# Last One Standing

An escalating-stakes multiplayer CLI game with real USDC micropayments on [Tempo](https://tempo.xyz). Players bid each round — the lowest bidder loses a life. Last player standing wins the entire pot. Final two settle it with Rock Paper Scissors.

## How it works

1. Players connect to a shared game server and deposit USDC into a payment channel
2. Each round, alive players submit a bid (any amount, including $0)
3. All bids go into the pot. The lowest bidder loses a life (ties = all lowest lose a life)
4. When 2 players remain, they play Rock Paper Scissors for the pot
5. The winner receives the full pot via on-chain transfer

Payment channels (via [mppx](https://www.npmjs.com/package/mppx)) enable instant off-chain bids — only the deposit and final payout hit the chain.

## Prerequisites

- **Node.js** 18+
- **Tempo CLI** — install and log in:
  ```
  npm i -g @aspect-build/tempo
  tempo wallet login
  ```
- Your Tempo wallet needs **USDC.e** on Tempo mainnet for deposits

## Setup

### Running the server

```bash
git clone <repo-url> && cd last-one-standing
npm install
cp .env.example .env
```

Fill in `.env`:

| Variable | Required | Description |
|---|---|---|
| `MPP_SECRET_KEY` | Yes | HMAC secret for payment challenges. Generate with `openssl rand -hex 32` |
| `SETTLE_PRIVATE_KEY` | Yes | Private key of the server wallet that closes channels and pays winners. Must hold USDC.e on Tempo. |
| `PORT` | No | HTTP/WS port (default: `3000`) |
| `MAX_LIVES` | No | Lives per player (default: `3`) |

Start the server:

```bash
# Production
npm run game

# Development (solo play enabled, max 3 rounds)
npm run dev
```

Expose it publicly (e.g. with ngrok) so players can connect:

```bash
ngrok http 3000
```

### Playing the game

Players don't need the `.env` — they just need the Tempo CLI and the server URL.

```bash
npm install
npm run play
```

By default the client connects to the hosted server. To point at your own:

```bash
npx tsx src/play.ts --server https://your-server.ngrok.app YourName
```

Options:
- `--server <url>` / `-s <url>` — game server URL
- `--deposit <amount>` / `-d <amount>` — suggested deposit in USD (default: `0.50`)
- Last positional arg is your display name

### Depositing into a session

Once in the lobby, open a payment channel by running this in a **separate terminal**:

```bash
tempo request "https://your-server.ngrok.app/api/session/open"
```

The game client will auto-detect your deposit. The default suggested deposit is $1.00.

## Gameplay controls

| Key | Action |
|---|---|
| `0-9` / `.` | Type bid amount |
| `Enter` | Confirm bid / Start game (host) / Advance round (host) |
| `1` / `2` / `3` | Rock / Paper / Scissors (finale) |
| `W` | Withdraw deposit and close channel (lobby only) |
| `Ctrl+C` | Quit |

## Scripts

| Command | Description |
|---|---|
| `npm run game` | Start the game server |
| `npm run dev` | Start in dev mode (solo play, 3-round cap) |
| `npm run play` | Connect as a player |
| `npm run withdraw-all` | Close all open escrow channels and return funds |
| `npm run reset` | Clear local wallet channel state |
| `npm run close-channel` | Close all tempo wallet sessions |

## API Endpoints

| Endpoint | Auth | Description |
|---|---|---|
| `GET /api/health` | Free | Health check |
| `GET /api/rooms` | Free | List active rooms |
| `GET /api/session/open` | Tempo payment channel | Open a session (deposit into escrow) |
| `GET /api/session/bid?amount=X` | Tempo voucher | Pay a bid via payment channel |
| `GET /api/session/status?wallet=X` | Free | Check if wallet has an active session |
| `GET /api/session/withdraw?wallet=X` | Free | Cooperatively close channel, return funds |
| `GET /api/channels?wallet=X` | Free | Channel history for a wallet |

## Architecture

- **Server** (`src/game.ts`) — Hono HTTP server + WebSocket for real-time game state. Manages rooms, rounds, bidding, RPS finale, and on-chain settlement via viem.
- **Client** (`src/play.ts`) — Terminal UI that connects over WebSocket. Uses `tempo request` CLI for payment channel operations.
- **Settlement** — Server closes all payment channels at game end, then transfers the pot to the winner from the settlement wallet.
