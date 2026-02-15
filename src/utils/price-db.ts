/** price-db.ts - Supabase operations for price_history table */

import { getSupabaseClient } from "./supabase";

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

export async function savePriceToDb(price: PriceRecord): Promise<void> {
  try {
    const { error } = await getSupabaseClient()
      .from("price_history")
      .insert({
        collection_slug: price.collection_slug,
        floor_price: price.floor_price,
        top_bid: price.top_bid,
        mid_price: price.mid_price,
        spread: price.spread,
      });

    if (error) {
      console.error(`[price-db] Save error for ${price.collection_slug}:`, error.message);
    }
  } catch (err: unknown) {
    console.error(`[price-db] Connection error for ${price.collection_slug}:`, err instanceof Error ? err.message : String(err));
  }
}

export async function getPriceHistory(collectionSlug: string, days: number = 30): Promise<PriceRecord[]> {
  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - days);

  const { data, error } = await getSupabaseClient()
    .from("price_history")
    .select("*")
    .eq("collection_slug", collectionSlug)
    .gte("timestamp", fromDate.toISOString())
    .order("timestamp", { ascending: true });

  if (error) {
    console.error(`[price-db] History error for ${collectionSlug}:`, error.message);
    return [];
  }

  return data || [];
}

export async function getLatestFloorPrice(
  collectionSlug: string
): Promise<{ floor: number; bid: number; mid: number } | null> {
  const { data, error } = await getSupabaseClient()
    .from("price_history")
    .select("floor_price, top_bid, mid_price")
    .eq("collection_slug", collectionSlug)
    .order("timestamp", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error(`[price-db] Latest price error for ${collectionSlug}:`, error.message);
    return null;
  }

  if (!data) return null;
  return { floor: data.floor_price, bid: data.top_bid, mid: data.mid_price };
}

export async function getDailyAveragePrices(collectionSlug: string, days: number = 30): Promise<DailyAveragePrice[]> {
  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - days);

  const { data, error } = await getSupabaseClient()
    .from("price_history")
    .select("floor_price, top_bid, mid_price, timestamp")
    .eq("collection_slug", collectionSlug)
    .gte("timestamp", fromDate.toISOString())
    .order("timestamp", { ascending: true });

  if (error) {
    console.error(`[price-db] Daily averages error:`, error.message);
    return [];
  }

  if (!data || data.length === 0) return [];

  const dailyMap = new Map<string, { floors: number[]; bids: number[]; mids: number[] }>();

  for (const record of data) {
    const date = record.timestamp.split("T")[0];
    if (!dailyMap.has(date)) dailyMap.set(date, { floors: [], bids: [], mids: [] });

    const day = dailyMap.get(date)!;
    if (record.floor_price > 0) day.floors.push(record.floor_price);
    if (record.top_bid > 0) day.bids.push(record.top_bid);
    if (record.mid_price > 0) day.mids.push(record.mid_price);
  }

  const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

  const result: DailyAveragePrice[] = [];
  for (const [date, values] of dailyMap.entries()) {
    result.push({ date, avg_floor: avg(values.floors), avg_bid: avg(values.bids), avg_mid: avg(values.mids) });
  }

  return result.sort((a, b) => a.date.localeCompare(b.date));
}
