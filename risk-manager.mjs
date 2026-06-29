// ═══════════════════════════════════════════════════════════════════════════════
//  LAYER 4: RISK MANAGER — Position sizing, circuit breakers, daily limits
// ═══════════════════════════════════════════════════════════════════════════════

import { CONFIG } from './config.mjs';
import fs from 'fs';
import path from 'path';

// ── State ──────────────────────────────────────────────────────────────────────
let openPositions = [];  // active positions
let tradeHistory = [];   // all trades (filled + exited)
let dailyStats = {
  date: new Date().toISOString().slice(0, 10),
  trades: 0,
  orderAttempts: 0,
  wins: 0,
  losses: 0,
  pnl: 0,
  volume: 0,
};
let portfolioPeak = 0;
let paused = false;
let pauseReason = '';
let cooldownUntil = 0;

// ── Load state ─────────────────────────────────────────────────────────────────
function loadState() {
  const stateFile = path.resolve(CONFIG.state.dir, 'risk_state.json');
  if (fs.existsSync(stateFile)) {
    const data = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    openPositions = data.openPositions || [];
    tradeHistory = data.tradeHistory || [];
    dailyStats = data.dailyStats || dailyStats;
    portfolioPeak = data.portfolioPeak || 0;
    paused = data.paused || false;
    pauseReason = data.pauseReason || '';
    cooldownUntil = data.cooldownUntil || 0;
  }
}

function saveState() {
  const stateFile = path.resolve(CONFIG.state.dir, 'risk_state.json');
  const stateDir = path.dirname(stateFile);
  if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({
    openPositions, tradeHistory, dailyStats, portfolioPeak,
    paused, pauseReason, cooldownUntil,
    savedAt: new Date().toISOString(),
  }, null, 2));
}

// ── Reset daily stats if new day ───────────────────────────────────────────────
function checkDailyReset() {
  const today = new Date().toISOString().slice(0, 10);
  if (dailyStats.date !== today) {
    dailyStats = {
      date: today,
      trades: 0, orderAttempts: 0, wins: 0, losses: 0, pnl: 0, volume: 0,
    };
    paused = false;
    pauseReason = '';
  }
}

// ── Fix 5: isExposureStatus helper ─────────────────────────────────────────────
// Unified helper for all exposure/position counting. Use everywhere we need to
// determine if a position counts toward exposure.
function isExposureStatus(status) {
  return ['FILLED', 'OPEN', 'PENDING_FILL', 'SUBMITTED', 'LIVE',
          'PARTIALLY_FILLED',
          'EXIT_SUBMITTED', 'EXIT_LIVE', 'EXIT_PARTIALLY_FILLED',
          'RECONCILE_UNKNOWN'].includes(status);
}

// ── Fix 6/8: Compute portfolio equity including cash (no double-counting) ─────
// Fix 2 (v1.3.2): totalEquity must NOT drop when a pending order is placed.
// availableCash = bankroll + realizedPnl - openCost - pendingExposure (capital locked in pending orders)
// reservedCash = pendingExposure (cash reserved for pending buy orders)
// totalEquity = availableCash + reservedCash + positionsValue
// Risk checks use availableCash; drawdown/reporting use totalEquity.
function computePortfolioEquity() {
  const activePositions = openPositions.filter(p => isExposureStatus(p.status));
  const valueStatuses = ['FILLED', 'OPEN', 'PARTIALLY_FILLED',
                 'EXIT_SUBMITTED', 'EXIT_LIVE', 'EXIT_PARTIALLY_FILLED'];
  const positionsValue = activePositions
    .filter(p => valueStatuses.includes(p.status))
    .reduce((s, p) => s + (p.currentValue || p.valueUsd || 0), 0);
  const pendingExposure = activePositions
    .filter(p => p.status === 'PENDING_FILL' || p.status === 'SUBMITTED' || p.status === 'LIVE')
    .reduce((s, p) => s + (p.valueUsd || 0), 0);
  const realizedPnl = dailyStats.pnl;
  const totalCostOfOpenPositions = activePositions
    .filter(p => valueStatuses.includes(p.status))
    .reduce((s, p) => s + (p.valueUsd || 0), 0);
  // Cash available for new trades (excludes capital locked in pending orders)
  const availableCash = CONFIG.risk.initialBankroll + realizedPnl - totalCostOfOpenPositions - pendingExposure;
  // Cash reserved in pending orders (still ours, just not available for new trades)
  const reservedCash = pendingExposure;
  // Total equity = available + reserved + positions (does NOT drop when an order is merely pending)
  const totalEquity = availableCash + reservedCash + positionsValue;
  return { positionsValue, pendingExposure, realizedPnl, cash: availableCash, availableCash, reservedCash, totalEquity };
}

