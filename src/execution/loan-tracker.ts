/**
 * loan-tracker.ts - Suit le statut des offres envoyées par le bot
 *
 * Poll l'API Gondi pour détecter :
 * - Offres acceptées (EXECUTED) -> enregistrer le prêt actif
 * - Offres annulées (CANCELLED) -> nettoyer
 * - Offres expirées (EXPIRED) -> nettoyer
 *
 * Met à jour le RiskManager et la DB lending_offers en conséquence.
 */

import { listOffers, OfferStatus } from "../collectors/gondi-fetcher";
import { getOffersByLender, updateOfferStatus } from "../utils/lending-db";
import { RiskManager } from "../risk/RiskManager";

// ==================== TYPES ====================

export interface TrackingResult {
  checked: number;
  executed: number;
  cancelled: number;
  expired: number;
  errors: number;
}

// ==================== TRACKER ====================

/**
 * Vérifie le statut actuel de nos offres sur Gondi et met à jour la DB + RiskManager
 */
export async function trackOurOffers(
  lenderAddress: string,
  riskManager: RiskManager
): Promise<TrackingResult> {
  const result: TrackingResult = {
    checked: 0,
    executed: 0,
    cancelled: 0,
    expired: 0,
    errors: 0,
  };

  // 1. Récupérer nos offres actives en DB locale
  const localActiveOffers = await getOffersByLender(lenderAddress, "gondi", "ACTIVE");

  if (localActiveOffers.length === 0) {
    return result;
  }

  result.checked = localActiveOffers.length;

  // 2. Récupérer nos offres depuis Gondi (toutes statuts confondus)
  // On cherche par lender pour ne récupérer que les nôtres
  const gondiResult = await listOffers({
    lenders: [lenderAddress.toLowerCase()],
    limit: 100,
  });

  // Indexer par offerId pour lookup rapide
  const gondiByOfferId = new Map<string, string>();
  for (const offer of gondiResult.offers) {
    gondiByOfferId.set(offer.offerId, offer.status);
  }

  // 3. Comparer et mettre à jour
  for (const localOffer of localActiveOffers) {
    try {
      const gondiStatus = gondiByOfferId.get(localOffer.offer_id);

      if (!gondiStatus) {
        // Offre pas trouvée sur Gondi - probablement expirée
        // Vérifier si elle est passée sa date d'expiration
        const isExpired = new Date(localOffer.expiration_time) < new Date();
        if (isExpired) {
          await updateOfferStatus(localOffer.id, "EXPIRED");
          await riskManager.updateLoanStatus(localOffer.id, "repaid");
          result.expired++;
        }
        continue;
      }

      // Offre exécutée = un emprunteur l'a acceptée
      if (gondiStatus === OfferStatus.Executed) {
        await updateOfferStatus(localOffer.id, "EXECUTED");
        // Le prêt est maintenant actif dans le RiskManager (déjà enregistré au moment de l'envoi)
        // On ne fait rien de plus - le RiskManager suit déjà cette position
        result.executed++;
        console.log(`  ✅ Offer ${localOffer.offer_id} EXECUTED for ${localOffer.collection_name || localOffer.collection_address}`);
      }

      // Offre annulée
      if (gondiStatus === OfferStatus.Cancelled) {
        await updateOfferStatus(localOffer.id, "CANCELLED");
        await riskManager.updateLoanStatus(localOffer.id, "repaid");
        result.cancelled++;
        console.log(`  🚫 Offer ${localOffer.offer_id} CANCELLED`);
      }

      // Offre expirée
      if (gondiStatus === OfferStatus.Expired || gondiStatus === OfferStatus.Inactive) {
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

/**
 * Formate un résultat de tracking pour les logs
 */
export function formatTrackingResult(result: TrackingResult): string {
  if (result.checked === 0) return "No active offers to track";
  return [
    `Checked ${result.checked} offer(s)`,
    result.executed > 0 ? `${result.executed} executed` : null,
    result.cancelled > 0 ? `${result.cancelled} cancelled` : null,
    result.expired > 0 ? `${result.expired} expired` : null,
    result.errors > 0 ? `${result.errors} error(s)` : null,
  ]
    .filter(Boolean)
    .join(", ");
}
