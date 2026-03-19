import { Hono } from "hono";
import { Mppx, tempo } from "mppx/hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { WebSocketServer, WebSocket } from "ws";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";

// --- Config ---
const CURRENCY = "0x20c000000000000000000000b9537d11c60e8b50"; // USDC.e on Tempo
const RECIPIENT = "0x454fE1f25eED444D0DFB72A22BeaF8cc40a5aBD5"; // Game host wallet
const PORT = Number(process.env.PORT ?? 3000);
const BALANCES_FILE = "./data/balances.json";
const ROUND_TIMER_MS = 15_000;
const BASE_COST_CENTS = 1; // $0.01 round 1

// --- Balances (persistent) ---
function ensureDataDir() {
  if (!existsSync("./data")) mkdirSync("./data", { recursive: true });
}

function loadBalances(): Record<string, number> {
  ensureDataDir();
  if (!existsSync(BALANCES_FILE)) return {};
  return JSON.parse(readFileSync(BALANCES_FILE, "utf-8"));
}

function saveBalances(b: Record<string, number>) {
  ensureDataDir();
  writeFileSync(BALANCES_FILE, JSON.stringify(b, null, 2));
}

const balances = loadBalances();

function getBalance(player: string): number {
  return balances[player] ?? 0;
}

function addBalance(player: string, cents: number) {
  balances[player] = (balances[player] ?? 0) + cents;
  saveBalances(balances);
}

function deductBalance(player: string, cents: number): boolean {
  if ((balances[player] ?? 0) < cents) return false;
  balances[player]! -= cents;
  saveBalances(balances);
  return true;
}

// --- Game Types ---
interface Player {
  name: string;
  ws: WebSocket;
  alive: boolean;
  choice: "stay" | "fold" | null;
}

interface Room {
  id: string;
  players: Player[];
  state: "lobby" | "playing" | "finished";
  round: number;
  pot: number;
  host: string;
  roundTimer: ReturnType<typeof setTimeout> | null;
}

const rooms = new Map<string, Room>();

// --- Deposit Codes ---
// Maps deposit code → player name. Generated when player joins, used once to link payment.
const depositCodes = new Map<string, string>();

