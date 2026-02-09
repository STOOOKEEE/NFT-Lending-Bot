/**
 * bot-auto.ts - Bot NFT Lending entièrement automatisé
 *
 * Architecture: un seul cycle toutes les 30 minutes
 *
 * Chaque cycle:
 *   1. Collecter les prix (floor, bid, spread)
 *   2. Syncer les offres compétiteurs sur Gondi
 *   3. Tracker les offres acceptées (EXECUTED)
 *   4. Évaluer la stratégie pour chaque collection
 *   5. Publier les offres compétitives (expiration 35 min)
 *
 * Les offres expirent naturellement → pas de gas pour annuler.
 * Si le marché bouge, le prochain cycle ajuste les paramètres.
 * Si le marché crash, la stratégie ne trouve rien → pas de publication.
 *
 * Usage:
 *   npm run bot
 */

import "dotenv/config";
import { PriceFetcher } from "./collectors/price-fetcher";
import { savePriceToDb, getLatestFloorPrice } from "./utils/price-db";
import { getAllOffers as fetchGondiOffers, OfferStatus, Offer } from "./collectors/gondi-fetcher";
import { replaceAllOffers, BestOfferRecord } from "./utils/gondi-db";
import { runStrategy, getOffersToSend } from "./strategy/Strategy";
import { loadEnabledCollections, CollectionConfig } from "./utils/collections-loader";
import { RiskManager, DEFAULT_RISK_LIMITS } from "./risk/RiskManager";
import { trackOurOffers, formatTrackingResult, TrackingResult } from "./execution/loan-tracker";
import { compactPriceHistory } from "./compact-price-history";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

// ==================== CONFIGURATION ====================

/** Collecte des prix indépendante (30 min) - reduced from 10 to avoid OpenSea rate limits after 8+ hours */
const PRICE_COLLECTION_INTERVAL = 30 * 60 * 1000;

/** Intervalle du cycle principal: sync + tracking + stratégie (30 min) */
const MAIN_CYCLE_INTERVAL = 30 * 60 * 1000;

/** Rapport de risque toutes les heures */
const RISK_REPORT_INTERVAL = 60 * 60 * 1000;

/** Compaction des prix toutes les 24h */
const COMPACTION_INTERVAL = 24 * 60 * 60 * 1000;

const SEND_OFFERS = process.env.SEND_OFFERS === "true";
const TELEGRAM_ENABLED = !!process.env.TELEGRAM_BOT_TOKEN && !!process.env.TELEGRAM_CHAT_ID;

let COLLECTIONS: CollectionConfig[] = [];
let riskManager: RiskManager;
let priceFetcher: PriceFetcher;
let cycleCount = 0;

// Tracking des prix pour détecter les mouvements importants
const lastKnownFloors = new Map<string, number>();
const PRICE_ALERT_THRESHOLD = 0.10; // Alerte si floor bouge de +/- 10%

// ==================== HELPERS ====================

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function log(emoji: string, message: string): void {
  const timestamp = new Date().toLocaleTimeString();
  console.log(`[${timestamp}] ${emoji} ${message}`);
}

function getDurationBucket(durationDays: number): number {
  const DURATION_BUCKETS = [5, 7, 10, 15, 30, 60, 90, 120];
  for (const bucket of DURATION_BUCKETS) {
    if (durationDays <= bucket) return bucket;
  }
  return DURATION_BUCKETS[DURATION_BUCKETS.length - 1];
}

function timestampToISODate(timestamp: string): string {
  const num = parseInt(timestamp);
  if (!isNaN(num) && num > 1000000000) {
    return new Date(num * 1000).toISOString();
  }
  return new Date(timestamp).toISOString();
}

