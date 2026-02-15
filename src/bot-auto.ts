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
 *   5. Publier les offres compétitives (expiration 30 min)
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
import { collectBlurMarketData, displayBlurMarketData } from "./collectors/blur-market-collector";
import { saveBlurMarketData } from "./utils/blur-db";
import { initGondiContext, sendGondiCollectionOffer, getWethBalanceEth, GondiContext } from "./execution/send-gondi-offer";
import { sendBlurOffer, initBlurWallet, getBlurPoolBalanceEth, BlurOfferParams } from "./adapters/BlurAdapter";
import { checkAndLiquidate, LiquidationResult } from "./execution/liquidation";
import { sleep, getDurationBucket, getEthUsdPrice, toETHEquivalent } from "./utils/helpers";

// ==================== CONFIGURATION ====================

/** Collecte des prix indépendante (1h) - hourly to have recent prices without rate limiting */
const PRICE_COLLECTION_INTERVAL = 60 * 60 * 1000;

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
let gondiCtx: GondiContext | null = null;
let cycleCount = 0;

// Tracking des prix pour détecter les mouvements importants
const lastKnownFloors = new Map<string, number>();
const PRICE_ALERT_THRESHOLD = 0.10; // Alerte si floor bouge de +/- 10%

// ==================== HELPERS ====================

function log(emoji: string, message: string): void {
  const timestamp = new Date().toLocaleTimeString();
  console.log(`[${timestamp}] ${emoji} ${message}`);
}

function timestampToISODate(timestamp: string): string {
  const num = parseInt(timestamp);
  if (!isNaN(num) && num > 1000000000) {
    return new Date(num * 1000).toISOString();
  }
  return new Date(timestamp).toISOString();
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

// ==================== STEP 2b: BLUR MARKET SYNC ====================

async function syncBlurMarket(): Promise<void> {
  log("🔵", "Syncing Blur Blend market data...");

  try {
    const summaries = await collectBlurMarketData();
    displayBlurMarketData(summaries);

    if (summaries.length > 0) {
      const result = await saveBlurMarketData(summaries);
      log("💾", `Blur: saved ${result.success} collections, ${result.failed} failed`);
    } else {
      log("⏭️", "No Blur lending activity in the last 24h");
    }

    log("✅", "Blur market sync completed");
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`❌ Blur market sync failed: ${msg}`);
    await sendTelegramMessage(`<b>❌ BLUR SYNC ERROR</b>\n${msg}`);
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

    // Cancelled offers logged in console only (not Telegram)

    return result;
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`❌ Loan tracking failed: ${msg}`);
    await sendTelegramMessage(`<b>❌ TRACKING ERROR</b>\n${msg}`);
    return null;
  }
}

// ==================== STEP 3b: LIQUIDATION CHECK ====================

