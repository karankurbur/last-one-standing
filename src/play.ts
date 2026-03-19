#!/usr/bin/env node
import WebSocket from "ws";
import * as readline from "readline";

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

if (!name) {
  console.log("");
  console.log("  last-one-standing — Escalating stakes. One winner takes all.");
  console.log("");
  console.log("  Usage: npx last-one-standing <name> [--server <url>]");
  console.log("");
  console.log("  Examples:");
  console.log("    npx last-one-standing Karan");
  console.log("    npx last-one-standing Karan --server https://abc123.ngrok.io");
  console.log("");
  process.exit(1);
}

// --- Config ---
const SERVER = server.replace(/\/$/, "");
const WS_URL = SERVER.replace("http", "ws");

// --- ANSI helpers ---
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  white: "\x1b[37m",
  bgGreen: "\x1b[42m",
  bgRed: "\x1b[41m",
  bgYellow: "\x1b[43m",
  clear: "\x1b[2J\x1b[H",
};

// --- State ---
let currentState: any = null;
let myDepositCode = "";
let waitingForChoice = false;
let gamePhase: "connecting" | "lobby" | "playing" | "gameover" = "connecting";
let roundTimer: ReturnType<typeof setInterval> | null = null;
let secondsLeft = 0;

// --- Terminal ---
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

// Enable raw mode for single keypress
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}

function clear() {
  process.stdout.write(c.clear);
}

function print(s: string) {
  process.stdout.write(s + "\n");
}

function box(lines: string[], width = 50) {
  const top = "╔" + "═".repeat(width) + "╗";
  const bot = "╗" + "═".repeat(width) + "╝";
  print(top);
  for (const line of lines) {
    // Strip ANSI for length calc
    const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
    const pad = width - stripped.length;
    print("║ " + line + " ".repeat(Math.max(0, pad - 1)) + "║");
  }
  print("╚" + "═".repeat(width) + "╝");
}

