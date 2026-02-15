/**
 * send-gondi-offer.ts - Envoyer des offres de prêt sur Gondi
 *
 * Utilisable comme MODULE (import) ou en CLI standalone.
 *
 * Module:
 *   import { initGondiContext, sendGondiCollectionOffer } from "./send-gondi-offer";
 *   const ctx = initGondiContext();
 *   const result = await sendGondiCollectionOffer(ctx, { ... });
 *
 * CLI:
 *   npx tsx src/execution/send-gondi-offer.ts --collection pudgy-penguins --amount 1.5 --apr 15 --duration 30
 */

import "dotenv/config";
import { Gondi } from "gondi";
import { createWalletClient, createPublicClient, http, parseEther, formatEther, Address } from "viem";

type ViemPublicClient = ReturnType<typeof createPublicClient>;
type ViemWalletClient = ReturnType<typeof createWalletClient>;
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import { addOffer, createOfferFromGondiResponse } from "../utils/lending-db";

// ==================== CONFIG ====================

const RPC_URL = process.env.RPC_URL || "https://eth-mainnet.g.alchemy.com/v2/demo";
const WALLET_PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY;

const WETH_ADDRESS = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as const;
const MSL_CONTRACT_V3_1 = "0xf41B389E0C1950dc0B16C9498eaE77131CC08A56" as const;

const WETH_ABI = [
  {
    constant: true,
    inputs: [{ name: "_owner", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "balance", type: "uint256" }],
    type: "function",
  },
  {
    constant: true,
    inputs: [
      { name: "_owner", type: "address" },
      { name: "_spender", type: "address" },
    ],
    name: "allowance",
    outputs: [{ name: "", type: "uint256" }],
    type: "function",
  },
  {
    constant: false,
    inputs: [
      { name: "_spender", type: "address" },
      { name: "_value", type: "uint256" },
    ],
    name: "approve",
    outputs: [{ name: "", type: "bool" }],
    type: "function",
  },
] as const;

const DEFAULT_EXPIRATION_MINUTES = 30;
const DEFAULT_FEE = 0n;

// ==================== EXPORTED TYPES ====================

export interface GondiContext {
  gondi: Gondi;
  walletClient: ViemWalletClient;
  publicClient: ViemPublicClient;
  walletAddress: Address;
}

export interface GondiOfferParams {
  slug: string;
  amountEth: number;
  aprPercent: number;
  durationDays: number;
  capacityEth?: number;
  expirationMinutes?: number;
  skipApproval?: boolean;
}

export interface GondiOfferResult {
  success: boolean;
  offerId?: string;
  error?: string;
}

// ==================== HELPERS ====================

/**
 * Retourne le solde WETH en ETH (nombre décimal).
 * Utilisé par bot-auto pour vérifier le solde avant d'envoyer des offres.
 */
export async function getWethBalanceEth(ctx: GondiContext): Promise<number> {
  const balance = await ctx.publicClient.readContract({
    address: WETH_ADDRESS,
    abi: WETH_ABI,
    functionName: "balanceOf",
    args: [ctx.walletAddress],
  }) as bigint;
  return parseFloat(formatEther(balance));
}

async function checkWethBalance(publicClient: ViemPublicClient, walletAddress: Address, requiredAmount: bigint): Promise<bigint> {
  const balance = await publicClient.readContract({
    address: WETH_ADDRESS,
    abi: WETH_ABI,
    functionName: "balanceOf",
    args: [walletAddress],
  }) as bigint;

  console.log(`  💰 WETH: ${formatEther(balance)} (need ${formatEther(requiredAmount)})`);

  if (balance < requiredAmount) {
    throw new Error(`Insufficient WETH: have ${formatEther(balance)}, need ${formatEther(requiredAmount)}`);
  }

  return balance;
}

