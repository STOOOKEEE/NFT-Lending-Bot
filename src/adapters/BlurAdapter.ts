/**
 * BlurAdapter.ts - Adapter pour envoyer des offres de prêt sur Blur Blend
 *
 * Flow:
 *   1. Auth: challenge → sign → login → accessToken (cached)
 *   2. Format: POST /v1/blend/loan-offer/format → signData + marketplaceData
 *   3. Sign: wallet.signTypedData(domain, types, value)
 *   4. Submit: POST /v1/blend/loan-offer/submit
 *
 * Contraintes Blur:
 *   - Montants multiples de 0.1 ETH
 *   - Addresses lowercase
 *   - ethers v6 pour signTypedData
 */

import { ethers } from "ethers";
import { sleep } from "../utils/helpers";

// ==================== CONFIG ====================

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || "";
const BLUR_HOST = "blur.p.rapidapi.com";
const RATE_LIMIT_DELAY = 600;
const BLUR_POOL_ADDRESS = "0x0000000000A39bb272e79075ade125fd351887Ac";

// ==================== TYPES ====================

export interface BlurOfferParams {
  collectionAddress: string;
  loanAmountEth: number;
  aprBps: number;
  expirationMinutes: number;
}

export interface BlurOfferResult {
  success: boolean;
  offerHash?: string;
  error?: string;
}

/** Collections supportées par Blur Blend */
export const BLUR_LENDING_COLLECTIONS: Record<string, string> = {
  "0xed5af388653567af2f388e6224dc7c4b3241c544": "azuki",
  "0xbd3531da5cf5857e7cfaa92426877b022e612cf8": "pudgy-penguins",
  "0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d": "boredapeyachtclub",
  "0x60e4d786628fea6478f785a6d7e704777c86a7c6": "mutant-ape-yacht-club",
  "0x5af0d9827e0c53e4799bb226655a1de152a425a5": "milady",
  "0x23581767a106ae21c074b2276d25e5c3e136a68b": "proof-moonbirds",
  "0x8a90cab2b38dba80c64b7734e58ee1db38b8992e": "doodles-official",
  "0x49cf6f5d44e70224e2e23fdcdd2c053f30ada28b": "clonex",
  "0x8821bee2ba0df28761afff119d66390d594cd280": "degods",
  "0x524cab2ec69124574082676e6f654a18df49a048": "lil-pudgys",
  "0xb7f7f6c52f2e2fdb1963eab30438024864c313f6": "wrapped-cryptopunks",
};

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

// ==================== AUTH (cached) ====================

let cachedToken: string | null = null;
let tokenFetchedAt = 0;
const TOKEN_CACHE_MS = 25 * 60 * 1000; // 25 min (tokens expire ~30 min)

