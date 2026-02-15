/** gondi-db.ts - Supabase operations for gondi_best_offers table */

import { getSupabaseClient } from "./supabase";

export interface BestOfferRecord {
  collection_name: string;
  collection_slug: string;
  duration_days: number;
  best_principal_amount: number;
  best_principal_currency: string;
  best_principal_apr: number;
  best_principal_offer_id: string;
  best_principal_lender: string;
  best_principal_expiration: string;
  best_apr_amount: number;
  best_apr_currency: string;
  best_apr_percent: number;
  best_apr_offer_id: string;
  best_apr_lender: string;
  best_apr_expiration: string;
}

export async function replaceAllOffers(records: BestOfferRecord[]): Promise<{ success: number; failed: number }> {
  const client = getSupabaseClient();
  const snapshotTime = new Date().toISOString();

  const { error, data } = await client
    .from("gondi_best_offers")
    .insert(records.map(r => ({ ...r, snapshot_time: snapshotTime })))
    .select();

  if (error) {
    console.error("[DB] Insert error:", error.message);
    return { success: 0, failed: records.length };
  }

  return { success: data?.length || 0, failed: records.length - (data?.length || 0) };
}

export async function getOffersByCollection(slug: string): Promise<BestOfferRecord[]> {
  const client = getSupabaseClient();

  const { data, error } = await client
    .from("gondi_best_offers_latest")
    .select("*")
    .eq("collection_slug", slug)
    .order("duration_days", { ascending: true });

  if (error) {
    console.error("[DB] Fetch error:", error.message);
    return [];
  }

  return data || [];
}

export async function getStats(): Promise<{ total: number; collections: number; durations: number[] }> {
  const client = getSupabaseClient();

  const { data, error } = await client
    .from("gondi_best_offers_latest")
    .select("collection_slug, duration_days");

  if (error || !data) {
    return { total: 0, collections: 0, durations: [] };
  }

  const uniqueCollections = new Set(data.map(d => d.collection_slug));
  const uniqueDurations = [...new Set(data.map(d => d.duration_days))].sort((a, b) => a - b);

  return { total: data.length, collections: uniqueCollections.size, durations: uniqueDurations };
}
