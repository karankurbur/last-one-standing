#!/usr/bin/env node
import WebSocket from "ws";
import { execSync, exec } from "child_process";

// --- Parse args ---
const args = process.argv.slice(2);
let name: string | undefined;
let server = "https://lenient-notably-mole.ngrok-free.app";

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--server" || args[i] === "-s") {
    server = args[++i] ?? server;
  } else if (!args[i]!.startsWith("-")) {
    name = args[i];
  }
}

// --- Get wallet ---
let wallet: string;
try {
  const out = execSync("tempo wallet -j whoami", { encoding: "utf-8", timeout: 10_000 });
  const info = JSON.parse(out);
  if (!info.ready || !info.wallet) {
    console.log("\n  Tempo wallet not ready. Run: tempo wallet login\n");
    process.exit(1);
  }
  wallet = info.wallet.toLowerCase();
} catch {
  console.log("\n  Could not read Tempo wallet. Run: tempo wallet login\n");
  process.exit(1);
}

const displayName = name || wallet.slice(0, 6) + "…" + wallet.slice(-4);
const SERVER = server.replace(/\/$/, "");
const WS_URL = SERVER.replace("http", "ws");

// --- Terminal setup ---
const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  bgRed: "\x1b[41m",
  bgGreen: "\x1b[42m",
  bgYellow: "\x1b[43m",
  bgBlue: "\x1b[44m",
  bgMagenta: "\x1b[45m",
  bgCyan: "\x1b[46m",
  clear: "\x1b[2J\x1b[H",
  hideCursor: "\x1b[?25l",
  showCursor: "\x1b[?25h",
};

// Color map for snake bodies
const SNAKE_COLORS = [
  ANSI.green,   // 1
  ANSI.red,     // 2
  ANSI.blue,    // 3
  ANSI.yellow,  // 4
  ANSI.magenta, // 5
  ANSI.cyan,    // 6
];

const SNAKE_BG = [
  ANSI.bgGreen,
  ANSI.bgRed,
  ANSI.bgBlue,
  ANSI.bgYellow,
  ANSI.bgMagenta,
  ANSI.bgCyan,
];

// --- Get terminal size ---
function getTermSize(): { cols: number; rows: number } {
  return {
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
  };
}

// --- State ---
let gameState: any = null;
let gamePhase: "connecting" | "lobby" | "playing" | "gameover" = "connecting";
let sessionReady = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;

// --- Raw mode ---
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
}
process.stdout.write(ANSI.hideCursor);
process.on("exit", () => process.stdout.write(ANSI.showCursor));

function write(s: string) {
  process.stdout.write(s);
}

function moveTo(x: number, y: number) {
  write(`\x1b[${y + 1};${x + 1}H`);
}

// --- Session polling ---
function startSessionPolling() {
  if (pollTimer || sessionReady) return;
  pollTimer = setInterval(async () => {
    if (sessionReady) { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } return; }
    try {
      const res = await fetch(`${SERVER}/api/session/status?wallet=${wallet}`);
      const json = await res.json() as any;
      if (json.ready) {
        sessionReady = true;
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        ws.send(JSON.stringify({ type: "session_ready", channelId: json.channelId }));
      }
    } catch {}
  }, 2000);
}

// --- Render ---
function renderLobby(state: any) {
  write(ANSI.clear);
  const lines = [
    "",
    `${ANSI.bold}${ANSI.green}  SNAKE ROYALE${ANSI.reset}`,
    `${ANSI.dim}  Last snake slithering wins the pot.${ANSI.reset}`,
    "",
    `${ANSI.dim}─────────────────────────────────────────${ANSI.reset}`,
    "",
    `  Wallet: ${ANSI.cyan}${wallet}${ANSI.reset}`,
    "",
  ];

  if (sessionReady) {
    lines.push(`  ${ANSI.green}✓ Session active${ANSI.reset}`);
  } else {
    lines.push(`  ${ANSI.red}✗ No session${ANSI.reset}`);
    lines.push("");
    lines.push(`  ${ANSI.dim}Run in another terminal:${ANSI.reset}`);
    lines.push(`  ${ANSI.green}tempo request "${SERVER}/api/session/open"${ANSI.reset}`);
    lines.push("");
    lines.push(`  ${ANSI.dim}Game will detect automatically.${ANSI.reset}`);
  }

  lines.push("");
  lines.push(`  ${ANSI.bold}Players:${ANSI.reset}`);

  if (state?.snakes) {
    for (const s of state.snakes) {
      const isMe = s.wallet === wallet;
      const color = SNAKE_COLORS[(s.color - 1) % SNAKE_COLORS.length]!;
      const nameStr = isMe ? `${ANSI.cyan}${s.name} (you)${ANSI.reset}` : s.name;
      const ready = s.sessionReady ? `${ANSI.green}✓${ANSI.reset}` : `${ANSI.dim}…${ANSI.reset}`;
      const isHost = s.wallet === state.host;
      const host = isHost ? ` ${ANSI.yellow}[HOST]${ANSI.reset}` : "";
      lines.push(`    ${ready} ${color}█${ANSI.reset} ${nameStr}${host}`);
    }
  }

  lines.push("");
  lines.push(`${ANSI.dim}─────────────────────────────────────────${ANSI.reset}`);
  lines.push("");

  const isHost = state?.host === wallet;
  if (isHost && state?.snakes?.length >= 1) {
    const allReady = state.snakes.every((s: any) => s.sessionReady);
    if (allReady) {
      lines.push(`  ${ANSI.bgGreen}${ANSI.bold} Press [Enter] to start ${ANSI.reset}`);
    } else {
      lines.push(`  ${ANSI.dim}Waiting for all players to open sessions...${ANSI.reset}`);
    }
  } else {
    lines.push(`  ${ANSI.dim}Waiting for host to start...${ANSI.reset}`);
  }

  lines.push("");
  lines.push(`  ${ANSI.dim}Controls: Arrow keys / WASD${ANSI.reset}`);
  lines.push(`  ${ANSI.dim}[Ctrl+C] Quit${ANSI.reset}`);
  lines.push("");

  for (const line of lines) write(line + "\n");
}

