import { Hono } from "hono";
import { Mppx, tempo } from "mppx/hono";
import { Credential, Receipt, Store } from "mppx";
import { tempo as tempoServer } from "mppx/server";
import { Session } from "mppx/tempo";
import { serve } from "@hono/node-server";
import { WebSocketServer, WebSocket } from "ws";
import { createClient, createWalletClient, http, formatUnits, type Hex, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { tempo as tempoChain } from "viem/chains";

// --- Config ---
const CURRENCY = "0x20C000000000000000000000b9537d11c60E8b50" as Address; // USDC.e on Tempo
const RECIPIENT = "0xd614701C9Ceef0a82e79Bf65ba8B9dd7A9d741fE" as Address; // payout wallet
const ESCROW = "0x33b901018174DDabE4841042ab76ba85D4e24f25" as Address; // payment channel escrow
const ADMIN_WALLET = "0x454fe1f25eed444d0dfb72a22beaf8cc40a5abd5"; // only this wallet can start games
const PORT = Number(process.env.PORT ?? 3000);
const ROUND_TIMER_MS = 60_000;
const DECIMALS = 6;
const DEV_MODE = process.argv.includes("--dev");
const MIN_PLAYERS = DEV_MODE ? 1 : 2;
const DEV_MAX_ROUNDS = 3;
const SUGGESTED_DEPOSIT = "1.00"; // suggest $1.00 deposit for session
const SHOW_BIDS = process.argv.includes("--show-bids"); // show bid amounts during round (default: hidden)
const MAX_LIVES = Number(process.env.MAX_LIVES ?? 3);

// --- Store & Channel tracking ---
const store = Store.memory();
const channelStore = Session.ChannelStore.fromStore(store);

// --- Settle / payout client ---
const SETTLE_KEY = process.env.SETTLE_PRIVATE_KEY;
const settleAccount = SETTLE_KEY ? privateKeyToAccount(SETTLE_KEY as `0x${string}`) : null;
const viemClient = settleAccount
  ? createWalletClient({ account: settleAccount, chain: tempoChain, transport: http("https://tempo-mainnet.g.alchemy.com/v2/wvo-jvwr3Nsw1nDafH25v") })
  : null;

// wallet → channelId (active)
const walletChannels = new Map<string, Hex>();
// channelId → wallet
const channelWallets = new Map<Hex, string>();
// All channels ever opened (for user to claim later)
const channelHistory: { wallet: string; channelId: Hex; openedAt: string }[] = [];

// --- Game Types ---
interface Player {
  wallet: string;
  name: string;
  ws: WebSocket;
  alive: boolean;
  lives: number;
  bid: number | null; // cents, null = hasn't bid yet, 0 = folded
  finalChoice: "rock" | "paper" | "scissors" | null; // for the finale
  channelId: Hex | null;
  sessionReady: boolean;
}

interface Room {
  id: string;
  players: Player[];
  state: "lobby" | "playing" | "finale" | "finished";
  round: number;
  pot: number; // in cents for display
  host: string; // wallet address
  roundTimer: ReturnType<typeof setTimeout> | null;
}

const rooms = new Map<string, Room>();

// --- Helpers ---
function genRoomId(): string {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function cents2dollars(c: number): string {
  return (c / 100).toFixed(2);
}

function shortAddr(wallet: string): string {
  return wallet.slice(0, 6) + "…" + wallet.slice(-4);
}

function extractWallet(source: string): string | null {
  const match = source.match(/0x[0-9a-fA-F]{40}/);
  return match ? match[0].toLowerCase() : null;
}

// --- Channel balance helper ---
async function getChannelBalance(channelId: Hex | null): Promise<string | null> {
  if (!channelId) return null;
  try {
    const state = await channelStore.getChannel(channelId);
    if (!state) return null;
    const available = state.deposit - state.highestVoucherAmount;
    return formatUnits(available < 0n ? 0n : available, DECIMALS);
  } catch { return null; }
}

// --- Broadcasting ---
function broadcast(room: Room, msg: object) {
  const data = JSON.stringify(msg);
  for (const p of room.players) {
    if (p.ws.readyState === WebSocket.OPEN) p.ws.send(data);
  }
}

async function broadcastState(room: Room) {
  broadcast(room, await roomState(room));
}

async function roomState(room: Room) {
  const players = await Promise.all(
    room.players.map(async (p) => ({
      wallet: p.wallet,
      name: p.name,
      alive: p.alive,
      lives: p.lives,
      sessionReady: p.sessionReady,
      hasBid: p.bid !== null,
      bidDollars: SHOW_BIDS && p.bid !== null && p.bid > 0 ? cents2dollars(p.bid) : null,
      hasFinaleChoice: p.finalChoice !== null,
      sessionBalance: await getChannelBalance(p.channelId),
    }))
  );
  return {
    type: "room_state",
    roomId: room.id,
    state: room.state,
    round: room.round,
    pot: room.pot,
    potDollars: cents2dollars(room.pot),
    host: room.host,
    maxLives: MAX_LIVES,
    players,
  };
}

// --- Game Logic ---
function startRound(room: Room) {
  const alive = room.players.filter((p) => p.alive);

  for (const p of alive) p.bid = null;

  broadcast(room, {
    type: "round_start",
    round: room.round,
    timer: ROUND_TIMER_MS / 1000,
    alivePlayers: alive.map((p) => p.wallet),
  });
  broadcastState(room);

  room.roundTimer = setTimeout(() => {
    for (const p of alive) {
      if (p.bid === null) p.bid = 0; // didn't bid = fold
    }
    resolveRound(room);
  }, ROUND_TIMER_MS);
}

function checkAllBid(room: Room) {
  const alive = room.players.filter((p) => p.alive);
  if (alive.every((p) => p.bid !== null)) {
    if (room.roundTimer) {
      clearTimeout(room.roundTimer);
      room.roundTimer = null;
    }
    resolveRound(room);
  }
}

function resolveRound(room: Room) {
  const alive = room.players.filter((p) => p.alive);

  // Everyone is a bidder (0 is a valid bid)
  const bidders = alive;
  for (const p of bidders) {
    if (p.bid === null) p.bid = 0;
  }

  // Find the lowest bid among bidders
  let eliminated: Player[] = [];
  let survivors: Player[] = [];

  if (bidders.length > 1) {
    const lowestBid = Math.min(...bidders.map((p) => p.bid!));
    // Eliminate all players with the lowest bid (ties = all eliminated)
    for (const p of bidders) {
      if (p.bid === lowestBid) {
        eliminated.push(p);
      } else {
        survivors.push(p);
      }
    }
    // If everyone bid the same amount, nobody is eliminated this round
    if (eliminated.length === bidders.length) {
      survivors = bidders;
      eliminated = [];
    }
  } else {
    survivors = bidders;
  }

  // All bids go into the pot
  for (const p of bidders) {
    room.pot += p.bid!;
  }

  // Lose a life for lowest bidders
  for (const p of eliminated) {
    p.lives--;
    if (p.lives <= 0) p.alive = false;
  }

  broadcast(room, {
    type: "round_result",
    round: room.round,
    bids: bidders.map((p) => ({ name: p.name, bid: p.bid!, bidDollars: cents2dollars(p.bid!), lives: p.lives })),
    eliminated: eliminated.map((p) => ({ name: p.name, lives: p.lives })),
    survivors: survivors.map((p) => ({ name: p.name, lives: p.lives })),
    maxLives: MAX_LIVES,
    pot: room.pot,
    potDollars: cents2dollars(room.pot),
  });

  const remaining = room.players.filter((p) => p.alive);

  // 2 players left → Rock Paper Scissors finale
  if (remaining.length === 2) {
    room.state = "finale";
    for (const p of remaining) p.finalChoice = null;

    broadcast(room, {
      type: "finale_start",
      pot: room.pot,
      potDollars: cents2dollars(room.pot),
      finalists: remaining.map((p) => p.name),
      timer: ROUND_TIMER_MS / 1000,
      message: `Rock Paper Scissors! $${cents2dollars(room.pot)} on the line.`,
    });

    room.roundTimer = setTimeout(() => {
      // Timeout = random choice
      const choices: ("rock" | "paper" | "scissors")[] = ["rock", "paper", "scissors"];
      for (const p of remaining) {
        if (p.finalChoice === null) p.finalChoice = choices[Math.floor(Math.random() * 3)]!;
      }
      resolveFinale(room);
    }, ROUND_TIMER_MS);
    return;
  }

  // 1 player left → they win outright
  if (remaining.length === 1) {
    endGame(room, remaining[0]!, `${remaining[0]!.name} wins $${cents2dollars(room.pot)}!`);
    return;
  }

  // 0 players left → everyone folded
  if (remaining.length === 0) {
    endGame(room, null, `Everyone folded! Pot ($${cents2dollars(room.pot)}) is lost.`);
    return;
  }

  // Dev mode: cap rounds
  if (DEV_MODE && room.round >= DEV_MAX_ROUNDS) {
    // Force finale with remaining players
    room.state = "finale";
    for (const p of remaining) p.finalChoice = null;
    broadcast(room, {
      type: "finale_start",
      pot: room.pot,
      potDollars: cents2dollars(room.pot),
      finalists: remaining.map((p) => p.name),
      timer: ROUND_TIMER_MS / 1000,
      message: `[DEV] Max rounds reached. Rock Paper Scissors!`,
    });
    room.roundTimer = setTimeout(() => {
      const choices: ("rock" | "paper" | "scissors")[] = ["rock", "paper", "scissors"];
      for (const p of remaining) {
        if (p.finalChoice === null) p.finalChoice = choices[Math.floor(Math.random() * 3)]!;
      }
      resolveFinale(room);
    }, ROUND_TIMER_MS);
    return;
  }

  // More than 2 alive → wait for admin to start next round
  room.round++;
  (room as any).waitingForAdmin = true;
  broadcast(room, {
    type: "waiting_for_admin",
    round: room.round,
    message: "Waiting for admin to start next round...",
  });
}

// --- Finale: Rock Paper Scissors ---
const RPS_WINS: Record<string, string> = { rock: "scissors", scissors: "paper", paper: "rock" };

function checkAllFinaleChosen(room: Room) {
  const finalists = room.players.filter((p) => p.alive);
  if (finalists.every((p) => p.finalChoice !== null)) {
    if (room.roundTimer) {
      clearTimeout(room.roundTimer);
      room.roundTimer = null;
    }
    resolveFinale(room);
  }
}

function resolveFinale(room: Room) {
  const finalists = room.players.filter((p) => p.alive);
  const [a, b] = finalists;

  if (!a || !b) {
    endGame(room, a ?? null, a ? `${a.name} wins!` : "No winner.");
    return;
  }

  const choiceA = a.finalChoice!;
  const choiceB = b.finalChoice!;

  let winner: Player | null = null;
  let isDraw = false;
  let message: string;

  if (choiceA === choiceB) {
    isDraw = true;
    message = `Both chose ${choiceA.toUpperCase()}! It's a draw — playing again...`;
  } else if (RPS_WINS[choiceA] === choiceB) {
    winner = a;
    message = `${a.name}'s ${choiceA.toUpperCase()} beats ${b.name}'s ${choiceB.toUpperCase()}! ${a.name} wins $${cents2dollars(room.pot)}!`;
  } else {
    winner = b;
    message = `${b.name}'s ${choiceB.toUpperCase()} beats ${a.name}'s ${choiceA.toUpperCase()}! ${b.name} wins $${cents2dollars(room.pot)}!`;
  }

  broadcast(room, {
    type: "finale_result",
    choices: [
      { name: a.name, wallet: a.wallet, choice: choiceA },
      { name: b.name, wallet: b.wallet, choice: choiceB },
    ],
    pot: room.pot,
    potDollars: cents2dollars(room.pot),
    winner: winner?.name ?? null,
    winnerWallet: winner?.wallet ?? null,
    isDraw,
    message,
  });

  if (isDraw) {
    // Reset choices and play again
    for (const p of finalists) p.finalChoice = null;
    setTimeout(() => {
      broadcast(room, {
        type: "finale_start",
        pot: room.pot,
        potDollars: cents2dollars(room.pot),
        finalists: finalists.map((p) => p.name),
        timer: ROUND_TIMER_MS / 1000,
        message: `Draw! Rock Paper Scissors again! $${cents2dollars(room.pot)} on the line.`,
      });
      room.roundTimer = setTimeout(() => {
        const choices: ("rock" | "paper" | "scissors")[] = ["rock", "paper", "scissors"];
        for (const p of finalists) {
          if (p.finalChoice === null) p.finalChoice = choices[Math.floor(Math.random() * 3)]!;
        }
        resolveFinale(room);
      }, ROUND_TIMER_MS);
    }, 3000);
  } else {
    endGame(room, winner, message);
  }
}

// --- End game (split pot between multiple players) ---
function endGameSplit(room: Room, winners: Player[], message: string) {
  room.state = "finished";

  broadcast(room, {
    type: "game_over",
    winner: null,
    winnerWallet: null,
    pot: room.pot,
    potDollars: cents2dollars(room.pot),
    splitAmong: winners.map((p) => p.name),
    shareDollars: cents2dollars(Math.floor(room.pot / winners.length)),
    message,
    players: room.players.map((p) => ({ wallet: p.wallet, name: p.name })),
  });

  settleGameSplit(room, winners, room.pot).catch((err) => console.error("Settlement error:", err));
}

async function settleGameSplit(room: Room, winners: Player[], potSnapshot?: number) {
  const pot = potSnapshot ?? room.pot;
  console.log(`Settling game (split) in room ${room.id}...`);

  if (!viemClient || !settleAccount) {
    console.error("  No SETTLE_PRIVATE_KEY");
    resetRoom(room);
    return;
  }

  // Close all channels
  for (const p of room.players) {
    if (!p.channelId) continue;
    try {
      const state = await channelStore.getChannel(p.channelId);
      if (!state) continue;
      const voucherAmount = state.highestVoucherAmount;
      const voucher = state.highestVoucher;
      await viemClient.writeContract({
        address: ESCROW,
        abi: [{ name: "close", type: "function", inputs: [{ name: "channelId", type: "bytes32" }, { name: "cumulativeAmount", type: "uint128" }, { name: "signature", type: "bytes" }], outputs: [], stateMutability: "nonpayable" }],
        functionName: "close",
        args: [p.channelId, voucherAmount, voucher?.signature ?? ("0x" as Hex)],
        feeToken: CURRENCY,
      } as any);
      console.log(`  ✓ Closed ${p.name}`);
    } catch (err: any) {
      console.error(`  ✗ Failed to close ${p.name}:`, err.message.slice(0, 100));
    }
    channelWallets.delete(p.channelId);
    walletChannels.delete(p.wallet);
    await new Promise((r) => setTimeout(r, 2000));
  }

  // Pay each winner their share
  const share = Math.floor(pot / winners.length);
  const shareBaseUnits = BigInt(share) * 10000n;

  for (const w of winners) {
    await new Promise((r) => setTimeout(r, 2000));
    console.log(`  Paying ${w.name} ($${cents2dollars(share)})...`);
    try {
      const txHash = await viemClient.writeContract({
        address: CURRENCY,
        abi: [{ name: "transfer", type: "function", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }], stateMutability: "nonpayable" }],
        functionName: "transfer",
        args: [w.wallet as Address, shareBaseUnits],
        feeToken: CURRENCY,
      } as any);
      console.log(`  ✓ Paid ${w.name}: ${txHash}`);
      broadcast(room, { type: "payout", txHash, winner: w.name, winnerWallet: w.wallet, amount: cents2dollars(share) });
    } catch (err: any) {
      console.error(`  ✗ Failed to pay ${w.name}:`, err.message.slice(0, 100));
    }
  }

  // Reset room to lobby
  resetRoom(room);
}

