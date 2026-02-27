/**
 * blur-market-collector.ts - Collecte les données marché Blur Blend
 *
 * Utilise l'API RapidAPI Blur:
 * - GET /v1/blend/aggregated-loan-offers/{collection} → lending book (rate + amount)
 * - GET /v1/collections/{collection} → floor price + bestCollectionLoanOffer
 *
 * Donne pour chaque collection: meilleur APR, montant, liquidité totale, floor
 */

import { BLUR_LENDING_COLLECTIONS } from "../config/blur-collections";

// Re-export for backwards compatibility
export const BLUR_SUPPORTED_COLLECTIONS = BLUR_LENDING_COLLECTIONS;

// ==================== TYPES ====================

export interface BlurMarketSummary {
  collectionAddress: string;
  collectionSlug: string;
  bestAprBps: number;
  bestOfferAmountEth: number;
  totalLiquidityEth: number;
  offerLevels: number;
  floorPriceEth: number;
  snapshotTime: string;
}

interface AggregatedOffer {
  interestRate: string;
  amount: string;
}

interface AggregatedResponse {
  success: boolean;
  offers: AggregatedOffer[];
}

interface CollectionResponse {
  success: boolean;
  collection: {
    floorPrice: { amount: string; unit: string } | null;
    bestCollectionLoanOffer: { amount: string; unit: string } | null;
  };
}

// ==================== API HELPERS ====================

function getApiKey(): string {
  const key = process.env.RAPIDAPI_KEY;
  if (!key) throw new Error("RAPIDAPI_KEY required in .env for Blur market collection");
  return key;
}

function apiHeaders(): Record<string, string> {
  return {
    "x-rapidapi-key": getApiKey(),
    "x-rapidapi-host": "blur.p.rapidapi.com",
  };
}

async function fetchAggregatedOffers(contractAddress: string): Promise<AggregatedOffer[]> {
  const resp = await fetch(
    `https://blur.p.rapidapi.com/v1/blend/aggregated-loan-offers/${contractAddress}`,
    { headers: apiHeaders() }
  );

  if (!resp.ok) {
    console.log(`  [blur-api] aggregated-offers failed for ${contractAddress}: ${resp.status}`);
    return [];
  }

  const data = (await resp.json()) as AggregatedResponse;
  return data.offers || [];
}

async function fetchCollectionData(contractAddress: string): Promise<{ floorEth: number }> {
  const resp = await fetch(
    `https://blur.p.rapidapi.com/v1/collections/${contractAddress}`,
    { headers: apiHeaders() }
  );

  if (!resp.ok) {
    return { floorEth: 0 };
  }

  const data = (await resp.json()) as CollectionResponse;
  const floor = data.collection?.floorPrice;
  return { floorEth: floor ? parseFloat(floor.amount) : 0 };
}

// ==================== COLLECTOR ====================

/**
 * Collecte les données marché Blur pour toutes les collections supportées
 */
export async function collectBlurMarketData(): Promise<BlurMarketSummary[]> {
  console.log(`\n  [blur] Collecting Blur Blend market data via API...`);

  const summaries: BlurMarketSummary[] = [];
  const now = new Date().toISOString();
  const entries = Object.entries(BLUR_SUPPORTED_COLLECTIONS);

  for (const [address, slug] of entries) {
    // 1. Lending book (aggregated offers by rate)
    const offers = await fetchAggregatedOffers(address);
    await new Promise(r => setTimeout(r, 1100));

    // 2. Floor price
    const { floorEth } = await fetchCollectionData(address);
    await new Promise(r => setTimeout(r, 1100));

    // Filter out zero-amount levels
    const validOffers = offers.filter(o => parseFloat(o.amount) > 0);

    if (validOffers.length === 0) {
      console.log(`  [blur] ${slug}: no offers`);
      continue;
    }

    // Best offer = lowest rate with amount > 0
    const bestOffer = validOffers[0];
    const bestAprBps = parseInt(bestOffer.interestRate, 10);
    const bestOfferAmount = parseFloat(bestOffer.amount);
    const totalLiquidity = validOffers.reduce((sum, o) => sum + parseFloat(o.amount), 0);

    summaries.push({
      collectionAddress: address,
      collectionSlug: slug,
      bestAprBps,
      bestOfferAmountEth: bestOfferAmount,
      totalLiquidityEth: totalLiquidity,
      offerLevels: validOffers.length,
      floorPriceEth: floorEth,
      snapshotTime: now,
    });

    console.log(`  [blur] ${slug}: best ${(bestAprBps / 100).toFixed(1)}% @ ${bestOfferAmount} ETH | floor ${floorEth} | ${validOffers.length} levels | ${totalLiquidity.toFixed(1)} ETH total`);
  }

  // Sort by liquidity (most liquid first)
  summaries.sort((a, b) => b.totalLiquidityEth - a.totalLiquidityEth);
  return summaries;
}

/**
 * Affiche les résultats de la collecte
 */
export function displayBlurMarketData(summaries: BlurMarketSummary[]): void {
  if (summaries.length === 0) {
    console.log("  [blur] No Blur lending data found");
    return;
  }

  console.log(`\n  ${"Collection".padEnd(22)} ${"Best APR".padEnd(10)} ${"Best Amt".padEnd(10)} ${"Total Liq".padEnd(12)} ${"Levels".padEnd(8)} ${"Floor".padEnd(10)}`);
  console.log("  " + "-".repeat(72));

  for (const s of summaries) {
    const name = s.collectionSlug.slice(0, 21).padEnd(22);
    const bestApr = `${(s.bestAprBps / 100).toFixed(1)}%`.padEnd(10);
    const bestAmt = `${s.bestOfferAmountEth.toFixed(2)} E`.padEnd(10);
    const liq = `${s.totalLiquidityEth.toFixed(1)} ETH`.padEnd(12);
    const levels = `${s.offerLevels}`.padEnd(8);
    const floor = s.floorPriceEth > 0 ? `${s.floorPriceEth.toFixed(3)} E`.padEnd(10) : "N/A".padEnd(10);
    console.log(`  ${name} ${bestApr} ${bestAmt} ${liq} ${levels} ${floor}`);
  }
}
