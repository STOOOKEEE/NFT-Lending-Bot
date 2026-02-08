/**
 * NFT Loan Pricer - Module de pricing basé sur Black-Scholes
 * 
 * Le prêt NFT est modélisé comme la vente d'un put option :
 * - Si le floor reste > montant prêté → on gagne les intérêts
 * - Si le floor tombe < montant prêté → on récupère un NFT dévalué (exercice du put)
 * 
 * Pour être rentable : Intérêts reçus ≥ Prime du Put
 */

// ============================================================
// TYPES
// ============================================================

export interface MarketData {
  floorPrice: number;        // Prix plancher actuel (ETH)
  middlePrice: number;       // Prix médian des ventes récentes (ETH)
  topBid: number;            // Meilleure offre d'achat (ETH)
  volatility: number;        // Volatilité (ex: 0.15 = 15%)
  volatilityPeriodDays: number; // Période sur laquelle la volatilité est calculée
}

export interface BestOffer {
  loanAmount: number;        // Montant prêté (ETH)
  apr: number;               // Taux annuel (ex: 0.45 = 45%)
  durationDays: number;      // Durée en jours
  ltv: number;               // Loan-to-Value ratio (ex: 0.7 = 70%)
}

export interface PricingConfig {
  riskFreeRate: number;      // Taux sans risque annualisé (ex: 0.04 = 4%)
  liquidityPremium: number;  // Prime de liquidité NFT (ex: 0.05 = 5%)
  safetyMultiplier: number;  // Multiplicateur de sécurité sur la volatilité (ex: 1.2)
  minSpreadBelowBest: number; // Spread minimum sous la meilleure offre (ex: 0.01 = 1%)
}

export interface PricingResult {
  isViable: boolean;         // L'offre est-elle viable (rentable) ?
  minApr: number;            // APR minimum pour être rentable
  recommendedApr: number;    // APR recommandé (minApr + marge)
  putPremium: number;        // Prime du put calculée
  expectedProfit: number;    // Profit espéré si l'emprunteur rembourse
  maxLoss: number;           // Perte maximum si défaut
  breakEvenFloor: number;    // Floor en dessous duquel on perd de l'argent
  riskScore: number;         // Score de risque 0-100
  details: PricingDetails;
}

export interface PricingDetails {
  spotPrice: number;
  strikePrice: number;
  timeToExpiry: number;
  annualizedVolatility: number;
  d1: number;
  d2: number;
}

export interface MultiDurationResult {
  collection: string;
  loanAmount: number;
  ltv: number;
  durations: {
    days: number;
    pricing: PricingResult;
  }[];
  bestDuration: number | null; // Durée la plus rentable, null si aucune viable
}

// ============================================================
// CONSTANTES PAR DÉFAUT
// ============================================================

export const DEFAULT_CONFIG: PricingConfig = {
  riskFreeRate: 0.07,        // 7% (ETH looping yield)
  liquidityPremium: 0.05,    // 5% de prime pour illiquidité NFT
  safetyMultiplier: 1.3,     // 30% de marge sur la volatilité
  minSpreadBelowBest: 0.02,  // 2% en dessous de la meilleure offre
};

export const GONDI_DURATIONS = [7, 14, 30, 60, 90]; // Durées en jours

// ============================================================
// FONCTIONS MATHÉMATIQUES
// ============================================================

/**
 * Fonction de répartition de la loi normale standard (CDF)
 * Approximation de Abramowitz and Stegun
 */
function normalCDF(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.sqrt(2);

  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

  return 0.5 * (1.0 + sign * y);
}

/**
 * Annualise la volatilité
 * @param volatility Volatilité sur la période
 * @param periodDays Nombre de jours de la période
 */
export function annualizeVolatility(volatility: number, periodDays: number): number {
  // σ_annual = σ_period × √(365 / period)
  return volatility * Math.sqrt(365 / periodDays);
}

// ============================================================
// BLACK-SCHOLES
// ============================================================

/**
 * Calcule la prime d'un put européen avec Black-Scholes
 * 
 * @param S Spot price (floor price actuel)
 * @param K Strike price (montant prêté)
 * @param T Time to expiry en années
 * @param r Risk-free rate
 * @param sigma Volatilité annualisée
 */
export function blackScholesPut(
  S: number,
  K: number,
  T: number,
  r: number,
  sigma: number
): { premium: number; d1: number; d2: number } {
  // Cas limite : si T très petit, utiliser une approximation
  if (T < 0.001) {
    const intrinsicValue = Math.max(0, K - S);
    return { premium: intrinsicValue, d1: 0, d2: 0 };
  }

  const d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);

  // Put = K × e^(-rT) × N(-d₂) - S × N(-d₁)
  const premium = K * Math.exp(-r * T) * normalCDF(-d2) - S * normalCDF(-d1);

  return { premium: Math.max(0, premium), d1, d2 };
}

