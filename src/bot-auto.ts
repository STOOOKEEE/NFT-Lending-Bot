/**
 * bot-auto.ts - Bot NFT Lending entièrement automatisé
 *
 * Architecture refactorée:
 * - LendingPlatform[] : tableau de plateformes (Gondi, Blur, ...)
 * - Chaque cycle itère sur les plateformes de manière uniforme
 * - Ajouter une plateforme = créer une classe, l'ajouter au tableau
 *
 * Chaque cycle (30 min):
 *   1. Collecter les prix (floor, bid, spread)
 *   2. Sync marché sur toutes les plateformes
 *   3. Tracker les offres acceptées (EXECUTED)
 *   4. Vérifier les liquidations sur toutes les plateformes
 *   5. Évaluer la stratégie et publier les offres compétitives
 *
 * Les offres expirent naturellement → pas de gas pour annuler.
 */

import "dotenv/config";
import { privateKeyToAccount } from "viem/accounts";
import { PriceFetcher } from "./collectors/price-fetcher";
import { savePriceToDb, getLatestFloorPrice } from "./utils/price-db";
import { runStrategy, getOffersToSend } from "./strategy/Strategy";
import { loadEnabledCollections, CollectionConfig } from "./utils/collections-loader";
import { RiskManager, DEFAULT_RISK_LIMITS } from "./risk/RiskManager";
import { compactPriceHistory } from "./compact-price-history";
import { sleep } from "./utils/helpers";
import { startTelegramCommands } from "./utils/telegram-commands";
import { LendingPlatform, NormalizedOffer, TrackingResult } from "./adapters/LendingPlatform";
import { GondiPlatform } from "./adapters/GondiPlatform";
import { BlurPlatform } from "./adapters/BlurPlatform";

// ==================== CONFIGURATION ====================

const PRICE_COLLECTION_INTERVAL = 60 * 60 * 1000;
const MAIN_CYCLE_INTERVAL = 30 * 60 * 1000;
const RISK_REPORT_INTERVAL = 60 * 60 * 1000;
const COMPACTION_INTERVAL = 24 * 60 * 60 * 1000;

const SEND_OFFERS = process.env.SEND_OFFERS === "true";
const TELEGRAM_ENABLED = !!process.env.TELEGRAM_BOT_TOKEN && !!process.env.TELEGRAM_CHAT_ID;

let COLLECTIONS: CollectionConfig[] = [];
let riskManager: RiskManager;
let priceFetcher: PriceFetcher;
let platforms: LendingPlatform[] = [];
let walletAddress: string = "";
let cycleCount = 0;

const lastKnownFloors = new Map<string, number>();
const PRICE_ALERT_THRESHOLD = 0.10;

// ==================== HELPERS ====================

function log(emoji: string, message: string): void {
  const timestamp = new Date().toLocaleTimeString();
  console.log(`[${timestamp}] ${emoji} ${message}`);
}

// ==================== TELEGRAM ====================

async function sendTelegramMessage(message: string): Promise<void> {
  if (!TELEGRAM_ENABLED) return;

  try {
    const botToken = process.env.TELEGRAM_BOT_TOKEN!;
    const chatId = process.env.TELEGRAM_CHAT_ID!;
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: "HTML",
      }),
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("Telegram error:", msg);
  }
}

// ==================== STEP 1: PRICE COLLECTION ====================

