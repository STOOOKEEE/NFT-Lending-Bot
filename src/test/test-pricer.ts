/**
 * Test script for LoanPricer
 * Uses real floor prices and volatility from database
 */

import "dotenv/config";
import { getLatestFloorPrice } from "../utils/price-db";
import { calculateVolatilityFromDb } from "../engines/volatility";
import {
  priceLoan,
  priceMultipleDurations,
  GONDI_DURATIONS,
  type MarketData,
  type PricingConfig,
} from "../engines/LoanPricer";

// Collections à tester
const TEST_COLLECTIONS = [
  { slug: "boredapeyachtclub", name: "BAYC" },
  { slug: "pudgypenguins", name: "Pudgy Penguins" },
  { slug: "azuki", name: "Azuki" },
  { slug: "milady", name: "Milady" },
];

// Configuration personnalisée (optionnelle)
const CUSTOM_CONFIG: PricingConfig = {
  riskFreeRate: 0.07,        // 7% (ETH looping yield)
  liquidityPremium: 0.05,    // 5% prime d'illiquidité
  safetyMultiplier: 1.3,     // 30% marge sur volatilité
  minSpreadBelowBest: 0.02,  // 2% sous meilleure offre
};

async function testPricerForCollection(collectionSlug: string, collectionName: string) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`🎯 Testing: ${collectionName} (${collectionSlug})`);
  console.log("=".repeat(60));

  try {
    // 1. Récupérer le floor price
    const latestPrice = await getLatestFloorPrice(collectionSlug);
    if (!latestPrice) {
      console.log(`❌ No price data for ${collectionSlug}`);
      return;
    }

    const floorPrice = latestPrice.mid;
    console.log(`\n📊 Floor Price: ${floorPrice.toFixed(4)} ETH`);

    // 2. Calculer la volatilité (30 jours)
    const volatilityData = await calculateVolatilityFromDb(collectionSlug, 30);

    if (!volatilityData || volatilityData.daily === 0) {
      console.log(`❌ No volatility data for ${collectionSlug}`);
      return;
    }

    console.log(`📈 Volatility (30d): ${(volatilityData.rolling30d * 100).toFixed(2)}%`);
    console.log(`📈 Volatility (annualized): ${(volatilityData.annualized * 100).toFixed(2)}%`);

    // 3. Construire les données de marché
    const marketData: MarketData = {
      floorPrice: floorPrice,
      middlePrice: floorPrice,  // Approximation
      topBid: floorPrice * 0.95, // Approximation: 5% sous le floor
      volatility: volatilityData.rolling30d,
      volatilityPeriodDays: 30,
    };

    // 4. Tester avec différents LTV
    const ltvTests = [0.3, 0.4, 0.5, 0.6]; // 30%, 40%, 50%, 60%

    for (const ltv of ltvTests) {
      const loanAmount = floorPrice * ltv;

      console.log(`\n${"─".repeat(60)}`);
      console.log(`💰 Testing LTV ${(ltv * 100).toFixed(0)}% (Loan: ${loanAmount.toFixed(4)} ETH)`);
      console.log("─".repeat(60));

      // Tester une durée unique (30 jours) pour commencer
      const result = priceLoan(marketData, loanAmount, 30, CUSTOM_CONFIG);

      console.log(`\nViability: ${result.isViable ? "✅ VIABLE" : "❌ NOT VIABLE"}`);
      console.log(`\n📊 Pricing:`);
      console.log(`   Min APR:         ${(result.minApr * 100).toFixed(2)}%`);
      console.log(`   Recommended APR: ${(result.recommendedApr * 100).toFixed(2)}%`);
      console.log(`\n💰 Financials:`);
      console.log(`   Put Premium:     ${result.putPremium.toFixed(4)} ETH`);
      console.log(`   Expected Profit: ${result.expectedProfit.toFixed(4)} ETH`);
      console.log(`   Max Loss:        ${result.maxLoss.toFixed(4)} ETH`);
      console.log(`   Break-even Floor: ${result.breakEvenFloor.toFixed(4)} ETH`);
      console.log(`\n⚠️  Risk Score: ${result.riskScore}/100`);
    }

    // 5. Tester toutes les durées pour LTV 40%
    console.log(`\n${"═".repeat(60)}`);
    console.log(`📅 Multi-Duration Pricing (LTV 40%)`);
    console.log("═".repeat(60));

    const loanAmount = floorPrice * 0.4;
    const multiDuration = priceMultipleDurations(
      marketData,
      loanAmount,
      collectionName,
      GONDI_DURATIONS,
      CUSTOM_CONFIG
    );

    console.log(`\n🎯 Best Duration: ${multiDuration.bestDuration ? multiDuration.bestDuration + " days" : "None"}`);
    console.log(`\nAll Durations:`);

    for (const { days, pricing } of multiDuration.durations) {
      const symbol = pricing.isViable ? "✅" : "❌";
      const marker = days === multiDuration.bestDuration ? "⭐" : "  ";
      console.log(
        `${marker} ${symbol} ${days}d: ` +
        `APR ${(pricing.recommendedApr * 100).toFixed(2)}% | ` +
        `Risk ${pricing.riskScore}/100 | ` +
        `Profit ${pricing.expectedProfit.toFixed(4)} ETH`
      );
    }

  } catch (error: any) {
    console.error(`❌ Error testing ${collectionSlug}:`, error.message);
  }
}

async function main() {
  console.log("🚀 NFT Loan Pricer Test");
  console.log("=".repeat(60));
  console.log(`Using config:`);
  console.log(`  Risk-free rate: ${(CUSTOM_CONFIG.riskFreeRate * 100).toFixed(1)}%`);
  console.log(`  Liquidity premium: ${(CUSTOM_CONFIG.liquidityPremium * 100).toFixed(1)}%`);
  console.log(`  Safety multiplier: ${CUSTOM_CONFIG.safetyMultiplier}x`);
  console.log(`  Min spread below best: ${(CUSTOM_CONFIG.minSpreadBelowBest * 100).toFixed(1)}%`);

  for (const collection of TEST_COLLECTIONS) {
    await testPricerForCollection(collection.slug, collection.name);
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log("✅ Test completed");
  console.log("=".repeat(60));
}

main().catch(console.error);