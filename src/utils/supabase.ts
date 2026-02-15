/**
 * supabase.ts - Client Supabase partagé (singleton)
 *
 * Un seul client pour tout le bot. Importé par price-db, gondi-db, blur-db, lending-db, RiskManager.
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";

let supabase: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
  if (!supabase) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_ANON_KEY;
    if (!url || !key) {
      throw new Error("SUPABASE_URL and SUPABASE_ANON_KEY required in .env");
    }
    supabase = createClient(url, key);
  }
  return supabase;
}
