/**
 * get-offers.ts - Récupère les offres de prêt actives sur Gondi
 * 
 * Les offres sont des propositions de prêt faites par des lenders
 * en attente d'être acceptées par des emprunteurs.
 * 
 * Usage:
 *   npm run offers
 *   npm run offers -- --collection pudgy-penguins
 */

import "dotenv/config";
import { sleep } from "../utils/helpers";

// ==================== CONFIG ====================

const GONDI_GRAPHQL_URL = "https://api.gondi.xyz/lending/graphql";

// ==================== TYPES ====================

export const OfferStatus = {
  Active: "ACTIVE",
  Cancelled: "CANCELLED",
  Executed: "EXECUTED",
  Expired: "EXPIRED",
  Inactive: "INACTIVE",
} as const;

export type OfferStatus = typeof OfferStatus[keyof typeof OfferStatus];

export interface Offer {
  id: string;
  offerId: string;
  lenderAddress: string;
  signerAddress: string;
  borrowerAddress?: string;
  principalAmount: string;
  aprBps: string;
  duration: string;
  expirationTime: string;
  fee: string;
  capacity: string;
  consumedCapacity: string;
  status: OfferStatus;
  hidden: boolean;
  createdDate: string;
  currency: {
    symbol: string;
    decimals: number;
    address: string;
  };
  validators: Array<{
    validator: string;
    arguments: string;
  }>;
  nft?: {
    id: string;
    tokenId: string;
    collection?: {
      id: string;
      name: string;
      slug: string;
      contractData?: {
        contractAddress: string;
      };
    };
  };
  collection?: {
    id: string;
    name: string;
    slug: string;
    floorPrice?: {
      amount: string;
      currency: { symbol: string; decimals: number };
    };
  };
}

export interface ListOffersResponse {
  listOffers: {
    totalCount: number;
    pageInfo: {
      hasNextPage: boolean;
      endCursor: string | null;
    };
    edges: Array<{
      node: Offer;
      cursor: string;
    }>;
  };
}

// ==================== GRAPHQL QUERY ====================

const LIST_OFFERS_QUERY = `
  query ListOffers(
    $first: Int
    $after: String
    $statuses: [OfferStatus!]
    $collections: [Int!]
    $slugs: [String!]
    $lenders: [String!]
    $onlySingleNftOffers: Boolean
    $onlyCollectionOffers: Boolean
    $sortBy: [OffersSortInput!]
  ) {
    listOffers(
      first: $first
      after: $after
      statuses: $statuses
      collections: $collections
      slugs: $slugs
      lenders: $lenders
      onlySingleNftOffers: $onlySingleNftOffers
      onlyCollectionOffers: $onlyCollectionOffers
      sortBy: $sortBy
    ) {
      totalCount
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        cursor
        node {
          id
          offerId
          lenderAddress
          signerAddress
          borrowerAddress
          principalAmount
          aprBps
          duration
          expirationTime
          fee
          capacity
          consumedCapacity
          status
          hidden
          createdDate
          currency {
            symbol
            decimals
            address
          }
          validators {
            validator
            arguments
          }
          ... on SingleNFTOffer {
            nft {
              id
              tokenId
              collection {
                id
                name
                slug
                contractData {
                  contractAddress
                }
              }
            }
          }
          ... on CollectionOffer {
            collection {
              id
              name
              slug
            }
          }
        }
      }
    }
  }
`;

// ==================== API CLIENT ====================

async function fetchGraphQL<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const response = await fetch(GONDI_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`GraphQL request failed: ${response.status} ${response.statusText}`);
  }

  const json = await response.json() as { data?: T; errors?: Array<{ message: string }> };

  if (json.errors && json.errors.length > 0) {
    throw new Error(`GraphQL errors: ${json.errors.map(e => e.message).join(", ")}`);
  }

  if (!json.data) {
    throw new Error("No data returned from GraphQL");
  }

  return json.data;
}

// ==================== OFFER FETCHER ====================

export interface ListOffersParams {
  limit?: number;
  cursor?: string | null;
  statuses?: OfferStatus[];
  collections?: number[];
  slugs?: string[];
  lenders?: string[];
  onlySingleNftOffers?: boolean;
  onlyCollectionOffers?: boolean;
}

