# 🐋 Polymarket Whale Copy Trader

**Auto-trades Polymarket prediction markets by copy-trading top wallets from the leaderboard — with a real-time on-chain edge.**

All trades on Polymarket are on-chain (Polygon) — fully transparent. This bot discovers profitable wallets, monitors their positions in real-time via Polygon WebSocket, and auto-executes copy trades via the CLOB API with full risk management.

## The Edge

We don't gamble. Every trade must have an edge. Our edge comes from three real-time systems:

### 1. On-Chain Entry Detection (2-4 seconds)
Traditional polling detects whale entries in ~45 seconds — by then, the price has already moved 10-26% and the edge is gone. We subscribe to `OrderFilled` events on Polymarket's CTF Exchange contracts via Alchemy WebSocket. When a tracked whale's trade settles on-chain, we detect it in 2-4 seconds and execute our copy trade immediately.

- **Contracts monitored:** CTF Exchange V2 (`0xE111...`) + Neg-Risk CTF Exchange V2 (`0xe222...`)
- **Event:** `OrderFilled(bytes32 orderHash, address maker, address taker, uint8 side, uint256 tokenId, ...)`
- **Dedup:** 60-second cooldown per whale+token pair prevents duplicate signals. `knownPositions` Set prevents double-counting between on-chain WS and 45s polling.
- **Fallback:** 45s API polling continues in parallel. If WS disconnects, polling takes over automatically.

### 2. WebSocket Exit Monitoring (< 1 second)
When a position hits TP/SL/trailing thresholds, we exit instantly via WebSocket price feeds — not 30-second polling. The WS exit monitor subscribes to live orderbook updates for every open position token.

- **Debounce:** Max 1 exit per token per 5 seconds (prevents double-exit on rapid price flickers)
- **Stale price protection:** Ignores messages > 5 seconds old
- **Empty book protection:** Skips exit if no bids exist
- **Fallback:** 30s API polling in `manageExits()` continues as backup

### 3. Real-Time Order Management (User WebSocket)
Authenticated `/ws/user` WebSocket gives real-time order fill confirmations — no 15-second reconciliation delay. We know instantly when an order fills, partially fills, or cancels.

## Strategy

### Entry
- **Signal sources:** Elite Sharp (A+ tier whale, standalone), Consensus (2+ whales aligned), Whale Entry (single whale)
- **Copy ratio:** 10% of whale's position size, capped at $10 max per trade
- **A+ standalone cap:** $4 max per trade
- **Entry quality gates:**
  - Spread ≤ 6%
  - Slippage ≤ 4% above whale's entry price
  - Sufficient orderbook depth for our size
  - Max entry price ≤ $0.92
  - Market liquidity ≥ $5,000
  - Market resolves within 24 hours (no dead markets)
  - Whale must bet ≥ 1% of their portfolio
  - Crypto candle bot detection (filters latency-edge bots)

### Exit — Scale-Out Strategy
| Trigger | Action | Size |
|---------|--------|------|
| **TP1** — price reaches +15% from entry | Sell half | 50% of position |
| **TP2** — price reaches +30% from entry | Sell remaining | 50% of position |
| **Stop loss** — price drops -20% from entry | Sell all | 100% of remaining |
| **Trailing stop** — price drops 12% from peak | Sell all | 100% of remaining |
| **Whale exit** — whale we copied sells | Sell all | 100% of remaining |
| **Portfolio TP** — total portfolio up 30% | Sell everything | All positions |

The scale-out at TP1 locks in profits on half the position while letting the rest ride to TP2 for the bigger move. The trailing stop protects gains if the price peaks and reverses before TP2.

### Risk Management
- **Max position size:** $10 (10% of $99 bankroll)
- **Max daily trades:** 100
- **Max concurrent positions:** 16
- **Max per category:** 6
- **Max portfolio drawdown:** 25% → pause trading
- **Min balance:** $10 → stop
- **Daily loss limit:** $30 → stop for the day
- **Order fill timeout:** 30 minutes → cancel
- **Exit order timeout:** 10 minutes → reprice at current best bid (max 3 retries)

### Operation Protect the Day

**Daily Take-Profit:** When realized PnL reaches **+$30** (30% of $99 bankroll), the bot:
1. Pauses all trading immediately
2. Sends a Telegram alert with the day's PnL and stats
3. Resumes automatically at midnight UTC with a fresh daily slate

**Daily Loss Limit:** When realized PnL drops to **-$30** (30% of $99 bankroll), the bot:
1. Pauses all trading immediately
2. Sends a Telegram alert with the day's PnL and stats
3. Resumes automatically at midnight UTC