// Cache du prix ETH/USD (refresh toutes les 10 minutes max)
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

      // Skip invalid prices (floor = 0 is an error from OpenSea)
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

      // Détecter les mouvements de prix importants
      const prevFloor = lastKnownFloors.get(col.slug);
      if (prevFloor && prevFloor > 0) {
        const change = (price.floorPrice - prevFloor) / prevFloor;
        if (Math.abs(change) >= PRICE_ALERT_THRESHOLD) {
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

  // Alerter sur les mouvements significatifs
  if (priceAlerts.length > 0) {
    log("🚨", `${priceAlerts.length} significant price movement(s) detected`);
    await sendTelegramMessage(
      `<b>🚨 PRICE ALERT</b>\n${priceAlerts.join("\n")}`
    );
  }
}

// ==================== STEP 2: GONDI SYNC ====================

async function findBestOffersPerCollectionDuration(offers: Offer[]): Promise<BestOfferRecord[]> {
  const ethUsdPrice = await getEthUsdPrice();
  const collectionOffers = offers.filter(o => o.collection && !o.nft);
  const grouped = new Map<string, Offer[]>();

  for (const offer of collectionOffers) {
    const slug = offer.collection?.slug || "unknown";
    const durationDays = Math.floor(parseInt(offer.duration) / 86400);
    const bucket = getDurationBucket(durationDays);
    const key = `${slug}|${bucket}`;

    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(offer);
  }

  const results: BestOfferRecord[] = [];

  for (const [key, groupOffers] of grouped.entries()) {
    const [slug, bucketStr] = key.split("|");
    const bucket = parseInt(bucketStr);

    let bestByPrincipal: Offer | null = null;
    let bestPrincipalETH = -Infinity;

    let bestByApr: Offer | null = null;
    let lowestApr = Infinity;

    for (const offer of groupOffers) {
      const principal = parseFloat(offer.principalAmount) / Math.pow(10, offer.currency.decimals);
      const principalETH = toETHEquivalent(principal, offer.currency.symbol, ethUsdPrice);
      const apr = parseInt(offer.aprBps) / 100;

      if (principalETH > bestPrincipalETH) {
        bestPrincipalETH = principalETH;
        bestByPrincipal = offer;
      }

      if (apr < lowestApr) {
        lowestApr = apr;
        bestByApr = offer;
      }
    }

    if (bestByPrincipal && bestByApr) {
      const p1 = parseFloat(bestByPrincipal.principalAmount) / Math.pow(10, bestByPrincipal.currency.decimals);
      const p2 = parseFloat(bestByApr.principalAmount) / Math.pow(10, bestByApr.currency.decimals);

      results.push({
        collection_name: bestByPrincipal.collection?.name || "Unknown",
        collection_slug: slug,
        duration_days: bucket,
        best_principal_amount: p1,
        best_principal_currency: bestByPrincipal.currency.symbol,
        best_principal_apr: parseInt(bestByPrincipal.aprBps) / 100,
        best_principal_offer_id: bestByPrincipal.offerId,
        best_principal_lender: bestByPrincipal.lenderAddress,
        best_principal_expiration: timestampToISODate(bestByPrincipal.expirationTime),
        best_apr_amount: p2,
        best_apr_currency: bestByApr.currency.symbol,
        best_apr_percent: parseInt(bestByApr.aprBps) / 100,
        best_apr_offer_id: bestByApr.offerId,
        best_apr_lender: bestByApr.lenderAddress,
        best_apr_expiration: timestampToISODate(bestByApr.expirationTime),
      });
    }
  }

  return results;
}

async function syncGondiOffers(): Promise<void> {
  log("🔄", "Syncing Gondi offers...");

  try {
    const offers = await fetchGondiOffers({
      statuses: [OfferStatus.Active],
      onlyCollectionOffers: true,
    });

    log("📥", `Found ${offers.length} active collection offers`);

    const bestOffers = await findBestOffersPerCollectionDuration(offers);
    log("🎯", `Processed ${bestOffers.length} best offers`);

    const result = await replaceAllOffers(bestOffers);
    log("💾", `Saved to DB: ${result.success} success, ${result.failed} failed`);

    log("✅", "Gondi sync completed");
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`❌ Gondi sync failed: ${msg}`);
    await sendTelegramMessage(`<b>❌ SYNC ERROR</b>\nGondi sync failed: ${msg}`);
  }
}

// ==================== STEP 3: LOAN TRACKING ====================

async function trackLoans(): Promise<TrackingResult | null> {
  const walletAddress = process.env.WALLET_ADDRESS;
  if (!walletAddress) return null;

  log("🔍", "Tracking loan statuses...");

  try {
    const result = await trackOurOffers(walletAddress, riskManager);
    const summary = formatTrackingResult(result);
    log("🔍", summary);

    if (result.executed > 0) {
      await sendTelegramMessage(
        `<b>✅ LOAN ACCEPTED</b>\n${result.executed} offer(s) accepted by borrowers`
      );
    }

    if (result.cancelled > 0) {
      await sendTelegramMessage(
        `<b>🚫 OFFERS CANCELLED</b>\n${result.cancelled} offer(s) cancelled on-chain`
      );
    }

    return result;
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`❌ Loan tracking failed: ${msg}`);
    await sendTelegramMessage(`<b>❌ TRACKING ERROR</b>\n${msg}`);
    return null;
  }
}

