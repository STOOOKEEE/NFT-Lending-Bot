/**
 * cleanup-offers.ts - Nettoyer les offres expirées de la DB
 * 
 * Usage:
 *   npx tsx cleanup-offers.ts              # Marquer expirées + supprimer >30 jours
 *   npx tsx cleanup-offers.ts --delete 7   # Supprimer offres expirées >7 jours
 *   npx tsx cleanup-offers.ts --mark-only  # Seulement marquer comme EXPIRED
 *   npx tsx cleanup-offers.ts --expiring   # Voir les offres qui expirent bientôt
 * 
 * Pour automatiser avec cron (exemple toutes les heures):
 *   0 * * * * cd /path/to/gondi-loans && npx tsx cleanup-offers.ts
 */

import "dotenv/config";
import { privateKeyToAccount } from "viem/accounts";
import {
  cleanupExpiredOffers,
  markExpiredOffers,
  deleteOldExpiredOffers,
  getExpiringOffers,
  getOffersStats,
} from "../utils/lending-db";

const args = process.argv.slice(2);

async function main() {
  console.log("🧹 Nettoyage des offres expirées...\n");
  
  // --expiring: Voir les offres qui expirent bientôt
  if (args.includes("--expiring")) {
    const pk = process.env.WALLET_PRIVATE_KEY!.startsWith("0x") 
      ? process.env.WALLET_PRIVATE_KEY as `0x${string}`
      : `0x${process.env.WALLET_PRIVATE_KEY}` as `0x${string}`;
    const account = privateKeyToAccount(pk);
    
    const hours = parseInt(args[args.indexOf("--expiring") + 1]) || 24;
    console.log(`⏰ Offres expirant dans les ${hours} prochaines heures:\n`);
    
    const expiring = await getExpiringOffers(account.address, hours);
    
    if (expiring.length === 0) {
      console.log("   Aucune offre n'expire bientôt ✅");
    } else {
      for (const offer of expiring) {
        const expiresIn = Math.round(
          (new Date(offer.expiration_time).getTime() - Date.now()) / (1000 * 60 * 60)
        );
        console.log(`   📌 ${offer.id.substring(0, 30)}...`);
        console.log(`      Collection: ${offer.collection_name || offer.collection_address}`);
        console.log(`      Principal: ${offer.principal_eth} ETH`);
        console.log(`      Expire dans: ${expiresIn}h`);
        console.log("");
      }
    }
    return;
  }
  
  // --mark-only: Seulement marquer comme EXPIRED
  if (args.includes("--mark-only")) {
    const marked = await markExpiredOffers();
    console.log(`\n✅ ${marked} offre(s) marquée(s) comme EXPIRED`);
    return;
  }
  
  // --delete N: Supprimer les offres expirées depuis N jours
  const deleteIdx = args.indexOf("--delete");
  if (deleteIdx !== -1) {
    const days = parseInt(args[deleteIdx + 1]) || 30;
    const deleted = await deleteOldExpiredOffers(days);
    console.log(`\n✅ ${deleted} offre(s) expirée(s) depuis plus de ${days} jours supprimée(s)`);
    return;
  }
  
  // Par défaut: cleanup complet
  const deleteAfterDays = 30;
  const { marked, deleted } = await cleanupExpiredOffers(deleteAfterDays);
  
  console.log("\n" + "=".repeat(50));
  console.log("📊 Résultat du nettoyage:");
  console.log(`   - ${marked} offre(s) marquée(s) comme EXPIRED`);
  console.log(`   - ${deleted} vieille(s) offre(s) supprimée(s) (>${deleteAfterDays} jours)`);
  
  // Afficher stats
  try {
    const stats = await getOffersStats();
    console.log("\n📈 Statistiques actuelles:");
    console.log(`   Total: ${stats.total}`);
    console.log(`   Active: ${stats.active}`);
    console.log(`   Expired: ${stats.expired}`);
    console.log(`   Cancelled: ${stats.cancelled}`);
  } catch (e) {
    // Ignore si pas de stats
  }
  
  console.log("\n✅ Nettoyage terminé");
}

main().catch(console.error);
