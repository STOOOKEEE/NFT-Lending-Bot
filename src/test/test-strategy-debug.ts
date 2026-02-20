/**
 * test-strategy-debug.ts — Debug complet du pipeline de sélection d'offres
 *
 * Usage: npx tsx src/test/test-strategy-debug.ts [collection-slug]
 * Exemple: npx tsx src/test/test-strategy-debug.ts rektguy
 *
 * Sans argument: teste toutes les collections principales
 */

import "dotenv/config";

import { getLatestFloorPrice } from "../utils/price-db";
import { calculateVolatilityFromDb, annualizeVolatility } from "../engines/volatility";
import { getOffersByCollection } from "../utils/gondi-db";
import {
  priceLoan,
  blackScholesPut,
  type MarketData,
  DEFAULT_CONFIG,
} from "../engines/LoanPricer";

// Config identique à Strategy.ts
const MAX_APR_CAP = 0.5;
const config = { ...DEFAULT_CONFIG };

const SEPARATOR = "─".repeat(70);
const HEADER = "═".repeat(70);

// ==================== ETH PRICE ====================

let cachedEthPrice: number | null = null;
let ethPriceFetchedAt = 0;
const ETH_PRICE_CACHE_MS = 10 * 60 * 1000;

async function getEthUsdPrice(): Promise<number> {
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

function toETHEquivalent(amount: number, currency: string, ethUsdPrice: number): number {
  if (currency === "USDC" || currency === "HUSDC") {
    return amount / ethUsdPrice;
  }
  return amount;
}

// ==================== HELPERS ====================

function pct(v: number): string {
  return `${(v * 100).toFixed(2)}%`;
}

function eth(v: number): string {
  return `${v.toFixed(4)} ETH`;
}

// ==================== ANALYSE DÉTAILLÉE ====================

async function debugCollection(slug: string): Promise<void> {
  console.log(`\n${HEADER}`);
  console.log(`  📊 DEBUG: ${slug}`);
  console.log(HEADER);

  // ── STEP 1: Prix ──
  console.log(`\n${SEPARATOR}`);
  console.log("  STEP 1: Prix (Supabase → price_history)");
  console.log(SEPARATOR);

  const latestPrice = await getLatestFloorPrice(slug);
  if (!latestPrice) {
    console.log("  ❌ Aucun prix en DB. STOP.");
    return;
  }

  const { floor, bid, mid } = latestPrice;
  const spread = floor > 0 ? (floor - bid) / floor : 0;

  console.log(`  Floor:    ${eth(floor)}`);
  console.log(`  Top Bid:  ${eth(bid)}`);
  console.log(`  Mid:      ${eth(mid)}`);
  console.log(`  Spread:   ${pct(spread)}`);

  // ── STEP 2: Volatilité ──
  console.log(`\n${SEPARATOR}`);
  console.log("  STEP 2: Volatilité (Supabase → price_history, 30j)");
  console.log(SEPARATOR);

  const volResult = await calculateVolatilityFromDb(slug, 30);

  const ewmaAnnualized = annualizeVolatility(volResult.ewma);

  console.log(`  Daily (std):     ${pct(volResult.daily)}`);
  console.log(`  Daily (EWMA):    ${pct(volResult.ewma)}`);
  console.log(`  Std annualized:  ${pct(volResult.annualized)} (non utilisé)`);
  console.log(`  EWMA annualized: ${pct(ewmaAnnualized)} ← UTILISÉ`);

  if (volResult.ewma === 0) {
    console.log("  ❌ Volatilité EWMA = 0, pas assez de données. STOP.");
    return;
  }

  // Vérifier la volatilité ajustée par le pricer
  const adjustedVol = ewmaAnnualized * config.safetyMultiplier;
  console.log(`  Adjusted (×${config.safetyMultiplier}): ${pct(adjustedVol)}`);

  // ── STEP 3: Offres Gondi ──
  console.log(`\n${SEPARATOR}`);
  console.log("  STEP 3: Offres Gondi (Supabase → gondi_best_offers_latest)");
  console.log(SEPARATOR);

  const gondiOffers = await getOffersByCollection(slug);

  if (gondiOffers.length === 0) {
    console.log("  ❌ Aucune offre Gondi. STOP.");
    return;
  }

  // Récupérer le prix ETH/USD pour convertir les offres USDC
  const ethUsdPrice = await getEthUsdPrice();
  console.log(`  ETH/USD: $${ethUsdPrice.toFixed(0)}`);
  console.log(`  ${gondiOffers.length} durée(s) trouvée(s):\n`);

  for (const offer of gondiOffers) {
    const aprDecimal = offer.best_apr_percent / 100;
    const currency = offer.best_apr_currency || "WETH";
    const rawAmount = offer.best_apr_amount;
    const amountETH = toETHEquivalent(rawAmount, currency, ethUsdPrice);
    const ltv = floor > 0 ? amountETH / floor : 0;
    const currencyNote = currency !== "WETH" ? ` (${rawAmount.toFixed(2)} ${currency} → ${eth(amountETH)})` : "";
    const principalCurrency = offer.best_principal_currency || "WETH";
    const principalETH = toETHEquivalent(offer.best_principal_amount, principalCurrency, ethUsdPrice);
    const principalNote = principalCurrency !== "WETH" ? ` (${offer.best_principal_amount.toFixed(2)} ${principalCurrency} → ${eth(principalETH)})` : "";
    console.log(`  📋 ${offer.duration_days}d:`);
    console.log(`     Best APR:    ${offer.best_apr_percent.toFixed(2)}% (DB) → ${pct(aprDecimal)} (decimal)`);
    console.log(`     Amount:      ${eth(amountETH)}${currencyNote} (LTV ${pct(ltv)})`);
    console.log(`     Best Principal: ${eth(principalETH)}${principalNote} @ ${(offer.best_principal_apr / 100).toFixed(2)}%`);
    console.log(`     Lender APR:  ${offer.best_apr_lender.slice(0, 10)}...`);
    console.log(`     Expires:     ${offer.best_apr_expiration}`);
  }

  // ── STEP 4: Pricing pour chaque durée ──
  console.log(`\n${SEPARATOR}`);
  console.log("  STEP 4: Pricing (LoanPricer) pour chaque durée");
  console.log(SEPARATOR);

  const marketData: MarketData = {
    floorPrice: floor,
    middlePrice: mid,
    topBid: bid,
    volatility: ewmaAnnualized,
    spread,
  };

  // Calculer le spot price utilisé par le pricer
  let spotPrice: number;
  if (spread < 0.10) {
    spotPrice = floor;
  } else if (spread > 0.30) {
    spotPrice = bid * 0.85 + floor * 0.15;
  } else {
    const t = (spread - 0.10) / (0.30 - 0.10);
    const bidWeight = 0.50 + 0.35 * t;
    spotPrice = bid * bidWeight + floor * (1 - bidWeight);
  }
  console.log(`\n  Spot price utilisé par Black-Scholes: ${eth(spotPrice)}`);
  console.log(`  Config: riskFreeRate=${pct(config.riskFreeRate)} liquidityPremium=${pct(config.liquidityPremium)} safety=${config.safetyMultiplier}x spread=${pct(config.minSpreadBelowBest)}`);

  for (const offer of gondiOffers) {
    const bestMarketApr = offer.best_apr_percent / 100;
    const currency = offer.best_apr_currency || "WETH";
    const rawAmount = offer.best_apr_amount;
    const bestMarketAmount = toETHEquivalent(rawAmount, currency, ethUsdPrice);
    const durationDays = offer.duration_days;
    const ourApr = bestMarketApr - config.minSpreadBelowBest;
    const ourLtv = floor > 0 ? bestMarketAmount / floor : 0;
    const currencyNote = currency !== "WETH" ? ` (${rawAmount.toFixed(2)} ${currency})` : "";

    console.log(`\n  ┌─── ${durationDays}d: ${eth(bestMarketAmount)}${currencyNote} @ marché ${pct(bestMarketApr)} ───`);
    console.log(`  │ Notre APR cible: ${pct(ourApr)} (marché - ${pct(config.minSpreadBelowBest)})`);
    console.log(`  │ LTV: ${pct(ourLtv)}`);

    // Check LTV
    if (ourLtv > 0.80) {
      console.log(`  │ ❌ LTV > 80% → SKIP`);
      console.log(`  └───`);
      continue;
    }

    // Pricing
    const pricing = priceLoan(marketData, bestMarketAmount, durationDays, config);
    const T = durationDays / 365;

    // Black-Scholes détails
    const K = bestMarketAmount;
    const bsResult = blackScholesPut(spotPrice, K, T, config.riskFreeRate, adjustedVol);

    console.log(`  │`);
    console.log(`  │ Black-Scholes:`);
    console.log(`  │   S (spot):    ${eth(spotPrice)}`);
    console.log(`  │   K (strike):  ${eth(K)}`);
    console.log(`  │   T (years):   ${T.toFixed(4)}`);
    console.log(`  │   σ (vol adj): ${pct(adjustedVol)}`);
    console.log(`  │   d1:          ${bsResult.d1.toFixed(4)}`);
    console.log(`  │   d2:          ${bsResult.d2.toFixed(4)}`);
    console.log(`  │   Put premium: ${eth(bsResult.premium)}`);
    console.log(`  │`);
    console.log(`  │ Pricing Result:`);
    console.log(`  │   Put premium:       ${eth(pricing.putPremium)}`);
    console.log(`  │   Liquidity premium: ${eth(bestMarketAmount * config.liquidityPremium * T)}`);
    console.log(`  │   Total premium:     ${eth(pricing.putPremium + bestMarketAmount * config.liquidityPremium * T)}`);
    console.log(`  │   Min APR:           ${pct(pricing.minApr)}`);
    console.log(`  │   Recommended APR:   ${pct(pricing.recommendedApr)}`);
    console.log(`  │   Risk Score:        ${pricing.riskScore}/100`);
    console.log(`  │   isViable:          ${pricing.isViable}`);

    // Décision
    const isProfitable = pricing.minApr < ourApr;
    const finalApr = Math.min(ourApr, MAX_APR_CAP);
    const expectedProfit = bestMarketAmount * finalApr * T;

    console.log(`  │`);
    console.log(`  │ Décision:`);
    console.log(`  │   minApr (${pct(pricing.minApr)}) < ourApr (${pct(ourApr)}) ? ${isProfitable ? "✅ OUI" : "❌ NON"}`);
    console.log(`  │   isViable? ${pricing.isViable ? "✅ OUI" : "❌ NON"}`);

    if (isProfitable && pricing.isViable) {
      console.log(`  │   → ✅ ENVOYER: ${eth(bestMarketAmount)} @ ${pct(finalApr)} for ${durationDays}d`);
      console.log(`  │   → Profit attendu: ${eth(expectedProfit)}`);
      console.log(`  │   → Marge de sécurité: ${pct(ourApr - pricing.minApr)}`);
    } else {
      console.log(`  │   → ❌ SKIP: Non rentable`);
      if (!isProfitable) {
        console.log(`  │     Raison: minApr ${pct(pricing.minApr)} > ourApr ${pct(ourApr)}`);
        console.log(`  │     Il faudrait un marché à > ${pct(pricing.minApr + config.minSpreadBelowBest)} pour être rentable`);
      }
    }
    console.log(`  └───`);
  }
}

// ==================== MAIN ====================

async function main(): Promise<void> {
  const targetSlug = process.argv[2];

  const defaultSlugs = [
    "rektguy",
    "boredapeyachtclub",
    "pudgypenguins",
    "milady",
    "azuki",
    "wrapped-cryptopunks",
    "doodles-official",
    "clonex",
  ];

  const slugs = targetSlug ? [targetSlug] : defaultSlugs;

  console.log("╔══════════════════════════════════════════════════════════════════════╗");
  console.log("║           🔬 DEBUG: Pipeline de sélection d'offres                 ║");
  console.log("╠══════════════════════════════════════════════════════════════════════╣");
  console.log(`║  Config LoanPricer:                                                ║`);
  console.log(`║    riskFreeRate:      ${pct(config.riskFreeRate).padEnd(8)}                                   ║`);
  console.log(`║    liquidityPremium:  ${pct(config.liquidityPremium).padEnd(8)}                                   ║`);
  console.log(`║    safetyMultiplier:  ${config.safetyMultiplier}x                                       ║`);
  console.log(`║    minSpreadBelowBest: ${pct(config.minSpreadBelowBest).padEnd(8)}                                  ║`);
  console.log(`║    MAX_APR_CAP:       ${pct(MAX_APR_CAP).padEnd(8)}                                   ║`);
  console.log("╚══════════════════════════════════════════════════════════════════════╝");

  for (const slug of slugs) {
    await debugCollection(slug);
  }

  console.log(`\n${"═".repeat(70)}`);
  console.log("  ✅ Debug terminé");
  console.log("═".repeat(70));
}

main().catch(console.error);
