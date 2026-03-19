import { Hono } from "hono";
import { Mppx, tempo } from "mppx/hono";
import { Credential, Store } from "mppx";
import { Session } from "mppx/tempo";
import { serve } from "@hono/node-server";
import { WebSocketServer, WebSocket } from "ws";
import { createWalletClient, http, formatUnits, type Hex, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { tempo as tempoChain } from "viem/chains";

// --- Config ---
const CURRENCY = "0x20C000000000000000000000b9537d11c60E8b50" as Address;
const RECIPIENT = "0xd614701C9Ceef0a82e79Bf65ba8B9dd7A9d741fE" as Address;
const ESCROW = "0x33b901018174DDabE4841042ab76ba85D4e24f25" as Address;
const ADMIN_WALLET = "0x454fe1f25eed444d0dfb72a22beaf8cc40a5abd5";
const PORT = Number(process.env.PORT ?? 3001);
const DECIMALS = 6;
const SUGGESTED_DEPOSIT = process.env.SNAKE_DEPOSIT ?? "1.00";

// Game settings
const GRID_W = 40;
const GRID_H = 20;
const TICK_MS = 200; // 5 ticks/sec
const COST_PER_TICK_CENTS = 0.1; // $0.001 per tick
const FOOD_REWARD_TICKS = 50; // eating food gives you 50 free ticks
const MIN_PLAYERS = process.argv.includes("--dev") ? 1 : 2;
const DEV_MODE = process.argv.includes("--dev");

// --- Store & Channels ---
const store = Store.memory();
const channelStore = Session.ChannelStore.fromStore(store);
const walletChannels = new Map<string, Hex>();
const channelWallets = new Map<Hex, string>();

// --- Settle client ---
const SETTLE_KEY = process.env.SETTLE_PRIVATE_KEY;
const settleAccount = SETTLE_KEY ? privateKeyToAccount(SETTLE_KEY as `0x${string}`) : null;
const viemClient = settleAccount
  ? createWalletClient({ account: settleAccount, chain: tempoChain, transport: http("https://rpc.tempo.xyz") })
  : null;

// --- Types ---
type Dir = "up" | "down" | "left" | "right";
type Point = { x: number; y: number };

interface Snake {
  wallet: string;
  name: string;
  ws: WebSocket;
  body: Point[];
  dir: Dir;
  nextDir: Dir;
  alive: boolean;
  color: number; // 1-6 for terminal colors
  freeTicks: number; // ticks remaining without payment
  totalPaid: number; // cents paid total
  channelId: Hex | null;
  sessionReady: boolean;
}

interface Game {
  id: string;
  snakes: Snake[];
  food: Point[];
  state: "lobby" | "playing" | "finished";
  tick: number;
  pot: number; // cents
  tickTimer: ReturnType<typeof setInterval> | null;
  host: string;
}

const games = new Map<string, Game>();
const COLORS = [1, 2, 3, 4, 5, 6]; // ANSI colors

// --- Helpers ---
function genId(): string {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function shortAddr(w: string): string {
  return w.slice(0, 6) + "…" + w.slice(-4);
}

function extractWallet(source: string): string | null {
  const match = source.match(/0x[0-9a-fA-F]{40}/);
  return match ? match[0].toLowerCase() : null;
}

function cents2dollars(c: number): string {
  return (c / 100).toFixed(3);
}

function randomPoint(): Point {
  return { x: Math.floor(Math.random() * GRID_W), y: Math.floor(Math.random() * GRID_H) };
}

function spawnFood(game: Game): Point {
  let p: Point;
  do {
    p = randomPoint();
  } while (
    game.snakes.some((s) => s.body.some((b) => b.x === p.x && b.y === p.y)) ||
    game.food.some((f) => f.x === p.x && f.y === p.y)
  );
  return p;
}

function spawnSnake(index: number): Point[] {
  // Spawn in different quadrants
  const positions = [
    { x: 5, y: 5 },
    { x: GRID_W - 6, y: GRID_H - 6 },
    { x: GRID_W - 6, y: 5 },
    { x: 5, y: GRID_H - 6 },
    { x: GRID_W / 2, y: 5 },
    { x: GRID_W / 2, y: GRID_H - 6 },
  ];
  const pos = positions[index % positions.length]!;
  return [
    { x: pos.x, y: pos.y },
    { x: pos.x - 1, y: pos.y },
    { x: pos.x - 2, y: pos.y },
  ];
}

const startDirs: Dir[] = ["right", "left", "left", "right", "right", "left"];

// --- Broadcasting ---
function broadcast(game: Game, msg: object) {
  const data = JSON.stringify(msg);
  for (const s of game.snakes) {
    if (s.ws.readyState === WebSocket.OPEN) s.ws.send(data);
  }
}

function gameState(game: Game) {
  return {
    type: "game_state",
    gameId: game.id,
    state: game.state,
    tick: game.tick,
    gridW: GRID_W,
    gridH: GRID_H,
    pot: game.pot,
    potDollars: cents2dollars(game.pot),
    food: game.food,
    snakes: game.snakes.map((s) => ({
      wallet: s.wallet,
      name: s.name,
      body: s.body,
      dir: s.dir,
      alive: s.alive,
      color: s.color,
      sessionReady: s.sessionReady,
      freeTicks: s.freeTicks,
    })),
  };
}

// --- Game Logic ---
function gameTick(game: Game) {
  if (game.state !== "playing") return;
  game.tick++;

  const alive = game.snakes.filter((s) => s.alive);

  for (const snake of alive) {
    // Apply queued direction
    snake.dir = snake.nextDir;

    // Move head
    const head = snake.body[0]!;
    let newHead: Point;
    switch (snake.dir) {
      case "up":    newHead = { x: head.x, y: head.y - 1 }; break;
      case "down":  newHead = { x: head.x, y: head.y + 1 }; break;
      case "left":  newHead = { x: head.x - 1, y: head.y }; break;
      case "right": newHead = { x: head.x + 1, y: head.y }; break;
    }

    // Wall collision = wrap around
    if (newHead.x < 0) newHead.x = GRID_W - 1;
    if (newHead.x >= GRID_W) newHead.x = 0;
    if (newHead.y < 0) newHead.y = GRID_H - 1;
    if (newHead.y >= GRID_H) newHead.y = 0;

    // Check self collision
    if (snake.body.some((b) => b.x === newHead.x && b.y === newHead.y)) {
      snake.alive = false;
      continue;
    }

    // Check collision with other snakes
    for (const other of alive) {
      if (other === snake) continue;
      if (other.body.some((b) => b.x === newHead.x && b.y === newHead.y)) {
        snake.alive = false;
        break;
      }
    }
    if (!snake.alive) continue;

    // Check food
    const foodIdx = game.food.findIndex((f) => f.x === newHead.x && f.y === newHead.y);
    if (foodIdx !== -1) {
      // Eat: grow (don't remove tail) + free ticks
      snake.body.unshift(newHead);
      game.food.splice(foodIdx, 1);
      game.food.push(spawnFood(game));
      snake.freeTicks += FOOD_REWARD_TICKS;
    } else {
      // Normal move: add head, remove tail
      snake.body.unshift(newHead);
      snake.body.pop();
    }

    // Payment: deduct from free ticks or add to pot
    if (snake.freeTicks > 0) {
      snake.freeTicks--;
    } else {
      snake.totalPaid += COST_PER_TICK_CENTS;
      game.pot += COST_PER_TICK_CENTS;
    }
  }

  // Head-on collision (two snakes move into same cell)
  for (let i = 0; i < alive.length; i++) {
    for (let j = i + 1; j < alive.length; j++) {
      const a = alive[i]!, b = alive[j]!;
      if (a.alive && b.alive && a.body[0]!.x === b.body[0]!.x && a.body[0]!.y === b.body[0]!.y) {
        a.alive = false;
        b.alive = false;
      }
    }
  }

  // Broadcast state
  broadcast(game, gameState(game));

  // Check game over
  const remaining = game.snakes.filter((s) => s.alive);
  if (remaining.length <= 1 || (DEV_MODE && game.tick >= 500)) {
    endSnakeGame(game, remaining[0] ?? null);
  }
}

function endSnakeGame(game: Game, winner: Snake | null) {
  game.state = "finished";
  if (game.tickTimer) {
    clearInterval(game.tickTimer);
    game.tickTimer = null;
  }

  const message = winner
    ? `${winner.name} wins $${cents2dollars(game.pot)}!`
    : "No survivors! Pot is lost.";

  broadcast(game, {
    type: "game_over",
    winner: winner?.name ?? null,
    winnerWallet: winner?.wallet ?? null,
    pot: game.pot,
    potDollars: cents2dollars(game.pot),
    message,
    snakes: game.snakes.map((s) => ({
      name: s.name,
      wallet: s.wallet,
      alive: s.alive,
      totalPaid: cents2dollars(s.totalPaid),
    })),
  });

  // Settle channels
  settleSnakeGame(game, winner).catch((err) => console.error("Settlement error:", err));

  // Reset to lobby after 10s
  setTimeout(() => {
    game.state = "lobby";
    game.tick = 0;
    game.pot = 0;
    game.food = [];
    for (const s of game.snakes) {
      s.alive = true;
      s.body = [];
      s.freeTicks = 0;
      s.totalPaid = 0;
      s.sessionReady = false;
      s.channelId = null;
    }
    broadcast(game, gameState(game));
  }, 10000);
}

async function settleSnakeGame(game: Game, winner: Snake | null) {
  console.log(`Settling snake game ${game.id}...`);

  if (!viemClient || !settleAccount) {
    console.error("  No SETTLE_PRIVATE_KEY");
    return;
  }

  // Close all channels
  for (const s of game.snakes) {
    if (!s.channelId) continue;
    try {
      const state = await channelStore.getChannel(s.channelId);
      if (!state) continue;
      const voucherAmount = state.highestVoucherAmount;
      const voucher = state.highestVoucher;
      await viemClient.writeContract({
        address: ESCROW,
        abi: [{ name: "close", type: "function", inputs: [{ name: "channelId", type: "bytes32" }, { name: "cumulativeAmount", type: "uint128" }, { name: "signature", type: "bytes" }], outputs: [], stateMutability: "nonpayable" }],
        functionName: "close",
        args: [s.channelId, voucherAmount, voucher?.signature ?? ("0x" as Hex)],
        feeToken: CURRENCY,
      } as any);
      console.log(`  ✓ Closed ${s.name}`);
    } catch (err: any) {
      console.error(`  ✗ Failed to close ${s.name}:`, err.message.slice(0, 100));
    }
    channelWallets.delete(s.channelId);
    walletChannels.delete(s.wallet);
    await new Promise((r) => setTimeout(r, 2000));
  }

  // Pay winner
  if (winner && game.pot > 0) {
    await new Promise((r) => setTimeout(r, 2000));
    const potBaseUnits = BigInt(Math.round(game.pot * 10000)); // cents → 6-decimal base units
    console.log(`  Paying ${winner.name} ($${cents2dollars(game.pot)})...`);
    try {
      const txHash = await viemClient.writeContract({
        address: CURRENCY,
        abi: [{ name: "transfer", type: "function", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }], stateMutability: "nonpayable" }],
        functionName: "transfer",
        args: [winner.wallet as Address, potBaseUnits],
        feeToken: CURRENCY,
      } as any);
      console.log(`  ✓ Paid ${winner.name}: ${txHash}`);
      broadcast(game, { type: "payout", txHash, winner: winner.name, amount: cents2dollars(game.pot) });
    } catch (err: any) {
      console.error(`  ✗ Failed to pay ${winner.name}:`, err.message.slice(0, 100));
    }
  }
}