// ============================================================
// PRICING PRINCIPAL
// ============================================================

/**
 * Calcule le pricing optimal pour un prêt NFT
 * 
 * @param marketData Données de marché de la collection
 * @param loanAmount Montant à prêter (ETH)
 * @param durationDays Durée du prêt en jours
 * @param config Configuration du pricer
 */
export function priceLoan(
  marketData: MarketData,
  loanAmount: number,
  durationDays: number,
  config: PricingConfig = DEFAULT_CONFIG
): PricingResult {
  // Paramètres Black-Scholes
  const S = marketData.floorPrice; // Spot = floor price
  const K = loanAmount;            // Strike = montant prêté
  const T = durationDays / 365;    // Temps en années
  const r = config.riskFreeRate;

  // Annualiser et ajuster la volatilité
  const baseAnnualizedVol = annualizeVolatility(
    marketData.volatility,
    marketData.volatilityPeriodDays
  );
  const adjustedVol = baseAnnualizedVol * config.safetyMultiplier;

  // Calculer la prime du put
  const { premium: putPremium, d1, d2 } = blackScholesPut(S, K, T, r, adjustedVol);

  // Ajouter la prime de liquidité
  const totalPremium = putPremium + (loanAmount * config.liquidityPremium * T);

  // APR minimum pour couvrir le risque
  // Intérêts = Montant × APR × T
  // Pour être rentable : Intérêts ≥ totalPremium
  // Donc : APR_min = totalPremium / (Montant × T)
  const minApr = T > 0 ? totalPremium / (loanAmount * T) : 0;

  // APR recommandé avec une marge
  const recommendedApr = minApr * 1.15; // 15% de marge supplémentaire

  // Calcul du LTV
  const ltv = loanAmount / S;

  // Score de risque (0-100)
  // Facteurs : LTV élevé = risque, volatilité élevée = risque, durée longue = risque
  const riskScore = Math.min(100, Math.round(
    (ltv * 40) +                           // LTV contribue à 40% max
    (adjustedVol * 30) +                   // Volatilité contribue à 30% max
    (Math.min(durationDays / 90, 1) * 30)  // Durée contribue à 30% max
  ));

  // Profit espéré si remboursement
  const expectedProfit = loanAmount * recommendedApr * T;

  // Perte maximum si défaut (on récupère un NFT qui peut valoir 0 dans le pire cas)
  const maxLoss = loanAmount;

  // Floor break-even : floor en dessous duquel on perd de l'argent
  // Si on récupère le NFT, on le vend au floor
  // Perte = loanAmount - floor
  // Pour break-even avec les intérêts : loanAmount - floor = intérêts
  // floor_breakeven = loanAmount - intérêts
  const breakEvenFloor = loanAmount - expectedProfit;

  // L'offre est viable si on peut proposer un APR compétitif
  // et que le LTV n'est pas trop risqué
  const isViable = ltv <= 0.85 && minApr < 2.0; // LTV max 85%, APR min < 200%

  return {
    isViable,
    minApr,
    recommendedApr,
    putPremium,
    expectedProfit,
    maxLoss,
    breakEvenFloor,
    riskScore,
    details: {
      spotPrice: S,
      strikePrice: K,
      timeToExpiry: T,
      annualizedVolatility: adjustedVol,
      d1,
      d2,
    },
  };
}

/**
 * Calcule le pricing pour une offre compétitive
 * Se positionne juste en dessous de la meilleure offre existante
 * 
 * @param marketData Données de marché
 * @param bestOffer Meilleure offre existante
 * @param config Configuration
 */
export function priceCompetitiveOffer(
  marketData: MarketData,
  bestOffer: BestOffer,
  config: PricingConfig = DEFAULT_CONFIG
): PricingResult & { 
  canCompete: boolean; 
  competitiveApr: number;
  vsbestOffer: {
    aprDiff: number;
    isMoreAttractive: boolean;
  };
} {
  // Calculer notre pricing minimum
  const pricing = priceLoan(
    marketData,
    bestOffer.loanAmount,
    bestOffer.durationDays,
    config
  );

  // APR compétitif = meilleure offre - spread
  const competitiveApr = bestOffer.apr - config.minSpreadBelowBest;

  // On peut compétiter si notre APR min est inférieur à l'APR compétitif
  const canCompete = pricing.isViable && pricing.minApr < competitiveApr;

  // Différence avec la meilleure offre
  const aprDiff = bestOffer.apr - pricing.recommendedApr;

  return {
    ...pricing,
    canCompete,
    competitiveApr: canCompete ? competitiveApr : pricing.recommendedApr,
    vsbestOffer: {
      aprDiff,
      isMoreAttractive: pricing.recommendedApr < bestOffer.apr,
    },
  };
}