async function resetRoom(room: Room) {
  room.state = "lobby";
  room.round = 0;
  room.pot = 0;
  for (const p of room.players) {
    p.alive = true;
    p.lives = MAX_LIVES;
    p.bid = null;
    p.finalChoice = null;
    p.sessionReady = false;
    p.channelId = null;
  }
  await broadcastState(room);
}

// --- End game + settle ---
function endGame(room: Room, winner: Player | null, message: string) {
  room.state = "finished";

  broadcast(room, {
    type: "game_over",
    winner: winner?.name ?? null,
    winnerWallet: winner?.wallet ?? null,
    pot: room.pot,
    potDollars: cents2dollars(room.pot),
    message,
    players: room.players.map((p) => ({ wallet: p.wallet, name: p.name })),
  });

  settleGame(room, winner, room.pot).catch((err) => console.error("Settlement error:", err));
}

// --- Settlement ---
// Uses the host's tempo CLI wallet (configured on this machine) for settlement.
// The server operator IS the RECIPIENT, so `tempo request` signs with their key.
async function settleGame(room: Room, winner: Player | null, pot: number) {
  console.log(`Settling game in room ${room.id}...`);

  if (!viemClient || !settleAccount) {
    console.error("  No SETTLE_PRIVATE_KEY — cannot settle. Logging channel state:");
    for (const p of room.players) {
      if (!p.channelId) continue;
      const state = await channelStore.getChannel(p.channelId);
      if (state) {
        console.log(`  ${p.name}: deposit=$${formatUnits(state.deposit, DECIMALS)}, voucher=$${formatUnits(state.highestVoucherAmount, DECIMALS)}`);
      }
    }
    resetRoom(room);
    return;
  }

  // Settle + close each player's channel
  for (const p of room.players) {
    if (!p.channelId) continue;
    try {
      const state = await channelStore.getChannel(p.channelId);
      if (!state) continue;
      const voucherAmount = state.highestVoucherAmount;
      const voucher = state.highestVoucher;
      const deposit = state.deposit;
      const returned = deposit - voucherAmount;

      console.log(`  Closing ${p.name}: claimed=$${formatUnits(voucherAmount, DECIMALS)} returned=$${formatUnits(returned < 0n ? 0n : returned, DECIMALS)}`);

      if (viemClient) {
        const tx = await viemClient.writeContract({
          address: ESCROW,
          abi: [{
            name: "close", type: "function",
            inputs: [
              { name: "channelId", type: "bytes32" },
              { name: "cumulativeAmount", type: "uint128" },
              { name: "signature", type: "bytes" },
            ],
            outputs: [],
            stateMutability: "nonpayable",
          }],
          functionName: "close",
          args: [p.channelId, voucherAmount, voucher?.signature ?? ("0x" as Hex)],
          feeToken: CURRENCY,
        } as any);
        console.log(`  ✓ Closed ${p.name}: ${tx}`);
      }
    } catch (err: any) {
      console.error(`  ✗ Failed to close ${p.name}:`, err.message);
    }

    // Clean up tracking
    channelWallets.delete(p.channelId);
    walletChannels.delete(p.wallet);

    // Rate limit: wait between on-chain txs
    await new Promise((r) => setTimeout(r, 2000));
  }

  // 2. Pay winner (transfer USDC.e from RECIPIENT wallet to winner)
  let payoutTxHash: string | null = null;
  if (winner && pot > 0) {
    await new Promise((r) => setTimeout(r, 2000));
    const potBaseUnits = BigInt(pot) * 10000n; // cents → 6-decimal base units
    console.log(`  Paying ${winner.name} ($${cents2dollars(pot)})...`);
    try {
      payoutTxHash = await viemClient.writeContract({
        address: CURRENCY,
        abi: [{
          name: "transfer",
          type: "function",
          inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }],
          outputs: [{ name: "", type: "bool" }],
          stateMutability: "nonpayable",
        }],
        functionName: "transfer",
        args: [winner.wallet as Address, potBaseUnits],
        feeToken: CURRENCY,
      } as any);
      console.log(`  ✓ Paid ${winner.name}: ${payoutTxHash}`);
    } catch (err: any) {
      console.error(`  ✗ Failed to pay ${winner.name}:`, err.message);
    }
  }

  // 3. Broadcast payout tx to players
  if (payoutTxHash) {
    broadcast(room, {
      type: "payout",
      txHash: payoutTxHash,
      winner: winner?.name,
      winnerWallet: winner?.wallet,
      amount: cents2dollars(pot),
    });
  }

  // Reset room to lobby
  resetRoom(room);
}

