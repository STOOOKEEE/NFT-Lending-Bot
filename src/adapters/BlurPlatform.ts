/**
 * BlurPlatform.ts - Implémentation LendingPlatform pour Blur Blend
 *
 * Encapsule: init wallet, sync marché, send offer, monitor LTV, recall.
 * Remplace les fonctions loose de BlurAdapter.ts et blur-market-collector.ts.
 */

import { ethers } from "ethers";
import {
  LendingPlatform,
  NormalizedOffer,
  OfferResult,
  PlatformMarketOffer,
  TrackingResult,
  LiquidationCheckResult,
} from "./LendingPlatform";
import { RiskManager } from "../risk/RiskManager";
import { collectBlurMarketData, displayBlurMarketData } from "../collectors/blur-market-collector";
import { saveBlurMarketData, getBlurMarketBySlug } from "../utils/blur-db";
import { getLatestFloorPrice } from "../utils/price-db";
import { findCollectionByAddress } from "../utils/collections-loader";
import { sleep } from "../utils/helpers";

// ==================== CONFIG ====================

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || "";
const BLUR_HOST = "blur.p.rapidapi.com";
const RATE_LIMIT_DELAY = 600;
const BLUR_POOL_ADDRESS = "0x0000000000A39bb272e79075ade125fd351887Ac";
const TOKEN_CACHE_MS = 25 * 60 * 1000;

/** LTV threshold above which we trigger a recall */
const BLUR_RECALL_LTV = 0.90;
/** LTV threshold for Telegram warning */
const BLUR_WARN_LTV = 0.85;

// Import from config (avoids circular import with blur-market-collector)
import { BLUR_LENDING_COLLECTIONS } from "../config/blur-collections";
export { BLUR_LENDING_COLLECTIONS };

// ==================== API RESPONSE TYPES ====================

interface ChallengeResponse {
  message: string;
  expiresOn: string;
  hmac: string;
}

interface LoginResponse {
  accessToken: string;
}

interface SignDataDomain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: string;
}

interface SignDataField {
  name: string;
  type: string;
}

interface FormatSignature {
  signData: {
    domain: SignDataDomain;
    types: Record<string, SignDataField[]>;
    value: Record<string, unknown>;
  };
  marketplaceData: string;
}

interface FormatResponse {
  success?: boolean;
  message?: string;
  signatures?: FormatSignature[];
}

interface SubmitResponse {
  success?: boolean;
  message?: string;
}

interface BlurActiveLien {
  lienId: string;
  collection: string;
  tokenId: string;
  borrowAmount: string;
  remainingBalance: string;
  interestRate: number;
  startDate: string;
}

interface ActiveLoansUserResponse {
  lenderOffers?: Array<{
    offerId: string;
    collection: string;
    rate: number;
    maxAmount: string;
    totalAvailable: string;
    taken: string;
  }>;
  borrowerLoans?: BlurActiveLien[];
  liens?: BlurActiveLien[];
}

// ==================== CLASS ====================

export class BlurPlatform extends LendingPlatform {
  readonly name = "blur";

  private wallet: ethers.Wallet | null = null;
  private cachedToken: string | null = null;
  private tokenFetchedAt = 0;
  private initialized = false;

  async init(): Promise<void> {
    const privateKey = process.env.WALLET_PRIVATE_KEY;
    if (!privateKey) {
      throw new Error("WALLET_PRIVATE_KEY not set in .env");
    }
    const cleanKey = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
    this.wallet = new ethers.Wallet(cleanKey);
    this.initialized = true;
    console.log(`🔵 Blur wallet initialized: ${this.wallet.address}`);
  }

  isCollectionSupported(collectionAddress: string): boolean {
    return collectionAddress.toLowerCase() in BLUR_LENDING_COLLECTIONS;
  }

  async getAvailableBalance(): Promise<number> {
    this.ensureInitialized();
    const rpcUrl = process.env.RPC_URL || "https://eth-mainnet.g.alchemy.com/v2/demo";
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const pool = new ethers.Contract(
      BLUR_POOL_ADDRESS,
      ["function balanceOf(address) view returns (uint256)"],
      provider
    );
    const balance: bigint = await pool.balanceOf(this.wallet!.address);
    return parseFloat(ethers.formatEther(balance));
  }