// ── Check if a trade is allowed ────────────────────────────────────────────────
export function checkRisk(signal, intendedSizeUsd) {
  loadState();
  checkDailyReset();

  // Paused
  if (paused) {
    return { allowed: false, reason: `Trading paused: ${pauseReason}` };
  }

  // Cooldown
  if (Date.now() < cooldownUntil) {
    const minsLeft = Math.ceil((cooldownUntil - Date.now()) / 60000);
    return { allowed: false, reason: `Cooldown active (${minsLeft}min remaining)` };
  }

  // Daily trade limit — based on order attempts (submitted orders)
  if (dailyStats.orderAttempts >= CONFIG.risk.maxDailyTrades) {
    return { allowed: false, reason: `Daily trade limit reached (${dailyStats.orderAttempts}/${CONFIG.risk.maxDailyTrades} order attempts)` };
  }

  // Fix 6: One-position-per-market-outcome protection
  const conditionId = signal.market?.conditionId;
  const tokenId = signal.market?.asset;
  if (conditionId && tokenId) {
    const existing = openPositions.find(p =>
      p.conditionId === conditionId &&
      p.tokenId === tokenId &&
      isExposureStatus(p.status)
    );
    if (existing) {
      return { allowed: false, reason: `Already have position for conditionId+tokenId (${existing.status})` };
    }
  }

  // Fix 5: Max concurrent positions — use isExposureStatus helper
  const activeCount = openPositions.filter(p => isExposureStatus(p.status)).length;
  if (activeCount >= CONFIG.risk.maxConcurrentPositions) {
    return { allowed: false, reason: `Max concurrent positions (${activeCount}/${CONFIG.risk.maxConcurrentPositions})` };
  }

  // Fix 5/6: Per-category limit — use isExposureStatus helper
  if (signal.market?.eventSlug) {
    const category = signal.market.eventSlug.split('/')[0] || 'unknown';
    const catCount = openPositions.filter(p =>
      isExposureStatus(p.status) &&
      (p.category || (p.marketSlug?.split('/')[0]) || 'unknown') === category
    ).length;
    if (catCount >= CONFIG.risk.maxConcurrentPerCategory) {
      return { allowed: false, reason: `Max positions in category "${category}" (${catCount}/${CONFIG.risk.maxConcurrentPerCategory})` };
    }
  }

  // Daily loss limit
  if (dailyStats.pnl <= -CONFIG.risk.dailyLossLimitUsd) {
    return { allowed: false, reason: `Daily loss limit hit ($${dailyStats.pnl.toFixed(2)} / -$${CONFIG.risk.dailyLossLimitUsd})` };
  }

  // Fix 6: Portfolio drawdown — based on total account equity (including cash)
  const equity = computePortfolioEquity();
  if (portfolioPeak > 0) {
    const drawdown = (portfolioPeak - equity.totalEquity) / portfolioPeak;
    if (drawdown > CONFIG.risk.maxPortfolioDrawdownPct) {
      paused = true;
      pauseReason = `Portfolio drawdown ${(drawdown * 100).toFixed(1)}% > ${(CONFIG.risk.maxPortfolioDrawdownPct * 100)}% limit`;
      saveState();
      return { allowed: false, reason: pauseReason };
    }
  }
  // Update peak
  if (equity.totalEquity > portfolioPeak) portfolioPeak = equity.totalEquity;

  // Fix 6: Min balance enforcement — available capital is cash
  const availableCapital = equity.cash;
  if (availableCapital < CONFIG.risk.minBalanceUsd) {
    return { allowed: false, reason: `Available capital $${availableCapital.toFixed(2)} < min balance $${CONFIG.risk.minBalanceUsd}` };
  }
  // Fix 2: Use intendedSizeUsd (our copy size), not signal.entry.valueUsd (whale's size)
  const tradeSize = intendedSizeUsd || CONFIG.risk.maxPositionSizeUsd;
  if (availableCapital < tradeSize) {
    return { allowed: false, reason: `Insufficient capital for $${tradeSize} trade (available: $${availableCapital.toFixed(2)})` };
  }

  return { allowed: true };
}

