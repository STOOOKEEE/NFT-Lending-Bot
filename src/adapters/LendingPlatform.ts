/**
 * LendingPlatform.ts - Abstract base class for all lending platforms
 *
 * Chaque plateforme (Gondi, Blur, future) implémente cette interface.
 * La stratégie et le bot itèrent sur LendingPlatform[] au lieu de
 * coder en dur des branches if/else par plateforme.
 */

import { RiskManager } from "../risk/RiskManager";

// ==================== NORMALIZED TYPES ====================

/** Offer normalisée cross-plateforme */
export interface NormalizedOffer {
  platform: string;
  collection: string;
  collectionAddress: string;
  loanAmount: number;
  aprBps: number;
  durationDays: number;
  ltv: number;
  offerType: "best_apr" | "best_principal";
}

/** Résultat d'envoi d'offre */
export interface OfferResult {
  success: boolean;
  offerId?: string;
  offerHash?: string;
  error?: string;
}

/** Données marché normalisées pour une (collection, durée) */
export interface PlatformMarketOffer {
  collection: string;
  collectionAddress: string;
  durationDays: number;
  bestAprDecimal: number;
  bestAprAmount: number;
  bestPrincipalAmount: number;
  bestPrincipalAprDecimal: number;
  offerType: "best_apr" | "best_principal";
}

/** Résultat de tracking des offres */
export interface TrackingResult {
  checked: number;
  executed: number;
  cancelled: number;
  expired: number;
  errors: number;
}

/** Résultat de vérification des liquidations */
export interface LiquidationCheckResult {
  checked: number;
  liquidated: number;
  recalled: number;
  warnings: number;
  errors: number;
  alerts: string[];
}

// ==================== ABSTRACT CLASS ====================

export abstract class LendingPlatform {
  /** Nom de la plateforme ("gondi", "blur") */
  abstract readonly name: string;

  /**
   * Initialise la plateforme (wallet, SDK, auth).
   * Appelé une fois au démarrage.
   */
  abstract init(): Promise<void>;

  /**
   * Retourne true si la collection est supportée sur cette plateforme.
   */
  abstract isCollectionSupported(collectionAddress: string): boolean;

  /**
   * Récupère le solde disponible pour prêter (ETH).
   */
  abstract getAvailableBalance(): Promise<number>;

  /**
   * Synchronise les données marché (offres concurrentes) et les sauvegarde en DB.
   */
  abstract syncMarketData(): Promise<void>;

  /**
   * Retourne les meilleures offres marché pour une collection donnée.
   * La stratégie utilise ces données pour décider de l'undercut.
   */
  abstract getMarketOffers(collectionSlug: string): Promise<PlatformMarketOffer[]>;

  /**
   * Envoie une offre de prêt sur la plateforme.
   */
  abstract sendOffer(offer: NormalizedOffer): Promise<OfferResult>;

  /**
   * Suit le statut de nos offres (ACTIVE → EXECUTED/EXPIRED/CANCELLED).
   */
  abstract trackOffers(lenderAddress: string, riskManager: RiskManager): Promise<TrackingResult>;

  /**
   * Vérifie les prêts actifs et liquide/recall si nécessaire.
   */
  abstract checkAndLiquidate(dryRun: boolean): Promise<LiquidationCheckResult>;
}
