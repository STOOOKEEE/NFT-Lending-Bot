/**
 * Strategy.ts - Décide quelles offres envoyer
 *
 * Refactoré pour être platform-agnostic:
 * - Reçoit un tableau de LendingPlatform[]
 * - Itère sur chaque plateforme pour obtenir les offres marché
 * - Génère des recommandations uniformes (Type 1 + Type 2)
 *
 * Pour chaque (collection, plateforme, durée), 2 types d'offres:
 *   Type 1 "best_apr": undercut la meilleure APR du marché
 *   Type 2 "best_principal": matcher le plus gros montant, APR compétitive
 */

import { getLatestFloorPrice } from "../utils/price-db";
import { calculateVolatilityFromDb, annualizeVolatility } from "../engines/volatility";
import { findCollectionBySlug } from "../utils/collections-loader";
import {
  priceLoan,
  calculateMaxLTV,
  GONDI_DURATIONS,
  type MarketData,
  type PricingConfig,
  DEFAULT_CONFIG,
} from "../engines/LoanPricer";
import { LendingPlatform, PlatformMarketOffer } from "../adapters/LendingPlatform";
import { roundToBlurTick } from "../adapters/BlurPlatform";

// ==================== TYPES ====================

export interface StrategyRecommendation {
  collection: string;
  shouldSendOffer: boolean;
  reason: string;
  platform: string;
  offerDetails?: {
    loanAmount: number;
    durationDays: number;
    recommendedApr: number;
    competitiveApr: number;
    expectedProfit: number;
    ltv: number;
    offerType: "best_apr" | "best_principal";
    collectionAddress?: string;
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

export const STRATEGY_CONFIG: PricingConfig = {
  ...DEFAULT_CONFIG,
};

const MIN_VOLATILITY_DATA_DAYS = 3;

/** APR max 80% - safety cap */
const MAX_APR_CAP = 0.8;

/** When no competitor exists: minimum APR scaled by duration.
 *  7d → 25%, 15d → 27%, 30d → 32%, 60d → 41% */
const NO_COMPETITOR_BASE_APR = 0.25;
const NO_COMPETITOR_APR_PER_DAY = 0.003;

function noCompetitorMinApr(durationDays: number): number {
  return NO_COMPETITOR_BASE_APR + NO_COMPETITOR_APR_PER_DAY * (durationDays - 7);
}

/** Blur: higher LTV allowed since loans are rolling (lender can exit anytime) */
const BLUR_MAX_LTV = 0.80;

// ==================== PLATFORM-SPECIFIC CONFIG ====================

interface PlatformConfig {
  maxLtv: number;
  skipViabilityCheck: boolean;
  roundAmount: (amount: number) => number;
  minAmount: number;
  /** Minimum APR the platform accepts (decimal). Gondi rejects < 1%. */
  minAprDecimal: number;
}

function getPlatformConfig(platformName: string): PlatformConfig {
  if (platformName === "blur") {
    return {
      maxLtv: BLUR_MAX_LTV,
      skipViabilityCheck: true, // Rolling loans allow exit
      roundAmount: roundToBlurTick,
      minAmount: 0.1,
      minAprDecimal: 0.01, // 1%
    };
  }
  // Default (Gondi and future platforms)
  return {
    maxLtv: 0, // Will be calculated from spread + vol
    skipViabilityCheck: false,
    roundAmount: (v: number) => v,
    minAmount: 0,
    minAprDecimal: 0.01, // Gondi rejects < 100 bps (1%)
  };
}

// ==================== ANALYSE D'UNE COLLECTION ====================

/**
 * Analyse une collection sur TOUTES les plateformes fournies
 * et retourne les offres possibles (Type 1 + Type 2, par plateforme × durée)
 */
export async function analyzeCollection(
  slug: string,
  platforms: LendingPlatform[],
  config: PricingConfig = STRATEGY_CONFIG
): Promise<StrategyRecommendation[]> {
  const results: StrategyRecommendation[] = [];
  const pct = (v: number) => `${(v * 100).toFixed(2)}%`;

  try {
    // 1. Récupérer le dernier prix depuis DB
    const latestPrice = await getLatestFloorPrice(slug);

    if (!latestPrice) {
      results.push({
        collection: slug,
        shouldSendOffer: false,
        reason: "No price data in DB",
        platform: "none",
      });
      return results;
    }

    const { floor, bid, mid } = latestPrice;
    const spread = floor > 0 ? (floor - bid) / floor : 0;

    // 2. Calculer la volatilité (EWMA annualisée)
    const volatilityResult = await calculateVolatilityFromDb(slug, 30);

    if (volatilityResult.ewma === 0) {
      results.push({
        collection: slug,
        shouldSendOffer: false,
        reason: `Not enough volatility data (need ${MIN_VOLATILITY_DATA_DAYS}+ days)`,
        platform: "none",
      });
      return results;
    }

    const ewmaAnnualized = annualizeVolatility(volatilityResult.ewma);
    const dynamicMaxLtv = calculateMaxLTV(spread, ewmaAnnualized);

    const collectionConfig = findCollectionBySlug(slug);
    const collectionAddress = collectionConfig?.address || "";

    const marketData: MarketData = {
      floorPrice: floor,
      middlePrice: mid,
      topBid: bid,
      volatility: ewmaAnnualized,
      spread,
    };

    console.log(`  [${slug}] Floor ${floor.toFixed(4)} | Bid ${bid.toFixed(4)} | Spread ${pct(spread)} | Vol(EWMA) ${pct(ewmaAnnualized)} | maxLTV ${pct(dynamicMaxLtv)}`);

    // 3. Pour chaque plateforme, obtenir les offres marché et générer des recommandations
    for (const platform of platforms) {
      // Check if this platform supports the collection
      if (collectionAddress && !platform.isCollectionSupported(collectionAddress)) {
        continue;
      }

      const platformConfig = getPlatformConfig(platform.name);
      const effectiveMaxLtv = platformConfig.maxLtv > 0 ? platformConfig.maxLtv : dynamicMaxLtv;

      let marketOffers: PlatformMarketOffer[];
      try {
        marketOffers = await platform.getMarketOffers(slug);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`  [${slug}] [${platform.name}] Error fetching market: ${msg}`);
        continue;
      }

      if (marketOffers.length === 0) {
        // No competitors at all — publish standalone offers on all durations
        const targetDurations = platform.name === "blur" ? [30] : GONDI_DURATIONS;
        const defaultLtv = effectiveMaxLtv * 0.6;
        const defaultAmount = platformConfig.roundAmount(floor * defaultLtv);

        if (defaultAmount >= platformConfig.minAmount) {
          for (const dur of targetDurations) {
            const pricing = priceLoan(marketData, defaultAmount, dur, config);
            const standaloneApr = Math.max(Math.min(pricing.recommendedApr, MAX_APR_CAP), noCompetitorMinApr(dur));

            if (pricing.isViable || platformConfig.skipViabilityCheck) {
              const expectedProfit = defaultAmount * standaloneApr * (dur / 365);
              console.log(`  [${slug}] [${platform.name}] SEND standalone ${dur}d | ${defaultAmount.toFixed(4)} ETH @ ${pct(standaloneApr)} (no competitors)`);

              results.push({
                collection: slug,
                shouldSendOffer: true,
                platform: platform.name,
                reason: `Standalone ${pct(standaloneApr)} APR (no competitors, ${dur}d)`,
                offerDetails: {
                  loanAmount: defaultAmount,
                  durationDays: dur,
                  recommendedApr: standaloneApr,
                  competitiveApr: standaloneApr,
                  expectedProfit,
                  ltv: defaultLtv,
                  offerType: "best_apr",
                  collectionAddress,
                },
                marketContext: {
                  floorPrice: floor,
                  volatility: ewmaAnnualized,
                  bestMarketApr: 0,
                  bestMarketAmount: 0,
                  bestMarketDuration: dur,
                },
              });
            }
          }
        }
        continue;
      }

      console.log(`  [${slug}] [${platform.name}] ${marketOffers.length} market offer(s)`);

      for (const mktOffer of marketOffers) {
        const durationDays = mktOffer.durationDays;

        // ---- TYPE 1: Best APR ----
        const type1Apr = Math.max(mktOffer.bestAprDecimal - config.minSpreadBelowBest, platformConfig.minAprDecimal);
        let type1Amount = mktOffer.bestAprAmount;
        type1Amount = platformConfig.roundAmount(type1Amount);

        if (type1Amount >= platformConfig.minAmount) {
          const type1Ltv = floor > 0 ? type1Amount / floor : 0;

          if (type1Ltv <= effectiveMaxLtv && type1Apr > 0) {
            const pricing = priceLoan(marketData, type1Amount, durationDays, config);
            const isProfitable = pricing.minApr < type1Apr;
            const isViable = platformConfig.skipViabilityCheck || pricing.isViable;
            const finalApr = Math.min(type1Apr, MAX_APR_CAP);

            if (isProfitable && isViable) {
              const expectedProfit = type1Amount * finalApr * (durationDays / 365);
              console.log(`  [${slug}] [${platform.name}] SEND T1 ${durationDays}d | ${type1Amount.toFixed(4)} ETH @ ${pct(finalApr)} | minApr ${pct(pricing.minApr)} | LTV ${pct(type1Ltv)}`);

              results.push({
                collection: slug,
                shouldSendOffer: true,
                platform: platform.name,
                reason: `T1 ${pct(finalApr)} APR vs market ${pct(mktOffer.bestAprDecimal)} (minApr ${pct(pricing.minApr)})`,
                offerDetails: {
                  loanAmount: type1Amount,
                  durationDays,
                  recommendedApr: finalApr,
                  competitiveApr: finalApr,
                  expectedProfit,
                  ltv: type1Ltv,
                  offerType: "best_apr",
                  collectionAddress: mktOffer.collectionAddress || collectionAddress,
                },
                marketContext: {
                  floorPrice: floor,
                  volatility: ewmaAnnualized,
                  bestMarketApr: mktOffer.bestAprDecimal,
                  bestMarketAmount: mktOffer.bestAprAmount,
                  bestMarketDuration: durationDays,
                },
              });
            } else {
              const skipReason = !isProfitable
                ? `minApr ${pct(pricing.minApr)} > ourApr ${pct(type1Apr)}`
                : `not viable (risk ${pricing.riskScore}/100)`;
              console.log(`  [${slug}] [${platform.name}] SKIP T1 ${durationDays}d | ${skipReason}`);
            }
          } else if (type1Ltv > effectiveMaxLtv) {
            console.log(`  [${slug}] [${platform.name}] SKIP T1 ${durationDays}d | LTV ${pct(type1Ltv)} > max ${pct(effectiveMaxLtv)}`);
          }
        }

        // ---- TYPE 2: Best Principal ----
        // Skip for Blur (rolling loans, only one offer type makes sense)
        if (platform.name === "blur") continue;

        const type2Amount = platformConfig.roundAmount(mktOffer.bestPrincipalAmount);
        const type2Apr = Math.max(mktOffer.bestPrincipalAprDecimal - config.minSpreadBelowBest, platformConfig.minAprDecimal);

        // Skip if duplicate of Type 1
        const isDuplicate = Math.abs(type2Amount - type1Amount) < 0.001 && Math.abs(type2Apr - type1Apr) < 0.001;

        if (!isDuplicate && type2Amount >= platformConfig.minAmount && type2Apr > 0) {
          const type2Ltv = floor > 0 ? type2Amount / floor : 0;

          if (type2Ltv <= effectiveMaxLtv) {
            const pricing = priceLoan(marketData, type2Amount, durationDays, config);
            const isProfitable = pricing.minApr < type2Apr;
            const isViable = platformConfig.skipViabilityCheck || pricing.isViable;
            const finalApr = Math.min(type2Apr, MAX_APR_CAP);

            if (isProfitable && isViable) {
              const expectedProfit = type2Amount * finalApr * (durationDays / 365);
              console.log(`  [${slug}] [${platform.name}] SEND T2 ${durationDays}d | ${type2Amount.toFixed(4)} ETH @ ${pct(finalApr)} | minApr ${pct(pricing.minApr)} | LTV ${pct(type2Ltv)}`);

              results.push({
                collection: slug,
                shouldSendOffer: true,
                platform: platform.name,
                reason: `T2 ${pct(finalApr)} APR, principal ${type2Amount.toFixed(4)} ETH`,
                offerDetails: {
                  loanAmount: type2Amount,
                  durationDays,
                  recommendedApr: finalApr,
                  competitiveApr: finalApr,
                  expectedProfit,
                  ltv: type2Ltv,
                  offerType: "best_principal",
                  collectionAddress: mktOffer.collectionAddress || collectionAddress,
                },
                marketContext: {
                  floorPrice: floor,
                  volatility: ewmaAnnualized,
                  bestMarketApr: mktOffer.bestPrincipalAprDecimal,
                  bestMarketAmount: mktOffer.bestPrincipalAmount,
                  bestMarketDuration: durationDays,
                },
              });
            } else {
              const skipReason = !isProfitable
                ? `minApr ${pct(pricing.minApr)} > ourApr ${pct(type2Apr)}`
                : `not viable (risk ${pricing.riskScore}/100)`;
              console.log(`  [${slug}] [${platform.name}] SKIP T2 ${durationDays}d | ${skipReason}`);
            }
          }
        } else if (isDuplicate) {
          console.log(`  [${slug}] [${platform.name}] SKIP T2 ${durationDays}d | duplicate of T1`);
        }
      }

      // ---- Standalone offers for durations with no competitors ----
      // Durations depend on platform: Gondi uses GONDI_DURATIONS, Blur uses [30]
      const targetDurations = platform.name === "blur" ? [30] : GONDI_DURATIONS;
      const coveredDurations = new Set(marketOffers.map(o => o.durationDays));

      for (const dur of targetDurations) {
        if (coveredDurations.has(dur)) continue;

        const standaloneLtv = effectiveMaxLtv * 0.6;
        const standaloneAmount = platformConfig.roundAmount(floor * standaloneLtv);

        if (standaloneAmount < platformConfig.minAmount) continue;

        const pricing = priceLoan(marketData, standaloneAmount, dur, config);
        const standaloneApr = Math.max(Math.min(pricing.recommendedApr, MAX_APR_CAP), noCompetitorMinApr(dur));

        if (pricing.isViable || platformConfig.skipViabilityCheck) {
          const expectedProfit = standaloneAmount * standaloneApr * (dur / 365);
          console.log(`  [${slug}] [${platform.name}] SEND standalone ${dur}d | ${standaloneAmount.toFixed(4)} ETH @ ${pct(standaloneApr)} (no competitors on ${dur}d)`);

          results.push({
            collection: slug,
            shouldSendOffer: true,
            platform: platform.name,
            reason: `Standalone ${pct(standaloneApr)} APR (no competitors on ${dur}d)`,
            offerDetails: {
              loanAmount: standaloneAmount,
              durationDays: dur,
              recommendedApr: standaloneApr,
              competitiveApr: standaloneApr,
              expectedProfit,
              ltv: standaloneLtv,
              offerType: "best_apr",
              collectionAddress,
            },
            marketContext: {
              floorPrice: floor,
              volatility: ewmaAnnualized,
              bestMarketApr: 0,
              bestMarketAmount: 0,
              bestMarketDuration: dur,
            },
          });
        }
      }
    }

    // Si aucune offre viable sur aucune plateforme
    if (results.length === 0) {
      results.push({
        collection: slug,
        shouldSendOffer: false,
        platform: "none",
        reason: "Cannot compete on any platform",
        marketContext: {
          floorPrice: floor,
          volatility: ewmaAnnualized,
          bestMarketApr: 0,
          bestMarketAmount: 0,
          bestMarketDuration: 0,
        },
      });
    }

    return results;
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    results.push({
      collection: slug,
      shouldSendOffer: false,
      platform: "none",
      reason: `Error: ${msg}`,
    });
    return results;
  }
}

// ==================== ANALYSE MULTI-COLLECTIONS ====================

/**
 * Analyse plusieurs collections sur toutes les plateformes
 */
export async function runStrategy(
  collectionSlugs: string[],
  platforms: LendingPlatform[],
  config: PricingConfig = STRATEGY_CONFIG
): Promise<StrategyReport> {
  const timestamp = new Date().toISOString();
  const allRecommendations: StrategyRecommendation[] = [];

  console.log(`\n${"=".repeat(70)}`);
  console.log(`🎯 Running Strategy - ${collectionSlugs.length} collections, ${platforms.length} platform(s) [${platforms.map(p => p.name).join(", ")}]`);
  console.log("=".repeat(70));

  for (const slug of collectionSlugs) {
    console.log(`\n📊 Analyzing ${slug}...`);

    const recommendations = await analyzeCollection(slug, platforms, config);
    allRecommendations.push(...recommendations);

    const sends = recommendations.filter(r => r.shouldSendOffer);
    const skips = recommendations.filter(r => !r.shouldSendOffer);

    if (sends.length > 0) {
      console.log(`  ✅ ${sends.length} offer(s) to send:`);
      for (const rec of sends) {
        if (rec.offerDetails) {
          const t = rec.offerDetails.offerType === "best_apr" ? "T1" : "T2";
          console.log(`     [${rec.platform}] ${t} ${rec.offerDetails.durationDays}d: ${rec.offerDetails.loanAmount.toFixed(4)} ETH @ ${(rec.offerDetails.competitiveApr * 100).toFixed(2)}%`);
        }
      }
    }
    if (skips.length > 0 && sends.length === 0) {
      console.log(`  ⏭️  SKIP: ${skips[0].reason}`);
    }
  }

  const shouldSend = allRecommendations.filter(r => r.shouldSendOffer).length;
  const skipped = allRecommendations.filter(r => !r.shouldSendOffer).length;

  console.log(`\n${"=".repeat(70)}`);
  console.log(`📈 Summary: ${shouldSend} offers to send, ${skipped} skipped`);
  console.log("=".repeat(70));

  return {
    timestamp,
    collections: allRecommendations,
    summary: {
      total: allRecommendations.length,
      shouldSend,
      skipped,
    },
  };
}

// ==================== HELPERS ====================

export function getOffersToSend(report: StrategyReport): StrategyRecommendation[] {
  return report.collections.filter(c => c.shouldSendOffer);
}

export function formatRecommendationShort(rec: StrategyRecommendation): string {
  if (!rec.shouldSendOffer || !rec.offerDetails) {
    return `${rec.collection}: SKIP - ${rec.reason}`;
  }

  const { loanAmount, competitiveApr, durationDays, expectedProfit, offerType } = rec.offerDetails;
  const t = offerType === "best_apr" ? "T1" : "T2";

  return [
    `${rec.collection} [${rec.platform}/${t}]`,
    `${loanAmount.toFixed(3)} ETH @ ${(competitiveApr * 100).toFixed(2)}%`,
    `${durationDays}d | Profit ${expectedProfit.toFixed(4)} ETH`,
  ].join(" | ");
}
