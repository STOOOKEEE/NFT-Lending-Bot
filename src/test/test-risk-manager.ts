/**
 * Test RiskManager: logique d'allocation + persistence Supabase
 *
 * Usage: npx ts-node src/test/test-risk-manager.ts
 */

import "dotenv/config";
import { RiskManager, DEFAULT_RISK_LIMITS, LoanPosition } from "../risk/RiskManager";

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

// ==================== TEST 1: LOGIC SANS DB ====================

function testAllocationLogic(): void {
  console.log("\n📊 Test 1: Allocation logic (in-memory only)");

  const rm = new RiskManager({
    ...DEFAULT_RISK_LIMITS,
    maxCapitalEth: 5,
    maxExposurePerCollection: 2,
    maxLoansPerCollection: 3,
    maxUtilizationRate: 0.8,
    maxActiveLoan: 10,
    liquidationRiskThreshold: 0.3,
    minReserveRatio: 0.2,
  });

  // Force initialized flag (skip DB)
  // @ts-expect-error accessing private field for test
  rm.initialized = true;

  // Should allocate when empty
  const check1 = rm.canAllocateCapital("azuki", 1.0);
  assert(check1.canAllocate === true, "Can allocate 1 ETH when portfolio empty");

  // Should reject if amount > total capital
  const check2 = rm.canAllocateCapital("azuki", 6.0);
  assert(check2.canAllocate === false, "Rejects 6 ETH (> 5 ETH total capital)");
  assert(check2.reason?.includes("Insufficient") === true, "Reason mentions insufficient capital");

  // Should reject if not initialized
  const rm2 = new RiskManager(DEFAULT_RISK_LIMITS);
  const check3 = rm2.canAllocateCapital("azuki", 1.0);
  assert(check3.canAllocate === false, "Rejects when not initialized");
  assert(check3.reason?.includes("not initialized") === true, "Reason mentions not initialized");
}

// ==================== TEST 2: POSITION TRACKING ====================

async function testPositionTracking(): Promise<void> {
  console.log("\n📊 Test 2: Position tracking (in-memory)");

  const rm = new RiskManager({
    ...DEFAULT_RISK_LIMITS,
    maxCapitalEth: 5,
    maxExposurePerCollection: 2,
    maxLoansPerCollection: 3,
    maxUtilizationRate: 0.8,
    maxActiveLoan: 10,
    liquidationRiskThreshold: 0.3,
    minReserveRatio: 0.2,
  });

  // @ts-expect-error accessing private field for test
  rm.initialized = true;

  const position: LoanPosition = {
    offerId: "test-offer-1",
    collection: "azuki",
    collectionAddress: "0x1234",
    loanAmount: 1.5,
    apr: 0.25,
    durationDays: 30,
    startDate: new Date(),
    endDate: new Date(Date.now() + 30 * 86400000),
    collateralFloorPrice: 5.0,
    status: "active",
    liquidationRisk: 0,
  };

  // Register without DB (will fail silently on DB, that's ok)
  await rm.registerLoan(position);

  const stats = rm.getPortfolioStats();
  assert(stats.activeLoans === 1, "1 active loan after register");
  assert(stats.deployedCapital === 1.5, "Deployed capital = 1.5 ETH");
  assert(stats.availableCapital === 3.5, "Available capital = 3.5 ETH");
  assert(stats.utilizationRate === 0.3, "Utilization = 30%");

  // Exposure per collection
  assert(stats.totalExposure["azuki"] === 1.5, "Azuki exposure = 1.5 ETH");

  // Should still allow allocation within limits
  const check4 = rm.canAllocateCapital("azuki", 0.5);
  assert(check4.canAllocate === true, "Can allocate 0.5 ETH more to azuki (total 2.0)");

  // Should reject exceeding per-collection limit
  const check5 = rm.canAllocateCapital("azuki", 0.6);
  assert(check5.canAllocate === false, "Rejects 0.6 ETH to azuki (would be 2.1 > 2.0 limit)");

  // Should reject exceeding utilization (80% of 5 = 4 ETH, already 1.5 deployed)
  const check6 = rm.canAllocateCapital("milady", 2.6);
  assert(check6.canAllocate === false, "Rejects when utilization would exceed 80%");
}