// --- HTTP ---
const app = new Hono();

const ALCHEMY_RPC = "https://tempo-mainnet.g.alchemy.com/v2/wvo-jvwr3Nsw1nDafH25v";

const mppx = Mppx.create({
  methods: [tempo({
    currency: CURRENCY,
    recipient: RECIPIENT,
    store,
    getClient: () => createClient({ chain: tempoChain, transport: http(ALCHEMY_RPC) }),
  })],
});

// Session open — player deposits into escrow to create payment channel
app.get(
  "/api/session/open",
  async (c, next) => {
    const deposit = c.req.query("deposit") || SUGGESTED_DEPOSIT;
    const handler = mppx.session({
      amount: "0",
      unitType: "round",
      suggestedDeposit: deposit,
    });
    return handler(c, next);
  },
  async (c) => {
    // Extract payer wallet and channelId from credential
    let wallet: string | null = null;
    let channelId: Hex | null = null;
    try {
      const credential = Credential.fromRequest(c.req.raw);
      if (credential.source) {
        wallet = extractWallet(credential.source);
      }
      // channelId is in the credential payload (session actions include it)
      const payload = credential.payload as any;
      if (payload?.channelId) {
        channelId = payload.channelId as Hex;
      }
    } catch {}

    if (wallet && channelId) {
      // If player already has a different channel, close the old one first
      const oldChannelId = walletChannels.get(wallet);
      if (oldChannelId && oldChannelId !== channelId && viemClient) {
        console.log(`  Closing old channel ${oldChannelId.slice(0, 10)}... for ${shortAddr(wallet)}`);
        try {
          const oldState = await channelStore.getChannel(oldChannelId);
          const voucherAmount = oldState?.highestVoucherAmount ?? 0n;
          const voucher = oldState?.highestVoucher;
          await viemClient.writeContract({
            address: ESCROW,
            abi: [{
              name: "close", type: "function",
              inputs: [
                { name: "channelId", type: "bytes32" },
                { name: "cumulativeAmount", type: "uint128" },
                { name: "signature", type: "bytes" },
              ],
              outputs: [],
              stateMutability: "nonpayable",
            }],
            functionName: "close",
            args: [oldChannelId, voucherAmount, voucher?.signature ?? ("0x" as Hex)],
            feeToken: CURRENCY,
          } as any);
          console.log(`  ✓ Old channel closed (settled $${formatUnits(voucherAmount, DECIMALS)})`);
          channelWallets.delete(oldChannelId);
        } catch (err: any) {
          console.error(`  ✗ Failed to close old channel:`, err.message.slice(0, 100));
        }
        await new Promise((r) => setTimeout(r, 2000));
      }

      walletChannels.set(wallet, channelId);
      channelWallets.set(channelId, wallet);
      channelHistory.push({ wallet, channelId, openedAt: new Date().toISOString() });

      // Log with deposit amount
      const newState = await channelStore.getChannel(channelId);
      const depositStr = newState ? `$${formatUnits(newState.deposit, DECIMALS)}` : "?";
      console.log(`Session opened: ${shortAddr(wallet)} → ${channelId.slice(0, 10)}... (deposit: ${depositStr})`);

      // Push state update to CLI
      for (const room of rooms.values()) {
        const player = room.players.find((p) => p.wallet === wallet);
        if (player) {
          player.channelId = channelId;
          player.sessionReady = true;
          await broadcastState(room);
          break;
        }
      }
    }

    return c.json({ success: true, channelId, wallet });
  }
);