  // ==================== MARKET SYNC ====================

  async syncMarketData(): Promise<void> {
    console.log("  [blur] Collecting Blur Blend market data...");

    const summaries = await collectBlurMarketData();
    displayBlurMarketData(summaries);

    if (summaries.length > 0) {
      const result = await saveBlurMarketData(summaries);
      console.log(`  [blur] Saved ${result.success} collections, ${result.failed} failed`);
    } else {
      console.log("  [blur] No Blur lending activity");
    }
  }

  async getMarketOffers(collectionSlug: string): Promise<PlatformMarketOffer[]> {
    // Find the Blur slug for this collection
    const { findCollectionBySlug } = await import("../utils/collections-loader");
    const col = findCollectionBySlug(collectionSlug);
    if (!col || !this.isCollectionSupported(col.address)) return [];

    const blurSlug = BLUR_LENDING_COLLECTIONS[col.address.toLowerCase()];
    const blurData = await getBlurMarketBySlug(blurSlug);
    if (!blurData || blurData.best_apr_bps <= 0) return [];

    return [{
      collection: collectionSlug,
      collectionAddress: col.address,
      durationDays: 30, // Blur: rolling loans, 30d as reference
      bestAprDecimal: blurData.best_apr_bps / 10000,
      bestAprAmount: blurData.best_offer_amount_eth,
      bestPrincipalAmount: blurData.best_offer_amount_eth,
      bestPrincipalAprDecimal: blurData.best_apr_bps / 10000,
      offerType: "best_apr",
    }];
  }

  // ==================== SEND OFFER ====================

  async sendOffer(offer: NormalizedOffer): Promise<OfferResult> {
    this.ensureInitialized();

    try {
      const accessToken = await this.getAuthToken();
      const blurAmount = roundToBlurTick(offer.loanAmount);

      if (blurAmount < 0.1) {
        return { success: false, error: `Amount too small: ${offer.loanAmount} ETH (min 0.1)` };
      }

      const amountStr = blurAmount.toFixed(1);
      const collectionAddress = offer.collectionAddress.toLowerCase();
      const userAddress = this.wallet!.address.toLowerCase();
      const expirationDate = new Date(Date.now() + 30 * 60 * 1000);

      console.log(`  🔵 Blur offer: ${amountStr} ETH @ ${offer.aprBps} bps for ${collectionAddress}`);

      // Step 1: Format
      const formatRes = await fetch(`https://${BLUR_HOST}/v1/blend/loan-offer/format`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-rapidapi-key": RAPIDAPI_KEY,
          "x-rapidapi-host": BLUR_HOST,
          "authToken": accessToken,
          "walletAddress": userAddress,
        },
        body: JSON.stringify({
          orders: [{
            rate: offer.aprBps,
            maxAmount: amountStr,
            totalAmount: amountStr,
            expirationTime: expirationDate.toISOString(),
            contractAddress: collectionAddress,
          }],
          userAddress,
          contractAddress: collectionAddress,
        }),
      });

      const formatResult = await formatRes.json() as FormatResponse;

      if (!formatRes.ok || !formatResult.signatures?.length) {
        const errorMsg = formatResult.message || `Format failed: ${formatRes.status}`;
        if (errorMsg.includes("blur pool balance")) {
          return { success: false, error: "Insufficient Blur Pool balance. Deposit ETH at blur.io" };
        }
        return { success: false, error: errorMsg };
      }

      await sleep(RATE_LIMIT_DELAY);

      // Step 2: Sign
      const { signData, marketplaceData } = formatResult.signatures[0];
      const convertedValue = convertBigNumbers(signData.value) as Record<string, unknown>;
      const signature = await this.wallet!.signTypedData(
        signData.domain,
        signData.types,
        convertedValue
      );

      await sleep(RATE_LIMIT_DELAY);

