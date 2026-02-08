/**
 * price-db.ts - Stockage des prix dans Supabase
 * 
 * Table SQL à créer dans Supabase:
 * 
 * CREATE TABLE price_history (
 *   id BIGSERIAL PRIMARY KEY,
 *   collection_slug TEXT NOT NULL,
 *   floor_price DECIMAL NOT NULL,
 *   top_bid DECIMAL NOT NULL,
 *   mid_price DECIMAL NOT NULL,
 *   spread DECIMAL NOT NULL,
 *   timestamp TIMESTAMPTZ DEFAULT NOW(),
 *   created_at TIMESTAMPTZ DEFAULT NOW()
 * );
 * 
 * CREATE INDEX idx_price_history_collection ON price_history(collection_slug);
 * CREATE INDEX idx_price_history_timestamp ON price_history(timestamp);
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";

// ==================== TYPES ====================

export interface PriceRecord {
  collection_slug: string;
  floor_price: number;
  top_bid: number;
  mid_price: number;
  spread: number;
  timestamp?: string;
}

export interface DailyAveragePrice {
  date: string;
  avg_floor: number;
  avg_bid: number;
  avg_mid: number;
}

// ==================== SUPABASE CLIENT ====================

let supabase: SupabaseClient | null = null;

function getSupabaseClient(): SupabaseClient {
  if (!supabase) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_ANON_KEY;

    if (!url || !key) {
      throw new Error("❌ SUPABASE_URL and SUPABASE_ANON_KEY are required in .env");
    }

    supabase = createClient(url, key);
  }
  return supabase;
}

// ==================== DATABASE OPERATIONS ====================

/**
 * Sauvegarde un prix dans la DB
 */
export async function savePriceToDb(price: PriceRecord): Promise<void> {
  try {
    const client = getSupabaseClient();
    
    const { error } = await client
      .from("price_history")
      .insert({
        collection_slug: price.collection_slug,
        floor_price: price.floor_price,
        top_bid: price.top_bid,
        mid_price: price.mid_price,
        spread: price.spread,
      });

    if (error) {
      console.error(`[DB] Error saving price for ${price.collection_slug}:`, error.message);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[DB] Connection error for ${price.collection_slug}:`, message);
  }
}

/**
 * Récupère l'historique des prix d'une collection
 */
export async function getPriceHistory(
  collectionSlug: string,
  days: number = 30
): Promise<PriceRecord[]> {
  const client = getSupabaseClient();
  
  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - days);

  const { data, error } = await client
    .from("price_history")
    .select("*")
    .eq("collection_slug", collectionSlug)
    .gte("timestamp", fromDate.toISOString())
    .order("timestamp", { ascending: true });

  if (error) {
    console.error(`[DB] Error fetching history for ${collectionSlug}:`, error.message);
    return [];
  }

  return data || [];
}

/**
 * Récupère le dernier prix enregistré pour une collection
 */
export async function getLatestFloorPrice(
  collectionSlug: string
): Promise<{ floor: number; bid: number; mid: number } | null> {
  const client = getSupabaseClient();

  const { data, error } = await client
    .from("price_history")
    .select("floor_price, top_bid, mid_price")
    .eq("collection_slug", collectionSlug)
    .order("timestamp", { ascending: false })
    .limit(1)
    .single();

  if (error) {
    console.error(`[DB] Error fetching latest price for ${collectionSlug}:`, error.message);
    return null;
  }

  if (!data) return null;

  return {
    floor: data.floor_price,
    bid: data.top_bid,
    mid: data.mid_price,
  };
}

/**
 * Récupère les moyennes journalières pour le calcul de volatilité
 */
export async function getDailyAveragePrices(
  collectionSlug: string,
  days: number = 30
): Promise<DailyAveragePrice[]> {
  const client = getSupabaseClient();
  
  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - days);

  const { data, error } = await client
    .from("price_history")
    .select("floor_price, top_bid, mid_price, timestamp")
    .eq("collection_slug", collectionSlug)
    .gte("timestamp", fromDate.toISOString())
    .order("timestamp", { ascending: true });

  if (error) {
    console.error(`[DB] Error fetching daily averages:`, error.message);
    return [];
  }

  if (!data || data.length === 0) return [];

  // Groupe par jour et calcule les moyennes
  const dailyMap = new Map<string, { floors: number[]; bids: number[]; mids: number[] }>();

  for (const record of data) {
    const date = record.timestamp.split("T")[0];
    
    if (!dailyMap.has(date)) {
      dailyMap.set(date, { floors: [], bids: [], mids: [] });
    }
    
    const day = dailyMap.get(date)!;
    if (record.floor_price > 0) day.floors.push(record.floor_price);
    if (record.top_bid > 0) day.bids.push(record.top_bid);
    if (record.mid_price > 0) day.mids.push(record.mid_price);
  }

  // Calcule les moyennes
  const result: DailyAveragePrice[] = [];
  
  for (const [date, values] of dailyMap.entries()) {
    const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
    
    result.push({
      date,
      avg_floor: avg(values.floors),
      avg_bid: avg(values.bids),
      avg_mid: avg(values.mids),
    });
  }

  return result.sort((a, b) => a.date.localeCompare(b.date));
}