// ── Register a new trade ───────────────────────────────────────────────────────
export function registerTrade(trade) {
  loadState();

  openPositions.push({
    ...trade,
    // Fix 6: Store actual market metadata, not signalType as marketSlug
    marketSlug: trade.marketSlug || trade.market || '',
    eventSlug: trade.eventSlug || '',
    category: trade.category || '',
    conditionId: trade.conditionId || '',
    assetId: trade.tokenId || trade.assetId || '',
    entryPrice: trade.price,
    peakPrice: trade.price,
    currentValue: trade.valueUsd,
    status: trade.status,
    marketData: trade.marketData || null,
    tp1Hit: false,
    tp2Hit: false,
    intendedSize: trade.size,
    // Fix 7: Store intended size separately from actual size
    processedEventIds: [],
    processedSellOrderIds: [],
    cumulativeFilledSize: 0,
    exitFillsByOrderId: {}, // Fix 4: per-sellOrderId fill tracking
  });

  // Fix 9 (v1.3.2): Increment orderAttempts (not trades) at submission time.
  // trades is incremented only when entry fill is confirmed (in updatePositionStatus).
  dailyStats.orderAttempts++;
  dailyStats.volume += trade.valueUsd;

  saveState();
}

// ── Update position status (Fix 3 — reconciliation support) ────────────────────
export function updatePositionStatus(orderId, newStatus) {
  loadState();

  const pos = openPositions.find(p => p.orderId === orderId);
  if (pos) {
    const oldStatus = pos.status;
    const preFillStatuses = ['PENDING_FILL', 'SUBMITTED', 'LIVE', 'RECONCILE_UNKNOWN'];
    // Fix 9 (v1.3.2): Increment trades only when entry fill is confirmed, not at submission
    if ((newStatus === 'FILLED' || newStatus === 'PARTIALLY_FILLED') && preFillStatuses.includes(oldStatus)) {
      dailyStats.trades++;
      console.log(`📊 Trade count incremented: ${orderId} ${oldStatus} → ${newStatus} (trades today: ${dailyStats.trades})`);
    }
    pos.status = newStatus;
    saveState();
    console.log(`📊 Status transition: ${orderId} ${oldStatus} → ${newStatus}`);
  }
}

// ── Fix 1: Persist entry fill size and price ──────────────────────────────────
export function updatePositionFill(orderId, filledSize, avgFillPrice, actualCost) {
  loadState();
  const pos = openPositions.find(p => p.orderId === orderId);
  if (!pos) {
    console.warn(`⚠️  updatePositionFill: position not found for orderId=${orderId}`);
    return;
  }
  pos.size = filledSize;
  pos.entryPrice = avgFillPrice;
  pos.valueUsd = actualCost !== undefined ? actualCost : (filledSize * avgFillPrice);
  pos.currentValue = pos.valueUsd;
  saveState();
  console.log(`💾 Position fill persisted: ${orderId} size=${filledSize} price=${avgFillPrice} cost=${pos.valueUsd}`);
}

