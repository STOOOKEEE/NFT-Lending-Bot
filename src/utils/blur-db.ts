/** blur-db.ts - Supabase operations for blur_market_data table */

import { getSupabaseClient } from "./supabase";
import { BlurMarketSummary } from "../collectors/blur-market-collector";

export interface BlurMarketRecord {
  collection_address: string;
  collection_slug: string;
  best_apr_bps: number;
  best_offer_amount_eth: number;
  total_liquidity_eth: number;
  offer_levels: number;
  floor_price_eth: number;
  snapshot_time?: string;
}

export async function saveBlurMarketData(
  summaries: BlurMarketSummary[]
): Promise<{ success: number; failed: number }> {
  if (summaries.length === 0) {
    return { success: 0, failed: 0 };
  }

  const client = getSupabaseClient();
  const snapshotTime = new Date().toISOString();

  const records: BlurMarketRecord[] = summaries.map(s => ({
    collection_address: s.collectionAddress,
    collection_slug: s.collectionSlug,
    best_apr_bps: s.bestAprBps,
    best_offer_amount_eth: s.bestOfferAmountEth,
    total_liquidity_eth: s.totalLiquidityEth,
    offer_levels: s.offerLevels,
    floor_price_eth: s.floorPriceEth,
    snapshot_time: snapshotTime,
  }));

  const { error, data } = await client
    .from("blur_market_data")
    .insert(records)
    .select();

  if (error) {
    console.error("[blur-db] Insert error:", error.message);
    return { success: 0, failed: records.length };
  }

  return { success: data?.length || 0, failed: records.length - (data?.length || 0) };
}

export async function getBlurMarketBySlug(slug: string): Promise<BlurMarketRecord | null> {
  const client = getSupabaseClient();

  const { data, error } = await client
    .from("blur_market_data_latest")
    .select("*")
    .eq("collection_slug", slug)
    .single();

  if (error) {
    if (error.code !== "PGRST116") {
      console.error("[blur-db] Fetch error:", error.message);
    }
    return null;
  }

  return data;
}