**New Day Reset:** At midnight UTC, the bot:
1. Resets daily stats (trades, wins, losses, PnL)
2. Resets `portfolioPeak` to current equity (prevents stale peaks from blocking trades)
3. Unpauses trading
4. Sends a Telegram alert confirming the reset with previous day's PnL

**Why 30%?**
- At 30% daily gain, the win rate edge has already been captured
- Continuing to trade increases exposure to variance — 2-3 bad trades can erase gains
- 30% compounded daily doubles the bankroll in ~3 days, which is already aggressive
- Without a daily cap, a winning day can become a losing day in 2-3 bad trades

## Quick Start (5 minutes)

```bash
# 1. Clone
git clone https://github.com/patrickabedin/polymarket-glm.git
cd polymarket-glm

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
# Edit .env — fill in POLY_PRIVATE_KEY, POLY_FUNDER_ADDRESS, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, ALCHEMY_API_KEY

# 4. Syntax check
npm test

# 5. Start with PM2
pm2 start index.mjs --name polymarket-copier
pm2 save

# 6. Verify it's running
pm2 logs polymarket-copier --lines 50
```

You should see the startup banner, whale discovery (151 wallets analyzed, ~50 tracked), WebSocket connections, and "Signal Monitor starting".

## What You Need

| Item | How to Get It |
|------|---------------|
| **Polymarket wallet** | Create a wallet on polymarket.com (browser wallet → Polymarket UI creates an EIP-1167 minimal proxy). Export the private key from your wallet settings. |
| **Wallet address** | Your Polymarket proxy wallet address (starts with `0x...`). This is the `POLY_FUNDER_ADDRESS`. |
| **Private key** | The EOA signer private key (`0x...` 64 hex chars). This is the `POLY_PRIVATE_KEY`. |
| **signatureType** | Already set to `3` (POLY_1271) in config.mjs. This is correct for Polymarket-upgraded wallets. **Do not change it.** |
| **Telegram bot** | Message @BotFather → /newbot → get token. Message @userinfobot to get your chat ID. |
| **Alchemy API key** | Create a free account at alchemy.com → create a Polygon mainnet app → copy the API key. Used for on-chain WebSocket monitoring. |

### Wallet Setup Notes

- Polymarket upgrades your wallet to an EIP-1167 minimal proxy. The `POLY_FUNDER_ADDRESS` is the **proxy** address (not your EOA).
- The `POLY_PRIVATE_KEY` is the **EOA signer** key, not the proxy.
- To find both: go to polymarket.com → Settings → look for your wallet address (proxy). The signer EOA is the address that signed the original wallet creation.
- **Test with $5-10 first.** The bot's default config caps trades at $10 each, $30 daily loss, $10 min balance.

## Architecture — 5 Layers + 3 Real-Time Systems

```
┌──────────────────────────────────────────────────────────────────┐
│                    index.mjs (orchestrator)                       │
├──────────┬──────────┬──────────┬──────────┬──────────────────────┤
│ Layer 1  │ Layer 2  │ Layer 3  │ Layer 4  │      Layer 5         │
│ Discover │ Monitor  │ Execute  │  Risk    │     Telegram         │
│          │          │          │          │                      │
│ whale-   │ signal-  │ clob-    │ risk-    │ telegram-bot         │
│ discov.  │ monitor  │ exec.    │ manager  │ .mjs                 │
│ + v2     │ .mjs     │ .mjs     │ .mjs     │                      │
│ sources  │          │          │          │                      │
└──────────┴──────────┴──────────┴──────────┴──────────────────────┘
     │           │          │           │
     │     ┌─────┴──────┐   │     ┌─────┴──────┐
     │     │ ON-CHAIN   │   │     │ WS EXIT    │
     │     │ MONITOR    │   │     │ MONITOR    │
     │     │ (Polygon   │   │     │ (price     │
     │     │  WS)       │   │     │  feeds)    │
     │     │ 2-4s entry │   │     │ <1s exit   │
     │     └────────────┘   │     └────────────┘
     │                      │
     │                ┌─────┴──────┐
     │                │ USER WS    │
     │                │ (order     │
     │                │  fills)    │
     │                └────────────┘
```