// Session bid — player pays their chosen bid amount via voucher
app.get(
  "/api/session/bid",
  async (c, next) => {
    const bid = c.req.query("amount") || "0.01";
    const handler = mppx.session({ amount: bid, unitType: "bid" });
    return handler(c, next);
  },
  async (c) => {
    const bid = c.req.query("amount") || "0.01";

    // Push updated balance to CLI
    try {
      const credential = Credential.fromRequest(c.req.raw);
      const wallet = credential.source ? extractWallet(credential.source) : null;
      if (wallet) {
        for (const room of rooms.values()) {
          if (room.players.some((p) => p.wallet === wallet)) {
            await broadcastState(room);
            break;
          }
        }
      }
    } catch {}

    return c.json({ success: true, paid: bid });
  }
);


// Free: list rooms
app.get("/api/rooms", (c) => {
  return c.json({
    rooms: Array.from(rooms.values()).map((r) => ({
      id: r.id,
      state: r.state,
      playerCount: r.players.length,
      players: r.players.map((p) => ({ wallet: p.wallet, name: p.name, alive: p.alive, sessionReady: p.sessionReady })),
      host: r.host,
      pot: r.pot,
      potDollars: cents2dollars(r.pot),
      round: r.round,
    })),
  });
});

// All channel history (so users can claim funds later)
app.get("/api/channels", async (c) => {
  const w = c.req.query("wallet")?.toLowerCase();
  const filtered = w ? channelHistory.filter((ch) => ch.wallet === w) : channelHistory;
  const results = await Promise.all(
    filtered.map(async (ch) => {
      const state = await channelStore.getChannel(ch.channelId);
      return {
        ...ch,
        deposit: state ? formatUnits(state.deposit, DECIMALS) : null,
        spent: state ? formatUnits(state.spent, DECIMALS) : null,
        highestVoucher: state ? formatUnits(state.highestVoucherAmount, DECIMALS) : null,
        settled: state ? formatUnits(state.settledOnChain, DECIMALS) : null,
        finalized: state?.finalized ?? null,
      };
    })
  );
  return c.json({ channels: results });
});

