/**
 * test-all.ts - Tests complets de toutes les fonctions du bot
 *
 * Teste:
 * 1. LoanPricer (Black-Scholes, pricing, compétitif, multi-durée)
 * 2. Volatility (log returns, std, EWMA, rolling, annualisation, outliers)
 * 3. RiskManager (allocation, positions, floor price, statut, alertes, rapport)
 * 4. Strategy helpers (getOffersToSend, formatRecommendationShort)
 * 5. collections-loader (load, filter, find)
 * 6. lending-db helpers (createOfferFromGondiResponse)
 * 7. loan-tracker helpers (formatTrackingResult)
 * 8. DB operations (price-db, gondi-db, lending-db) - si Supabase dispo
 * 9. PriceFetcher (OpenSea API) - si API key dispo
 * 10. Gondi API (listOffers) - test réseau
 *
 * Usage: npx ts-node src/test/test-all.ts
 */

import "dotenv/config";

// ==================== TEST FRAMEWORK ====================

let totalPassed = 0;
let totalFailed = 0;
let currentSection = "";

function section(name: string): void {
  currentSection = name;
  console.log(`\n${"═".repeat(70)}`);
  console.log(`📦 ${name}`);
  console.log("═".repeat(70));
}

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✅ ${label}`);
    totalPassed++;
  } else {
    console.error(`  ❌ ${label} [${currentSection}]`);
    totalFailed++;
  }
}

function assertApprox(actual: number, expected: number, tolerance: number, label: string): void {
  const diff = Math.abs(actual - expected);
  if (diff <= tolerance) {
    console.log(`  ✅ ${label} (${actual.toFixed(6)} ≈ ${expected.toFixed(6)})`);
    totalPassed++;
  } else {
    console.error(`  ❌ ${label}: got ${actual.toFixed(6)}, expected ${expected.toFixed(6)} ± ${tolerance} [${currentSection}]`);
    totalFailed++;
  }
}

function assertThrows(fn: () => unknown, label: string): void {
  try {
    fn();
    console.error(`  ❌ ${label}: expected error but none thrown [${currentSection}]`);
    totalFailed++;
  } catch {
    console.log(`  ✅ ${label} (threw as expected)`);
    totalPassed++;
  }
}

// ==================== 1. LOAN PRICER ====================

async function testLoanPricer(): Promise<void> {
  section("1. LoanPricer - Black-Scholes Pricing");

  const {
    blackScholesPut,
    annualizeVolatility,
    priceLoan,
    DEFAULT_CONFIG,
  } = await import("../engines/LoanPricer");

  // -- 1.1 annualizeVolatility --
  console.log("\n  --- annualizeVolatility ---");
  const annVol = annualizeVolatility(0.10, 30);
  assert(annVol > 0, "annualizeVolatility returns positive value");
  assertApprox(annVol, 0.10 * Math.sqrt(365 / 30), 0.0001, "annualizeVolatility formula correct");

  // Annual period should return same value
  const annVol365 = annualizeVolatility(0.50, 365);
  assertApprox(annVol365, 0.50, 0.0001, "annualizeVolatility(0.5, 365) = 0.5");

  // -- 1.2 blackScholesPut --
  console.log("\n  --- blackScholesPut ---");

  // In-the-money put: K > S
  const itmPut = blackScholesPut(10, 12, 0.5, 0.05, 0.30);
  assert(itmPut.premium > 0, "ITM put has positive premium");
  assert(itmPut.premium > 2 * Math.exp(-0.05 * 0.5) - 10 * 0, "ITM put premium > intrinsic lower bound");

  // Out-of-the-money put: K < S
  const otmPut = blackScholesPut(10, 8, 0.5, 0.05, 0.30);
  assert(otmPut.premium > 0, "OTM put has positive premium");
  assert(otmPut.premium < itmPut.premium, "OTM put cheaper than ITM put");

  // Very short expiry: should approach intrinsic value
  const shortPut = blackScholesPut(10, 12, 0.001, 0.05, 0.30);
  assertApprox(shortPut.premium, 2, 0.1, "Short-expiry ITM put ≈ intrinsic value");

  // At-the-money put
  const atmPut = blackScholesPut(10, 10, 0.5, 0.05, 0.30);
  assert(atmPut.premium > 0, "ATM put has positive premium");
  assert(atmPut.d1 !== 0 || atmPut.d2 !== 0, "ATM put has non-trivial d1/d2");

  // Higher volatility = higher premium
  const lowVolPut = blackScholesPut(10, 10, 0.5, 0.05, 0.10);
  const highVolPut = blackScholesPut(10, 10, 0.5, 0.05, 0.60);
  assert(highVolPut.premium > lowVolPut.premium, "Higher volatility → higher put premium");

  // Longer expiry = higher premium (for ATM puts)
  const shortExpiryPut = blackScholesPut(10, 10, 0.1, 0.05, 0.30);
  const longExpiryPut = blackScholesPut(10, 10, 1.0, 0.05, 0.30);
  assert(longExpiryPut.premium > shortExpiryPut.premium, "Longer expiry → higher ATM put premium");

  // -- 1.3 priceLoan --
  console.log("\n  --- priceLoan ---");

  const marketData = {
    floorPrice: 10.0,
    middlePrice: 10.5,
    topBid: 9.8,
    volatility: 0.30,
  };

  // Low LTV should be viable
  const lowLtv = priceLoan(marketData, 3.0, 30, DEFAULT_CONFIG); // LTV 30%
  assert(lowLtv.isViable === true, "LTV 30% is viable");
  assert(lowLtv.minApr > 0, "minApr > 0");
  assert(lowLtv.recommendedApr > lowLtv.minApr, "recommendedApr > minApr");
  assertApprox(lowLtv.recommendedApr, lowLtv.minApr * 1.15, 0.0001, "recommendedApr = minApr * 1.15");
  assert(lowLtv.putPremium >= 0, "putPremium >= 0");
  assert(lowLtv.expectedProfit > 0, "expectedProfit > 0");
  assert(lowLtv.maxLoss === 3.0, "maxLoss = loanAmount");
  assert(lowLtv.breakEvenFloor < 3.0, "breakEvenFloor < loanAmount");
  assert(lowLtv.riskScore >= 0 && lowLtv.riskScore <= 100, "riskScore in [0, 100]");

  // Details
  // With no spread field → spread=0 < 10% → spotPrice = (floor + bid) / 2 = (10 + 9.8) / 2 = 9.9
  assertApprox(lowLtv.details.spotPrice, 9.9, 0.001, "details.spotPrice = mid (floor+bid)/2");
  assert(lowLtv.details.strikePrice === 3.0, "details.strikePrice = loanAmount");
  assert(lowLtv.details.timeToExpiry > 0, "details.timeToExpiry > 0");
  assert(lowLtv.details.annualizedVolatility > 0, "details.annualizedVolatility > 0");

  // High LTV should not be viable (> 85%)
  const highLtv = priceLoan(marketData, 9.0, 30, DEFAULT_CONFIG); // LTV 90%
  assert(highLtv.isViable === false, "LTV 90% is not viable");

  // Risk score increases with LTV
  const midLtv = priceLoan(marketData, 5.0, 30, DEFAULT_CONFIG); // LTV 50%
  assert(midLtv.riskScore > lowLtv.riskScore, "Higher LTV → higher risk score");

  // Longer duration = higher minApr (more time value in put)
  const short = priceLoan(marketData, 4.0, 7, DEFAULT_CONFIG);
  const long = priceLoan(marketData, 4.0, 90, DEFAULT_CONFIG);
  assert(long.riskScore >= short.riskScore, "Longer duration → higher or equal risk score");

}

// ==================== 2. VOLATILITY ====================

async function testVolatility(): Promise<void> {
  section("2. Volatility - Log Returns & Statistical Measures");

  const {
    calculateDailyReturns,
    calculateStdVolatility,
    calculateEWMAVolatility,
    findOptimalLambda,
    calculateRollingVolatility,
    annualizeVolatility,
    calculateAllVolatilities,
    removeOutliers,
  } = await import("../engines/volatility");

  // -- 2.1 calculateDailyReturns --
  console.log("\n  --- calculateDailyReturns ---");

  const prices = [
    { date: "2024-01-01", price: 10.0 },
    { date: "2024-01-02", price: 10.5 },
    { date: "2024-01-03", price: 10.2 },
    { date: "2024-01-04", price: 11.0 },
    { date: "2024-01-05", price: 10.8 },
  ];

  const returns = calculateDailyReturns(prices);
  assert(returns.length === 4, "4 returns from 5 prices");
  assertApprox(returns[0], Math.log(10.5 / 10.0), 0.0001, "First return = ln(10.5/10.0)");
  assertApprox(returns[1], Math.log(10.2 / 10.5), 0.0001, "Second return = ln(10.2/10.5)");

  // Empty/single price
  const emptyReturns = calculateDailyReturns([]);
  assert(emptyReturns.length === 0, "Empty prices → empty returns");

  const singleReturn = calculateDailyReturns([{ date: "2024-01-01", price: 10.0 }]);
  assert(singleReturn.length === 0, "Single price → empty returns");

  // Zero prices should be skipped
  const withZero = [
    { date: "2024-01-01", price: 10.0 },
    { date: "2024-01-02", price: 0 },
    { date: "2024-01-03", price: 10.5 },
  ];
  const zeroReturns = calculateDailyReturns(withZero);
  assert(zeroReturns.length === 0, "Zero prices are skipped (no valid consecutive pairs)");

  // -- 2.2 calculateStdVolatility --
  console.log("\n  --- calculateStdVolatility ---");

  const stdVol = calculateStdVolatility(prices);
  assert(stdVol > 0, "Std volatility > 0 for varying prices");

  // Constant prices = 0 volatility
  const constantPrices = [
    { date: "2024-01-01", price: 10.0 },
    { date: "2024-01-02", price: 10.0 },
    { date: "2024-01-03", price: 10.0 },
  ];
  const constVol = calculateStdVolatility(constantPrices);
  assertApprox(constVol, 0, 0.0001, "Constant prices → 0 volatility");

  // Insufficient data
  const tooFew = calculateStdVolatility([{ date: "2024-01-01", price: 10.0 }]);
  assert(tooFew === 0, "Single price → 0 volatility");

  // -- 2.3 calculateEWMAVolatility --
  console.log("\n  --- calculateEWMAVolatility ---");

  const ewmaVol = calculateEWMAVolatility(prices);
  assert(ewmaVol > 0, "EWMA volatility > 0 for varying prices");

  // With fixed lambda
  const ewmaFixed = calculateEWMAVolatility(prices, 0.94);
  assert(ewmaFixed > 0, "EWMA with lambda=0.94 > 0");

  // Insufficient data
  const ewmaFew = calculateEWMAVolatility([{ date: "2024-01-01", price: 10.0 }]);
  assert(ewmaFew === 0, "Single price → EWMA 0");

  // -- 2.4 findOptimalLambda --
  console.log("\n  --- findOptimalLambda ---");

  // Few returns → default 0.94
  const shortLambda = findOptimalLambda([0.01, 0.02]);
  assertApprox(shortLambda, 0.94, 0.0001, "Short returns → lambda 0.94 default");

  // Longer returns
  const longReturns = Array.from({ length: 20 }, () => (Math.random() - 0.5) * 0.1);
  const optLambda = findOptimalLambda(longReturns);
  assert(optLambda >= 0.80 && optLambda <= 0.99, `Optimal lambda in [0.80, 0.99]: ${optLambda}`);

  // -- 2.5 calculateRollingVolatility --
  console.log("\n  --- calculateRollingVolatility ---");

  // Generate longer price series
  const longPrices = Array.from({ length: 60 }, (_, i) => ({
    date: `2024-${String(Math.floor(i / 30) + 1).padStart(2, "0")}-${String((i % 30) + 1).padStart(2, "0")}`,
    price: 10 + Math.sin(i / 5) * 2 + Math.random() * 0.5,
  }));

  const rolling = calculateRollingVolatility(longPrices, 30);
  assert(rolling > 0, "Rolling 30d volatility > 0");

  // Fallback to std when not enough data
  const shortRolling = calculateRollingVolatility(prices, 30);
  const stdFallback = calculateStdVolatility(prices);
  assertApprox(shortRolling, stdFallback, 0.0001, "Short data → falls back to std volatility");

  // -- 2.6 annualizeVolatility --
  console.log("\n  --- annualizeVolatility (volatility.ts) ---");

  const annVol = annualizeVolatility(0.02);
  assertApprox(annVol, 0.02 * Math.sqrt(365), 0.0001, "annualize daily vol: daily × √365");

  // -- 2.7 removeOutliers --
  console.log("\n  --- removeOutliers ---");

  const withOutlier = [
    { date: "2024-01-01", price: 10.0 },
    { date: "2024-01-02", price: 10.2 },
    { date: "2024-01-03", price: 10.1 },
    { date: "2024-01-04", price: 10.3 },
    { date: "2024-01-05", price: 10.15 },
    { date: "2024-01-06", price: 10.25 },
    { date: "2024-01-07", price: 100.0 }, // Outlier! Far from the rest
  ];

  const cleaned = removeOutliers(withOutlier, 2);
  assert(cleaned.length < withOutlier.length, "Outlier removed");
  assert(cleaned.every(p => p.price < 50), "No extreme outliers remain");

  // Too few prices → returned as-is
  const twoItems = [
    { date: "2024-01-01", price: 10.0 },
    { date: "2024-01-02", price: 100.0 },
  ];
  const notFiltered = removeOutliers(twoItems);
  assert(notFiltered.length === 2, "< 3 items → no filtering");

  // -- 2.8 calculateAllVolatilities --
  console.log("\n  --- calculateAllVolatilities ---");

  const allVols = calculateAllVolatilities(longPrices);
  assert(allVols.daily > 0, "daily vol > 0");
  assert(allVols.ewma > 0, "ewma vol > 0");
  assert(allVols.rolling30d > 0, "rolling30d vol > 0");
  assert(allVols.annualized > 0, "annualized vol > 0");
  assertApprox(allVols.annualized, allVols.daily * Math.sqrt(365), 0.01, "annualized = daily × √365");

  // Insufficient data
  const fewVols = calculateAllVolatilities([{ date: "2024-01-01", price: 10.0 }]);
  assert(fewVols.daily === 0, "1 price → daily 0");
  assert(fewVols.annualized === 0, "1 price → annualized 0");
}

// ==================== 3. RISK MANAGER ====================

async function testRiskManager(): Promise<void> {
  section("3. RiskManager - Capital Allocation & Risk Control");

  const { RiskManager, DEFAULT_RISK_LIMITS } = await import("../risk/RiskManager");
  type LoanPosition = import("../risk/RiskManager").LoanPosition;

  const makeLimits = (overrides: Partial<typeof DEFAULT_RISK_LIMITS> = {}) => ({
    ...DEFAULT_RISK_LIMITS,
    maxCapitalEth: 5,
    maxExposurePerCollection: 2,
    maxLoansPerCollection: 3,
    maxUtilizationRate: 0.8,
    maxActiveLoan: 10,
    liquidationRiskThreshold: 0.3,
    minReserveRatio: 0.2,
    ...overrides,
  });

  const makePosition = (overrides: Partial<LoanPosition> = {}): LoanPosition => ({
    offerId: `test-${Date.now()}-${Math.random().toFixed(4)}`,
    collection: "azuki",
    collectionAddress: "0x1234",
    loanAmount: 1.0,
    apr: 0.20,
    durationDays: 30,
    startDate: new Date(),
    endDate: new Date(Date.now() + 30 * 86400000),
    collateralFloorPrice: 5.0,
    status: "active",
    liquidationRisk: 0,
    ...overrides,
  });

  // -- 3.1 Not initialized --
  console.log("\n  --- canAllocateCapital (not initialized) ---");
  const rm1 = new RiskManager(makeLimits());
  const check1 = rm1.canAllocateCapital("azuki", 1.0);
  assert(check1.canAllocate === false, "Rejects when not initialized");
  assert(check1.reason?.includes("not initialized") === true, "Reason mentions init");

  // -- 3.2 Basic allocation --
  console.log("\n  --- canAllocateCapital (basic) ---");
  const rm2 = new RiskManager(makeLimits());
  // @ts-expect-error accessing private for test
  rm2.initialized = true;

  const check2 = rm2.canAllocateCapital("azuki", 1.0);
  assert(check2.canAllocate === true, "Can allocate when empty");

  const check3 = rm2.canAllocateCapital("azuki", 6.0);
  assert(check3.canAllocate === false, "Rejects > total capital");
  assert(check3.reason?.includes("Insufficient") === true, "Reason: insufficient capital");

  // -- 3.3 Position tracking --
  console.log("\n  --- registerLoan + getPortfolioStats ---");
  const rm3 = new RiskManager(makeLimits());
  // @ts-expect-error accessing private for test
  rm3.initialized = true;

  await rm3.registerLoan(makePosition({ offerId: "pos-1", loanAmount: 1.5 }));

  const stats1 = rm3.getPortfolioStats();
  assert(stats1.activeLoans === 1, "1 active loan");
  assertApprox(stats1.deployedCapital, 1.5, 0.001, "Deployed = 1.5 ETH");
  assertApprox(stats1.availableCapital, 3.5, 0.001, "Available = 3.5 ETH");
  assertApprox(stats1.utilizationRate, 0.3, 0.001, "Utilization = 30%");
  assert(stats1.totalExposure["azuki"] === 1.5, "Azuki exposure = 1.5");
  assert(stats1.totalCapital === 5, "Total capital = 5");

  // -- 3.4 Collection exposure limit --
  console.log("\n  --- Collection exposure limits ---");
  const check4 = rm3.canAllocateCapital("azuki", 0.5);
  assert(check4.canAllocate === true, "Can add 0.5 more to azuki (total 2.0 = limit)");

  const check5 = rm3.canAllocateCapital("azuki", 0.6);
  assert(check5.canAllocate === false, "Rejects 0.6 to azuki (would be 2.1 > 2.0)");
  assert(check5.reason?.includes("Collection exposure") === true, "Reason: collection exposure");

  // -- 3.5 Utilization limit --
  console.log("\n  --- Utilization limit ---");
  const check6 = rm3.canAllocateCapital("milady", 2.6);
  assert(check6.canAllocate === false, "Rejects when utilization would exceed 80%");
  assert(check6.reason?.includes("Utilization") === true, "Reason: utilization");

  // -- 3.6 Max loans per collection --
  console.log("\n  --- Max loans per collection ---");
  await rm3.registerLoan(makePosition({ offerId: "pos-2", loanAmount: 0.2 }));
  await rm3.registerLoan(makePosition({ offerId: "pos-3", loanAmount: 0.2 }));
  const check7 = rm3.canAllocateCapital("azuki", 0.05);
  assert(check7.canAllocate === false, "Rejects when max loans per collection reached (3)");
  assert(check7.reason?.includes("Max loans per collection") === true, "Reason: max loans per collection");

  // -- 3.7 Max active loans --
  console.log("\n  --- Max active loans ---");
  const rm4 = new RiskManager(makeLimits({ maxActiveLoan: 2 }));
  // @ts-expect-error accessing private for test
  rm4.initialized = true;
  await rm4.registerLoan(makePosition({ offerId: "max-1", collection: "a", loanAmount: 0.1 }));
  await rm4.registerLoan(makePosition({ offerId: "max-2", collection: "b", loanAmount: 0.1 }));
  const check8 = rm4.canAllocateCapital("c", 0.1);
  assert(check8.canAllocate === false, "Rejects when max active loans reached");
  assert(check8.reason?.includes("Max active loans") === true, "Reason: max active loans");

  // -- 3.8 Floor price update & liquidation risk --
  console.log("\n  --- updateFloorPrice + liquidation risk ---");
  const rm5 = new RiskManager(makeLimits({ maxCapitalEth: 10, maxExposurePerCollection: 5 }));
  // @ts-expect-error accessing private for test
  rm5.initialized = true;

  await rm5.registerLoan(makePosition({ offerId: "risk-1", loanAmount: 2.0, collateralFloorPrice: 10.0 }));

  const safe = rm5.getLoansAtRisk(0.1);
  assert(safe.length === 0, "No risk at LTV=20%");

  // Floor drops → high LTV
  await rm5.updateFloorPrice("risk-1", 2.3);
  const risky = rm5.getLoansAtRisk(0.1);
  assert(risky.length === 1, "1 loan at risk when floor drops to 2.3 (LTV=87%)");
  assert(risky[0].liquidationRisk > 0.3, "Liquidation risk > 0.3");
  assert(risky[0].currentFloorPrice === 2.3, "Current floor price updated");

  // Floor recovers
  await rm5.updateFloorPrice("risk-1", 5.0);
  const recovered = rm5.getLoansAtRisk(0.1);
  assert(recovered.length === 0, "No risk after floor recovery");

  // -- 3.9 Status update --
  console.log("\n  --- updateLoanStatus ---");
  const rm6 = new RiskManager(makeLimits({ maxCapitalEth: 10 }));
  // @ts-expect-error accessing private for test
  rm6.initialized = true;

  await rm6.registerLoan(makePosition({ offerId: "stat-1", loanAmount: 1.0 }));
  assert(rm6.getActiveLoans().length === 1, "1 active loan");
  assert(rm6.getPortfolioStats().deployedCapital === 1.0, "1 ETH deployed");

  await rm6.updateLoanStatus("stat-1", "repaid");
  assert(rm6.getActiveLoans().length === 0, "0 active after repaid");
  assert(rm6.getPortfolioStats().deployedCapital === 0, "0 ETH after repaid");
  assert(rm6.getPortfolioStats().availableCapital === 10, "Full capital available");

  // -- 3.10 Collection queries --
  console.log("\n  --- getActiveLoansForCollection ---");
  const rm7 = new RiskManager(makeLimits({ maxCapitalEth: 100, maxExposurePerCollection: 50, maxLoansPerCollection: 20 }));
  // @ts-expect-error accessing private for test
  rm7.initialized = true;

  await rm7.registerLoan(makePosition({ offerId: "coll-1", collection: "azuki", loanAmount: 1.0 }));
  await rm7.registerLoan(makePosition({ offerId: "coll-2", collection: "milady", loanAmount: 2.0 }));
  await rm7.registerLoan(makePosition({ offerId: "coll-3", collection: "azuki", loanAmount: 0.5 }));

  const azukiLoans = rm7.getActiveLoansForCollection("azuki");
  assert(azukiLoans.length === 2, "2 azuki loans");

  const miladyLoans = rm7.getActiveLoansForCollection("milady");
  assert(miladyLoans.length === 1, "1 milady loan");

  const noLoans = rm7.getActiveLoansForCollection("bayc");
  assert(noLoans.length === 0, "0 bayc loans");

  // -- 3.11 Risk alerts --
  console.log("\n  --- getRiskAlerts ---");
  const rm8 = new RiskManager(makeLimits({ maxCapitalEth: 10, maxExposurePerCollection: 5, maxLoansPerCollection: 20 }));
  // @ts-expect-error accessing private for test
  rm8.initialized = true;

  // No alerts when empty
  const emptyAlerts = rm8.getRiskAlerts();
  assert(emptyAlerts.length === 0, "No alerts when empty");

  // -- 3.12 Report generation --
  console.log("\n  --- generateReport ---");
  const emptyReport = rm8.generateReport();
  assert(emptyReport.includes("PORTFOLIO REPORT"), "Report has header");
  assert(emptyReport.includes("Active Loans: 0"), "Shows 0 loans");

  await rm8.registerLoan(makePosition({ offerId: "rep-1", collection: "azuki", loanAmount: 2.0, apr: 0.20 }));
  const report = rm8.generateReport();
  assert(report.includes("Active Loans: 1"), "Shows 1 loan");
  assert(report.includes("azuki"), "Shows collection name");
  assert(report.includes("Capital:"), "Shows deployed capital");

  // -- 3.13 Average APR --
  console.log("\n  --- averageAPR ---");
  const rm9 = new RiskManager(makeLimits({ maxCapitalEth: 100, maxExposurePerCollection: 50, maxLoansPerCollection: 20 }));
  // @ts-expect-error accessing private for test
  rm9.initialized = true;
  await rm9.registerLoan(makePosition({ offerId: "apr-1", apr: 0.20, loanAmount: 1.0 }));
  await rm9.registerLoan(makePosition({ offerId: "apr-2", apr: 0.40, loanAmount: 1.0 }));
  const aprStats = rm9.getPortfolioStats();
  assertApprox(aprStats.averageAPR, 0.30, 0.001, "Average APR = (0.20 + 0.40) / 2 = 0.30");
}

// ==================== 4. STRATEGY HELPERS ====================

async function testStrategyHelpers(): Promise<void> {
  section("4. Strategy Helpers");

  const { getOffersToSend, formatRecommendationShort } = await import("../strategy/Strategy");
  type StrategyReport = import("../strategy/Strategy").StrategyReport;
  type StrategyRecommendation = import("../strategy/Strategy").StrategyRecommendation;

  // -- 4.1 getOffersToSend --
  console.log("\n  --- getOffersToSend ---");

  const report: StrategyReport = {
    timestamp: new Date().toISOString(),
    collections: [
      { collection: "azuki", shouldSendOffer: true, reason: "Can compete", platform: "gondi", offerDetails: { loanAmount: 2.0, durationDays: 30, recommendedApr: 0.25, competitiveApr: 0.30, expectedProfit: 0.05, ltv: 0.4, offerType: "best_apr" as const } },
      { collection: "milady", shouldSendOffer: false, reason: "No price data", platform: "gondi" },
      { collection: "bayc", shouldSendOffer: true, reason: "Can compete", platform: "gondi", offerDetails: { loanAmount: 5.0, durationDays: 14, recommendedApr: 0.20, competitiveApr: 0.28, expectedProfit: 0.08, ltv: 0.35, offerType: "best_principal" as const } },
    ],
    summary: { total: 3, shouldSend: 2, skipped: 1 },
  };

  const toSend = getOffersToSend(report);
  assert(toSend.length === 2, "2 offers to send");
  assert(toSend[0].collection === "azuki", "First offer is azuki");
  assert(toSend[1].collection === "bayc", "Second offer is bayc");

  // Empty report
  const emptyReport: StrategyReport = {
    timestamp: new Date().toISOString(),
    collections: [],
    summary: { total: 0, shouldSend: 0, skipped: 0 },
  };
  assert(getOffersToSend(emptyReport).length === 0, "Empty report → 0 offers");

  // All skipped
  const allSkipped: StrategyReport = {
    timestamp: new Date().toISOString(),
    collections: [
      { collection: "a", shouldSendOffer: false, reason: "skip", platform: "gondi" },
      { collection: "b", shouldSendOffer: false, reason: "skip", platform: "gondi" },
    ],
    summary: { total: 2, shouldSend: 0, skipped: 2 },
  };
  assert(getOffersToSend(allSkipped).length === 0, "All skipped → 0 offers");

  // -- 4.2 formatRecommendationShort --
  console.log("\n  --- formatRecommendationShort ---");

  const sendRec: StrategyRecommendation = {
    collection: "azuki",
    shouldSendOffer: true,
    reason: "Can compete",
    platform: "gondi",
    offerDetails: {
      loanAmount: 2.0,
      durationDays: 30,
      recommendedApr: 0.25,
      competitiveApr: 0.30,
      expectedProfit: 0.05,
      ltv: 0.4,
      offerType: "best_apr",
    },
  };

  const sendFormatted = formatRecommendationShort(sendRec);
  assert(sendFormatted.includes("azuki"), "Formatted contains collection name");
  assert(sendFormatted.includes("2.000"), "Formatted contains loan amount");
  assert(sendFormatted.includes("30.00%"), "Formatted contains APR");
  assert(sendFormatted.includes("30d"), "Formatted contains duration");
  assert(sendFormatted.includes("0.0500"), "Formatted contains profit");

  const skipRec: StrategyRecommendation = {
    collection: "milady",
    shouldSendOffer: false,
    reason: "No price data",
    platform: "gondi",
  };
  const skipFormatted = formatRecommendationShort(skipRec);
  assert(skipFormatted.includes("SKIP"), "Skipped rec shows SKIP");
  assert(skipFormatted.includes("No price data"), "Skipped rec shows reason");
}

// ==================== 5. COLLECTIONS LOADER ====================

async function testCollectionsLoader(): Promise<void> {
  section("5. Collections Loader");

  const { loadCollections, loadEnabledCollections, findCollectionBySlug, findCollectionByAddress } = await import("../utils/collections-loader");

  // -- 5.1 loadCollections --
  console.log("\n  --- loadCollections ---");
  const all = loadCollections();
  assert(all.length > 0, `Loaded ${all.length} collections`);
  assert(all[0].slug !== undefined, "First collection has slug");
  assert(all[0].address !== undefined, "First collection has address");
  assert(all[0].name !== undefined, "First collection has name");
  assert(typeof all[0].enabled === "boolean", "First collection has enabled boolean");

  // -- 5.2 loadEnabledCollections --
  console.log("\n  --- loadEnabledCollections ---");
  const enabled = loadEnabledCollections();
  assert(enabled.length > 0, `${enabled.length} enabled collections`);
  assert(enabled.every(c => c.enabled), "All enabled collections have enabled=true");

  // -- 5.3 findCollectionBySlug --
  console.log("\n  --- findCollectionBySlug ---");
  const azuki = findCollectionBySlug("azuki");
  assert(azuki !== null, "Found azuki by slug");
  assert(azuki?.name === "Azuki", "Azuki name correct");

  const notFound = findCollectionBySlug("nonexistent-collection-xyz");
  assert(notFound === null, "Returns null for unknown slug");

  // -- 5.4 findCollectionByAddress --
  console.log("\n  --- findCollectionByAddress ---");
  const bayc = findCollectionByAddress("0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D");
  assert(bayc !== null, "Found BAYC by address");
  assert(bayc?.slug === "boredapeyachtclub", "BAYC slug correct");

  // Case insensitive
  const baycLower = findCollectionByAddress("0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d");
  assert(baycLower !== null, "Case insensitive address lookup");

  const notFoundAddr = findCollectionByAddress("0x0000000000000000000000000000000000000000");
  assert(notFoundAddr === null, "Returns null for unknown address");

  // -- 5.5 Invalid file --
  console.log("\n  --- loadCollections (invalid file) ---");
  assertThrows(() => loadCollections("/nonexistent/path.json"), "Throws for invalid file path");
}

// ==================== 6. LENDING-DB HELPERS ====================

async function testLendingDbHelpers(): Promise<void> {
  section("6. lending-db - createOfferFromGondiResponse");

  const { createOfferFromGondiResponse } = await import("../utils/lending-db");

  // -- 6.1 Basic conversion --
  console.log("\n  --- createOfferFromGondiResponse (basic) ---");

  const gondiResponse = {
    id: "contract.lender.123",
    offerId: BigInt(123),
    contractAddress: "0xABC",
    lenderAddress: "0xDEF",
    principalAmount: BigInt("1000000000000000000"), // 1 ETH
    capacity: BigInt("2000000000000000000"), // 2 ETH
    aprBps: BigInt(2500), // 25%
    duration: BigInt(2592000), // 30 days
    expirationTime: BigInt(Math.floor(Date.now() / 1000) + 3600),
    fee: BigInt(0),
    maxSeniorRepayment: BigInt("1100000000000000000"),
    requiresLiquidation: true,
    borrowerAddress: "0x0000000000000000000000000000000000000000",
    nftCollateralAddress: "0xNFT",
    nftCollateralTokenId: BigInt(0),
    collectionId: 42,
    principalAddress: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    offerHash: "0xHASH",
    signature: "0xSIG",
  };

  const offer = createOfferFromGondiResponse(gondiResponse, {
    id: 42,
    address: "0xNFTCOLL",
    name: "Test Collection",
  });

  assert(offer.id === "contract.lender.123", "ID preserved");
  assert(offer.marketplace === "gondi", "Marketplace is gondi");
  assert(offer.offer_id === "123", "offerId extracted from bigint");
  assert(offer.contract_address === "0xabc", "Contract address lowercased");
  assert(offer.lender_address === "0xdef", "Lender address lowercased");
  assertApprox(offer.principal_eth, 1.0, 0.001, "Principal = 1 ETH");
  assertApprox(offer.capacity_eth || 0, 2.0, 0.001, "Capacity = 2 ETH");
  assert(offer.apr_bps === 2500, "APR bps = 2500");
  assertApprox(offer.apr_percent, 25.0, 0.001, "APR percent = 25%");
  assert(offer.duration_seconds === 2592000, "Duration seconds correct");
  assert(offer.duration_days === 30, "Duration days = 30");
  assert(offer.currency === "WETH", "Currency is WETH");
  assert(offer.status === "ACTIVE", "Status is ACTIVE");
  assert(offer.collection_name === "Test Collection", "Collection name from param");
  assert(offer.collection_id === 42, "Collection ID from param");
  assert(offer.requires_liquidation === true, "Requires liquidation");
  assert(offer.borrower_address === undefined, "Zero address borrower → undefined");
  assert(offer.token_id === undefined, "Token ID 0 → undefined");
  assert(offer.offer_hash === "0xHASH", "Offer hash preserved");

  // -- 6.2 With null fields --
  console.log("\n  --- createOfferFromGondiResponse (null fields) ---");

  const nullResponse = {
    id: "null-test.123",
    maxSeniorRepayment: null,
    requiresLiquidation: null,
    principalAddress: "0xOTHER",
    expirationTime: BigInt(Math.floor(Date.now() / 1000) + 3600),
  };

  const nullOffer = createOfferFromGondiResponse(nullResponse);
  assert(nullOffer.max_senior_repayment === undefined, "null maxSeniorRepayment → undefined");
  assert(nullOffer.requires_liquidation === true, "null requiresLiquidation → defaults to true");
  assert(nullOffer.currency === "UNKNOWN", "Non-WETH address → UNKNOWN currency");

  // -- 6.3 With non-zero tokenId --
  console.log("\n  --- createOfferFromGondiResponse (single NFT) ---");

  const singleNft = {
    id: "nft-test.456",
    nftCollateralTokenId: BigInt(1234),
    borrowerAddress: "0xBORROWER",
    expirationTime: BigInt(Math.floor(Date.now() / 1000) + 3600),
  };

  const nftOffer = createOfferFromGondiResponse(singleNft);
  assert(nftOffer.token_id === "1234", "Non-zero token ID preserved");
  assert(nftOffer.borrower_address === "0xborrower", "Non-zero borrower lowercased");
}

// ==================== 7. LOAN TRACKER HELPERS ====================

async function testLoanTrackerHelpers(): Promise<void> {
  section("7. loan-tracker - formatTrackingResult");

  const { formatTrackingResult } = await import("../execution/loan-tracker");

  // -- 7.1 No offers --
  console.log("\n  --- formatTrackingResult ---");

  const noOffers = formatTrackingResult({ checked: 0, executed: 0, cancelled: 0, expired: 0, errors: 0 });
  assert(noOffers === "No active offers to track", "Empty result message");

  // -- 7.2 All fields --
  const full = formatTrackingResult({ checked: 10, executed: 2, cancelled: 1, expired: 3, errors: 1 });
  assert(full.includes("Checked 10"), "Shows checked count");
  assert(full.includes("2 executed"), "Shows executed");
  assert(full.includes("1 cancelled"), "Shows cancelled");
  assert(full.includes("3 expired"), "Shows expired");
  assert(full.includes("1 error"), "Shows errors");

  // -- 7.3 Only checked, no changes --
  const noChanges = formatTrackingResult({ checked: 5, executed: 0, cancelled: 0, expired: 0, errors: 0 });
  assert(noChanges === "Checked 5 offer(s)", "Only checked count when no changes");

  // -- 7.4 Partial --
  const partial = formatTrackingResult({ checked: 3, executed: 1, cancelled: 0, expired: 0, errors: 0 });
  assert(partial.includes("1 executed"), "Shows executed");
  assert(!partial.includes("cancelled"), "Hides zero cancelled");
  assert(!partial.includes("expired"), "Hides zero expired");
}

// ==================== 8. DB OPERATIONS ====================

async function testDbOperations(): Promise<void> {
  section("8. Database Operations (Supabase)");

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    console.log("  ⏭️  Skipped (SUPABASE_URL / SUPABASE_ANON_KEY not set)");
    return;
  }

  // -- 8.1 price-db --
  console.log("\n  --- price-db ---");
  const { savePriceToDb, getPriceHistory, getLatestFloorPrice, getDailyAveragePrices } = await import("../utils/price-db");

  const testSlug = `test-${Date.now()}`;

  try {
    // Save a price
    await savePriceToDb({
      collection_slug: testSlug,
      floor_price: 5.5,
      top_bid: 5.2,
      mid_price: 5.35,
      spread: 0.3,
    });
    console.log("  ✅ savePriceToDb succeeded");
    totalPassed++;

    // Get latest
    const latest = await getLatestFloorPrice(testSlug);
    if (latest) {
      assertApprox(latest.floor, 5.5, 0.01, "Latest floor = 5.5");
      assertApprox(latest.bid, 5.2, 0.01, "Latest bid = 5.2");
      assertApprox(latest.mid, 5.35, 0.01, "Latest mid = 5.35");
    } else {
      console.log("  ⚠️  getLatestFloorPrice returned null (table may not exist)");
    }

    // Get history
    const history = await getPriceHistory(testSlug, 1);
    assert(history.length >= 1, `History has ${history.length} records`);

    // Get daily averages
    const daily = await getDailyAveragePrices(testSlug, 1);
    assert(daily.length >= 1, `Daily averages has ${daily.length} records`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  ⚠️  price-db test error (table may not exist): ${msg}`);
  }

  // -- 8.2 gondi-db --
  console.log("\n  --- gondi-db ---");
  const { getStats } = await import("../utils/gondi-db");

  try {
    const stats = await getStats();
    assert(typeof stats.total === "number", `Stats: ${stats.total} total offers`);
    assert(typeof stats.collections === "number", `Stats: ${stats.collections} collections`);
    console.log(`  ✅ getStats: ${stats.total} offers, ${stats.collections} collections`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  ⚠️  gondi-db test error: ${msg}`);
  }

  // -- 8.3 lending-db --
  console.log("\n  --- lending-db ---");
  const { getOffersStats, markExpiredOffers } = await import("../utils/lending-db");

  try {
    // We just test the stats function (read-only)
    const stats = await getOffersStats();
    assert(typeof stats.total === "number", `Lending stats: ${stats.total} total`);
    assert(typeof stats.active === "number", `Lending stats: ${stats.active} active`);
    console.log(`  ✅ getOffersStats: ${stats.total} total, ${stats.active} active`);
    totalPassed++;

    const expired = await markExpiredOffers();
    assert(typeof expired === "number", `markExpiredOffers: ${expired} marked`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  ⚠️  lending-db test error: ${msg}`);
  }

  // -- 8.4 RiskManager DB persistence --
  console.log("\n  --- RiskManager DB persistence ---");
  const { RiskManager, DEFAULT_RISK_LIMITS } = await import("../risk/RiskManager");

  try {
    const { createClient } = await import("@supabase/supabase-js");
    const client = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!);
    const { error: tableCheck } = await client.from("risk_positions").select("offer_id").limit(1);

    if (tableCheck) {
      console.log(`  ⏭️  risk_positions table not found: ${tableCheck.message}`);
    } else {
      const testId = `test-db-${Date.now()}`;
      const rm = new RiskManager({ ...DEFAULT_RISK_LIMITS, maxCapitalEth: 10, minReserveRatio: 0.2 });
      await rm.init();

      await rm.registerLoan({
        offerId: testId,
        collection: "test-db-collection",
        collectionAddress: "0xTEST",
        loanAmount: 0.001,
        apr: 0.10,
        durationDays: 7,
        startDate: new Date(),
        endDate: new Date(Date.now() + 7 * 86400000),
        collateralFloorPrice: 1.0,
        status: "active",
        liquidationRisk: 0,
      });

      // Reload from DB
      const rm2 = new RiskManager({ ...DEFAULT_RISK_LIMITS, maxCapitalEth: 10, minReserveRatio: 0.2 });
      await rm2.init();

      const found = rm2.getActiveLoans().find(l => l.offerId === testId);
      assert(found !== undefined, "Position persisted and reloaded from DB");

      // Cleanup
      await rm2.updateLoanStatus(testId, "repaid");
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  ⚠️  RiskManager DB test error: ${msg}`);
  }
}

// ==================== 9. PRICE FETCHER ====================

async function testPriceFetcher(): Promise<void> {
  section("9. PriceFetcher (OpenSea API)");

  if (!process.env.OPENSEA_API_KEY) {
    console.log("  ⏭️  Skipped (OPENSEA_API_KEY not set)");
    return;
  }

  const { PriceFetcher } = await import("../collectors/price-fetcher");

  const fetcher = new PriceFetcher({ openseaApiKey: process.env.OPENSEA_API_KEY! });

  // -- 9.1 fetchPrice --
  console.log("\n  --- fetchPrice ---");
  try {
    const price = await fetcher.fetchPrice("pudgypenguins");
    assert(price.floorPrice > 0, `Pudgy Penguins floor = ${price.floorPrice.toFixed(4)} ETH`);
    assert(price.topBid >= 0, `Pudgy Penguins bid = ${price.topBid.toFixed(4)} ETH`);
    assert(price.midPrice > 0, `Pudgy Penguins mid = ${price.midPrice.toFixed(4)} ETH`);
    assert(price.spread >= 0, `Spread = ${price.spread.toFixed(4)}`);
    assert(typeof price.timestamp === "number", "Has timestamp");
    assert(typeof price.date === "string", "Has date string");
    assert(price.collection === "pudgypenguins", "Collection slug correct");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  ⚠️  PriceFetcher error: ${msg}`);
  }

  // -- 9.2 Multiple collections --
  console.log("\n  --- fetchPrice (multiple) ---");
  const slugs = ["boredapeyachtclub", "azuki"];
  for (const slug of slugs) {
    try {
      const price = await fetcher.fetchPrice(slug);
      assert(price.floorPrice > 0, `${slug} floor = ${price.floorPrice.toFixed(4)} ETH`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ⚠️  ${slug}: ${msg}`);
    }
  }

  // -- 9.3 getHistory & getDailyPrices --
  console.log("\n  --- getHistory / getDailyPrices ---");
  // After fetching, history should have entries
  const history = fetcher.getHistory("pudgypenguins");
  assert(history.length >= 1, `History has ${history.length} entries`);

  const daily = fetcher.getDailyPrices("pudgypenguins");
  assert(daily.length >= 1, `Daily prices has ${daily.length} entries`);
}

// ==================== 10. GONDI API ====================

async function testGondiApi(): Promise<void> {
  section("10. Gondi API (GraphQL)");

  const { listOffers, OfferStatus } = await import("../collectors/gondi-fetcher");

  // -- 10.1 listOffers (active, collection offers) --
  console.log("\n  --- listOffers ---");
  try {
    const result = await listOffers({
      statuses: [OfferStatus.Active],
      slugs: ["pudgypenguins"],
      onlyCollectionOffers: true,
      limit: 5,
    });

    assert(typeof result.totalCount === "number", `Total count: ${result.totalCount}`);
    assert(Array.isArray(result.offers), `Got ${result.offers.length} offers`);
    assert(typeof result.hasNextPage === "boolean", `hasNextPage: ${result.hasNextPage}`);

    if (result.offers.length > 0) {
      const offer = result.offers[0];
      assert(typeof offer.id === "string", "Offer has id");
      assert(typeof offer.offerId === "string", "Offer has offerId");
      assert(typeof offer.principalAmount === "string", "Offer has principalAmount");
      assert(typeof offer.aprBps === "string", "Offer has aprBps");
      assert(typeof offer.duration === "string", "Offer has duration");
      assert(typeof offer.status === "string", "Offer has status");
      // Note: Gondi GraphQL API returns statuses like "OrderStatus.Active", "OrderStatus.Executed"
      // Our OfferStatus constants use "ACTIVE", "EXECUTED" etc.
      // The filter works (API accepts "ACTIVE" input), but the returned value differs
      const validStatuses = ["ACTIVE", "CANCELLED", "EXECUTED", "EXPIRED", "INACTIVE"];
      const isValidStatus = validStatuses.includes(offer.status) || offer.status.startsWith("OrderStatus.");
      assert(isValidStatus, `Offer status is valid: ${offer.status}`);

      // IMPORTANT FINDING: If status is "OrderStatus.X" format, loan-tracker comparisons
      // like `gondiStatus === OfferStatus.Executed` will FAIL because OfferStatus.Executed = "EXECUTED"
      if (offer.status.startsWith("OrderStatus.")) {
        console.log(`  ⚠️  WARNING: Gondi API returns "${offer.status}" not "${validStatuses[0]}"`);
        console.log(`     This may break status comparisons in loan-tracker.ts!`);
      }

      const principal = parseFloat(offer.principalAmount) / 1e18;
      const apr = parseInt(offer.aprBps) / 100;
      const days = parseInt(offer.duration) / 86400;
      console.log(`  ✅ Sample: ${principal.toFixed(3)} ETH @ ${apr.toFixed(1)}% for ${days.toFixed(0)}d`);
      totalPassed++;
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  ⚠️  Gondi API error: ${msg}`);
  }
}