// ==================== TEST 3: FLOOR PRICE UPDATE & RISK ====================

async function testFloorPriceRisk(): Promise<void> {
  console.log("\n📊 Test 3: Floor price update & liquidation risk");

  const rm = new RiskManager({
    ...DEFAULT_RISK_LIMITS,
    maxCapitalEth: 10,
    maxExposurePerCollection: 5,
    liquidationRiskThreshold: 0.3,
    minReserveRatio: 0.2,
  });

  // @ts-expect-error accessing private field for test
  rm.initialized = true;

  await rm.registerLoan({
    offerId: "risk-test-1",
    collection: "bayc",
    collectionAddress: "0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D",
    loanAmount: 2.0,
    apr: 0.20,
    durationDays: 30,
    startDate: new Date(),
    endDate: new Date(Date.now() + 30 * 86400000),
    collateralFloorPrice: 10.0,
    status: "active",
    liquidationRisk: 0,
  });

  // LTV = 2/10 = 20% -> safe
  const loans1 = rm.getLoansAtRisk(0.5);
  assert(loans1.length === 0, "No loans at risk when LTV=20%");

  // Floor drops to 2.3 ETH -> LTV = 2/2.3 = 87% -> risky
  await rm.updateFloorPrice("risk-test-1", 2.3);
  const loans2 = rm.getLoansAtRisk(0.1);
  assert(loans2.length === 1, "1 loan at risk when floor drops to 2.3 ETH (LTV=87%)");
  assert(loans2[0].liquidationRisk > 0.3, "Liquidation risk > 0.3");

  // Floor recovers to 5.0 ETH -> LTV = 2/5 = 40% -> safe
  await rm.updateFloorPrice("risk-test-1", 5.0);
  const loans3 = rm.getLoansAtRisk(0.1);
  assert(loans3.length === 0, "No loans at risk after floor recovery to 5 ETH");
}

// ==================== TEST 4: LOAN STATUS UPDATE ====================

async function testStatusUpdate(): Promise<void> {
  console.log("\n📊 Test 4: Loan status updates");

  const rm = new RiskManager({
    ...DEFAULT_RISK_LIMITS,
    maxCapitalEth: 10,
    minReserveRatio: 0.2,
  });

  // @ts-expect-error accessing private field for test
  rm.initialized = true;

  await rm.registerLoan({
    offerId: "status-test-1",
    collection: "doodles",
    collectionAddress: "0x1234",
    loanAmount: 1.0,
    apr: 0.15,
    durationDays: 14,
    startDate: new Date(),
    endDate: new Date(Date.now() + 14 * 86400000),
    collateralFloorPrice: 3.0,
    status: "active",
    liquidationRisk: 0,
  });

  assert(rm.getActiveLoans().length === 1, "1 active loan");
  assert(rm.getPortfolioStats().deployedCapital === 1.0, "1 ETH deployed");

  // Mark as repaid
  await rm.updateLoanStatus("status-test-1", "repaid");
  assert(rm.getActiveLoans().length === 0, "0 active loans after repaid");
  assert(rm.getPortfolioStats().deployedCapital === 0, "0 ETH deployed after repaid");
  assert(rm.getPortfolioStats().availableCapital === 10, "Full capital available after repaid");
}

// ==================== TEST 5: REPORT GENERATION ====================

