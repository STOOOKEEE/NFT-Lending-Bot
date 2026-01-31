/**
 * send-offer.ts - Envoyer des offres de prêt sur Gondi
 * 
 * Utilise le SDK officiel Gondi pour créer des offres de prêt:
 * - Collection offers (pour n'importe quel NFT d'une collection)
 * - Single NFT offers (pour un NFT spécifique)
 * 
 * Usage:
 *   # Collection offer
 *   npx tsx send-offer.ts --collection pudgy-penguins --amount 1.5 --apr 15 --duration 30
 * 
 *   # Single NFT offer
 *   npx tsx send-offer.ts --nft pudgy-penguins --token-id 1234 --amount 1.5 --apr 15 --duration 30
 * 
 * Paramètres:
 *   --collection <slug>    Collection slug ou adresse du contrat (0x...)
 *   --nft <slug>           Pour offre single NFT
 *   --token-id <id>        Token ID pour single NFT offer
 *   --amount <eth>         Montant du prêt en ETH
 *   --apr <percent>        APR annuel en pourcentage (ex: 15 = 15%)
 *   --duration <days>      Durée du prêt en jours
 *   --capacity <eth>       Capacité totale (optionnel, défaut = amount)
 *   --expiration <days>    Expiration de l'offre en jours (défaut = 7)
 *   --dry-run              Mode test sans envoi réel
 *   --skip-approval        Skip WETH approval check
 */

