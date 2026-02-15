/**
 * sync-offers.ts - Synchronise les meilleures offres Gondi avec Supabase
 * 
 * Pour chaque collection + durée, on stocke:
 * - Meilleure offre par PRINCIPAL (le plus haut collatéral)
 * - Meilleure offre par APR (le taux le plus bas)
 * 
 * Usage:
 *   npm run sync              # Sync une fois
 *   npm run sync -- --loop    # Sync en boucle (toutes les 5 min)
 */

import "dotenv/config";
import { getAllOffers as fetchAllOffers, Offer, OfferStatus } from "./collectors/gondi-fetcher";
import { replaceAllOffers, getStats, BestOfferRecord } from "./utils/gondi-db";
import { getDurationBucket, toETHEquivalent, getEthUsdPrice } from "./utils/helpers";

// ==================== CONFIG ====================

const SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// ==================== HELPERS ====================

function timestampToISODate(timestamp: string): string {
  const num = parseInt(timestamp);
  if (!isNaN(num) && num > 1000000000) {
    return new Date(num * 1000).toISOString();
  }
  return new Date(timestamp).toISOString();
}

// ==================== MAIN LOGIC ====================

async function findBestOffersPerCollectionDuration(offers: Offer[]): Promise<BestOfferRecord[]> {
  const ethUsdPrice = await getEthUsdPrice();
  const collectionOffers = offers.filter(o => o.collection && !o.nft);
  
  // Grouper par collection + duration bucket
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
    
    // === Trouver la meilleure par Principal (en ETH équivalent) ===
    let bestByPrincipal: Offer | null = null;
    let bestPrincipalETH = -Infinity;
    
    // === Trouver la meilleure par APR (le plus bas) ===
    let bestByApr: Offer | null = null;
    let lowestApr = Infinity;

    for (const offer of groupOffers) {
      const principal = parseFloat(offer.principalAmount) / Math.pow(10, offer.currency.decimals);
      const principalETH = toETHEquivalent(principal, offer.currency.symbol, ethUsdPrice);
      const apr = parseInt(offer.aprBps) / 100;

      // Best Principal
      if (principalETH > bestPrincipalETH) {
        bestPrincipalETH = principalETH;
        bestByPrincipal = offer;
      }

      // Best APR
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
        // Best by Principal
        best_principal_amount: p1,
        best_principal_currency: bestByPrincipal.currency.symbol,
        best_principal_apr: parseInt(bestByPrincipal.aprBps) / 100,
        best_principal_offer_id: bestByPrincipal.offerId,
        best_principal_lender: bestByPrincipal.lenderAddress,
        best_principal_expiration: timestampToISODate(bestByPrincipal.expirationTime),
        // Best by APR
        best_apr_amount: p2,
        best_apr_currency: bestByApr.currency.symbol,
        best_apr_percent: parseInt(bestByApr.aprBps) / 100,
        best_apr_offer_id: bestByApr.offerId,
        best_apr_lender: bestByApr.lenderAddress,
        best_apr_expiration: timestampToISODate(bestByApr.expirationTime),
      });
    }
  }

  return results.sort((a, b) => 
    a.collection_name.localeCompare(b.collection_name) || a.duration_days - b.duration_days
  );
}

// ==================== DISPLAY ====================

function displayResults(records: BestOfferRecord[]): void {
  console.log("\n" + "=".repeat(150));
  console.log("🏆 BEST OFFERS BY COLLECTION & DURATION");
  console.log("=".repeat(150));
  
  console.log("\n" + 
    "Collection".padEnd(32) +
    "Duration".padEnd(10) +
    "| BEST PRINCIPAL (highest)".padEnd(40) +
    "| BEST APR (lowest)".padEnd(40)
  );
  console.log("-".repeat(150));

  // Grouper par collection pour affichage
  const byCollection = new Map<string, BestOfferRecord[]>();
  for (const r of records) {
    if (!byCollection.has(r.collection_name)) byCollection.set(r.collection_name, []);
    byCollection.get(r.collection_name)!.push(r);
  }

  let displayCount = 0;
  for (const [collection, recs] of Array.from(byCollection.entries()).slice(0, 30)) {
    for (const r of recs.sort((a, b) => a.duration_days - b.duration_days)) {
      const principalStr = `${r.best_principal_amount.toFixed(2)} ${r.best_principal_currency} @${r.best_principal_apr}%`;
      const aprStr = `${r.best_apr_amount.toFixed(2)} ${r.best_apr_currency} @${r.best_apr_percent}%`;
      
      console.log(
        collection.slice(0, 31).padEnd(32) +
        `${r.duration_days}d`.padEnd(10) +
        `| ${principalStr}`.padEnd(40) +
        `| ${aprStr}`.padEnd(40)
      );
      displayCount++;
    }
  }
  
  console.log("-".repeat(150));
  console.log(`\n📊 Displayed ${displayCount} entries from ${byCollection.size} collections\n`);
}

// ==================== SYNC ====================

async function syncOffers(): Promise<void> {
  console.log("\n" + "=".repeat(60));
  console.log("🔄 SYNCING GONDI OFFERS TO SUPABASE");
  console.log("=".repeat(60));
  console.log(`📅 ${new Date().toLocaleString()}\n`);

  try {
    // 1. Récupérer les offres
    console.log("📥 Fetching active offers from Gondi...");
    const offers = await fetchAllOffers({
      statuses: [OfferStatus.Active],
      onlyCollectionOffers: true,
    });
    console.log(`   Found: ${offers.length} active collection offers\n`);

    // 2. Trouver les meilleures par collection + durée
    console.log("🎯 Finding best offers per collection & duration...");
    const bestOffers = await findBestOffersPerCollectionDuration(offers);
    console.log(`   Records: ${bestOffers.length} (collection × duration combinations)\n`);

    // 3. Afficher les résultats
    displayResults(bestOffers);

    // 4. Sauvegarder dans Supabase
    console.log("💾 Saving to Supabase...");
    const result = await replaceAllOffers(bestOffers);
    console.log(`   Success: ${result.success}`);
    console.log(`   Failed: ${result.failed}\n`);

    // 5. Stats
    const stats = await getStats();
    console.log("📊 Database Stats:");
    console.log(`   Total records: ${stats.total}`);
    console.log(`   Unique collections: ${stats.collections}`);
    console.log(`   Durations: ${stats.durations.map(d => `${d}d`).join(", ")}`);

    console.log("\n✅ Sync completed!\n");

  } catch (error: unknown) {
    console.error("❌ Sync failed:", error instanceof Error ? error.message : String(error));
  }
}

// ==================== MAIN ====================

async function main() {
  const args = process.argv.slice(2);
  const loopMode = args.includes("--loop");

  console.log("\n🚀 Gondi Offers Sync v2");
  console.log("=".repeat(50));
  console.log(`📅 Started: ${new Date().toLocaleString()}`);
  console.log(`📋 Format: Best Principal + Best APR per Duration`);
  console.log(`⏱️  Durations: 5d, 7d, 10d, 15d, 30d, 60d, 90d, 120d`);
  if (loopMode) console.log(`🔄 Loop Mode: every ${SYNC_INTERVAL_MS / 60000} minutes`);
  console.log("=".repeat(50));

  if (loopMode) {
    while (true) {
      await syncOffers();
      console.log(`⏳ Next sync in ${SYNC_INTERVAL_MS / 60000} minutes...\n`);
      await new Promise(resolve => setTimeout(resolve, SYNC_INTERVAL_MS));
    }
  } else {
    await syncOffers();
  }
}

main().catch(console.error);