async function testReport(): Promise<void> {
  console.log("\n📊 Test 5: Report generation");

  const rm = new RiskManager({
    ...DEFAULT_RISK_LIMITS,
    maxCapitalEth: 10,
    minReserveRatio: 0.2,
  });

  // @ts-expect-error accessing private field for test
  rm.initialized = true;

  // Empty portfolio report should not crash
  const emptyReport = rm.generateReport();
  assert(emptyReport.includes("PORTFOLIO REPORT"), "Empty report has header");
  assert(emptyReport.includes("Active Loans:       0"), "Empty report shows 0 loans");

  // With a position
  await rm.registerLoan({
    offerId: "report-test-1",
    collection: "azuki",
    collectionAddress: "0x1234",
    loanAmount: 2.0,
    apr: 0.20,
    durationDays: 30,
    startDate: new Date(),
    endDate: new Date(Date.now() + 30 * 86400000),
    collateralFloorPrice: 8.0,
    status: "active",
    liquidationRisk: 0,
  });

  const report = rm.generateReport();
  assert(report.includes("Active Loans:       1"), "Report shows 1 loan");
  assert(report.includes("azuki"), "Report mentions collection name");
}

// ==================== TEST 6: DB PERSISTENCE ====================

async function testDbPersistence(): Promise<void> {
  console.log("\n📊 Test 6: Supabase persistence (requires DB connection + risk_positions table)");

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    console.log("  ⏭️  Skipped (SUPABASE_URL / SUPABASE_ANON_KEY not set)");
    return;
  }

  // Check if table exists by trying to init
  const probe = new RiskManager({ ...DEFAULT_RISK_LIMITS, maxCapitalEth: 10, minReserveRatio: 0.2 });
  await probe.init();

  // If init logs a DB load error, the table doesn't exist yet - skip
  // We detect this by trying a registerLoan and checking if DB save works
  const { createClient } = await import("@supabase/supabase-js");
  const client = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!);
  const { error: tableCheck } = await client.from("risk_positions").select("offer_id").limit(1);
  if (tableCheck) {
    console.log(`  ⏭️  Skipped (table risk_positions not found: ${tableCheck.message})`);
    console.log("  💡 Create it with the SQL in RiskManager.ts header comment");
    return;
  }

  const testId = `test-persist-${Date.now()}`;

  // Create a RiskManager, register a loan, save to DB
  const rm1 = new RiskManager({
    ...DEFAULT_RISK_LIMITS,
    maxCapitalEth: 10,
    minReserveRatio: 0.2,
  });
  await rm1.init();

  await rm1.registerLoan({
    offerId: testId,
    collection: "test-collection",
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

  // Create a NEW RiskManager instance and load from DB
  const rm2 = new RiskManager({
    ...DEFAULT_RISK_LIMITS,
    maxCapitalEth: 10,
    minReserveRatio: 0.2,
  });
  await rm2.init();

  const activeLoans = rm2.getActiveLoans();
  const found = activeLoans.find(l => l.offerId === testId);
  assert(found !== undefined, `Position ${testId} found after reload from DB`);

  if (found) {
    assert(found.loanAmount === 0.001, "Loan amount preserved after reload");
    assert(found.collection === "test-collection", "Collection preserved after reload");
  }

  // Cleanup: mark as repaid so it doesn't pollute future tests
  await rm2.updateLoanStatus(testId, "repaid");

  // Verify cleanup
  const rm3 = new RiskManager({
    ...DEFAULT_RISK_LIMITS,
    maxCapitalEth: 10,
    minReserveRatio: 0.2,
  });
  await rm3.init();
  const cleanLoans = rm3.getActiveLoans();
  const shouldNotFind = cleanLoans.find(l => l.offerId === testId);
  assert(shouldNotFind === undefined, "Repaid position not loaded on next init");
}

// ==================== MAIN ====================

async function main() {
  console.log("🧪 RiskManager Tests");
  console.log("=".repeat(60));

  // In-memory tests (no DB needed)
  testAllocationLogic();
  await testPositionTracking();
  await testFloorPriceRisk();
  await testStatusUpdate();
  await testReport();

  // DB test (optional, needs Supabase)
  await testDbPersistence();

  console.log(`\n${"=".repeat(60)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("=".repeat(60));

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("❌ Test crashed:", err);
  process.exit(1);
});
