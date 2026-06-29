# PRD: On-Chain Whale Entry Monitoring via Polygon WebSocket

## Problem
We detect whale entries by polling `Data.getPositions()` every 45 seconds. On fast-moving markets (tennis, Bitcoin 5-min), the price moves 10-26% before we detect the entry. This causes:
- Skipped trades (slippage > 4% threshold)
- Worse entry prices (entering at $0.79 when whale got $0.626)
- Missed spikes (price already pumped by the time we enter)

## Solution
Subscribe to Polymarket's `OrderFilled` events on the Polygon blockchain via Alchemy WebSocket. Detect whale trades in **2-4 seconds** instead of 45.

## Architecture

### Current Flow (45s delay)
```
Whale places order on Polymarket
  → CLOB operator matches and settles on-chain
  → [45s later] Our poll cycle fires
  → Data.getPositions(whaleAddress) returns new position
  → Signal detected → trade executed
```

### New Flow (2-4s delay)
```
Whale places order on Polymarket
  → CLOB operator matches and settles on-chain
  → OrderFilled event emitted on Polygon
  → [2-4s] Alchemy WS delivers event to our bot
  → Match maker/taker address against whale list
  → Signal detected → trade executed immediately
```

### Hybrid Flow (both run in parallel)
```
On-chain WS (2-4s) → primary detection
45s API poll        → backup/fallback (in case WS disconnects)
```

## Technical Implementation

### Contracts to Monitor
| Contract | Address | Purpose |
|----------|---------|---------|
| CTF Exchange V2 (standard) | `0xE111180000d2663C0091e4f400237545B87B996B` | Standard markets |
| Neg Risk CTF Exchange V2 | `0xe2222d279d744050d28e00520010520000310F59` | Neg-risk markets (politics, multi-outcome) |

### Event Signature
```solidity
event OrderFilled(
    bytes32 indexed orderHash,
    address indexed maker,    // ← filter by whale addresses (topic2)
    address indexed taker,    // ← filter by whale addresses (topic3)
    uint8 side,               // 0 = BUY, 1 = SELL
    uint256 tokenId,          // CTF outcome token ID
    uint256 makerAmountFilled,
    uint256 takerAmountFilled,
    uint256 fee,
    bytes32 builder,
    bytes32 metadata
)
```

### Whale Address Management
- Load whale addresses from `data/whales.json` (51 addresses)
- Refresh every 60 minutes (same cycle as whale discovery)
- Store as both lowercase checksummed addresses
- Need TWO subscriptions (maker + taker) since whale could be either side

### Implementation Steps (6 steps)

#### Step 1: Create `onchain-monitor.mjs` module
- Connect to Alchemy Polygon WS: `wss://polygon-mainnet.g.alchemy.com/v2/<API_KEY>`
- Subscribe to `OrderFilled` events on both exchange contracts
- Filter maker/taker addresses against whale list
- On match: emit signal with `{ whaleAddress, tokenId, side, amount, timestamp }`
- Reconnect logic with backoff (same pattern as signal-monitor.mjs WS)
- Heartbeat/ping every 30s

#### Step 2: Decode OrderFilled events
- Use viem `decodeEventLog` or manual topic decoding
- Extract: maker, taker, side (BUY/SELL), tokenId, amounts
- Convert tokenId (uint256) to the string format Polymarket API uses
- Compute approximate price from `makerAmountFilled / takerAmountFilled`

#### Step 3: Wire to existing signal pipeline
- On `OrderFilled` with whale as maker or taker AND side = BUY:
  - Fetch market metadata from Gamma API (conditionId, title, outcome, endDate)
  - Check 24h resolution filter
  - Check if position is new (not in `knownPositions`)
  - Call `processNewPosition()` from signal-monitor.mjs
- On `OrderFilled` with whale as maker or taker AND side = SELL:
  - Trigger whale exit check in ws-exit-monitor.mjs
  - This gives us real-time whale EXIT detection too

#### Step 4: Dedup with polling
- On-chain detection may fire BEFORE the 45s poll sees it
- Use `knownPositions` Set (already exists) to prevent duplicate signals
- If on-chain fires first, the 45s poll will see it's already known and skip
- If poll fires first (WS disconnected), on-chain will see it's already known and skip