function centerPad(s: string, width: number) {
  const stripped = s.replace(/\x1b\[[0-9;]*m/g, "");
  const pad = Math.max(0, width - stripped.length);
  const left = Math.floor(pad / 2);
  return " ".repeat(left) + s;
}

// --- Render ---
function renderLobby(state: any) {
  clear();
  const me = state.players.find((p: any) => p.name === name);
  myDepositCode = me?.depositCode ?? myDepositCode;
  const balance = me?.balanceDollars ?? "0.00";

  const lines: string[] = [
    "",
    `${c.bold}${c.yellow}  LAST ONE STANDING${c.reset}`,
    `${c.dim}  Escalating stakes. One winner takes all.${c.reset}`,
    "",
    `${c.dim}─────────────────────────────────────────────${c.reset}`,
    "",
    `  ${c.bold}Your balance: ${c.green}$${balance}${c.reset}`,
    "",
    `  ${c.bold}Players:${c.reset}`,
  ];

  for (const p of state.players) {
    const isMe = p.name === name;
    const isHost = p.name === state.host;
    const nameStr = isMe ? `${c.cyan}${p.name} (you)${c.reset}` : p.name;
    const hostBadge = isHost ? ` ${c.yellow}[HOST]${c.reset}` : "";
    const bal = `${c.dim}$${p.balanceDollars}${c.reset}`;
    lines.push(`    ${c.green}●${c.reset} ${nameStr}${hostBadge}  ${bal}`);
  }

  lines.push("");
  lines.push(`${c.dim}─────────────────────────────────────────────${c.reset}`);

  if (me && me.balance === 0) {
    lines.push("");
    lines.push(`  ${c.red}No credits!${c.reset} Deposit by running:`);
    lines.push("");
    lines.push(`  ${c.green}tempo request "${SERVER}/api/deposit/${myDepositCode}"${c.reset}`);
    lines.push("");
  } else {
    lines.push("");
    lines.push(`  ${c.dim}Add more credits:${c.reset}`);
    lines.push(`  ${c.green}tempo request "${SERVER}/api/deposit/${myDepositCode}"${c.reset}`);
    lines.push("");
  }

  const isHost = state.host === name;
  if (isHost) {
    if (state.players.length < 2) {
      lines.push(`  ${c.dim}Waiting for more players...${c.reset}`);
    } else {
      lines.push(`  ${c.bgGreen}${c.bold} Press [ENTER] to start the game ${c.reset}`);
    }
  } else {
    lines.push(`  ${c.dim}Waiting for ${state.host} to start...${c.reset}`);
  }

  lines.push("");

  for (const line of lines) print(line);
}

function renderRound(roundMsg: any) {
  clear();
  const state = currentState;
  const me = state?.players.find((p: any) => p.name === name);
  const balance = me?.balanceDollars ?? "0.00";
  const amAlive = roundMsg.alivePlayers.includes(name);

  const lines: string[] = [
    "",
    `${c.bold}${c.yellow}  LAST ONE STANDING${c.reset}`,
    "",
    `${c.dim}─────────────────────────────────────────────${c.reset}`,
    "",
    `  ${c.bold}${c.yellow}Prize Pool: $${state?.potDollars ?? "0.00"}${c.reset}`,
    "",
    `  ${c.bold}Round ${roundMsg.round}${c.reset}  ${c.dim}|${c.reset}  Cost: ${c.red}$${roundMsg.costDollars}${c.reset}  ${c.dim}|${c.reset}  Balance: ${c.green}$${balance}${c.reset}`,
    "",
  ];

  // Player list
  if (state) {
    for (const p of state.players) {
      const isMe = p.name === name;
      const alive = p.alive;
      const chosen = p.hasChosen;
      const status = !alive
        ? `${c.red}✗ eliminated${c.reset}`
        : chosen
          ? `${c.green}✓ locked in${c.reset}`
          : `${c.dim}deciding...${c.reset}`;
      const nameStr = isMe ? `${c.cyan}${p.name}${c.reset}` : p.name;
      lines.push(`    ${alive ? c.green + "●" : c.red + "●"}${c.reset} ${nameStr}  ${status}`);
    }
  }

  lines.push("");
  lines.push(`${c.dim}─────────────────────────────────────────────${c.reset}`);
  lines.push("");

  for (const line of lines) print(line);

  if (amAlive && waitingForChoice) {
    print(`  ${c.bold}${c.white}  [S]${c.reset} Stay In ${c.dim}(-$${roundMsg.costDollars})${c.reset}    ${c.bold}${c.white}[F]${c.reset} Fold`);
    print("");
  } else if (amAlive) {
    print(`  ${c.dim}Waiting for others...${c.reset}`);
    print("");
  } else {
    print(`  ${c.red}You've been eliminated. Spectating...${c.reset}`);
    print("");
  }
}

function renderTimer() {
  // Move cursor to timer position and update
  process.stdout.write(`\x1b[s\x1b[1;45H${c.bold}${secondsLeft <= 5 ? c.red : c.white}${secondsLeft}s${c.reset} \x1b[u`);
}

function renderRoundResult(msg: any) {
  if (roundTimer) {
    clearInterval(roundTimer);
    roundTimer = null;
  }
  waitingForChoice = false;

  print("");
  print(`${c.dim}─────────────────────────────────────────────${c.reset}`);
  print(`  ${c.bold}Round ${msg.round} Results:${c.reset}`);

  if (msg.stayers.length > 0) {
    print(`    ${c.green}Stayed:${c.reset} ${msg.stayers.join(", ")} ${c.dim}(-$${msg.costDollars} each)${c.reset}`);
  }
  if (msg.folders.length > 0) {
    print(`    ${c.red}Folded:${c.reset} ${msg.folders.join(", ")}`);
  }
  print(`    ${c.yellow}Pot: $${msg.potDollars}${c.reset}`);
  print("");
}

function renderGameOver(msg: any) {
  if (roundTimer) {
    clearInterval(roundTimer);
    roundTimer = null;
  }
  waitingForChoice = false;
  gamePhase = "gameover";

  clear();
  const lines: string[] = [
    "",
    `${c.bold}${c.yellow}  LAST ONE STANDING${c.reset}`,
    "",
    `${c.dim}═════════════════════════════════════════════${c.reset}`,
    "",
  ];

  if (msg.winner) {
    const isMe = msg.winner === name;
    if (isMe) {
      lines.push(`  ${c.bold}${c.green}  YOU WIN!  ${c.reset}`);
    } else {
      lines.push(`  ${c.bold}${c.red}  GAME OVER  ${c.reset}`);
    }
    lines.push("");
    lines.push(`  ${c.bold}Winner: ${c.yellow}${msg.winner} 👑${c.reset}`);
  } else {
    lines.push(`  ${c.bold}${c.yellow}  DRAW!  ${c.reset}`);
  }

  lines.push(`  ${c.bold}Prize: ${c.yellow}$${msg.potDollars}${c.reset}`);
  lines.push("");
  lines.push(`  ${msg.message}`);
  lines.push("");
  lines.push(`${c.dim}─────────────────────────────────────────────${c.reset}`);
  lines.push("");

  for (const p of msg.players) {
    const isMe = p.name === name;
    const isWinner = p.name === msg.winner;
    const nameStr = isMe ? `${c.cyan}${p.name}${c.reset}` : p.name;
    const crown = isWinner ? ` ${c.yellow}👑${c.reset}` : "";
    lines.push(`    ${nameStr}${crown}  ${c.green}$${p.balanceDollars}${c.reset}`);
  }

  lines.push("");
  lines.push(`  ${c.dim}Returning to lobby...${c.reset}`);
  lines.push("");

  for (const line of lines) print(line);
}

// --- WebSocket ---
let ws: WebSocket;
let currentRoundMsg: any = null;

function connect() {
  ws = new WebSocket(WS_URL);

  ws.on("open", () => {
    ws.send(JSON.stringify({ type: "create_room", player: name }));
  });

  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());

    switch (msg.type) {
      case "room_created":
        break;

      case "room_state":
        currentState = msg;
        if (msg.state === "lobby") {
          gamePhase = "lobby";
          renderLobby(msg);
        } else if (msg.state === "playing" && currentRoundMsg) {
          renderRound(currentRoundMsg);
        }
        break;

      case "round_start":
        gamePhase = "playing";
        currentRoundMsg = msg;
        waitingForChoice = msg.alivePlayers.includes(name);
        secondsLeft = msg.timer;

        renderRound(msg);

        if (roundTimer) clearInterval(roundTimer);
        roundTimer = setInterval(() => {
          secondsLeft--;
          if (secondsLeft <= 0) {
            if (roundTimer) clearInterval(roundTimer);
          }
          renderTimer();
        }, 1000);
        break;

      case "round_result":
        renderRoundResult(msg);
        break;

      case "game_over":
        renderGameOver(msg);
        break;

      case "error":
        print(`\n  ${c.red}Error: ${msg.message}${c.reset}\n`);
        break;
    }
  });

  ws.on("close", () => {
    print(`\n  ${c.red}Disconnected from server.${c.reset}`);
    process.exit(0);
  });

  ws.on("error", (err) => {
    print(`\n  ${c.red}Connection error: ${err.message}${c.reset}`);
    print(`  Make sure the server is running: ${c.green}npm run dev${c.reset}\n`);
    process.exit(1);
  });
}