async function checkAndLiquidateLoans(): Promise<LiquidationResult | null> {
  if (!gondiCtx) return null;

  log("⚠️ ", "Checking for defaulted loans...");

  try {
    const result = await checkAndLiquidate(gondiCtx, SEND_OFFERS);

    if (result.checked === 0) {
      log("✅", "No active loans to check");
      return result;
    }

    log("🔍", `Checked ${result.checked} loan(s): ${result.liquidated} liquidated, ${result.errors} error(s)`);

    if (result.alerts.length > 0) {
      await sendTelegramMessage(
        `<b>⚠️ LIQUIDATION CHECK</b>\n${result.alerts.join("\n")}`
      );
    }

    return result;
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`❌ Liquidation check failed: ${msg}`);
    await sendTelegramMessage(`<b>❌ LIQUIDATION ERROR</b>\n${msg}`);
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
      // Fetch balances once before sending any offers
      let wethBalance = Infinity;
      let blurPoolBalance = Infinity;

      if (gondiCtx) {
        try {
          wethBalance = await getWethBalanceEth(gondiCtx);
          log("💰", `WETH balance: ${wethBalance.toFixed(4)} ETH`);
        } catch {
          log("⚠️ ", "Could not fetch WETH balance — skipping balance checks for Gondi");
        }
      }

      try {
        blurPoolBalance = await getBlurPoolBalanceEth();
        log("💰", `Blur Pool balance: ${blurPoolBalance.toFixed(4)} ETH`);
      } catch {
        log("⚠️ ", "Could not fetch Blur Pool balance — skipping balance checks for Blur");
      }

      for (const offer of offersToSend) {
        if (!offer.offerDetails) continue;

        const { loanAmount, durationDays, competitiveApr, offerType } = offer.offerDetails;
        const t = offerType === "best_apr" ? "T1" : "T2";
        const platform = offer.platform.toUpperCase();

        // Balance check: skip if offer amount > available balance
        if (offer.platform === "gondi" && loanAmount > wethBalance) {
          log("⏭️", `[GONDI] Skip ${t} ${offer.collection}: ${loanAmount.toFixed(3)} ETH > ${wethBalance.toFixed(3)} ETH WETH balance`);
          stats.offersSkipped++;
          continue;
        }
        if (offer.platform === "blur" && loanAmount > blurPoolBalance) {
          log("⏭️", `[BLUR] Skip ${t} ${offer.collection}: ${loanAmount.toFixed(3)} ETH > ${blurPoolBalance.toFixed(3)} ETH Pool balance`);
          stats.offersSkipped++;
          continue;
        }

        log("📤", `[${platform}] Publishing ${t} offer for ${offer.collection}...`);

        try {
          if (offer.platform === "gondi" && gondiCtx) {
            // --- GONDI ---
            const result = await sendGondiCollectionOffer(gondiCtx, {
              slug: offer.collection,
              amountEth: loanAmount,
              aprPercent: competitiveApr * 100,
              durationDays,
            });

            if (result.success) {
              log("✅", `[GONDI] ${t} offer published for ${offer.collection} (ID: ${result.offerId})`);
              stats.offersPublished++;
            } else {
              console.error(`  ❌ [GONDI] Failed: ${result.error}`);
              stats.errors++;
              await sendTelegramMessage(`<b>❌ GONDI ERROR</b>\n${offer.collection}: ${result.error}`);
            }

          } else if (offer.platform === "blur") {
            // --- BLUR ---
            const collectionAddress = offer.offerDetails.collectionAddress;
            if (!collectionAddress) {
              console.error(`  ❌ [BLUR] No collection address for ${offer.collection}`);
              stats.errors++;
              continue;
            }

            const blurParams: BlurOfferParams = {
              collectionAddress,
              loanAmountEth: loanAmount,
              aprBps: Math.round(competitiveApr * 10000),
              expirationMinutes: 30,
            };

            const result = await sendBlurOffer(blurParams);

            if (result.success) {
              log("✅", `[BLUR] ${t} offer published for ${offer.collection} (${result.offerHash})`);
              stats.offersPublished++;
            } else {
              console.error(`  ❌ [BLUR] Failed: ${result.error}`);
              stats.errors++;
              await sendTelegramMessage(`<b>❌ BLUR ERROR</b>\n${offer.collection}: ${result.error}`);
            }

          } else {
            log("⚠️ ", `Unknown platform: ${offer.platform} for ${offer.collection}`);
            stats.offersSkipped++;
            continue;
          }
        } catch (error: unknown) {
          const errMsg = error instanceof Error ? error.message : String(error);
          console.error(`  ❌ [${platform}] Failed to publish offer: ${errMsg}`);
          stats.errors++;
          await sendTelegramMessage(`<b>❌ ${platform} ERROR</b>\n${offer.collection}: ${errMsg}`);
        }

        await sleep(2000);
      }
    } else {
      log("ℹ️", "SEND_OFFERS=false, dry-run mode");

      for (const offer of offersToSend) {
        if (!offer.offerDetails) continue;
        const { loanAmount, durationDays, competitiveApr, offerType } = offer.offerDetails;
        const t = offerType === "best_apr" ? "T1" : "T2";
        const platform = offer.platform.toUpperCase();
        console.log(
          `  📋 [${platform}] ${offer.collection} [${t}]: ${loanAmount.toFixed(3)} ETH @ ${(competitiveApr * 100).toFixed(2)}% for ${durationDays}d`
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
    await sendTelegramMessage(`<b>🚨 RISK ALERTS</b>\n${alerts.join("\n")}`);
  }

  // Status logged in console only (Telegram reserved for alerts/errors)
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
 * Exécuté toutes les 30 min. Les offres expirent en 30 min.
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

  // 1b. Syncer les données marché Blur (on-chain)
  await syncBlurMarket();
  await sleep(2000);

  // 2. Tracker les offres acceptées/expirées
  const tracking = await trackLoans();

  // 2b. Check for defaulted loans and liquidate
  let liquidation: LiquidationResult | null = null;
  if (gondiCtx) {
    liquidation = await checkAndLiquidateLoans();
  }

  // 3. Évaluer et publier les offres
  const stats = await executeStrategy();

  // 4. Telegram only on errors or important events (not every cycle)
  const hasErrors = stats.errors > 0;
  const hasLiquidation = liquidation && liquidation.liquidated > 0;
  const hasAcceptedLoans = tracking && tracking.executed > 0;

  if (hasErrors || hasLiquidation || hasAcceptedLoans) {
    const lines: string[] = [`<b>🔄 Cycle #${cycleCount}</b>`];
    if (stats.offersPublished > 0) lines.push(`📤 ${stats.offersPublished} offer(s) published`);
    if (stats.errors > 0) lines.push(`❌ ${stats.errors} error(s)`);
    if (hasAcceptedLoans) lines.push(`✅ ${tracking.executed} loan(s) accepted`);
    if (hasLiquidation) lines.push(`⚠️ ${liquidation!.liquidated} loan(s) liquidated`);
    await sendTelegramMessage(lines.join("\n"));
  }

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

  // Init lending clients (singletons, reused for all offers)
  if (SEND_OFFERS) {
    try {
      gondiCtx = initGondiContext();
      log("✅", "Gondi client initialized");
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`❌ Failed to init Gondi client: ${msg}`);
      console.error("   Gondi offers will not be sent. Check WALLET_PRIVATE_KEY in .env");
    }

    try {
      initBlurWallet();
      log("✅", "Blur wallet initialized");
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`❌ Failed to init Blur wallet: ${msg}`);
      console.error("   Blur offers will not be sent. Check WALLET_PRIVATE_KEY in .env");
    }
  }

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
