/**
 * Test Supabase connection and data saving
 */

import "dotenv/config";
import { PriceFetcher } from "../collectors/price-fetcher";
import { savePriceToDb, getLatestFloorPrice, PriceRecord } from "../utils/price-db";

async function testSupabase() {
  console.log("🧪 Test Supabase Connection");
  console.log("=".repeat(60));

  // Initialize price fetcher
  const priceFetcher = new PriceFetcher({
    openseaApiKey: process.env.OPENSEA_API_KEY!,
  });

  // Test 1: Collecte et sauvegarde de prix
  const slug = "pudgypenguins";
  console.log(`\n📊 Test 1: Collecte prix pour ${slug}...`);

  const priceData = await priceFetcher.fetchPrice(slug);

  const price: PriceRecord = {
    collection_slug: priceData.collection,
    floor_price: priceData.floorPrice,
    top_bid: priceData.topBid,
    mid_price: priceData.midPrice,
    spread: priceData.spread,
  };

  if (price) {
    console.log(`✅ Prix récupéré:`);
    console.log(`   Floor: ${price.floor_price} ETH`);
    console.log(`   Top Bid: ${price.top_bid} ETH`);
    console.log(`   Mid: ${price.mid_price} ETH`);

    console.log(`\n💾 Sauvegarde dans Supabase...`);
    await savePriceToDb(price);
    console.log(`✅ Prix sauvegardé dans price_history!`);
  } else {
    console.log("❌ Impossible de récupérer le prix");
    return;
  }

  // Test 2: Récupération depuis la DB
  console.log(`\n📊 Test 2: Récupération depuis DB...`);
  const latestPrice = await getLatestFloorPrice(slug);

  if (latestPrice) {
    console.log(`✅ Prix récupéré depuis DB:`);
    console.log(`   Floor: ${latestPrice.floor} ETH`);
    console.log(`   Bid: ${latestPrice.bid} ETH`);
    console.log(`   Mid: ${latestPrice.mid} ETH`);
  } else {
    console.log("❌ Impossible de récupérer depuis DB");
  }

  // Test 3: Test avec plusieurs collections
  console.log(`\n📊 Test 3: Test avec 3 collections...`);
  const collections = ["azuki", "milady", "boredapeyachtclub"];

  for (const col of collections) {
    try {
      console.log(`\n   ${col}:`);
      const priceData = await priceFetcher.fetchPrice(col);
      const priceRecord: PriceRecord = {
        collection_slug: priceData.collection,
        floor_price: priceData.floorPrice,
        top_bid: priceData.topBid,
        mid_price: priceData.midPrice,
        spread: priceData.spread,
      };
      await savePriceToDb(priceRecord);
      console.log(`   ✅ Floor: ${priceRecord.floor_price} ETH - Saved to DB`);
    } catch (error: any) {
      console.log(`   ❌ Error: ${error.message}`);
    }
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log("✅ Tests Supabase terminés!");
}

testSupabase().catch((error) => {
  console.error("❌ Test failed:", error);
  process.exit(1);
});