async function getAuthToken(wallet: ethers.Wallet): Promise<string> {
  const now = Date.now();
  if (cachedToken && now - tokenFetchedAt < TOKEN_CACHE_MS) {
    return cachedToken;
  }

  console.log("  🔑 Blur auth: getting challenge...");

  const challengeRes = await fetch(`https://${BLUR_HOST}/auth/challenge`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-rapidapi-key": RAPIDAPI_KEY,
      "x-rapidapi-host": BLUR_HOST,
    },
    body: JSON.stringify({ walletAddress: wallet.address }),
  });

  if (!challengeRes.ok) {
    throw new Error(`Auth challenge failed: ${challengeRes.status}`);
  }

  const challenge = await challengeRes.json() as ChallengeResponse;
  await sleep(RATE_LIMIT_DELAY);

  const signature = await wallet.signMessage(challenge.message);

  const loginRes = await fetch(`https://${BLUR_HOST}/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-rapidapi-key": RAPIDAPI_KEY,
      "x-rapidapi-host": BLUR_HOST,
    },
    body: JSON.stringify({
      message: challenge.message,
      walletAddress: wallet.address,
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

  cachedToken = login.accessToken;
  tokenFetchedAt = now;
  console.log("  ✅ Blur auth successful");
  return cachedToken;
}

// ==================== HELPERS ====================

/**
 * Convert BigNumber objects in API response to string values.
 * Blur API sometimes returns { type: "BigNumber", hex: "0x..." } objects
 * that ethers v6 signTypedData cannot handle directly.
 */
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

/**
 * Arrondir au 0.1 ETH inférieur (contrainte Blur)
 */
export function roundToBlurTick(amountEth: number): number {
  return Math.floor(amountEth * 10) / 10;
}

// ==================== BLUR ADAPTER ====================

let blurWallet: ethers.Wallet | null = null;

/**
 * Initialise le wallet ethers pour Blur.
 * Appelé une fois au démarrage du bot.
 */
export function initBlurWallet(): ethers.Wallet {
  if (blurWallet) return blurWallet;

  const privateKey = process.env.WALLET_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error("WALLET_PRIVATE_KEY not set in .env");
  }

  const cleanKey = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
  blurWallet = new ethers.Wallet(cleanKey);
  console.log(`🔵 Blur wallet initialized: ${blurWallet.address}`);
  return blurWallet;
}

/**
 * Retourne le solde Blur Pool en ETH (nombre décimal).
 * Le Blur Pool contract expose balanceOf(address).
 */
export async function getBlurPoolBalanceEth(): Promise<number> {
  const wallet = initBlurWallet();
  const rpcUrl = process.env.RPC_URL || "https://eth-mainnet.g.alchemy.com/v2/demo";
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const pool = new ethers.Contract(
    BLUR_POOL_ADDRESS,
    ["function balanceOf(address) view returns (uint256)"],
    provider
  );
  const balance: bigint = await pool.balanceOf(wallet.address);
  return parseFloat(ethers.formatEther(balance));
}

/**
 * Envoie une offre de prêt sur Blur Blend.
 *
 * Flow: format → sign → submit
 */
export async function sendBlurOffer(params: BlurOfferParams): Promise<BlurOfferResult> {
  try {
    const wallet = initBlurWallet();
    const accessToken = await getAuthToken(wallet);

    // Round amount to 0.1 ETH tick
    const blurAmount = roundToBlurTick(params.loanAmountEth);
    if (blurAmount < 0.1) {
      return { success: false, error: `Amount too small: ${params.loanAmountEth} ETH (min 0.1)` };
    }

    const amountStr = blurAmount.toFixed(1);
    const collectionAddress = params.collectionAddress.toLowerCase();
    const userAddress = wallet.address.toLowerCase();
    const expirationDate = new Date(Date.now() + params.expirationMinutes * 60 * 1000);

    console.log(`  🔵 Blur offer: ${amountStr} ETH @ ${params.aprBps} bps for ${collectionAddress}`);

    // Step 1: Format the offer
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
          rate: params.aprBps,
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
      // Detect "not enough blur pool balance" error
      if (errorMsg.includes("blur pool balance")) {
        return { success: false, error: "Insufficient Blur Pool balance. Deposit ETH at blur.io" };
      }
      return { success: false, error: errorMsg };
    }

    await sleep(RATE_LIMIT_DELAY);

    // Step 2: Sign the typed data
    const { signData, marketplaceData } = formatResult.signatures[0];
    const convertedValue = convertBigNumbers(signData.value) as Record<string, unknown>;

    const signature = await wallet.signTypedData(
      signData.domain,
      signData.types,
      convertedValue
    );

    await sleep(RATE_LIMIT_DELAY);

    // Step 3: Submit the signed offer
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
        orders: [{
          signature,
          marketplaceData,
        }],
        userAddress,
        contractAddress: collectionAddress,
      }),
    });

    const submitResult = await submitRes.json() as SubmitResponse;

    if (!submitRes.ok) {
      return { success: false, error: submitResult.message || `Submit failed: ${submitRes.status}` };
    }

    console.log(`  ✅ Blur offer submitted: ${amountStr} ETH @ ${params.aprBps} bps`);
    return { success: true, offerHash: signature.slice(0, 18) + "..." };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return { success: false, error: msg };
  }
}

/**
 * Check if a collection address is supported by Blur Blend
 */
export function isBlurSupported(collectionAddress: string): boolean {
  return collectionAddress.toLowerCase() in BLUR_LENDING_COLLECTIONS;
}
