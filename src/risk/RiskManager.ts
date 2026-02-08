/**
 * RiskManager.ts - Gestion du capital et du risque
 *
 * Responsabilités:
 * - Allocation du capital par collection
 * - Limites de position
 * - Diversification du portefeuille
 * - Suivi des prêts actifs
 * - Gestion des liquidations
 *
 * Les positions sont persistées dans Supabase (table risk_positions).
 * Au démarrage, les positions actives sont rechargées depuis la DB.
 *
 * Table SQL à créer dans Supabase:
 *
 * CREATE TABLE risk_positions (
 *   offer_id TEXT PRIMARY KEY,
 *   collection TEXT NOT NULL,
 *   collection_address TEXT NOT NULL,
 *   loan_amount DECIMAL NOT NULL,
 *   apr DECIMAL NOT NULL,
 *   duration_days INTEGER NOT NULL,
 *   start_date TIMESTAMPTZ NOT NULL,
 *   end_date TIMESTAMPTZ NOT NULL,
 *   collateral_floor_price DECIMAL NOT NULL,
 *   current_floor_price DECIMAL,
 *   status TEXT NOT NULL DEFAULT 'active',
 *   liquidation_risk DECIMAL NOT NULL DEFAULT 0,
 *   updated_at TIMESTAMPTZ DEFAULT NOW()
 * );
 *
 * CREATE INDEX idx_risk_positions_status ON risk_positions(status);
 * CREATE INDEX idx_risk_positions_collection ON risk_positions(collection);
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";

// ==================== TYPES ====================

export interface LoanPosition {
  offerId: string;
  collection: string;
  collectionAddress: string;
  loanAmount: number;
  apr: number;
  durationDays: number;
  startDate: Date;
  endDate: Date;
  collateralFloorPrice: number;
  currentFloorPrice?: number;
  status: "active" | "repaid" | "liquidated" | "defaulted";
  liquidationRisk: number;
}

export interface PortfolioStats {
  totalCapital: number;
  deployedCapital: number;
  availableCapital: number;
  activeLoans: number;
  totalExposure: Record<string, number>;
  utilizationRate: number;
  averageAPR: number;
  totalExpectedReturn: number;
  atRiskCapital: number;
}

export interface RiskLimits {
  maxCapitalEth: number;
  maxExposurePerCollection: number;
  maxLoansPerCollection: number;
  minReserveRatio: number;
  maxUtilizationRate: number;
  maxActiveLoan: number;
  liquidationRiskThreshold: number;
}

// ==================== DB ROW TYPE ====================

interface RiskPositionRow {
  offer_id: string;
  collection: string;
  collection_address: string;
  loan_amount: number;
  apr: number;
  duration_days: number;
  start_date: string;
  end_date: string;
  collateral_floor_price: number;
  current_floor_price: number | null;
  status: string;
  liquidation_risk: number;
}

// ==================== SUPABASE CLIENT ====================

let supabase: SupabaseClient | null = null;

function getSupabaseClient(): SupabaseClient {
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

// ==================== CONVERSION HELPERS ====================

function positionToRow(p: LoanPosition): RiskPositionRow {
  return {
    offer_id: p.offerId,
    collection: p.collection,
    collection_address: p.collectionAddress,
    loan_amount: p.loanAmount,
    apr: p.apr,
    duration_days: p.durationDays,
    start_date: p.startDate.toISOString(),
    end_date: p.endDate.toISOString(),
    collateral_floor_price: p.collateralFloorPrice,
    current_floor_price: p.currentFloorPrice ?? null,
    status: p.status,
    liquidation_risk: p.liquidationRisk,
  };
}

function rowToPosition(row: RiskPositionRow): LoanPosition {
  return {
    offerId: row.offer_id,
    collection: row.collection,
    collectionAddress: row.collection_address,
    loanAmount: row.loan_amount,
    apr: row.apr,
    durationDays: row.duration_days,
    startDate: new Date(row.start_date),
    endDate: new Date(row.end_date),
    collateralFloorPrice: row.collateral_floor_price,
    currentFloorPrice: row.current_floor_price ?? undefined,
    status: row.status as LoanPosition["status"],
    liquidationRisk: row.liquidation_risk,
  };
}

// ==================== RISK MANAGER ====================

export class RiskManager {
  private positions: Map<string, LoanPosition> = new Map();
  private limits: RiskLimits;
  private initialized = false;

  constructor(limits: RiskLimits) {
    this.limits = limits;
  }

  /**
   * Charge les positions actives depuis Supabase.
   * Doit être appelé une fois au démarrage du bot.
   */
  async init(): Promise<void> {
    try {
      const client = getSupabaseClient();

      const { data, error } = await client
        .from("risk_positions")
        .select("*")
        .in("status", ["active"]);

      if (error) {
        console.error("[RiskManager] DB load error:", error.message);
        this.initialized = true;
        return;
      }

      const rows = (data || []) as RiskPositionRow[];
      for (const row of rows) {
        const position = rowToPosition(row);
        this.positions.set(position.offerId, position);
      }

      this.initialized = true;
      console.log(`[RiskManager] Loaded ${rows.length} active position(s) from DB`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[RiskManager] Init error:", message);
      this.initialized = true;
    }
  }

  // ==================== CAPITAL MANAGEMENT ====================

  canAllocateCapital(
    collection: string,
    amount: number
  ): { canAllocate: boolean; reason?: string } {
    if (!this.initialized) {
      return { canAllocate: false, reason: "RiskManager not initialized (call init() first)" };
    }

    const stats = this.getPortfolioStats();

    if (amount > stats.availableCapital) {
      return {
        canAllocate: false,
        reason: `Insufficient capital: ${amount.toFixed(2)} ETH needed, ${stats.availableCapital.toFixed(2)} ETH available`,
      };
    }

    const newUtilization = (stats.deployedCapital + amount) / this.limits.maxCapitalEth;
    if (newUtilization > this.limits.maxUtilizationRate) {
      return {
        canAllocate: false,
        reason: `Utilization too high: ${(newUtilization * 100).toFixed(1)}% > ${(this.limits.maxUtilizationRate * 100).toFixed(1)}%`,
      };
    }

    const currentExposure = stats.totalExposure[collection] || 0;
    if (currentExposure + amount > this.limits.maxExposurePerCollection) {
      return {
        canAllocate: false,
        reason: `Collection exposure limit: ${(currentExposure + amount).toFixed(2)} ETH > ${this.limits.maxExposurePerCollection.toFixed(2)} ETH max`,
      };
    }

    const loansInCollection = this.getActiveLoansForCollection(collection).length;
    if (loansInCollection >= this.limits.maxLoansPerCollection) {
      return {
        canAllocate: false,
        reason: `Max loans per collection: ${loansInCollection} >= ${this.limits.maxLoansPerCollection}`,
      };
    }

    if (stats.activeLoans >= this.limits.maxActiveLoan) {
      return {
        canAllocate: false,
        reason: `Max active loans reached: ${stats.activeLoans} >= ${this.limits.maxActiveLoan}`,
      };
    }

    if (stats.atRiskCapital > this.limits.maxCapitalEth * this.limits.liquidationRiskThreshold) {
      return {
        canAllocate: false,
        reason: `Too much capital at risk: ${stats.atRiskCapital.toFixed(2)} ETH at liquidation risk`,
      };
    }

    return { canAllocate: true };
  }

  /**
   * Enregistre un nouveau prêt (mémoire + DB)
   */
  async registerLoan(position: LoanPosition): Promise<void> {
    this.positions.set(position.offerId, position);

    try {
      const client = getSupabaseClient();
      const { error } = await client
        .from("risk_positions")
        .upsert(positionToRow(position), { onConflict: "offer_id" });

      if (error) {
        console.error("[RiskManager] DB save error:", error.message);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[RiskManager] DB save error:", message);
    }
  }

  /**
   * Met à jour le statut d'un prêt (mémoire + DB)
   */
  async updateLoanStatus(
    offerId: string,
    status: LoanPosition["status"]
  ): Promise<void> {
    const position = this.positions.get(offerId);
    if (!position) return;

    position.status = status;

    try {
      const client = getSupabaseClient();
      const { error } = await client
        .from("risk_positions")
        .update({ status, updated_at: new Date().toISOString() })
        .eq("offer_id", offerId);

      if (error) {
        console.error("[RiskManager] DB update error:", error.message);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[RiskManager] DB update error:", message);
    }
  }

  /**
   * Met à jour le prix floor actuel et recalcule le risque de liquidation (mémoire + DB)
   */
  async updateFloorPrice(offerId: string, currentFloorPrice: number): Promise<void> {
    const position = this.positions.get(offerId);
    if (!position) return;

    position.currentFloorPrice = currentFloorPrice;

    const ltv = position.loanAmount / currentFloorPrice;
    if (ltv > 0.8) {
      position.liquidationRisk = Math.min(1, (ltv - 0.8) / 0.2);
    } else {
      position.liquidationRisk = 0;
    }

    try {
      const client = getSupabaseClient();
      const { error } = await client
        .from("risk_positions")
        .update({
          current_floor_price: currentFloorPrice,
          liquidation_risk: position.liquidationRisk,
          updated_at: new Date().toISOString(),
        })
        .eq("offer_id", offerId);

      if (error) {
        console.error("[RiskManager] DB update error:", error.message);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[RiskManager] DB update error:", message);
    }
  }

  // ==================== PORTFOLIO STATS ====================

  getPortfolioStats(): PortfolioStats {
    const activePositions = Array.from(this.positions.values()).filter(
      (p) => p.status === "active"
    );

    const deployedCapital = activePositions.reduce(
      (sum, p) => sum + p.loanAmount,
      0
    );

    const totalExposure: Record<string, number> = {};
    for (const position of activePositions) {
      totalExposure[position.collection] =
        (totalExposure[position.collection] || 0) + position.loanAmount;
    }

    const totalExpectedReturn = activePositions.reduce((sum, p) => {
      const daysRemaining = Math.max(
        0,
        (p.endDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24)
      );
      const annualizedReturn = p.loanAmount * p.apr;
      const expectedReturn = (annualizedReturn * daysRemaining) / 365;
      return sum + expectedReturn;
    }, 0);

    const atRiskCapital = activePositions
      .filter((p) => p.liquidationRisk > 0.5)
      .reduce((sum, p) => sum + p.loanAmount, 0);

    const averageAPR =
      activePositions.length > 0
        ? activePositions.reduce((sum, p) => sum + p.apr, 0) / activePositions.length
        : 0;

    return {
      totalCapital: this.limits.maxCapitalEth,
      deployedCapital,
      availableCapital: this.limits.maxCapitalEth - deployedCapital,
      activeLoans: activePositions.length,
      totalExposure,
      utilizationRate: deployedCapital / this.limits.maxCapitalEth,
      averageAPR,
      totalExpectedReturn,
      atRiskCapital,
    };
  }

  getActiveLoansForCollection(collection: string): LoanPosition[] {
    return Array.from(this.positions.values()).filter(
      (p) => p.collection === collection && p.status === "active"
    );
  }

  getLoansAtRisk(threshold: number = 0.5): LoanPosition[] {
    return Array.from(this.positions.values()).filter(
      (p) => p.status === "active" && p.liquidationRisk >= threshold
    );
  }

  getActiveLoans(): LoanPosition[] {
    return Array.from(this.positions.values()).filter(
      (p) => p.status === "active"
    );
  }

  // ==================== RISK ALERTS ====================

  getRiskAlerts(): string[] {
    const alerts: string[] = [];
    const stats = this.getPortfolioStats();

    if (stats.utilizationRate > this.limits.maxUtilizationRate) {
      alerts.push(
        `⚠️ High utilization: ${(stats.utilizationRate * 100).toFixed(1)}%`
      );
    }

    if (stats.atRiskCapital > this.limits.maxCapitalEth * 0.2) {
      alerts.push(
        `🚨 High risk exposure: ${stats.atRiskCapital.toFixed(2)} ETH at liquidation risk`
      );
    }

    for (const [collection, exposure] of Object.entries(stats.totalExposure)) {
      if (exposure > this.limits.maxExposurePerCollection * 0.9) {
        alerts.push(
          `⚠️ High concentration in ${collection}: ${exposure.toFixed(2)} ETH`
        );
      }
    }

    const atRisk = this.getLoansAtRisk(0.8);
    if (atRisk.length > 0) {
      alerts.push(
        `🚨 ${atRisk.length} loan(s) at high liquidation risk`
      );
    }

    return alerts;
  }

  // ==================== REPORTING ====================

  generateReport(): string {
    const stats = this.getPortfolioStats();
    const alerts = this.getRiskAlerts();

    const lines = [
      "📊 PORTFOLIO REPORT",
      "═".repeat(60),
      "",
      "💰 Capital:",
      `   Total:      ${stats.totalCapital.toFixed(2)} ETH`,
      `   Deployed:   ${stats.deployedCapital.toFixed(2)} ETH (${(stats.utilizationRate * 100).toFixed(1)}%)`,
      `   Available:  ${stats.availableCapital.toFixed(2)} ETH`,
      "",
      "📈 Performance:",
      `   Active Loans:       ${stats.activeLoans}`,
      `   Average APR:        ${(stats.averageAPR * 100).toFixed(2)}%`,
      `   Expected Return:    ${stats.totalExpectedReturn.toFixed(4)} ETH`,
      "",
      "⚠️  Risk:",
      `   At Risk Capital:    ${stats.atRiskCapital.toFixed(2)} ETH`,
      "",
      "📦 Exposure by Collection:",
    ];

    for (const [collection, exposure] of Object.entries(stats.totalExposure)) {
      const pct = stats.deployedCapital > 0 ? (exposure / stats.deployedCapital) * 100 : 0;
      lines.push(`   ${collection}: ${exposure.toFixed(2)} ETH (${pct.toFixed(1)}%)`);
    }

    if (alerts.length > 0) {
      lines.push("", "🚨 ALERTS:", ...alerts.map((a) => `   ${a}`));
    }

    lines.push("═".repeat(60));

    return lines.join("\n");
  }
}

// ==================== DEFAULT CONFIG ====================

export const DEFAULT_RISK_LIMITS: RiskLimits = {
  maxCapitalEth: 10.0,
  maxExposurePerCollection: 2.0,
  maxLoansPerCollection: 5,
  minReserveRatio: 0.2,
  maxUtilizationRate: 0.8,
  maxActiveLoan: 50,
  liquidationRiskThreshold: 0.3,
};
