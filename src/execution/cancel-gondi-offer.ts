/**
 * cancel-offer.ts - Annuler une offre sur Gondi
 * 
 * Usage:
 *   npx tsx cancel-offer.ts --id <contract.lender.offerId>
 *   npx tsx cancel-offer.ts --offer-id 3
 *   npx tsx cancel-offer.ts --all --min-id 0
 *   npx tsx cancel-offer.ts --id <id> --hide
 */

import "dotenv/config";
import { Gondi } from "gondi";
import { createWalletClient, http, Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import { removeOffer, removeAllOffers, updateOfferStatus } from "../utils/lending-db";

const MSL_CONTRACT = "0xf41B389E0C1950dc0B16C9498eaE77131CC08A56" as const;

// ==================== HELPERS ====================

const getArg = (name: string): string | undefined => {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 && process.argv[idx + 1]?.startsWith("--") === false ? process.argv[idx + 1] : undefined;
};

const hasFlag = (name: string) => process.argv.includes(`--${name}`);

function parseFullId(id: string) {
  const [contract, lender, offerId] = id.split(".");
  return offerId ? { contract: contract as Address, offerId: BigInt(offerId) } : null;
}

function createClient() {
  const pk = process.env.WALLET_PRIVATE_KEY!.startsWith("0x") 
    ? process.env.WALLET_PRIVATE_KEY as `0x${string}`
    : `0x${process.env.WALLET_PRIVATE_KEY}` as `0x${string}`;
  const account = privateKeyToAccount(pk);
  const wallet = createWalletClient({ account, transport: http(process.env.RPC_URL), chain: mainnet });
  console.log(`🔐 Wallet: ${account.address}`);
  return { gondi: new Gondi({ wallet }), address: account.address };
}

// ==================== MAIN ====================

async function main() {
  console.log("🚀 Gondi Offer Cancellation\n" + "=".repeat(50));

  const [id, offerId, contract, minId] = [getArg("id"), getArg("offer-id"), getArg("contract"), getArg("min-id")];
  const [all, hide, dryRun] = [hasFlag("all"), hasFlag("hide"), hasFlag("dry-run")];

  if (!id && !offerId && !all) {
    console.log(`
Usage:
  npx tsx cancel-offer.ts --id <contract.lender.offerId>
  npx tsx cancel-offer.ts --offer-id <n> [--contract <addr>]
  npx tsx cancel-offer.ts --all [--min-id 0]
  
Options: --hide (masquer sans tx), --dry-run (test)`);
    return;
  }

  const { gondi, address } = createClient();
  if (dryRun) console.log("\n⚠️  DRY-RUN");

  try {
    // Cancel ALL
    if (all) {
      const contractAddr = (contract || MSL_CONTRACT) as Address;
      console.log(`\n🗑️  Annulation de TOUTES les offres (min-id: ${minId || 0})...`);
      if (!dryRun) {
        const result = await gondi.cancelAllOffers({ minId: BigInt(minId || 0), contractAddress: contractAddr });
        if (result?.waitTxInBlock) await result.waitTxInBlock();
        console.log("✅ Toutes les offres annulées!");
        try { await removeAllOffers(address, "gondi"); } catch {}
      }
      return;
    }

    // Parse offer ID
    let oid: bigint, contractAddr: Address, fullId: string;
    if (id) {
      const parsed = parseFullId(id);
      if (!parsed) throw new Error(`Format invalide: ${id}`);
      oid = parsed.offerId;
      contractAddr = parsed.contract;
      fullId = id;
    } else {
      oid = BigInt(offerId!);
      contractAddr = (contract || MSL_CONTRACT) as Address;
      fullId = `${contractAddr.toLowerCase()}.${address.toLowerCase()}.${offerId}`;
    }

    console.log(`\n🗑️  ${hide ? "Masquage" : "Annulation"} de l'offre ${oid}...`);
    
    if (!dryRun) {
      if (hide) {
        await gondi.hideOffer({ id: oid, contractAddress: contractAddr });
        console.log("✅ Offre masquée!");
        try { await updateOfferStatus(fullId, "HIDDEN"); } catch {}
      } else {
        const result = await gondi.cancelOffer({ id: oid, contractAddress: contractAddr });
        if (result?.waitTxInBlock) await result.waitTxInBlock();
        console.log("✅ Offre annulée!");
        try { await removeOffer(fullId); } catch {}
      }
    }

    console.log("\n✅ Terminé!");
  } catch (e: any) {
    console.error("❌ Erreur:", e.message);
    process.exit(1);
  }
}

main();