### Layer 1: Whale Discovery (`whale-discovery.mjs` + `whale-sources-v2.mjs` + `whale-scoring-v2.mjs`)
- Fetches Polymarket leaderboards (OVERALL, POLITICS, CRYPTO, SPORTS)
- Filters: ≥75% win rate, ≥10 resolved positions, ≤0.60 avg entry price, ≥$1,000 total stake
- Classifies into tiers: A+ (elite sharp, auto-trade standalone), A, B, C
- Multi-source discovery adds wallets found via holders, on-chain, and social signals
- Scores on: timing accuracy, sizing consistency, category specialization, win rate, PnL magnitude
- Re-ranks every 60 minutes
- Output: `data/whales.json` (top 50 tracked wallets)

### Layer 2: Signal Monitoring (`signal-monitor.mjs` + `onchain-monitor.mjs`)
- **On-chain WebSocket** (primary) — subscribes to `OrderFilled` events on Polymarket's CTF Exchange contracts via Alchemy. Detects whale entries in 2-4 seconds.
- **Polymarket WebSocket** — subscribes to market price feeds for open positions (used by WS exit monitor)
- **Always-on polling** (every 45s) — backup detection in case WS disconnects
- Three signal types:
  - **WHALE_ENTRY** — single whale enters a market
  - **CONSENSUS** — 2+ whales enter same market within 30min window (weighted score ≥3.0)
  - **ELITE_SHARP** — A+ tier whale acts alone (auto-trade standalone enabled)
- Filters: min position $500, min whale stake 1%, filter markets near resolution, filter crypto candle bots, min liquidity $5k

### Layer 3: CLOB Execution (`clob-executor.mjs` + `ws-exit-monitor.mjs`)
- Uses `@polymarket/clob-client-v2` SDK for authenticated order placement
- Limit orders (GTC) at best ask price for instant fills
- Position sizing: `copyRatio (10%) × whaleValue`, capped at `$10` max
- A+ standalone trades capped at `$4`
- Entry quality checks: spread ≤6%, slippage ≤4%, depth sufficient, max entry ≤0.92
- **Exit management (scale-out):**
  - TP1 at +15% → sell 50% (scale out half)
  - TP2 at +30% → sell remaining 50%
  - Stop loss at -20% → sell all
  - Trailing stop at 12% from peak → sell all
  - Whale exit → sell all (follow the whale out)
- **WS exit monitor:** real-time price feed triggers exits in <1s (30s API poll backup)
- Order reconciliation loop (every 15s) checks fill status
- User WebSocket (`/ws/user`) for real-time order fill/cancel confirmations
- Resolved market cleanup every 5 minutes (prevents 404 errors on dead markets)

### Layer 4: Risk Management (`risk-manager.mjs`)
- Max $10 per trade
- Max 100 daily trades
- Max 16 concurrent positions
- Max 6 per category
- 25% max portfolio drawdown → pause
- $10 min balance → stop
- **$30 daily loss limit → stop for the day (Operation Protect the Day)**
- **$30 daily take-profit → stop for the day (Operation Protect the Day)**
- 30min cooldown after losses
- Portfolio take-profit at +30% → sell everything
- Auto-reset at midnight UTC with Telegram notification
- State: `data/risk_state.json`

### Layer 5: Telegram Alerts (`telegram-bot.mjs`)
**Only actionable alerts are sent. No spam.**
- 🎯 **COPY TRADE EXECUTED** — when a trade is placed
- ✅ **ORDER FILLED** — when an entry order fills
- 💸 **EXIT ORDER SUBMITTED** — when an exit order is placed
- 🏆/💀 **POSITION CLOSED** — when an exit fills, with win/loss verdict + PnL
- ⏰ **ORDER CANCELLED** — when an order times out unfilled
- 💰 **PORTFOLIO TAKE PROFIT** — when portfolio hits +30% and sells everything
- Daily summary at 8:00 UTC

## File Reference

| File | Purpose |
|------|---------|
| `index.mjs` | Main entry point — orchestrates all layers |
| `config.mjs` | All configuration (discovery, monitoring, execution, risk, Telegram) |
| `whale-discovery.mjs` | Leaderboard fetching, wallet analysis, tier classification |
| `whale-sources-v2.mjs` | Multi-source discovery (holders, onchain, social) |
| `whale-scoring-v2.mjs` | 10-dimension wallet scoring |
| `signal-monitor.mjs` | WebSocket + polling monitor, signal detection, alert formatting |
| `onchain-monitor.mjs` | **On-chain whale entry detection via Polygon WS (2-4s latency)** |
| `ws-exit-monitor.mjs` | **Real-time WS exit monitoring (<1s latency)** |
| `clob-executor.mjs` | CLOB order placement, exit management, reconciliation |
| `risk-manager.mjs` | Position sizing, circuit breakers, portfolio tracking |
| `telegram-bot.mjs` | Telegram message sending (Markdown + HTML) |
| `polymarket-api.mjs` | Gamma + Data + CLOB API client wrappers |
| `pnl-logger.mjs` | Trade-level + daily JSONL PnL logging |
| `pattern_logger.mjs` | Entry/exit pattern logging for optimization |
| `moralis-pusd-tracker.mjs` | Optional pUSD flow tracking (requires Moralis) |
| `moralis-wallet-profiler.mjs` | Optional wallet classification (requires Moralis) |
| `.env.example` | Template for environment variables |

