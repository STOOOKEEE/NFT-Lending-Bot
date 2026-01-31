/**
 * offers-db.ts - Gestion des offres de prêt dans Supabase
 * 
 * Table SQL à créer dans Supabase:
 * 
 * CREATE TABLE lending_offers (
 *   id TEXT PRIMARY KEY,                    -- ID complet: contractAddress.lenderAddress.offerId
 *   marketplace TEXT NOT NULL,              -- 'gondi', 'arcade', 'nftfi', 'blur', etc.
 *   offer_id TEXT NOT NULL,                 -- ID numérique de l'offre
 *   contract_address TEXT NOT NULL,         -- Adresse du contrat MSL
 *   lender_address TEXT NOT NULL,           -- Adresse du prêteur
 *   
 *   -- Collection info
 *   collection_id INTEGER,
 *   collection_address TEXT,
 *   collection_name TEXT,
 *   token_id TEXT,                          -- NULL pour collection offers
 *   
 *   -- Offer terms
 *   principal_amount TEXT NOT NULL,         -- En wei (string pour bigint)
 *   principal_eth DECIMAL NOT NULL,         -- En ETH pour lisibilité
 *   currency TEXT DEFAULT 'WETH',
 *   apr_bps INTEGER NOT NULL,               -- APR en basis points
 *   apr_percent DECIMAL NOT NULL,           -- APR en pourcentage
 *   duration_seconds INTEGER NOT NULL,
 *   duration_days INTEGER NOT NULL,
 *   
 *   -- Capacity & fees
 *   capacity TEXT,
 *   capacity_eth DECIMAL,
 *   fee TEXT DEFAULT '0',
 *   max_senior_repayment TEXT,
 *   
 *   -- Timestamps
 *   expiration_time TIMESTAMPTZ NOT NULL,
 *   created_at TIMESTAMPTZ DEFAULT NOW(),
 *   
 *   -- Status
 *   status TEXT DEFAULT 'ACTIVE',           -- ACTIVE, CANCELLED, EXECUTED, EXPIRED
 *   offer_hash TEXT,
 *   signature TEXT,
 *   
 *   -- Metadata
 *   requires_liquidation BOOLEAN DEFAULT TRUE,
 *   borrower_address TEXT
 * );
 * 
 * CREATE INDEX idx_lending_offers_marketplace ON lending_offers(marketplace);
 * CREATE INDEX idx_lending_offers_lender ON lending_offers(lender_address);
 * CREATE INDEX idx_lending_offers_status ON lending_offers(status);
 * CREATE INDEX idx_lending_offers_collection ON lending_offers(collection_address);
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";

// ==================== TYPES ====================

export interface LendingOffer {
  id: string;                      // ID complet
  marketplace: string;
  offer_id: string;
  contract_address: string;
  lender_address: string;
  
  collection_id?: number;
  collection_address?: string;
  collection_name?: string;
  token_id?: string;
  
  principal_amount: string;
  principal_eth: number;
  currency: string;
  apr_bps: number;
  apr_percent: number;
  duration_seconds: number;
  duration_days: number;
  
  capacity?: string;
  capacity_eth?: number;
  fee?: string;
  max_senior_repayment?: string;
  
  expiration_time: string;
  created_at?: string;
  
  status: string;
  offer_hash?: string;
  signature?: string;
  
  requires_liquidation?: boolean;
  borrower_address?: string;
}

// ==================== DB CLIENT ====================

let supabase: SupabaseClient | null = null;

function getSupabase(): SupabaseClient {
  if (supabase) return supabase;
  
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  
  if (!url || !key) {
    throw new Error("SUPABASE_URL et SUPABASE_ANON_KEY requis dans .env");
  }
  
  supabase = createClient(url, key);
  return supabase;
}

// ==================== CRUD OPERATIONS ====================

/**
 * Ajouter une nouvelle offre à la DB
 */
export async function addOffer(offer: LendingOffer): Promise<void> {
  const db = getSupabase();
  
  const { error } = await db
    .from("lending_offers")
    .upsert(offer, { onConflict: "id" });
  
  if (error) {
    console.error("❌ Erreur ajout offre DB:", error.message);
    throw error;
  }
  
  console.log(`✅ Offre ajoutée à la DB: ${offer.id}`);
}

/**
 * Récupérer une offre par ID
 */
