# Security Model & Known Cheating Vectors

## How Payments Work

```
Player Wallet ──deposit──▶ Escrow Contract ──settle──▶ Server Wallet (RECIPIENT)
                               │
                               ├── vouchers are off-chain signatures
                               │   (player signs "server can claim up to $X")
                               │
                               └── unused funds stay in escrow
                                   (player can reclaim anytime)
```

1. **Session open**: Player deposits USDC into an on-chain escrow contract. Funds leave their wallet → escrow. NOT to the server.
2. **Each round**: Player signs an off-chain voucher authorizing the server to claim a cumulative amount. No on-chain tx.
3. **Settlement**: Server submits the highest voucher to the escrow contract to claim what's owed.
4. **Withdrawal**: Player can call `requestClose` on the escrow contract to start reclaiming unused funds.

## Known Cheating Vectors

### 1. Race-to-close attack (HIGH risk)

**The attack**: A player can call `requestClose(channelId)` directly on the escrow contract at any time — even mid-game. This starts a grace period. If the server doesn't settle (submit the highest voucher) before the grace period ends, the player calls `withdraw()` and gets their FULL deposit back, including funds they already "spent" via vouchers.

**Impact**: Player plays multiple rounds, accumulates losses, then closes the channel before the server settles. They get all their money back despite having lost.

**Mitigation** (not yet implemented):
- Server should monitor the escrow contract for `CloseRequested` events
- On detection, immediately call `settle(channelId, cumulativeAmount, signature)` with the highest voucher
- This claims what's owed before the player can withdraw
- The grace period (`CLOSE_GRACE_PERIOD` on the contract) is the window the server has to react

```
Escrow contract: 0x33b901018174DDabE4841042ab76ba85D4e24f25 (Tempo mainnet)
```

### 2. Disconnect-and-reopen (MEDIUM risk)

**The attack**: Player disconnects mid-game (Ctrl+C), then reconnects with a new session/channel. Their old channel vouchers are orphaned — the server may not settle them.

**Impact**: Player avoids paying for rounds they already played.

**Mitigation**:
- Server tracks channelIds per wallet
- On disconnect during a game, the server should immediately settle the player's channel
- Currently the server logs channel state but doesn't auto-settle (requires `SETTLE_PRIVATE_KEY` or viem client)

### 3. Same wallet, different name (LOW risk)

**The attack**: Not really an attack — player reconnects with same wallet but different display name. Balance follows wallet, not name.

**Impact**: None. Wallet address is the identity, name is cosmetic.

### 4. Voucher replay (NO risk)

**The attack**: Try to reuse an old voucher.

**Impact**: None. Vouchers are cumulative and monotonically increasing. The escrow contract rejects any voucher with `cumulativeAmount <= settled`. The mppx session server also rejects vouchers that don't increase.

## What the Server CAN'T Do

- **Server cannot steal deposits**: Funds sit in the escrow contract, not the server's wallet. Server can only claim up to the highest voucher amount signed by the player.
- **Server cannot forge vouchers**: Vouchers are EIP-712 signed by the player's key. Server cannot create valid vouchers.
- **Server cannot prevent withdrawal**: The escrow contract's `requestClose` is callable by the payer at any time. Server can only settle during the grace period.

## What the Player CAN'T Do

- **Player cannot avoid paying for rounds after signing**: Once a voucher is signed and the server has it, the server can settle on-chain at any time to claim that amount. The only defense is the race-to-close attack above.
- **Player cannot double-spend**: Cumulative voucher model prevents this. Each voucher authorizes "up to $X total", not "$X more".

## Production Recommendations

1. **Monitor escrow events**: Watch for `CloseRequested` and auto-settle immediately
2. **Settle frequently**: Don't wait for game-over. Settle after each round or every N rounds to minimize exposure
3. **Require minimum deposit**: Ensure deposit covers at least a few rounds so the player has skin in the game
4. **Timeout stale channels**: If a player's channel is idle for too long, settle and remove
5. **Use a proper viem wallet client**: Instead of manual settlement, integrate `tempo.settle()` with the server's private key for automated on-chain settlement
