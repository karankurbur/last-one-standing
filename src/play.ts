#!/usr/bin/env node
import WebSocket from "ws";
import * as readline from "readline";
import { execSync, exec } from "child_process";

// --- Parse args ---
const args = process.argv.slice(2);
let name: string | undefined;
let server = "http://localhost:3000";
let depositAmount = "0.50";

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--server" || args[i] === "-s") {
    server = args[++i] ?? server;
  } else if (args[i] === "--deposit" || args[i] === "-d") {
    depositAmount = args[++i] ?? depositAmount;
  } else if (!args[i]!.startsWith("-")) {
    name = args[i];
  }
}

// --- Get wallet address from tempo CLI ---
let wallet: string;
try {
  const out = execSync("tempo wallet -j whoami", { encoding: "utf-8", timeout: 10_000 });
  const info = JSON.parse(out);
  if (!info.ready || !info.wallet) {
    console.log("\n  Tempo wallet not ready. Run: tempo wallet login\n");
    process.exit(1);
  }
  wallet = info.wallet.toLowerCase();
} catch (e: any) {
  console.log("\n  Could not read Tempo wallet. Make sure tempo CLI is installed.");
  console.log("  Run: tempo wallet login\n");
  process.exit(1);
}

const displayName = name || wallet.slice(0, 6) + "…" + wallet.slice(-4);

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
let waitingForChoice = false;
let paymentInProgress = false;
let gamePhase: "connecting" | "lobby" | "playing" | "gameover" = "connecting";
let roundTimer: ReturnType<typeof setInterval> | null = null;
let secondsLeft = 0;
let sessionReady = false;
let sessionOpening = false;
let myChannelId: string | null = null;

// --- Terminal ---
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}

function clear() {
  process.stdout.write(c.clear);
}

function print(s: string) {
  process.stdout.write(s + "\n");
}

// --- tempo request helper ---
function tempoRequest(url: string): Promise<{ success: boolean; output: string }> {
  return new Promise((resolve) => {
    exec(`tempo request "${url}"`, { timeout: 30_000 }, (error, stdout, stderr) => {
      if (error) {
        resolve({ success: false, output: stderr || error.message });
      } else {
        resolve({ success: true, output: stdout });
      }
    });
  });
}

// --- Poll for session readiness ---
let pollTimer: ReturnType<typeof setInterval> | null = null;

function startSessionPolling() {
  if (pollTimer || sessionReady) return;
  pollTimer = setInterval(async () => {
    if (sessionReady) {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      return;
    }
    try {
      const res = await fetch(`${SERVER}/api/session/status?wallet=${wallet}`);
      const json = await res.json() as any;
      if (json.ready && json.channelId) {
        myChannelId = json.channelId;
        sessionReady = true;
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        ws.send(JSON.stringify({ type: "session_ready", channelId: myChannelId }));
        renderLobby(currentState);
      }
    } catch {}
  }, 2000);
}