// --- HTTP ---
const app = new Hono();

const mppx = Mppx.create({
  methods: [tempo({ currency: CURRENCY, recipient: RECIPIENT, store })],
});

// Session open
app.get(
  "/api/session/open",
  async (c, next) => {
    const deposit = c.req.query("deposit") || SUGGESTED_DEPOSIT;
    return mppx.session({ amount: "0", unitType: "tick", suggestedDeposit: deposit })(c, next);
  },
  async (c) => {
    let wallet: string | null = null;
    let channelId: Hex | null = null;
    try {
      const credential = Credential.fromRequest(c.req.raw);
      if (credential.source) wallet = extractWallet(credential.source);
      const payload = credential.payload as any;
      if (payload?.channelId) channelId = payload.channelId as Hex;
    } catch {}

    if (wallet && channelId) {
      // Close old channel if exists
      const oldChannelId = walletChannels.get(wallet);
      if (oldChannelId && oldChannelId !== channelId && viemClient) {
        try {
          const oldState = await channelStore.getChannel(oldChannelId);
          await viemClient.writeContract({
            address: ESCROW,
            abi: [{ name: "close", type: "function", inputs: [{ name: "channelId", type: "bytes32" }, { name: "cumulativeAmount", type: "uint128" }, { name: "signature", type: "bytes" }], outputs: [], stateMutability: "nonpayable" }],
            functionName: "close",
            args: [oldChannelId, oldState?.highestVoucherAmount ?? 0n, oldState?.highestVoucher?.signature ?? ("0x" as Hex)],
            feeToken: CURRENCY,
          } as any);
          channelWallets.delete(oldChannelId);
        } catch {}
        await new Promise((r) => setTimeout(r, 2000));
      }

      walletChannels.set(wallet, channelId);
      channelWallets.set(channelId, wallet);

      const newState = await channelStore.getChannel(channelId);
      const depositStr = newState ? `$${formatUnits(newState.deposit, DECIMALS)}` : "?";
      console.log(`Session opened: ${shortAddr(wallet)} (deposit: ${depositStr})`);

      // Update player in game
      for (const game of games.values()) {
        const snake = game.snakes.find((s) => s.wallet === wallet);
        if (snake) {
          snake.channelId = channelId;
          snake.sessionReady = true;
          broadcast(game, gameState(game));
          break;
        }
      }
    }

    return c.json({ success: true, channelId, wallet });
  }
);

