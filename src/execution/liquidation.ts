/**
 * liquidation.ts - Détecte et exécute les liquidations de prêts en défaut
 *
 * Pour Gondi:
 *   - Fetch nos prêts actifs via gondi.loans()
 *   - Détecte ceux qui ont dépassé startTime + duration (= en défaut)
 *   - Appelle gondi.liquidateLoan() pour saisir le collatéral NFT
 *
 * Pour Blur:
 *   - Les prêts Blur sont rolling (pas de date d'expiration fixe)
 *   - Le lender peut initier un repay/recall via POST /v1/blend/lien/repay
 *   - On monitor le LTV et on trigger le recall si le floor chute trop
 */

import { GondiContext } from "./send-gondi-offer";
import { LoanStatusType } from "gondi";
import {
  fetchActiveBlurLoans,
  triggerBlurRepay,
} from "../adapters/BlurAdapter";
import { getLatestFloorPrice } from "../utils/price-db";
import { findCollectionByAddress } from "../utils/collections-loader";

// ==================== TYPES ====================

export interface LiquidationResult {
  checked: number;
  liquidated: number;
  errors: number;
  alerts: string[];
}

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

function formatEthAmount(amount: bigint, decimals: number): string {
  const divisor = BigInt(10 ** decimals);
  const whole = amount / divisor;
  const fraction = amount % divisor;
  const fractionStr = fraction.toString().padStart(decimals, "0").slice(0, 4);
  return `${whole}.${fractionStr}`;
}

// ==================== MAIN ====================

/**
 * Check for defaulted loans and liquidate them.
 * A loan is defaulted when: now > startTime + duration (in seconds)
 */
export async function checkAndLiquidate(
  gondiCtx: GondiContext,
  sendOffers: boolean
): Promise<LiquidationResult> {
  const result: LiquidationResult = {
    checked: 0,
    liquidated: 0,
    errors: 0,
    alerts: [],
  };

  try {
    // Fetch our active loans on Gondi
    const walletAddress = gondiCtx.walletAddress.toLowerCase() as `0x${string}`;

    const loansResponse = await gondiCtx.gondi.loans({
      statuses: [LoanStatusType.LoanInitiated],
      limit: 50,
    });

    const allLoans = loansResponse.loans as unknown as GondiLoan[];

    // Filter loans where we are a lender (in any source/tranche)
    const ourLoans = allLoans.filter(loan =>
      loan.source.some(s => s.lenderAddress.toLowerCase() === walletAddress)
    );

    result.checked = ourLoans.length;

    if (ourLoans.length === 0) {
      return result;
    }

    const now = BigInt(Math.floor(Date.now() / 1000));

    for (const loan of ourLoans) {
      const endTime = loan.startTime + loan.duration;
      const isExpired = now > endTime;

      if (!isExpired) continue;

      // Loan has defaulted
      const collectionName = loan.nft?.collection?.name || "Unknown";
      const collectionSlug = loan.nft?.collection?.slug || "unknown";
      const amount = formatEthAmount(loan.principalAmount, loan.currency.decimals);
      const overdueSec = Number(now - endTime);
      const overdueHours = (overdueSec / 3600).toFixed(1);

      const alertMsg = `${collectionName} | ${amount} ${loan.currency.symbol} | Overdue ${overdueHours}h`;

      if (sendOffers) {
        // Attempt liquidation
        try {
          console.log(`  ⚠️  Liquidating loan ${loan.loanId} (${collectionSlug})...`);

          const txResult = await gondiCtx.gondi.liquidateLoan({
            loan: loan as unknown as Parameters<typeof gondiCtx.gondi.liquidateLoan>[0]["loan"],
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
        // Dry-run mode
        console.log(`  📋 [DRY-RUN] Would liquidate loan ${loan.loanId}: ${alertMsg}`);
        result.alerts.push(`📋 DEFAULT DETECTED | ${alertMsg}`);
      }
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`❌ Liquidation check failed: ${errMsg}`);
    result.errors++;
    result.alerts.push(`❌ Liquidation check error: ${errMsg}`);
  }

  return result;
}

// ==================== BLUR LOAN MONITORING ====================

/** LTV threshold above which we trigger a recall */
const BLUR_RECALL_LTV = 0.90;

/** LTV threshold for Telegram warning (before recall) */
const BLUR_WARN_LTV = 0.85;

export interface BlurMonitorResult {
  checked: number;
  recalled: number;
  warnings: number;
  errors: number;
  alerts: string[];
}

/**
 * Reverse-lookup: collection address → collections.json slug for price DB.
 */
function blurAddressToSlug(address: string): string {
  const col = findCollectionByAddress(address);
  return col?.slug || address;
}

/**
 * Monitor active Blur Blend loans.
 * If LTV exceeds BLUR_RECALL_LTV, trigger a repay/recall.
 * If LTV exceeds BLUR_WARN_LTV, send a warning.
 */
export async function checkBlurLoans(sendOffers: boolean): Promise<BlurMonitorResult> {
  const result: BlurMonitorResult = {
    checked: 0,
    recalled: 0,
    warnings: 0,
    errors: 0,
    alerts: [],
  };

  try {
    const liens = await fetchActiveBlurLoans();

    if (liens.length === 0) {
      return result;
    }

    result.checked = liens.length;
    console.log(`  [blur-monitor] ${liens.length} active lien(s) found`);

    for (const lien of liens) {
      const collection = lien.collection?.toLowerCase() || "";
      const slug = blurAddressToSlug(collection);
      const loanAmount = parseFloat(lien.remainingBalance || lien.borrowAmount);

      if (isNaN(loanAmount) || loanAmount <= 0) continue;

      // Get current floor price
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
        // LTV critical — trigger recall
        const alertMsg = `🚨 BLUR RECALL | ${slug} | lien ${lien.lienId} | LTV ${pct} | ${loanAmount.toFixed(3)} ETH / floor ${floor.toFixed(3)}`;
        console.log(`  ${alertMsg}`);

        if (sendOffers) {
          const repayResult = await triggerBlurRepay(collection, lien.lienId, lien.tokenId);
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
        // LTV warning — alert only
        result.warnings++;
        result.alerts.push(`⚠️ BLUR WARNING | ${slug} lien ${lien.lienId} | LTV ${pct}`);
        console.log(`  [blur-monitor] ⚠️ ${slug} lien ${lien.lienId}: LTV ${pct} (warn threshold)`);
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
