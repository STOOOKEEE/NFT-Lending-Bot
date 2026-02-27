/**
 * GondiPlatform.ts - Implémentation LendingPlatform pour Gondi
 *
 * Encapsule: init SDK, sync marché (GraphQL), send offer, track, liquidate.
 * Remplace les fonctions loose de send-gondi-offer.ts et gondi-fetcher.ts.
 */

import "dotenv/config";
import { Gondi, LoanStatusType } from "gondi";
import { createWalletClient, createPublicClient, http, parseEther, formatEther, Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import {
  LendingPlatform,
  NormalizedOffer,
  OfferResult,
  PlatformMarketOffer,
  TrackingResult,
  LiquidationCheckResult,
} from "./LendingPlatform";
import { RiskManager } from "../risk/RiskManager";
import { addOffer, createOfferFromGondiResponse, getOffersByLender, updateOfferStatus } from "../utils/lending-db";
import { getAllOffers as fetchGondiOffers, listOffers, OfferStatus, Offer } from "../collectors/gondi-fetcher";
import { replaceAllOffers, getOffersByCollection, BestOfferRecord } from "../utils/gondi-db";
import { getDurationBucket, getEthUsdPrice, toETHEquivalent } from "../utils/helpers";

// ==================== CONFIG ====================

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
const ORIGINATION_FEE_USD = 1;

// ==================== INTERNAL TYPES ====================

type ViemPublicClient = ReturnType<typeof createPublicClient>;
type ViemWalletClient = ReturnType<typeof createWalletClient>;

interface GondiLoan {
  id: string;
  loanId: number;
  contractAddress: `0x${string}`;
  borrowerAddress: `0x${string}`;
  principalAmount: bigint;
  duration: bigint;
  startTime: bigint;
  status: string;
  nftCollateralTokenId: bigint;
  nftCollateralAddress: `0x${string}` | undefined;
  borrower: `0x${string}`;
  source: {
    lender: `0x${string}`;
    loanId: bigint;
    startTime: bigint;
    originationFee: bigint;
    principalAmount: bigint;
    lenderAddress: string;
    accruedInterest: bigint;
    aprBps: bigint;
  }[];
  protocolFee: bigint;
  principalAddress: `0x${string}`;
  blendedAprBps: number;
  nft: {
    tokenId: bigint;
    collection?: {
      slug: string;
      name?: string | null;
    } | null;
  };
  currency: {
    symbol: string;
    decimals: number;
  };
}

// ==================== HELPERS ====================

/** Round a bigint DOWN to the nearest multiple of step */
function roundToStep(value: bigint, step: bigint): bigint {
  if (step <= 0n) return value;
  return (value / step) * step;
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

function timestampToISODate(timestamp: string): string {
  const num = parseInt(timestamp);
  if (!isNaN(num) && num > 1000000000) {
    return new Date(num * 1000).toISOString();
  }
  return new Date(timestamp).toISOString();
}

function formatEthAmount(amount: bigint, decimals: number): string {
  const divisor = BigInt(10 ** decimals);
  const whole = amount / divisor;
  const fraction = amount % divisor;
  const fractionStr = fraction.toString().padStart(decimals, "0").slice(0, 4);
  return `${whole}.${fractionStr}`;
}

// ==================== CLASS ====================

export class GondiPlatform extends LendingPlatform {
  readonly name = "gondi";

  private gondi: Gondi | null = null;
  private walletClient: ViemWalletClient | null = null;
  private publicClient: ViemPublicClient | null = null;
  private walletAddress: Address | null = null;
  private initialized = false;
  /** Cache of collection offer steps (collectionId → steps) */
  private stepsCache = new Map<number, { wethStep: bigint; aprBpsStep: bigint }>();

  async init(): Promise<void> {
    const privateKey = process.env.WALLET_PRIVATE_KEY;
    if (!privateKey) {
      throw new Error("WALLET_PRIVATE_KEY not set in .env");
    }

    const cleanKey = (privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) as `0x${string}`;
    const account = privateKeyToAccount(cleanKey);
    const rpcUrl = process.env.RPC_URL || "https://eth-mainnet.g.alchemy.com/v2/demo";

    const walletClient = createWalletClient({
      account,
      transport: http(rpcUrl),
      chain: mainnet,
    });

    this.walletClient = walletClient;

    this.publicClient = createPublicClient({
      transport: http(rpcUrl),
      chain: mainnet,
    });

    // walletClient has `account` set — Gondi needs this
    this.gondi = new Gondi({ wallet: walletClient });
    this.walletAddress = account.address;
    this.initialized = true;

    console.log(`🔐 Gondi client initialized: ${account.address}`);
  }

  /** Gondi supports all collections (collection-wide offers) */
  isCollectionSupported(_collectionAddress: string): boolean {
    return true;
  }

  async getAvailableBalance(): Promise<number> {
    this.ensureInitialized();
    const balance = await this.publicClient!.readContract({
      address: WETH_ADDRESS,
      abi: WETH_ABI,
      functionName: "balanceOf",
      args: [this.walletAddress!],
    }) as bigint;
    return parseFloat(formatEther(balance));
  }

  // ==================== MARKET SYNC ====================

  async syncMarketData(): Promise<void> {
    console.log("  [gondi] Syncing offers from Gondi API...");

    const offers = await fetchGondiOffers({
      statuses: [OfferStatus.Active],
      onlyCollectionOffers: true,
    });

    console.log(`  [gondi] Found ${offers.length} active collection offers`);

    const bestOffers = await this.findBestOffersPerDuration(offers);
    console.log(`  [gondi] Processed ${bestOffers.length} best offers`);

    const result = await replaceAllOffers(bestOffers);
    console.log(`  [gondi] Saved to DB: ${result.success} success, ${result.failed} failed`);
  }

  async getMarketOffers(collectionSlug: string): Promise<PlatformMarketOffer[]> {
    const gondiOffers = await getOffersByCollection(collectionSlug);
    const ethUsdPrice = await getEthUsdPrice();
    const results: PlatformMarketOffer[] = [];

    for (const offer of gondiOffers) {
      // Type 1: best APR
      results.push({
        collection: collectionSlug,
        collectionAddress: "",
        durationDays: offer.duration_days,
        bestAprDecimal: offer.best_apr_percent / 100,
        bestAprAmount: toETHEquivalent(offer.best_apr_amount, offer.best_apr_currency || "WETH", ethUsdPrice),
        bestPrincipalAmount: toETHEquivalent(offer.best_principal_amount, offer.best_principal_currency || "WETH", ethUsdPrice),
        bestPrincipalAprDecimal: offer.best_principal_apr / 100,
        offerType: "best_apr",
      });
    }

    return results;
  }

  // ==================== SEND OFFER ====================

  async sendOffer(offer: NormalizedOffer): Promise<OfferResult> {
    this.ensureInitialized();

    const { collection: slug, loanAmount: amountEth, aprBps, durationDays } = offer;
    const aprPercent = aprBps / 100;

    try {
      // Resolve collection ID
      let collectionId: number;
      if (slug.startsWith("0x")) {
        const result = await this.gondi!.collectionId({ contractAddress: slug as `0x${string}` });
        const ids = Array.isArray(result) ? result : [result];
        if (!ids.length || typeof ids[0] !== "number") {
          return { success: false, error: `Collection not found: ${slug}` };
        }
        collectionId = ids[0];
      } else {
        const result = await this.gondi!.collectionId({ slug });
        const ids = Array.isArray(result) ? result : [result];
        if (!ids.length || typeof ids[0] !== "number") {
          return { success: false, error: `Collection not found: ${slug}` };
        }
        collectionId = ids[0];
      }

      // Get collection metadata
      let collectionName: string | undefined;
      let collectionAddress: string | undefined = slug.startsWith("0x") ? slug : undefined;
      try {
        const collectionData = await this.gondi!.collections({ collections: [collectionId] });
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

      // Query collection steps and round to valid increments
      const steps = await this.getCollectionSteps(collectionId);

      let principalWei = ethToWei(amountEth);
      let bps = aprPercentToBps(aprPercent);

      if (steps) {
        principalWei = roundToStep(principalWei, steps.wethStep);
        bps = roundToStep(bps, steps.aprBpsStep);
        if (principalWei <= 0n || bps <= 0n) {
          return { success: false, error: `Amount or APR too small after rounding to Gondi steps (wethStep=${steps.wethStep}, aprBpsStep=${steps.aprBpsStep})` };
        }
      }

      const capacityWei = principalWei;
      const maxSeniorRepayment = (principalWei * (10000n + bps * BigInt(durationDays) / 365n)) / 10000n;

      // Check WETH balance
      await this.checkWethBalance(capacityWei);

      // Check and approve WETH
      await this.checkAndApproveWeth(capacityWei);

      // Compute origination fee (~$1 in ETH)
      const ethPrice = await getEthUsdPrice();
      let feeWei = ethToWei(ORIGINATION_FEE_USD / ethPrice);
      if (steps) {
        feeWei = roundToStep(feeWei, steps.wethStep);
      }

      // Send offer
      const roundedAmountEth = parseFloat(formatEther(principalWei));
      const roundedAprPercent = Number(bps) / 100;
      const feeEth = parseFloat(formatEther(feeWei));
      console.log(`  [gondi] Sending: ${slug} | ${roundedAmountEth} ETH | ${roundedAprPercent}% | ${durationDays}d | fee ${feeEth.toFixed(6)} ETH (~$${ORIGINATION_FEE_USD}) | collectionId=${collectionId}`);
      const gondiOffer = await this.gondi!.makeCollectionOffer({
        collectionId,
        principalAddress: WETH_ADDRESS,
        principalAmount: principalWei,
        capacity: capacityWei,
        fee: feeWei,
        aprBps: bps,
        expirationTime: getExpirationTime(DEFAULT_EXPIRATION_MINUTES),
        duration: daysToSeconds(durationDays),
        requiresLiquidation: true,
        maxSeniorRepayment,
      });

      if (gondiOffer?.id) {
        try {
          const dbOffer = createOfferFromGondiResponse(gondiOffer, {
            id: collectionId,
            address: collectionAddress,
            name: collectionName,
          });
          await addOffer(dbOffer);
        } catch {
          // Best effort
        }
        return { success: true, offerId: String(gondiOffer.id) };
      }

      return { success: false, error: "No offer ID returned" };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, error: msg };
    }
  }

  // ==================== TRACKING ====================

  async trackOffers(lenderAddress: string, riskManager: RiskManager): Promise<TrackingResult> {
    const result: TrackingResult = { checked: 0, executed: 0, cancelled: 0, expired: 0, errors: 0 };

    const localActiveOffers = await getOffersByLender(lenderAddress, "gondi", "ACTIVE");
    if (localActiveOffers.length === 0) return result;

    result.checked = localActiveOffers.length;

    const gondiResult = await listOffers({
      lenders: [lenderAddress.toLowerCase()],
      limit: 100,
    });

    const gondiByOfferId = new Map<string, string>();
    for (const offer of gondiResult.offers) {
      gondiByOfferId.set(offer.offerId, offer.status);
    }

    for (const localOffer of localActiveOffers) {
      try {
        const gondiStatus = gondiByOfferId.get(localOffer.offer_id);

        if (!gondiStatus) {
          const isExpired = new Date(localOffer.expiration_time) < new Date();
          if (isExpired) {
            await updateOfferStatus(localOffer.id, "EXPIRED");
            await riskManager.updateLoanStatus(localOffer.id, "repaid");
            result.expired++;
          }
          continue;
        }

        if (gondiStatus === OfferStatus.Executed) {
          await updateOfferStatus(localOffer.id, "EXECUTED");
          await riskManager.registerLoan({
            offerId: localOffer.offer_id,
            collection: localOffer.collection_name || localOffer.collection_address || "",
            collectionAddress: localOffer.collection_address || "",
            loanAmount: localOffer.principal_eth,
            apr: localOffer.apr_percent / 100,
            durationDays: localOffer.duration_days,
            startDate: new Date(),
            endDate: new Date(Date.now() + localOffer.duration_days * 86400000),
            collateralFloorPrice: 0,
            status: "active",
            liquidationRisk: 0,
          });
          result.executed++;
          console.log(`  ✅ Offer ${localOffer.offer_id} EXECUTED for ${localOffer.collection_name || localOffer.collection_address}`);
        } else if (gondiStatus === OfferStatus.Cancelled) {
          await updateOfferStatus(localOffer.id, "CANCELLED");
          await riskManager.updateLoanStatus(localOffer.id, "repaid");
          result.cancelled++;
          console.log(`  🚫 Offer ${localOffer.offer_id} CANCELLED`);
        } else if (gondiStatus === OfferStatus.Expired || gondiStatus === OfferStatus.Inactive) {
          await updateOfferStatus(localOffer.id, "EXPIRED");
          await riskManager.updateLoanStatus(localOffer.id, "repaid");
          result.expired++;
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`  ❌ Error tracking offer ${localOffer.offer_id}: ${message}`);
        result.errors++;
      }
    }

    return result;
  }

  // ==================== LIQUIDATION ====================

  async checkAndLiquidate(dryRun: boolean): Promise<LiquidationCheckResult> {
    this.ensureInitialized();

    const result: LiquidationCheckResult = {
      checked: 0, liquidated: 0, recalled: 0, warnings: 0, errors: 0, alerts: [],
    };

    try {
      const walletAddr = this.walletAddress!.toLowerCase() as `0x${string}`;
      const loansResponse = await this.gondi!.loans({
        statuses: [LoanStatusType.LoanInitiated],
        limit: 50,
      });

      const allLoans = loansResponse.loans as unknown as GondiLoan[];
      const ourLoans = allLoans.filter(loan =>
        loan.source.some(s => s.lenderAddress.toLowerCase() === walletAddr)
      );

      result.checked = ourLoans.length;
      if (ourLoans.length === 0) return result;

      const now = BigInt(Math.floor(Date.now() / 1000));

      for (const loan of ourLoans) {
        const endTime = loan.startTime + loan.duration;
        if (now <= endTime) continue;

        const collectionName = loan.nft?.collection?.name || "Unknown";
        const amount = formatEthAmount(loan.principalAmount, loan.currency.decimals);
        const overdueHours = (Number(now - endTime) / 3600).toFixed(1);
        const alertMsg = `${collectionName} | ${amount} ${loan.currency.symbol} | Overdue ${overdueHours}h`;

        if (!dryRun) {
          try {
            console.log(`  ⚠️  Liquidating loan ${loan.loanId}...`);
            const gondiRef = this.gondi!;
            const txResult = await gondiRef.liquidateLoan({
              loan: loan as unknown as Parameters<typeof gondiRef.liquidateLoan>[0]["loan"],
              loanId: BigInt(loan.loanId),
            });
            const receipt = await txResult.waitTxInBlock();
            console.log(`  ✅ Liquidated loan ${loan.loanId} - tx: ${receipt.blockHash}`);
            result.liquidated++;
            result.alerts.push(`✅ LIQUIDATED | ${alertMsg}`);
          } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error(`  ❌ Liquidation failed for loan ${loan.loanId}: ${errMsg}`);
            result.errors++;
            result.alerts.push(`❌ LIQUIDATION FAILED | ${alertMsg} | ${errMsg}`);
          }
        } else {
          console.log(`  📋 [DRY-RUN] Would liquidate loan ${loan.loanId}: ${alertMsg}`);
          result.alerts.push(`📋 DEFAULT DETECTED | ${alertMsg}`);
        }
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`❌ Gondi liquidation check failed: ${errMsg}`);
      result.errors++;
      result.alerts.push(`❌ Gondi liquidation error: ${errMsg}`);
    }

    return result;
  }

  // ==================== PRIVATE HELPERS ====================

  private async getCollectionSteps(collectionId: number): Promise<{ wethStep: bigint; aprBpsStep: bigint } | null> {
    const cached = this.stepsCache.get(collectionId);
    if (cached) return cached;

    try {
      const result = await this.gondi!.collectionStepsById({ collectionId });
      const steps = { wethStep: result.wethStep, aprBpsStep: result.aprBpsStep };
      this.stepsCache.set(collectionId, steps);
      console.log(`  [gondi] Steps for collection ${collectionId}: wethStep=${result.wethStep}, aprBpsStep=${result.aprBpsStep}`);
      return steps;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  [gondi] Could not fetch steps for collection ${collectionId}: ${msg}`);
      return null;
    }
  }

  private ensureInitialized(): void {
    if (!this.initialized || !this.gondi || !this.walletClient || !this.publicClient || !this.walletAddress) {
      throw new Error("GondiPlatform not initialized. Call init() first.");
    }
  }

  private async checkWethBalance(requiredAmount: bigint): Promise<void> {
    const balance = await this.publicClient!.readContract({
      address: WETH_ADDRESS,
      abi: WETH_ABI,
      functionName: "balanceOf",
      args: [this.walletAddress!],
    }) as bigint;

    console.log(`  💰 WETH: ${formatEther(balance)} (need ${formatEther(requiredAmount)})`);

    if (balance < requiredAmount) {
      throw new Error(`Insufficient WETH: have ${formatEther(balance)}, need ${formatEther(requiredAmount)}`);
    }
  }

  private async checkAndApproveWeth(requiredAmount: bigint): Promise<void> {
    const allowance = await this.publicClient!.readContract({
      address: WETH_ADDRESS,
      abi: WETH_ABI,
      functionName: "allowance",
      args: [this.walletAddress!, MSL_CONTRACT_V3_1],
    }) as bigint;

    if (allowance < requiredAmount) {
      console.log(`  🔓 Approving WETH for Gondi MSL...`);
      const maxApproval = BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
      const hash = await this.walletClient!.writeContract({
        account: this.walletAddress!,
        chain: mainnet,
        address: WETH_ADDRESS,
        abi: WETH_ABI,
        functionName: "approve",
        args: [MSL_CONTRACT_V3_1, maxApproval],
      });
      await this.publicClient!.waitForTransactionReceipt({ hash });
      console.log(`  ✅ WETH approved`);
    }
  }

  private async findBestOffersPerDuration(offers: Offer[]): Promise<BestOfferRecord[]> {
    const ethUsdPrice = await getEthUsdPrice();
    // Exclude our own offers so we don't undercut ourselves
    const ourAddress = this.walletAddress?.toLowerCase() || "";
    const collectionOffers = offers.filter(o =>
      o.collection && !o.nft && o.lenderAddress.toLowerCase() !== ourAddress
    );
    const grouped = new Map<string, Offer[]>();

    for (const offer of collectionOffers) {
      const slug = offer.collection?.slug || "unknown";
      const durationDays = Math.floor(parseInt(offer.duration) / 86400);
      const bucket = getDurationBucket(durationDays);
      const key = `${slug}|${bucket}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(offer);
    }

    const results: BestOfferRecord[] = [];

    for (const [key, groupOffers] of grouped.entries()) {
      const [slug, bucketStr] = key.split("|");
      const bucket = parseInt(bucketStr);

      let bestByPrincipal: Offer | null = null;
      let bestPrincipalETH = -Infinity;
      let bestByApr: Offer | null = null;
      let lowestApr = Infinity;

      for (const offer of groupOffers) {
        const principal = parseFloat(offer.principalAmount) / Math.pow(10, offer.currency.decimals);
        const principalETH = toETHEquivalent(principal, offer.currency.symbol, ethUsdPrice);
        const apr = parseInt(offer.aprBps) / 100;

        if (principalETH > bestPrincipalETH) {
          bestPrincipalETH = principalETH;
          bestByPrincipal = offer;
        }
        if (apr < lowestApr) {
          lowestApr = apr;
          bestByApr = offer;
        }
      }

      if (bestByPrincipal && bestByApr) {
        const p1 = parseFloat(bestByPrincipal.principalAmount) / Math.pow(10, bestByPrincipal.currency.decimals);
        const p2 = parseFloat(bestByApr.principalAmount) / Math.pow(10, bestByApr.currency.decimals);

        results.push({
          collection_name: bestByPrincipal.collection?.name || "Unknown",
          collection_slug: slug,
          duration_days: bucket,
          best_principal_amount: p1,
          best_principal_currency: bestByPrincipal.currency.symbol,
          best_principal_apr: parseInt(bestByPrincipal.aprBps) / 100,
          best_principal_offer_id: bestByPrincipal.offerId,
          best_principal_lender: bestByPrincipal.lenderAddress,
          best_principal_expiration: timestampToISODate(bestByPrincipal.expirationTime),
          best_apr_amount: p2,
          best_apr_currency: bestByApr.currency.symbol,
          best_apr_percent: parseInt(bestByApr.aprBps) / 100,
          best_apr_offer_id: bestByApr.offerId,
          best_apr_lender: bestByApr.lenderAddress,
          best_apr_expiration: timestampToISODate(bestByApr.expirationTime),
        });
      }
    }

    return results;
  }

  /** Expose wallet address for external use (e.g., tracking) */
  getWalletAddress(): string {
    this.ensureInitialized();
    return this.walletAddress!;
  }
}