function renderGame(state: any) {
  if (!state) return;
  const { cols, rows } = getTermSize();
  const gridW = state.gridW as number;
  const gridH = state.gridH as number;

  // Calculate offsets to center the grid
  const borderW = gridW + 2; // +2 for left/right border
  const borderH = gridH + 2; // +2 for top/bottom border
  const offsetX = Math.max(0, Math.floor((cols - borderW) / 2));
  const offsetY = Math.max(0, Math.floor((rows - borderH - 4) / 2)); // -4 for HUD

  write(ANSI.clear);

  // HUD top
  const mySnake = state.snakes?.find((s: any) => s.wallet === wallet);
  const potStr = `Pot: $${state.potDollars}`;
  const tickStr = `Tick: ${state.tick}`;
  const freeStr = mySnake ? `Free ticks: ${mySnake.freeTicks}` : "";
  moveTo(offsetX, offsetY);
  write(`${ANSI.bold}${ANSI.green}SNAKE ROYALE${ANSI.reset}  ${ANSI.yellow}${potStr}${ANSI.reset}  ${ANSI.dim}${tickStr}  ${freeStr}${ANSI.reset}`);

  // Player status line
  moveTo(offsetX, offsetY + 1);
  const aliveSnakes = state.snakes?.filter((s: any) => s.alive) ?? [];
  const statusParts = (state.snakes ?? []).map((s: any) => {
    const color = SNAKE_COLORS[(s.color - 1) % SNAKE_COLORS.length]!;
    const alive = s.alive ? "●" : "✗";
    const isMe = s.wallet === wallet;
    return `${color}${alive}${ANSI.reset} ${isMe ? ANSI.cyan : ""}${s.name}${isMe ? ANSI.reset : ""}`;
  });
  write(statusParts.join("  "));

  // Top border
  moveTo(offsetX, offsetY + 2);
  write(`┌${"─".repeat(gridW)}┐`);

  // Build grid buffer
  const grid: string[][] = Array.from({ length: gridH }, () =>
    Array.from({ length: gridW }, () => " ")
  );

  // Place food
  for (const f of state.food ?? []) {
    if (f.y >= 0 && f.y < gridH && f.x >= 0 && f.x < gridW) {
      grid[f.y]![f.x] = `${ANSI.red}●${ANSI.reset}`;
    }
  }

  // Place snakes
  for (const s of state.snakes ?? []) {
    if (!s.alive) continue;
    const color = SNAKE_COLORS[(s.color - 1) % SNAKE_COLORS.length]!;
    const bg = SNAKE_BG[(s.color - 1) % SNAKE_BG.length]!;
    for (let i = 0; i < s.body.length; i++) {
      const p = s.body[i]!;
      if (p.y >= 0 && p.y < gridH && p.x >= 0 && p.x < gridW) {
        if (i === 0) {
          // Head
          const headChar = s.wallet === wallet ? "@" : "O";
          grid[p.y]![p.x] = `${bg}${ANSI.bold}${headChar}${ANSI.reset}`;
        } else {
          grid[p.y]![p.x] = `${color}█${ANSI.reset}`;
        }
      }
    }
  }

  // Render grid rows
  for (let y = 0; y < gridH; y++) {
    moveTo(offsetX, offsetY + 3 + y);
    write(`│${grid[y]!.join("")}│`);
  }

  // Bottom border
  moveTo(offsetX, offsetY + 3 + gridH);
  write(`└${"─".repeat(gridW)}┘`);

  // Bottom HUD
  moveTo(offsetX, offsetY + 4 + gridH);
  if (mySnake && !mySnake.alive) {
    write(`${ANSI.red}You died! Spectating...${ANSI.reset}`);
  } else {
    write(`${ANSI.dim}Arrow keys / WASD to move${ANSI.reset}`);
  }
}