export async function listOffers(params: ListOffersParams = {}): Promise<{
  offers: Offer[];
  totalCount: number;
  hasNextPage: boolean;
  cursor: string | null;
}> {
  const {
    limit = 50,
    cursor = null,
    statuses,
    collections,
    slugs,
    lenders,
    onlySingleNftOffers,
    onlyCollectionOffers,
  } = params;

  const variables: Record<string, unknown> = {
    first: limit,
    sortBy: [{ field: "CREATED_DATE", order: "DESC" }],
  };

  if (cursor) variables.after = cursor;
  if (statuses && statuses.length > 0) variables.statuses = statuses;
  if (collections && collections.length > 0) variables.collections = collections;
  if (slugs && slugs.length > 0) variables.slugs = slugs;
  if (lenders && lenders.length > 0) variables.lenders = lenders;
  if (onlySingleNftOffers !== undefined) variables.onlySingleNftOffers = onlySingleNftOffers;
  if (onlyCollectionOffers !== undefined) variables.onlyCollectionOffers = onlyCollectionOffers;

  const data = await fetchGraphQL<ListOffersResponse>(LIST_OFFERS_QUERY, variables);

  return {
    offers: data.listOffers.edges.map(edge => ({
      ...edge.node,
      status: normalizeStatus(edge.node.status),
    })),
    totalCount: data.listOffers.totalCount,
    hasNextPage: data.listOffers.pageInfo.hasNextPage,
    cursor: data.listOffers.pageInfo.endCursor,
  };
}

/**
 * Récupère toutes les offres avec pagination automatique
 */