// Admin: list active channels
app.get("/api/admin/channels", async (c) => {
  const channels: any[] = [];
  for (const [wallet, channelId] of walletChannels) {
    const state = await channelStore.getChannel(channelId);
    channels.push({
      wallet,
      channelId,
      deposit: state ? formatUnits(state.deposit, DECIMALS) : null,
      highestVoucher: state ? formatUnits(state.highestVoucherAmount, DECIMALS) : null,
      spent: state ? formatUnits(state.spent, DECIMALS) : null,
      finalized: state?.finalized ?? null,
    });
  }
  return c.json({ channels });
});

// Withdraw — server cooperatively closes the player's channel on-chain,
// returning unused deposit to the player.
app.get("/api/session/withdraw", async (c) => {
  const w = c.req.query("wallet")?.toLowerCase();
  if (!w) return c.json({ error: "wallet required" }, 400);
  const channelId = walletChannels.get(w);
  if (!channelId) return c.json({ error: "No active session" }, 404);

  // Block withdrawal if player is in an active game
  for (const room of rooms.values()) {
    const player = room.players.find((p) => p.wallet === w);
    if (player && room.state === "playing") {
      return c.json({ error: "Cannot withdraw during an active game" }, 403);
    }
  }

  if (!viemClient) {
    return c.json({ error: "Server cannot close channels (no SETTLE_PRIVATE_KEY)" }, 500);
  }

  // 1. Settle what's owed (claim vouchered amount)
  // 2. Close channel (return remaining deposit to payer)
  let txHash: string | null = null;
  let returned: string | null = null;
  try {
    const state = await channelStore.getChannel(channelId);
    const voucherAmount = state?.highestVoucherAmount ?? 0n;
    const deposit = state?.deposit ?? 0n;
    const remaining = deposit - voucherAmount;
    returned = formatUnits(remaining < 0n ? 0n : remaining, DECIMALS);

    // Close with the highest voucher — settles what's owed and returns the rest
    const voucher = state?.highestVoucher;
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

    txHash = await viemClient.writeContract({
      address: ESCROW,
      abi: closeAbi,
      functionName: "close",
      args: [
        channelId,
        voucherAmount,
        voucher?.signature ?? ("0x" as Hex),
      ],
      feeToken: CURRENCY,
    } as any);
    console.log(`Withdraw: closed ${channelId.slice(0, 10)}... claimed=$${formatUnits(voucherAmount, DECIMALS)} returned=$${returned} tx=${txHash}`);
  } catch (err: any) {
    console.error(`Withdraw failed for ${channelId.slice(0, 10)}...:`, err.message);
    return c.json({ error: "Failed to close channel on-chain" }, 500);
  }

  // Remove from tracking
  walletChannels.delete(w);
  channelWallets.delete(channelId);

  // Remove from lobby if present
  for (const room of rooms.values()) {
    if (room.state !== "lobby") continue;
    const player = room.players.find((p) => p.wallet === w);
    if (!player) continue;
    player.sessionReady = false;
    player.channelId = null;
    await broadcastState(room);
    break;
  }

  return c.json({ success: true, channelId, txHash, returned });
});

