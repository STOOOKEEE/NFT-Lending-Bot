/**
 * test-fee-analysis.ts - Analyze how other lenders set origin fees on Gondi
 *
 * Usage: npx ts-node src/test-fee-analysis.ts
 */

import "dotenv/config";

const GONDI_GRAPHQL_URL = "https://api.gondi.xyz/lending/graphql";

const QUERY = `
  query ListOffers($first: Int, $after: String, $statuses: [OfferStatus!], $onlyCollectionOffers: Boolean) {
    listOffers(first: $first, after: $after, statuses: $statuses, onlyCollectionOffers: $onlyCollectionOffers) {
      totalCount
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          offerId
          lenderAddress
          principalAmount
          aprBps
          duration
          fee
          capacity
          status
          contractAddress
          ... on CollectionOffer {
            collection { id name slug }
          }
        }
      }
    }
  }
`;

interface OfferNode {
  id: string;
  offerId: string;
  lenderAddress: string;
  principalAmount: string;
  aprBps: string;
  duration: string;
  fee: string;
  capacity: string;
  status: string;
  contractAddress: string;
  collection?: { id: string; name: string; slug: string };
}

async function main() {
  console.log("Fetching active collection offers with fee > 0...\n");

  const response = await fetch(GONDI_GRAPHQL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: QUERY,
      variables: {
        first: 100,
        statuses: ["ACTIVE"],
        onlyCollectionOffers: true,
      },
    }),
  });

  const json = await response.json() as {
    data?: { listOffers: { totalCount: number; edges: Array<{ node: OfferNode }> } };
    errors?: Array<{ message: string }>;
  };

  if (json.errors) {
    console.error("GraphQL errors:", json.errors);
    return;
  }

  const offers = json.data?.listOffers.edges.map(e => e.node) || [];
  console.log(`Total offers fetched: ${offers.length}`);

  // Filter offers with non-zero fee
  const withFee = offers.filter(o => o.fee !== "0" && o.fee !== "");
  console.log(`Offers with fee > 0: ${withFee.length}\n`);

  if (withFee.length === 0) {
    console.log("No offers with non-zero fees found. Showing sample of all offers:\n");
    for (const o of offers.slice(0, 10)) {
      const principalEth = Number(o.principalAmount) / 1e18;
      const durationDays = Math.round(Number(o.duration) / 86400);
      console.log(`  ${o.collection?.slug || "?"} | ${principalEth.toFixed(4)} ETH | APR ${Number(o.aprBps)/100}% | ${durationDays}d | fee=${o.fee} | contract=${o.contractAddress} | lender=${o.lenderAddress.slice(0, 10)}...`);
    }
    return;
  }

  console.log("--- Offers with non-zero fees ---\n");
  for (const o of withFee) {
    const principalEth = Number(o.principalAmount) / 1e18;
    const feeNum = Number(o.fee);
    const feeEth = feeNum / 1e18;
    const feePctOfPrincipal = principalEth > 0 ? (feeNum / Number(o.principalAmount)) * 100 : 0;
    const durationDays = Math.round(Number(o.duration) / 86400);

    console.log(`  Collection: ${o.collection?.slug || "unknown"}`);
    console.log(`  Principal:  ${principalEth.toFixed(4)} ETH`);
    console.log(`  APR:        ${Number(o.aprBps) / 100}%`);
    console.log(`  Duration:   ${durationDays}d`);
    console.log(`  Fee raw:    ${o.fee}`);
    console.log(`  Fee as ETH: ${feeEth} ETH`);
    console.log(`  Fee as BPS: ${feeNum} bps (${feeNum / 100}%)`);
    console.log(`  Fee % of principal: ${feePctOfPrincipal.toFixed(4)}%`);
    console.log(`  Contract:   ${o.contractAddress}`);
    console.log(`  Lender:     ${o.lenderAddress}`);
    console.log(`  Capacity:   ${Number(o.capacity) / 1e18} ETH`);
    console.log("");
  }

  // Summary: unique fee values
  const uniqueFees = [...new Set(withFee.map(o => o.fee))].sort((a, b) => Number(a) - Number(b));
  console.log(`Unique fee values: ${uniqueFees.join(", ")}`);

  // Summary: unique contracts
  const uniqueContracts = [...new Set(withFee.map(o => o.contractAddress))];
  console.log(`Contracts used: ${uniqueContracts.join(", ")}`);
}

main().catch((err: unknown) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
