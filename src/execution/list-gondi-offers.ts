/**
 * list-offers.ts - Lister les offres (Gondi + DB)
 * 
 * Usage:
 *   npx tsx list-offers.ts           # Gondi + DB
 *   npx tsx list-offers.ts --db      # DB uniquement
 *   npx tsx list-offers.ts --gondi   # Gondi uniquement
 */

import "dotenv/config";
import { Gondi } from "gondi";
import { createWalletClient, http, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import { getOffersByLender, getOffersStats, markExpiredOffers, getExpiringOffers } from "../utils/lending-db";

const dbOnly = process.argv.includes("--db");
const gondiOnly = process.argv.includes("--gondi");

async function main() {
  const pk = process.env.WALLET_PRIVATE_KEY!.startsWith("0x") 
    ? process.env.WALLET_PRIVATE_KEY as `0x${string}`
    : `0x${process.env.WALLET_PRIVATE_KEY}` as `0x${string}`;
  const account = privateKeyToAccount(pk);
  
  console.log(`🔐 Wallet: ${account.address}\n`);

  // ==================== DB ====================
  if (!gondiOnly) {
    console.log("=".repeat(50) + "\n📊 BASE DE DONNÉES\n" + "=".repeat(50));
    try {
      const expired = await markExpiredOffers();
      if (expired > 0) console.log(`⏰ ${expired} offre(s) marquée(s) EXPIRED`);

      const offers = await getOffersByLender(account.address, undefined, "ACTIVE");
      console.log(`\n✅ ${offers.length} offre(s) active(s):\n`);

      for (const o of offers) {
        const h = Math.round((new Date(o.expiration_time).getTime() - Date.now()) / 3600000);
        console.log(`  📌 ${o.collection_name || o.collection_address || "?"} | ${o.principal_eth} ETH | ${o.apr_percent}% | ${h > 0 ? h + "h" : "EXPIRÉ"}`);
      }

      const expiring = await getExpiringOffers(account.address, 24);
      if (expiring.length) console.log(`\n⚠️  ${expiring.length} offre(s) expire(nt) dans 24h`);

      const stats = await getOffersStats(account.address);
      console.log(`\n📈 ${stats.total} total | ${stats.active} active | ${stats.expired} expired | ${stats.cancelled} cancelled`);
    } catch (e: any) {
      console.warn("⚠️  DB:", e.message);
    }
  }

  // ==================== GONDI ====================
  if (!dbOnly) {
    console.log("\n" + "=".repeat(50) + "\n🌐 GONDI API\n" + "=".repeat(50));
    const wallet = createWalletClient({ account, transport: http(process.env.RPC_URL), chain: mainnet });
    const gondi = new Gondi({ wallet });

    try {
      const { edges } = await gondi.offers({ lenderAddress: account.address, statuses: ["ACTIVE"], first: 50 });
      console.log(`\n✅ ${edges?.length || 0} offre(s) active(s):\n`);

      for (const { node: o } of edges || []) {
        const eth = formatEther(BigInt(o.principalAmount));
        const apr = Number(o.aprBps) / 100;
        const days = Number(o.duration) / 86400;
        console.log(`  📌 ${o.collection?.name || o.id.slice(0, 20)}... | ${eth} ETH | ${apr}% | ${days}j`);
      }

      const all = await gondi.offers({ lenderAddress: account.address, first: 20 });
      console.log(`\n📋 Historique (${all.edges?.length || 0}):`);
      for (const { node: o } of all.edges || []) {
        console.log(`   ${o.status} | ${formatEther(BigInt(o.principalAmount))} ETH | ${o.id.slice(0, 30)}...`);
      }
    } catch (e: any) {
      console.error("❌ Gondi:", e.message);
    }
  }

  console.log("\n✅ Terminé");
}

main().catch(console.error);
