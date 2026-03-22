/**
 * test-detected-loan.ts - Unit test for DetectedLoan type and
 * GondiPlatform.fetchActiveLoans conversion logic.
 *
 * Pure unit test: no imports from GondiPlatform, no env vars needed.
 * We recreate the GondiLoan interface and conversion logic inline.
 */

import type { DetectedLoan } from "../adapters/LendingPlatform";

// ==================== GondiLoan interface (mirrored from GondiPlatform.ts) ====================

interface GondiLoan {
  id: string;
  loanId: number;
  contractAddress: `0x${string}`;
  borrowerAddress: `0x${string}`;
  principalAmount: bigint;
  duration: bigint;
  startTime: bigint;
  status: string;
  nftCollateralTokenId: bigint;
  nftCollateralAddress: `0x${string}` | undefined;
  borrower: `0x${string}`;
  source: {
    lender: `0x${string}`;
    loanId: bigint;
    startTime: bigint;
    originationFee: bigint;
    principalAmount: bigint;
    lenderAddress: string;
    accruedInterest: bigint;
    aprBps: bigint;
  }[];
  protocolFee: bigint;
  principalAddress: `0x${string}`;
  blendedAprBps: number;
  nft: {
    tokenId: bigint;
    collection?: {
      slug: string;
      name?: string | null;
    } | null;
  };
  currency: {
    symbol: string;
    decimals: number;
  };
}

// ==================== Conversion logic (exact copy from GondiPlatform.fetchActiveLoans) ====================

function convertGondiLoanToDetected(loan: GondiLoan): DetectedLoan {
  const decimals = loan.currency.decimals;
  const amount = Number(loan.principalAmount) / Math.pow(10, decimals);
  const startTs = Number(loan.startTime);
  const durationSec = Number(loan.duration);

  return {
    loanId: String(loan.loanId),
    platform: "gondi",
    collection: loan.nft?.collection?.name || "Unknown",
    collectionSlug: loan.nft?.collection?.slug || "",
    collectionAddress: loan.nftCollateralAddress || "",
    amount,
    currency: loan.currency.symbol,
    aprBps: loan.blendedAprBps,
    durationDays: Math.round(durationSec / 86400),
    borrower: loan.borrower,
    startTime: new Date(startTs * 1000),
    endTime: new Date((startTs + durationSec) * 1000),
    tokenId: String(loan.nft.tokenId),
  };
}

// ==================== Test helpers ====================

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.log(`  FAIL: ${label}`);
    failed++;
  }
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual === expected) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.log(`  FAIL: ${label} | expected=${String(expected)} actual=${String(actual)}`);
    failed++;
  }
}

// ==================== TEST 1: Standard loan conversion ====================

function testStandardLoan(): void {
  console.log("\n--- Test 1: Standard loan conversion ---");

  const startTimestamp = 1710000000; // 2024-03-09T16:00:00Z
  const durationSeconds = 7 * 86400; // 7 days

  const mockLoan: GondiLoan = {
    id: "loan-abc-123",
    loanId: 42,
    contractAddress: "0xf41B389E0C1950dc0B16C9498eaE77131CC08A56",
    borrowerAddress: "0x1234567890abcdef1234567890abcdef12345678",
    principalAmount: 500000000000000000n, // 0.5 ETH
    duration: BigInt(durationSeconds),
    startTime: BigInt(startTimestamp),
    status: "LoanInitiated",
    nftCollateralTokenId: 9999n,
    nftCollateralAddress: "0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D",
    borrower: "0x1234567890abcdef1234567890abcdef12345678",
    source: [
      {
        lender: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        loanId: 42n,
        startTime: BigInt(startTimestamp),
        originationFee: 0n,
        principalAmount: 500000000000000000n,
        lenderAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        accruedInterest: 1000000000000000n,
        aprBps: 3200n,
      },
    ],
    protocolFee: 250n,
    principalAddress: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    blendedAprBps: 3200,
    nft: {
      tokenId: 9999n,
      collection: {
        slug: "boredapeyachtclub",
        name: "Bored Ape Yacht Club",
      },
    },
    currency: {
      symbol: "WETH",
      decimals: 18,
    },
  };

  const result = convertGondiLoanToDetected(mockLoan);

  assertEqual(result.loanId, "42", "loanId is String(loan.loanId)");
  assertEqual(result.platform, "gondi", "platform is gondi");
  assertEqual(result.collection, "Bored Ape Yacht Club", "collection name");
  assertEqual(result.collectionSlug, "boredapeyachtclub", "collectionSlug");
  assertEqual(result.collectionAddress, "0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D", "collectionAddress");
  assertEqual(result.amount, 0.5, "amount is 0.5 ETH");
  assertEqual(result.currency, "WETH", "currency");
  assertEqual(result.aprBps, 3200, "aprBps from blendedAprBps");
  assertEqual(result.durationDays, 7, "durationDays = round(7d)");
  assertEqual(result.borrower, "0x1234567890abcdef1234567890abcdef12345678", "borrower address");
  assertEqual(result.startTime.toISOString(), new Date(startTimestamp * 1000).toISOString(), "startTime");
  assertEqual(result.endTime.toISOString(), new Date((startTimestamp + durationSeconds) * 1000).toISOString(), "endTime");
  assertEqual(result.tokenId, "9999", "tokenId is String(nft.tokenId)");
}

