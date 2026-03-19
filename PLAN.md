# Plan: Refactor Last One Standing to Use `tempo.session()` Streaming Payments

## Context
The game currently uses `tempo.charge()` for one-shot deposits into an internal balance ledger (`data/balances.json`). This means money leaves the player's wallet immediately on deposit and the server tracks credits internally. We're switching to `tempo.session()` — payment channels where players lock funds in escrow, the server pulls per-round via signed vouchers, and only claims what was actually used.

User requirements:
- "Deposit" = opening a session (payment channel with escrow deposit)
- Each round = streaming payment (incremental voucher)
- Game over = server auto-settles channels and sends pot to winner
- 10-second round timer; no response = eliminated
- Players can top-up (fund more) during the game
- CLI accepts deposit amount as a flag

## Files to Modify
- `src/game.ts` — Major refactor: session endpoints, channel tracking, settle logic, remove internal balances
- `src/play.ts` — `tempo request` subprocess for session open/stay/top-up, deposit amount flag
- `.env` — Add `SETTLE_PRIVATE_KEY`

## Architecture

```
Player CLI                    Server                        Blockchain
   |                             |                              |
   |-- WS: create_room -------->|                              |
   |<-- WS: room_state ---------|                              |
   |                             |                              |
   |-- tempo request /api/session/open (escrow deposit) ------>|
   |<-- 200 + receipt (channelId) |                            |
   |-- WS: session_ready ------>|                              |
   |                             |                              |
   |<-- WS: round_start -------|                              |
   |                             |                              |
   |-- tempo request /api/session/stay?round=1 (voucher) ---->|
   |<-- 200 -------------------|                              |
   |-- WS: stay_confirmed ---->|                              |
   |                             |                              |
   |  ... more rounds ...        |                              |
   |                             |                              |
   |<-- WS: game_over ---------|                              |
   |                            |-- settle all channels ------>|
   |                            |-- transfer USDC to winner -->|
```

Key: per-round vouchers are off-chain signatures (fast, no tx). Only open/settle/transfer are on-chain.

## Server Changes (`src/game.ts`)

### 1. Setup
- `Store.memory()` + `ChannelStore.fromStore(store)` for channel state
- `Mppx.create({ methods: [tempo({ currency, recipient, store })] })` — gives both `mppx.charge()` and `mppx.session()`
- Viem wallet client with `SETTLE_PRIVATE_KEY` for settle + winner payout
- Change `ROUND_TIMER_MS` to `10_000`

### 2. Remove
- Entire internal balance system (`balances`, `loadBalances`, `saveBalances`, `getBalance`, `addBalance`, `deductBalance`)
- Deposit codes (`depositCodes`, `genCode`, `createDepositCode`)
- `GET /api/deposit/:code`, `GET /api/balance`, `GET /api/admin/grant`, `GET /api/admin/balances`
- `data/balances.json` concept

### 3. Add channel tracking
```ts
const walletChannels = new Map<string, Hex>();   // wallet → channelId
const channelWallets = new Map<Hex, string>();   // channelId → wallet
```

### 4. Update Player interface
```ts
interface Player {
  wallet: string;
  name: string;
  ws: WebSocket;
  alive: boolean;
  choice: "stay" | "fold" | null;
  channelId: Hex | null;
  sessionReady: boolean;
}
```

### 5. New endpoints

**`GET /api/session/open`** — gated by `mppx.session()`
- Opens payment channel (first call triggers escrow deposit on-chain)
- Extracts channelId from receipt, payer wallet from credential
- Tracks wallet↔channelId mapping
- `suggestedDeposit` param tells client how much to escrow (e.g. "0.50")

**`GET /api/session/stay?round=N`** — gated by `mppx.session()` with dynamic amount
- Charges `roundCostDollars(round)` against the channel via voucher
- Wrapper middleware reads `round` query param to set the amount dynamically

**`GET /api/session/topup`** — gated by `mppx.session()` (top-up action)
- Allows adding more funds to an existing channel during the game

### 6. WebSocket changes
- New message type: `"session_ready"` — client sends after `tempo request /api/session/open` succeeds, with channelId
- `"stay"` becomes `"stay_confirmed"` — sent after `tempo request /api/session/stay` succeeds
- `"fold"` unchanged
- `"start_game"` checks all players have `sessionReady === true` (skip in DEV_MODE)

### 7. `resolveRound` changes
- No more `deductBalance` calls — payment already captured via voucher
- `room.pot` tracks total in display units (cents) for simplicity
- Stayers are those who sent `stay_confirmed` before timer

### 8. Game over: `settleGame(room, winner)`
1. `tempo.settle(channelStore, viemClient, channelId)` for each player — claims vouchered amount to RECIPIENT
2. If winner: ERC20 transfer from RECIPIENT to `winner.wallet` for pot amount
3. If draw (all fold same round): settle channels, split pot via multiple transfers
4. Clean up channel tracking maps

### 9. `roomState` broadcast
- Remove balance/depositCode fields
- Add `sessionReady` per player
- Pot displayed in dollars

## Client Changes (`src/play.ts`)

### 1. New CLI flags
- `--deposit <amount>` or `-d <amount>` — deposit amount in dollars (default "0.50")
- Name is optional (defaults to truncated wallet address)

### 2. `tempoRequest()` helper
- Async wrapper around `exec("tempo request ...")` subprocess
- Returns `{ success, output }`
- 30s timeout

### 3. Auto-open session on lobby join
- After receiving first `room_state` in lobby, auto-run `tempo request /api/session/open`
- On success, send `{ type: "session_ready", channelId }` via WebSocket
- Show status: "Opening payment session..." → "Session active (Channel: 0xabc...)"

### 4. Stay action
- Player presses S → "Processing payment..."
- Run `tempo request /api/session/stay?round=N` (async)
- Success → send `{ type: "stay_confirmed" }` via WS
- Failure → send `{ type: "fold" }` via WS, show error

### 5. Top-up command
- Player can press T during lobby or game to top-up channel
- Runs `tempo request /api/session/topup`

### 6. Updated rendering
- Lobby: show session status instead of balance/deposit code
- Round: show payment status instead of balance
- Game over: show winner + pot, note settlement happening on-chain

## Environment
- `.env` needs: `SETTLE_PRIVATE_KEY=0x...` (RECIPIENT's private key for settle + payouts)
- `RPC_URL` defaults to `https://rpc.tempo.xyz` (Tempo mainnet)

## DEV_MODE
- Skip session requirement (allow start without `sessionReady`)
- Skip payment for stay (auto-confirm)
- Skip settle on game over
- Still tracks pot for display

## Verification
1. `npm run dev` starts server with `--dev` flag
2. `npm run play -- Karan` connects, auto-opens session
3. Second terminal: `npm run play -- Bot` joins
4. Host presses Enter to start
5. Each round: S to stay (triggers `tempo request`), F to fold
6. Game over: server settles channels, sends pot to winner
7. Check `tempo wallet whoami` balances before/after