function renderGameOver(msg: any) {
  gamePhase = "gameover";
  write(ANSI.clear);
  const lines = [
    "",
    `${ANSI.bold}${ANSI.green}  SNAKE ROYALE${ANSI.reset}`,
    "",
    `${ANSI.dim}═════════════════════════════════════════${ANSI.reset}`,
    "",
  ];

  if (msg.winner) {
    const isMe = msg.winnerWallet === wallet;
    lines.push(isMe
      ? `  ${ANSI.bold}${ANSI.green}YOU WIN!${ANSI.reset}`
      : `  ${ANSI.bold}${ANSI.red}GAME OVER${ANSI.reset}`);
    lines.push("");
    lines.push(`  Winner: ${ANSI.yellow}${msg.winner} 🐍${ANSI.reset}`);
  } else {
    lines.push(`  ${ANSI.bold}${ANSI.red}NO SURVIVORS${ANSI.reset}`);
  }

  lines.push(`  Prize: ${ANSI.yellow}$${msg.potDollars}${ANSI.reset}`);
  lines.push("");
  lines.push(`  ${msg.message}`);
  lines.push("");
  lines.push(`${ANSI.dim}─────────────────────────────────────────${ANSI.reset}`);
  lines.push("");

  for (const s of msg.snakes ?? []) {
    const isMe = s.wallet === wallet;
    const nameStr = isMe ? `${ANSI.cyan}${s.name}${ANSI.reset}` : s.name;
    const status = s.alive ? `${ANSI.green}survived${ANSI.reset}` : `${ANSI.red}died${ANSI.reset}`;
    lines.push(`    ${nameStr}  ${status}  paid: $${s.totalPaid}`);
  }

  lines.push("");
  lines.push(`  ${ANSI.dim}Returning to lobby...${ANSI.reset}`);
  lines.push("");

  for (const line of lines) write(line + "\n");

  sessionReady = false;
}

// --- WebSocket ---
let ws: WebSocket;

function connect() {
  ws = new WebSocket(WS_URL);

  ws.on("open", () => {
    ws.send(JSON.stringify({ type: "join", wallet, name: name || undefined }));
  });

  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());

    switch (msg.type) {
      case "joined":
        break;

      case "game_state":
        gameState = msg;
        if (msg.state === "lobby") {
          gamePhase = "lobby";
          if (!sessionReady) startSessionPolling();
          renderLobby(msg);
        } else if (msg.state === "playing") {
          gamePhase = "playing";
          renderGame(msg);
        }
        break;

      case "game_start":
        gamePhase = "playing";
        break;

      case "game_over":
        renderGameOver(msg);
        break;

      case "payout":
        write(`\n  ${ANSI.green}${ANSI.bold}💰 Payout: $${msg.amount} → ${msg.winner}${ANSI.reset}`);
        write(`\n  ${ANSI.dim}tx: ${msg.txHash}${ANSI.reset}\n`);
        break;

      case "error":
        write(`\n  ${ANSI.red}Error: ${msg.message}${ANSI.reset}\n`);
        break;
    }
  });

  ws.on("close", () => {
    write(`\n  ${ANSI.red}Disconnected.${ANSI.reset}\n`);
    process.stdout.write(ANSI.showCursor);
    process.exit(0);
  });

  ws.on("error", (err) => {
    write(`\n  ${ANSI.red}Connection error: ${err.message}${ANSI.reset}\n`);
    process.stdout.write(ANSI.showCursor);
    process.exit(1);
  });
}

// --- Input ---
process.stdin.on("data", (key) => {
  const k = key.toString();

  // Ctrl+C
  if (k === "\x03") {
    process.stdout.write(ANSI.showCursor);
    write(`\n  ${ANSI.dim}Bye!${ANSI.reset}\n`);
    process.exit(0);
  }

  if (gamePhase === "lobby") {
    if (k === "\r" || k === "\n") {
      ws.send(JSON.stringify({ type: "start" }));
    }
  }

  if (gamePhase === "playing") {
    let dir: string | null = null;

    // Arrow keys
    if (k === "\x1b[A" || k === "w" || k === "W") dir = "up";
    if (k === "\x1b[B" || k === "s" || k === "S") dir = "down";
    if (k === "\x1b[D" || k === "a" || k === "A") dir = "left";
    if (k === "\x1b[C" || k === "d" || k === "D") dir = "right";

    if (dir) {
      ws.send(JSON.stringify({ type: "dir", dir }));
    }
  }
});

// --- Handle resize ---
process.stdout.on("resize", () => {
  if (gamePhase === "playing" && gameState) {
    renderGame(gameState);
  }
});

// --- Start ---
write(ANSI.clear);
write(`\n  ${ANSI.bold}${ANSI.green}SNAKE ROYALE${ANSI.reset}\n`);
write(`  ${ANSI.dim}Wallet: ${ANSI.cyan}${wallet}${ANSI.reset}\n`);
write(`  ${ANSI.dim}Connecting to ${SERVER}...${ANSI.reset}\n\n`);
connect();