async function collectPrices(): Promise<void> {
  log("📊", `Collecting prices for ${COLLECTIONS.length} collections...`);
  const priceAlerts: string[] = [];
  const startTime = Date.now();
  let successCount = 0;
  let errorCount = 0;

  for (const col of COLLECTIONS) {
    try {
      const collStartTime = Date.now();
      const price = await priceFetcher.fetchPrice(col.slug);
      const collDuration = Date.now() - collStartTime;

      if (price.floorPrice <= 0) {
        log("⚠️ ", `${col.slug}: invalid floor price (${price.floorPrice}), skipping`);
        errorCount++;
        continue;
      }

      successCount++;
      log("✅", `${col.slug}: ${collDuration}ms (floor=${price.floorPrice.toFixed(4)}, bid=${price.topBid.toFixed(4)})`);

      await savePriceToDb({
        collection_slug: col.slug,
        floor_price: price.floorPrice,
        top_bid: price.topBid,
        mid_price: price.midPrice,
        spread: price.spread,
      });

      const prevFloor = lastKnownFloors.get(col.slug);
      if (prevFloor && prevFloor > 0) {
        const change = (price.floorPrice - prevFloor) / prevFloor;
        const hasActiveLoan = riskManager.getActiveLoansForCollection(col.slug).length > 0;
        if (Math.abs(change) >= PRICE_ALERT_THRESHOLD && hasActiveLoan) {
          const direction = change > 0 ? "📈" : "📉";
          const pct = (change * 100).toFixed(1);
          priceAlerts.push(
            `${direction} ${col.name}: ${prevFloor.toFixed(3)} → ${price.floorPrice.toFixed(3)} ETH (${pct}%)`
          );
        }
      }
      lastKnownFloors.set(col.slug, price.floorPrice);

      console.log(
        `  ${col.name.padEnd(20)} | Floor: ${price.floorPrice.toFixed(3)} ETH | ` +
        `Bid: ${price.topBid.toFixed(3)} ETH | Spread: ${price.spread.toFixed(1)}%`
      );

      await sleep(300);
    } catch (error: unknown) {
      errorCount++;
      const msg = error instanceof Error ? error.message : String(error);
      log("❌", `${col.name}: ${msg}`);
    }
  }

  const totalDuration = Date.now() - startTime;
  log("✅", `Price collection completed: ${successCount}/${COLLECTIONS.length} (${errorCount} errors) in ${(totalDuration / 1000).toFixed(1)}s`);

  if (priceAlerts.length > 0) {
    log("🚨", `${priceAlerts.length} significant price movement(s) detected`);
    await sendTelegramMessage(
      `<b>🚨 PRICE ALERT</b>\n${priceAlerts.join("\n")}`
    );
  }
}

// ==================== STEP 2: MARKET SYNC (all platforms) ====================

async function syncAllMarkets(): Promise<void> {
  for (const platform of platforms) {
    log("🔄", `Syncing ${platform.name} market data...`);
    try {
      await platform.syncMarketData();
      log("✅", `${platform.name} sync completed`);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`❌ ${platform.name} sync failed: ${msg}`);
      // Sync errors: console only, resolves next cycle
    }
    await sleep(2000);
  }
}

// ==================== STEP 3: LOAN TRACKING (all platforms) ====================

interface AggregatedTracking {
  totalExecuted: number;
  totalCancelled: number;
  totalExpired: number;
  totalErrors: number;
  results: Map<string, TrackingResult>;
}

async function trackAllLoans(): Promise<AggregatedTracking> {
  const aggregated: AggregatedTracking = {
    totalExecuted: 0,
    totalCancelled: 0,
    totalExpired: 0,
    totalErrors: 0,
    results: new Map(),
  };

  if (!walletAddress) return aggregated;

  log("🔍", "Tracking loan statuses...");

  for (const platform of platforms) {
    try {
      const result = await platform.trackOffers(walletAddress, riskManager);
      aggregated.results.set(platform.name, result);
      aggregated.totalExecuted += result.executed;
      aggregated.totalCancelled += result.cancelled;
      aggregated.totalExpired += result.expired;
      aggregated.totalErrors += result.errors;

      if (result.checked > 0) {
        const parts = [
          `Checked ${result.checked}`,
          result.executed > 0 ? `${result.executed} executed` : null,
          result.cancelled > 0 ? `${result.cancelled} cancelled` : null,
          result.expired > 0 ? `${result.expired} expired` : null,
        ].filter(Boolean).join(", ");
        log("🔍", `[${platform.name}] ${parts}`);
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`❌ [${platform.name}] Tracking failed: ${msg}`);
      aggregated.totalErrors++;
    }
  }

  if (aggregated.totalExecuted > 0) {
    await sendTelegramMessage(
      `<b>✅ LOAN ACCEPTED</b>\n${aggregated.totalExecuted} offer(s) accepted by borrowers`
    );
  }

  return aggregated;
}

// ==================== STEP 4: LIQUIDATION CHECK (all platforms) ====================

interface AggregatedLiquidation {
  totalLiquidated: number;
  totalRecalled: number;
  totalWarnings: number;
  totalErrors: number;
  allAlerts: string[];
}

