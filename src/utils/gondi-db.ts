/**
 * offers-db.ts - Stockage des meilleures offres Gondi dans Supabase
 * 
 * Nouvelle structure: Par collection + durée, on stocke:
 * - Meilleure offre par PRINCIPAL (le plus haut)
 * - Meilleure offre par APR (le plus bas)
 * 
 * Table SQL à créer dans Supabase:
 * 
 * DROP TABLE IF EXISTS gondi_best_offers;
 * 
 * CREATE TABLE gondi_best_offers (
 *   id BIGSERIAL PRIMARY KEY,
 *   collection_name TEXT NOT NULL,
 *   collection_slug TEXT NOT NULL,
 *   duration_days INTEGER NOT NULL,
 *   
 *   -- Best by Principal (highest collateral)
 *   best_principal_amount DECIMAL NOT NULL,
 *   best_principal_currency TEXT NOT NULL,
 *   best_principal_apr DECIMAL NOT NULL,
 *   best_principal_offer_id TEXT NOT NULL,
 *   best_principal_lender TEXT NOT NULL,
 *   best_principal_expiration TIMESTAMPTZ NOT NULL,
 *   
 *   -- Best by APR (lowest rate)
 *   best_apr_amount DECIMAL NOT NULL,
 *   best_apr_currency TEXT NOT NULL,
 *   best_apr_percent DECIMAL NOT NULL,
 *   best_apr_offer_id TEXT NOT NULL,
 *   best_apr_lender TEXT NOT NULL,
 *   best_apr_expiration TIMESTAMPTZ NOT NULL,
 *   
 *   updated_at TIMESTAMPTZ DEFAULT NOW(),
 *   
 *   UNIQUE(collection_slug, duration_days)
 * );
 * 
 * CREATE INDEX idx_gondi_collection ON gondi_best_offers(collection_slug);
 * CREATE INDEX idx_gondi_duration ON gondi_best_offers(duration_days);
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";

// ==================== TYPES ====================

export interface BestOfferRecord {
  collection_name: string;
  collection_slug: string;
  duration_days: number;
  // Best by Principal
  best_principal_amount: number;
  best_principal_currency: string;
  best_principal_apr: number;
  best_principal_offer_id: string;
  best_principal_lender: string;
  best_principal_expiration: string;
  // Best by APR
  best_apr_amount: number;
  best_apr_currency: string;
  best_apr_percent: number;
  best_apr_offer_id: string;
  best_apr_lender: string;
  best_apr_expiration: string;
}

// ==================== SUPABASE CLIENT ====================

let supabase: SupabaseClient | null = null;

function getSupabaseClient(): SupabaseClient {
  if (!supabase) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_ANON_KEY;
    if (!url || !key) {
      throw new Error("❌ SUPABASE_URL and SUPABASE_ANON_KEY required in .env");
    }
    supabase = createClient(url, key);
  }
  return supabase;
}

// ==================== DATABASE OPERATIONS ====================

/**
 * Supprime toutes les offres et insère les nouvelles
 */
export async function replaceAllOffers(records: BestOfferRecord[]): Promise<{ success: number; failed: number }> {
  const client = getSupabaseClient();

  // Supprimer toutes les anciennes offres
  const { error: deleteError } = await client
    .from("gondi_best_offers")
    .delete()
    .gte("id", 0);

  if (deleteError) {
    console.error("[DB] Delete error:", deleteError.message);
  }

  // Insérer les nouvelles
  const { error, data } = await client
    .from("gondi_best_offers")
    .insert(records.map(r => ({
      ...r,
      updated_at: new Date().toISOString(),
    })))
    .select();

  if (error) {
    console.error("[DB] Insert error:", error.message);
    return { success: 0, failed: records.length };
  }

  return { success: data?.length || 0, failed: records.length - (data?.length || 0) };
}

/**
 * Récupère toutes les offres
 */
export async function getAllOffers(): Promise<BestOfferRecord[]> {
  const client = getSupabaseClient();
  
  const { data, error } = await client
    .from("gondi_best_offers")
    .select("*")
    .order("collection_name", { ascending: true })
    .order("duration_days", { ascending: true });

  if (error) {
    console.error("[DB] Fetch error:", error.message);
    return [];
  }

  return data || [];
}

/**
 * Récupère les offres pour une collection
 */
export async function getOffersByCollection(slug: string): Promise<BestOfferRecord[]> {
  const client = getSupabaseClient();
  
  const { data, error } = await client
    .from("gondi_best_offers")
    .select("*")
    .eq("collection_slug", slug)
    .order("duration_days", { ascending: true });

  if (error) {
    console.error("[DB] Fetch error:", error.message);
    return [];
  }

  return data || [];
}

/**
 * Récupère les offres pour une durée spécifique
 */
export async function getOffersByDuration(durationDays: number): Promise<BestOfferRecord[]> {
  const client = getSupabaseClient();
  
  const { data, error } = await client
    .from("gondi_best_offers")
    .select("*")
    .eq("duration_days", durationDays)
    .order("best_principal_amount", { ascending: false });

  if (error) {
    console.error("[DB] Fetch error:", error.message);
    return [];
  }

  return data || [];
}

/**
 * Statistiques
 */
export async function getStats(): Promise<{ 
  total: number; 
  collections: number; 
  durations: number[];
}> {
  const client = getSupabaseClient();
  
  const { data, error } = await client
    .from("gondi_best_offers")
    .select("collection_slug, duration_days");

  if (error || !data) {
    return { total: 0, collections: 0, durations: [] };
  }

  const uniqueCollections = new Set(data.map(d => d.collection_slug));
  const uniqueDurations = [...new Set(data.map(d => d.duration_days))].sort((a, b) => a - b);

  return {
    total: data.length,
    collections: uniqueCollections.size,
    durations: uniqueDurations,
  };
}
