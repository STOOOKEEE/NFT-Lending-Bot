/**
 * Strategy.ts - Décide quelles offres envoyer
 *
 * Principe:
 * 1. Récupère prix et volatilité depuis DB
 * 2. Récupère meilleures offres Gondi depuis DB
 * 3. Utilise LoanPricer pour calculer notre pricing compétitif
 * 4. Recommande les offres où on peut compétir
 *
 * Philosophie:
 * - Maximiser le nombre d'offres
 * - Accepter que certaines revertent (pas de fund manager)
 * - Déployer la liquidité au max
 */

import { getLatestFloorPrice } from "../utils/price-db";
import { calculateVolatilityFromDb } from "../engines/volatility";
import { getOffersByCollection } from "../utils/gondi-db";
import {
  priceCompetitiveOffer,
  type MarketData,
  type BestOffer,
  type PricingConfig,
  DEFAULT_CONFIG,
} from "../engines/LoanPricer";

// ==================== TYPES ====================

export interface StrategyRecommendation {
  collection: string;
  shouldSendOffer: boolean;
  reason: string;
  offerDetails?: {
    loanAmount: number;
    durationDays: number;
    recommendedApr: number;
    competitiveApr: number;
    expectedProfit: number;
    ltv: number;
  };
  marketContext?: {
    floorPrice: number;
    volatility: number;
    bestMarketApr: number;
    bestMarketAmount: number;
    bestMarketDuration: number;
  };
}

export interface StrategyReport {
  timestamp: string;
  collections: StrategyRecommendation[];
  summary: {
    total: number;
    shouldSend: number;
    skipped: number;
  };
}

// ==================== CONFIGURATION ====================

/**
 * Configuration de la stratégie
 * Peut être overridée avec des paramètres custom
 */
export const STRATEGY_CONFIG: PricingConfig = {
  ...DEFAULT_CONFIG,
  // Optionnel: ajuster les paramètres par défaut ici
};

/**
 * LTV cible pour nos offres (40% du floor price)
 */
const TARGET_LTV = 0.40;

/**
 * Nombre de jours de données minimum pour calculer volatilité
 */
const MIN_VOLATILITY_DATA_DAYS = 3;

// ==================== ANALYSE D'UNE COLLECTION ====================

/**
 * Analyse une collection et détermine si on doit envoyer une offre
 */
export async function analyzeCollection(
  slug: string,
  config: PricingConfig = STRATEGY_CONFIG
): Promise<StrategyRecommendation> {
  try {
    // 1. Récupérer le dernier prix depuis DB
    const latestPrice = await getLatestFloorPrice(slug);

    if (!latestPrice) {
      return {
        collection: slug,
        shouldSendOffer: false,
        reason: "No price data in DB",
      };
    }

    const { floor, bid, mid } = latestPrice;

    // 2. Calculer la volatilité depuis DB
    const volatilityResult = await calculateVolatilityFromDb(slug, 30);

    if (volatilityResult.annualized === 0) {
      return {
        collection: slug,
        shouldSendOffer: false,
        reason: `Not enough volatility data (need ${MIN_VOLATILITY_DATA_DAYS}+ days)`,
      };
    }

    // 3. Récupérer les meilleures offres Gondi depuis DB
    const gondiOffers = await getOffersByCollection(slug);

    if (gondiOffers.length === 0) {
      return {
        collection: slug,
        shouldSendOffer: false,
        reason: "No Gondi offers found for this collection",
      };
    }

    // 4. Pour chaque durée disponible, calculer si on peut compétir
    let bestCompetitiveOffer: StrategyRecommendation | null = null;

    for (const offer of gondiOffers) {
      const durationDays = offer.duration_days;
      const bestMarketApr = offer.best_apr_percent;
      const bestMarketAmount = offer.best_apr_amount;

      // Construire MarketData pour LoanPricer
      // volatilityResult.annualized est déjà annualisée (daily * √365)
      // donc volatilityPeriodDays = 365 pour éviter une double annualisation
      const marketData: MarketData = {
        floorPrice: floor,
        middlePrice: mid,
        topBid: bid,
        volatility: volatilityResult.annualized,
        volatilityPeriodDays: 365,
      };

      // Construire BestOffer pour comparaison
      const marketBestOffer: BestOffer = {
        loanAmount: bestMarketAmount,
        apr: bestMarketApr,
        durationDays,
        ltv: bestMarketAmount / floor,
      };

      // Utiliser le pricer pour voir si on peut compétir
      const pricingResult = priceCompetitiveOffer(marketData, marketBestOffer, config);

      if (pricingResult.canCompete && pricingResult.vsbestOffer.isMoreAttractive) {
        // On peut compétir!
        const loanAmount = floor * TARGET_LTV;

        const recommendation: StrategyRecommendation = {
          collection: slug,
          shouldSendOffer: true,
          reason: `Can compete with ${(pricingResult.competitiveApr * 100).toFixed(2)}% APR vs market ${(bestMarketApr * 100).toFixed(2)}%`,
          offerDetails: {
            loanAmount,
            durationDays,
            recommendedApr: pricingResult.recommendedApr,
            competitiveApr: pricingResult.competitiveApr,
            expectedProfit: pricingResult.expectedProfit,
            ltv: TARGET_LTV,
          },
          marketContext: {
            floorPrice: floor,
            volatility: volatilityResult.annualized,
            bestMarketApr,
            bestMarketAmount,
            bestMarketDuration: durationDays,
          },
        };

        // Garder la meilleure opportunité (max profit)
        if (
          !bestCompetitiveOffer ||
          (recommendation.offerDetails && bestCompetitiveOffer.offerDetails &&
           recommendation.offerDetails.expectedProfit > bestCompetitiveOffer.offerDetails.expectedProfit)
        ) {
          bestCompetitiveOffer = recommendation;
        }
      }
    }

    // 5. Retourner la meilleure opportunité trouvée
    if (bestCompetitiveOffer) {
      return bestCompetitiveOffer;
    }

    // Aucune opportunité compétitive
    return {
      collection: slug,
      shouldSendOffer: false,
      reason: "Cannot compete with current market offers (our min APR > market APR)",
      marketContext: {
        floorPrice: floor,
        volatility: volatilityResult.annualized,
        bestMarketApr: gondiOffers[0].best_apr_percent,
        bestMarketAmount: gondiOffers[0].best_apr_amount,
        bestMarketDuration: gondiOffers[0].duration_days,
      },
    };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      collection: slug,
      shouldSendOffer: false,
      reason: `Error: ${msg}`,
    };
  }
}