// ==================== STEP 4+5: STRATEGY + PUBLISH ====================

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
    const report = await runStrategy(collectionSlugs);

    const offersToSend = getOffersToSend(report);
    stats.offersSkipped = report.summary.skipped;

    if (offersToSend.length === 0) {
      log("⏭️", "No competitive offers found — previous offers will expire naturally");
      return stats;
    }

    log("✅", `Found ${offersToSend.length} competitive offers`);

    if (SEND_OFFERS) {
      for (const offer of offersToSend) {
        if (!offer.offerDetails) continue;

        const { loanAmount, durationDays, competitiveApr } = offer.offerDetails;

        const riskCheck = riskManager.canAllocateCapital(offer.collection, loanAmount);
        if (!riskCheck.canAllocate) {
          log("⚠️", `Skipping ${offer.collection}: ${riskCheck.reason}`);
          stats.riskBlocked++;
          continue;
        }

        log("📤", `Publishing offer for ${offer.collection}...`);

        try {
          const command = [
            "npx ts-node src/execution/send-gondi-offer.ts",
            `--collection ${offer.collection}`,
            `--amount ${loanAmount.toFixed(4)}`,
            `--apr ${(competitiveApr * 100).toFixed(2)}`,
            `--duration ${durationDays}`,
          ].join(" ");

          const { stderr } = await execAsync(command);

          if (stderr && !stderr.includes("Debugger")) {
            console.error(`  ⚠️ Stderr: ${stderr}`);
          }

          log("✅", `Offer published for ${offer.collection} (expires in ~35 min)`);
          stats.offersPublished++;

          // Enregistrer dans le RiskManager
          const floorPrice = offer.marketContext?.floorPrice || loanAmount / (offer.offerDetails.ltv || 0.4);
          const collectionConfig = COLLECTIONS.find(c => c.slug === offer.collection);

          await riskManager.registerLoan({
            offerId: `${offer.collection}-${Date.now()}`,
            collection: offer.collection,
            collectionAddress: collectionConfig?.address || "",
            loanAmount,
            apr: competitiveApr,
            durationDays,
            startDate: new Date(),
            endDate: new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000),
            collateralFloorPrice: floorPrice,
            status: "active",
            liquidationRisk: 0,
          });

          await sendTelegramMessage(
            `<b>📤 OFFER</b> | ${offer.collection}\n` +
            `${loanAmount.toFixed(3)} ETH @ ${(competitiveApr * 100).toFixed(2)}%\n` +
            `${durationDays}d | Profit ${offer.offerDetails.expectedProfit.toFixed(4)} ETH`
          );
        } catch (error: unknown) {
          const errMsg = error instanceof Error ? error.message : String(error);
          console.error(`  ❌ Failed to publish offer: ${errMsg}`);
          stats.errors++;
          await sendTelegramMessage(
            `<b>❌ PUBLISH ERROR</b>\n${offer.collection}: ${errMsg}`
          );
        }

        await sleep(2000);
      }
    } else {
      log("ℹ️", "SEND_OFFERS=false, dry-run mode");

      for (const offer of offersToSend) {
        if (!offer.offerDetails) continue;
        const { loanAmount, durationDays, competitiveApr } = offer.offerDetails;
        console.log(
          `  📋 ${offer.collection}: ${loanAmount.toFixed(3)} ETH @ ${(competitiveApr * 100).toFixed(2)}% for ${durationDays}d`
        );
      }
    }

    log("✅", "Strategy execution completed");
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`❌ Strategy execution failed: ${msg}`);
    await sendTelegramMessage(`<b>❌ STRATEGY ERROR</b>\n${msg}`);
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
        await riskManager.updateFloorPrice(loan.offerId, latestPrice.floor);
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
    await sendTelegramMessage(`<b>🚨 RISK ALERTS</b>\n${alerts.join("\n")}`);
  }

  // Heartbeat horaire — status même sans alertes
  const totalExposure = activeLoans.reduce((sum, l) => sum + l.loanAmount, 0);
  const maxCapital = parseFloat(process.env.MAX_CAPITAL_ETH || "10");
  const utilization = maxCapital > 0 ? (totalExposure / maxCapital * 100).toFixed(0) : "0";

  await sendTelegramMessage(
    `<b>📊 HOURLY STATUS</b>\n` +
    `⏱️ Uptime: ${cycleCount} cycles\n` +
    `💰 ${activeLoans.length} active loan(s) — ${totalExposure.toFixed(3)} ETH\n` +
    `📈 Capital: ${utilization}% used (${totalExposure.toFixed(2)}/${maxCapital} ETH)\n` +
    `${alerts.length > 0 ? `🚨 ${alerts.length} alert(s)` : "✅ No alerts"}`
  );
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
    await sendTelegramMessage(`<b>❌ COMPACTION ERROR</b>\n${msg}`);
  }
}

