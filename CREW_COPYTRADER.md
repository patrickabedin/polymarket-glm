# 🐺 Crew Copy-Trader

Detects when profitable "crew" wallets (wallets that profited from multiple rug coins) buy new tokens, and sends high-conviction Telegram alerts.

## How It Works

### 1. Fingerprinting (every 24h)
- Fetches recent token transfers for 77 watchlist rug coins via Moralis `erc20/{token}/transfers` endpoint
- Identifies wallets that received tokens from DEX entities (Uniswap, PancakeSwap, etc.)
- Wallets appearing on **2+ rug coins** = "crew" (multi-rug profiteers)
- Output: `data/crew_cache.json` (typically 4-15 crew wallets)

### 2. Live Monitoring (every 5 min)
- Polls each crew wallet's recent activity via Moralis `wallets/{address}/history` endpoint
- Classifies transactions as BUY/SELL using `core/tx_classifier.mjs`
- When 2+ crew wallets buy the same token within 6h window → consensus signal

### 3. Signal Tiers
| Tier | Score | Action | Telegram Alert |
|------|-------|--------|----------------|
| STRONG_COPY | 85+ | Highest conviction | ✅ Yes (rich HTML) |
| COPY | 70+ | High conviction | ✅ Yes (rich HTML) |
| WATCH | 55+ | Early signal | ❌ No (logged only) |
| RADAR | 40+ | Low confidence | ❌ No (logged only) |
| IGNORE | <40 | Skip | ❌ No |

**Only COPY and STRONG_COPY alerts are sent to Telegram.** This avoids noise from low-confidence signals.

### 4. Alert Format
Alerts are sent in HTML format with:
- Token name, chain, direction (LONG)
- Signal score out of 100
- Number of crew buyers and clusters
- Net buy USD (computed from DexScreener price × token amount)
- Liquidity, current price, move from crew entry
- Crew buyer details (address, score, tier)
- DexScreener chart link
- Clear call-to-action

### 5. Net Buy USD Calculation
Moralis doesn't always return `value_usd` on transfers. The bot computes it:
1. Try `evt.usdValue` from Moralis (if available)
2. Fallback: `valueFormatted (token amount) × DexScreener price`
3. Aggregated across all crew buyers → `netBuyUsd`

## Configuration

Key settings in `crew_copytrader.mjs` CONFIG:
```javascript
consensusWindowMs: 6 * 60 * 60 * 1000,  // 6h window
minCrewWallets: 2,                        // 2+ crew wallets needed
minIndependentClusters: 1,                // 1+ cluster (lowered from 2)
minWeightedCrewScore: 80,                 // minimum crew score sum
radarMinNetBuyUsd: 0,                     // allow $0 (Moralis may not provide USD)
copyMinNetBuyUsd: 25000,                  // $25k for COPY execution (not used in alert mode)
shadowMode: true,                         // alert-only (no auto-trade)
shadowAlerts: true,                       // send Telegram for COPY/STRONG_COPY
requireRiskGatePass: false,               // skip risk gate (alert-only mode)
```

## Moralis API Usage
- **Fingerprinting**: 77 calls every 24h (1 per watchlist coin)
- **Polling**: 4 calls per 5-min cycle × 288 cycles/day = 1,152 calls/day
- **Total**: ~1,229 calls/day — reasonable with Moralis Overages enabled
- **Caching**: 10-min TTL on fingerprinting, per-wallet cache on polling

## PM2 Commands
```bash
pm2 start crew_copytrader.mjs --name crew-copytrader
pm2 logs crew-copytrader --lines 50
pm2 restart crew-copytrader
pm2 save
```

## File Structure
```
/app/trading_engine/
├── crew_copytrader.mjs          # Main engine
├── core/
│   ├── moralis_wallets.mjs      # Moralis API client (transfers-based fingerprinting)
│   ├── tx_classifier.mjs        # Transaction classification (BUY/SELL)
│   ├── crew_scorer.mjs          # Crew wallet scoring
│   ├── wallet_clusterer.mjs     # Wallet clustering
│   ├── dexscreener.mjs          # DEX liquidity/price data
│   ├── risk_gate.mjs            # Token safety checks (disabled in alert mode)
│   ├── apex_plan.mjs            # APEX trade plan (disabled in shadow mode)
│   ├── telegram.mjs             # Telegram alert sending (HTML)
│   └── signal_logger.mjs        # Signal logging
├── data/
│   ├── crew_cache.json          # Discovered crew wallets
│   ├── crew_wallets.json        # All wallets from fingerprinting
│   ├── crew_scores.json         # Crew wallet scores
│   ├── wallet_clusters.json     # Cluster mappings
│   ├── fingerprint_ts.json      # Last fingerprint timestamp
│   ├── post_rug_watchlist.json  # 82 watchlist rug coins
│   ├── contract_map.json        # Token contract addresses
│   └── crew_copytrader.jsonl    # Signal log
```

## Pitfalls & Lessons Learned

### 1. Moralis `top-gainers` endpoint is deprecated (CRITICAL)
**Symptom:** Fingerprinting returns 0 crew wallets. Bot polls nothing.
**Cause:** `erc20/{token}/top-gainers` returns HTTP 500 on BSC, empty on ETH.
**Fix:** Use `erc20/{token}/transfers` endpoint instead. Filter for DEX-entity sends = buys.

### 2. Moralis `limit` parameter silently capped at 100
**Symptom:** `limit=200` returns 0 results. `limit=100` works fine.
**Fix:** Always use `limit=100` or less.

### 3. Moralis doesn't always return `value_usd` on transfers
**Symptom:** Net Buy shows $0 in alerts. Signals may fail USD threshold checks.
**Fix:** Compute USD value from `valueFormatted × DexScreener price` as fallback.

### 4. `telegram.mjs` exports `send` not `sendTelegram`
**Symptom:** `MOD.sendTelegram is not a function` — alerts never sent.
**Fix:** `mod.sendTelegram = tg.send || tg.sendTelegram || tg.alertInfo`

### 5. Risk gate `isBitgetTradeable` error in alert-only mode
**Symptom:** `RISK_GATE Error: isBitgetTradeable is not defined` — all signals blocked.
**Fix:** Set `requireRiskGatePass: false` for alert-only mode. Risk gate is for execution, not alerts.

### 6. Crew scores not regenerated when crew cache changes
**Symptom:** New crew wallets from fingerprinting have no scores → filtered out by `score >= 60`.
**Fix:** Delete `data/crew_scores.json` and `data/wallet_clusters.json` to force regeneration.

### 7. Old cluster mappings don't include new crew wallets
**Symptom:** `minIndependentClusters: 2` never satisfied because crew wallets aren't in cluster map.
**Fix:** Delete cluster/score files when crew cache changes. Set `minIndependentClusters: 1` for small crew sizes.
