/**
 * test-gondi-offer.ts - Test origin fee matching exact UI parameters
 *
 * From intercepting the Gondi UI signing request, the correct parameters are:
 *   - fee: WEI (not bps)
 *   - capacity: 0
 *   - maxSeniorRepayment: principalAmount
 *   - validators.arguments: longer ABI-encoded bytes (not "0x0")
 *
 * Usage: npx ts-node src/test-gondi-offer.ts
 */

import "dotenv/config";
import { Gondi } from "gondi";
import { createWalletClient, http, formatEther, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";

const COLLECTION_SLUG = "sappy-seals";
const WETH_ADDRESS = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as const;

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
  if (typeof collectionId !== "number") throw new Error(`Collection not found`);

  const steps = await gondi.collectionStepsById({ collectionId });
  console.log(`Steps: wethStep=${steps.wethStep}, aprBpsStep=${steps.aprBpsStep}, origFeeBpsStep=${steps.origFeeBpsStep}\n`);

  const principalWei = parseEther("0.04");
  const bps = 2300n;
  const feeBps = 100n;
  const feeWei = principalWei * feeBps / 10000n; // 400000000000000 = 0.0004 ETH
  const durationSeconds = BigInt(7 * 86400);
  const expirationTime = BigInt(Math.floor(Date.now() / 1000) + 35 * 60);

  console.log(`Principal: ${formatEther(principalWei)} ETH`);
  console.log(`Fee: ${feeWei} wei (${formatEther(feeWei)} ETH)`);

  // Exact UI parameters: fee=wei, capacity=0, maxSeniorRepayment=principal
  console.log("\n--- TEST: fee=wei, capacity=0, maxSR=principal (UI match) ---");
  try {
    const result = await gondi.makeCollectionOffer({
      collectionId,
      principalAddress: WETH_ADDRESS,
      principalAmount: principalWei,
      capacity: 0n,
      fee: feeWei,
      aprBps: bps,
      expirationTime,
      duration: durationSeconds,
      requiresLiquidation: false,
      maxSeniorRepayment: principalWei,
    });
    console.log(`SUCCESS! ID: ${result?.id}`);
    console.log(`Fee stored: ${result?.fee}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`FAILED: ${msg}`);

    // If SDK fails, try via apiClient directly with UI-style validator arguments
    console.log("\n--- RETRY via apiClient with UI validator arguments ---");
    const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
    const MSL_CONTRACT = "0xf41B389E0C1950dc0B16C9498eaE77131CC08A56" as const;
    // UI validator arguments (ABI-encoded)
    const UI_VALIDATOR_ARGS = "0x0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`;

    const apiClient = (gondi as unknown as Record<string, unknown>).apiClient as {
      generateCollectionOfferHash(vars: Record<string, unknown>): Promise<{
        offer: { offerId: bigint; offerHash: string; collateralAddress: string; validators: { validator: string; arguments: string }[] };
      }>;
      saveCollectionOffer(input: Record<string, unknown>): Promise<{ id: string; fee: bigint }>;
    };

    const offerInput = {
      collectionId,
      principalAddress: WETH_ADDRESS,
      principalAmount: principalWei,
      capacity: 0n,
      fee: feeWei,
      aprBps: bps,
      expirationTime,
      duration: durationSeconds,
      requiresLiquidation: false,
      maxSeniorRepayment: principalWei,
      lenderAddress: account.address,
      signerAddress: account.address,
      borrowerAddress: ZERO_ADDRESS,
      contractAddress: MSL_CONTRACT,
      offerValidators: [{ validator: ZERO_ADDRESS, arguments: UI_VALIDATOR_ARGS }],
    };

    try {
      console.log("  Calling generateCollectionOfferHash...");
      const hashResult = await apiClient.generateCollectionOfferHash({ offerInput });
      console.log(`  offerId: ${hashResult.offer.offerId}`);
      console.log(`  SUCCESS — API accepted fee in wei!`);

      // Sign with V3.1 types
      const { offerId, offerHash, validators, collateralAddress } = hashResult.offer;
      const structToSign = {
        offerId,
        lender: account.address,
        fee: feeWei,
        capacity: 0n,
        nftCollateralAddress: collateralAddress as `0x${string}`,
        nftCollateralTokenId: 0n,
        principalAddress: WETH_ADDRESS,
        principalAmount: principalWei,
        aprBps: bps,
        expirationTime,
        duration: durationSeconds,
        maxSeniorRepayment: principalWei,
        validators: validators.map((v: { validator: string; arguments: string }) => ({
          validator: v.validator as `0x${string}`,
          arguments: v.arguments as `0x${string}`,
        })),
      };

      const signature = await walletClient.signTypedData({
        domain: {
          name: "GONDI_MULTI_SOURCE_LOAN",
          version: "3.1",
          chainId: mainnet.id,
          verifyingContract: MSL_CONTRACT,
        },
        primaryType: "LoanOffer",
        types: {
          LoanOffer: [
            { name: "offerId", type: "uint256" },
            { name: "lender", type: "address" },
            { name: "fee", type: "uint256" },
            { name: "capacity", type: "uint256" },
            { name: "nftCollateralAddress", type: "address" },
            { name: "nftCollateralTokenId", type: "uint256" },
            { name: "principalAddress", type: "address" },
            { name: "principalAmount", type: "uint256" },
            { name: "aprBps", type: "uint256" },
            { name: "expirationTime", type: "uint256" },
            { name: "duration", type: "uint256" },
            { name: "maxSeniorRepayment", type: "uint256" },
            { name: "validators", type: "OfferValidator[]" },
          ],
          OfferValidator: [
            { name: "validator", type: "address" },
            { name: "arguments", type: "bytes" },
          ],
        },
        message: structToSign,
      });

      console.log("  Saving offer...");
      const saved = await apiClient.saveCollectionOffer({
        ...offerInput,
        offerValidators: validators.map((v: { validator: string; arguments: string }) => ({
          validator: v.validator,
          arguments: v.arguments,
        })),
        offerHash: offerHash ?? "",
        offerId,
        signature,
      });
      console.log(`\n  Offer saved! ID: ${saved.id}, fee: ${saved.fee}`);
    } catch (err2: unknown) {
      const msg2 = err2 instanceof Error ? err2.message : String(err2);
      console.log(`  FAILED: ${msg2}`);
    }
  }

  console.log("\nDone. Check Gondi UI.");
}

main().catch((err: unknown) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