async function checkAllLiquidations(): Promise<AggregatedLiquidation> {
  const aggregated: AggregatedLiquidation = {
    totalLiquidated: 0,
    totalRecalled: 0,
    totalWarnings: 0,
    totalErrors: 0,
    allAlerts: [],
  };

  for (const platform of platforms) {
    log("⚠️ ", `Checking ${platform.name} for defaults/LTV...`);

    try {
      const result = await platform.checkAndLiquidate(!SEND_OFFERS);

      aggregated.totalLiquidated += result.liquidated;
      aggregated.totalRecalled += result.recalled;
      aggregated.totalWarnings += result.warnings;
      aggregated.totalErrors += result.errors;
      aggregated.allAlerts.push(...result.alerts);

      if (result.checked > 0) {
        log("🔍", `[${platform.name}] Checked ${result.checked}, liquidated ${result.liquidated}, recalled ${result.recalled}, warnings ${result.warnings}`);
      } else {
        log("✅", `[${platform.name}] No active loans to check`);
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`❌ [${platform.name}] Liquidation check failed: ${msg}`);
      aggregated.totalErrors++;
    }
  }

  if (aggregated.allAlerts.length > 0) {
    await sendTelegramMessage(
      `<b>⚠️ LIQUIDATION CHECK</b>\n${aggregated.allAlerts.join("\n")}`
    );
  }

  return aggregated;
}

// ==================== STEP 5: STRATEGY + PUBLISH ====================

interface CycleStats {
  offersPublished: number;
  offersSkipped: number;
  riskBlocked: number;
  errors: number;
}

async function executeStrategy(): Promise<CycleStats> {
  log("🎯", "Executing strategy...");

  const stats: CycleStats = { offersPublished: 0, offersSkipped: 0, riskBlocked: 0, errors: 0 };

  try {
    const collectionSlugs = COLLECTIONS.map(c => c.slug);
    const report = await runStrategy(collectionSlugs, platforms);

    const offersToSend = getOffersToSend(report);
    stats.offersSkipped = report.summary.skipped;

    if (offersToSend.length === 0) {
      log("⏭️", "No competitive offers found — previous offers will expire naturally");
      return stats;
    }

    log("✅", `Found ${offersToSend.length} competitive offers`);

    if (SEND_OFFERS) {
      // Fetch balances once per platform
      const balances = new Map<string, number>();
      for (const platform of platforms) {
        try {
          const balance = await platform.getAvailableBalance();
          balances.set(platform.name, balance);
          log("💰", `${platform.name} balance: ${balance.toFixed(4)} ETH`);
        } catch {
          log("⚠️ ", `Could not fetch ${platform.name} balance — skipping balance checks`);
          balances.set(platform.name, Infinity);
        }
      }

      // Index platforms by name for quick lookup
      const platformByName = new Map<string, LendingPlatform>();
      for (const p of platforms) platformByName.set(p.name, p);

      for (const offer of offersToSend) {
        if (!offer.offerDetails) continue;

        const { loanAmount, durationDays, competitiveApr, offerType, collectionAddress } = offer.offerDetails;
        const t = offerType === "best_apr" ? "T1" : "T2";
        const platformName = offer.platform.toUpperCase();

        // Find the platform
        const platform = platformByName.get(offer.platform);
        if (!platform) {
          log("⚠️ ", `Unknown platform: ${offer.platform} for ${offer.collection}`);
          stats.offersSkipped++;
          continue;
        }

        // Balance check
        const balance = balances.get(offer.platform) ?? 0;
        if (loanAmount > balance) {
          log("⏭️", `[${platformName}] Skip ${t} ${offer.collection}: ${loanAmount.toFixed(3)} ETH > ${balance.toFixed(3)} ETH balance`);
          stats.offersSkipped++;
          continue;
        }

        // Risk check
        const riskCheck = riskManager.canAllocateCapital(offer.collection, loanAmount);
        if (!riskCheck.canAllocate) {
          log("🛡️", `[${platformName}] Skip ${t} ${offer.collection}: ${riskCheck.reason}`);
          stats.riskBlocked++;
          continue;
        }

        // Dedup check disabled: offers expire naturally (30 min), no gas to cancel.
        // Skipping caused missed cycles when old offer had seconds left.

        log("📤", `[${platformName}] Publishing ${t} offer for ${offer.collection}...`);

        try {
          const normalizedOffer: NormalizedOffer = {
            platform: offer.platform,
            collection: offer.collection,
            collectionAddress: collectionAddress || "",
            loanAmount,
            aprBps: Math.round(competitiveApr * 10000),
            durationDays,
            ltv: offer.offerDetails.ltv,
            offerType,
          };

          const result = await platform.sendOffer(normalizedOffer);

          if (result.success) {
            log("✅", `[${platformName}] ${t} offer published for ${offer.collection} (${result.offerId || result.offerHash || "ok"})`);
            stats.offersPublished++;
          } else {
            console.error(`  ❌ [${platformName}] ${offer.collection}: ${result.error}`);
            stats.errors++;
          }
        } catch (error: unknown) {
          const errMsg = error instanceof Error ? error.message : String(error);
          console.error(`  ❌ [${platformName}] ${offer.collection}: ${errMsg}`);
          stats.errors++;
        }

        await sleep(2000);
      }
    } else {
      log("ℹ️", "SEND_OFFERS=false, dry-run mode");

      for (const offer of offersToSend) {
        if (!offer.offerDetails) continue;
        const { loanAmount, durationDays, competitiveApr, offerType } = offer.offerDetails;
        const t = offerType === "best_apr" ? "T1" : "T2";
        const platformName = offer.platform.toUpperCase();
        console.log(
          `  📋 [${platformName}] ${offer.collection} [${t}]: ${loanAmount.toFixed(3)} ETH @ ${(competitiveApr * 100).toFixed(2)}% for ${durationDays}d`
        );
      }
    }

    log("✅", "Strategy execution completed");
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`❌ Strategy execution failed: ${msg}`);
    // Strategy errors: console only
  }

  return stats;
}

