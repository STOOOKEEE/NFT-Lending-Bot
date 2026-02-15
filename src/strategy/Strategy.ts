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
 * - Maximiser le nombre d'offres (multi-durée, multi-type)
 * - Accepter que certaines revertent (pas de fund manager)
 * - Déployer la liquidité au max
 *
 * Pour chaque (collection, durée), 2 types d'offres:
 *   Type 1 "best_apr": undercut la meilleure APR du marché
 *   Type 2 "best_principal": matcher le plus gros montant, APR compétitive
 */

import { getLatestFloorPrice } from "../utils/price-db";
import { calculateVolatilityFromDb, annualizeVolatility } from "../engines/volatility";
import { getOffersByCollection } from "../utils/gondi-db";
import { getBlurMarketBySlug } from "../utils/blur-db";
import { isBlurSupported, roundToBlurTick, BLUR_LENDING_COLLECTIONS } from "../adapters/BlurAdapter";
import { findCollectionBySlug } from "../utils/collections-loader";
import {
  priceLoan,
  calculateMaxLTV,
  type MarketData,
  type PricingConfig,
  DEFAULT_CONFIG,
} from "../engines/LoanPricer";
import { getEthUsdPrice, toETHEquivalent } from "../utils/helpers";

// ==================== TYPES ====================

