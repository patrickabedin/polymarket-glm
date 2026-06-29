# PRD: WebSocket Real-Time Exit System

## Problem
Exit checks run every 15 seconds via API polling. On tennis matches, price spikes last 10-30 seconds. We're catching spikes at +5% instead of +15% because of the 15-second delay.

## Solution
Use the existing Polymarket WebSocket connection to monitor open positions in real-time. When price hits TP/SL/trailing thresholds, exit instantly (< 1 second).

## Architecture

### Current Flow (15s delay)
```
manageExits() timer (15s)
  → for each open position:
    → CLOB.getOrderBook(tokenId)  [API call]
    → check TP/SL/trailing
    → if threshold hit: exitPosition()
```

### New Flow (real-time)
```
WS message received (price update for token X)
  → check if token X is an open position
  → if yes: check TP/SL/trailing against WS price
  → if threshold hit: exitPosition() immediately

Backup: manageExits() timer (15s) — unchanged, runs as fallback
```

## Implementation Plan (6 steps)

### Step 1: Backup current code
- `cp clob-executor.mjs clob-executor.mjs.bak.20260629.ws_exit`
- `cp signal-monitor.mjs signal-monitor.mjs.bak.20260629.ws_exit`

### Step 2: Create WS price monitor module (`ws-exit-monitor.mjs`)
- Maintains a Map of `tokenId → { position, entryPrice, peakPrice, exitConfig }`
- `registerPosition(tokenId, position, exitConfig)` — called when a trade fills
- `unregisterPosition(tokenId)` — called when a position closes
- `onPriceUpdate(tokenId, bestBid)` — called from signal-monitor.mjs WS message handler
  - Checks TP1, TP2, stop loss, trailing stop
  - If threshold hit: calls `exitPosition()` from clob-executor.mjs
  - Debounce: max 1 exit per token per 5 seconds (prevent double-sell)

### Step 3: Wire WS message handler → ws-exit-monitor
In `signal-monitor.mjs`, the `ws.on('message')` handler currently logs price updates.
Change to:
```javascript
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === 'book' || msg.type === 'price_change') {
    const tokenId = msg.asset_id;
    const bestBid = msg.bids?.[0]?.price || msg.price;
    if (tokenId && bestBid) {
      onPriceUpdate(tokenId, parseFloat(bestBid));
    }
  }
});
```

### Step 4: Wire trade fill → register position
In `clob-executor.mjs`, when a position transitions to FILLED:
```javascript
import { registerPosition, unregisterPosition } from './ws-exit-monitor.mjs';
// After fill confirmed:
registerPosition(pos.tokenId, pos, CONFIG.execution.exitLogic);
// After exit confirmed:
unregisterPosition(pos.tokenId);
```

### Step 5: Subscribe to position tokens on WS
In `signal-monitor.mjs`, when a new position opens, subscribe to that token:
```javascript
export function subscribeToToken(tokenId) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'market', assets_ids: [tokenId] }));
  }
}
export function unsubscribeFromToken(tokenId) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'market', assets_ids: [tokenId], action: 'unsubscribe' }));
  }
}
```

### Step 6: Keep 15s API poll as backup
- `manageExits()` in clob-executor.mjs stays unchanged
- It runs every 15s as fallback if WS disconnects
- If WS exit already fired, the 15s poll sees the position as EXIT_SUBMITTED and skips it

## Exit Thresholds (unchanged from current config)
| Threshold | Value | Action |
|-----------|-------|--------|
| TP1 | +15% from entry | Sell 50% |
| TP2 | +30% from entry | Sell remaining 50% |
| Stop loss | -20% from entry | Sell all |
| Trailing stop | 12% from peak | Sell all |
| Whale exit | Whale sold | Sell all |

## Edge Cases & Safety

1. **WS disconnect** → 15s API poll takes over. Log warning.
2. **WS reconnect** → Re-subscribe to all open position tokens. Sync peak prices from API.
3. **Double exit prevention** → If WS fires exit AND 15s poll fires exit for same position, the second one sees EXIT_SUBMITTED status and skips.
4. **Partial fill on exit** → WS exit sells remaining size (same as current logic).
5. **TP1 already hit** → WS monitor tracks tp1Hit flag, won't re-fire TP1.
6. **Stale WS price** → Ignore messages older than 5 seconds (compare timestamp).
7. **WS price has no bids** → Skip exit check (can't sell into empty book).

## QA Checklist

- [ ] Syntax check: `node --check` on all modified files
- [ ] Backup files created before any changes
- [ ] WS subscription works for new position token
- [ ] WS price update triggers exit check
- [ ] TP1 (+15%) fires via WS
- [ ] TP2 (+30%) fires via WS
- [ ] Stop loss (-20%) fires via WS
- [ ] Trailing stop (12%) fires via WS
- [ ] No double-exit when both WS and 15s poll fire
- [ ] WS disconnect → 15s poll continues working
- [ ] WS reconnect → re-subscribes to open positions
- [ ] Unsubscribe on position close
- [ ] No extra API calls from WS path (zero cost)
- [ ] Bot starts cleanly with WS exit monitor active
- [ ] First trade fills → position registered → WS price updates received → exit fires if threshold hit

## Rollback Plan
If anything breaks:
```bash
cp clob-executor.mjs.bak.20260629.ws_exit clob-executor.mjs
cp signal-monitor.mjs.bak.20260629.ws_exit signal-monitor.mjs
rm ws-exit-monitor.mjs
pm2 restart polymarket-copier
```