// ==================== RISK REPORT ====================

async function generateRiskReport(): Promise<void> {
  log("📊", "Generating risk report...");

  const activeLoans = riskManager.getActiveLoans();
  for (const loan of activeLoans) {
    try {
      const latestPrice = await getLatestFloorPrice(loan.collection);
      if (latestPrice) {
        await riskManager.updateFloorPrice(loan.offerId, latestPrice.floor, latestPrice.bid);
      }
    } catch {
      // Best-effort
    }
  }

  const report = riskManager.generateReport();
  console.log("\n" + report);

  const alerts = riskManager.getRiskAlerts();
  if (alerts.length > 0) {
    log("🚨", `${alerts.length} risk alerts detected`);
    // Risk alerts: console only, accessible via /risk command
  }
}

// ==================== PRICE HISTORY COMPACTION ====================

async function runCompaction(): Promise<void> {
  log("📦", "Running price history compaction...");
  try {
    await compactPriceHistory();
    log("✅", "Price history compaction completed");
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`❌ Price history compaction failed: ${msg}`);
    // Compaction errors: console only, non-critical
  }
}

// ==================== MAIN CYCLE ====================

async function runCycle(): Promise<void> {
  cycleCount++;
  const separator = "=".repeat(70);
  console.log(`\n${separator}`);
  log("🔄", `Cycle #${cycleCount} starting`);
  console.log(separator);

  // 1. Sync market data on all platforms
  await syncAllMarkets();

  // 2. Track loan statuses on all platforms
  await trackAllLoans();

  // 3. Check for defaults/recalls on all platforms
  await checkAllLiquidations();

  // 4. Run strategy and publish offers
  await executeStrategy();

  log("✅", `Cycle #${cycleCount} completed — next in 30 min`);
}

// ==================== MAIN ====================