// Check if a wallet has an active session
app.get("/api/session/status", (c) => {
  const w = c.req.query("wallet")?.toLowerCase();
  if (!w) return c.json({ error: "wallet required" }, 400);
  const channelId = walletChannels.get(w);
  if (!channelId) return c.json({ ready: false });
  return c.json({ ready: true, channelId });
});

// Health
app.get("/api/health", (c) =>
  c.json({ status: "ok", service: "last-one-standing" })
);

// --- Start ---
const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log("");
  console.log("  LAST ONE STANDING");
  if (DEV_MODE) console.log("  [DEV MODE] Solo play enabled");
  console.log(`  http://localhost:${info.port}`);
  console.log("");
});

// --- WebSocket ---
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  let myWallet: string | null = null;
  let myRoom: Room | null = null;

  ws.on("message", async (raw) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }

    switch (msg.type) {
      case "create_room": {
        const wallet = msg.wallet?.trim()?.toLowerCase();
        if (!wallet) {
          ws.send(JSON.stringify({ type: "error", message: "Wallet address required" }));
          return;
        }
        const name = msg.player?.trim() || shortAddr(wallet);

        // If a lobby room already exists, auto-join it
        const existingLobby = Array.from(rooms.values()).find((r) => r.state === "lobby");
        if (existingLobby) {
          const existing = existingLobby.players.find((p) => p.wallet === wallet);
          if (existing) {
            existing.ws = ws;
            existing.name = name;
            existing.alive = true;
            existing.lives = MAX_LIVES;
            existing.bid = null;
            existing.finalChoice = null;
          } else {
            existingLobby.players.push({
              wallet, name, ws, alive: true, lives: MAX_LIVES, bid: null, finalChoice: null,
              channelId: walletChannels.get(wallet) ?? null,
              sessionReady: false,
            });
          }
          myWallet = wallet;
          myRoom = existingLobby;
          ws.send(JSON.stringify({ type: "room_created", roomId: existingLobby.id }));
          await broadcastState(existingLobby);
          break;
        }

        const id = genRoomId();
        const room: Room = {
          id,
          players: [{
            wallet, name, ws, alive: true, lives: MAX_LIVES, bid: null, finalChoice: null,
            channelId: walletChannels.get(wallet) ?? null,
            sessionReady: false,
          }],
          state: "lobby",
          round: 0,
          pot: 0,
          host: wallet,
          roundTimer: null,
        };
        rooms.set(id, room);
        myWallet = wallet;
        myRoom = room;

        ws.send(JSON.stringify({ type: "room_created", roomId: id }));
        await broadcastState(room);
        break;
      }

      case "join_room": {
        const wallet = msg.wallet?.trim()?.toLowerCase();
        const id = msg.roomId?.trim()?.toUpperCase();
        if (!wallet || !id) {
          ws.send(JSON.stringify({ type: "error", message: "Wallet address and room ID required" }));
          return;
        }
        const name = msg.player?.trim() || shortAddr(wallet);
        const room = rooms.get(id);
        if (!room) {
          ws.send(JSON.stringify({ type: "error", message: "Room not found" }));
          return;
        }
        if (room.state !== "lobby") {
          ws.send(JSON.stringify({ type: "error", message: "Game already in progress" }));
          return;
        }
        const existing = room.players.find((p) => p.wallet === wallet);
        if (existing) {
          existing.ws = ws;
          existing.name = name;
        } else {
          room.players.push({
            wallet, name, ws, alive: true, lives: MAX_LIVES, bid: null, finalChoice: null,
            channelId: walletChannels.get(wallet) ?? null,
            sessionReady: false,
          });
        }
        myWallet = wallet;
        myRoom = room;
        await broadcastState(room);
        break;
      }

      case "session_ready": {
        if (!myRoom || !myWallet) return;
        const player = myRoom.players.find((p) => p.wallet === myWallet);
        if (!player) return;
        const channelId = msg.channelId as Hex | undefined;
        if (channelId) {
          player.channelId = channelId;
          walletChannels.set(myWallet, channelId);
          channelWallets.set(channelId, myWallet);
        }
        player.sessionReady = true;
        await broadcastState(myRoom);
        break;
      }

      case "start_game": {
        if (!myRoom || !myWallet) return;
        if (myWallet !== ADMIN_WALLET) {
          ws.send(JSON.stringify({ type: "error", message: "Only the admin can start the game" }));
          return;
        }
        if (!settleAccount) {
          ws.send(JSON.stringify({ type: "error", message: "Server missing SETTLE_PRIVATE_KEY — cannot run games" }));
          return;
        }
        if (myRoom.players.length < MIN_PLAYERS) {
          ws.send(JSON.stringify({ type: "error", message: `Need at least ${MIN_PLAYERS} players` }));
          return;
        }
        const unready = myRoom.players.filter((p) => !p.sessionReady);
        if (unready.length > 0) {
          ws.send(JSON.stringify({
            type: "error",
            message: `${unready.length} player(s) haven't opened sessions yet`,
          }));
          return;
        }
        myRoom.state = "playing";
        myRoom.round = 1;
        myRoom.pot = 0;
        for (const p of myRoom.players) {
          p.alive = true;
          p.lives = MAX_LIVES;
          p.bid = null;
          p.finalChoice = null;
        }
        startRound(myRoom);
        break;
      }

      case "next_round": {
        if (!myRoom || !myWallet) return;
        if (myWallet !== ADMIN_WALLET) {
          ws.send(JSON.stringify({ type: "error", message: "Only the admin can advance rounds" }));
          return;
        }
        if (myRoom.state !== "playing" || !(myRoom as any).waitingForAdmin) return;
        (myRoom as any).waitingForAdmin = false;
        startRound(myRoom);
        break;
      }

      case "finale_choice": {
        if (!myRoom || !myWallet || myRoom.state !== "finale") return;
        const me = myRoom.players.find((p) => p.wallet === myWallet);
        if (!me || !me.alive || me.finalChoice !== null) return;
        const choice = msg.choice;
        if (choice !== "rock" && choice !== "paper" && choice !== "scissors") {
          ws.send(JSON.stringify({ type: "error", message: "Choose 'rock', 'paper', or 'scissors'" }));
          return;
        }
        me.finalChoice = choice;
        await broadcastState(myRoom);
        checkAllFinaleChosen(myRoom);
        break;
      }

      case "bid_intent": {
        // Pre-validate bid BEFORE payment. Client pays only after approval.
        if (!myRoom || !myWallet || myRoom.state !== "playing" || (myRoom as any).waitingForAdmin) return;
        const me = myRoom.players.find((p) => p.wallet === myWallet);
        if (!me || !me.alive || me.bid !== null) {
          ws.send(JSON.stringify({ type: "bid_rejected", reason: "Cannot bid right now" }));
          return;
        }

        const bidCents = Number(msg.bidCents ?? 0);

        if (bidCents < 0) {
          ws.send(JSON.stringify({ type: "bid_rejected", reason: "Bid cannot be negative" }));
          return;
        }

        const balance = await getChannelBalance(me.channelId);
        if (balance !== null) {
          const balanceCents = Math.round(parseFloat(balance) * 100);
          if (bidCents > balanceCents) {
            ws.send(JSON.stringify({
              type: "bid_rejected",
              reason: `You're betting $${cents2dollars(bidCents)} but only have $${balance} in your session! Deposit more first.`,
            }));
            return;
          }
        }

        console.log(`  Bid approved: ${me.name} $${cents2dollars(bidCents)} (round ${myRoom.round})`);
        ws.send(JSON.stringify({ type: "bid_approved", bidCents }));
        break;
      }

      case "bid_confirmed": {
        if (!myRoom || !myWallet || myRoom.state !== "playing" || (myRoom as any).waitingForAdmin) return;
        const me = myRoom.players.find((p) => p.wallet === myWallet);
        if (!me || !me.alive || me.bid !== null) return;

        const bidCents = Number(msg.bidCents ?? 0);
        console.log(`  Bid confirmed: ${me.name} $${cents2dollars(bidCents)}`);
        me.bid = bidCents;
        await broadcastState(myRoom);
        checkAllBid(myRoom);
        break;
      }

      case "fold": {
        // Legacy: treat fold as a $0 bid
        if (!myRoom || !myWallet || myRoom.state !== "playing" || (myRoom as any).waitingForAdmin) return;
        const me = myRoom.players.find((p) => p.wallet === myWallet);
        if (!me || !me.alive || me.bid !== null) return;
        me.bid = 0;
        await broadcastState(myRoom);
        checkAllBid(myRoom);
        break;
      }
    }
  });

  ws.on("close", async () => {
    if (!myRoom || !myWallet) return;
    const me = myRoom.players.find((p) => p.wallet === myWallet);
    if (!me) return;

    if ((myRoom.state === "playing" || myRoom.state === "finale") && me.alive) {
      if (myRoom.state === "finale") {
        const choices: ("rock" | "paper" | "scissors")[] = ["rock", "paper", "scissors"];
        me.finalChoice = me.finalChoice ?? choices[Math.floor(Math.random() * 3)]!; // random on disconnect
        await broadcastState(myRoom);
        checkAllFinaleChosen(myRoom);
      } else {
        me.bid = 0;
        me.lives = 0;
        me.alive = false;
        await broadcastState(myRoom);
        checkAllBid(myRoom);
      }
    } else if (myRoom.state === "lobby") {
      myRoom.players = myRoom.players.filter((p) => p.wallet !== myWallet);
      if (myRoom.players.length === 0) {
        rooms.delete(myRoom.id);
      } else {
        if (myRoom.host === myWallet) myRoom.host = myRoom.players[0]!.wallet;
        await broadcastState(myRoom);
      }
    }
  });
});
