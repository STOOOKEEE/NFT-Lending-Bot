/**
 * test-loan-monitor.ts - Unit tests for the loan monitoring logic (checkNewLoans)
 *
 * Tests the core detection logic from bot-auto.ts using mocks only.
 * No env vars, no network, no imports from bot-auto.ts.
 *
 * Usage: npx ts-node src/test/test-loan-monitor.ts
 */

// ==================== TEST FRAMEWORK ====================

let totalPassed = 0;
let totalFailed = 0;
let currentSection = "";

function section(name: string): void {
  currentSection = name;
  console.log(`\n${"=".repeat(70)}`);
  console.log(`  ${name}`);
  console.log("=".repeat(70));
}

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  PASS: ${label}`);
    totalPassed++;
  } else {
    console.error(`  FAIL: ${label} [${currentSection}]`);
    totalFailed++;
  }
}

// ==================== TYPES (copied to avoid imports with side effects) ====================

interface DetectedLoan {
  loanId: string;
  platform: string;
  collection: string;
  collectionSlug: string;
  collectionAddress: string;
  amount: number;
  currency: string;
  aprBps: number;
  durationDays: number;
  borrower: string;
  startTime: Date;
  endTime: Date;
  tokenId: string;
}

interface MockPlatform {
  name: string;
  loans: DetectedLoan[];
}

// ==================== CORE LOGIC UNDER TEST (mirrors bot-auto.ts) ====================

interface LoanNotification {
  collection: string;
  tokenId: string;
  amount: number;
  currency: string;
  aprPercent: string;
  durationDays: number;
  borrowerShort: string;
  telegramMessage: string;
}

/**
 * Recreates the checkNewLoans logic from bot-auto.ts.
 * Returns notifications that would be sent (instead of actually calling Telegram).
 */
function checkNewLoans(
  platforms: MockPlatform[],
  knownLoanIds: Set<string>,
  loanCheckInitialized: boolean,
): { notifications: LoanNotification[]; newInitialized: boolean } {
  const notifications: LoanNotification[] = [];

  for (const platform of platforms) {
    for (const loan of platform.loans) {
      const key = `${platform.name}_${loan.loanId}`;
      if (knownLoanIds.has(key)) continue;

      knownLoanIds.add(key);

      // First call = initialization, no notifications
      if (!loanCheckInitialized) continue;

      const aprPercent = (loan.aprBps / 100).toFixed(2);
      const borrowerShort = `${loan.borrower.slice(0, 6)}...${loan.borrower.slice(-4)}`;

      const telegramMessage =
        `<b>LOAN ACCEPTED</b>\n` +
        `${loan.collection} #${loan.tokenId}\n` +
        `${loan.amount.toFixed(4)} ${loan.currency} @ ${aprPercent}%\n` +
        `${loan.durationDays}d | ${borrowerShort}`;

      notifications.push({
        collection: loan.collection,
        tokenId: loan.tokenId,
        amount: loan.amount,
        currency: loan.currency,
        aprPercent,
        durationDays: loan.durationDays,
        borrowerShort,
        telegramMessage,
      });
    }
  }

  const newInitialized = loanCheckInitialized || true;
  return { notifications, newInitialized };
}

// ==================== MOCK DATA ====================

function makeLoan(overrides: Partial<DetectedLoan> = {}): DetectedLoan {
  const now = new Date();
  const end = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  return {
    loanId: "loan_001",
    platform: "gondi",
    collection: "BAYC",
    collectionSlug: "boredapeyachtclub",
    collectionAddress: "0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D",
    amount: 5.5,
    currency: "WETH",
    aprBps: 3200,
    durationDays: 7,
    borrower: "0xAbCdEf1234567890AbCdEf1234567890AbCdEf12",
    startTime: now,
    endTime: end,
    tokenId: "4291",
    ...overrides,
  };
}

const loanA = makeLoan({ loanId: "loan_A", collection: "BAYC", tokenId: "4291", amount: 5.5, aprBps: 3200 });
const loanB = makeLoan({ loanId: "loan_B", collection: "Pudgy Penguins", tokenId: "777", amount: 2.0, aprBps: 4500, collectionSlug: "pudgypenguins" });
const loanC = makeLoan({ loanId: "loan_C", collection: "Azuki", tokenId: "1234", amount: 3.0, aprBps: 2800, collectionSlug: "azuki", borrower: "0x1111222233334444555566667777888899990000" });

// ==================== TESTS ====================

