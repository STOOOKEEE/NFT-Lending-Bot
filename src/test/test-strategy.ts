/**
 * Test script for Strategy.ts
 *
 * Vérifie que la stratégie peut:
 * 1. Récupérer les prix depuis DB
 * 2. Calculer la volatilité depuis DB
 * 3. Récupérer les meilleures offres Gondi depuis DB
 * 4. Utiliser le LoanPricer pour déterminer si on peut compétir
 * 5. Générer des recommandations d'offres
 */

import "dotenv/config";
import { runStrategy, formatRecommendationShort, getOffersToSend } from "../strategy/Strategy";

async function testStrategy() {
  console.log("🧪 Test Strategy");
  console.log("=".repeat(70));

  // Collections de test
  // Note: Assurez-vous que ces collections ont des données dans:
  // - price_history (prix)
  // - gondi_best_offers (offres)
  const testCollections = [
    "pudgypenguins",
    "azuki",
    "milady",
    "boredapeyachtclub",
  ];

  console.log(`\n📋 Testing with ${testCollections.length} collections:`);
  testCollections.forEach(c => console.log(`   - ${c}`));

  // Exécuter la stratégie
  const report = await runStrategy(testCollections);

  // Afficher le résumé
  console.log(`\n\n${"=".repeat(70)}`);
  console.log("📊 FINAL REPORT");
  console.log("=".repeat(70));

  console.log(`\nTimestamp: ${report.timestamp}`);
  console.log(`\nSummary:`);
  console.log(`  Total collections analyzed: ${report.summary.total}`);
  console.log(`  Offers to send: ${report.summary.shouldSend}`);
  console.log(`  Skipped: ${report.summary.skipped}`);

  // Détail des offres à envoyer
  const offersToSend = getOffersToSend(report);

  if (offersToSend.length > 0) {
    console.log(`\n${"─".repeat(70)}`);
    console.log("✅ OFFERS TO SEND:");
    console.log("─".repeat(70));

    for (const offer of offersToSend) {
      console.log(`\n${formatRecommendationShort(offer)}`);
      if (offer.offerDetails) {
        console.log(`   Reason: ${offer.reason}`);
        console.log(`   LTV: ${(offer.offerDetails.ltv * 100).toFixed(0)}%`);
        console.log(`   Recommended APR: ${(offer.offerDetails.recommendedApr * 100).toFixed(2)}%`);
        console.log(`   Competitive APR: ${(offer.offerDetails.competitiveApr * 100).toFixed(2)}%`);
      }
      if (offer.marketContext) {
        console.log(`   Market: Floor ${offer.marketContext.floorPrice.toFixed(2)} ETH, Vol ${(offer.marketContext.volatility * 100).toFixed(1)}%`);
      }
    }
  } else {
    console.log(`\n⚠️  No competitive offers found`);
  }

  // Détail des collections skipped
  const skipped = report.collections.filter(c => !c.shouldSendOffer);

  if (skipped.length > 0) {
    console.log(`\n${"─".repeat(70)}`);
    console.log("⏭️  SKIPPED:");
    console.log("─".repeat(70));

    for (const skip of skipped) {
      console.log(`\n❌ ${skip.collection}`);
      console.log(`   Reason: ${skip.reason}`);
      if (skip.marketContext) {
        console.log(`   Floor: ${skip.marketContext.floorPrice.toFixed(2)} ETH`);
        console.log(`   Volatility: ${(skip.marketContext.volatility * 100).toFixed(1)}%`);
        console.log(`   Best Market APR: ${(skip.marketContext.bestMarketApr * 100).toFixed(2)}%`);
      }
    }
  }

  console.log(`\n${"=".repeat(70)}`);
  console.log("✅ Test completed");
  console.log("=".repeat(70));
}

testStrategy().catch((error) => {
  console.error("❌ Test failed:", error);
  process.exit(1);
});