// --- Render ---
function renderLobby(state: any) {
  if (!state) return;
  clear();

  const lines: string[] = [
    "",
    `${c.bold}${c.yellow}  LAST ONE STANDING${c.reset}`,
    `${c.dim}  Escalating stakes. One winner takes all.${c.reset}`,
    "",
    `${c.dim}─────────────────────────────────────────────${c.reset}`,
    "",
    `  ${c.bold}Wallet: ${c.cyan}${wallet}${c.reset}`,
    "",
  ];

  // Session status + balance
  const me = state.players.find((p: any) => p.wallet === wallet);
  const sessionBal = me?.sessionBalance;

  if (sessionOpening) {
    lines.push(`  ${c.yellow}⏳ Opening payment session...${c.reset}`);
  } else if (sessionReady) {
    lines.push(`  ${c.green}✓ Session active${c.reset} ${c.dim}(Channel: ${myChannelId?.slice(0, 10) ?? "?"}...)${c.reset}`);
    if (sessionBal) lines.push(`  ${c.bold}Session balance: ${c.green}$${sessionBal}${c.reset}`);
  } else {
    lines.push(`  ${c.red}✗ No session${c.reset}`);
    lines.push("");
    lines.push(`  ${c.dim}Run in another terminal to deposit (default $0.10):${c.reset}`);
    lines.push(`  ${c.green}tempo request "${SERVER}/api/session/open"${c.reset}`);
    lines.push("");
    lines.push(`  ${c.dim}Or specify deposit amount:${c.reset}`);
    lines.push(`  ${c.green}tempo request "${SERVER}/api/session/open?deposit=1.00"${c.reset}`);
    lines.push("");
    lines.push(`  ${c.dim}Game will detect your deposit automatically.${c.reset}`);
  }

  lines.push("");
  lines.push(`  ${c.bold}Players:${c.reset}`);

  for (const p of state.players) {
    const isMe = p.wallet === wallet;
    const isHost = p.wallet === state.host;
    const nameStr = isMe ? `${c.cyan}${p.name} (you)${c.reset}` : p.name;
    const hostBadge = isHost ? ` ${c.yellow}[HOST]${c.reset}` : "";
    const ready = p.sessionReady ? `${c.green}✓${c.reset}` : `${c.dim}…${c.reset}`;
    lines.push(`    ${ready} ${nameStr}${hostBadge}`);
  }

  lines.push("");
  lines.push(`${c.dim}─────────────────────────────────────────────${c.reset}`);
  lines.push("");

  const isHost = state.host === wallet;
  if (isHost) {
    if (state.players.length < 2) {
      lines.push(`  ${c.dim}Waiting for more players...${c.reset}`);
    } else {
      const allReady = state.players.every((p: any) => p.sessionReady);
      if (allReady) {
        lines.push(`  ${c.bgGreen}${c.bold} Press [ENTER] to start the game ${c.reset}`);
      } else {
        lines.push(`  ${c.dim}Waiting for all players to open sessions...${c.reset}`);
      }
    }
  } else {
    const hostPlayer = state.players.find((p: any) => p.wallet === state.host);
    const hostName = hostPlayer?.name ?? "host";
    lines.push(`  ${c.dim}Waiting for ${hostName} to start...${c.reset}`);
  }

  lines.push("");
  if (sessionReady) {
    lines.push(`  ${c.dim}[T] Top-up  [W] Withdraw deposit  [Ctrl+C] Quit${c.reset}`);
  } else {
    lines.push(`  ${c.dim}[Ctrl+C] Quit${c.reset}`);
  }
  lines.push("");

  for (const line of lines) print(line);
}

