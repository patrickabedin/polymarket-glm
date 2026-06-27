# Polymarket Whale Copier — Complete Documentation

## Table of Contents
1. [What This Is](#what-this-is)
2. [Architecture Overview](#architecture-overview)
3. [How We Built It (Step by Step)](#how-we-built-it)
4. [Pitfalls & Lessons Learned](#pitfalls--lessons-learned)
5. [Deployment Guide (From Scratch)](#deployment-guide-from-scratch)
6. [Configuration Reference](#configuration-reference)
7. [API Reference](#api-reference)
8. [Troubleshooting](#troubleshooting)

---

## What This Is

An automated copy-trading bot for Polymarket prediction markets. It discovers profitable wallets from the Polymarket leaderboard, monitors their positions in real-time via WebSocket, and auto-executes copy trades via the CLOB API with full risk management.

**Why Polymarket (not TradingView/Cornix):**
- All trades are on-chain (Polygon) — fully transparent
- Public API with order placement (CLOB)
- Public leaderboard with PnL rankings
- No middleman needed — we trade directly

**Backtest evidence:** Copy-trading wallets with ≥75% WR, ≥10 resolved positions, avg entry ≤0.60 showed 46.7% ROI over 90 days.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│  Layer 1: WHALE DISCOVERY                                           │
│  Scan leaderboard → filter by WR/entry/stake → score → rank top 20  │
│  API: Polymarket Data API (no auth)                                 │
├─────────────────────────────────────────────────────────────────────┤
│  Layer 2: SIGNAL MONITOR (WebSocket + polling fallback)             │
│  Connect to wss://ws-subscriptions-clob.polymarket.com/ws/market    │
│  Subscribe to 200+ token IDs across 100 active markets              │
│  On trade event → cross-reference with whale wallets via Data API   │
│  If whale new entry → emit signal (⚡ LIVE or ⏱️ POLL)             │
│  Consensus: 3+ whales same market within 10min = strong signal     │
│  Fallback: 30s polling if WS down >60s                             │
│  Reconnection: exponential backoff (1s → 30s max)                  │
├─────────────────────────────────────────────────────────────────────┤
│  Layer 3: AUTO EXECUTION                                            │
│  CLOB API order placement via @polymarket/clob-client-v2            │
│  signatureType: POLY_1271 (3) — EIP-1271 smart contract wallet      │
│  Limit orders at ask price for instant fills                       │
│  Copy ratio: 5% of whale position (capped at $5)                   │
│  Independent exits: TP at 0.85/0.90, stop at 0.20, trailing 10%    │
├─────────────────────────────────────────────────────────────────────┤
│  Layer 4: RISK MANAGEMENT                                           │
│  Max $5/trade, 5 trades/day, 8 concurrent positions                │
│  Max 3 per category, 15% drawdown kill, $15 daily loss limit       │
│  30min cooldown after loss                                         │
├─────────────────────────────────────────────────────────────────────┤
│  Layer 5: TELEGRAM ALERTS                                           │
│  Whale entries, consensus signals, trade fills, exits, daily summary│
│  Bot: @skynet_cyberdin_bot                                         │
└─────────────────────────────────────────────────────────────────────┘
```

---

## How We Built It

### Step 1: Research (Polymarket APIs)
Discovered Polymarket has 3 public APIs:
- **Gamma API** (no auth) — markets, events, prices, volume
- **Data API** (no auth) — positions, trades, leaderboard, whale tracking
- **CLOB API** (wallet auth) — order placement, orderbook, prices

### Step 2: Built 5-Layer Engine
Wrote 8 files implementing all layers:
- `config.mjs` — all parameters
- `polymarket-api.mjs` — API client (Gamma + Data + CLOB)
- `whale-discovery.mjs` — Layer 1
- `signal-monitor.mjs` — Layer 2
- `clob-executor.mjs` — Layer 3
- `risk-manager.mjs` — Layer 4
- `telegram-bot.mjs` — Layer 5
- `index.mjs` — orchestrator

### Step 3: Created GitHub Repo
- Repo: `patrickabedin/polymarket-glm`
- Deleted old compromised repos (`polymarket-oracle`, `skynet-crew-copytrader`) that had exposed wallet credentials

### Step 4: Deployed to DO Droplet
- SCP'd files to `/app/polymarket-copier/`
- `npm install` (viem, @polymarket/clob-client-v2, @polymarket/clob-client, ws, ethers)
- PM2: `polymarket-copier` (id 68)
- Also deployed `accumulation_scanner.mjs` to `/app/trading_engine/scripts/`

### Step 5: WebSocket Upgrade
- Replaced 30s polling with real-time WebSocket
- Connects to `wss://ws-subscriptions-clob.polymarket.com/ws/market`
- Subscribes to 200 token IDs across 100 active markets
- Polling fallback after 60s WS downtime
- Used `ws` npm package (Node v20 on droplet doesn't have global WebSocket)

### Step 6: Fixed Wallet Issues (Major Pitfall)
- Patrick's wallet was upgraded by Polymarket UI
- Old wallet: `0x08535205Cf1BafD37E4C4B9906E1305e154BC183` (Gnosis Safe)
- New wallet: `0x707f068abe713CA75642954dfB698Ca0303A2E55` (EIP-1167 proxy)
- Required signatureType change: POLY_GNOSIS_SAFE (2) → POLY_1271 (3)
- Test trade: 5 shares "Phillies win NL East" YES @ 0.36 = $1.80 → INSTANT FILL ✅

---

## Pitfalls & Lessons Learned

### 1. CRITICAL: Wallet Credential Exposure
**What happened:** Old repo `polymarket-oracle` had wallet addresses, proxy credentials, and references to compromised keys committed to GitHub in `src/index.ts`.

**Lesson:** NEVER commit wallet addresses, private keys, proxy credentials, or any identifying info to ANY repo (even private). Use `.env` files (gitignored) exclusively.

**What we did:** Deleted both old repos. New repo has zero hardcoded credentials. All secrets in `.env` (600 perms, gitignored).

### 2. CRITICAL: Polymarket Wallet Upgrade Changes signatureType
**What happened:** Polymarket UI asked Patrick to "upgrade your wallet". This silently changed the wallet from a Gnosis Safe (signatureType=2) to an EIP-1167 minimal proxy with EIP-1271 support (signatureType=3).

**Symptom:** `{"error":"maker address not allowed, please use the deposit wallet flow"}` with signatureType=0, 1, and 2.

**Fix:** Use `signatureType=3` (POLY_1271) with the `@polymarket/clob-client-v2` SDK. The v1 client (`@polymarket/clob-client`) doesn't support POLY_1271 properly.

**How to determine wallet type:**
```javascript
const code = await provider.getCode(funderAddress);
if (code === '0x') → EOA (signatureType=0)
else if (has getOwners()) → Gnosis Safe (signatureType=2)
else if (has owner()) → Polymarket Proxy (signatureType=1 or 3)
  → Try POLY_1271 (3) first for upgraded wallets
```

### 3. WebSocket URL Path Matters
**What happened:** Connected to `wss://ws-subscriptions-clob.polymarket.com/ws` → 404.

**Correct endpoints:**
- Market channel (no auth): `wss://ws-subscriptions-clob.polymarket.com/ws/market`
- User channel (auth): `wss://ws-subscriptions-clob.polymarket.com/ws/user`

### 4. Node v20 Doesn't Have Global WebSocket
**What happened:** `WebSocket is not defined` error on droplet (Node v20).

**Fix:** Install `ws` npm package and import: `import { WebSocket } from 'ws';`

### 5. Gamma API Field Names Differ from Docs
**What happened:** Code looked for `minimumTickSize` but the actual field is `orderPriceMinTickSize`.

**Other field name gotchas:**
- `clobTokenIds` — returned as a JSON string, not an array (must `JSON.parse()`)
- `volumeNum` / `liquidityNum` — not `volume_num` / `liquidity_num`
- `negRisk` — boolean, not string

### 6. CLOB Balance Endpoint Unreliable for Proxy Wallets
**What happened:** `getBalanceAllowance` returns `{"balance":"0"}` even when the wallet has funds and can trade.

**Workaround:** Don't rely on the balance endpoint for proxy wallets. Test with actual order placement instead. Monitor fill confirmations via order status (`"matched"` = filled).

### 7. Market Channel Doesn't Include Maker/Taker Addresses
**What happened:** The market WebSocket channel emits `last_trade_price` events but without wallet addresses. Can't directly identify which whale made the trade.

**Workaround:** On each trade event, do a quick Data API lookup (`GET /trades?market={conditionId}&limit=10`) and cross-reference taker addresses with tracked whale wallets.

### 8. Polymarket Markets Have Huge Spreads
**What happened:** Most long-shot markets have bid=0.001, ask=0.999. Can't get filled at a reasonable price.

**Solution:** Filter for markets with `spread < 0.05` and `bestAsk` between 0.10 and 0.90. These are typically high-volume markets (politics, sports).

### 9. FAK vs FOK Order Types
- **FAK (Fill-And-Kill / IOC):** Fills what it can, cancels rest. Good for our use case.
- **FOK (Fill-Or-Kill):** All-or-nothing. Might fail on low-liquidity markets.
- We use GTC (Good-Til-Cancelled) limit orders at ask price for instant fills.

### 10. Old vs New Polymarket SDK
- `@polymarket/clob-client` (v4) — uses ethers v5, supports signatureType 0/1/2
- `@polymarket/clob-client-v2` (v1.0.6) — uses viem, supports signatureType 0/1/2/3
- **Use v2** for POLY_1271 support

---

## Deployment Guide (From Scratch)

### Prerequisites
- DO droplet (or any Linux server) with Node.js 18+
- Polymarket account with upgraded wallet
- Telegram bot token (from @BotFather)
- PM2 installed globally

### Step 1: Clone Repo
```bash
git clone https://github.com/patrickabedin/polymarket-glm.git
cd polymarket-glm
```

### Step 2: Install Dependencies
```bash
npm install
```

### Step 3: Configure Environment
```bash
cp .env.example .env
# Edit .env:
# POLY_PRIVATE_KEY=0x... (your wallet's private key from Polymarket Settings → Export Wallet)
# POLY_FUNDER_ADDRESS=0x... (your Polymarket proxy wallet address)
# TELEGRAM_BOT_TOKEN=... (from @BotFather)
# TELEGRAM_CHAT_ID=... (your Telegram user ID)
chmod 600 .env
```

### Step 4: Verify Wallet Type
```javascript
// Run this to determine your signatureType
import { ethers } from 'ethers';
const provider = new ethers.providers.JsonRpcProvider('https://polygon.drpc.org');
const code = await provider.getCode(FUNDER_ADDRESS);
if (code === '0x') sigType = 0; // EOA
else {
  try {
    const safe = new ethers.Contract(FUNDER_ADDRESS, ['function getOwners() view returns (address[])'], provider);
    await safe.getOwners();
    sigType = 2; // Gnosis Safe
  } catch {
    sigType = 3; // POLY_1271 (upgraded wallet)
  }
}
```

### Step 5: Set signatureType in config.mjs
```javascript
signatureType: 3,  // 3 = POLY_1271 for upgraded wallets
```

### Step 6: Create PM2 Ecosystem Config
```javascript
// ecosystem.config.cjs
module.exports = {
  apps: [{
    name: 'polymarket-copier',
    script: 'index.mjs',
    env: {
      POLY_PRIVATE_KEY: '0x...',
      POLY_FUNDER_ADDRESS: '0x...',
      TELEGRAM_BOT_TOKEN: '...',
      TELEGRAM_CHAT_ID: '...',
    },
  }],
};
```

### Step 7: Start
```bash
pm2 start ecosystem.config.cjs
pm2 logs polymarket-copier --lines 30
pm2 save
```

### Step 8: Verify
- Check logs show "✅ WebSocket connected"
- Check logs show "📡 Subscribed to N token IDs"
- Check Telegram received startup message with whale list
- Place a test trade to verify CLOB execution

---

## Configuration Reference

### Whale Discovery Filters
| Parameter | Default | Description |
|-----------|---------|-------------|
| `minWinRate` | 0.75 | Minimum win rate (75%) |
| `minResolvedPositions` | 10 | Minimum resolved positions |
| `maxAvgEntryPrice` | 0.60 | Max avg entry (filters late scalpers) |
| `minTotalStake` | 5000 | Minimum total stake ($5K) |
| `maxTrackedWallets` | 20 | Track top 20 wallets |
| `refreshIntervalMin` | 60 | Re-rank whales every hour |

### Signal Monitoring
| Parameter | Default | Description |
|-----------|---------|-------------|
| `pollIntervalSec` | 30 | Fallback poll interval |
| `consensusMinWhales` | 3 | 3+ whales = strong signal |
| `consensusWindowMin` | 10 | Within 10-minute window |
| `minPositionSizeUsd` | 500 | Ignore trades < $500 |
| `filterCryptoCandleBots` | true | Skip latency-edge bots |
| `filterResolutionBufferHours` | 24 | Skip markets resolving <24h |
| `minMarketLiquidity` | 5000 | Market must have ≥$5k liquidity |

### Execution
| Parameter | Default | Description |
|-----------|---------|-------------|
| `copyRatio` | 0.05 | Copy 5% of whale's position |
| `slippageBuffer` | 0.02 | Limit 2% above whale entry |
| `signatureType` | 3 | POLY_1271 for upgraded wallets |
| `takeProfitRatios` | [0.85, 0.90] | Scale out at 0.85 and 0.90 |
| `stopLossPrice` | 0.20 | Hard stop at $0.20 |
| `trailingStopPct` | 0.10 | 10% trailing stop |

### Risk Management
| Parameter | Default | Description |
|-----------|---------|-------------|
| `maxPositionSizeUsd` | 5 | Max $5 per trade |
| `maxDailyTrades` | 5 | Max 5 trades/day |
| `maxConcurrentPositions` | 8 | Max 8 open at once |
| `maxConcurrentPerCategory` | 3 | Max 3 in same category |
| `maxPortfolioDrawdownPct` | 0.15 | Pause at 15% drawdown |
| `dailyLossLimitUsd` | 15 | Stop if daily loss > $15 |
| `cooldownAfterLossMin` | 30 | 30min cooldown after loss |

---

## API Reference

### Polymarket APIs

| API | Base URL | Auth | Purpose |
|-----|----------|------|---------|
| Gamma | `gamma-api.polymarket.com` | None | Markets, events, search |
| Data | `data-api.polymarket.com` | None | Positions, trades, leaderboard |
| CLOB | `clob.polymarket.com` | Wallet | Order placement, orderbook, prices |
| WebSocket | `ws-subscriptions-clob.polymarket.com/ws/market` | None | Real-time trade data |

### Key Endpoints
```
GET /v1/leaderboard?category=OVERALL&timePeriod=ALL&orderBy=PNL&limit=50
GET /positions?user={address}&sizeThreshold=1&limit=500
GET /closed-positions?user={address}&limit=500
GET /trades?market={conditionId}&limit=100
GET /markets?active=true&closed=false&limit=100
GET /midpoint?token_id={tokenId}
GET /book?token_id={tokenId}
```

### WebSocket Subscription (Market Channel)
```json
{
  "assets_ids": ["token_id_1", "token_id_2", ...],
  "type": "market"
}
```

### WebSocket Events
- `book` — Full orderbook snapshot
- `price_change` — Price level updates
- `last_trade_price` — Trade executions
- `tick_size_change` — Tick size changes

---

## Troubleshooting

### "maker address not allowed, please use the deposit wallet flow"
**Cause:** Wrong signatureType for your wallet type.
**Fix:** Use signatureType=3 (POLY_1271) for upgraded Polymarket wallets. Use signatureType=2 for Gnosis Safe. Use signatureType=0 for EOA.

### "Invalid order payload"
**Cause:** Usually a fee rate issue or wrong tick size.
**Fix:** Don't hardcode `feeRateBps`. Let the SDK determine it. Make sure `tickSize` matches the market's `orderPriceMinTickSize`.

### WebSocket 404
**Cause:** Wrong URL path.
**Fix:** Use `/ws/market` (not `/ws`). Market channel is public (no auth). User channel is at `/ws/user` (requires API creds).

### "WebSocket is not defined"
**Cause:** Node v20 doesn't have global WebSocket.
**Fix:** `npm install ws` and `import { WebSocket } from 'ws';`

### Balance shows 0 but trades work
**Cause:** Known quirk with proxy wallets. The `getBalanceAllowance` endpoint doesn't correctly report balance for POLY_1271 wallets.
**Fix:** Don't rely on balance endpoint. Test with actual order placement.

### Telegram 401 Unauthorized
**Cause:** Bot token not passed to PM2 environment.
**Fix:** Use `ecosystem.config.cjs` with `env:` block to pass `TELEGRAM_BOT_TOKEN` explicitly. PM2 doesn't auto-load `.env` files.

---

## File Structure
```
polymarket-whale-copier/
├── index.mjs              # Main entry — orchestrates all 5 layers
├── config.mjs             # All configuration
├── polymarket-api.mjs     # Gamma + Data + CLOB API client
├── whale-discovery.mjs    # Layer 1: Leaderboard scan + wallet scoring
├── signal-monitor.mjs     # Layer 2: WebSocket + polling fallback
├── clob-executor.mjs      # Layer 3: Order placement + exit management
├── risk-manager.mjs       # Layer 4: Circuit breakers + position limits
├── telegram-bot.mjs       # Layer 5: Telegram alerts + daily summary
├── package.json
├── .env.example
├── .gitignore
├── README.md
└── DEPLOYMENT.md          # This file
```

---

## Moralis Integration (Not Yet Implemented)

Moralis is configured in `config.mjs` but NOT used in the engine code. Planned uses:
1. Bot vs human detection (transaction timing analysis)
2. On-chain PnL verification (verify leaderboard claims)
3. pUSD flow tracking (detect whales moving funds)
4. Wallet profiling (human vs automated trader)

To implement, add a `moralis-integration.mjs` module that queries Moralis Polygon API for each tracked whale's transaction history and exposes the results to the signal monitor and whale discovery layers.

---

## Contact / Maintenance
- GitHub: `patrickabedin/polymarket-glm`
- Server: DO droplet `178.128.242.13` (SSH key: `~/.ssh/do_skynet`)
- PM2: `polymarket-copier` (id 68)
- Telegram: @skynet_cyberdin_bot
- Bankroll: $99.26 (starting)
- Bet size: $5/trade (5% of bankroll)

---

*Last updated: 2026-06-27*
*Built by: KiloClaw (SKYNET)*
