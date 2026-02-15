/** RiskManager - Capital allocation, position tracking, risk alerts (table: risk_positions) */

import { getSupabaseClient } from "../utils/supabase";

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

function positionToRow(p: LoanPosition): RiskPositionRow {
  return {
    offer_id: p.offerId, collection: p.collection, collection_address: p.collectionAddress,
    loan_amount: p.loanAmount, apr: p.apr, duration_days: p.durationDays,
    start_date: p.startDate.toISOString(), end_date: p.endDate.toISOString(),
    collateral_floor_price: p.collateralFloorPrice,
    current_floor_price: p.currentFloorPrice ?? null,
    status: p.status, liquidation_risk: p.liquidationRisk,
  };
}

function rowToPosition(row: RiskPositionRow): LoanPosition {
  return {
    offerId: row.offer_id, collection: row.collection, collectionAddress: row.collection_address,
    loanAmount: row.loan_amount, apr: row.apr, durationDays: row.duration_days,
    startDate: new Date(row.start_date), endDate: new Date(row.end_date),
    collateralFloorPrice: row.collateral_floor_price,
    currentFloorPrice: row.current_floor_price ?? undefined,
    status: row.status as LoanPosition["status"],
    liquidationRisk: row.liquidation_risk,
  };
}

export class RiskManager {
  private positions: Map<string, LoanPosition> = new Map();
  private limits: RiskLimits;
  private initialized = false;

  constructor(limits: RiskLimits) {
    this.limits = limits;
  }

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

      for (const row of (data || []) as RiskPositionRow[]) {
        const position = rowToPosition(row);
        this.positions.set(position.offerId, position);
      }