#### Step 5: Whale address subscription management
- `eth_subscribe` topic filters have address limits per subscription
- With 51 whales × 2 contracts × 2 (maker + taker) = 204 address-contract-role combos
- Split into batches of ~50 addresses per subscription (4 subscriptions)
- OR: single subscription with no address filter, filter client-side (simpler, more bandwidth)

#### Step 6: Fallback and monitoring
- If Alchemy WS disconnects → 45s API poll takes over automatically
- Log WS status every 5 minutes
- Alert on Telegram if WS disconnected > 5 minutes
- Health check: expect at least 1 event per hour during active trading

## Configuration

Add to `config.mjs`:
```javascript
onchain: {
  enabled: true,
  alchemyApiKey: process.env.ALCHEMY_API_KEY || '',
  exchangeContracts: [
    '0xE111180000d2663C0091e4f400237545B87B996B',  // CTF Exchange V2
    '0xe2222d279d744050d28e00520010520000310F59',  // Neg Risk CTF Exchange V2
  ],
  reconnectBaseMs: 1000,
  reconnectMaxMs: 30000,
  heartbeatMs: 30000,
  clientSideFilter: true,  // filter whale addresses client-side (simpler)
}
```

Add to `.env`:
```
ALCHEMY_API_KEY=<from Patrick>
```

## Dependencies
- `viem` (already installed) — for ABI decoding and WebSocket transport
- No new npm packages needed

## Edge Cases & Safety

1. **WS disconnect** → 45s API poll continues. Log + Telegram alert after 5 min.
2. **Duplicate signal** → `knownPositions` Set prevents double-entry (same as current).
3. **False positive** (whale selling, not buying) → Check `side === 0` (BUY) before triggering entry.
4. **Resolved market** → Check `endDate` via Gamma API before entering.
5. **Whale address changed** → Refresh whale list every 60 min from `data/whales.json`.
6. **Token ID format mismatch** → Polymarket API uses string token IDs, on-chain uses uint256. Convert with `BigInt(tokenId).toString()`.
7. **Neg-risk vs standard** → Check both contracts. Neg-risk markets (politics, multi-outcome) use the second contract.
8. **MEV/frontrun concern** → We're reading events, not sending transactions. No MEV risk.
9. **Rate limits** → Alchemy free tier: 25 RPS, 750K CU/month. WebSocket subscriptions are push-based (0 CU per event after subscription). Well within limits.

## QA Checklist

- [ ] Alchemy WS connects to Polygon
- [ ] OrderFilled events received from both exchange contracts
- [ ] Whale address matching works (test with known whale trade)
- [ ] Signal fires within 2-4 seconds of whale trade
- [ ] Market metadata fetched from Gamma API
- [ ] 24h resolution filter applied
- [ ] Entry executes via existing `executeSignal()` pipeline
- [ ] Duplicate prevention (on-chain + polling don't double-enter)
- [ ] WS disconnect → 45s poll takes over
- [ ] WS reconnect → resumes monitoring
- [ ] Whale sell detection → triggers whale exit
- [ ] Telegram alert on WS disconnect > 5 min
- [ ] No extra API calls from on-chain path (uses event data)
- [ ] Syntax check all files
- [ ] Backup all files before modifying

## Rollback Plan
```bash
# Remove onchain monitor
rm onchain-monitor.mjs
# Restore original files
cp index.mjs.bak.20260629.onchain index.mjs
cp config.mjs.bak.20260629.onchain config.mjs
pm2 restart polymarket-copier
```

## Expected Impact

| Metric | Current (45s poll) | With On-Chain (2-4s) |
|--------|-------------------|----------------------|
| Detection latency | ~22s average | ~3s average |
| Skipped trades (slippage) | ~20% of signals | ~5% of signals |
| Entry price vs whale | +5-15% slippage | +1-3% slippage |
| Win rate (estimated) | 37% | 45-50% |
| Daily PnL (estimated) | -$4 to +$6 | +$10 to +$25 |

## Bonus: Real-Time Whale Exit Detection
The same `OrderFilled` events that detect entries ALSO detect exits (side = SELL). Currently we check whale exits via polling in `manageExits()`. On-chain monitoring would give us **instant whale exit detection** — when a whale sells, we sell within 2-4 seconds instead of up to 15 seconds. This is a free bonus from the same subscription.

## Timeline
- Step 1-2: 2 hours (module + event decoding)
- Step 3-4: 2 hours (signal pipeline wiring + dedup)
- Step 5-6: 1 hour (subscription management + fallback)
- QA: 1 hour
- **Total: ~6 hours**
