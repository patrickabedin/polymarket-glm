# DEPLOYMENT.md — Polymarket Whale Copy Trader

Complete deployment guide with troubleshooting, pitfalls, and lessons learned.

## Prerequisites

- Node.js ≥ 20.10.0
- PM2 process manager
- A Polymarket wallet with funds (USDC on Polygon)
- A Telegram bot token

## Full Deployment (fresh server)

```bash
# 1. Clone
git clone https://github.com/patrickabedin/polymarket-glm.git
cd polymarket-glm

# 2. Install dependencies
npm install

# 3. Configure
cp .env.example .env
nano .env  # Fill in all values

# 4. Create data directory
mkdir -p data

# 5. Syntax check
npm test

# 6. Start with PM2
pm2 start index.mjs --name polymarket-copier
pm2 save

# 7. Monitor startup
pm2 logs polymarket-copier --lines 50
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `POLY_PRIVATE_KEY` | Yes (auto-trade) | EOA signer private key (0x + 64 hex chars) |
| `POLY_FUNDER_ADDRESS` | Yes (auto-trade) | Polymarket proxy wallet address |
| `TELEGRAM_BOT_TOKEN` | Yes | Bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | Yes | Your Telegram chat ID |
| `MORALIS_API_KEY` | No | For on-chain wallet profiling (optional) |

## Wallet Setup

### Getting your private key and funder address

1. Go to [polymarket.com](https://polymarket.com) and sign in
2. Click Settings → look for your wallet address
3. Your **funder address** is the proxy wallet address shown in settings (starts with `0x...`)
4. Your **private key** is the EOA signer key — export it from your browser wallet (MetaMask, etc.)
5. The EOA address (derived from the private key) is the signer; the funder address is the proxy

### signatureType

The config uses `signatureType: 3` (POLY_1271 / EIP-1271). This is correct for Polymarket-upgraded wallets. **Do not change this value.** Other types:
- `0` = EOA (direct wallet, no proxy)
- `1` = POLY_PROXY
- `2` = POLY_GNOSIS_SAFE
- `3` = POLY_1271 (correct for Polymarket UI-created wallets)

## Verification Checklist

After starting the bot, verify each step in the logs:

1. **Startup banner** prints with `Mode: 🟢 AUTO-TRADE`
2. **Deployment Safety Report** shows `mode: 🟢 LIVE`
3. **Whale Discovery** fetches 4 leaderboards, finds ~150 wallets, filters to ~50
4. **Tier classification** shows ~36 A+, 12 A, 48 B
5. **Telegram startup alert** received on your phone
6. **WebSocket connected** — `✅ WebSocket connected`
7. **Subscribed to N token IDs** — ~1400+ tokens
8. **CLOB client initialized** — `✅ CLOB client initialized with official SDK (sigType: 3)`
9. **User WebSocket connected** — for order updates
10. **Always-on polling started** — every 120s
11. **First poll completes** — `📊 Poll complete: N new signal(s) detected`

## Common Pitfalls & Lessons Learned

### P1: signal-monitor.mjs incomplete — missing exports (CRITICAL)

**Symptom:** Bot crashes instantly on startup. PM2 shows 24+ restarts. Zero log output. Error: `SyntaxError: The requested module './signal-monitor.mjs' does not provide an export named 'startMonitoring'`

**Root cause:** The file was left incomplete — missing the `startMonitoring()` export function, alert formatters, and the `executeSignal` import that wires signals to trade execution.

**Fix:** Ensure `signal-monitor.mjs` exports `startMonitoring(whales)` and imports `executeSignal` from `clob-executor.mjs`. See the file in this repo for the complete implementation.

**Lesson:** Always run `npm test` (syntax check) before deploying. A syntax check catches missing exports.

### P2: CLOB API error responses not handled (CRITICAL)

**Symptom:** Orders placed but `orderID=undefined, status=400`. Bot registers phantom trades. Reconciliation loop spams errors every 15s about "order undefined not in open orders."

**Root cause:** The CLOB API returns `{ error: "...", status: 400 }` on rejected orders (e.g., invalid token, amount too small, market resolved). The `placeOrder` function didn't check for `response.success` or `response.error` — it just logged `response.orderID` (which is undefined in error responses) and continued as if the order succeeded.

**Fix:** `placeOrder` now checks `response.success` and `response.error`, throws on error responses. `executeSignal` catches the throw and alerts via Telegram. Reconciliation filters out `undefined`/`null` orderIds.

**Lesson:** Always validate API response shapes. Don't assume success. Check for error fields before accessing success fields.

### P3: Gamma API field name mismatch — `minimumTickSize` vs `orderPriceMinTickSize`

**Symptom:** Orders might fail on 0.001-tick markets because tick size defaults to 0.01.

**Root cause:** The Gamma API returns `orderPriceMinTickSize`, not `minimumTickSize`. The code referenced `market.minimumTickSize` which was always `undefined`, falling back to `'0.01'`.

**Fix:** Use `market.orderPriceMinTickSize || market.minimumTickSize || '0.01'` everywhere.

**Lesson:** API field names change. Always verify against actual API responses with `curl`.

### P4: Moralis `top-gainers` endpoint deprecated/broken (CRITICAL for crew copy-trader)

**Symptom:** Crew copy-trader polls 0 wallets. Fingerprinting produces empty crew cache. Bot runs cycles doing nothing.

**Root cause:** The Moralis `erc20/{token}/top-gainers` endpoint returns HTTP 500 "Unknown error occurred" for BSC tokens and empty results for ETH tokens. The endpoint appears deprecated or broken.

**Fix:** Replaced with the `erc20/{token}/transfers` endpoint (which works reliably). The new implementation fetches recent transfers, identifies wallets that received tokens from DEX entities (Uniswap, PancakeSwap, etc.), and aggregates them as buyer wallets.

**Important:** The Moralis transfers endpoint has a max `limit` of 100. Using `limit=200` returns 0 results silently. Always use `limit=100` or less.

**Lesson:** Don't depend on a single API endpoint. Have fallbacks. Test endpoints with `curl` before building on them.

### P5: Moralis API limit parameter silently capped at 100

**Symptom:** `limit=200` returns 0 results. `limit=100` returns 100 results. `limit=50` returns 50 results.

**Root cause:** Moralis silently rejects requests with `limit > 100` on certain endpoints, returning empty results instead of an error.

**Fix:** Always use `limit=100` or less on Moralis API endpoints.

### P6: PM2 logs empty after `pm2 flush`

**Symptom:** After `pm2 flush`, logs remain at 0 bytes even though the process is running and producing output.

**Root cause:** PM2 log flushing can sometimes desync from the process's stdout/stderr streams.

**Fix:** Use `pm2 delete` + `pm2 start` instead of `pm2 flush` + `pm2 restart` to fully recreate the process and its log handles.

### P7: Private key validation fails when running test scripts

**Symptom:** `Error: invalid private key, expected hex or 32 bytes, got string` when running `node -e '...'` test scripts.

**Root cause:** The `config.mjs` validation runs at module load time. If `dotenv` isn't configured before importing `config.mjs`, the env vars are empty and execution gets disabled. The validation regex then sees an empty string as invalid.

**Fix:** Always use `import "dotenv/config"` as the FIRST import in any test script, before importing `config.mjs`.

## Architecture Details

### Signal Flow

```
Whale enters market
    ↓
