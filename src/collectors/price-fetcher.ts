/**
 * price-fetcher.ts - Récupère les prix NFT via OpenSea API
 * 
 * Features:
 * - Floor price (prix minimum de listing)
 * - Top bid (meilleure offre d'achat)
 * - Mid price (moyenne floor + bid)
 * - Horodatage
 */

// ==================== TYPES ====================

export interface PriceData {
  collection: string;        // Slug de la collection OpenSea
  floorPrice: number;        // Prix minimum de listing (ETH)
  topBid: number;            // Meilleure offre d'achat (ETH)
  midPrice: number;          // (floor + bid) / 2
  spread: number;            // (floor - bid) / floor (en %)
  timestamp: number;         // Unix timestamp ms
  date: string;              // ISO date string
}

export interface CollectionStats {
  collection: string;
  priceHistory: PriceData[];
  lastUpdate: number;
}

// ==================== CONFIG ====================

const OPENSEA_API_BASE = "https://api.opensea.io/api/v2";

// ==================== API OPENSEA ====================

/**
 * Récupère le floor price d'une collection via OpenSea API v2
 */
async function fetchFloorPrice(
  collectionSlug: string,
  apiKey: string
): Promise<number> {
  try {
    const response = await fetch(
      `${OPENSEA_API_BASE}/collections/${collectionSlug}/stats`,
      {
        headers: {
          "X-API-KEY": apiKey,
          "Accept": "application/json",
        },
      }
    );

    if (!response.ok) {
      throw new Error(`OpenSea API error: ${response.status}`);
    }

    const data = await response.json() as { total?: { floor_price?: number } };
    return data.total?.floor_price || 0;
  } catch (error: any) {
    console.error(`[OpenSea] Error fetching floor for ${collectionSlug}:`, error.message);
    return 0;
  }
}

/**
 * Récupère le top bid (meilleure offre) via OpenSea API v2
 */
async function fetchTopBid(
  collectionSlug: string,
  apiKey: string
): Promise<number> {
  try {
    // OpenSea v2 - récupère les offres sur la collection
    const response = await fetch(
      `${OPENSEA_API_BASE}/offers/collection/${collectionSlug}?limit=1`,
      {
        headers: {
          "X-API-KEY": apiKey,
          "Accept": "application/json",
        },
      }
    );

    if (!response.ok) {
      console.error(`[OpenSea] Offers API error: ${response.status}`);
      return 0;
    }

    const data = await response.json() as { 
      offers?: Array<{ 
        protocol_data?: { 
          parameters?: { 
            offer?: Array<{ 
              startAmount?: string;
            }> 
          } 
        } 
      }> 
    };
    
    const topOffer = data.offers?.[0];
    const amountWei = topOffer?.protocol_data?.parameters?.offer?.[0]?.startAmount;
    
    if (amountWei) {
      // Convertir de wei (18 decimals) en ETH
      return parseFloat(amountWei) / 1e18;
    }
    
    return 0;
  } catch (error: any) {
    console.error(`[OpenSea] Error fetching bids for ${collectionSlug}:`, error.message);
    return 0;
  }
}

/**
 * Récupère floor price et top bid depuis OpenSea
 */
async function fetchPricesFromOpenSea(
  collectionSlug: string,
  apiKey: string
): Promise<{ floor: number; topBid: number }> {
  const [floor, topBid] = await Promise.all([
    fetchFloorPrice(collectionSlug, apiKey),
    fetchTopBid(collectionSlug, apiKey),
  ]);
  
  return { floor, topBid };
}

// ==================== PRICE FETCHER CLASS ====================

export class PriceFetcher {
  private apiKey: string;
  private collections: Map<string, CollectionStats> = new Map();

  constructor(config: { 
    openseaApiKey: string; 
  }) {
    this.apiKey = config.openseaApiKey;
    
    if (!this.apiKey) {
      throw new Error("❌ OpenSea API key is required! Get one at https://opensea.io/account/settings");
    }
  }

  /**
   * Récupère les prix d'une collection via OpenSea
   */
  async fetchPrice(collectionSlug: string): Promise<PriceData> {
    const now = Date.now();

    const prices = await fetchPricesFromOpenSea(collectionSlug, this.apiKey);
    const floor = prices.floor;
    const topBid = prices.topBid;

    const midPrice = (floor + topBid) / 2;
    const spread = floor > 0 ? ((floor - topBid) / floor) * 100 : 0;

    const priceData: PriceData = {
      collection: collectionSlug.toLowerCase(),
      floorPrice: floor,
      topBid: topBid,
      midPrice: midPrice,
      spread: spread,
      timestamp: now,
      date: new Date(now).toISOString(),
    };

    // Stocke dans l'historique
    this.addToHistory(collectionSlug, priceData);

    return priceData;
  }

  /**
   * Ajoute un prix à l'historique
   */
  private addToHistory(contractAddress: string, price: PriceData): void {
    const addr = contractAddress.toLowerCase();
    
    if (!this.collections.has(addr)) {
      this.collections.set(addr, {
        collection: addr,
        priceHistory: [],
        lastUpdate: 0,
      });
    }

    const stats = this.collections.get(addr)!;
    stats.priceHistory.push(price);
    stats.lastUpdate = price.timestamp;

    // Garde max 50000 points
    if (stats.priceHistory.length > 50000) {
      stats.priceHistory = stats.priceHistory.slice(-50000);
    }
  }

  /**
   * Récupère l'historique des prix d'une collection
   */
  getHistory(contractAddress: string): PriceData[] {
    const stats = this.collections.get(contractAddress.toLowerCase());
    return stats?.priceHistory || [];
  }

  /**
   * Récupère le dernier prix connu
   */
  getLatestPrice(contractAddress: string): PriceData | null {
    const history = this.getHistory(contractAddress);
    return history.length > 0 ? history[history.length - 1] : null;
  }

  /**
   * Convertit l'historique en DailyPrice pour les calculs de volatilité
   */
  getDailyPrices(contractAddress: string): { date: string; price: number }[] {
    const history = this.getHistory(contractAddress);
    
    // Groupe par jour et fait la moyenne
    const dailyMap = new Map<string, number[]>();
    
    for (const price of history) {
      const date = price.date.split("T")[0]; // "2026-01-29"
      const floors = dailyMap.get(date) || [];
      if (price.floorPrice > 0) {
        floors.push(price.floorPrice);
      }
      dailyMap.set(date, floors);
    }

    // Calcule la moyenne par jour
    return Array.from(dailyMap.entries())
      .map(([date, prices]) => ({
        date,
        price: prices.reduce((a, b) => a + b, 0) / prices.length,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }
}