// ── Fix 4: Persist TP1/TP2 state ───────────────────────────────────────────────
export function markTpHit(orderId, tpKey) {
  loadState();
  const pos = openPositions.find(p => p.orderId === orderId);
  if (pos) {
    pos[tpKey] = true;
    saveState();
    console.log(`📌 TP state persisted: ${orderId} ${tpKey}=true`);
  }
}

// ── Update position price (for trailing stop) ──────────────────────────────────
export function updatePositionPrice(orderId, currentPrice, peakPrice) {
  loadState();

  const pos = openPositions.find(p => p.orderId === orderId);
  if (pos) {
    pos.currentPrice = currentPrice;
    pos.peakPrice = peakPrice;
    pos.currentValue = currentPrice * pos.size;
    // Fix 7: Portfolio peak must be based on total equity, not one position
    const equity = computePortfolioEquity();
    if (equity.totalEquity > portfolioPeak) {
      portfolioPeak = equity.totalEquity;
    }
    saveState();
  }
}

// ── Fix 1: Persist exit order metadata to risk_state.json ─────────────────────
export function setExitOrderMetadata(entryOrderId, sellOrderId, exitSize, exitPrice, reason, pendingExitSize) {
  loadState();
  const pos = openPositions.find(p => p.orderId === entryOrderId);
  if (!pos) {
    console.warn(`⚠️  setExitOrderMetadata: position not found for entryOrderId=${entryOrderId}`);
    return;
  }
  pos.exitSellOrderId = sellOrderId;
  pos.exitSize = exitSize;
  pos.exitPrice = exitPrice;
  pos.exitReason = reason;
  pos.exitSubmittedAt = Date.now();
  // Fix 4: Persist pendingExitSize
  if (pendingExitSize !== undefined) {
    pos.pendingExitSize = pendingExitSize;
  }
  saveState();
  console.log(`💾 Exit metadata persisted: entry=${entryOrderId} sell=${sellOrderId} size=${exitSize} price=${exitPrice} reason=${reason} pendingExitSize=${pendingExitSize !== undefined ? pendingExitSize : 'N/A'}`);
}

// ── Fix 4: Persist pendingExitSize separately ─────────────────────────────────
export function setPendingExitSize(orderId, size) {
  loadState();
  const pos = openPositions.find(p => p.orderId === orderId);
  if (!pos) {
    console.warn(`⚠️  setPendingExitSize: position not found for orderId=${orderId}`);
    return;
  }
  pos.pendingExitSize = size;
  saveState();
  console.log(`💾 pendingExitSize persisted: ${orderId} size=${size}`);
}

// ── Fix 5: Persist exit retries ───────────────────────────────────────────────
export function incrementExitRetry(entryOrderId) {
  loadState();
  const pos = openPositions.find(p => p.orderId === entryOrderId);
  if (!pos) {
    console.warn(`⚠️  incrementExitRetry: position not found for entryOrderId=${entryOrderId}`);
    return 0;
  }
  pos.exitRetries = (pos.exitRetries || 0) + 1;
  const retries = pos.exitRetries;
  saveState();
  console.log(`💾 Exit retry persisted: ${entryOrderId} retries=${retries}`);
  return retries;
}

// ── Fix 5: Get exit retries from persisted state ──────────────────────────────
export function getExitRetries(entryOrderId) {
  loadState();
  const pos = openPositions.find(p => p.orderId === entryOrderId);
  if (!pos) return 0;
  return pos.exitRetries || 0;
}

