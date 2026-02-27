/**
 * LoanPricer - Pricing basé sur Black-Scholes
 *
 * Le prêt NFT = vente d'un put option :
 * - Floor > montant prêté → on gagne les intérêts
 * - Floor < montant prêté → on récupère un NFT dévalué
 * Pour être rentable : Intérêts ≥ Prime du Put
 */

export interface MarketData {
  floorPrice: number;
  middlePrice: number;
  topBid: number;
  /** Annualized volatility (already scaled to yearly) */
  volatility: number;
  spread?: number;
}

export interface BestOffer {
  loanAmount: number;
  apr: number;
  durationDays: number;
  ltv: number;
}

export interface PricingConfig {
  riskFreeRate: number;
  liquidityPremium: number;
  safetyMultiplier: number;
  minSpreadBelowBest: number;
}

export interface PricingResult {
  isViable: boolean;
  minApr: number;
  recommendedApr: number;
  putPremium: number;
  expectedProfit: number;
  maxLoss: number;
  breakEvenFloor: number;
  riskScore: number;
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

export const DEFAULT_CONFIG: PricingConfig = {
  riskFreeRate: 0.05,
  liquidityPremium: 0.03,
  safetyMultiplier: 1.15,
  minSpreadBelowBest: 0.01,
};

export const GONDI_DURATIONS = [7, 15, 30, 60];

export function calculateMaxLTV(spread: number, annualizedVolatility: number): number {
  const BASE_MAX_LTV = 0.80;
  const spreadPenalty = Math.min(0.15, spread * 0.5);
  const volPenalty = Math.min(0.10, annualizedVolatility * 0.1);
  return Math.max(0.30, BASE_MAX_LTV - spreadPenalty - volPenalty);
}

/** Normal CDF (Abramowitz & Stegun approximation) */
function normalCDF(x: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.sqrt(2);
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1.0 + sign * y);
}

export function annualizeVolatility(volatility: number, periodDays: number): number {
  return volatility * Math.sqrt(365 / periodDays);
}

/** Black-Scholes put premium */
export function blackScholesPut(
  S: number, K: number, T: number, r: number, sigma: number
): { premium: number; d1: number; d2: number } {
  if (T < 0.001) {
    return { premium: Math.max(0, K - S), d1: 0, d2: 0 };
  }

  const d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  const premium = K * Math.exp(-r * T) * normalCDF(-d2) - S * normalCDF(-d1);

  return { premium: Math.max(0, premium), d1, d2 };
}

export function priceLoan(
  marketData: MarketData,
  loanAmount: number,
  durationDays: number,
  config: PricingConfig = DEFAULT_CONFIG
): PricingResult {
  // Spot price: spread < 10% → mid price, spread >= 10% → weighted toward bid
  let S: number;
  const spread = marketData.spread ?? 0;

  if (spread < 0.10) {
    S = (marketData.floorPrice + marketData.topBid) / 2;
  } else {
    const bidWeight = 0.85 + 0.15 * Math.min(1, (spread - 0.10) / 0.40);
    S = marketData.topBid * bidWeight + marketData.floorPrice * (1 - bidWeight);
  }

  const K = loanAmount;
  const T = durationDays / 365;
  const r = config.riskFreeRate;

  // volatility is already annualized by the caller (Strategy.ts)
  const adjustedVol = marketData.volatility * config.safetyMultiplier;

  const { premium: putPremium, d1, d2 } = blackScholesPut(S, K, T, r, adjustedVol);
  const totalPremium = putPremium + (loanAmount * config.liquidityPremium * T);

  const minApr = T > 0 ? totalPremium / (loanAmount * T) : 0;
  const recommendedApr = minApr * 1.15;
  const ltv = loanAmount / S;

  const riskScore = Math.min(100, Math.round(
    (ltv * 40) + (adjustedVol * 30) + (Math.min(durationDays / 90, 1) * 30)
  ));

  const expectedProfit = loanAmount * recommendedApr * T;
  const maxLoss = loanAmount;
  const breakEvenFloor = loanAmount - expectedProfit;

  const maxLTV = calculateMaxLTV(spread, adjustedVol);
  const isViable = ltv <= maxLTV && minApr < 2.0;

  return {
    isViable, minApr, recommendedApr, putPremium,
    expectedProfit, maxLoss, breakEvenFloor, riskScore,
    details: { spotPrice: S, strikePrice: K, timeToExpiry: T, annualizedVolatility: adjustedVol, d1, d2 },
  };
}