function renderRound(roundMsg: any) {
  clear();
  const state = currentState;
  const amAlive = roundMsg.alivePlayers.includes(wallet);
  const me = state?.players.find((p: any) => p.wallet === wallet);
  const sessionBal = me?.sessionBalance ?? "?";

  const lines: string[] = [
    "",
    `${c.bold}${c.yellow}  LAST ONE STANDING${c.reset}`,
    "",
    `${c.dim}─────────────────────────────────────────────${c.reset}`,
    "",
    `  ${c.bold}${c.yellow}Prize Pool: $${state?.potDollars ?? "0.00"}${c.reset}`,
    "",
    `  ${c.bold}Round ${roundMsg.round}${c.reset}  ${c.dim}|${c.reset}  Cost: ${c.red}$${roundMsg.costDollars}${c.reset}  ${c.dim}|${c.reset}  Session: ${c.green}$${sessionBal}${c.reset}`,
    "",
  ];

  if (state) {
    for (const p of state.players) {
      const isMe = p.wallet === wallet;
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

  if (amAlive && paymentInProgress) {
    print(`  ${c.yellow}⏳ Processing payment...${c.reset}`);
    print("");
  } else if (amAlive && waitingForChoice) {
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
  process.stdout.write(`\x1b[s\x1b[1;45H${c.bold}${secondsLeft <= 5 ? c.red : c.white}${secondsLeft}s${c.reset} \x1b[u`);
}

function renderRoundResult(msg: any) {
  if (roundTimer) {
    clearInterval(roundTimer);
    roundTimer = null;
  }
  waitingForChoice = false;
  paymentInProgress = false;

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
  paymentInProgress = false;
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
    const isMe = msg.winnerWallet === wallet;
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
    const isMe = p.wallet === wallet;
    const isWinner = p.name === msg.winner;
    const nameStr = isMe ? `${c.cyan}${p.name}${c.reset}` : p.name;
    const crown = isWinner ? ` ${c.yellow}👑${c.reset}` : "";
    lines.push(`    ${nameStr}${crown}`);
  }

  lines.push("");
  lines.push(`  ${c.dim}Settling on-chain...${c.reset}`);
  lines.push(`  ${c.dim}Returning to lobby...${c.reset}`);
  lines.push("");

  for (const line of lines) print(line);

  // Channel closed after game — need new session next game
  sessionReady = false;
  myChannelId = null;
}

// --- WebSocket ---
let ws: WebSocket;
let currentRoundMsg: any = null;

function connect() {
  ws = new WebSocket(WS_URL);

  ws.on("open", () => {
    ws.send(JSON.stringify({ type: "create_room", wallet, player: name || undefined }));
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
          if (!sessionReady) startSessionPolling();
          renderLobby(msg);
        } else if (msg.state === "playing" && currentRoundMsg) {
          renderRound(currentRoundMsg);
        }
        break;

      case "round_start":
        gamePhase = "playing";
        currentRoundMsg = msg;
        waitingForChoice = msg.alivePlayers.includes(wallet);
        paymentInProgress = false;
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

      case "payout":
        print(`\n  ${c.green}${c.bold}💰 Payout: $${msg.amount} → ${msg.winner}${c.reset}`);
        print(`  ${c.dim}tx: ${msg.txHash}${c.reset}\n`);
        break;

      case "player_withdrew":
        print(`\n  ${c.yellow}${msg.message}${c.reset}\n`);
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
      if (currentState?.host === wallet && currentState?.players.length >= 1) {
        ws.send(JSON.stringify({ type: "start_game" }));
      }
    }
    // T to top-up
    if (k.toLowerCase() === "t" && sessionReady) {
      print(`\n  ${c.yellow}⏳ Topping up...${c.reset}`);
      tempoRequest(`${SERVER}/api/session/topup`).then((result) => {
        if (result.success) {
          print(`  ${c.green}✓ Top-up successful${c.reset}\n`);
        } else {
          print(`  ${c.red}Top-up failed: ${result.output.trim()}${c.reset}\n`);
        }
      });
    }
  }

  if (gamePhase === "playing" && waitingForChoice && !paymentInProgress) {
    const lower = k.toLowerCase();
    if (lower === "s") {
      waitingForChoice = false;
      paymentInProgress = true;
      if (currentRoundMsg) renderRound(currentRoundMsg);

      const round = currentRoundMsg?.round ?? 1;
      tempoRequest(`${SERVER}/api/session/stay?round=${round}`).then((result) => {
        paymentInProgress = false;
        if (result.success) {
          ws.send(JSON.stringify({ type: "stay_confirmed", round }));
        } else {
          print(`  ${c.red}Payment failed — auto-folding${c.reset}`);
          ws.send(JSON.stringify({ type: "fold" }));
        }
      });
    } else if (lower === "f") {
      ws.send(JSON.stringify({ type: "fold" }));
      waitingForChoice = false;
      if (currentRoundMsg) renderRound(currentRoundMsg);
    }
  }

  // W to withdraw deposit (lobby only)
  if (k.toLowerCase() === "w" && sessionReady && gamePhase === "lobby") {
    print(`\n  ${c.yellow}⏳ Withdrawing deposit...${c.reset}`);
    fetch(`${SERVER}/api/session/withdraw?wallet=${wallet}`)
      .then((res) => res.json())
      .then((json: any) => {
        if (json.success) {
          sessionReady = false;
          myChannelId = null;
          print(`  ${c.green}✓ Channel closed. $${json.returned} returned to your wallet.${c.reset}`);
          print(`  ${c.dim}tx: ${json.txHash}${c.reset}\n`);
        } else {
          print(`  ${c.red}${json.error}${c.reset}\n`);
        }
        renderLobby(currentState);
      })
      .catch(() => print(`  ${c.red}Failed to reach server.${c.reset}\n`));
  }

  // T to top-up during game
  if (gamePhase === "playing" && k.toLowerCase() === "t") {
    tempoRequest(`${SERVER}/api/session/topup`).then((result) => {
      if (result.success) {
        print(`  ${c.green}✓ Top-up successful${c.reset}`);
      }
    });
  }
});

// --- Start ---
clear();
print("");
print(`  ${c.bold}${c.yellow}LAST ONE STANDING${c.reset}`);
print(`  ${c.dim}Wallet: ${c.cyan}${wallet}${c.reset}`);
if (name) print(`  ${c.dim}Name: ${c.cyan}${name}${c.reset}`);
print(`  ${c.dim}Deposit: ${c.cyan}$${depositAmount}${c.reset}`);
print(`  ${c.dim}Connecting to ${SERVER}...${c.reset}`);
print("");

connect();