function runTests(): void {
  console.log("=".repeat(70));
  console.log("  LOAN MONITOR TESTS");
  console.log("=".repeat(70));

  // ---- TEST 1: First call initializes, no notifications ----
  section("1. First call (initialization) sends no notifications");
  {
    const knownIds = new Set<string>();
    const platform: MockPlatform = { name: "gondi", loans: [loanA, loanB] };

    const result = checkNewLoans([platform], knownIds, false);

    assert(result.notifications.length === 0, "No notifications on first call");
    assert(knownIds.size === 2, `Known IDs populated: ${knownIds.size} === 2`);
    assert(knownIds.has("gondi_loan_A"), "loan_A registered");
    assert(knownIds.has("gondi_loan_B"), "loan_B registered");
    assert(result.newInitialized === true, "loanCheckInitialized set to true after first call");
  }

  // ---- TEST 2: Second call with same loans, no notifications ----
  section("2. Second call with same loans (no new loans) sends no notifications");
  {
    const knownIds = new Set<string>(["gondi_loan_A", "gondi_loan_B"]);
    const platform: MockPlatform = { name: "gondi", loans: [loanA, loanB] };

    const result = checkNewLoans([platform], knownIds, true);

    assert(result.notifications.length === 0, "No notifications for already-known loans");
    assert(knownIds.size === 2, "Known IDs unchanged");
  }

  // ---- TEST 3: Third call with a new loan, exactly 1 notification ----
  section("3. New loan detected triggers exactly 1 notification");
  {
    const knownIds = new Set<string>(["gondi_loan_A", "gondi_loan_B"]);
    const platform: MockPlatform = { name: "gondi", loans: [loanA, loanB, loanC] };

    const result = checkNewLoans([platform], knownIds, true);

    assert(result.notifications.length === 1, `Exactly 1 notification: ${result.notifications.length} === 1`);
    assert(knownIds.size === 3, `Known IDs grew to 3: ${knownIds.size}`);
    assert(knownIds.has("gondi_loan_C"), "loan_C now registered");
    assert(result.notifications[0].collection === "Azuki", `Notification is for Azuki: ${result.notifications[0].collection}`);
  }

  // ---- TEST 4: Loan removed (repaid) triggers no notification ----
  section("4. Loan removed (repaid) triggers no notification");
  {
    const knownIds = new Set<string>(["gondi_loan_A", "gondi_loan_B", "gondi_loan_C"]);
    // Only loanA remains active (B and C repaid)
    const platform: MockPlatform = { name: "gondi", loans: [loanA] };

    const result = checkNewLoans([platform], knownIds, true);

    assert(result.notifications.length === 0, "No notification when loans disappear");
    assert(knownIds.size === 3, "Known IDs not removed (Set only grows)");
  }

  // ---- TEST 5: Duplicate detection across calls ----
  section("5. Duplicate detection: same loan ID never triggers twice");
  {
    const knownIds = new Set<string>();
    const platform: MockPlatform = { name: "gondi", loans: [loanA] };

    // Call 1: initialization
    const r1 = checkNewLoans([platform], knownIds, false);
    assert(r1.notifications.length === 0, "Call 1 (init): no notification");

    // Call 2: same loan, now initialized
    const r2 = checkNewLoans([platform], knownIds, true);
    assert(r2.notifications.length === 0, "Call 2: no notification (already known from init)");

    // Call 3: same loan again
    const r3 = checkNewLoans([platform], knownIds, true);
    assert(r3.notifications.length === 0, "Call 3: still no notification");

    assert(knownIds.size === 1, "Only 1 entry in knownIds despite 3 calls");
  }

  // ---- TEST 6: Multiple new loans in one call ----
  section("6. Multiple new loans in single call trigger multiple notifications");
  {
    const knownIds = new Set<string>();
    const platform: MockPlatform = { name: "gondi", loans: [loanA] };

    // Init with loanA
    checkNewLoans([platform], knownIds, false);

    // Now add B and C at once
    platform.loans = [loanA, loanB, loanC];
    const result = checkNewLoans([platform], knownIds, true);

    assert(result.notifications.length === 2, `2 notifications for 2 new loans: ${result.notifications.length}`);
    const collections = result.notifications.map(n => n.collection).sort();
    assert(collections[0] === "Azuki" && collections[1] === "Pudgy Penguins", `Correct collections: ${collections.join(", ")}`);
  }

  // ---- TEST 7: Multi-platform support ----
  section("7. Multi-platform: same loanId on different platforms treated as separate");
  {
    const knownIds = new Set<string>();
    const sameIdLoan = makeLoan({ loanId: "shared_001" });

    const gondi: MockPlatform = { name: "gondi", loans: [sameIdLoan] };
    const blur: MockPlatform = { name: "blur", loans: [sameIdLoan] };

    // Init with both platforms
    checkNewLoans([gondi, blur], knownIds, false);
    assert(knownIds.size === 2, `2 entries (one per platform): ${knownIds.size}`);
    assert(knownIds.has("gondi_shared_001"), "gondi key exists");
    assert(knownIds.has("blur_shared_001"), "blur key exists");
  }

  // ---- TEST 8: Telegram message format ----
  section("8. Telegram message format verification");
  {
    const knownIds = new Set<string>();
    const platform: MockPlatform = { name: "gondi", loans: [loanA] };

    // Init
    checkNewLoans([platform], knownIds, false);

    // Add loanC (Azuki, 3.0 WETH, 2800 bps = 28.00%, 7d, borrower 0x1111...0000)
    platform.loans = [loanA, loanC];
    const result = checkNewLoans([platform], knownIds, true);

    assert(result.notifications.length === 1, "Got 1 notification");
    const notif = result.notifications[0];

    // APR formatting: 2800 bps / 100 = 28.00%
    assert(notif.aprPercent === "28.00", `APR: ${notif.aprPercent} === 28.00`);

    // Borrower truncation: first 6 chars + ... + last 4 chars
    assert(notif.borrowerShort === "0x1111...0000", `Borrower: ${notif.borrowerShort} === 0x1111...0000`);

    // Amount with 4 decimals
    assert(notif.telegramMessage.includes("3.0000 WETH"), `Amount format: contains "3.0000 WETH"`);

    // Collection and token ID
    assert(notif.telegramMessage.includes("Azuki #1234"), `Contains "Azuki #1234"`);

    // Duration
    assert(notif.telegramMessage.includes("7d"), `Contains "7d"`);

    // HTML bold tag for title
    assert(notif.telegramMessage.includes("<b>LOAN ACCEPTED</b>"), `Contains HTML title`);

    // Full message check
    const expectedMessage =
      `<b>LOAN ACCEPTED</b>\n` +
      `Azuki #1234\n` +
      `3.0000 WETH @ 28.00%\n` +
      `7d | 0x1111...0000`;
    assert(notif.telegramMessage === expectedMessage, `Full message matches expected format`);
  }

  // ---- TEST 9: APR edge cases ----
  section("9. APR formatting edge cases");
  {
    const knownIds = new Set<string>();

    // 100 bps = 1.00%
    const lowApr = makeLoan({ loanId: "apr_low", aprBps: 100 });
    // 10000 bps = 100.00%
    const highApr = makeLoan({ loanId: "apr_high", aprBps: 10000 });
    // 1 bps = 0.01%
    const minApr = makeLoan({ loanId: "apr_min", aprBps: 1 });
    // 1550 bps = 15.50%
    const fractional = makeLoan({ loanId: "apr_frac", aprBps: 1550 });

    const platform: MockPlatform = { name: "gondi", loans: [lowApr, highApr, minApr, fractional] };

    // Init
    checkNewLoans([platform], knownIds, false);

    // Re-add as "new" by using a different platform name to trigger notifications
    const platform2: MockPlatform = { name: "blur", loans: [lowApr, highApr, minApr, fractional] };
    const result = checkNewLoans([platform2], knownIds, true);

    assert(result.notifications.length === 4, `4 APR notifications: ${result.notifications.length}`);

    const aprMap = new Map(result.notifications.map(n => [n.telegramMessage.match(/@ ([\d.]+)%/)?.[1], true]));
    assert(aprMap.has("1.00"), "100 bps -> 1.00%");
    assert(aprMap.has("100.00"), "10000 bps -> 100.00%");
    assert(aprMap.has("0.01"), "1 bps -> 0.01%");
    assert(aprMap.has("15.50"), "1550 bps -> 15.50%");
  }

  // ---- TEST 10: Borrower address truncation edge case ----
  section("10. Borrower address truncation");
  {
    const knownIds = new Set<string>();
    const loan = makeLoan({
      loanId: "trunc_test",
      borrower: "0xDeAdBeEf00000000000000000000000000CaFe01",
    });
    const platform: MockPlatform = { name: "gondi", loans: [loan] };

    checkNewLoans([platform], knownIds, false);

    // Use different platform to get notification
    const platform2: MockPlatform = { name: "blur", loans: [loan] };
    const result = checkNewLoans([platform2], knownIds, true);

    assert(result.notifications.length === 1, "Got notification");
    // "0xDeAd" (first 6) + "..." + "Fe01" (last 4)
    assert(result.notifications[0].borrowerShort === "0xDeAd...Fe01", `Truncation: ${result.notifications[0].borrowerShort} === 0xDeAd...Fe01`);
  }

  // ==================== SUMMARY ====================

  console.log(`\n${"=".repeat(70)}`);
  console.log(`  RESULTS: ${totalPassed} passed, ${totalFailed} failed, ${totalPassed + totalFailed} total`);
  console.log("=".repeat(70));

  if (totalFailed > 0) {
    console.error(`\n  ${totalFailed} test(s) FAILED`);
    process.exit(1);
  } else {
    console.log(`\n  All tests passed.`);
  }
}

runTests();