      // Step 3: Submit
      const submitRes = await fetch(`https://${BLUR_HOST}/v1/blend/loan-offer/submit`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-rapidapi-key": RAPIDAPI_KEY,
          "x-rapidapi-host": BLUR_HOST,
          "authToken": accessToken,
          "walletAddress": userAddress,
        },
        body: JSON.stringify({
          orders: [{ signature, marketplaceData }],
          userAddress,
          contractAddress: collectionAddress,
        }),
      });

      const submitResult = await submitRes.json() as SubmitResponse;

      if (!submitRes.ok) {
        return { success: false, error: submitResult.message || `Submit failed: ${submitRes.status}` };
      }

      console.log(`  ✅ Blur offer submitted: ${amountStr} ETH @ ${offer.aprBps} bps`);
      return { success: true, offerHash: signature.slice(0, 18) + "..." };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, error: msg };
    }
  }

  // ==================== TRACKING (Blur has no DB-based tracking yet) ====================

  async trackOffers(_lenderAddress: string, _riskManager: RiskManager): Promise<TrackingResult> {
    // Blur offers tracked differently (no Gondi-style offer status API)
    return { checked: 0, executed: 0, cancelled: 0, expired: 0, errors: 0 };
  }

  // ==================== LIQUIDATION / LTV MONITORING ====================

  async checkAndLiquidate(dryRun: boolean): Promise<LiquidationCheckResult> {
    this.ensureInitialized();

    const result: LiquidationCheckResult = {
      checked: 0, liquidated: 0, recalled: 0, warnings: 0, errors: 0, alerts: [],
    };

    try {
      const liens = await this.fetchActiveLoans();
      if (liens.length === 0) return result;

      result.checked = liens.length;
      console.log(`  [blur-monitor] ${liens.length} active lien(s) found`);

      for (const lien of liens) {
        const collection = lien.collection?.toLowerCase() || "";
        const col = findCollectionByAddress(collection);
        const slug = col?.slug || collection;
        const loanAmount = parseFloat(lien.remainingBalance || lien.borrowAmount);

        if (isNaN(loanAmount) || loanAmount <= 0) continue;

        const priceData = await getLatestFloorPrice(slug);
        if (!priceData) {
          console.log(`  [blur-monitor] No price data for ${slug}, skipping lien ${lien.lienId}`);
          continue;
        }

        const floor = priceData.floor;
        if (floor <= 0) continue;

        const ltv = loanAmount / floor;
        const pct = `${(ltv * 100).toFixed(1)}%`;

        if (ltv >= BLUR_RECALL_LTV) {
          const alertMsg = `🚨 BLUR RECALL | ${slug} | lien ${lien.lienId} | LTV ${pct}`;
          console.log(`  ${alertMsg}`);

          if (!dryRun) {
            const repayResult = await this.triggerRepay(collection, lien.lienId, lien.tokenId);
            if (repayResult.success) {
              result.recalled++;
              result.alerts.push(`✅ RECALLED | ${slug} lien ${lien.lienId} | LTV ${pct}`);
            } else {
              result.errors++;
              result.alerts.push(`❌ RECALL FAILED | ${slug} lien ${lien.lienId} | ${repayResult.error}`);
            }
          } else {
            result.alerts.push(`📋 [DRY-RUN] Would recall ${slug} lien ${lien.lienId} | LTV ${pct}`);
          }
        } else if (ltv >= BLUR_WARN_LTV) {
          result.warnings++;
          result.alerts.push(`⚠️ BLUR WARNING | ${slug} lien ${lien.lienId} | LTV ${pct}`);
        } else {
          console.log(`  [blur-monitor] ✅ ${slug} lien ${lien.lienId}: LTV ${pct} (healthy)`);
        }
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`❌ Blur monitor failed: ${errMsg}`);
      result.errors++;
      result.alerts.push(`❌ Blur monitor error: ${errMsg}`);
    }

    return result;
  }

  // ==================== PRIVATE HELPERS ====================

  private ensureInitialized(): void {
    if (!this.initialized || !this.wallet) {
      throw new Error("BlurPlatform not initialized. Call init() first.");
    }
  }

  private async getAuthToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && now - this.tokenFetchedAt < TOKEN_CACHE_MS) {
      return this.cachedToken;
    }

    console.log("  🔑 Blur auth: getting challenge...");

    const challengeRes = await fetch(`https://${BLUR_HOST}/auth/challenge`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-rapidapi-key": RAPIDAPI_KEY,
        "x-rapidapi-host": BLUR_HOST,
      },
      body: JSON.stringify({ walletAddress: this.wallet!.address }),
    });

    if (!challengeRes.ok) {
      throw new Error(`Auth challenge failed: ${challengeRes.status}`);
    }

    const challenge = await challengeRes.json() as ChallengeResponse;
    await sleep(RATE_LIMIT_DELAY);

    const signature = await this.wallet!.signMessage(challenge.message);

    const loginRes = await fetch(`https://${BLUR_HOST}/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-rapidapi-key": RAPIDAPI_KEY,
        "x-rapidapi-host": BLUR_HOST,
      },
      body: JSON.stringify({
        message: challenge.message,
        walletAddress: this.wallet!.address,
        expiresOn: challenge.expiresOn,
        hmac: challenge.hmac,
        signature,
      }),
    });

    if (!loginRes.ok) {
      throw new Error(`Auth login failed: ${loginRes.status}`);
    }

    const login = await loginRes.json() as LoginResponse;
    await sleep(RATE_LIMIT_DELAY);

    this.cachedToken = login.accessToken;
    this.tokenFetchedAt = now;
    console.log("  ✅ Blur auth successful");
    return this.cachedToken;
  }

  private async fetchActiveLoans(): Promise<BlurActiveLien[]> {
    const walletAddress = this.wallet!.address.toLowerCase();

    const res = await fetch(
      `https://${BLUR_HOST}/v1/blend/active-loans/${walletAddress}`,
      {
        headers: {
          "x-rapidapi-key": RAPIDAPI_KEY,
          "x-rapidapi-host": BLUR_HOST,
        },
      }
    );

    if (!res.ok) {
      console.error(`[blur] Active loans fetch failed: ${res.status}`);
      return [];
    }

    const data = await res.json() as { data?: ActiveLoansUserResponse };
    const response = data?.data;
    if (!response) return [];

    return response.liens || response.borrowerLoans || [];
  }

  private async triggerRepay(
    contractAddress: string,
    lienId: string,
    tokenId: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const accessToken = await this.getAuthToken();
      const userAddress = this.wallet!.address.toLowerCase();

      console.log(`  🔵 Blur repay: lienId=${lienId} tokenId=${tokenId}`);

      const res = await fetch(`https://${BLUR_HOST}/v1/blend/lien/repay`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-rapidapi-key": RAPIDAPI_KEY,
          "x-rapidapi-host": BLUR_HOST,
          "authToken": accessToken,
          "walletAddress": userAddress,
        },
        body: JSON.stringify({
          userAddress,
          lienRequests: [{ lienId, tokenId }],
          contractAddress: contractAddress.toLowerCase(),
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        return { success: false, error: `Repay failed: ${res.status} - ${body}` };
      }

      console.log(`  ✅ Blur repay triggered for lien ${lienId}`);
      return { success: true };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, error: msg };
    }
  }
}

// ==================== STANDALONE HELPERS (backwards compat) ====================

export function roundToBlurTick(amountEth: number): number {
  return Math.floor(amountEth * 10) / 10;
}

export function isBlurSupported(collectionAddress: string): boolean {
  return collectionAddress.toLowerCase() in BLUR_LENDING_COLLECTIONS;
}

function convertBigNumbers(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return obj;

  const record = obj as Record<string, unknown>;
  if (record.type === "BigNumber" && typeof record.hex === "string") {
    return BigInt(record.hex).toString();
  }
  if (Array.isArray(obj)) {
    return obj.map(convertBigNumbers);
  }
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    result[key] = convertBigNumbers(record[key]);
  }
  return result;
}
