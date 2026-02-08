/**
 * Test script for LoanPricer with MOCK data
 * No database required
 */

import {
  priceLoan,
  priceCompetitiveOffer,
  priceMultipleDurations,
  GONDI_DURATIONS,
  type MarketData,
  type BestOffer,
  type PricingConfig,
} from "../engines/LoanPricer";

// Configuration personnalisée
const CUSTOM_CONFIG: PricingConfig = {
  riskFreeRate: 0.07,        // 7% (ETH looping yield)
  liquidityPremium: 0.05,    // 5% prime d'illiquidité
  safetyMultiplier: 1.3,     // 30% marge sur volatilité
  minSpreadBelowBest: 0.02,  // 2% sous meilleure offre
};

// Collections de test avec données simulées
const TEST_COLLECTIONS = [
  {
    name: "BAYC",
    marketData: {
      floorPrice: 15.5,      // 15.5 ETH
      middlePrice: 16.0,
      topBid: 15.0,
      volatility: 0.35,      // 35% volatilité (30 jours)
      volatilityPeriodDays: 30,
    } as MarketData,
  },
  {
    name: "Pudgy Penguins",
    marketData: {
      floorPrice: 8.2,       // 8.2 ETH
      middlePrice: 8.5,
      topBid: 8.0,
      volatility: 0.28,      // 28% volatilité
      volatilityPeriodDays: 30,
    } as MarketData,
  },
  {
    name: "Azuki",
    marketData: {
      floorPrice: 4.5,       // 4.5 ETH
      middlePrice: 4.7,
      topBid: 4.3,
      volatility: 0.42,      // 42% volatilité (plus volatile)
      volatilityPeriodDays: 30,
    } as MarketData,
  },
  {
    name: "Milady",
    marketData: {
      floorPrice: 2.8,       // 2.8 ETH
      middlePrice: 2.9,
      topBid: 2.7,
      volatility: 0.55,      // 55% volatilité (très volatile)
      volatilityPeriodDays: 30,
    } as MarketData,
  },
];

