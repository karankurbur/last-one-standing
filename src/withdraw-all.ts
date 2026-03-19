#!/usr/bin/env node
/**
 * Find all open escrow channels on-chain and close them cooperatively.
 * Uses the Tempo chain definition from viem (USDC.e feeToken, custom serializers).
 *
 * Usage: npm run withdraw-all
 */
import {
  createPublicClient, createWalletClient, http, parseAbiItem, formatUnits,
  encodeFunctionData, type Hex, type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { tempo as tempoChain } from "viem/chains";

// --- Config ---
const ESCROW = "0x33b901018174DDabE4841042ab76ba85D4e24f25" as Address;
const USDC_E = "0x20C000000000000000000000b9537d11c60E8b50" as Address;
const DECIMALS = 6;
const START_BLOCK = 10220000n;
const RPC = "https://gracious-knuth:goofy-chandrasekhar@rpc.tempo.xyz";

const channelsAbi = [{
  name: "channels", type: "function",
  inputs: [{ name: "", type: "bytes32" }],
  outputs: [
    { name: "finalized", type: "bool" },
    { name: "closeRequestedAt", type: "uint64" },
    { name: "payer", type: "address" },
    { name: "payee", type: "address" },
    { name: "token", type: "address" },
    { name: "authorizedSigner", type: "address" },
    { name: "deposit", type: "uint128" },
    { name: "settled", type: "uint128" },
  ],
  stateMutability: "view",
}] as const;

const closeAbi = [{
  name: "close", type: "function",
  inputs: [
    { name: "channelId", type: "bytes32" },
    { name: "cumulativeAmount", type: "uint128" },
    { name: "signature", type: "bytes" },
  ],
  outputs: [],
  stateMutability: "nonpayable",
}] as const;

const PRIVATE_KEY = process.env.SETTLE_PRIVATE_KEY;
if (!PRIVATE_KEY) {
  console.error("Set SETTLE_PRIVATE_KEY in .env");
  process.exit(1);
}

const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);

async function main() {
  console.log(`\n  Server wallet: ${account.address}`);
  console.log(`  Escrow:        ${ESCROW}`);
  console.log(`  Scanning from block ${START_BLOCK}...\n`);

  const publicClient = createPublicClient({ chain: tempoChain, transport: http(RPC) });
  const walletClient = createWalletClient({ account, chain: tempoChain, transport: http(RPC) });

  console.log("  Scanning ChannelOpened events...");
  const payeeLogs = await publicClient.getLogs({
    address: ESCROW,
    event: parseAbiItem(
      "event ChannelOpened(bytes32 indexed channelId, address indexed payer, address indexed payee, address token, address authorizedSigner, bytes32 salt, uint256 deposit)"
    ),
    args: { payee: account.address },
    fromBlock: START_BLOCK,
    toBlock: "latest",
  });

  const channelIds = [...new Set(payeeLogs.map((l) => l.args.channelId!))];
  console.log(`  Found ${channelIds.length} channel(s)\n`);

  if (channelIds.length === 0) {
    console.log("  Nothing to close.\n");
    return;
  }

  let closedCount = 0;

  for (const channelId of channelIds) {
    try {
      const [finalized, , payer, , , , deposit, settled] =
        await publicClient.readContract({
          address: ESCROW,
          abi: channelsAbi,
          functionName: "channels",
          args: [channelId],
        });

      const remaining = deposit - settled;

      if (finalized || deposit === 0n) {
        console.log(`  ${channelId.slice(0, 16)}... ✓ already finalized`);
        continue;
      }

      console.log(`  ${channelId.slice(0, 16)}... deposit=$${formatUnits(deposit, DECIMALS)} settled=$${formatUnits(settled, DECIMALS)} remaining=$${formatUnits(remaining, DECIMALS)}`);

      console.log(`    Closing (returning funds to ${payer.slice(0, 10)}...)...`);
      const txHash = await walletClient.writeContract({
        address: ESCROW,
        abi: closeAbi,
        functionName: "close",
        args: [channelId, 0n, "0x" as Hex],
        feeToken: USDC_E,
      } as any);
      console.log(`    ✓ Closed: ${txHash}\n`);
      closedCount++;
    } catch (err: any) {
      console.error(`    ✗ ${err.message.slice(0, 200)}\n`);
    }
  }

  console.log(`  Done. Closed ${closedCount} channel(s).\n`);
}

main().catch(console.error);