signal-monitor.mjs detects new position (via polling or WS)
    ↓
processNewPosition() classifies signal:
  - Single whale → WHALE_ENTRY
  - 2+ whales same market → CONSENSUS
  - A+ tier alone → ELITE_SHARP
    ↓
sendTelegramHTML() — alert sent to Telegram
    ↓
executeSignal() called (if execution enabled for signal type)
    ↓
checkRisk() — risk gate (max positions, daily loss, etc.)
    ↓
checkEntryQuality() — spread, slippage, depth checks
    ↓
placeOrder() — CLOB API order placement
    ↓
registerTrade() — stored in risk_state.json
    ↓
Telegram alert with order ID
    ↓
manageExits() — runs every 30s, monitors TP/SL/trailing
    ↓
reconcileOrders() — runs every 15s, checks fill status
```

### State Files

| File | Purpose | Format |
|------|---------|--------|
| `data/whales.json` | Tracked whale wallets | JSON array |
| `data/monitor_state.json` | Known positions per whale | JSON (Sets serialized as arrays) |
| `data/risk_state.json` | Open positions, trade history, daily stats | JSON |
| `data/pnl_log.jsonl` | Trade-level PnL log | JSONL |
| `data/pnl_daily.jsonl` | Daily PnL summaries | JSONL |

### Risk Management

The bot has multiple safety layers:

1. **Per-trade cap:** $5 max per trade (5% of $99 bankroll)
2. **Daily trade cap:** 5 trades/day
3. **Concurrent position cap:** 8 positions max
4. **Category cap:** 3 per category max
5. **Drawdown circuit breaker:** 15% portfolio drawdown → pause
6. **Min balance:** $10 → stop trading
7. **Daily loss limit:** $15 → stop trading
8. **Cooldown:** 30min after any loss
9. **A+ standalone cap:** $2 max for elite sharp standalone trades
10. **Entry quality gate:** spread ≤6%, slippage ≤4%, depth sufficient, price ≤0.92

### Exit Logic

- Scale out at 0.85 and 0.90 (50% at first TP)
- Hard stop at 0.20
- 10% trailing stop from peak
- Hold to resolution if none of above hit

## Monitoring Commands

```bash
# Check status
pm2 describe polymarket-copier

# Recent logs
pm2 logs polymarket-copier --lines 100

# Check positions
cat data/risk_state.json | python3 -m json.tool | head -50

