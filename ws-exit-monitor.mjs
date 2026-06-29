// ═══════════════════════════════════════════════════════════════════════════════
//  WS EXIT MONITOR — Real-time position exit via WebSocket price feeds
//
//  Subscribes to Polymarket WS price updates for open positions.
//  When price hits TP/SL/trailing thresholds, exits instantly (< 1s).
//  Zero API calls — uses the existing WS connection in signal-monitor.mjs.
//
//  Safety:
//    - Debounce: max 1 exit per token per 5 seconds
//    - Stale price protection: ignore messages > 5s old
//    - Empty book protection: skip if no bids
//    - Double-exit prevention: checks position status before exiting
//    - 15s API poll backup continues running in clob-executor.mjs
// ═══════════════════════════════════════════════════════════════════════════════

// Position registry: tokenId → position context
const positions = new Map();

// Debounce tracker: tokenId → last exit attempt timestamp
const lastExitAttempt = new Map();
const DEBOUNCE_MS = 5000;

// Stale price threshold
const STALE_MS = 5000;

// ── Register a position for WS monitoring ────────────────────────────────────
export function registerPosition(tokenId, position, exitConfig) {
  if (!tokenId) {
    console.warn('[WS-EXIT] Cannot register position: no tokenId');
    return;
  }
  positions.set(tokenId, {
    orderId: position.orderId,
    entryPrice: position.entryPrice,
    peakPrice: position.peakPrice || position.entryPrice || 0,
    size: position.size,
    tp1Hit: position.tp1Hit || false,
    tp2Hit: position.tp2Hit || false,
    exitConfig: exitConfig || {},
    registeredAt: Date.now(),
  });
  console.log(`[WS-EXIT] Registered position for token ${tokenId.slice(0, 12)}... (entry=${position.entryPrice}, size=${position.size})`);
}

// ── Unregister a position (on close) ─────────────────────────────────────────
export function unregisterPosition(tokenId) {
  if (positions.has(tokenId)) {
    positions.delete(tokenId);
    lastExitAttempt.delete(tokenId);
    console.log(`[WS-EXIT] Unregistered position for token ${tokenId.slice(0, 12)}...`);
  }
}

// ── Get all registered token IDs (for WS subscription) ────────────────────────
export function getRegisteredTokenIds() {
  return [...positions.keys()];
}

// ── Check if any positions are registered ────────────────────────────────────
export function hasRegisteredPositions() {
  return positions.size > 0;
}

// ── Main price update handler — called from signal-monitor.mjs WS onmessage ──
// Returns true if an exit was triggered, false otherwise.
export async function onPriceUpdate(tokenId, bestBid, timestamp) {
  const ctx = positions.get(tokenId);
  if (!ctx) return false; // not a monitored position

  // Stale price protection
  const msgAge = Date.now() - (timestamp || Date.now());
  if (msgAge > STALE_MS) {
    return false;
  }

  // Empty book protection
  if (!bestBid || bestBid <= 0) {
    return false;
  }

  // Debounce check
  const lastAttempt = lastExitAttempt.get(tokenId) || 0;
  if (Date.now() - lastAttempt < DEBOUNCE_MS) {
    return false;
  }

  const { entryPrice, exitConfig } = ctx;
  const price = bestBid;

  // Update peak price
  if (price > ctx.peakPrice) {
    ctx.peakPrice = price;
  }
  const peakPrice = ctx.peakPrice;

  let shouldExit = false;
  let exitReason = '';
  let exitSize = ctx.size;

  // 1. TP1: +15% from entry (sell half)
  if (!ctx.tp1Hit) {
    const tp1Target = entryPrice * (1 + (exitConfig.takeProfitPcts?.[0] ?? 0.15));
    if (price >= tp1Target) {
      shouldExit = true;
      exitReason = `WS TP1 +${((exitConfig.takeProfitPcts?.[0] ?? 0.15) * 100).toFixed(0)}% at ${price.toFixed(3)}`;
      exitSize = Math.floor(ctx.size * (exitConfig.scaleOutFraction ?? 0.5));
      ctx.tp1Hit = true;
    }
  }

  // 2. TP2: +30% from entry (sell remaining)
  if (!shouldExit && !ctx.tp2Hit) {
    const tp2Target = entryPrice * (1 + (exitConfig.takeProfitPcts?.[1] ?? 0.30));
    if (price >= tp2Target) {
      shouldExit = true;
      exitReason = `WS TP2 +${((exitConfig.takeProfitPcts?.[1] ?? 0.30) * 100).toFixed(0)}% at ${price.toFixed(3)}`;
      ctx.tp2Hit = true;
      const remaining = ctx.size - (ctx.pendingExitSize || 0);
      exitSize = Math.max(0, remaining);
    }
  }

  // 3. Stop loss: -20% from entry
  if (!shouldExit) {
    const stopTarget = entryPrice * (1 - (exitConfig.stopLossPct ?? 0.20));
    if (price <= stopTarget) {
      shouldExit = true;
      exitReason = `WS Stop loss -${((exitConfig.stopLossPct ?? 0.20) * 100).toFixed(0)}% at ${price.toFixed(3)}`;
      const remaining = ctx.size - (ctx.pendingExitSize || 0);
      exitSize = Math.max(0, remaining);
    }
  }

  // 4. Trailing stop: 12% from peak
  if (!shouldExit && exitConfig.trailingStopEnabled && peakPrice > entryPrice) {
    const trailingStop = peakPrice * (1 - (exitConfig.trailingStopPct ?? 0.12));
    if (price <= trailingStop && price < peakPrice) {
      shouldExit = true;
      exitReason = `WS Trailing stop at ${price.toFixed(3)} (peak: ${peakPrice.toFixed(3)})`;
      const remaining = ctx.size - (ctx.pendingExitSize || 0);
      exitSize = Math.max(0, remaining);
    }
  }

  if (shouldExit && exitSize > 0) {
    lastExitAttempt.set(tokenId, Date.now());
    console.log(`[WS-EXIT] ${exitReason} — selling ${exitSize} tokens of ${tokenId.slice(0, 12)}...`);

    // Import clob-executor dynamically to avoid circular dependency
    try {
      const { exitPositionWS } = await import('./clob-executor.mjs');
      if (typeof exitPositionWS === 'function') {
        await exitPositionWS(ctx.orderId, exitSize, price, exitReason, tokenId);
      } else {
        console.warn('[WS-EXIT] exitPositionWS not available — falling back to 15s poll');
      }
    } catch (e) {
      console.error(`[WS-EXIT] Exit failed for ${tokenId.slice(0, 12)}...: ${e.message}`);
    }

    return true;
  }

  return false;
}