// Session tick — pays per game tick (called by server internally, not by player)
app.get(
  "/api/session/tick",
  async (c, next) => {
    const amount = c.req.query("amount") || "0.001";
    return mppx.session({ amount, unitType: "tick" })(c, next);
  },
  async (c) => {
    return c.json({ success: true });
  }
);

// Health
app.get("/api/health", (c) => c.json({ status: "ok", service: "snake" }));

// List games
app.get("/api/games", (c) => {
  return c.json({
    games: Array.from(games.values()).map((g) => ({
      id: g.id,
      state: g.state,
      players: g.snakes.map((s) => ({ name: s.name, alive: s.alive })),
      pot: cents2dollars(g.pot),
      tick: g.tick,
    })),
  });
});

// --- Start ---
const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log("");
  console.log("  SNAKE ROYALE");
  if (DEV_MODE) console.log("  [DEV MODE]");
  console.log(`  http://localhost:${info.port}`);
  console.log(`  ${GRID_W}x${GRID_H} grid, ${1000/TICK_MS} ticks/sec, $${cents2dollars(COST_PER_TICK_CENTS)}/tick`);
  console.log("");
});

// --- WebSocket ---
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  let myWallet: string | null = null;
  let myGame: Game | null = null;

  ws.on("message", async (raw) => {
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.type) {
      case "join": {
        const wallet = msg.wallet?.trim()?.toLowerCase();
        if (!wallet) return;
        const name = msg.name?.trim() || shortAddr(wallet);

        // Find or create lobby game
        let game = Array.from(games.values()).find((g) => g.state === "lobby");
        if (!game) {
          game = {
            id: genId(),
            snakes: [],
            food: [],
            state: "lobby",
            tick: 0,
            pot: 0,
            tickTimer: null,
            host: wallet,
          };
          games.set(game.id, game);
        }

        const existing = game.snakes.find((s) => s.wallet === wallet);
        if (existing) {
          existing.ws = ws;
          existing.name = name;
        } else {
          const idx = game.snakes.length;
          game.snakes.push({
            wallet,
            name,
            ws,
            body: [],
            dir: "right",
            nextDir: "right",
            alive: true,
            color: COLORS[idx % COLORS.length]!,
            freeTicks: 0,
            totalPaid: 0,
            channelId: walletChannels.get(wallet) ?? null,
            sessionReady: walletChannels.has(wallet),
          });
        }

        myWallet = wallet;
        myGame = game;
        ws.send(JSON.stringify({ type: "joined", gameId: game.id }));
        broadcast(game, gameState(game));
        break;
      }

      case "start": {
        if (!myGame || !myWallet) return;
        if (myWallet !== ADMIN_WALLET) {
          ws.send(JSON.stringify({ type: "error", message: "Only admin can start" }));
          return;
        }
        if (myGame.snakes.length < MIN_PLAYERS) {
          ws.send(JSON.stringify({ type: "error", message: `Need ${MIN_PLAYERS}+ players` }));
          return;
        }
        const unready = myGame.snakes.filter((s) => !s.sessionReady);
        if (unready.length > 0 && !DEV_MODE) {
          ws.send(JSON.stringify({ type: "error", message: `${unready.length} player(s) not ready` }));
          return;
        }

        // Initialize game
        myGame.state = "playing";
        myGame.tick = 0;
        myGame.pot = 0;
        myGame.food = [];

        for (let i = 0; i < myGame.snakes.length; i++) {
          const s = myGame.snakes[i]!;
          s.body = spawnSnake(i);
          s.dir = startDirs[i % startDirs.length]!;
          s.nextDir = s.dir;
          s.alive = true;
          s.freeTicks = 100; // 100 free ticks to start (~20 seconds)
          s.totalPaid = 0;
        }

        // Spawn food
        for (let i = 0; i < 3; i++) {
          myGame.food.push(spawnFood(myGame));
        }

        broadcast(myGame, { type: "game_start" });
        broadcast(myGame, gameState(myGame));

        // Start tick loop
        myGame.tickTimer = setInterval(() => gameTick(myGame!), TICK_MS);
        break;
      }

      case "dir": {
        if (!myGame || !myWallet || myGame.state !== "playing") return;
        const snake = myGame.snakes.find((s) => s.wallet === myWallet);
        if (!snake || !snake.alive) return;

        const dir = msg.dir as Dir;
        if (!["up", "down", "left", "right"].includes(dir)) return;

        // Prevent 180° turns
        const opposite: Record<Dir, Dir> = { up: "down", down: "up", left: "right", right: "left" };
        if (dir === opposite[snake.dir]) return;

        snake.nextDir = dir;
        break;
      }
    }
  });

  ws.on("close", () => {
    if (!myGame || !myWallet) return;
    const snake = myGame.snakes.find((s) => s.wallet === myWallet);
    if (!snake) return;

    if (myGame.state === "playing" && snake.alive) {
      snake.alive = false;
    } else if (myGame.state === "lobby") {
      myGame.snakes = myGame.snakes.filter((s) => s.wallet !== myWallet);
      if (myGame.snakes.length === 0) {
        games.delete(myGame.id);
      } else {
        if (myGame.host === myWallet) myGame.host = myGame.snakes[0]!.wallet;
        broadcast(myGame, gameState(myGame));
      }
    }
  });
});