// --- Input handling ---
process.stdin.on("data", (key) => {
  const k = key.toString();

  // Ctrl+C
  if (k === "\x03") {
    print(`\n  ${c.dim}Bye!${c.reset}\n`);
    process.exit(0);
  }

  if (gamePhase === "lobby") {
    // Enter to start game (host only)
    if (k === "\r" || k === "\n") {
      if (currentState?.host === name && currentState?.players.length >= 2) {
        ws.send(JSON.stringify({ type: "start_game" }));
      }
    }
  }

  if (gamePhase === "playing" && waitingForChoice) {
    const lower = k.toLowerCase();
    if (lower === "s") {
      ws.send(JSON.stringify({ type: "stay" }));
      waitingForChoice = false;
      if (currentRoundMsg) renderRound(currentRoundMsg);
    } else if (lower === "f") {
      ws.send(JSON.stringify({ type: "fold" }));
      waitingForChoice = false;
      if (currentRoundMsg) renderRound(currentRoundMsg);
    }
  }
});

// --- Start ---
clear();
print("");
print(`  ${c.bold}${c.yellow}LAST ONE STANDING${c.reset}`);
print(`  ${c.dim}Connecting as ${c.cyan}${name}${c.dim} to ${SERVER}...${c.reset}`);
print("");

connect();