// ==================== TEST 2: Null collection name defaults to "Unknown" ====================

function testNullCollectionName(): void {
  console.log("\n--- Test 2: Null collection name defaults to Unknown ---");

  const mockLoan: GondiLoan = {
    id: "loan-null-name",
    loanId: 100,
    contractAddress: "0xf41B389E0C1950dc0B16C9498eaE77131CC08A56",
    borrowerAddress: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    principalAmount: 1000000000000000000n, // 1 ETH
    duration: 259200n, // 3 days
    startTime: 1710100000n,
    status: "LoanInitiated",
    nftCollateralTokenId: 55n,
    nftCollateralAddress: "0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D",
    borrower: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    source: [
      {
        lender: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        loanId: 100n,
        startTime: 1710100000n,
        originationFee: 0n,
        principalAmount: 1000000000000000000n,
        lenderAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        accruedInterest: 0n,
        aprBps: 2500n,
      },
    ],
    protocolFee: 100n,
    principalAddress: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    blendedAprBps: 2500,
    nft: {
      tokenId: 55n,
      collection: {
        slug: "some-collection",
        name: null,
      },
    },
    currency: {
      symbol: "WETH",
      decimals: 18,
    },
  };

  const result = convertGondiLoanToDetected(mockLoan);

  assertEqual(result.collection, "Unknown", "null name defaults to Unknown");
  assertEqual(result.collectionSlug, "some-collection", "slug still present");
}

// ==================== TEST 3: Undefined nftCollateralAddress defaults to "" ====================

function testUndefinedCollateralAddress(): void {
  console.log("\n--- Test 3: Undefined nftCollateralAddress defaults to empty string ---");

  const mockLoan: GondiLoan = {
    id: "loan-no-addr",
    loanId: 200,
    contractAddress: "0xf41B389E0C1950dc0B16C9498eaE77131CC08A56",
    borrowerAddress: "0xcccccccccccccccccccccccccccccccccccccccc",
    principalAmount: 250000000000000000n, // 0.25 ETH
    duration: 604800n, // 7 days
    startTime: 1710200000n,
    status: "LoanInitiated",
    nftCollateralTokenId: 77n,
    nftCollateralAddress: undefined,
    borrower: "0xcccccccccccccccccccccccccccccccccccccccc",
    source: [
      {
        lender: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        loanId: 200n,
        startTime: 1710200000n,
        originationFee: 0n,
        principalAmount: 250000000000000000n,
        lenderAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        accruedInterest: 0n,
        aprBps: 4000n,
      },
    ],
    protocolFee: 50n,
    principalAddress: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    blendedAprBps: 4000,
    nft: {
      tokenId: 77n,
      collection: {
        slug: "doodles-official",
        name: "Doodles",
      },
    },
    currency: {
      symbol: "WETH",
      decimals: 18,
    },
  };

  const result = convertGondiLoanToDetected(mockLoan);

  assertEqual(result.collectionAddress, "", "undefined nftCollateralAddress defaults to empty string");
  assertEqual(result.collection, "Doodles", "collection name still correct");
}

// ==================== TEST 4: Very large bigint values (1.5 ETH) ====================