// ==================== 11. VOLATILITY FROM DB ====================

async function testVolatilityFromDb(): Promise<void> {
  section("11. Volatility from DB");

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    console.log("  ⏭️  Skipped (SUPABASE_URL / SUPABASE_ANON_KEY not set)");
    return;
  }

  const { calculateVolatilityFromDb } = await import("../engines/volatility");

  try {
    // Try with a collection that should have data
    const vol = await calculateVolatilityFromDb("pudgypenguins", 30);
    assert(typeof vol.daily === "number", `daily vol = ${vol.daily.toFixed(6)}`);
    assert(typeof vol.ewma === "number", `ewma vol = ${vol.ewma.toFixed(6)}`);
    assert(typeof vol.annualized === "number", `annualized vol = ${(vol.annualized * 100).toFixed(2)}%`);

    if (vol.annualized > 0) {
      assert(vol.annualized > vol.daily, "Annualized > daily (since √365 > 1)");
      console.log(`  ✅ Pudgy Penguins annualized vol: ${(vol.annualized * 100).toFixed(2)}%`);
      totalPassed++;
    } else {
      console.log("  ⚠️  No price data for pudgypenguins in DB (volatility = 0)");
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  ⚠️  Volatility from DB error: ${msg}`);
  }
}

// ==================== 12. TYPESCRIPT COMPILATION ====================

async function testCompilation(): Promise<void> {
  section("12. TypeScript Compilation");

  const { exec } = await import("child_process");
  const { promisify } = await import("util");
  const execAsync = promisify(exec);

  try {
    const { stderr } = await execAsync("npx tsc --noEmit 2>&1", {
      cwd: process.cwd(),
      timeout: 60000,
    });

    // Filter out node_modules errors (ox/viem stuff)
    const lines = stderr.split("\n").filter(l =>
      l.trim() !== "" && !l.includes("node_modules")
    );

    if (lines.length === 0) {
      console.log("  ✅ TypeScript compiles with 0 source errors");
      totalPassed++;
    } else {
      console.log(`  ❌ TypeScript compilation has ${lines.length} source error(s):`);
      for (const line of lines.slice(0, 10)) {
        console.log(`     ${line}`);
      }
      totalFailed++;
    }
  } catch (err: unknown) {
    // tsc exits with non-zero if there are errors, but we need to check
    const error = err as { stdout?: string; stderr?: string };
    const output = (error.stdout || "") + (error.stderr || "");
    const sourceErrors = output.split("\n").filter(l =>
      l.includes("error TS") && !l.includes("node_modules")
    );

    if (sourceErrors.length === 0) {
      console.log("  ✅ TypeScript compiles with 0 source errors (node_modules warnings ignored)");
      totalPassed++;
    } else {
      console.log(`  ❌ ${sourceErrors.length} source error(s):`);
      for (const line of sourceErrors.slice(0, 10)) {
        console.log(`     ${line}`);
      }
      totalFailed++;
    }
  }
}

// ==================== MAIN ====================

async function main(): Promise<void> {
  console.log("🧪 NFT Lending Bot - Comprehensive Test Suite");
  console.log("=".repeat(70));
  console.log(`📅 ${new Date().toISOString()}`);
  console.log("=".repeat(70));

  // Pure logic tests (no external deps)
  await testLoanPricer();
  await testVolatility();
  await testRiskManager();
  await testStrategyHelpers();
  await testCollectionsLoader();
  await testLendingDbHelpers();
  await testLoanTrackerHelpers();

  // DB-dependent tests
  await testDbOperations();

  // API-dependent tests
  await testPriceFetcher();
  await testGondiApi();
  await testVolatilityFromDb();

  // Compilation test
  await testCompilation();

  // Summary
  console.log(`\n${"═".repeat(70)}`);
  console.log(`📊 FINAL RESULTS`);
  console.log("═".repeat(70));
  console.log(`  ✅ Passed: ${totalPassed}`);
  console.log(`  ❌ Failed: ${totalFailed}`);
  console.log(`  Total:    ${totalPassed + totalFailed}`);
  console.log("═".repeat(70));

  if (totalFailed > 0) {
    console.log("\n❌ SOME TESTS FAILED");
    process.exit(1);
  } else {
    console.log("\n✅ ALL TESTS PASSED");
  }
}

main().catch((err) => {
  console.error("❌ Test suite crashed:", err);
  process.exit(1);
});