# Check PnL log
tail -20 data/pnl_log.jsonl | python3 -m json.tool

# Check whale cache
cat data/whales.json | python3 -c "import json,sys; d=json.load(sys.stdin); print(f'{len(d)} whales')"

# Check monitor state
cat data/monitor_state.json | python3 -c "import json,sys; d=json.load(sys.stdin); print(f'{len(d[\"knownPositions\"])} tracked wallets')"
```

## Troubleshooting

### Bot not producing any alerts

1. Check PM2 status: `pm2 describe polymarket-copier`
2. Check logs: `pm2 logs polymarket-copier --lines 100`
3. If logs are empty → delete and restart: `pm2 delete polymarket-copier && pm2 start index.mjs --name polymarket-copier`
4. If crashes on startup → run `npm test` to check syntax
5. If "missing export" error → the file is incomplete, re-clone from repo

### Orders failing with status 400

1. Check if the token ID is valid (market not resolved): `curl -s 'https://clob.polymarket.com/tick-size?token_id=TOKENID'`
2. If "market not found" → the market has resolved, token ID is stale
3. Check order size: minimum is $1 for marketable orders
4. Check if wallet has sufficient USDC balance

### Telegram alerts not arriving

1. Verify `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in `.env`
2. Test: `curl -s "https://api.telegram.org/bot<TOKEN>/sendMessage" -d chat_id=<CHAT_ID> -d text=test`
3. Check for HTML formatting errors in logs (unclosed tags cause 400 errors)

### Moralis API errors

1. Verify API key is valid: `curl -H 'X-API-Key: <KEY>' 'https://deep-index.moralis.io/api/v2.2/wallets/0x.../history?chain=bsc&limit=1'`
2. If "Invalid signature" → key is expired or invalid
3. If 429 → rate limited, increase delays between calls
4. Never use `limit > 100` — Moralis silently returns empty results

## Crew Copy-Trader (separate engine)

The crew copy-trader is a separate engine at `/app/trading_engine/crew_copytrader.mjs`. It:

1. **Fingerprints** crew wallets by fetching token transfers across 77 rug coins
2. Identifies wallets appearing on 2+ rug coins as "crew"
3. Monitors crew wallet activity via Moralis wallet history API
4. Detects consensus buys/sells across crew members
5. Runs in shadow mode (alerts only) by default

Key files:
- `core/moralis_wallets.mjs` — Moralis API client (transfers-based fingerprinting)
- `core/tx_classifier.mjs` — Transaction classification (BUY/SELL/intent confidence)
- `core/crew_scorer.mjs` — Crew wallet scoring
- `core/wallet_clusterer.mjs` — Wallet clustering (identifies related wallets)

PM2 process: `crew-copytrader`

---

## Exit Logic (Updated 2026-06-29)

### Priority Order
1. **Whale Exit** (primary) — polls the copied whale's portfolio each cycle. If the whale no longer holds the market, we sell immediately. This is the #1 exit signal.
2. **TP1/TP2 Scale-out** — sell 50% at $0.85, sell remaining at $0.90
3. **Hard Stop Loss** — exit at $0.30 (max 33% loss per position)
4. **Trailing Stop** — 7% from peak price (locks in gains when price reverses)
5. **No Hold-to-Resolution** — disabled. If nothing triggers, position stays open until whale exits or a stop hits.

### Why Whale Exit?
The bot copies whale entries. It should also copy whale exits. Trailing stops and TP levels are guesses — the whale knows when to exit better than we do. This also avoids the problem of riding a winner all the way back to break-even.

### Previous Exit Issues (Fixed)
- Trailing stop was 10% → gave back entire moves (bought $0.46, peaked $0.54, exited at $0.46 = $0 PnL)
- Hard stop was $0.20 → lost 56% per stop loss
- Hold-to-resolution was enabled → held bags forever if no stop triggered
- No whale exit tracking → bot held positions after whales already sold

## Cooldown Rules

| Rule | Value | Description |
|------|-------|-------------|
| Loss cooldown | 30 min | After any losing trade, 30min cooldown before next trade |
| Daily trade limit | 5 trades | Max 5 order attempts per day |
| Daily loss limit | $15 | Stop trading if daily losses exceed $15 |
| Min balance | $10 | Stop trading if balance drops below $10 |
| Max drawdown | 15% | Pause trading if portfolio drops 15% from peak |

## Concurrent Position Limits

| Rule | Value |
|------|-------|
| Max concurrent positions | 8 |
| Max per category | 3 (politics, sports, crypto, etc.) |
| Max position size | $5 (5% of $99 bankroll) |
| A+ standalone max | $2 |

## Risk Gates (Entry)
- Spread ≤ 6%
- Slippage ≤ 4% above whale entry
- Orderbook depth sufficient
- Max entry price ≤ $0.92
- Cooldown not active
- Daily trade limit not exceeded
- Daily loss limit not exceeded
- Min balance maintained
- Max concurrent positions not exceeded
