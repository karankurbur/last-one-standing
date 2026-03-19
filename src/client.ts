import { Mppx, tempo } from "mppx/client";
import { privateKeyToAccount } from "viem/accounts";

// Client private key — set via env
const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) {
  console.error("Set PRIVATE_KEY env var (hex, with 0x prefix)");
  process.exit(1);
}

const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);
console.log(`Client wallet: ${account.address}`);

const SERVER = process.env.SERVER_URL ?? "http://localhost:3000";

// Create payment-aware fetch — patches globalThis.fetch
// Automatically handles 402 → sign tx → retry flow
Mppx.create({
  methods: [tempo.charge({ account })],
});

async function main() {
  console.log(`\nTarget: ${SERVER}\n`);

  // 1. Free endpoint
  console.log("--- Health Check (free) ---");
  const health = await fetch(`${SERVER}/`);
  console.log(await health.json());

  // 2. Paid: joke
  console.log("\n--- Joke ($0.01) ---");
  const jokeRes = await fetch(`${SERVER}/api/joke`);
  console.log("Status:", jokeRes.status);
  console.log(await jokeRes.json());

  // 3. Paid: oracle
  console.log("\n--- Oracle ($0.001) ---");
  const oracleRes = await fetch(`${SERVER}/api/oracle`);
  console.log("Status:", oracleRes.status);
  console.log(await oracleRes.json());

  // 4. Paid: word count
  console.log("\n--- Word Count ($0.005) ---");
  const wcRes = await fetch(`${SERVER}/api/wordcount`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: "The Machine Payments Protocol lets any client pay for any service in the same HTTP request",
    }),
  });
  console.log("Status:", wcRes.status);
  console.log(await wcRes.json());
}

main().catch(console.error);