export async function getOffer(id: string): Promise<LendingOffer | null> {
  const db = getSupabase();
  
  const { data, error } = await db
    .from("lending_offers")
    .select("*")
    .eq("id", id)
    .single();
  
  if (error && error.code !== "PGRST116") { // PGRST116 = not found
    throw error;
  }
  
  return data;
}

/**
 * Récupérer toutes les offres d'un lender
 */
export async function getOffersByLender(
  lenderAddress: string, 
  marketplace?: string,
  status?: string
): Promise<LendingOffer[]> {
  const db = getSupabase();
  
  let query = db
    .from("lending_offers")
    .select("*")
    .eq("lender_address", lenderAddress.toLowerCase());
  
  if (marketplace) {
    query = query.eq("marketplace", marketplace);
  }
  
  if (status) {
    query = query.eq("status", status);
  }
  
  const { data, error } = await query.order("created_at", { ascending: false });
  
  if (error) throw error;
  
  return data || [];
}

/**
 * Mettre à jour le statut d'une offre
 */
export async function updateOfferStatus(id: string, status: string): Promise<void> {
  const db = getSupabase();
  
  const { error } = await db
    .from("lending_offers")
    .update({ status })
    .eq("id", id);
  
  if (error) {
    console.error("❌ Erreur update statut:", error.message);
    throw error;
  }
  
  console.log(`✅ Statut mis à jour: ${id} → ${status}`);
}

/**
 * Supprimer une offre (ou marquer comme CANCELLED)
 */
export async function removeOffer(id: string, hardDelete: boolean = false): Promise<void> {
  const db = getSupabase();
  
  if (hardDelete) {
    const { error } = await db
      .from("lending_offers")
      .delete()
      .eq("id", id);
    
    if (error) throw error;
    console.log(`🗑️  Offre supprimée de la DB: ${id}`);
  } else {
    await updateOfferStatus(id, "CANCELLED");
  }
}

/**
 * Supprimer toutes les offres d'un lender sur un marketplace
 */
export async function removeAllOffers(
  lenderAddress: string, 
  marketplace: string,
  hardDelete: boolean = false
): Promise<number> {
  const db = getSupabase();
  
  if (hardDelete) {
    const { data, error } = await db
      .from("lending_offers")
      .delete()
      .eq("lender_address", lenderAddress.toLowerCase())
      .eq("marketplace", marketplace)
      .select("id");
    
    if (error) throw error;
    return data?.length || 0;
  } else {
    const { data, error } = await db
      .from("lending_offers")
      .update({ status: "CANCELLED" })
      .eq("lender_address", lenderAddress.toLowerCase())
      .eq("marketplace", marketplace)
      .eq("status", "ACTIVE")
      .select("id");
    
    if (error) throw error;
    return data?.length || 0;
  }
}

/**
 * Obtenir des statistiques sur les offres
 */
export async function getOffersStats(lenderAddress?: string): Promise<{
  total: number;
  active: number;
  cancelled: number;
  expired: number;
  byMarketplace: Record<string, number>;
}> {
  const db = getSupabase();
  
  let query = db.from("lending_offers").select("marketplace, status");
  
  if (lenderAddress) {
    query = query.eq("lender_address", lenderAddress.toLowerCase());
  }
  
  const { data, error } = await query;
  
  if (error) throw error;
  
  const offers = data || [];
  const byMarketplace: Record<string, number> = {};
  
  for (const offer of offers) {
    byMarketplace[offer.marketplace] = (byMarketplace[offer.marketplace] || 0) + 1;
  }
  
  return {
    total: offers.length,
    active: offers.filter(o => o.status === "ACTIVE").length,
    cancelled: offers.filter(o => o.status === "CANCELLED").length,
    expired: offers.filter(o => o.status === "EXPIRED").length,
    byMarketplace,
  };
}

// ==================== CLEANUP: Gestion des offres expirées ====================

/**
 * Marquer les offres expirées comme EXPIRED
 * Retourne le nombre d'offres mises à jour
 */
export async function markExpiredOffers(): Promise<number> {
  const db = getSupabase();
  
  const now = new Date().toISOString();
  
  const { data, error } = await db
    .from("lending_offers")
    .update({ status: "EXPIRED" })
    .eq("status", "ACTIVE")
    .lt("expiration_time", now)
    .select("id");
  
  if (error) {
    console.error("❌ Erreur marking expired offers:", error.message);
    throw error;
  }
  
  const count = data?.length || 0;
  if (count > 0) {
    console.log(`⏰ ${count} offre(s) marquée(s) comme EXPIRED`);
  }
  
  return count;
}