function genCode(): string {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

function createDepositCode(playerName: string): string {
  // Reuse existing code if player already has one
  for (const [code, name] of depositCodes) {
    if (name === playerName) return code;
  }
  const code = genCode();
  depositCodes.set(code, playerName);
  return code;
}

function genRoomId(): string {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function roundCost(round: number): number {
  return BASE_COST_CENTS * Math.pow(2, round - 1);
}

function cents2dollars(c: number): string {
  return (c / 100).toFixed(2);
}

// --- Broadcasting ---
function broadcast(room: Room, msg: object) {
  const data = JSON.stringify(msg);
  for (const p of room.players) {
    if (p.ws.readyState === WebSocket.OPEN) p.ws.send(data);
  }
}

function roomState(room: Room) {
  return {
    type: "room_state",
    roomId: room.id,
    state: room.state,
    round: room.round,
    pot: room.pot,
    potDollars: cents2dollars(room.pot),
    host: room.host,
    nextCost: room.state === "playing" ? roundCost(room.round) : roundCost(1),
    nextCostDollars:
      room.state === "playing"
        ? cents2dollars(roundCost(room.round))
        : cents2dollars(roundCost(1)),
    players: room.players.map((p) => ({
      name: p.name,
      alive: p.alive,
      balance: getBalance(p.name),
      balanceDollars: cents2dollars(getBalance(p.name)),
      hasChosen: p.choice !== null,
      depositCode: createDepositCode(p.name),
    })),
  };
}

// --- Game Logic ---
function startRound(room: Room) {
  const cost = roundCost(room.round);
  const alive = room.players.filter((p) => p.alive);

  for (const p of alive) p.choice = null;

  broadcast(room, {
    type: "round_start",
    round: room.round,
    cost,
    costDollars: cents2dollars(cost),
    timer: ROUND_TIMER_MS / 1000,
    alivePlayers: alive.map((p) => p.name),
  });
  broadcast(room, roomState(room));

  room.roundTimer = setTimeout(() => {
    for (const p of alive) {
      if (p.choice === null) p.choice = "fold";
    }
    resolveRound(room);
  }, ROUND_TIMER_MS);
}

function checkAllChosen(room: Room) {
  const alive = room.players.filter((p) => p.alive);
  if (alive.every((p) => p.choice !== null)) {
    if (room.roundTimer) {
      clearTimeout(room.roundTimer);
      room.roundTimer = null;
    }
    resolveRound(room);
  }
}

function resolveRound(room: Room) {
  const cost = roundCost(room.round);
  const alive = room.players.filter((p) => p.alive);
  const stayers: Player[] = [];
  const folders: Player[] = [];

  for (const p of alive) {
    if (p.choice === "stay") {
      if (deductBalance(p.name, cost)) {
        room.pot += cost;
        stayers.push(p);
      } else {
        p.choice = "fold";
        folders.push(p);
      }
    } else {
      folders.push(p);
    }
  }

  for (const p of folders) p.alive = false;

  broadcast(room, {
    type: "round_result",
    round: room.round,
    cost,
    costDollars: cents2dollars(cost),
    stayers: stayers.map((p) => p.name),
    folders: folders.map((p) => p.name),
    pot: room.pot,
    potDollars: cents2dollars(room.pot),
  });

  const remaining = room.players.filter((p) => p.alive);

  if (remaining.length <= 1) {
    room.state = "finished";

    if (remaining.length === 1) {
      const winner = remaining[0]!;
      addBalance(winner.name, room.pot);
      broadcast(room, {
        type: "game_over",
        winner: winner.name,
        pot: room.pot,
        potDollars: cents2dollars(room.pot),
        message: `${winner.name} wins $${cents2dollars(room.pot)}!`,
        players: room.players.map((p) => ({
          name: p.name,
          balance: getBalance(p.name),
          balanceDollars: cents2dollars(getBalance(p.name)),
        })),
      });
    } else {
      // All folded same round — split pot
      const share = Math.floor(room.pot / folders.length);
      for (const p of folders) addBalance(p.name, share);
      broadcast(room, {
        type: "game_over",
        winner: null,
        pot: room.pot,
        potDollars: cents2dollars(room.pot),
        message: "Everyone folded! Pot split equally.",
        players: room.players.map((p) => ({
          name: p.name,
          balance: getBalance(p.name),
          balanceDollars: cents2dollars(getBalance(p.name)),
        })),
      });
    }

    // Reset room to lobby after 8s
    setTimeout(() => {
      room.state = "lobby";
      room.round = 0;
      room.pot = 0;
      for (const p of room.players) {
        p.alive = true;
        p.choice = null;
      }
      broadcast(room, roomState(room));
    }, 8000);
    return;
  }

  // Next round after 3s pause
  room.round++;
  setTimeout(() => startRound(room), 3000);
}

// --- HTTP ---
const app = new Hono();

const mppx = Mppx.create({
  methods: [tempo({ currency: CURRENCY, recipient: RECIPIENT })],
});

app.use("/public/*", serveStatic({ root: "./" }));

// Deposit $0.01 → 1 credit via deposit code (test amount)
app.get(
  "/api/deposit/:code",
  mppx.charge({ amount: "0.01", description: "Deposit 1 game credit ($0.01)" }),
  async (c) => {
    const code = c.req.param("code").toUpperCase();
    const player = depositCodes.get(code);
    if (!player) return c.json({ error: "Invalid deposit code" }, 404);
    addBalance(player, 1);

    // Notify player via WebSocket that balance updated
    for (const room of rooms.values()) {
      const p = room.players.find((p) => p.name === player);
      if (p && p.ws.readyState === 1) {
        broadcast(room, roomState(room));
        break;
      }
    }

    return c.json({
      success: true,
      player,
      deposited: 100,
      balance: getBalance(player),
      balanceDollars: cents2dollars(getBalance(player)),
    });
  }
);

// Free: check balance
app.get("/api/balance", (c) => {
  const player = c.req.query("player");
  if (!player) return c.json({ error: "player query param required" }, 400);
  return c.json({
    player,
    balance: getBalance(player),
    balanceDollars: cents2dollars(getBalance(player)),
  });
});

// Free: list rooms
app.get("/api/rooms", (c) => {
  return c.json({
    rooms: Array.from(rooms.values()).map((r) => ({
      id: r.id,
      state: r.state,
      playerCount: r.players.length,
      players: r.players.map(p => ({ name: p.name, alive: p.alive })),
      host: r.host,
      pot: r.pot,
      potDollars: cents2dollars(r.pot),
      round: r.round,
    })),
  });
});

// Admin: grant credits (for testing)
app.get("/api/admin/grant", (c) => {
  const player = c.req.query("player");
  const amount = Number(c.req.query("amount") ?? 100);
  if (!player) return c.json({ error: "player required" }, 400);
  addBalance(player, amount);
  return c.json({
    player,
    granted: amount,
    balance: getBalance(player),
    balanceDollars: cents2dollars(getBalance(player)),
  });
});

// Admin: all balances
app.get("/api/admin/balances", (c) => {
  return c.json({ balances });
});

// Health
app.get("/api/health", (c) =>
  c.json({ status: "ok", service: "last-one-standing" })
);

// Serve admin panel
app.get("/admin", (c) => {
  const html = readFileSync("./public/admin.html", "utf-8");
  return c.html(html);
});

// Serve frontend
app.get("/", (c) => {
  const html = readFileSync("./public/index.html", "utf-8");
  return c.html(html);
});

// --- Start ---
const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log("");
  console.log("  LAST ONE STANDING");
  console.log(`  http://localhost:${info.port}`);
  console.log("");
  console.log("  Deposit credits (Tempo wallet):");
  console.log(
    `  tempo request http://localhost:${info.port}/api/deposit?player=YOUR_NAME`
  );
  console.log("");
  console.log("  Check balance:");
  console.log(
    `  curl http://localhost:${info.port}/api/balance?player=YOUR_NAME`
  );
  console.log("");
});

