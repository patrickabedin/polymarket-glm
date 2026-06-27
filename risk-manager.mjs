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
      trades: 0, wins: 0, losses: 0, pnl: 0, volume: 0,
    };
    paused = false;
    pauseReason = '';
  }
}

// ── Check if a trade is allowed ────────────────────────────────────────────────
export function checkRisk(signal) {
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

  // Daily trade limit
  if (dailyStats.trades >= CONFIG.risk.maxDailyTrades) {
    return { allowed: false, reason: `Daily trade limit reached (${dailyStats.trades}/${CONFIG.risk.maxDailyTrades})` };
  }

  // Max concurrent positions
  const activeCount = openPositions.filter(p => p.status === 'FILLED' || p.status === 'OPEN').length;
  if (activeCount >= CONFIG.risk.maxConcurrentPositions) {
    return { allowed: false, reason: `Max concurrent positions (${activeCount}/${CONFIG.risk.maxConcurrentPositions})` };
  }

  // Per-category limit
  if (signal.market?.eventSlug) {
    const category = signal.market.eventSlug.split('/')[0] || 'unknown';
    const catCount = openPositions.filter(p =>
      (p.status === 'FILLED' || p.status === 'OPEN') &&
      (p.marketSlug?.split('/')[0] || 'unknown') === category
    ).length;
    if (catCount >= CONFIG.risk.maxConcurrentPerCategory) {
      return { allowed: false, reason: `Max positions in category "${category}" (${catCount}/${CONFIG.risk.maxConcurrentPerCategory})` };
    }
  }

  // Daily loss limit
  if (dailyStats.pnl <= -CONFIG.risk.dailyLossLimitUsd) {
    return { allowed: false, reason: `Daily loss limit hit ($${dailyStats.pnl.toFixed(2)} / -$${CONFIG.risk.dailyLossLimitUsd})` };
  }

  // Portfolio drawdown
  if (portfolioPeak > 0) {
    const currentValue = openPositions.reduce((s, p) => s + (p.currentValue || p.valueUsd || 0), 0);
    const drawdown = (portfolioPeak - currentValue) / portfolioPeak;
    if (drawdown > CONFIG.risk.maxPortfolioDrawdownPct) {
      paused = true;
      pauseReason = `Portfolio drawdown ${(drawdown * 100).toFixed(1)}% > ${(CONFIG.risk.maxPortfolioDrawdownPct * 100)}% limit`;
      saveState();
      return { allowed: false, reason: pauseReason };
    }
  }

  return { allowed: true };
}

// ── Register a new trade ───────────────────────────────────────────────────────
export function registerTrade(trade) {
  loadState();

  openPositions.push({
    ...trade,
    marketSlug: trade.signalType,
    entryPrice: trade.price,
    peakPrice: trade.price,
    currentValue: trade.valueUsd,
    status: trade.status,
    marketData: trade.marketData,
    tp1Hit: false,
    tp2Hit: false,
  });

  dailyStats.trades++;
  dailyStats.volume += trade.valueUsd;

  saveState();
}

// ── Update position price (for trailing stop) ──────────────────────────────────
export function updatePositionPrice(orderId, currentPrice, peakPrice) {
  loadState();

  const pos = openPositions.find(p => p.orderId === orderId);
  if (pos) {
    pos.currentPrice = currentPrice;
    pos.peakPrice = peakPrice;
    pos.currentValue = currentPrice * pos.size;
    if (pos.currentValue > portfolioPeak) {
      portfolioPeak = pos.currentValue;
    }
    saveState();
  }
}

// ── Register an exit ───────────────────────────────────────────────────────────
export function registerExit(orderId, exitDetails) {
  loadState();

  const pos = openPositions.find(p => p.orderId === orderId);
  if (!pos) return;

  const pnl = (exitDetails.price - pos.entryPrice) * exitDetails.size;
  dailyStats.pnl += pnl;

  if (pnl > 0) dailyStats.wins++;
  else dailyStats.losses++;

  // Update or remove position
  if (exitDetails.size >= pos.size) {
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
    // Partial exit
    pos.size -= exitDetails.size;
    pos.realizedPnl = (pos.realizedPnl || 0) + pnl;
  }

  saveState();
}

// ── Get open positions ─────────────────────────────────────────────────────────
export function getOpenPositions() {
  loadState();
  return openPositions.filter(p => p.status === 'FILLED' || p.status === 'OPEN' || p.status === 'PENDING_FILL');
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
  const active = openPositions.filter(p => p.status === 'FILLED' || p.status === 'OPEN');
  const totalValue = active.reduce((s, p) => s + (p.currentValue || p.valueUsd || 0), 0);
  const totalCost = active.reduce((s, p) => s + (p.valueUsd || 0), 0);
  const unrealizedPnl = totalValue - totalCost;

  return {
    activePositions: active.length,
    totalValue,
    totalCost,
    unrealizedPnl,
    realizedPnlToday: dailyStats.pnl,
    tradesToday: dailyStats.trades,
    winsToday: dailyStats.wins,
    lossesToday: dailyStats.losses,
    winRate: dailyStats.trades > 0 ? dailyStats.wins / dailyStats.trades : 0,
    paused,
    pauseReason,
    cooldownRemaining: Math.max(0, cooldownUntil - Date.now()),
  };
}