// ── Fix 9: Clear exit metadata (for cancelled/timeout exits) ──────────────────
export function clearExitMetadata(orderId) {
  loadState();
  const pos = openPositions.find(p => p.orderId === orderId);
  if (!pos) {
    console.warn(`⚠️  clearExitMetadata: position not found for orderId=${orderId}`);
    return;
  }
  delete pos.exitSellOrderId;
  delete pos.exitSize;
  delete pos.exitPrice;
  delete pos.exitReason;
  delete pos.exitSubmittedAt;
  delete pos.exitRetries;
  delete pos.pendingExitSize;
  saveState();
  console.log(`🧹 Exit metadata cleared for ${orderId}`);
}

// ── Fix 11: Event idempotence helpers ─────────────────────────────────────────
export function isEventProcessed(orderId, eventHash) {
  loadState();
  const pos = openPositions.find(p => p.orderId === orderId);
  if (!pos) return false;
  if (!pos.processedEventIds) pos.processedEventIds = [];
  return pos.processedEventIds.includes(eventHash);
}

export function markEventProcessed(orderId, eventHash) {
  loadState();
  const pos = openPositions.find(p => p.orderId === orderId);
  if (!pos) return;
  if (!pos.processedEventIds) pos.processedEventIds = [];
  if (!pos.processedEventIds.includes(eventHash)) {
    pos.processedEventIds.push(eventHash);
    // Keep array bounded — only last 100 events
    if (pos.processedEventIds.length > 100) {
      pos.processedEventIds = pos.processedEventIds.slice(-100);
    }
    saveState();
  }
}

export function makeEventHash(orderId, eventType, sizeMatched, price) {
  return `${orderId}:${eventType}:${sizeMatched}:${price}`;
}

// ── Register an exit (Fix 4/5: per-order fill tracking, returns { booked, fillDelta, pnl }) ──
export function registerExit(orderId, exitDetails) {
  loadState();

  const pos = openPositions.find(p => p.orderId === orderId);
  if (!pos) return { booked: false, fillDelta: 0, pnl: 0 };

  // Fix 4: Track cumulative filled per sellOrderId, not globally
  const sellOrderId = exitDetails.sellOrderId || 'unknown';
  const cumulativeFilledSize = exitDetails.cumulativeFilledSize !== undefined
    ? exitDetails.cumulativeFilledSize
    : exitDetails.size;

  if (!pos.exitFillsByOrderId) pos.exitFillsByOrderId = {};
  const alreadyRegistered = pos.exitFillsByOrderId[sellOrderId] || 0;
  const fillDelta = cumulativeFilledSize - alreadyRegistered;

  // Fix 5: Return without booking if no new fill
  if (fillDelta <= 0) {
    console.log(`⏭️  registerExit: cumulative ${cumulativeFilledSize} <= already registered ${alreadyRegistered} for sellOrder ${sellOrderId} on ${orderId}, skipping`);
    return { booked: false, fillDelta: 0, pnl: 0 };
  }

  // Book PnL only on the fillDelta
  const pnl = (exitDetails.price - pos.entryPrice) * fillDelta;
  dailyStats.pnl += pnl;

  if (pnl > 0) dailyStats.wins++;
  else dailyStats.losses++;

  // Fix 4: Update per-order cumulative tracker
  pos.exitFillsByOrderId[sellOrderId] = cumulativeFilledSize;

  // Also keep cumulativeFilledSize for backward compatibility
  pos.cumulativeFilledSize = (pos.cumulativeFilledSize || 0) + fillDelta;

  // Reduce pos.size by the fill delta
  pos.size -= fillDelta;
  if (pos.size < 0) pos.size = 0;

  // Fix 4 (v1.3.2): Update remaining cost basis and current value proportionally
  // After selling half, the remaining position should reflect the remaining cost/value
  const remainingCost = pos.entryPrice * pos.size;
  pos.valueUsd = remainingCost;
  pos.currentValue = pos.currentPrice ? pos.currentPrice * pos.size : remainingCost;

  pos.realizedPnl = (pos.realizedPnl || 0) + pnl;

  // Clear pendingExitSize if this exit covers it
  if (pos.pendingExitSize && cumulativeFilledSize >= pos.pendingExitSize) {
    delete pos.pendingExitSize;
  }

  // Update or remove position
  if (pos.size <= 0) {
    pos.status = 'EXITED';
    pos.exitPrice = exitDetails.price;
    pos.exitReason = exitDetails.reason;
    pos.exitTime = Date.now();
    pos.pnl = pnl;
    tradeHistory.push({ ...pos });
    openPositions = openPositions.filter(p => p.orderId !== orderId);

    // Cooldown after loss
    if (pnl < 0) {
      cooldownUntil = Date.now() + (CONFIG.risk.cooldownAfterLossMin * 60000);
      console.log(`⏸️  Loss cooldown: ${CONFIG.risk.cooldownAfterLossMin}min`);
    }
  } else {
    // Partial exit — position stays open with reduced size
    // Fix 3 (v1.3.2): If status is EXIT_FILLED (set by WS/reconciliation), reset to FILLED
    // so the remaining position is counted in exposure, risk, and exit management.
    // EXIT_FILLED is not an exposure status — the remaining size would disappear from risk.
    if (pos.status === 'EXIT_FILLED' || pos.status === 'EXIT_PARTIALLY_FILLED') {
      pos.status = 'FILLED';
      // Clear exit metadata so manageExits can re-evaluate cleanly
      delete pos.exitSellOrderId;
      delete pos.exitSize;
      delete pos.exitPrice;
      delete pos.exitReason;
      delete pos.exitSubmittedAt;
      delete pos.exitRetries;
      delete pos.pendingExitSize;
      console.log(`🔄 Partial exit fill: ${orderId} status reset to FILLED (remaining size: ${pos.size})`);
    }
    pos.exitRegistered = false;
  }

  saveState();
  return { booked: true, fillDelta, pnl };
}

