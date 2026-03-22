/**
 * test-fee-limits.ts - Find what fee values Gondi API accepts
 *
 * Tests multiple fee values via makeCollectionOffer to find the boundary.
 * Uses sappy-seals (cheap) with tiny amounts.
 *
 * Usage: npx ts-node src/test-fee-limits.ts
 */

import "dotenv/config";
import { Gondi } from "gondi";
import { createWalletClient, http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";

const COLLECTION_SLUG = "sappy-seals";
const WETH_ADDRESS = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as const;

// Fee values to test (from small BPS to large WEI-like values)
const FEE_VALUES_TO_TEST = [
  { label: "0 BPS (0%)", fee: 0n },
  { label: "100 BPS (1%)", fee: 100n },
  { label: "500 BPS (5%)", fee: 500n },
  { label: "1000 BPS (10%)", fee: 1000n },
  { label: "2500 BPS (25%)", fee: 2500n },
  { label: "5000 BPS (50%)", fee: 5000n },
  { label: "9900 BPS (99%)", fee: 9900n },
  { label: "10000 BPS (100%)", fee: 10000n },
  { label: "10100 BPS (101%)", fee: 10100n },
  { label: "50000", fee: 50000n },
  { label: "1000000", fee: 1000000n },
  { label: "0.0001 ETH in wei", fee: 100000000000000n },
  { label: "0.001 ETH in wei", fee: 1000000000000000n },
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
  console.log(`Wallet: ${account.address}\n`);

  const ids = await gondi.collectionId({ slug: COLLECTION_SLUG });
  const collectionId = Array.isArray(ids) ? ids[0] : ids;
  if (typeof collectionId !== "number") throw new Error("Collection not found");

  const steps = await gondi.collectionStepsById({ collectionId });
  console.log(`Steps: wethStep=${steps.wethStep}, aprBpsStep=${steps.aprBpsStep}, origFeeBpsStep=${steps.origFeeBpsStep}\n`);

  const principalWei = parseEther("0.01");
  const aprBps = 2300n;
  const durationSeconds = BigInt(7 * 86400);

  let maxSeniorRepayment = (principalWei * (10000n + aprBps * 7n / 365n)) / 10000n;
  const rem = maxSeniorRepayment % steps.wethStep;
  if (rem > 0n) maxSeniorRepayment += steps.wethStep - rem;

  console.log("Fee Value".padEnd(25), "Result");
  console.log("-".repeat(70));

  for (const { label, fee } of FEE_VALUES_TO_TEST) {
    const expirationTime = BigInt(Math.floor(Date.now() / 1000) + 35 * 60);

    try {
      const result = await gondi.makeCollectionOffer({
        collectionId,
        principalAddress: WETH_ADDRESS,
        principalAmount: principalWei,
        capacity: principalWei,
        fee,
        aprBps,
        expirationTime,
        duration: durationSeconds,
        requiresLiquidation: true,
        maxSeniorRepayment,
      });

      const storedFee = (result as Record<string, unknown>).fee;
      console.log(label.padEnd(25), `✅ OK — id=${result.id?.slice(-8)} fee_stored=${storedFee}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const short = msg.length > 60 ? msg.slice(0, 60) + "..." : msg;
      console.log(label.padEnd(25), `❌ ${short}`);
    }

    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 500));
  }

  console.log("\nDone.");
}

main().catch((err: unknown) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
