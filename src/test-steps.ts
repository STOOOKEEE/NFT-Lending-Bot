/**
 * test-steps.ts - Check collection steps for collections where other bots have WEI fees
 *
 * Usage: npx ts-node src/test-steps.ts
 */

import "dotenv/config";
import { Gondi } from "gondi";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";

const COLLECTIONS_TO_CHECK = [
  "sappy-seals",           // our test collection (origFeeBpsStep=100)
  "boredapeyachtclub",     // other bots have ~0.06-0.08 ETH fees
  "official-v1-punks",     // other bots have ~0.048 ETH fee
  "cryptopunks",           // other bots have fees
  "grifters-by-xcopy",     // 0.397 ETH fee
  "xcopy-remnants",        // 0.181 ETH fee
  "azuki",
  "autoglyphs",
  "fidenza-by-tyler-hobbs",
  "chromie-squiggle-by-snowfro",
];

async function main() {
  const privateKey = process.env.WALLET_PRIVATE_KEY;
  if (!privateKey) throw new Error("WALLET_PRIVATE_KEY not set");

  const cleanKey = (privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) as `0x${string}`;
  const account = privateKeyToAccount(cleanKey);
  const rpcUrl = process.env.RPC_URL || "https://eth-mainnet.g.alchemy.com/v2/demo";

  const walletClient = createWalletClient({
    account,
    transport: http(rpcUrl),
    chain: mainnet,
  });

  const gondi = new Gondi({ wallet: walletClient });

  console.log("Collection Steps Analysis\n");
  console.log("Collection".padEnd(35), "ID".padEnd(8), "wethStep".padEnd(22), "aprBpsStep".padEnd(12), "origFeeBpsStep");
  console.log("-".repeat(100));

  for (const slug of COLLECTIONS_TO_CHECK) {
    try {
      const ids = await gondi.collectionId({ slug });
      const collectionId = Array.isArray(ids) ? ids[0] : ids;
      if (typeof collectionId !== "number") {
        console.log(slug.padEnd(35), "NOT FOUND");
        continue;
      }

      const steps = await gondi.collectionStepsById({ collectionId });
      console.log(
        slug.padEnd(35),
        String(collectionId).padEnd(8),
        String(steps.wethStep).padEnd(22),
        String(steps.aprBpsStep).padEnd(12),
        String(steps.origFeeBpsStep),
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(slug.padEnd(35), `ERROR: ${msg}`);
    }
  }
}

main().catch((err: unknown) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
