/**
 * run-collector.ts - Lance le Price Collector
 * 
 * Usage:
 *   npm run collector
 */

import "dotenv/config";
import { PriceFetcher } from "./collectors/price-fetcher";
import { savePriceToDb } from "./utils/price-db";
import { calculateAllVolatilities } from "./engines/volatility";

// Collections à tracker (slugs OpenSea)
const COLLECTIONS = [
  { slug: "pudgypenguins", name: "Pudgy Penguins" },
  { slug: "boredapeyachtclub", name: "BAYC" },
  { slug: "mutant-ape-yacht-club", name: "MAYC" },
  { slug: "azuki", name: "Azuki" },
  { slug: "clonex", name: "CloneX" },
  { slug: "otherdeed", name: "Otherdeed" },
];

const UPDATE_INTERVAL_MS = 60 * 1000;     // 1 minute
const STATUS_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const USE_SUPABASE = !!process.env.SUPABASE_URL && !!process.env.SUPABASE_ANON_KEY;

async function main() {
  console.log("🚀 Starting NFT Price Collector (OpenSea)");
  console.log(`📊 Tracking ${COLLECTIONS.length} collections`);
  console.log(`⏱️ Update interval: ${UPDATE_INTERVAL_MS / 1000}s`);
  console.log(`💾 Supabase storage: ${USE_SUPABASE ? "✅ Enabled" : "❌ Disabled (in-memory only)"}\n`);

  const apiKey = process.env.OPENSEA_API_KEY || "";
  if (!apiKey) {
    console.error("❌ OPENSEA_API_KEY is required!");
    console.error("   Get your API key at: https://opensea.io/account/settings");
    process.exit(1);
  }
  console.log("🔑 OpenSea API key found\n");

  const fetcher = new PriceFetcher({
    openseaApiKey: apiKey,
  });

  async function updatePrices() {
    console.log(`\n[${new Date().toLocaleTimeString()}] Updating prices...`);
    
    for (const col of COLLECTIONS) {
      try {
        const price = await fetcher.fetchPrice(col.slug);
        
        if (USE_SUPABASE) {
          await savePriceToDb({
            collection_slug: col.slug,
            floor_price: price.floorPrice,
            top_bid: price.topBid,
            mid_price: price.midPrice,
            spread: price.spread,
          });
        }
        
        const floorStr = price.floorPrice.toFixed(3);
        const bidStr = price.topBid.toFixed(3);
        const midStr = price.midPrice.toFixed(3);
        const spreadStr = price.spread.toFixed(1);
        
        console.log(`  ${col.name.padEnd(20)} | Floor: ${floorStr} | Bid: ${bidStr} | Mid: ${midStr} | Spread: ${spreadStr}%`);
        
        await sleep(300);
      } catch (error: any) {
        console.error(`  ❌ ${col.name}: ${error.message}`);
      }
    }
  }

  function printStatus() {
    console.log("\n" + "=".repeat(80));
    console.log("📈 STATUS REPORT - " + new Date().toLocaleString());
    console.log("=".repeat(80));

    for (const col of COLLECTIONS) {
      const latest = fetcher.getLatestPrice(col.slug);
      const dailyPrices = fetcher.getDailyPrices(col.slug);
      
      let volStr = "N/A";
      if (dailyPrices.length >= 3) {
        const vol = calculateAllVolatilities(dailyPrices);
        volStr = `${(vol.annualized * 100).toFixed(1)}%`;
      }

      const floorStr = latest?.floorPrice.toFixed(3) || "N/A";
      const bidStr = latest?.topBid.toFixed(3) || "N/A";
      const midStr = latest?.midPrice.toFixed(3) || "N/A";
      const points = fetcher.getHistory(col.slug).length;

      console.log(`${col.name.padEnd(20)} | Floor: ${floorStr.padEnd(8)} | Bid: ${bidStr.padEnd(8)} | Mid: ${midStr.padEnd(8)} | Vol: ${volStr.padEnd(8)} | Points: ${points}`);
    }

    console.log("=".repeat(80) + "\n");
  }

  await updatePrices();
  setInterval(updatePrices, UPDATE_INTERVAL_MS);
  setInterval(printStatus, STATUS_INTERVAL_MS);
  setTimeout(printStatus, 10000);

  process.on("SIGINT", () => {
    console.log("\n⏹️ Stopping collector...");
    process.exit(0);
  });

  console.log("\n✅ Collector running. Press Ctrl+C to stop.\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error("❌ Fatal error:", error);
  process.exit(1);
});