function testPricerForCollection(name: string, marketData: MarketData) {
  console.log(`\n${"=".repeat(70)}`);
  console.log(`🎯 ${name}`);
  console.log("=".repeat(70));

  console.log(`\n📊 Market Data:`);
  console.log(`   Floor Price:   ${marketData.floorPrice.toFixed(4)} ETH`);
  console.log(`   Top Bid:       ${marketData.topBid.toFixed(4)} ETH`);
  console.log(`   Volatility:    ${(marketData.volatility * 100).toFixed(1)}% (${marketData.volatilityPeriodDays}d)`);

  // 1. Tester différents LTV
  const ltvTests = [0.3, 0.4, 0.5, 0.6]; // 30%, 40%, 50%, 60%

  console.log(`\n${"─".repeat(70)}`);
  console.log(`📊 Single Duration Test (30 days)`);
  console.log("─".repeat(70));

  for (const ltv of ltvTests) {
    const loanAmount = marketData.floorPrice * ltv;

    const result = priceLoan(marketData, loanAmount, 30, CUSTOM_CONFIG);

    const symbol = result.isViable ? "✅" : "❌";
    console.log(
      `\n${symbol} LTV ${(ltv * 100).toFixed(0)}% (${loanAmount.toFixed(3)} ETH):`
    );
    console.log(`   Min APR:         ${(result.minApr * 100).toFixed(2)}%`);
    console.log(`   Recommended APR: ${(result.recommendedApr * 100).toFixed(2)}%`);
    console.log(`   Put Premium:     ${result.putPremium.toFixed(4)} ETH`);
    console.log(`   Expected Profit: ${result.expectedProfit.toFixed(4)} ETH`);
    console.log(`   Risk Score:      ${result.riskScore}/100`);
    console.log(`   Break-even:      ${result.breakEvenFloor.toFixed(4)} ETH`);
  }

  // 2. Tester toutes les durées pour LTV 40%
  console.log(`\n${"─".repeat(70)}`);
  console.log(`📅 Multi-Duration Test (LTV 40%)`);
  console.log("─".repeat(70));

  const loanAmount = marketData.floorPrice * 0.4;
  const multiDuration = priceMultipleDurations(
    marketData,
    loanAmount,
    name,
    GONDI_DURATIONS,
    CUSTOM_CONFIG
  );

  console.log(`\nLoan Amount: ${loanAmount.toFixed(4)} ETH`);
  console.log(`Best Duration: ${multiDuration.bestDuration ? multiDuration.bestDuration + " days ⭐" : "None"}\n`);

  for (const { days, pricing } of multiDuration.durations) {
    const symbol = pricing.isViable ? "✅" : "❌";
    const marker = days === multiDuration.bestDuration ? "⭐" : "  ";
    console.log(
      `${marker} ${symbol} ${String(days).padStart(2)}d: ` +
      `APR ${(pricing.recommendedApr * 100).toFixed(2)}% | ` +
      `Profit ${pricing.expectedProfit.toFixed(4)} ETH | ` +
      `Risk ${pricing.riskScore}/100`
    );
  }

  // 3. Test compétitif : se positionner contre la meilleure offre du marché
  console.log(`\n${"─".repeat(70)}`);
  console.log(`🏆 Competitive Pricing Test`);
  console.log("─".repeat(70));

  // Simuler une meilleure offre existante
  const bestOffer: BestOffer = {
    loanAmount: marketData.floorPrice * 0.4,
    apr: 0.45, // 45% APR
    durationDays: 30,
    ltv: 0.4,
  };

  console.log(`\nBest Market Offer: ${(bestOffer.apr * 100).toFixed(2)}% APR`);

  const competitive = priceCompetitiveOffer(marketData, bestOffer, CUSTOM_CONFIG);

  console.log(`\nOur Pricing:`);
  console.log(`   Min APR:          ${(competitive.minApr * 100).toFixed(2)}%`);
  console.log(`   Recommended APR:  ${(competitive.recommendedApr * 100).toFixed(2)}%`);
  console.log(`   Competitive APR:  ${(competitive.competitiveApr * 100).toFixed(2)}%`);
  console.log(`   Can Compete:      ${competitive.canCompete ? "✅ YES" : "❌ NO"}`);
  console.log(`   More Attractive:  ${competitive.vsbestOffer.isMoreAttractive ? "✅ YES" : "❌ NO"}`);
  console.log(`   APR Difference:   ${(competitive.vsbestOffer.aprDiff * 100).toFixed(2)}%`);

  if (competitive.canCompete) {
    const ourProfit = loanAmount * competitive.competitiveApr * (30 / 365);
    console.log(`\n💰 If we compete at ${(competitive.competitiveApr * 100).toFixed(2)}% APR:`);
    console.log(`   Our Profit:       ${ourProfit.toFixed(4)} ETH`);
    console.log(`   Our Margin:       ${((competitive.competitiveApr - competitive.minApr) * 100).toFixed(2)}%`);
  }
}

function main() {
  console.log("🚀 NFT Loan Pricer Test (MOCK DATA)");
  console.log("=".repeat(70));
  console.log(`Configuration:`);
  console.log(`  Risk-free rate:       ${(CUSTOM_CONFIG.riskFreeRate * 100).toFixed(1)}%`);
  console.log(`  Liquidity premium:    ${(CUSTOM_CONFIG.liquidityPremium * 100).toFixed(1)}%`);
  console.log(`  Safety multiplier:    ${CUSTOM_CONFIG.safetyMultiplier}x`);
  console.log(`  Min spread below best: ${(CUSTOM_CONFIG.minSpreadBelowBest * 100).toFixed(1)}%`);

  for (const collection of TEST_COLLECTIONS) {
    testPricerForCollection(collection.name, collection.marketData);
  }

  console.log(`\n${"=".repeat(70)}`);
  console.log("✅ Test completed");
  console.log("=".repeat(70));

  // Résumé des insights
  console.log(`\n📝 Key Insights:`);
  console.log(`\n1. Collections avec volatilité plus élevée nécessitent des APR plus élevés`);
  console.log(`   - BAYC (35% vol) vs Milady (55% vol) → APR min différent`);
  console.log(`\n2. LTV plus élevé → APR plus élevé (plus de risque)`);
  console.log(`   - LTV 30% vs LTV 60% → APR augmente`);
  console.log(`\n3. Durée plus longue → APR peut être plus attractif (spread sur plus de temps)`);
  console.log(`   - Mais aussi plus de risque (volatilité × √temps)`);
  console.log(`\n4. Le pricer peut déterminer si on peut compétir avec le marché`);
  console.log(`   - Si notre min APR > meilleur APR marché → pas compétitif`);
  console.log(`   - Si notre min APR < meilleur APR marché → on peut offrir mieux`);
}

main();