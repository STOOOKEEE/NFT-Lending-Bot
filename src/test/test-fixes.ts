/**
 * test-fixes.ts - Tests pour les 3 fixes: log returns, double annualisation, ETH/USD
 *
 * Usage: npx ts-node src/test/test-fixes.ts
 */

import "dotenv/config";
import { calculateDailyReturns, calculateAllVolatilities, DailyPrice } from "../engines/volatility";
import { priceLoan, annualizeVolatility, DEFAULT_CONFIG } from "../engines/LoanPricer";
import type { MarketData } from "../engines/LoanPricer";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.error(`  ❌ ${label}`);
    failed++;
  }
}

// ==================== TEST 1: LOG RETURNS ====================

function testLogReturns(): void {
  console.log("\n📊 Test 1: calculateDailyReturns uses log returns");

  // If price goes from 10 to 11: log return = ln(11/10) = 0.09531
  // Simple return would be (11-10)/10 = 0.1
  const prices: DailyPrice[] = [
    { date: "2025-01-01", price: 10 },
    { date: "2025-01-02", price: 11 },
  ];

  const returns = calculateDailyReturns(prices);
  const expected = Math.log(11 / 10); // 0.09531...

  assert(returns.length === 1, "One return for two prices");
  assert(Math.abs(returns[0] - expected) < 0.0001, `Log return = ${returns[0].toFixed(5)} (expected ${expected.toFixed(5)})`);
  assert(Math.abs(returns[0] - 0.1) > 0.001, "NOT simple return (0.1)");

  // Test symmetric property of log returns: ln(11/10) = -ln(10/11)
  const pricesDown: DailyPrice[] = [
    { date: "2025-01-01", price: 11 },
    { date: "2025-01-02", price: 10 },
  ];
  const returnsDown = calculateDailyReturns(pricesDown);
  assert(
    Math.abs(returnsDown[0] + returns[0]) < 0.0001,
    `Symmetric: up=${returns[0].toFixed(5)}, down=${returnsDown[0].toFixed(5)}`
  );

  // Test with zero/negative prices -> should be filtered
  const pricesWithZero: DailyPrice[] = [
    { date: "2025-01-01", price: 10 },
    { date: "2025-01-02", price: 0 },
    { date: "2025-01-03", price: 12 },
  ];
  const returnsZero = calculateDailyReturns(pricesWithZero);
  assert(returnsZero.length === 0, "Zero prices filtered out (no log(0))");
}

// ==================== TEST 2: NO DOUBLE ANNUALIZATION ====================

function testNoDoubleAnnualization(): void {
  console.log("\n📊 Test 2: No double annualization in LoanPricer");

  // Create a known annualized volatility
  const annualizedVol = 0.50; // 50% annualized

  // annualizeVolatility(vol, 365) should return vol * sqrt(365/365) = vol * 1
  const result = annualizeVolatility(annualizedVol, 365);
  assert(
    Math.abs(result - annualizedVol) < 0.0001,
    `annualizeVolatility(0.5, 365) = ${result.toFixed(5)} (should be 0.5, no change)`
  );

  // When periodDays = 30, it would multiply by sqrt(365/30) ≈ 3.49 -> BAD
  const resultBad = annualizeVolatility(annualizedVol, 30);
  assert(
    resultBad > annualizedVol * 3,
    `annualizeVolatility(0.5, 30) = ${resultBad.toFixed(2)} (would be 3.5x too high)`
  );

  // Now test full priceLoan flow with periodDays=365 (as Strategy.ts now passes)
  const marketData: MarketData = {
    floorPrice: 10,
    middlePrice: 9,
    topBid: 8,
    volatility: 0.50,          // Already annualized
  };

  const pricing = priceLoan(marketData, 4.0, 30, DEFAULT_CONFIG);

  // The adjusted vol should be ~0.50 * 1.3 (safetyMultiplier) = 0.65
  // NOT 0.50 * sqrt(365/30) * 1.3 = ~2.27
  assert(
    pricing.details.annualizedVolatility < 1.0,
    `Adjusted vol = ${(pricing.details.annualizedVolatility * 100).toFixed(1)}% (should be ~65%, not ~227%)`
  );
  assert(
    pricing.details.annualizedVolatility > 0.5 && pricing.details.annualizedVolatility < 0.8,
    `Adjusted vol in expected range 50-80% (got ${(pricing.details.annualizedVolatility * 100).toFixed(1)}%)`
  );
}

// ==================== TEST 3: VOLATILITY END TO END ====================

function testVolatilityEndToEnd(): void {
  console.log("\n📊 Test 3: Volatility end-to-end (daily -> annualized -> pricer)");

  // Simulate 30 days of prices with ~2% daily moves
  const prices: DailyPrice[] = [];
  let price = 10;
  for (let i = 0; i < 31; i++) {
    prices.push({
      date: `2025-01-${String(i + 1).padStart(2, "0")}`,
      price,
    });
    // Random-ish walk: alternate +2% and -1.5%
    price *= i % 2 === 0 ? 1.02 : 0.985;
  }

  const volResult = calculateAllVolatilities(prices);

  assert(volResult.daily > 0, `Daily vol > 0 (got ${(volResult.daily * 100).toFixed(3)}%)`);
  assert(volResult.annualized > volResult.daily, `Annualized > daily`);

  // Annualized should be daily * sqrt(365), roughly 19x daily
  const ratio = volResult.annualized / volResult.daily;
  assert(
    Math.abs(ratio - Math.sqrt(365)) < 1,
    `Annualized/daily ratio = ${ratio.toFixed(1)} (expected ~${Math.sqrt(365).toFixed(1)})`
  );

  // Now feed into pricer with periodDays=365 (as Strategy does after fix)
  const marketData: MarketData = {
    floorPrice: 10,
    middlePrice: 9.5,
    topBid: 9,
    volatility: volResult.annualized,
  };

  const pricing = priceLoan(marketData, 4.0, 30, DEFAULT_CONFIG);
  assert(pricing.isViable, "Offer should be viable at 40% LTV with moderate vol");
  assert(
    pricing.minApr < 1.0,
    `Min APR = ${(pricing.minApr * 100).toFixed(1)}% (should be < 100% for sane vol)`
  );
}

// ==================== TEST 4: ETH/USD FETCH ====================

async function testEthUsdFetch(): Promise<void> {
  console.log("\n📊 Test 4: ETH/USD price fetch from CoinGecko");

  try {
    const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd");
    const data = await res.json() as { ethereum?: { usd?: number } };
    const price = data?.ethereum?.usd;

    assert(price !== undefined && price > 0, `ETH price fetched: $${price}`);
    assert(price! > 500 && price! < 50000, `Price in sane range ($500-$50000)`);

    // Test conversion
    const usdcAmount = 5000;
    const ethEquivalent = usdcAmount / price!;
    assert(ethEquivalent > 0.1 && ethEquivalent < 50, `5000 USDC = ${ethEquivalent.toFixed(4)} ETH`);
  } catch {
    console.log("  ⏭️  CoinGecko API unreachable, skipping");
  }
}

// ==================== MAIN ====================

async function main() {
  console.log("🧪 Fixes Validation Tests");
  console.log("=".repeat(60));

  testLogReturns();
  testNoDoubleAnnualization();
  testVolatilityEndToEnd();
  await testEthUsdFetch();

  console.log(`\n${"=".repeat(60)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("=".repeat(60));

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("❌ Test crashed:", err);
  process.exit(1);
});
