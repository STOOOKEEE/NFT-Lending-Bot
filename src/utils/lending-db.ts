/** lending-db.ts - Supabase operations for lending_offers table */

import { getSupabaseClient } from "./supabase";

export interface LendingOffer {
  id: string;
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

export async function addOffer(offer: LendingOffer): Promise<void> {
  const db = getSupabaseClient();

  const { error } = await db
    .from("lending_offers")
    .upsert(offer, { onConflict: "id" });

  if (error) {
    console.error("[lending-db] Insert error:", error.message);
    throw error;
  }
}

export async function getOffersByLender(
  lenderAddress: string,
  marketplace?: string,
  status?: string
): Promise<LendingOffer[]> {
  const db = getSupabaseClient();

  let query = db
    .from("lending_offers")
    .select("*")
    .eq("lender_address", lenderAddress.toLowerCase());

  if (marketplace) query = query.eq("marketplace", marketplace);
  if (status) query = query.eq("status", status);

  const { data, error } = await query.order("created_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function updateOfferStatus(id: string, status: string): Promise<void> {
  const db = getSupabaseClient();

  const { error } = await db
    .from("lending_offers")
    .update({ status })
    .eq("id", id);

  if (error) {
    console.error("[lending-db] Update error:", error.message);
    throw error;
  }
}

export async function removeOffer(id: string, hardDelete: boolean = false): Promise<void> {
  const db = getSupabaseClient();

  if (hardDelete) {
    const { error } = await db.from("lending_offers").delete().eq("id", id);
    if (error) throw error;
  } else {
    await updateOfferStatus(id, "CANCELLED");
  }
}

export async function removeAllOffers(
  lenderAddress: string,
  marketplace: string,
  hardDelete: boolean = false
): Promise<number> {
  const db = getSupabaseClient();

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

export async function getOffersStats(lenderAddress?: string): Promise<{
  total: number;
  active: number;
  cancelled: number;
  expired: number;
  byMarketplace: Record<string, number>;
}> {
  const db = getSupabaseClient();

  let query = db.from("lending_offers").select("marketplace, status");
  if (lenderAddress) query = query.eq("lender_address", lenderAddress.toLowerCase());

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

export async function markExpiredOffers(): Promise<number> {
  const db = getSupabaseClient();

  const { data, error } = await db
    .from("lending_offers")
    .update({ status: "EXPIRED" })
    .eq("status", "ACTIVE")
    .lt("expiration_time", new Date().toISOString())
    .select("id");

  if (error) {
    console.error("[lending-db] Mark expired error:", error.message);
    throw error;
  }

  return data?.length || 0;
}

export async function deleteOldExpiredOffers(daysOld: number = 30): Promise<number> {
  const db = getSupabaseClient();

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysOld);

  const { data, error } = await db
    .from("lending_offers")
    .delete()
    .eq("status", "EXPIRED")
    .lt("expiration_time", cutoffDate.toISOString())
    .select("id");

  if (error) {
    console.error("[lending-db] Delete expired error:", error.message);
    throw error;
  }

  return data?.length || 0;
}

export async function cleanupExpiredOffers(deleteAfterDays: number = 30): Promise<{ marked: number; deleted: number }> {
  const marked = await markExpiredOffers();
  const deleted = await deleteOldExpiredOffers(deleteAfterDays);
  return { marked, deleted };
}

export async function getExpiringOffers(
  lenderAddress: string,
  withinHours: number = 24
): Promise<LendingOffer[]> {
  const db = getSupabaseClient();

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

interface GondiOfferResponse {
  id: string;
  offerId?: bigint | string | number;
  contractAddress?: string;
  lenderAddress?: string;
  principalAmount?: bigint | string | number;
  capacity?: bigint | string | number;
  aprBps?: bigint | number | string;
  duration?: bigint | number | string;
  expirationTime?: bigint | number | string;
  fee?: bigint | string | number;
  maxSeniorRepayment?: bigint | string | number | null;
  requiresLiquidation?: boolean | null;
  borrowerAddress?: string;
  nftCollateralAddress?: string;
  nftCollateralTokenId?: bigint | string;
  collectionId?: number;
  principalAddress?: string;
  offerHash?: string;
  signature?: string;
}

export function createOfferFromGondiResponse(
  gondiResponse: GondiOfferResponse,
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
    offer_id: gondiResponse.offerId?.toString() || gondiResponse.id.split(".").pop() || "",
    contract_address: gondiResponse.contractAddress?.toLowerCase() || "",
    lender_address: gondiResponse.lenderAddress?.toLowerCase() || "",
    collection_id: collectionInfo?.id || gondiResponse.collectionId,
    collection_address: collectionInfo?.address || gondiResponse.nftCollateralAddress?.toLowerCase(),
    collection_name: collectionInfo?.name,
    token_id: gondiResponse.nftCollateralTokenId && gondiResponse.nftCollateralTokenId.toString() !== "0"
      ? gondiResponse.nftCollateralTokenId.toString()
      : undefined,
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