/**
 * Supprimer définitivement les offres expirées depuis plus de X jours
 */
export async function deleteOldExpiredOffers(daysOld: number = 30): Promise<number> {
  const db = getSupabase();
  
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysOld);
  
  const { data, error } = await db
    .from("lending_offers")
    .delete()
    .eq("status", "EXPIRED")
    .lt("expiration_time", cutoffDate.toISOString())
    .select("id");
  
  if (error) {
    console.error("❌ Erreur deleting old expired offers:", error.message);
    throw error;
  }
  
  const count = data?.length || 0;
  if (count > 0) {
    console.log(`🗑️  ${count} vieille(s) offre(s) expirée(s) supprimée(s)`);
  }
  
  return count;
}

/**
 * Nettoyage complet: marquer expirées + supprimer les vieilles
 */
export async function cleanupExpiredOffers(deleteAfterDays: number = 30): Promise<{
  marked: number;
  deleted: number;
}> {
  const marked = await markExpiredOffers();
  const deleted = await deleteOldExpiredOffers(deleteAfterDays);
  
  return { marked, deleted };
}

/**
 * Récupérer les offres qui vont expirer bientôt
 */
export async function getExpiringOffers(
  lenderAddress: string,
  withinHours: number = 24
): Promise<LendingOffer[]> {
  const db = getSupabase();
  
  const now = new Date();
  const cutoff = new Date(now.getTime() + withinHours * 60 * 60 * 1000);
  
  const { data, error } = await db
    .from("lending_offers")
    .select("*")
    .eq("lender_address", lenderAddress.toLowerCase())
    .eq("status", "ACTIVE")
    .gt("expiration_time", now.toISOString())
    .lt("expiration_time", cutoff.toISOString())
    .order("expiration_time", { ascending: true });
  
  if (error) throw error;
  
  return data || [];
}

// ==================== HELPER: Create offer from Gondi response ====================

export function createOfferFromGondiResponse(
  gondiResponse: any,
  collectionInfo?: { id?: number; address?: string; name?: string }
): LendingOffer {
  const principalWei = gondiResponse.principalAmount?.toString() || "0";
  const principalEth = Number(principalWei) / 1e18;
  const capacityWei = gondiResponse.capacity?.toString();
  const capacityEth = capacityWei ? Number(capacityWei) / 1e18 : principalEth;
  const aprBps = Number(gondiResponse.aprBps || 0);
  const durationSeconds = Number(gondiResponse.duration || 0);
  
  return {
    id: gondiResponse.id,
    marketplace: "gondi",
    offer_id: gondiResponse.offerId?.toString() || gondiResponse.id.split(".").pop(),
    contract_address: gondiResponse.contractAddress?.toLowerCase(),
    lender_address: gondiResponse.lenderAddress?.toLowerCase(),
    
    collection_id: collectionInfo?.id || gondiResponse.collectionId,
    collection_address: collectionInfo?.address || gondiResponse.nftCollateralAddress?.toLowerCase(),
    collection_name: collectionInfo?.name,
    token_id: gondiResponse.nftCollateralTokenId !== "0" ? gondiResponse.nftCollateralTokenId : undefined,
    
    principal_amount: principalWei,
    principal_eth: principalEth,
    currency: gondiResponse.principalAddress === "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" ? "WETH" : "UNKNOWN",
    apr_bps: aprBps,
    apr_percent: aprBps / 100,
    duration_seconds: durationSeconds,
    duration_days: Math.round(durationSeconds / 86400),
    
    capacity: capacityWei,
    capacity_eth: capacityEth,
    fee: gondiResponse.fee?.toString() || "0",
    max_senior_repayment: gondiResponse.maxSeniorRepayment?.toString(),
    
    expiration_time: new Date(Number(gondiResponse.expirationTime) * 1000).toISOString(),
    
    status: "ACTIVE",
    offer_hash: gondiResponse.offerHash,
    signature: gondiResponse.signature,
    
    requires_liquidation: gondiResponse.requiresLiquidation ?? true,
    borrower_address: gondiResponse.borrowerAddress !== "0x0000000000000000000000000000000000000000" 
      ? gondiResponse.borrowerAddress?.toLowerCase() 
      : undefined,
  };
}