// ==================== MAIN CYCLE ====================

/**
 * Cycle principal: sync → tracking → stratégie → publication
 * Exécuté toutes les 30 min. Les offres expirent en 35 min.
 * Les prix sont collectés indépendamment toutes les 10 min.
 */
async function runCycle(): Promise<void> {
  cycleCount++;
  const separator = "=".repeat(70);
  console.log(`\n${separator}`);
  log("🔄", `Cycle #${cycleCount} starting`);
  console.log(separator);

  // 1. Syncer les offres Gondi (marché)
  await syncGondiOffers();
  await sleep(2000);

  // 2. Tracker les offres acceptées/expirées
  const tracking = await trackLoans();

  // 3. Évaluer et publier les offres
  const stats = await executeStrategy();

  // 4. Résumé du cycle via Telegram
  const lines: string[] = [`<b>🔄 Cycle #${cycleCount}</b>`];

  if (stats.offersPublished > 0) {
    lines.push(`📤 ${stats.offersPublished} offer(s) published`);
  }
  if (stats.offersSkipped > 0) {
    lines.push(`⏭️ ${stats.offersSkipped} collection(s) skipped`);
  }
  if (stats.riskBlocked > 0) {
    lines.push(`🛡️ ${stats.riskBlocked} blocked by risk`);
  }
  if (stats.errors > 0) {
    lines.push(`❌ ${stats.errors} error(s)`);
  }
  if (tracking) {
    if (tracking.executed > 0) lines.push(`✅ ${tracking.executed} loan(s) accepted`);
    if (tracking.expired > 0) lines.push(`⏰ ${tracking.expired} offer(s) expired`);
  }

  const activeLoans = riskManager.getActiveLoans();
  if (activeLoans.length > 0) {
    const totalExposure = activeLoans.reduce((sum, l) => sum + l.loanAmount, 0);
    lines.push(`💰 ${activeLoans.length} active loan(s) — ${totalExposure.toFixed(3)} ETH`);
  }

  await sendTelegramMessage(lines.join("\n"));

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
  console.log(`⏱️  Offer expiration: 35 minutes`);
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

  // Init
  priceFetcher = new PriceFetcher({
    openseaApiKey: process.env.OPENSEA_API_KEY,
  });

  const maxCapital = parseFloat(process.env.MAX_CAPITAL_ETH || "10");
  const maxExposurePerCollection = parseFloat(process.env.MAX_EXPOSURE_PER_COLLECTION || "2");

  riskManager = new RiskManager({
    ...DEFAULT_RISK_LIMITS,
    maxCapitalEth: maxCapital,
    maxExposurePerCollection,
  });

  await riskManager.init();
  log("🛡️", `Risk Manager initialized: ${maxCapital} ETH total, ${maxExposurePerCollection} ETH per collection`);

  await sendTelegramMessage(
    `<b>🤖 NFT Lending Bot Started</b>\n` +
    `📊 ${COLLECTIONS.length} collections\n` +
    `🔄 Cycle: every 30 min\n` +
    `📤 Send offers: ${SEND_OFFERS ? "ON" : "OFF"}`
  );

  // Première collecte de prix + premier cycle
  await collectPrices();
  await sleep(3000);
  await runCycle();

  // Collecte de prix indépendante toutes les 10 minutes
  setInterval(collectPrices, PRICE_COLLECTION_INTERVAL);

  // Cycle principal toutes les 30 minutes
  setInterval(runCycle, MAIN_CYCLE_INTERVAL);

  // Rapport de risque toutes les heures
  setInterval(generateRiskReport, RISK_REPORT_INTERVAL);

  // Compaction des prix toutes les 24h (garde 7j haute fréquence, compacte le reste)
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