function testLargeBigintValues(): void {
  console.log("\n--- Test 4: Large bigint values (1.5 ETH = 1500000000000000000) ---");

  const principalWei = 1500000000000000000n; // 1.5 ETH
  const startTimestamp = 1710300000;
  const durationSeconds = 30 * 86400; // 30 days

  const mockLoan: GondiLoan = {
    id: "loan-large",
    loanId: 999999,
    contractAddress: "0xf41B389E0C1950dc0B16C9498eaE77131CC08A56",
    borrowerAddress: "0xdddddddddddddddddddddddddddddddddddddd",
    principalAmount: principalWei,
    duration: BigInt(durationSeconds),
    startTime: BigInt(startTimestamp),
    status: "LoanInitiated",
    nftCollateralTokenId: 12345678901234n,
    nftCollateralAddress: "0xED5AF388653567Af2F388E6224dC7C4b3241C544",
    borrower: "0xdddddddddddddddddddddddddddddddddddddd",
    source: [
      {
        lender: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        loanId: 999999n,
        startTime: BigInt(startTimestamp),
        originationFee: 0n,
        principalAmount: principalWei,
        lenderAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        accruedInterest: 50000000000000000n,
        aprBps: 1500n,
      },
    ],
    protocolFee: 500n,
    principalAddress: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    blendedAprBps: 1500,
    nft: {
      tokenId: 12345678901234n,
      collection: {
        slug: "azuki",
        name: "Azuki",
      },
    },
    currency: {
      symbol: "WETH",
      decimals: 18,
    },
  };

  const result = convertGondiLoanToDetected(mockLoan);

  assertEqual(result.loanId, "999999", "large loanId converts correctly");
  assertEqual(result.amount, 1.5, "1.5 ETH from large bigint");
  assertEqual(result.durationDays, 30, "30-day duration");
  assertEqual(result.tokenId, "12345678901234", "large tokenId as string");
  assertEqual(result.aprBps, 1500, "aprBps 1500");

  // Verify start and end time are 30 days apart
  const diffMs = result.endTime.getTime() - result.startTime.getTime();
  const diffDays = diffMs / (1000 * 86400);
  assertEqual(diffDays, 30, "endTime - startTime = 30 days");
}

// ==================== TEST 5: Null collection object (missing collection entirely) ====================

function testNullCollectionObject(): void {
  console.log("\n--- Test 5: Null collection object ---");

  const mockLoan: GondiLoan = {
    id: "loan-no-collection",
    loanId: 333,
    contractAddress: "0xf41B389E0C1950dc0B16C9498eaE77131CC08A56",
    borrowerAddress: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    principalAmount: 100000000000000000n, // 0.1 ETH
    duration: 86400n, // 1 day
    startTime: 1710400000n,
    status: "LoanInitiated",
    nftCollateralTokenId: 1n,
    nftCollateralAddress: "0x1234567890abcdef1234567890abcdef12345678",
    borrower: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    source: [
      {
        lender: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        loanId: 333n,
        startTime: 1710400000n,
        originationFee: 0n,
        principalAmount: 100000000000000000n,
        lenderAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        accruedInterest: 0n,
        aprBps: 5000n,
      },
    ],
    protocolFee: 25n,
    principalAddress: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    blendedAprBps: 5000,
    nft: {
      tokenId: 1n,
      collection: null,
    },
    currency: {
      symbol: "WETH",
      decimals: 18,
    },
  };

  const result = convertGondiLoanToDetected(mockLoan);

  assertEqual(result.collection, "Unknown", "null collection object defaults to Unknown");
  assertEqual(result.collectionSlug, "", "null collection object defaults slug to empty string");
}

// ==================== TEST 6: Type structure validation ====================

function testDetectedLoanTypeStructure(): void {
  console.log("\n--- Test 6: DetectedLoan type structure validation ---");

  const loan: DetectedLoan = {
    loanId: "1",
    platform: "gondi",
    collection: "Test",
    collectionSlug: "test",
    collectionAddress: "0x0000000000000000000000000000000000000000",
    amount: 1.0,
    currency: "WETH",
    aprBps: 2000,
    durationDays: 7,
    borrower: "0x0000000000000000000000000000000000000001",
    startTime: new Date(),
    endTime: new Date(),
    tokenId: "1",
  };

  // All required fields exist and have the right types
  assertEqual(typeof loan.loanId, "string", "loanId is string");
  assertEqual(typeof loan.platform, "string", "platform is string");
  assertEqual(typeof loan.collection, "string", "collection is string");
  assertEqual(typeof loan.collectionSlug, "string", "collectionSlug is string");
  assertEqual(typeof loan.collectionAddress, "string", "collectionAddress is string");
  assertEqual(typeof loan.amount, "number", "amount is number");
  assertEqual(typeof loan.currency, "string", "currency is string");
  assertEqual(typeof loan.aprBps, "number", "aprBps is number");
  assertEqual(typeof loan.durationDays, "number", "durationDays is number");
  assertEqual(typeof loan.borrower, "string", "borrower is string");
  assert(loan.startTime instanceof Date, "startTime is Date");
  assert(loan.endTime instanceof Date, "endTime is Date");
  assertEqual(typeof loan.tokenId, "string", "tokenId is string");
}

// ==================== RUN ALL TESTS ====================

console.log("=== DetectedLoan & fetchActiveLoans conversion tests ===");

testStandardLoan();
testNullCollectionName();
testUndefinedCollateralAddress();
testLargeBigintValues();
testNullCollectionObject();
testDetectedLoanTypeStructure();

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);

if (failed > 0) {
  process.exit(1);
}