export async function getAllOffers(params: Omit<ListOffersParams, "cursor" | "limit"> = {}): Promise<Offer[]> {
  const allOffers: Offer[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;
  let page = 1;

  console.log("📥 Fetching offers from Gondi...\n");

  while (hasNextPage) {
    const result = await listOffers({ ...params, cursor, limit: 100 });
    allOffers.push(...result.offers);
    hasNextPage = result.hasNextPage;
    cursor = result.cursor;

    console.log(`  Page ${page}: ${result.offers.length} offers (total: ${allOffers.length}/${result.totalCount})`);
    page++;

    // Rate limiting
    await sleep(100);

    // Limite pour éviter de tout récupérer (les offres peuvent être très nombreuses)
    // Set a high limit to fetch all offers (Gondi has max ~50k active offers)
    if (allOffers.length >= 50000) {
      console.log("  ⚠️ Limiting to 50000 offers for memory");
      break;
    }
  }

  return allOffers;
}

// ==================== HELPERS ====================

/**
 * Normalize API status: "OrderStatus.Active" → "ACTIVE"
 * The GraphQL API returns statuses prefixed with "OrderStatus."
 * but our constants (and DB) use the short uppercase form.
 */
export function normalizeStatus(status: string): OfferStatus {
  if (status.startsWith("OrderStatus.")) {
    const short = status.replace("OrderStatus.", "").toUpperCase();
    const valid = Object.values(OfferStatus) as string[];
    if (valid.includes(short)) return short as OfferStatus;
  }
  return status as OfferStatus;
}

function formatAmount(amount: string, decimals: number): string {
  const value = parseFloat(amount) / Math.pow(10, decimals);
  return value.toFixed(4);
}

function formatDuration(seconds: string | number): string {
  const secs = typeof seconds === "string" ? parseInt(seconds) : seconds;
  const days = Math.floor(secs / 86400);
  return `${days}d`;
}

function formatDate(isoString: string): string {
  return new Date(isoString).toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function isExpired(expirationTime: string): boolean {
  return new Date(expirationTime) < new Date();
}

function calculateLTV(principalAmount: string, floorPrice: string, decimals: number): number {
  const principal = parseFloat(principalAmount) / Math.pow(10, decimals);
  const floor = parseFloat(floorPrice) / Math.pow(10, decimals);
  return floor > 0 ? (principal / floor) * 100 : 0;
}

// ==================== DISPLAY ====================

export function displayOffers(offers: Offer[]): void {
  console.log("\n" + "=".repeat(120));
  console.log("📋 GONDI ACTIVE OFFERS REPORT");
  console.log("=".repeat(120) + "\n");

  if (offers.length === 0) {
    console.log("No offers found.\n");
    return;
  }

  // Séparer les offres par type
  const collectionOffers = offers.filter(o => o.collection && !o.nft);
  const singleNftOffers = offers.filter(o => o.nft);

  // Statistiques globales
  const totalPrincipal = offers.reduce((sum, o) => {
    return sum + parseFloat(o.principalAmount) / Math.pow(10, o.currency.decimals);
  }, 0);

  const avgApr = offers.reduce((sum, o) => sum + parseInt(o.aprBps), 0) / offers.length / 100;

  console.log("📈 SUMMARY:");
  console.log("-".repeat(60));
  console.log(`  Total Offers:          ${offers.length}`);
  console.log(`  Collection Offers:     ${collectionOffers.length}`);
  console.log(`  Single NFT Offers:     ${singleNftOffers.length}`);
  console.log(`  Total Available:       ${totalPrincipal.toFixed(2)} ETH`);
  console.log(`  Average APR:           ${avgApr.toFixed(2)}%`);
  console.log("-".repeat(60) + "\n");

  // Top Collection Offers
  if (collectionOffers.length > 0) {
    console.log("🏆 TOP COLLECTION OFFERS (by principal):");
    console.log("-".repeat(120));
    console.log(
      "Collection".padEnd(30) +
      "Principal".padEnd(15) +
      "APR".padEnd(10) +
      "Duration".padEnd(10) +
      "LTV".padEnd(10) +
      "Capacity".padEnd(15) +
      "Expires"
    );
    console.log("-".repeat(120));

    // Trier par principal décroissant
    const sortedOffers = [...collectionOffers]
      .sort((a, b) => parseFloat(b.principalAmount) - parseFloat(a.principalAmount))
      .slice(0, 30);

    for (const offer of sortedOffers) {
      const collectionName = offer.collection?.name || "Unknown";
      const principal = formatAmount(offer.principalAmount, offer.currency.decimals);
      const symbol = offer.currency.symbol;
      const apr = (parseInt(offer.aprBps) / 100).toFixed(2);
      const duration = formatDuration(offer.duration);
      
      // Calculer LTV si floor price disponible
      let ltv = "N/A";
      if (offer.collection?.floorPrice) {
        const ltvValue = calculateLTV(
          offer.principalAmount,
          offer.collection.floorPrice.amount,
          offer.currency.decimals
        );
        ltv = `${ltvValue.toFixed(1)}%`;
      }

      const capacity = `${offer.consumedCapacity}/${offer.capacity}`;
      const expires = formatDate(offer.expirationTime);
      const expired = isExpired(offer.expirationTime) ? " ⚠️" : "";

      console.log(
        collectionName.slice(0, 29).padEnd(30) +
        `${principal} ${symbol}`.padEnd(15) +
        `${apr}%`.padEnd(10) +
        duration.padEnd(10) +
        ltv.padEnd(10) +
        capacity.padEnd(15) +
        expires + expired
      );
    }
    console.log("-".repeat(120) + "\n");
  }

  // Grouper par collection ET par devise
  const byCollectionCurrency = new Map<string, Offer[]>();
  for (const offer of collectionOffers) {
    const name = offer.collection?.name || "Unknown";
    const currency = offer.currency.symbol;
    const key = `${name}|${currency}`;
    if (!byCollectionCurrency.has(key)) byCollectionCurrency.set(key, []);
    byCollectionCurrency.get(key)!.push(offer);
  }

  // Afficher les meilleures offres par collection (une ligne par collection/devise)
  console.log("📚 BEST OFFERS BY COLLECTION:");
  console.log("-".repeat(90));
  console.log(
    "Collection".padEnd(35) +
    "Currency".padEnd(10) +
    "# Offers".padEnd(10) +
    "Best APR".padEnd(12) +
    "Max Principal".padEnd(20)
  );
  console.log("-".repeat(90));

  // Trouver le meilleur offre par collection (tous devises confondues) pour le tri
  const collectionBest = new Map<string, { maxPrincipalETH: number, offers: Array<{currency: string, count: number, bestApr: number, maxPrincipal: number}> }>();
  
  for (const [key, collOffers] of byCollectionCurrency.entries()) {
    const [collection, currency] = key.split("|");
    const bestApr = Math.min(...collOffers.map(o => parseInt(o.aprBps))) / 100;
    const maxPrincipal = Math.max(...collOffers.map(o => 
      parseFloat(o.principalAmount) / Math.pow(10, o.currency.decimals)
    ));
    
    // Approximate ETH conversion for display sorting only (not used in pricing)
    const ethEquivalent = currency === "USDC" ? maxPrincipal / 3000 : maxPrincipal;
    
    if (!collectionBest.has(collection)) {
      collectionBest.set(collection, { maxPrincipalETH: 0, offers: [] });
    }
    const entry = collectionBest.get(collection)!;
    entry.offers.push({ currency, count: collOffers.length, bestApr, maxPrincipal });
    entry.maxPrincipalETH = Math.max(entry.maxPrincipalETH, ethEquivalent);
  }

  // Trier par max principal ETH équivalent
  const sortedCollections = Array.from(collectionBest.entries())
    .sort((a, b) => b[1].maxPrincipalETH - a[1].maxPrincipalETH)
    .slice(0, 30);

  for (const [collection, data] of sortedCollections) {
    // Afficher la meilleure devise (principal le plus élevé en ETH equivalent)
    const bestOffer = data.offers.sort((a, b) => {
      const aETH = a.currency === "USDC" ? a.maxPrincipal / 3000 : a.maxPrincipal;
      const bETH = b.currency === "USDC" ? b.maxPrincipal / 3000 : b.maxPrincipal;
      return bETH - aETH;
    })[0];
    
    const totalOffers = data.offers.reduce((sum, o) => sum + o.count, 0);
    
    console.log(
      collection.slice(0, 34).padEnd(35) +
      bestOffer.currency.padEnd(10) +
      totalOffers.toString().padEnd(10) +
      `${bestOffer.bestApr.toFixed(2)}%`.padEnd(12) +
      `${bestOffer.maxPrincipal.toFixed(4)} ${bestOffer.currency}`
    );
  }
  console.log("-".repeat(90) + "\n");

  // APR Distribution
  console.log("📊 APR DISTRIBUTION:");
  console.log("-".repeat(50));
  const aprRanges = [
    { min: 0, max: 10, label: "0-10%" },
    { min: 10, max: 20, label: "10-20%" },
    { min: 20, max: 30, label: "20-30%" },
    { min: 30, max: 50, label: "30-50%" },
    { min: 50, max: 100, label: "50-100%" },
    { min: 100, max: Infinity, label: "100%+" },
  ];

  for (const range of aprRanges) {
    const count = offers.filter(o => {
      const apr = parseInt(o.aprBps) / 100;
      return apr >= range.min && apr < range.max;
    }).length;
    const bar = "█".repeat(Math.ceil(count / offers.length * 50));
    console.log(`  ${range.label.padEnd(10)} : ${count.toString().padEnd(6)} ${bar}`);
  }
  console.log("-".repeat(50) + "\n");
}

// ==================== MAIN ====================

async function main() {
  const args = process.argv.slice(2);
  
  let collectionSlug: string | undefined;
  let onlyCollection = false;
  let onlySingleNft = false;

  // Parse arguments
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--collection" && args[i + 1]) {
      collectionSlug = args[i + 1];
      i++;
    }
    if (args[i] === "--collection-offers") {
      onlyCollection = true;
    }
    if (args[i] === "--single-nft") {
      onlySingleNft = true;
    }
  }

  console.log("\n🚀 Gondi Active Offers Fetcher");
  console.log("=".repeat(50));
  console.log(`📅 Date: ${new Date().toLocaleString()}`);
  if (collectionSlug) console.log(`📦 Collection: ${collectionSlug}`);
  if (onlyCollection) console.log(`🔍 Filter: Collection offers only`);
  if (onlySingleNft) console.log(`🔍 Filter: Single NFT offers only`);
  console.log("=".repeat(50) + "\n");

  try {
    // Fetch active offers
    const offers = await getAllOffers({
      statuses: [OfferStatus.Active],
      slugs: collectionSlug ? [collectionSlug] : undefined,
      onlyCollectionOffers: onlyCollection || undefined,
      onlySingleNftOffers: onlySingleNft || undefined,
    });

    // Display results
    displayOffers(offers);

    console.log(`\n✅ Total: ${offers.length} active offers found\n`);

  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("❌ Error:", msg);
    process.exit(1);
  }
}

const isStandalone = require.main === module;
if (isStandalone) {
  main();
}