// --- WebSocket ---
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  let myName: string | null = null;
  let myRoom: Room | null = null;

  ws.on("message", (raw) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }

    switch (msg.type) {
      case "create_room": {
        const name = msg.player?.trim();
        if (!name) {
          ws.send(
            JSON.stringify({ type: "error", message: "Player name required" })
          );
          return;
        }

        // If a lobby room already exists, auto-join it instead
        const existingLobby = Array.from(rooms.values()).find(
          (r) => r.state === "lobby"
        );
        if (existingLobby) {
          if (existingLobby.players.some((p) => p.name === name)) {
            ws.send(
              JSON.stringify({ type: "error", message: "Name already taken" })
            );
            return;
          }
          existingLobby.players.push({ name, ws, alive: true, choice: null });
          myName = name;
          myRoom = existingLobby;
          ws.send(
            JSON.stringify({ type: "room_created", roomId: existingLobby.id })
          );
          broadcast(existingLobby, roomState(existingLobby));
          break;
        }

        const id = genRoomId();
        const room: Room = {
          id,
          players: [{ name, ws, alive: true, choice: null }],
          state: "lobby",
          round: 0,
          pot: 0,
          host: name,
          roundTimer: null,
        };
        rooms.set(id, room);
        myName = name;
        myRoom = room;

        ws.send(JSON.stringify({ type: "room_created", roomId: id }));
        broadcast(room, roomState(room));
        break;
      }

      case "join_room": {
        const name = msg.player?.trim();
        const id = msg.roomId?.trim()?.toUpperCase();
        if (!name || !id) {
          ws.send(
            JSON.stringify({
              type: "error",
              message: "Player name and room ID required",
            })
          );
          return;
        }
        const room = rooms.get(id);
        if (!room) {
          ws.send(
            JSON.stringify({ type: "error", message: "Room not found" })
          );
          return;
        }
        if (room.state !== "lobby") {
          ws.send(
            JSON.stringify({
              type: "error",
              message: "Game already in progress",
            })
          );
          return;
        }
        if (room.players.some((p) => p.name === name)) {
          ws.send(
            JSON.stringify({ type: "error", message: "Name already taken" })
          );
          return;
        }
        room.players.push({ name, ws, alive: true, choice: null });
        myName = name;
        myRoom = room;

        broadcast(room, roomState(room));
        break;
      }

      case "start_game": {
        if (!myRoom || !myName) return;
        if (myRoom.host !== myName) {
          ws.send(
            JSON.stringify({
              type: "error",
              message: "Only the host can start",
            })
          );
          return;
        }
        if (myRoom.players.length < 2) {
          ws.send(
            JSON.stringify({
              type: "error",
              message: "Need at least 2 players",
            })
          );
          return;
        }
        myRoom.state = "playing";
        myRoom.round = 1;
        myRoom.pot = 0;
        for (const p of myRoom.players) {
          p.alive = true;
          p.choice = null;
        }
        startRound(myRoom);
        break;
      }

      case "stay":
      case "fold": {
        if (!myRoom || !myName || myRoom.state !== "playing") return;
        const me = myRoom.players.find((p) => p.name === myName);
        if (!me || !me.alive || me.choice !== null) return;

        if (msg.type === "stay") {
          const cost = roundCost(myRoom.round);
          if (getBalance(myName) < cost) {
            ws.send(
              JSON.stringify({
                type: "error",
                message: `Insufficient balance! Need $${cents2dollars(cost)}`,
              })
            );
            me.choice = "fold";
            broadcast(myRoom, roomState(myRoom));
            checkAllChosen(myRoom);
            return;
          }
        }

        me.choice = msg.type;
        broadcast(myRoom, roomState(myRoom));
        checkAllChosen(myRoom);
        break;
      }
    }
  });

  ws.on("close", () => {
    if (!myRoom || !myName) return;
    const me = myRoom.players.find((p) => p.name === myName);
    if (!me) return;

    if (myRoom.state === "playing" && me.alive) {
      me.choice = "fold";
      me.alive = false;
      broadcast(myRoom, roomState(myRoom));
      checkAllChosen(myRoom);
    } else if (myRoom.state === "lobby") {
      myRoom.players = myRoom.players.filter((p) => p.name !== myName);
      if (myRoom.players.length === 0) {
        rooms.delete(myRoom.id);
      } else {
        if (myRoom.host === myName) myRoom.host = myRoom.players[0]!.name;
        broadcast(myRoom, roomState(myRoom));
      }
    }
  });
});