/**
 * Calcule le pricing pour plusieurs durées (spécifique Gondi)
 * 
 * @param marketData Données de marché
 * @param loanAmount Montant à prêter
 * @param collection Nom de la collection
 * @param durations Liste des durées à évaluer
 * @param config Configuration
 */
export function priceMultipleDurations(
  marketData: MarketData,
  loanAmount: number,
  collection: string,
  durations: number[] = GONDI_DURATIONS,
  config: PricingConfig = DEFAULT_CONFIG
): MultiDurationResult {
  const ltv = loanAmount / marketData.floorPrice;
  
  const results = durations.map(days => ({
    days,
    pricing: priceLoan(marketData, loanAmount, days, config),
  }));

  // Trouver la meilleure durée (viable avec le meilleur ratio profit/risque)
  const viableResults = results.filter(r => r.pricing.isViable);
  
  let bestDuration: number | null = null;
  if (viableResults.length > 0) {
    // Trier par ratio (expectedProfit / riskScore)
    viableResults.sort((a, b) => {
      const ratioA = a.pricing.expectedProfit / (a.pricing.riskScore || 1);
      const ratioB = b.pricing.expectedProfit / (b.pricing.riskScore || 1);
      return ratioB - ratioA;
    });
    bestDuration = viableResults[0].days;
  }

  return {
    collection,
    loanAmount,
    ltv,
    durations: results,
    bestDuration,
  };
}

// ============================================================
// UTILITAIRES
// ============================================================

/**
 * Vérifie si une offre existante est toujours rentable
 * (Pour le processus de monitoring)
 */
export function isOfferStillProfitable(
  currentMarketData: MarketData,
  existingOffer: {
    loanAmount: number;
    apr: number;
    durationDays: number;
    remainingDays: number;
  },
  config: PricingConfig = DEFAULT_CONFIG
): {
  stillProfitable: boolean;
  currentMinApr: number;
  margin: number; // Marge entre notre APR et le minimum requis
  recommendation: 'keep' | 'withdraw' | 'update';
} {
  const pricing = priceLoan(
    currentMarketData,
    existingOffer.loanAmount,
    existingOffer.remainingDays,
    config
  );

  const margin = existingOffer.apr - pricing.minApr;
  const stillProfitable = margin > 0;

  let recommendation: 'keep' | 'withdraw' | 'update';
  if (!stillProfitable) {
    recommendation = 'withdraw';
  } else if (margin < 0.05) { // Marge < 5%
    recommendation = 'update';
  } else {
    recommendation = 'keep';
  }

  return {
    stillProfitable,
    currentMinApr: pricing.minApr,
    margin,
    recommendation,
  };
}

/**
 * Formate le résultat de pricing pour affichage
 */
export function formatPricingResult(result: PricingResult, durationDays?: number): string {
  const lines = [
    `═══════════════════════════════════════════════`,
    `📊 PRICING RESULT`,
    `═══════════════════════════════════════════════`,
    ``,
    `Viabilité: ${result.isViable ? '✅ VIABLE' : '❌ NON VIABLE'}`,
    ``,
    `📈 APR:`,
    `   Minimum requis: ${(result.minApr * 100).toFixed(2)}%`,
    `   Recommandé:     ${(result.recommendedApr * 100).toFixed(2)}%`,
    ``,
    `💰 Financier:`,
    `   Prime du Put:    ${result.putPremium.toFixed(4)} ETH`,
    `   Profit espéré:   ${result.expectedProfit.toFixed(4)} ETH`,
    `   Perte max:       ${result.maxLoss.toFixed(4)} ETH`,
    `   Floor break-even: ${result.breakEvenFloor.toFixed(4)} ETH`,
    ``,
    `⚠️  Score de risque: ${result.riskScore}/100`,
    ``,
    `📐 Détails Black-Scholes:`,
    `   Spot (Floor):     ${result.details.spotPrice.toFixed(4)} ETH`,
    `   Strike (Loan):    ${result.details.strikePrice.toFixed(4)} ETH`,
    `   Volatilité ann.:  ${(result.details.annualizedVolatility * 100).toFixed(1)}%`,
    durationDays ? `   Durée:            ${durationDays} jours` : '',
    `═══════════════════════════════════════════════`,
  ];

  return lines.filter(l => l !== '').join('\n');
}
