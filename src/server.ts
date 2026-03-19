import { Hono } from "hono";
import { Mppx, tempo } from "mppx/hono";
import { serve } from "@hono/node-server";

// Mainnet USDC on Tempo (pathUSD)
const CURRENCY = "0x20c0000000000000000000000000000000000000";

// Recipient address — set via env or use a default for demo
const RECIPIENT = process.env.RECIPIENT ?? "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

const app = new Hono();

const mppx = Mppx.create({
  methods: [
    tempo({
      currency: CURRENCY,
      recipient: RECIPIENT,
    }),
  ],
});

// Free endpoint — health check
app.get("/", (c) => c.json({ status: "ok", service: "tempo-hackathon-mvp" }));

// Paid endpoint — joke API ($0.01 per joke)
app.get(
  "/api/joke",
  mppx.charge({ amount: "0.01", description: "A premium joke" }),
  async (c) => {
    const jokes = [
      "Why do programmers prefer dark mode? Because light attracts bugs.",
      "There are only 10 types of people: those who understand binary and those who don't.",
      "A SQL query walks into a bar, sees two tables, and asks: 'Can I JOIN you?'",
      "Why did the developer go broke? Because he used up all his cache.",
      "!false — it's funny because it's true.",
    ];
    const joke = jokes[Math.floor(Math.random() * jokes.length)];
    return c.json({ joke, price: "$0.01", method: "tempo-charge" });
  }
);

// Paid endpoint — random number oracle ($0.001 per call)
app.get(
  "/api/oracle",
  mppx.charge({ amount: "0.001", description: "Random oracle" }),
  async (c) => {
    const value = Math.random();
    const timestamp = new Date().toISOString();
    return c.json({ value, timestamp, price: "$0.001" });
  }
);

// Paid endpoint — word count service ($0.005 per request)
app.post(
  "/api/wordcount",
  mppx.charge({ amount: "0.005", description: "Word count analysis" }),
  async (c) => {
    const body = await c.req.json();
    const text: string = body.text ?? "";
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    const chars = text.length;
    return c.json({ words, chars, price: "$0.005" });
  }
);

const PORT = Number(process.env.PORT ?? 3000);

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`Server running on http://localhost:${info.port}`);
  console.log(`Recipient: ${RECIPIENT}`);
  console.log(`Currency: ${CURRENCY} (pathUSD on Tempo mainnet)`);
  console.log();
  console.log("Endpoints:");
  console.log("  GET  /             — free health check");
  console.log("  GET  /api/joke     — $0.01  (paid)");
  console.log("  GET  /api/oracle   — $0.001 (paid)");
  console.log("  POST /api/wordcount — $0.005 (paid)");
});