async function main() {
  try {
    COLLECTIONS = loadEnabledCollections();
    console.log(`✅ Loaded ${COLLECTIONS.length} enabled collections from collections.json`);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("❌ Failed to load collections:", msg);
    process.exit(1);
  }

  console.log("\n" + "=".repeat(70));
  console.log("🤖 NFT LENDING BOT - AUTONOMOUS MODE");
  console.log("=".repeat(70));
  console.log(`📅 Started: ${new Date().toLocaleString()}`);
  console.log(`📊 Collections: ${COLLECTIONS.length}`);
  console.log(`📊 Price collection: every ${PRICE_COLLECTION_INTERVAL / 60000} minutes`);
  console.log(`🔄 Main cycle: every ${MAIN_CYCLE_INTERVAL / 60000} minutes`);
  console.log(`⏱️  Offer expiration: 30 minutes`);
  console.log(`📤 Send Offers: ${SEND_OFFERS ? "✅ ENABLED" : "❌ DISABLED (dry-run)"}`);
  console.log(`📱 Telegram: ${TELEGRAM_ENABLED ? "✅ ENABLED" : "❌ DISABLED"}`);
  console.log("=".repeat(70) + "\n");

  console.log("📋 Enabled collections:");
  for (const col of COLLECTIONS) {
    console.log(`   - ${col.name.padEnd(30)} (${col.slug}) - Max: ${col.maxCapitalEth} ETH`);
  }
  console.log("");

  // Vérifications
  if (!process.env.OPENSEA_API_KEY) {
    console.error("❌ OPENSEA_API_KEY required");
    process.exit(1);
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    console.error("❌ SUPABASE_URL and SUPABASE_ANON_KEY required");
    process.exit(1);
  }

  // Derive wallet address from private key
  const pk = process.env.WALLET_PRIVATE_KEY;
  if (!pk) {
    console.error("❌ WALLET_PRIVATE_KEY required");
    process.exit(1);
  }
  const cleanKey = (pk.startsWith("0x") ? pk : `0x${pk}`) as `0x${string}`;
  walletAddress = privateKeyToAccount(cleanKey).address;
  console.log(`🔐 Wallet: ${walletAddress}`);

  // Init price fetcher
  priceFetcher = new PriceFetcher({
    openseaApiKey: process.env.OPENSEA_API_KEY,
  });

  // Init risk manager
  const maxCapital = parseFloat(process.env.MAX_CAPITAL_ETH || "10");
  const maxExposurePerCollection = parseFloat(process.env.MAX_EXPOSURE_PER_COLLECTION || "2");

  riskManager = new RiskManager({
    ...DEFAULT_RISK_LIMITS,
    maxCapitalEth: maxCapital,
    maxExposurePerCollection,
  });

  for (const col of COLLECTIONS) {
    if (col.maxCapitalEth > 0) {
      riskManager.setCollectionLimit(col.slug, col.maxCapitalEth);
    }
  }

  await riskManager.init();
  log("🛡️", `Risk Manager initialized: ${maxCapital} ETH total, ${maxExposurePerCollection} ETH default per collection`);

  // Init lending platforms
  platforms = [];

  // Init platforms (both dry-run and live — init needed for balance checks, tracking, liquidation)
  try {
    const gondi = new GondiPlatform();
    await gondi.init();
    platforms.push(gondi);
    log("✅", "GondiPlatform initialized");
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`❌ Failed to init GondiPlatform: ${msg}`);
    console.error("   Gondi offers will not be sent. Check WALLET_PRIVATE_KEY in .env");
  }

  try {
    const blur = new BlurPlatform();
    await blur.init();
    platforms.push(blur);
    log("✅", "BlurPlatform initialized");
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`❌ Failed to init BlurPlatform: ${msg}`);
    console.error("   Blur offers will not be sent. Check WALLET_PRIVATE_KEY in .env");
  }

  log("📡", `Platforms: ${platforms.map(p => p.name).join(", ")} (${platforms.length})`);

  await sendTelegramMessage(
    `<b>🤖 NFT Lending Bot Started</b>\n` +
    `📊 ${COLLECTIONS.length} collections\n` +
    `📡 Platforms: ${platforms.map(p => p.name).join(", ")}\n` +
    `🔄 Cycle: every 30 min\n` +
    `📤 Send offers: ${SEND_OFFERS ? "ON" : "OFF"}`
  );

  // Start Telegram command listener
  startTelegramCommands(riskManager);

  // First price collection + first cycle
  await collectPrices();
  await sleep(3000);
  await runCycle();

  // Periodic timers
  setInterval(collectPrices, PRICE_COLLECTION_INTERVAL);
  setInterval(runCycle, MAIN_CYCLE_INTERVAL);
  setInterval(generateRiskReport, RISK_REPORT_INTERVAL);
  setInterval(runCompaction, COMPACTION_INTERVAL);

  log("✅", "Bot running. Press Ctrl+C to stop.");

  process.on("SIGINT", async () => {
    log("⏹️", "Stopping bot...");
    await sendTelegramMessage("<b>🛑 NFT Lending Bot Stopped</b>");
    process.exit(0);
  });
}

main().catch(async (error: unknown) => {
  const msg = error instanceof Error ? error.message : String(error);
  console.error("❌ Fatal error:", msg);
  await sendTelegramMessage(`<b>❌ Bot Crashed</b>\n${msg}`);
  process.exit(1);
});