import "dotenv/config";
import { Gondi } from "gondi";
import { createWalletClient, createPublicClient, http, parseEther, formatEther, Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import { addOffer, createOfferFromGondiResponse } from "../utils/lending-db";

// ==================== CONFIG ====================

const RPC_URL = process.env.RPC_URL || "https://eth-mainnet.g.alchemy.com/v2/demo";
const WALLET_PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY;

// WETH contract address on mainnet
const WETH_ADDRESS = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as const;

// Gondi Multi Source Loan contract (MSL) - pour approval
// IMPORTANT: Adresse du contrat MSL v3.1 sur mainnet (utilisé par défaut par le SDK Gondi)
// Trouvé dans: https://github.com/gondixyz/gondi-js/blob/main/src/deploys.ts
const MSL_CONTRACT_V3_1 = "0xf41B389E0C1950dc0B16C9498eaE77131CC08A56" as const;

// ABI minimal pour WETH
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

// Default values
const DEFAULT_EXPIRATION_DAYS = 7;
const DEFAULT_FEE = 0n;

// ==================== TYPES ====================

interface OfferParams {
  collectionSlug?: string;
  nftSlug?: string;
  tokenId?: bigint;
  amountEth: number;
  aprPercent: number;
  durationDays: number;
  capacityEth?: number;
  expirationDays?: number;
  requiresLiquidation?: boolean;
  borrowerAddress?: string;
}

// ==================== HELPERS ====================

async function checkWethBalance(publicClient: any, walletAddress: Address, requiredAmount: bigint): Promise<bigint> {
  const balance = await publicClient.readContract({
    address: WETH_ADDRESS,
    abi: WETH_ABI,
    functionName: "balanceOf",
    args: [walletAddress],
  }) as bigint;
  
  console.log(`\n💰 Balance WETH: ${formatEther(balance)} WETH`);
  console.log(`   Required: ${formatEther(requiredAmount)} WETH`);
  
  if (balance < requiredAmount) {
    throw new Error(`Insufficient WETH balance. You have ${formatEther(balance)} but need ${formatEther(requiredAmount)}`);
  }
  
  return balance;
}

async function checkAndApproveWeth(
  publicClient: any, 
  walletClient: any,
  walletAddress: Address, 
  requiredAmount: bigint
): Promise<void> {
  // Check current allowance
  const allowance = await publicClient.readContract({
    address: WETH_ADDRESS,
    abi: WETH_ABI,
    functionName: "allowance",
    args: [walletAddress, MSL_CONTRACT_V3_1],
  }) as bigint;
  
  console.log(`\n🔓 Allowance WETH pour Gondi MSL v3.1: ${formatEther(allowance)} WETH`);
  
  if (allowance < requiredAmount) {
    console.log(`   ⚠️  Allowance insuffisante, approval nécessaire...`);
    
    // Approve max amount
    const maxApproval = BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
    
    const hash = await walletClient.writeContract({
      address: WETH_ADDRESS,
      abi: WETH_ABI,
      functionName: "approve",
      args: [MSL_CONTRACT_V3_1, maxApproval],
    });
    
    console.log(`   📝 Tx d'approbation envoyée: ${hash}`);
    console.log(`   ⏳ Attente de confirmation...`);
    
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(`   ✅ Approbation confirmée!`);
  } else {
    console.log(`   ✅ Allowance suffisante`);
  }
}

function parseArgs(): OfferParams & { dryRun: boolean; skipApproval: boolean } {
  const args = process.argv.slice(2);
  
  const getArg = (name: string): string | undefined => {
    const index = args.findIndex(a => a === `--${name}`);
    if (index !== -1 && args[index + 1]) {
      return args[index + 1];
    }
    return undefined;
  };

  const collectionSlug = getArg("collection");
  const nftSlug = getArg("nft");
  const tokenIdStr = getArg("token-id");
  const amountStr = getArg("amount");
  const aprStr = getArg("apr");
  const durationStr = getArg("duration");
  const capacityStr = getArg("capacity");
  const expirationStr = getArg("expiration");
  const borrowerAddress = getArg("borrower");
  const dryRun = args.includes("--dry-run");
  const skipApproval = args.includes("--skip-approval");
  const requiresLiquidation = args.includes("--liquidation");

  // Validation
  if (!collectionSlug && !nftSlug) {
    console.error("❌ Erreur: --collection ou --nft requis");
    process.exit(1);
  }

  if (nftSlug && !tokenIdStr) {
    console.error("❌ Erreur: --token-id requis pour une offre single NFT");
    process.exit(1);
  }

  if (!amountStr) {
    console.error("❌ Erreur: --amount requis");
    process.exit(1);
  }

  if (!aprStr) {
    console.error("❌ Erreur: --apr requis");
    process.exit(1);
  }

  if (!durationStr) {
    console.error("❌ Erreur: --duration requis");
    process.exit(1);
  }

  return {
    collectionSlug,
    nftSlug,
    tokenId: tokenIdStr ? BigInt(tokenIdStr) : undefined,
    amountEth: parseFloat(amountStr),
    aprPercent: parseFloat(aprStr),
    durationDays: parseInt(durationStr, 10),
    capacityEth: capacityStr ? parseFloat(capacityStr) : undefined,
    expirationDays: expirationStr ? parseInt(expirationStr, 10) : DEFAULT_EXPIRATION_DAYS,
    requiresLiquidation,
    borrowerAddress,
    dryRun,
    skipApproval,
  };
}

function ethToWei(eth: number): bigint {
  return parseEther(eth.toString());
}

function aprPercentToBps(aprPercent: number): bigint {
  // 1% = 100 bps
  return BigInt(Math.round(aprPercent * 100));
}

function daysToSeconds(days: number): bigint {
  return BigInt(days * 24 * 60 * 60);
}

function getExpirationTime(days: number): bigint {
  const now = Math.floor(Date.now() / 1000);
  return BigInt(now + days * 24 * 60 * 60);
}

// Arrondir un montant vers le bas au step le plus proche
function roundToStep(value: bigint, step: bigint): bigint {
  if (step === 0n) return value;
  return (value / step) * step;
}

// Arrondir un montant vers le haut au step le plus proche
function roundUpToStep(value: bigint, step: bigint): bigint {
  if (step === 0n) return value;
  const remainder = value % step;
  if (remainder === 0n) return value;
  return value + (step - remainder);
}

// ==================== GONDI CLIENT ====================

interface GondiContext {
  gondi: Gondi;
  walletClient: any;
  publicClient: any;
  walletAddress: Address;
}

function createGondiClient(): GondiContext {
  if (!WALLET_PRIVATE_KEY) {
    throw new Error("WALLET_PRIVATE_KEY non définie dans .env");
  }

  // Nettoyer la clé privée (enlever 0x si présent)
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

  console.log(`🔐 Wallet: ${account.address}`);

  const gondi = new Gondi({ wallet: walletClient });
  
  return {
    gondi,
    walletClient,
    publicClient,
    walletAddress: account.address,
  };
}

// ==================== SEND OFFER ====================

async function sendCollectionOffer(
  ctx: GondiContext,
  params: OfferParams,
  skipApproval: boolean = false
): Promise<void> {
  const { gondi, publicClient, walletClient, walletAddress } = ctx;
  const { collectionSlug, amountEth, aprPercent, durationDays, capacityEth, expirationDays, requiresLiquidation, borrowerAddress } = params;

  console.log("\n📤 Création d'une Collection Offer...");
  console.log(`   Collection: ${collectionSlug}`);
  console.log(`   Montant: ${amountEth} ETH`);
  console.log(`   APR: ${aprPercent}%`);
  console.log(`   Durée: ${durationDays} jours`);
  console.log(`   Capacité: ${capacityEth || amountEth} ETH`);
  console.log(`   Expiration: ${expirationDays} jours`);

  // Récupérer le collectionId - essayer d'abord par slug, puis par contractAddress
  let collectionId: number;
  
  // Si c'est une adresse de contrat (commence par 0x)
  if (collectionSlug!.startsWith("0x")) {
    console.log(`   🔍 Recherche par contract address: ${collectionSlug}`);
    const collectionIds = await gondi.collectionId({ 
      contractAddress: collectionSlug as `0x${string}` 
    });
    
    if (!collectionIds || collectionIds.length === 0) {
      throw new Error(`Collection avec contrat '${collectionSlug}' non trouvée sur Gondi`);
    }
    collectionId = collectionIds[0];
  } else {
    // Sinon essayer par slug
    console.log(`   🔍 Recherche par slug: ${collectionSlug}`);
    try {
      const collectionIds = await gondi.collectionId({ slug: collectionSlug! });
      
      if (!collectionIds || collectionIds.length === 0) {
        throw new Error(`Collection '${collectionSlug}' non trouvée`);
      }
      collectionId = collectionIds[0];
    } catch (error) {
      // Si le slug ne fonctionne pas, afficher l'aide
      console.log(`\n⚠️  Le slug '${collectionSlug}' n'existe pas sur Gondi.`);
      console.log(`\n💡 Utilise plutôt l'adresse du contrat NFT:`);
      console.log(`   Pudgy Penguins: 0xBd3531dA5CF5857e7CfAA92426877b022e612cf8`);
      console.log(`   Milady: 0x5Af0D9827E0c53E4799BB226655A1de152A425a5`);
      console.log(`   Azuki: 0xED5AF388653567Af2F388E6224dC7C4b3241C544`);
      console.log(`   BAYC: 0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D`);
      console.log(`\n   Exemple: npm run send -- --collection 0xBd3531dA5CF5857e7CfAA92426877b022e612cf8 --amount 0.001 --apr 20 --duration 14`);
      throw error;
    }
  }
  
  console.log(`   Collection ID: ${collectionId}`);

  // Récupérer le nom de la collection
  let collectionName: string | undefined;
  let collectionAddress: string | undefined = collectionSlug!.startsWith("0x") ? collectionSlug : undefined;
  
  try {
    const collectionData = await gondi.collections({ collections: [collectionId] });
    if (collectionData.collections && collectionData.collections.length > 0) {
      const col = collectionData.collections[0];
      collectionName = col.name || col.slug;
      // Récupérer l'adresse du contrat si pas déjà connue
      if (!collectionAddress && col.contractData?.contractAddress) {
        collectionAddress = col.contractData.contractAddress;
      }
      console.log(`   Collection Name: ${collectionName}`);
    }
  } catch (err: any) {
    console.log(`   ⚠️ Impossible de récupérer le nom de collection: ${err.message}`);
  }

  // Récupérer les steps de la collection pour s'assurer de respecter les incréments
  console.log("\n📊 Récupération des Offer Steps de la collection...");
  let offerSteps;
  try {
    offerSteps = await gondi.collectionStepsById({ collectionId });
    console.log(`   wethStep: ${formatEther(offerSteps.wethStep)} ETH (minimum increment)`);
    console.log(`   aprBpsStep: ${offerSteps.aprBpsStep} bps (minimum increment)`);
    console.log(`   origFeeBpsStep: ${offerSteps.origFeeBpsStep} bps`);
    if (offerSteps.usdcStep) console.log(`   usdcStep: ${offerSteps.usdcStep}`);
  } catch (err: any) {
    console.log(`   ⚠️ Impossible de récupérer les steps: ${err.message}`);
    offerSteps = null;
  }

  // Calculer le repayment maximal (principal + intérêts pour la durée)
  let principalWei = ethToWei(amountEth);
  let capacityWei = ethToWei(capacityEth || amountEth);
  let aprBps = aprPercentToBps(aprPercent);
  const durationSeconds = daysToSeconds(durationDays);
  
  // Arrondir selon les steps si disponibles
  if (offerSteps) {
    const wethStep = BigInt(offerSteps.wethStep);
    const aprStep = BigInt(offerSteps.aprBpsStep);
    
    // Arrondir le principal vers le haut au step le plus proche
    const roundedPrincipal = roundUpToStep(principalWei, wethStep);
    if (roundedPrincipal !== principalWei) {
      console.log(`\n⚠️ Principal arrondi: ${formatEther(principalWei)} → ${formatEther(roundedPrincipal)} ETH (step: ${formatEther(wethStep)})`);
      principalWei = roundedPrincipal;
      capacityWei = roundedPrincipal; // Capacity = principal pour simplifier
    }
    
    // Arrondir l'APR vers le haut au step le plus proche  
    const roundedApr = roundUpToStep(aprBps, aprStep);
    if (roundedApr !== aprBps) {
      console.log(`⚠️ APR arrondi: ${aprBps} → ${roundedApr} bps (step: ${aprStep})`);
      aprBps = roundedApr;
    }
  }
  
  // Calcul du max repayment: principal * (1 + apr * duration / 365 days)
  // En basis points: principal * (10000 + aprBps * durationDays / 365) / 10000
  const maxSeniorRepayment = (principalWei * (10000n + aprBps * BigInt(durationDays) / 365n)) / 10000n;

  // Paramètres de l'offre
  const offerParams = {
    collectionId,
    principalAddress: WETH_ADDRESS,
    principalAmount: principalWei,
    capacity: capacityWei,
    fee: DEFAULT_FEE,
    aprBps,
    expirationTime: getExpirationTime(expirationDays || DEFAULT_EXPIRATION_DAYS),
    duration: durationSeconds,
    requiresLiquidation: true,
    maxSeniorRepayment, // Ajout du champ requis
    ...(borrowerAddress && { borrowerAddress: borrowerAddress as `0x${string}` }),
  };

  console.log("\n📋 Paramètres de l'offre:");
  console.log(`   Principal: ${formatEther(offerParams.principalAmount)} WETH`);
  console.log(`   Capacity: ${formatEther(offerParams.capacity)} WETH`);
  console.log(`   APR: ${offerParams.aprBps} bps (${Number(offerParams.aprBps) / 100}%)`);
  console.log(`   Duration: ${offerParams.duration} seconds (${durationDays} days)`);
  console.log(`   Max Repayment: ${formatEther(offerParams.maxSeniorRepayment)} WETH`);
  console.log(`   Expiration: ${new Date(Number(offerParams.expirationTime) * 1000).toISOString()}`);

  // Vérifier le balance WETH
  await checkWethBalance(publicClient, walletAddress, capacityWei);
  
  // Vérifier et approuver WETH si nécessaire
  if (!skipApproval) {
    await checkAndApproveWeth(publicClient, walletClient, walletAddress, capacityWei);
  }

  // Envoyer l'offre
  console.log("\n⏳ Signature et envoi de l'offre...");
  
  try {
    const offer = await gondi.makeCollectionOffer(offerParams);
    
    // Debug: afficher la réponse complète
    console.log("\n📋 Réponse complète de l'API:");
    console.log(JSON.stringify(offer, (key, value) => 
      typeof value === 'bigint' ? value.toString() : value
    , 2));
    
    if (offer && offer.id) {
      console.log("\n✅ Offre créée avec succès!");
      console.log(`   Offer ID: ${offer.id}`);
      console.log(`   Status: ${offer.status}`);
      console.log(`   Created: ${offer.createdDate}`);
      
      // Sauvegarder dans la DB
      try {
        const dbOffer = createOfferFromGondiResponse(offer, {
          id: collectionId,
          address: collectionAddress,
          name: collectionName,
        });
        await addOffer(dbOffer);
        console.log(`   💾 Offre sauvegardée dans la DB`);
      } catch (dbError: any) {
        console.warn(`   ⚠️  Erreur sauvegarde DB: ${dbError.message}`);
      }
    } else {
      console.log("\n⚠️ Réponse inattendue - l'offre peut ne pas avoir été créée");
    }
  } catch (error: any) {
    // Meilleure gestion de l'erreur
    if (error?.message) {
      console.error("\n❌ Erreur Gondi:", error.message);
    }
    if (error?.response?.errors) {
      console.error("   Détails:", JSON.stringify(error.response.errors, null, 2));
    }
    // Log complet pour debug
    console.error("\n📋 Debug info:");
    console.error("   Offer params:", JSON.stringify({
      ...offerParams,
      principalAmount: offerParams.principalAmount.toString(),
      capacity: offerParams.capacity.toString(),
      aprBps: offerParams.aprBps.toString(),
      expirationTime: offerParams.expirationTime.toString(),
      duration: offerParams.duration.toString(),
      maxSeniorRepayment: offerParams.maxSeniorRepayment.toString(),
    }, null, 2));
    throw error;
  }
}

async function sendSingleNftOffer(
  ctx: GondiContext,
  params: OfferParams,
  skipApproval: boolean = false
): Promise<void> {
  const { gondi, publicClient, walletClient, walletAddress } = ctx;
  const { nftSlug, tokenId, amountEth, aprPercent, durationDays, capacityEth, expirationDays, requiresLiquidation, borrowerAddress } = params;

  console.log("\n📤 Création d'une Single NFT Offer...");
  console.log(`   Collection: ${nftSlug}`);
  console.log(`   Token ID: ${tokenId}`);
  console.log(`   Montant: ${amountEth} ETH`);
  console.log(`   APR: ${aprPercent}%`);
  console.log(`   Durée: ${durationDays} jours`);

  // Récupérer le nftId depuis le slug et tokenId
  const nftId = await gondi.nftId({ 
    slug: nftSlug!, 
    tokenId: tokenId!
  });
  
  if (!nftId) {
    throw new Error(`NFT '${nftSlug}' #${tokenId} non trouvé`);
  }

  console.log(`   NFT ID: ${nftId}`);

  // Récupérer le collectionId et le nom de la collection
  let collectionId: number | undefined;
  let collectionName: string | undefined;
  let collectionAddress: string | undefined = nftSlug!.startsWith("0x") ? nftSlug : undefined;
  
  try {
    // Récupérer le collectionId via le slug ou l'adresse
    if (nftSlug!.startsWith("0x")) {
      const ids = await gondi.collectionId({ contractAddress: nftSlug as `0x${string}` });
      collectionId = ids?.[0];
    } else {
      const ids = await gondi.collectionId({ slug: nftSlug! });
      collectionId = ids?.[0];
    }
    
    if (collectionId) {
      const collectionData = await gondi.collections({ collections: [collectionId] });
      if (collectionData.collections && collectionData.collections.length > 0) {
        const col = collectionData.collections[0];
        collectionName = col.name || col.slug;
        if (!collectionAddress && col.contractData?.contractAddress) {
          collectionAddress = col.contractData.contractAddress;
        }
        console.log(`   Collection Name: ${collectionName}`);
      }
    }
  } catch (err: any) {
    console.log(`   ⚠️ Impossible de récupérer les infos de collection: ${err.message}`);
  }

  const capacityWei = ethToWei(capacityEth || amountEth);

  // Paramètres de l'offre
  const offerParams = {
    nftId,
    principalAddress: WETH_ADDRESS as `0x${string}`,
    principalAmount: ethToWei(amountEth),
    capacity: capacityWei,
    fee: DEFAULT_FEE,
    aprBps: aprPercentToBps(aprPercent),
    expirationTime: getExpirationTime(expirationDays || DEFAULT_EXPIRATION_DAYS),
    duration: daysToSeconds(durationDays),
    requiresLiquidation: requiresLiquidation ?? true,
    ...(borrowerAddress && { borrowerAddress: borrowerAddress as `0x${string}` }),
  };

  console.log("\n📋 Paramètres de l'offre:");
  console.log(`   Principal: ${formatEther(offerParams.principalAmount)} WETH`);
  console.log(`   APR: ${offerParams.aprBps} bps (${Number(offerParams.aprBps) / 100}%)`);
  console.log(`   Duration: ${offerParams.duration} seconds (${durationDays} days)`);

  // Vérifier le balance WETH
  await checkWethBalance(publicClient, walletAddress, capacityWei);
  
  // Vérifier et approuver WETH si nécessaire
  if (!skipApproval) {
    await checkAndApproveWeth(publicClient, walletClient, walletAddress, capacityWei);
  }

  // Envoyer l'offre
  console.log("\n⏳ Signature et envoi de l'offre...");
  const offer = await gondi.makeSingleNftOffer(offerParams);

  console.log("\n✅ Offre créée avec succès!");
  console.log(`   Offer ID: ${offer.id}`);
  console.log(`   Status: ${offer.status}`);
  
  // Sauvegarder dans la DB
  try {
    const dbOffer = createOfferFromGondiResponse(offer, {
      id: collectionId,
      address: collectionAddress,
      name: collectionName,
    });
    await addOffer(dbOffer);
    console.log(`   💾 Offre sauvegardée dans la DB`);
  } catch (dbError: any) {
    console.warn(`   ⚠️  Erreur sauvegarde DB: ${dbError.message}`);
  }
}

// ==================== MAIN ====================

async function main() {
  console.log("🚀 Gondi Offer Sender");
  console.log("=".repeat(50));

  const params = parseArgs();
  
  if (params.dryRun) {
    console.log("\n⚠️  MODE DRY-RUN - Aucune offre ne sera envoyée");
    console.log("\nParamètres:");
    console.log(`   Type: ${params.nftSlug ? "Single NFT" : "Collection"}`);
    console.log(`   Collection/NFT: ${params.collectionSlug || params.nftSlug}`);
    if (params.tokenId) console.log(`   Token ID: ${params.tokenId}`);
    console.log(`   Amount: ${params.amountEth} ETH`);
    console.log(`   APR: ${params.aprPercent}%`);
    console.log(`   Duration: ${params.durationDays} days`);
    console.log(`   Capacity: ${params.capacityEth || params.amountEth} ETH`);
    console.log(`   Expiration: ${params.expirationDays} days`);
    return;
  }

  try {
    const ctx = createGondiClient();

    if (params.nftSlug && params.tokenId !== undefined) {
      await sendSingleNftOffer(ctx, params, params.skipApproval);
    } else if (params.collectionSlug) {
      await sendCollectionOffer(ctx, params, params.skipApproval);
    }

    console.log("\n✅ Opération terminée avec succès!");

  } catch (error) {
    console.error("\n❌ Erreur:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();