// ==================== ANALYSE MULTI-COLLECTIONS ====================

/**
 * Analyse plusieurs collections et génère un rapport
 */
export async function runStrategy(
  collectionSlugs: string[],
  config: PricingConfig = STRATEGY_CONFIG
): Promise<StrategyReport> {
  const timestamp = new Date().toISOString();
  const collections: StrategyRecommendation[] = [];

  console.log(`\n${"=".repeat(70)}`);
  console.log(`🎯 Running Strategy - ${collectionSlugs.length} collections`);
  console.log("=".repeat(70));

  for (const slug of collectionSlugs) {
    console.log(`\n📊 Analyzing ${slug}...`);

    const recommendation = await analyzeCollection(slug, config);
    collections.push(recommendation);

    if (recommendation.shouldSendOffer) {
      console.log(`✅ SHOULD SEND: ${recommendation.reason}`);
      if (recommendation.offerDetails) {
        console.log(`   Amount: ${recommendation.offerDetails.loanAmount.toFixed(4)} ETH`);
        console.log(`   APR: ${(recommendation.offerDetails.competitiveApr * 100).toFixed(2)}%`);
        console.log(`   Duration: ${recommendation.offerDetails.durationDays}d`);
        console.log(`   Expected Profit: ${recommendation.offerDetails.expectedProfit.toFixed(4)} ETH`);
      }
    } else {
      console.log(`⏭️  SKIP: ${recommendation.reason}`);
    }
  }

  const summary = {
    total: collections.length,
    shouldSend: collections.filter(c => c.shouldSendOffer).length,
    skipped: collections.filter(c => !c.shouldSendOffer).length,
  };

  console.log(`\n${"=".repeat(70)}`);
  console.log(`📈 Summary: ${summary.shouldSend} offers to send, ${summary.skipped} skipped`);
  console.log("=".repeat(70));

  return {
    timestamp,
    collections,
    summary,
  };
}

// ==================== HELPERS ====================

/**
 * Filtre uniquement les recommandations qui doivent être envoyées
 */
export function getOffersToSend(report: StrategyReport): StrategyRecommendation[] {
  return report.collections.filter(c => c.shouldSendOffer);
}

/**
 * Formatte une recommandation pour affichage concis (Telegram)
 */
export function formatRecommendationShort(rec: StrategyRecommendation): string {
  if (!rec.shouldSendOffer || !rec.offerDetails) {
    return `${rec.collection}: SKIP - ${rec.reason}`;
  }

  const { loanAmount, competitiveApr, durationDays, expectedProfit } = rec.offerDetails;

  return [
    `${rec.collection}`,
    `${loanAmount.toFixed(3)} ETH @ ${(competitiveApr * 100).toFixed(2)}%`,
    `${durationDays}d | Profit ${expectedProfit.toFixed(4)} ETH`,
  ].join(" | ");
}
