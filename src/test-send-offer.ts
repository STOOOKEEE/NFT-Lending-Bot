/**
 * test-send-offer.ts - Send a single Gondi offer with origination fee
 *
 * Usage: npx ts-node src/test-send-offer.ts
 *
 * Reads wallet + fee config from .env (GONDI_ORIGINATION_FEE_BPS).
 */

import "dotenv/config";
import { GondiPlatform } from "./adapters/GondiPlatform";
import { NormalizedOffer } from "./adapters/LendingPlatform";

// ==================== OFFER PARAMS (edit here) ====================

const COLLECTION_SLUG = "sappy-seals";      // cheap collection for testing
const LOAN_AMOUNT_ETH = 0.01;               // small test amount
const APR_PERCENT = 23;                      // 23% APR
const DURATION_DAYS = 7;
const FEE_BPS = parseInt(process.env.GONDI_ORIGINATION_FEE_BPS || "100", 10);

// ==================================================================

async function main() {
  const feePercent = FEE_BPS / 100;
  const feeEth = LOAN_AMOUNT_ETH * FEE_BPS / 10000;

  console.log("=== Gondi Test Offer ===\n");
  console.log(`Collection: ${COLLECTION_SLUG}`);
  console.log(`Amount:     ${LOAN_AMOUNT_ETH} ETH`);
  console.log(`APR:        ${APR_PERCENT}%`);
  console.log(`Duration:   ${DURATION_DAYS}d`);
  console.log(`Fee:        ${FEE_BPS} BPS (${feePercent}%) = ~${feeEth.toFixed(6)} ETH`);
  console.log();

  const gondi = new GondiPlatform();
  await gondi.init();

  const balance = await gondi.getAvailableBalance();
  console.log(`WETH balance: ${balance.toFixed(4)} ETH\n`);

  if (balance < LOAN_AMOUNT_ETH) {
    console.error(`Insufficient WETH: have ${balance.toFixed(4)}, need ${LOAN_AMOUNT_ETH}`);
    process.exit(1);
  }

  const offer: NormalizedOffer = {
    platform: "gondi",
    collection: COLLECTION_SLUG,
    collectionAddress: "",
    loanAmount: LOAN_AMOUNT_ETH,
    aprBps: Math.round(APR_PERCENT * 100),
    durationDays: DURATION_DAYS,
    ltv: 0,
    offerType: "best_apr",
    originationFeeBps: FEE_BPS,
  };

  console.log("Sending offer...\n");
  const result = await gondi.sendOffer(offer);

  if (result.success) {
    console.log(`\n✅ SUCCESS`);
    console.log(`   Offer ID: ${result.offerId}`);
    if (result.offerHash) console.log(`   Hash: ${result.offerHash}`);
  } else {
    console.log(`\n❌ FAILED: ${result.error}`);
  }
}

main().catch((err: unknown) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