async function checkAndApproveWeth(
  publicClient: ViemPublicClient,
  walletClient: ViemWalletClient,
  walletAddress: Address,
  requiredAmount: bigint
): Promise<void> {
  const allowance = await publicClient.readContract({
    address: WETH_ADDRESS,
    abi: WETH_ABI,
    functionName: "allowance",
    args: [walletAddress, MSL_CONTRACT_V3_1],
  }) as bigint;

  if (allowance < requiredAmount) {
    console.log(`  🔓 Approving WETH for Gondi MSL...`);
    const maxApproval = BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");

    const hash = await walletClient.writeContract({
      account: walletAddress,
      chain: mainnet,
      address: WETH_ADDRESS,
      abi: WETH_ABI,
      functionName: "approve",
      args: [MSL_CONTRACT_V3_1, maxApproval],
    });

    await publicClient.waitForTransactionReceipt({ hash });
    console.log(`  ✅ WETH approved`);
  }
}

function ethToWei(eth: number): bigint {
  return parseEther(eth.toString());
}

function aprPercentToBps(aprPercent: number): bigint {
  return BigInt(Math.round(aprPercent * 100));
}

function daysToSeconds(days: number): bigint {
  return BigInt(days * 24 * 60 * 60);
}

function getExpirationTime(minutes: number): bigint {
  const now = Math.floor(Date.now() / 1000);
  return BigInt(now + minutes * 60);
}

// ==================== GONDI CLIENT (singleton) ====================

let cachedContext: GondiContext | null = null;

/**
 * Initialise le client Gondi une seule fois (singleton).
 * Appelé au démarrage du bot, réutilisé pour chaque offre.
 */
export function initGondiContext(): GondiContext {
  if (cachedContext) return cachedContext;

  if (!WALLET_PRIVATE_KEY) {
    throw new Error("WALLET_PRIVATE_KEY not set in .env");
  }

  const cleanPrivateKey = WALLET_PRIVATE_KEY.startsWith("0x")
    ? WALLET_PRIVATE_KEY as `0x${string}`
    : `0x${WALLET_PRIVATE_KEY}` as `0x${string}`;

  const account = privateKeyToAccount(cleanPrivateKey);

  const walletClient = createWalletClient({
    account,
    transport: http(RPC_URL),
    chain: mainnet,
  });

  const publicClient = createPublicClient({
    transport: http(RPC_URL),
    chain: mainnet,
  });

  const gondi = new Gondi({ wallet: walletClient });

  cachedContext = {
    gondi,
    walletClient,
    publicClient,
    walletAddress: account.address,
  };

  console.log(`🔐 Gondi client initialized: ${account.address}`);
  return cachedContext;
}

// ==================== EXPORTED: SEND COLLECTION OFFER ====================

/**
 * Envoie une offre de prêt collection sur Gondi.
 * Retourne { success, offerId } ou { success: false, error }.
 */