## Data Files

| File | Content |
|------|---------|
| `data/whales.json` | Tracked whale wallets (top 50) |
| `data/whales_multisource.json` | Multi-source discovery results |
| `data/monitor_state.json` | Known positions per whale (for new-position detection) |
| `data/risk_state.json` | Open positions, trade history, daily stats |
| `data/pnl_log.jsonl` | Trade-level PnL log |
| `data/pnl_daily.jsonl` | Daily PnL summaries |
| `data/polymarket_copier.jsonl` | Engine event log |

## Configuration

All config is in `config.mjs`. Key sections:

### Risk
```javascript
risk: {
  initialBankroll: 99.26,
  maxPositionSizeUsd: 10,        // max $10 per trade
  maxDailyTrades: 100,
  maxConcurrentPositions: 16,
  maxConcurrentPerCategory: 6,
  maxPortfolioDrawdownPct: 0.25, // 25% drawdown → pause
  minBalanceUsd: 10,
  dailyLossLimitUsd: 30,        // PROTECT THE DAY: stop at -$30 daily loss
  dailyTakeProfitUsd: 30,       // PROTECT THE DAY: stop at +$30 daily gain
  cooldownAfterLossMin: 0,
}
```

### Execution
```javascript
execution: {
  enabled: true,                  // auto-trade (false = alert-only)
  copyRatio: 0.10,                // copy 10% of whale's position size
  slippageBuffer: 0.04,           // 4% above whale entry
  orderType: 'GTC',
  fillTimeoutMin: 30,
  signatureType: 3,               // POLY_1271 — do NOT change
  exitLogic: {
    takeProfitPcts: [0.15, 0.30], // TP1 +15%, TP2 +30%
    scaleOutFraction: 0.5,        // sell half at TP1
    stopLossPct: 0.20,            // -20% hard stop
    trailingStopEnabled: true,
    trailingStopPct: 0.12,        // 12% trailing from peak
    holdToResolution: false,
    whaleExitEnabled: true,       // follow whale out
  },
}
```

### Monitoring
```javascript
monitoring: {
  pollIntervalSec: 30,
  alwaysOnPollIntervalSec: 45,   // backup polling (parallel with on-chain WS)
  consensusMinWhales: 3,
  minPositionSizeUsd: 500,
  minMarketLiquidity: 5000,
  filterResolutionBufferHours: 24,
}
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `POLY_PRIVATE_KEY` | Yes | EOA signer private key (`0x...` 64 hex chars) |
| `POLY_FUNDER_ADDRESS` | Yes | Polymarket proxy wallet address |
| `TELEGRAM_BOT_TOKEN` | Yes | Telegram bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | Yes | Your Telegram chat ID |
| `ALCHEMY_API_KEY` | Yes | Alchemy Polygon mainnet API key (for on-chain WS) |
| `MORALIS_API_KEY` | No | Optional — for pUSD flow tracking and wallet profiling |

## PM2 Commands

```bash
# Start
pm2 start index.mjs --name polymarket-copier

# Save process list (survives reboots)
pm2 save

# Logs
pm2 logs polymarket-copier --lines 100

# Restart
pm2 restart polymarket-copier --update-env

# Stop
pm2 stop polymarket-copier

# Delete
pm2 delete polymarket-copier
```

## Troubleshooting

See [DEPLOYMENT.md](DEPLOYMENT.md) for comprehensive troubleshooting, pitfalls, and lessons learned.

## Documentation

- [DEPLOYMENT.md](DEPLOYMENT.md) — Full deployment guide, troubleshooting, and lessons learned
- [PRD_ONCHAIN_ENTRIES.md](PRD_ONCHAIN_ENTRIES.md) — On-chain entry detection design document
- [PRD_WS_EXITS.md](PRD_WS_EXITS.md) — WebSocket exit monitoring design document
- [CREW_COPYTRADER.md](CREW_COPYTRADER.md) — Crew copy-trader documentation
