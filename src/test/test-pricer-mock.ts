/** Test LoanPricer with mock data (no DB required) */

import {
  priceLoan,
  GONDI_DURATIONS,
  type MarketData,
  type PricingConfig,
} from "../engines/LoanPricer";

const CUSTOM_CONFIG: PricingConfig = {
  riskFreeRate: 0.07,
  liquidityPremium: 0.05,
  safetyMultiplier: 1.3,
  minSpreadBelowBest: 0.02,
};

const TEST_COLLECTIONS = [
  { name: "BAYC", marketData: { floorPrice: 15.5, middlePrice: 16.0, topBid: 15.0, volatility: 0.35 } as MarketData },
  { name: "Pudgy Penguins", marketData: { floorPrice: 8.2, middlePrice: 8.5, topBid: 8.0, volatility: 0.28 } as MarketData },
  { name: "Azuki", marketData: { floorPrice: 4.5, middlePrice: 4.7, topBid: 4.3, volatility: 0.42 } as MarketData },
  { name: "Milady", marketData: { floorPrice: 2.8, middlePrice: 2.9, topBid: 2.7, volatility: 0.55 } as MarketData },
];

function testCollection(name: string, marketData: MarketData) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`${name} | Floor: ${marketData.floorPrice} ETH | Vol: ${(marketData.volatility * 100).toFixed(0)}%`);
  console.log("=".repeat(60));

  // Test different LTVs at 30 days
  for (const ltv of [0.3, 0.4, 0.5, 0.6]) {
    const loanAmount = marketData.floorPrice * ltv;
    const result = priceLoan(marketData, loanAmount, 30, CUSTOM_CONFIG);
    const icon = result.isViable ? "OK" : "NO";
    console.log(
      `  [${icon}] LTV ${(ltv * 100).toFixed(0)}% (${loanAmount.toFixed(3)} ETH) | ` +
      `APR: ${(result.recommendedApr * 100).toFixed(2)}% | Risk: ${result.riskScore}/100`
    );
  }

  // Test all durations at 40% LTV
  console.log(`\n  Multi-duration (LTV 40%):`);
  const loanAmount = marketData.floorPrice * 0.4;
  for (const days of GONDI_DURATIONS) {
    const result = priceLoan(marketData, loanAmount, days, CUSTOM_CONFIG);
    const icon = result.isViable ? "OK" : "NO";
    console.log(
      `    [${icon}] ${String(days).padStart(2)}d: APR ${(result.recommendedApr * 100).toFixed(2)}% | ` +
      `Profit ${result.expectedProfit.toFixed(4)} ETH | Risk ${result.riskScore}/100`
    );
  }
}

console.log("NFT Loan Pricer Test (MOCK DATA)");
for (const c of TEST_COLLECTIONS) {
  testCollection(c.name, c.marketData);
}
console.log("\nDone.");