export async function sendGondiCollectionOffer(
  ctx: GondiContext,
  params: GondiOfferParams
): Promise<GondiOfferResult> {
  const { gondi, publicClient, walletClient, walletAddress } = ctx;
  const {
    slug,
    amountEth,
    aprPercent,
    durationDays,
    capacityEth,
    expirationMinutes = DEFAULT_EXPIRATION_MINUTES,
    skipApproval = false,
  } = params;

  try {
    // Resolve collection ID
    let collectionId: number;

    if (slug.startsWith("0x")) {
      const result = await gondi.collectionId({ contractAddress: slug as `0x${string}` });
      const ids = Array.isArray(result) ? result : [result];
      if (!ids.length || typeof ids[0] !== "number") {
        return { success: false, error: `Collection not found: ${slug}` };
      }
      collectionId = ids[0];
    } else {
      const result = await gondi.collectionId({ slug });
      const ids = Array.isArray(result) ? result : [result];
      if (!ids.length || typeof ids[0] !== "number") {
        return { success: false, error: `Collection not found: ${slug}` };
      }
      collectionId = ids[0];
    }

    // Get collection metadata for DB
    let collectionName: string | undefined;
    let collectionAddress: string | undefined = slug.startsWith("0x") ? slug : undefined;

    try {
      const collectionData = await gondi.collections({ collections: [collectionId] });
      if (collectionData.collections?.length) {
        const col = collectionData.collections[0];
        collectionName = col.name || col.slug;
        if (!collectionAddress && col.contractData?.contractAddress) {
          collectionAddress = col.contractData.contractAddress;
        }
      }
    } catch {
      // Best effort
    }

    // Build offer params
    const principalWei = ethToWei(amountEth);
    const capacityWei = ethToWei(capacityEth || amountEth);
    const aprBps = aprPercentToBps(aprPercent);
    const maxSeniorRepayment = (principalWei * (10000n + aprBps * BigInt(durationDays) / 365n)) / 10000n;

    // Check WETH balance + approval
    await checkWethBalance(publicClient, walletAddress, capacityWei);
    if (!skipApproval) {
      await checkAndApproveWeth(publicClient, walletClient, walletAddress, capacityWei);
    }

    // Send offer
    const offer = await gondi.makeCollectionOffer({
      collectionId,
      principalAddress: WETH_ADDRESS,
      principalAmount: principalWei,
      capacity: capacityWei,
      fee: DEFAULT_FEE,
      aprBps,
      expirationTime: getExpirationTime(expirationMinutes),
      duration: daysToSeconds(durationDays),
      requiresLiquidation: true,
      maxSeniorRepayment,
    });

    if (offer?.id) {
      // Save to DB (best effort)
      try {
        const dbOffer = createOfferFromGondiResponse(offer, {
          id: collectionId,
          address: collectionAddress,
          name: collectionName,
        });
        await addOffer(dbOffer);
      } catch {
        // Best effort
      }

      return { success: true, offerId: String(offer.id) };
    }

    return { success: false, error: "No offer ID returned" };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return { success: false, error: msg };
  }
}

// ==================== CLI MODE ====================

function parseArgs(): GondiOfferParams & { dryRun: boolean } {
  const args = process.argv.slice(2);

  const getArg = (name: string): string | undefined => {
    const index = args.findIndex(a => a === `--${name}`);
    if (index !== -1 && args[index + 1]) {
      return args[index + 1];
    }
    return undefined;
  };

  const collection = getArg("collection");
  const amountStr = getArg("amount");
  const aprStr = getArg("apr");
  const durationStr = getArg("duration");
  const capacityStr = getArg("capacity");
  const expirationStr = getArg("expiration");
  const dryRun = args.includes("--dry-run");
  const skipApproval = args.includes("--skip-approval");

  if (!collection) { console.error("--collection required"); process.exit(1); }
  if (!amountStr) { console.error("--amount required"); process.exit(1); }
  if (!aprStr) { console.error("--apr required"); process.exit(1); }
  if (!durationStr) { console.error("--duration required"); process.exit(1); }

  return {
    slug: collection,
    amountEth: parseFloat(amountStr),
    aprPercent: parseFloat(aprStr),
    durationDays: parseInt(durationStr, 10),
    capacityEth: capacityStr ? parseFloat(capacityStr) : undefined,
    expirationMinutes: expirationStr ? parseInt(expirationStr, 10) : DEFAULT_EXPIRATION_MINUTES,
    skipApproval,
    dryRun,
  };
}

// Only run CLI when executed directly (not imported as module)
const isDirectExecution = process.argv[1]?.includes("send-gondi-offer");

if (isDirectExecution) {
  const params = parseArgs();

  if (params.dryRun) {
    console.log("DRY-RUN mode");
    console.log(`  Collection: ${params.slug}`);
    console.log(`  Amount: ${params.amountEth} ETH | APR: ${params.aprPercent}% | Duration: ${params.durationDays}d`);
  } else {
    const ctx = initGondiContext();
    sendGondiCollectionOffer(ctx, params)
      .then(result => {
        if (result.success) {
          console.log(`✅ Offer created: ${result.offerId}`);
        } else {
          console.error(`❌ Failed: ${result.error}`);
          process.exit(1);
        }
      })
      .catch((err: unknown) => {
        console.error("Fatal:", err instanceof Error ? err.message : err);
        process.exit(1);
      });
  }
}
