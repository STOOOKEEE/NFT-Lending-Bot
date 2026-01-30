/**
 * test-volatility.ts - Script pour calculer et afficher la volatilité
 * 
 * Usage:
 *   npm run volatility
 *   npm run volatility -- pudgypenguins
 *   npm run volatility -- pudgypenguins 7
 */

import "dotenv/config";
import { calculateVolatilitiesFromDb } from "./engines/volatility";

const DEFAULT_COLLECTIONS = [
  "pudgypenguins",
  "boredapeyachtclub",
  "mutant-ape-yacht-club",
  "azuki",
  "clonex",
  "otherdeed",
];

async function main() {
  const args = process.argv.slice(2);
  
  let collections = DEFAULT_COLLECTIONS;
  let days = 30;
  
  if (args.length > 0) {
    collections = [args[0]];
    if (args.length > 1) {
      days = parseInt(args[1], 10);
    }
  }
  
  console.log("\n📊 NFT Volatility Calculator");
  console.log("=".repeat(80));
  console.log(`📅 Period: last ${days} days`);
  console.log("=".repeat(80) + "\n");
  
  try {
    const vols = await calculateVolatilitiesFromDb(collections, days);
    
    for (const [slug, vol] of vols.entries()) {
      const daily = (vol.daily * 100).toFixed(2);
      const ewma = (vol.ewma * 100).toFixed(2);
      const rolling = (vol.rolling30d * 100).toFixed(2);
      const annualized = (vol.annualized * 100).toFixed(2);
      
      console.log(`📈 ${slug.toUpperCase()}`);
      console.log(`   Daily Volatility:       ${daily}%`);
      console.log(`   EWMA Volatility:        ${ewma}%`);
      console.log(`   Rolling 30d Volatility: ${rolling}%`);
      console.log(`   Annualized Volatility:  ${annualized}% ← Use for Black-Scholes\n`);
    }
    
    console.log("=".repeat(80));
    console.log("✅ Volatility calculation complete\n");
    
  } catch (error: any) {
    console.error("❌ Error:", error.message);
    process.exit(1);
  }
}

main();
