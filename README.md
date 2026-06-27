# 🐋 Polymarket Whale Copy Trader

**Auto-trades Polymarket prediction markets by copy-trading top wallets from the leaderboard.**

All trades on Polymarket are on-chain (Polygon) — fully transparent. This bot discovers profitable wallets, monitors their positions in real-time, and auto-executes copy trades via the CLOB API with full risk management.

## Architecture — 5 Layers

```
┌─────────────────────────────────────────────────────────────────────┐
│  Layer 1: WHALE DISCOVERY                                           │
│  Scan leaderboard → filter by WR/entry/stake → score → rank top 20  │
├─────────────────────────────────────────────────────────────────────┤
│  Layer 2: SIGNAL MONITOR                                            │
│  Poll whale positions every 30s → detect new entries → consensus    │
├─────────────────────────────────────────────────────────────────────┤
│  Layer 3: AUTO EXECUTION                                            │
│  CLOB API limit orders → 10% of whale size → independent exits      │
├─────────────────────────────────────────────────────────────────────┤
│  Layer 4: RISK MANAGEMENT                                           │
│  Max $50/trade, 10 trades/day, 15% drawdown kill, category limits   │
├─────────────────────────────────────────────────────────────────────┤
│  Layer 5: TELEGRAM ALERTS                                           │
│  Whale entries, consensus signals, trade fills, exits, daily summary │
└─────────────────────────────────────────────────────────────────────┘
```

## Why Polymarket (not TradingView/Cornix)

| Feature | Polymarket | TradingView/Cornix |
|---------|-----------|-------------------|
| Trade transparency | ✅ All on-chain (Polygon) | ❌ Private |
| Order placement API | ✅ Full CLOB API | ❌ Cornix middleman |
| Position tracking | ✅ Public Data API | ❌ No visibility |
| Whale wallet tracking | ✅ Leaderboard + positions | ❌ Impossible |
| SDK | ✅ Python/TS/Rust official | ❌ None |

## Quick Start

```bash
# 1. Clone
git clone https://github.com/patrickabedin/polymarket-glm.git
cd polymarket-glm

# 2. Install dependencies
npm install

# 3. Configure
cp .env.example .env
# Edit .env with your wallet key + Telegram bot token

# 4. Run whale discovery (one-time, see who we'll track)
node whale-discovery.mjs

# 5. Start the full bot
npm start
```

## Configuration

All settings are in `config.mjs`. Key parameters:

### Whale Discovery Filters
| Parameter | Default | Description |
|-----------|---------|-------------|
| `minWinRate` | 0.75 | Minimum win rate (75%) |
| `minResolvedPositions` | 10 | Minimum resolved positions |
| `maxAvgEntryPrice` | 0.60 | Max avg entry (filters late scalpers) |
| `minTotalStake` | 5000 | Minimum total stake ($5K) |
| `maxTrackedWallets` | 20 | Track top 20 wallets |

### Signal Monitoring
| Parameter | Default | Description |
|-----------|---------|-------------|
| `pollIntervalSec` | 30 | Poll whale positions every 30s |
| `consensusMinWhales` | 3 | 3+ whales = strong signal |
| `consensusWindowMin` | 10 | Within 10-minute window |
| `minPositionSizeUsd` | 500 | Ignore trades < $500 |
| `filterCryptoCandleBots` | true | Skip latency-edge bots |

### Execution
| Parameter | Default | Description |
|-----------|---------|-------------|
| `copyRatio` | 0.10 | Copy 10% of whale's position |
| `slippageBuffer` | 0.02 | Limit 2% above whale entry |
| `orderType` | GTC | Good-til-cancelled |
| `takeProfitRatios` | [0.85, 0.90] | Scale out at 0.85 and 0.90 |
| `stopLossPrice` | 0.20 | Hard stop at $0.20 |
| `trailingStopPct` | 0.10 | 10% trailing stop |

### Risk Management
| Parameter | Default | Description |
|-----------|---------|-------------|
| `maxPositionSizeUsd` | 50 | Max $50 per trade |
| `maxDailyTrades` | 10 | Max 10 trades/day |
| `maxConcurrentPositions` | 10 | Max 10 open at once |
| `maxConcurrentPerCategory` | 3 | Max 3 in same category |
| `maxPortfolioDrawdownPct` | 0.15 | Pause at 15% drawdown |
| `dailyLossLimitUsd` | 50 | Stop if daily loss > $50 |
| `cooldownAfterLossMin` | 30 | 30min cooldown after loss |

## API Reference

### Polymarket APIs Used

| API | Base URL | Auth | Purpose |
|-----|----------|------|---------|
| Gamma | `gamma-api.polymarket.com` | None | Markets, events, search |
| Data | `data-api.polymarket.com` | None | Positions, trades, leaderboard |
| CLOB | `clob.polymarket.com` | Wallet | Order placement, orderbook, prices |

### Key Endpoints

```
GET /v1/leaderboard?category=OVERALL&timePeriod=ALL&orderBy=PNL&limit=50
GET /positions?user={address}&sizeThreshold=1&limit=500
GET /closed-positions?user={address}&limit=500
GET /trades?user={address}&limit=100
GET /markets?active=true&closed=false&limit=100
GET /price?token_id={tokenId}
GET /book?token_id={tokenId}
```

## File Structure

```
polymarket-whale-copier/
├── index.mjs              # Main entry — orchestrates all 5 layers
├── config.mjs             # All configuration
├── polymarket-api.mjs     # Gamma + Data + CLOB API client
├── whale-discovery.mjs    # Layer 1: Leaderboard scan + wallet scoring
├── signal-monitor.mjs     # Layer 2: Position polling + consensus detection
├── clob-executor.mjs      # Layer 3: Order placement + exit management
├── risk-manager.mjs       # Layer 4: Circuit breakers + position limits
├── telegram-bot.mjs       # Layer 5: Telegram alerts + daily summary
├── package.json
├── .env.example
└── .gitignore
```

## Backtest Evidence

A backtest of copy-trading Polymarket whales with these filters (≥10 resolved positions, ≥$5K stake, ≥75% WR, avg entry ≤0.60) showed **46.7% ROI over 90 days**.

## Requirements

- Node.js 18+
- Polygon wallet with pUSD (for auto-trade mode)
- Telegram bot token (for alerts)
- PM2 (recommended for production)

## PM2 Deployment

```bash
npm install
pm2 start index.mjs --name polymarket-copier
pm2 save
```

## License

MIT