export interface StrategyRecommendation {
  collection: string;
  shouldSendOffer: boolean;
  reason: string;
  platform: "gondi" | "blur";
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

/** APR max 80% — safety cap */
const MAX_APR_CAP = 0.8;

// ==================== ANALYSE D'UNE COLLECTION ====================

/**
 * Analyse une collection et retourne TOUTES les offres possibles
 * (Type 1 + Type 2, pour chaque durée)
 */
export async function analyzeCollection(
  slug: string,
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
        platform: "gondi",
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
        platform: "gondi",
      });
      return results;
    }

    const ewmaAnnualized = annualizeVolatility(volatilityResult.ewma);

    // 3. Récupérer les meilleures offres Gondi depuis DB
    const gondiOffers = await getOffersByCollection(slug);

    if (gondiOffers.length === 0) {
      results.push({
        collection: slug,
        shouldSendOffer: false,
        reason: "No Gondi offers found for this collection",
        platform: "gondi",
      });
      return results;
    }

    const ethUsdPrice = await getEthUsdPrice();
    const maxLtv = calculateMaxLTV(spread, ewmaAnnualized);

    console.log(`  [${slug}] Floor ${floor.toFixed(4)} | Bid ${bid.toFixed(4)} | Spread ${pct(spread)} | Vol(EWMA) ${pct(ewmaAnnualized)} | maxLTV ${pct(maxLtv)} | ${gondiOffers.length} duration(s) | ETH=$${ethUsdPrice.toFixed(0)}`);

    const marketData: MarketData = {
      floorPrice: floor,
      middlePrice: mid,
      topBid: bid,
      volatility: ewmaAnnualized,
      volatilityPeriodDays: 365,
      spread,
    };

    // 4. Pour chaque durée, générer Type 1 + Type 2
    for (const offer of gondiOffers) {
      const durationDays = offer.duration_days;

      // ---- TYPE 1: Best APR ----
      // Se cale sur la meilleure offre APR du marché
      const bestAprDecimal = offer.best_apr_percent / 100; // % → decimal
      const bestAprAmount = toETHEquivalent(offer.best_apr_amount, offer.best_apr_currency || "WETH", ethUsdPrice);
      const type1Apr = bestAprDecimal - config.minSpreadBelowBest;
      const type1Amount = bestAprAmount;
      const type1Ltv = floor > 0 ? type1Amount / floor : 0;
      const type1CurrencyNote = (offer.best_apr_currency || "WETH") !== "WETH" ? ` (${offer.best_apr_amount.toFixed(2)} ${offer.best_apr_currency})` : "";

      if (type1Ltv <= maxLtv && type1Apr > 0) {
        const pricing = priceLoan(marketData, type1Amount, durationDays, config);
        const isProfitable = pricing.minApr < type1Apr;
        const finalApr = Math.min(type1Apr, MAX_APR_CAP);

        if (isProfitable && pricing.isViable) {
          const expectedProfit = type1Amount * finalApr * (durationDays / 365);
          console.log(`  [${slug}] SEND T1 ${durationDays}d | ${type1Amount.toFixed(4)} ETH${type1CurrencyNote} @ ${pct(finalApr)} | minApr ${pct(pricing.minApr)} | LTV ${pct(type1Ltv)}`);

          results.push({
            collection: slug,
            shouldSendOffer: true,
            platform: "gondi",
            reason: `T1 ${pct(finalApr)} APR vs market ${pct(bestAprDecimal)} (minApr ${pct(pricing.minApr)})`,
            offerDetails: {
              loanAmount: type1Amount,
              durationDays,
              recommendedApr: finalApr,
              competitiveApr: finalApr,
              expectedProfit,
              ltv: type1Ltv,
              offerType: "best_apr",
            },
            marketContext: {
              floorPrice: floor,
              volatility: ewmaAnnualized,
              bestMarketApr: bestAprDecimal,
              bestMarketAmount: bestAprAmount,
              bestMarketDuration: durationDays,
            },
          });
        } else {
          const skipReason = !isProfitable
            ? `minApr ${pct(pricing.minApr)} > ourApr ${pct(type1Apr)}`
            : `not viable (risk ${pricing.riskScore}/100)`;
          console.log(`  [${slug}] SKIP T1 ${durationDays}d | ${skipReason} | ${type1Amount.toFixed(4)} ETH${type1CurrencyNote} | LTV ${pct(type1Ltv)} | Market APR ${pct(bestAprDecimal)}`);
        }
      } else if (type1Ltv > maxLtv) {
        console.log(`  [${slug}] SKIP T1 ${durationDays}d | LTV ${pct(type1Ltv)} > max ${pct(maxLtv)} | ${type1Amount.toFixed(4)} ETH${type1CurrencyNote}`);
      }

      // ---- TYPE 2: Best Principal ----
      // Se cale sur la meilleure offre par montant
      const bestPrincipalAmount = toETHEquivalent(offer.best_principal_amount, offer.best_principal_currency || "WETH", ethUsdPrice);
      const bestPrincipalApr = offer.best_principal_apr / 100; // % → decimal
      const type2Amount = bestPrincipalAmount;
      const type2Apr = bestPrincipalApr - config.minSpreadBelowBest;
      const type2Ltv = floor > 0 ? type2Amount / floor : 0;
      const type2CurrencyNote = (offer.best_principal_currency || "WETH") !== "WETH" ? ` (${offer.best_principal_amount.toFixed(2)} ${offer.best_principal_currency})` : "";

      // Skip Type 2 if it's identical to Type 1 (same amount and APR)
      const isDuplicate = Math.abs(type2Amount - type1Amount) < 0.001 && Math.abs(type2Apr - type1Apr) < 0.001;

      if (!isDuplicate && type2Ltv <= maxLtv && type2Apr > 0) {
        const pricing = priceLoan(marketData, type2Amount, durationDays, config);
        const isProfitable = pricing.minApr < type2Apr;
        const finalApr = Math.min(type2Apr, MAX_APR_CAP);

        if (isProfitable && pricing.isViable) {
          const expectedProfit = type2Amount * finalApr * (durationDays / 365);
          console.log(`  [${slug}] SEND T2 ${durationDays}d | ${type2Amount.toFixed(4)} ETH${type2CurrencyNote} @ ${pct(finalApr)} | minApr ${pct(pricing.minApr)} | LTV ${pct(type2Ltv)}`);

          results.push({
            collection: slug,
            shouldSendOffer: true,
            platform: "gondi",
            reason: `T2 ${pct(finalApr)} APR, principal ${type2Amount.toFixed(4)} ETH vs market ${bestPrincipalAmount.toFixed(4)} ETH`,
            offerDetails: {
              loanAmount: type2Amount,
              durationDays,
              recommendedApr: finalApr,
              competitiveApr: finalApr,
              expectedProfit,
              ltv: type2Ltv,
              offerType: "best_principal",
            },
            marketContext: {
              floorPrice: floor,
              volatility: ewmaAnnualized,
              bestMarketApr: bestPrincipalApr,
              bestMarketAmount: bestPrincipalAmount,
              bestMarketDuration: durationDays,
            },
          });
        } else {
          const skipReason = !isProfitable
            ? `minApr ${pct(pricing.minApr)} > ourApr ${pct(type2Apr)}`
            : `not viable (risk ${pricing.riskScore}/100)`;
          console.log(`  [${slug}] SKIP T2 ${durationDays}d | ${skipReason} | ${type2Amount.toFixed(4)} ETH${type2CurrencyNote} | LTV ${pct(type2Ltv)} | Market APR ${pct(bestPrincipalApr)}`);
        }
      } else if (isDuplicate) {
        console.log(`  [${slug}] SKIP T2 ${durationDays}d | duplicate of T1`);
      }
    }

    // ---- BLUR OFFERS ----
    // Check if this collection is supported on Blur Blend
    const collectionConfig = findCollectionBySlug(slug);
    const collectionAddress = collectionConfig?.address || "";

    if (collectionAddress && isBlurSupported(collectionAddress)) {
      // Use Blur's own slug (e.g., "pudgy-penguins") not collections.json slug ("pudgypenguins")
      const blurSlug = BLUR_LENDING_COLLECTIONS[collectionAddress.toLowerCase()];
      const blurData = await getBlurMarketBySlug(blurSlug);

      if (blurData && blurData.best_apr_bps > 0) {
        // Blur: rolling loans, use 30 days for pricing reference
        const blurDurationDays = 30;
        const bestBlurAprDecimal = blurData.best_apr_bps / 10000; // bps → decimal
        const blurOfferApr = bestBlurAprDecimal - 0.01; // undercut by 1%
        const blurAmount = roundToBlurTick(blurData.best_offer_amount_eth);
        const blurLtv = floor > 0 ? blurAmount / floor : 0;

        if (blurAmount >= 0.1 && blurOfferApr > 0 && blurLtv <= maxLtv) {
          const pricing = priceLoan(marketData, blurAmount, blurDurationDays, config);
          const isProfitable = pricing.minApr < blurOfferApr;
          const finalApr = Math.min(blurOfferApr, MAX_APR_CAP);

          if (isProfitable && pricing.isViable) {
            const expectedProfit = blurAmount * finalApr * (blurDurationDays / 365);
            const aprBps = Math.round(finalApr * 10000);
            console.log(`  [${slug}] SEND BLUR | ${blurAmount.toFixed(1)} ETH @ ${aprBps} bps | minApr ${pct(pricing.minApr)} | LTV ${pct(blurLtv)}`);

            results.push({
              collection: slug,
              shouldSendOffer: true,
              platform: "blur",
              reason: `Blur ${aprBps} bps vs market ${blurData.best_apr_bps} bps`,
              offerDetails: {
                loanAmount: blurAmount,
                durationDays: blurDurationDays,
                recommendedApr: finalApr,
                competitiveApr: finalApr,
                expectedProfit,
                ltv: blurLtv,
                offerType: "best_apr",
                collectionAddress,
              },
              marketContext: {
                floorPrice: floor,
                volatility: ewmaAnnualized,
                bestMarketApr: bestBlurAprDecimal,
                bestMarketAmount: blurAmount,
                bestMarketDuration: blurDurationDays,
              },
            });
          } else {
            console.log(`  [${slug}] SKIP BLUR | minApr ${pct(pricing.minApr)} > ${pct(blurOfferApr)} | ${blurAmount.toFixed(1)} ETH`);
          }
        } else if (blurAmount < 0.1) {
          console.log(`  [${slug}] SKIP BLUR | amount ${blurData.best_offer_amount_eth} < 0.1 ETH min`);
        }
      }
    }

    // Si aucune offre viable, retourner un skip
    if (results.length === 0) {
      results.push({
        collection: slug,
        shouldSendOffer: false,
        platform: "gondi",
        reason: "Cannot compete on any platform",
        marketContext: {
          floorPrice: floor,
          volatility: ewmaAnnualized,
          bestMarketApr: gondiOffers[0].best_apr_percent / 100,
          bestMarketAmount: gondiOffers[0].best_apr_amount,
          bestMarketDuration: gondiOffers[0].duration_days,
        },
      });
    }

    return results;
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    results.push({
      collection: slug,
      shouldSendOffer: false,
      platform: "gondi",
      reason: `Error: ${msg}`,
    });
    return results;
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
  const allRecommendations: StrategyRecommendation[] = [];

  console.log(`\n${"=".repeat(70)}`);
  console.log(`🎯 Running Strategy - ${collectionSlugs.length} collections`);
  console.log("=".repeat(70));

  for (const slug of collectionSlugs) {
    console.log(`\n📊 Analyzing ${slug}...`);

    const recommendations = await analyzeCollection(slug, config);
    allRecommendations.push(...recommendations);

    const sends = recommendations.filter(r => r.shouldSendOffer);
    const skips = recommendations.filter(r => !r.shouldSendOffer);

    if (sends.length > 0) {
      console.log(`  ✅ ${sends.length} offer(s) to send:`);
      for (const rec of sends) {
        if (rec.offerDetails) {
          const t = rec.offerDetails.offerType === "best_apr" ? "T1" : "T2";
          console.log(`     ${t} ${rec.offerDetails.durationDays}d: ${rec.offerDetails.loanAmount.toFixed(4)} ETH @ ${(rec.offerDetails.competitiveApr * 100).toFixed(2)}%`);
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

  const { loanAmount, competitiveApr, durationDays, expectedProfit, offerType } = rec.offerDetails;
  const t = offerType === "best_apr" ? "T1" : "T2";

  return [
    `${rec.collection} [${t}]`,
    `${loanAmount.toFixed(3)} ETH @ ${(competitiveApr * 100).toFixed(2)}%`,
    `${durationDays}d | Profit ${expectedProfit.toFixed(4)} ETH`,
  ].join(" | ");
}
