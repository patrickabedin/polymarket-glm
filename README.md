# 🐋 Polymarket Whale Copy Trader

**Auto-trades Polymarket prediction markets by copy-trading top wallets from the leaderboard.**

All trades on Polymarket are on-chain (Polygon) — fully transparent. This bot discovers profitable wallets, monitors their positions in real-time, and auto-executes copy trades via the CLOB API with full risk management.

## Quick Start (5 minutes)

```bash
# 1. Clone
git clone https://github.com/patrickabedin/polymarket-glm.git
cd polymarket-glm

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
# Edit .env — fill in POLY_PRIVATE_KEY, POLY_FUNDER_ADDRESS, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID

# 4. Syntax check
npm test

# 5. Start with PM2
pm2 start index.mjs --name polymarket-copier
pm2 save

# 6. Verify it's running
pm2 logs polymarket-copier --lines 50
```

You should see the startup banner, whale discovery (151 wallets analyzed, ~50 tracked), WebSocket connection, and "Signal Monitor starting".

## What You Need

| Item | How to Get It |
|------|---------------|
| **Polymarket wallet** | Create a wallet on polymarket.com (browser wallet → Polymarket UI creates an EIP-1167 minimal proxy). Export the private key from your wallet settings. |
| **Wallet address** | Your Polymarket proxy wallet address (starts with `0x...`). This is the `POLY_FUNDER_ADDRESS`. |
| **Private key** | The EOA signer private key (`0x...` 64 hex chars). This is the `POLY_PRIVATE_KEY`. |
| **signatureType** | Already set to `3` (POLY_1271) in config.mjs. This is correct for Polymarket-upgraded wallets. **Do not change it.** |
| **Telegram bot** | Message @BotFather → /newbot → get token. Message @userinfobot to get your chat ID. |

### Wallet Setup Notes

- Polymarket upgrades your wallet to an EIP-1167 minimal proxy. The `POLY_FUNDER_ADDRESS` is the **proxy** address (not your EOA).
- The `POLY_PRIVATE_KEY` is the **EOA signer** key, not the proxy.
- To find both: go to polymarket.com → Settings → look for your wallet address (proxy). The signer EOA is the address that signed the original wallet creation.
- **Test with $5-10 first.** The bot's default config caps trades at $5 each, $15 daily loss, $10 min balance.

## Architecture — 5 Layers

```
┌─────────────────────────────────────────────────────┐
│                  index.mjs (orchestrator)            │
├─────────┬─────────┬─────────┬─────────┬──────────────┤
│ Layer 1 │ Layer 2 │ Layer 3 │ Layer 4 │   Layer 5    │
│ Discover│ Monitor │ Execute │  Risk   │   Telegram   │
│         │         │         │         │              │
│ whale-  │ signal- │ clob-   │ risk-   │ telegram-    │
│ discov. │ monitor │ exec.   │ manager │ bot          │
│ + v2    │ .mjs    │ .mjs    │ .mjs    │ .mjs         │
│ sources │         │         │         │              │
└─────────┴─────────┴─────────┴─────────┴──────────────┘
```

### Layer 1: Whale Discovery (`whale-discovery.mjs` + `whale-sources-v2.mjs` + `whale-scoring-v2.mjs`)
- Fetches Polymarket leaderboards (OVERALL, POLITICS, CRYPTO, SPORTS)
- Filters: ≥75% win rate, ≥10 resolved positions, ≤0.60 avg entry price, ≥$1,000 total stake
- Classifies into tiers: A+ (elite sharp, auto-trade standalone), A, B, C
- Multi-source discovery adds wallets found via holders, on-chain, and social signals
- Scores on: timing accuracy, sizing consistency, category specialization, win rate, PnL magnitude
- Re-ranks every 60 minutes
- Output: `data/whales.json` (top 50 tracked wallets)

### Layer 2: Signal Monitoring (`signal-monitor.mjs`)
- **WebSocket** connection to `wss://ws-subscriptions-clob.polymarket.com/ws/market`
- Subscribes to all token IDs from tracked whales' known positions
- **Always-on polling** (every 120s) runs in parallel with WS for redundancy
- Detects NEW whale positions (not existing ones — state is persisted in `data/monitor_state.json`)
- Three signal types:
  - **WHALE_ENTRY** — single whale enters a market (alert + optional trade)
  - **CONSENSUS** — 2+ whales enter same market within 30min window (weighted score ≥3.0)
  - **ELITE_SHARP** — A+ tier whale acts alone (auto-trade standalone enabled)
- Filters: min position $500, min whale stake 1%, filter markets near resolution (<24h), filter crypto candle bots, min liquidity $5k

### Layer 3: CLOB Execution (`clob-executor.mjs`)
- Uses `@polymarket/clob-client-v2` SDK for authenticated order placement
- Limit orders (GTC) at best ask price for instant fills
- Position sizing: `copyRatio (5%) × whaleValue`, capped at `$5` max
- A+ standalone trades capped at `$2`
- Entry quality checks: spread ≤6%, slippage ≤4% above whale entry, depth sufficient, max entry price ≤0.92
- Exit management: scale-out at 0.85/0.90, hard stop at 0.20, 10% trailing stop, hold-to-resolution
- Order reconciliation loop (every 15s) checks fill status
- User WebSocket for real-time order updates

### Layer 4: Risk Management (`risk-manager.mjs`)
- Max $5 per trade (5% of $99 bankroll)
- Max 5 daily trades
- Max 8 concurrent positions
- Max 3 per category
- 15% max portfolio drawdown → pause
- $10 min balance → stop
- $15 daily loss limit → stop
- 30min cooldown after losses
- State: `data/risk_state.json`

### Layer 5: Telegram Alerts (`telegram-bot.mjs`)
- Whale entry alerts (HTML formatted)
- Consensus alerts (multi-whale)
- Elite sharp alerts (A+ standalone)
- Trade execution alerts
- Risk gate blocks
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
| `clob-executor.mjs` | CLOB order placement, exit management, reconciliation |
| `risk-manager.mjs` | Position sizing, circuit breakers, portfolio tracking |
| `telegram-bot.mjs` | Telegram message sending (Markdown + HTML) |
| `polymarket-api.mjs` | Gamma + Data + CLOB API client wrappers |
| `pnl-logger.mjs` | Trade-level + daily JSONL PnL logging |
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

### Risk (change these to match your bankroll)
```javascript
risk: {
  initialBankroll: 99.26,
  maxPositionSizeUsd: 5,        // max $5 per trade
  maxDailyTrades: 5,
  maxConcurrentPositions: 8,
  maxConcurrentPerCategory: 3,
  maxPortfolioDrawdownPct: 0.15,
  minBalanceUsd: 10,
  dailyLossLimitUsd: 15,
  cooldownAfterLossMin: 30,
}
```

### Execution
```javascript
execution: {
  enabled: true,                // auto-trade (false = alert-only)
  copyRatio: 0.05,              // copy 5% of whale's position size
  slippageBuffer: 0.04,         // 4% above whale entry
  orderType: 'GTC',
  fillTimeoutMin: 30,
  signatureType: 3,             // POLY_1271 — do NOT change
}
```

### Monitoring
```javascript
monitoring: {
  pollIntervalSec: 30,          // polling fallback interval
  alwaysOnPollIntervalSec: 120, // always-on polling (parallel with WS)
  consensusMinWhales: 3,
  minPositionSizeUsd: 500,
  minMarketLiquidity: 5000,
  filterResolutionBufferHours: 24,
}
```

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