// ── Get open positions (Fix 3/5: include exit lifecycle states) ────────────────
export function getOpenPositions() {
  loadState();
  return openPositions.filter(p => isExposureStatus(p.status));
}

// ── Fix 3: Get all stored positions (including non-exposure) for lookups ───────
export function getAllStoredPositions() {
  loadState();
  return openPositions;
}

// ── Get daily stats ────────────────────────────────────────────────────────────
export function getDailyStats() {
  loadState();
  checkDailyReset();
  return { ...dailyStats };
}

// ── Get full portfolio status ──────────────────────────────────────────────────
export function getPortfolioStatus() {
  loadState();
  const equity = computePortfolioEquity();
  const active = openPositions.filter(p => p.status === 'FILLED' || p.status === 'OPEN' || p.status === 'PARTIALLY_FILLED');
  const totalValue = active.reduce((s, p) => s + (p.currentValue || p.valueUsd || 0), 0);
  const totalCost = active.reduce((s, p) => s + (p.valueUsd || 0), 0);
  const unrealizedPnl = totalValue - totalCost;

  return {
    activePositions: active.length,
    // Fix 5: Use isExposureStatus for pending positions count
    pendingPositions: openPositions.filter(p =>
      p.status === 'PENDING_FILL' || p.status === 'SUBMITTED' ||
      p.status === 'LIVE' ||
      p.status === 'EXIT_SUBMITTED' || p.status === 'EXIT_LIVE' ||
      p.status === 'EXIT_PARTIALLY_FILLED'
    ).length,
    totalValue,
    totalCost,
    unrealizedPnl,
    realizedPnlToday: dailyStats.pnl,
    totalEquity: equity.totalEquity,
    tradesToday: dailyStats.trades,
    orderAttemptsToday: dailyStats.orderAttempts || 0,
    winsToday: dailyStats.wins,
    lossesToday: dailyStats.losses,
    winRate: dailyStats.trades > 0 ? dailyStats.wins / dailyStats.trades : 0,
    paused,
    pauseReason,
    cooldownRemaining: Math.max(0, cooldownUntil - Date.now()),
  };
}
