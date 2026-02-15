/**
 * helpers.ts - Fonctions utilitaires partagées
 */

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const DURATION_BUCKETS = [5, 7, 10, 15, 30, 60, 90, 120];

export function getDurationBucket(durationDays: number): number {
  for (const bucket of DURATION_BUCKETS) {
    if (durationDays <= bucket) return bucket;
  }
  return DURATION_BUCKETS[DURATION_BUCKETS.length - 1];
}

/** Converts an amount to ETH equivalent using dynamic ETH/USD price */
export function toETHEquivalent(amount: number, currency: string, ethUsdPrice: number): number {
  if (currency === "USDC" || currency === "HUSDC") {
    return amount / ethUsdPrice;
  }
  return amount;
}

/** Cached ETH/USD price from CoinGecko */
let cachedEthPrice: number | null = null;
let ethPriceFetchedAt = 0;
const ETH_PRICE_CACHE_MS = 10 * 60 * 1000;

export async function getEthUsdPrice(): Promise<number> {
  const now = Date.now();
  if (cachedEthPrice && now - ethPriceFetchedAt < ETH_PRICE_CACHE_MS) {
    return cachedEthPrice;
  }
  try {
    const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd");
    const data = await res.json() as { ethereum?: { usd?: number } };
    const price = data?.ethereum?.usd;
    if (price && price > 0) {
      cachedEthPrice = price;
      ethPriceFetchedAt = now;
      return price;
    }
  } catch {
    // Fallback silencieux
  }
  return cachedEthPrice || 2500;
}
