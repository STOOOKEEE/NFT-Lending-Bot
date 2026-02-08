/**
 * compact-price-history.ts - Compacte les vieilles données de prix
 *
 * Stratégie:
 * - Garde les 7 derniers jours en haute fréquence (toutes les 7 min)
 * - Compacte les données plus anciennes en moyennes journalières
 *
 * Usage standalone:
 *   npx ts-node src/compact-price-history.ts
 *   npx ts-node src/compact-price-history.ts --dry-run  # Simulation
 *
 * Usage depuis bot-auto.ts:
 *   import { compactPriceHistory } from "./compact-price-history";
 *   await compactPriceHistory();
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const KEEP_DAYS = 7; // Garder 7 jours en haute fréquence

interface PriceRecord {
  id: number;
  collection_slug: string;
  floor_price: number;
  top_bid: number;
  mid_price: number;
  spread: number;
  timestamp: string;
}

interface DailyAverage {
  collection_slug: string;
  date: string;
  avg_floor: number;
  avg_bid: number;
  avg_mid: number;
  avg_spread: number;
  count: number;
}

export async function compactPriceHistory(dryRun = false): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_ANON_KEY required");
  }

  const supabase = createClient(url, key);

  console.log("\n📦 Compacting Price History");
  console.log("=".repeat(70));
  console.log(`Mode: ${dryRun ? "DRY-RUN (simulation)" : "PRODUCTION"}`);
  console.log(`Keep last ${KEEP_DAYS} days at high frequency`);
  console.log("Compact older data to daily averages\n");

  // 1. Calculer la date limite
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - KEEP_DAYS);
  const cutoffISO = cutoffDate.toISOString();

  console.log(`📅 Cutoff date: ${cutoffDate.toLocaleString()}`);
  console.log(`   Keep: data after ${cutoffISO}`);
  console.log(`   Compact: data before ${cutoffISO}\n`);

  // 2. Récupérer les anciennes données
  console.log("📥 Fetching old data...");
  const { data: oldData, error: fetchError } = await supabase
    .from("price_history")
    .select("*")
    .lt("timestamp", cutoffISO)
    .order("timestamp", { ascending: true });

  if (fetchError) {
    throw new Error(`Fetch error: ${fetchError.message}`);
  }

  if (!oldData || oldData.length === 0) {
    console.log("✅ No old data to compact!");
    return;
  }

  console.log(`   Found: ${oldData.length} records to compact\n`);

  // 3. Grouper par collection + jour
  console.log("📊 Calculating daily averages...");
  const dailyMap = new Map<string, PriceRecord[]>();

  for (const record of oldData) {
    const date = record.timestamp.split("T")[0]; // YYYY-MM-DD
    const key = `${record.collection_slug}|${date}`;

    if (!dailyMap.has(key)) {
      dailyMap.set(key, []);
    }
    dailyMap.get(key)!.push(record as PriceRecord);
  }

  console.log(`   Grouped into ${dailyMap.size} daily buckets\n`);

  // 4. Calculer les moyennes
  const dailyAverages: DailyAverage[] = [];

  for (const [key, records] of dailyMap.entries()) {
    const [collection_slug, date] = key.split("|");

    const avg_floor = records.reduce((sum, r) => sum + r.floor_price, 0) / records.length;
    const avg_bid = records.reduce((sum, r) => sum + r.top_bid, 0) / records.length;
    const avg_mid = records.reduce((sum, r) => sum + r.mid_price, 0) / records.length;
    const avg_spread = records.reduce((sum, r) => sum + r.spread, 0) / records.length;

    dailyAverages.push({
      collection_slug,
      date,
      avg_floor,
      avg_bid,
      avg_mid,
      avg_spread,
      count: records.length,
    });
  }

  // 5. Afficher le résumé
  console.log("📋 Summary:");
  console.log(`   Original records: ${oldData.length}`);
  console.log(`   Daily averages: ${dailyAverages.length}`);
  console.log(`   Reduction: ${((1 - dailyAverages.length / oldData.length) * 100).toFixed(1)}%\n`);

  if (dryRun) {
    console.log("🔍 DRY-RUN MODE - Sample daily averages:\n");
    for (const avg of dailyAverages.slice(0, 5)) {
      console.log(`   ${avg.collection_slug.padEnd(20)} ${avg.date} | Floor: ${avg.avg_floor.toFixed(3)} (${avg.count} records)`);
    }
    console.log(`   ... and ${dailyAverages.length - 5} more\n`);
    console.log("✅ Dry-run completed. Run without --dry-run to apply changes.");
    return;
  }

  // 6. Supprimer les anciennes données
  console.log("🗑️  Deleting old records...");
  const { error: deleteError } = await supabase
    .from("price_history")
    .delete()
    .lt("timestamp", cutoffISO);

  if (deleteError) {
    throw new Error(`Delete error: ${deleteError.message}`);
  }

  console.log(`   ✅ Deleted ${oldData.length} records\n`);

  // 7. Insérer les moyennes journalières
  console.log("📥 Inserting daily averages...");

  const insertRecords = dailyAverages.map(avg => ({
    collection_slug: avg.collection_slug,
    floor_price: avg.avg_floor,
    top_bid: avg.avg_bid,
    mid_price: avg.avg_mid,
    spread: avg.avg_spread,
    timestamp: new Date(`${avg.date}T12:00:00Z`).toISOString(), // Midday UTC
  }));

  // Batch insert (Supabase limite à 1000 par batch)
  const BATCH_SIZE = 1000;
  let inserted = 0;

  for (let i = 0; i < insertRecords.length; i += BATCH_SIZE) {
    const batch = insertRecords.slice(i, i + BATCH_SIZE);

    const { error: insertError } = await supabase
      .from("price_history")
      .insert(batch);

    if (insertError) {
      throw new Error(`Insert error (batch ${i / BATCH_SIZE + 1}): ${insertError.message}`);
    }

    inserted += batch.length;
    console.log(`   Inserted ${inserted}/${insertRecords.length}...`);
  }

  console.log(`   ✅ Inserted ${inserted} daily averages\n`);

  // 8. Vérifier le résultat
  const { data: afterCount } = await supabase
    .from("price_history")
    .select("id", { count: "exact", head: true });

  console.log("=".repeat(70));
  console.log("✅ Compaction completed!");
  console.log(`   Before: ${oldData.length} old records`);
  console.log(`   After: ${dailyAverages.length} daily averages`);
  console.log(`   Total in DB: ${Array.isArray(afterCount) ? afterCount.length : 0}`);
  console.log(`   Space saved: ${((1 - dailyAverages.length / oldData.length) * 100).toFixed(1)}%`);
  console.log("=".repeat(70) + "\n");
}

// Standalone execution: npx ts-node src/compact-price-history.ts [--dry-run]
const isStandalone = require.main === module;
if (isStandalone) {
  const dryRun = process.argv.includes("--dry-run");
  compactPriceHistory(dryRun).catch((error) => {
    console.error("Failed:", error);
    process.exit(1);
  });
}