      this.initialized = true;
      console.log(`[RiskManager] Loaded ${(data || []).length} active position(s)`);
    } catch (err: unknown) {
      console.error("[RiskManager] Init error:", err instanceof Error ? err.message : String(err));
      this.initialized = true;
    }
  }

  canAllocateCapital(collection: string, amount: number): { canAllocate: boolean; reason?: string } {
    if (!this.initialized) {
      return { canAllocate: false, reason: "RiskManager not initialized" };
    }

    const stats = this.getPortfolioStats();

    if (amount > stats.availableCapital) {
      return { canAllocate: false, reason: `Insufficient capital: need ${amount.toFixed(2)}, have ${stats.availableCapital.toFixed(2)} ETH` };
    }

    const newUtilization = (stats.deployedCapital + amount) / this.limits.maxCapitalEth;
    if (newUtilization > this.limits.maxUtilizationRate) {
      return { canAllocate: false, reason: `Utilization too high: ${(newUtilization * 100).toFixed(1)}%` };
    }

    const currentExposure = stats.totalExposure[collection] || 0;
    if (currentExposure + amount > this.limits.maxExposurePerCollection) {
      return { canAllocate: false, reason: `Collection exposure limit reached` };
    }

    if (this.getActiveLoansForCollection(collection).length >= this.limits.maxLoansPerCollection) {
      return { canAllocate: false, reason: `Max loans per collection reached` };
    }

    if (stats.activeLoans >= this.limits.maxActiveLoan) {
      return { canAllocate: false, reason: `Max active loans reached` };
    }

    if (stats.atRiskCapital > this.limits.maxCapitalEth * this.limits.liquidationRiskThreshold) {
      return { canAllocate: false, reason: `Too much capital at risk` };
    }

    return { canAllocate: true };
  }

  async registerLoan(position: LoanPosition): Promise<void> {
    this.positions.set(position.offerId, position);
    try {
      const { error } = await getSupabaseClient()
        .from("risk_positions")
        .upsert(positionToRow(position), { onConflict: "offer_id" });
      if (error) console.error("[RiskManager] DB save error:", error.message);
    } catch (err: unknown) {
      console.error("[RiskManager] DB save error:", err instanceof Error ? err.message : String(err));
    }
  }

  async updateLoanStatus(offerId: string, status: LoanPosition["status"]): Promise<void> {
    const position = this.positions.get(offerId);
    if (!position) return;
    position.status = status;

    try {
      const { error } = await getSupabaseClient()
        .from("risk_positions")
        .update({ status, updated_at: new Date().toISOString() })
        .eq("offer_id", offerId);
      if (error) console.error("[RiskManager] DB update error:", error.message);
    } catch (err: unknown) {
      console.error("[RiskManager] DB update error:", err instanceof Error ? err.message : String(err));
    }
  }

  async updateFloorPrice(offerId: string, currentFloorPrice: number, topBid?: number): Promise<void> {
    const position = this.positions.get(offerId);
    if (!position) return;

    position.currentFloorPrice = currentFloorPrice;
    const liquidationPrice = topBid && topBid > 0 ? topBid : currentFloorPrice;
    const effectiveLTV = position.loanAmount / liquidationPrice;

    if (effectiveLTV > 0.9) {
      position.liquidationRisk = Math.min(1, (effectiveLTV - 0.7) / 0.3);
    } else if (effectiveLTV > 0.7) {
      position.liquidationRisk = (effectiveLTV - 0.7) / 0.4;
    } else {
      position.liquidationRisk = 0;
    }

    try {
      const { error } = await getSupabaseClient()
        .from("risk_positions")
        .update({
          current_floor_price: currentFloorPrice,
          liquidation_risk: position.liquidationRisk,
          updated_at: new Date().toISOString(),
        })
        .eq("offer_id", offerId);
      if (error) console.error("[RiskManager] DB update error:", error.message);
    } catch (err: unknown) {
      console.error("[RiskManager] DB update error:", err instanceof Error ? err.message : String(err));
    }
  }

  getPortfolioStats(): PortfolioStats {
    const active = Array.from(this.positions.values()).filter(p => p.status === "active");
    const deployedCapital = active.reduce((sum, p) => sum + p.loanAmount, 0);

    const totalExposure: Record<string, number> = {};
    for (const p of active) {
      totalExposure[p.collection] = (totalExposure[p.collection] || 0) + p.loanAmount;
    }

    const totalExpectedReturn = active.reduce((sum, p) => {
      const daysRemaining = Math.max(0, (p.endDate.getTime() - Date.now()) / 86400000);
      return sum + (p.loanAmount * p.apr * daysRemaining) / 365;
    }, 0);

    const atRiskCapital = active
      .filter(p => p.liquidationRisk > 0.5)
      .reduce((sum, p) => sum + p.loanAmount, 0);

    const averageAPR = active.length > 0
      ? active.reduce((sum, p) => sum + p.apr, 0) / active.length
      : 0;

    return {
      totalCapital: this.limits.maxCapitalEth,
      deployedCapital,
      availableCapital: this.limits.maxCapitalEth - deployedCapital,
      activeLoans: active.length,
      totalExposure,
      utilizationRate: deployedCapital / this.limits.maxCapitalEth,
      averageAPR,
      totalExpectedReturn,
      atRiskCapital,
    };
  }

  getActiveLoansForCollection(collection: string): LoanPosition[] {
    return Array.from(this.positions.values()).filter(
      p => p.collection === collection && p.status === "active"
    );
  }

  getLoansAtRisk(threshold: number = 0.5): LoanPosition[] {
    return Array.from(this.positions.values()).filter(
      p => p.status === "active" && p.liquidationRisk >= threshold
    );
  }

  getActiveLoans(): LoanPosition[] {
    return Array.from(this.positions.values()).filter(p => p.status === "active");
  }

  getRiskAlerts(): string[] {
    const alerts: string[] = [];
    const stats = this.getPortfolioStats();

    if (stats.utilizationRate > this.limits.maxUtilizationRate) {
      alerts.push(`High utilization: ${(stats.utilizationRate * 100).toFixed(1)}%`);
    }
    if (stats.atRiskCapital > this.limits.maxCapitalEth * 0.2) {
      alerts.push(`High risk exposure: ${stats.atRiskCapital.toFixed(2)} ETH at liquidation risk`);
    }
    for (const [collection, exposure] of Object.entries(stats.totalExposure)) {
      if (exposure > this.limits.maxExposurePerCollection * 0.9) {
        alerts.push(`High concentration in ${collection}: ${exposure.toFixed(2)} ETH`);
      }
    }
    const atRisk = this.getLoansAtRisk(0.8);
    if (atRisk.length > 0) {
      alerts.push(`${atRisk.length} loan(s) at high liquidation risk`);
    }

    return alerts;
  }

  generateReport(): string {
    const stats = this.getPortfolioStats();
    const alerts = this.getRiskAlerts();

    const lines = [
      "PORTFOLIO REPORT",
      "=".repeat(50),
      `Capital: ${stats.deployedCapital.toFixed(2)}/${stats.totalCapital.toFixed(2)} ETH (${(stats.utilizationRate * 100).toFixed(1)}%)`,
      `Active Loans: ${stats.activeLoans} | Avg APR: ${(stats.averageAPR * 100).toFixed(2)}%`,
      `Expected Return: ${stats.totalExpectedReturn.toFixed(4)} ETH`,
      `At Risk: ${stats.atRiskCapital.toFixed(2)} ETH`,
    ];

    for (const [collection, exposure] of Object.entries(stats.totalExposure)) {
      const pct = stats.deployedCapital > 0 ? (exposure / stats.deployedCapital) * 100 : 0;
      lines.push(`  ${collection}: ${exposure.toFixed(2)} ETH (${pct.toFixed(1)}%)`);
    }

    if (alerts.length > 0) {
      lines.push("", "ALERTS:", ...alerts.map(a => `  ${a}`));
    }

    return lines.join("\n");
  }
}

export const DEFAULT_RISK_LIMITS: RiskLimits = {
  maxCapitalEth: 10.0,
  maxExposurePerCollection: 2.0,
  maxLoansPerCollection: 5,
  minReserveRatio: 0.2,
  maxUtilizationRate: 0.8,
  maxActiveLoan: 50,
  liquidationRiskThreshold: 0.3,
};
