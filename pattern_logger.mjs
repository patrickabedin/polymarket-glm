// ═══════════════════════════════════════════════════════════════════════════════
//  PATTERN LOGGER — Captures every trade with full context for later optimization
//
//  Logs to data/patterns.jsonl with:
//    - Whale stats (win rate, tier, category specialization)
//    - Market context (category, liquidity, volume, spread, time to resolution)
//    - Entry conditions (signal type, price vs whale, move since whale entry)
//    - Market state (RSI, momentum, price level)
//    - Outcome (exit reason, PnL, hold time, peak price, trough price)
//
//  Run analysis: python3 pattern_analyzer.py
// ═══════════════════════════════════════════════════════════════════════════════

import fs from 'fs';
import path from 'path';
import { CONFIG } from './config.mjs';

const PATTERN_LOG = path.resolve(CONFIG.state.dir, 'patterns.jsonl');

function ensureDir() {
  const dir = path.resolve(CONFIG.state.dir);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function append(obj) {
  ensureDir();
  fs.appendFileSync(PATTERN_LOG, JSON.stringify(obj) + '\n');
}

// ── Log entry pattern (called when a trade is placed) ─────────────────────────
export function logEntryPattern(trade, context = {}) {
  const pattern = {
    type: 'ENTRY',
    tradeId: trade.orderId || trade.tradeId,
    timestamp: new Date().toISOString(),

    // Market context
    market: trade.market || context.market?.title || '',
    conditionId: trade.conditionId || context.market?.conditionId || '',
    category: context.market?.eventSlug?.split('/')[0] || trade.category || 'unknown',
    eventSlug: context.market?.eventSlug || '',
    marketLiquidity: context.marketData?.liquidity || 0,
    marketVolume: context.marketData?.volume || 0,
    tickSize: context.marketData?.tickSize || 0,
    negRisk: context.marketData?.negRisk || false,

    // Entry details
    entryPrice: trade.price || trade.entryPrice || 0,
    size: trade.size || 0,
    costUsd: trade.valueUsd || trade.costUsd || 0,
    side: trade.side || 'BUY',

    // Whale context
    whaleAddress: trade.whaleAddress || '',
    whaleUsername: trade.whaleUsername || trade.whale || '',
    whaleTier: context.whale?.tier || '',
    whaleEntryPrice: trade.whaleEntryPrice || 0,
    whaleWinRate: context.whaleStats?.winRate || 0,
    whaleResolvedCount: context.whaleStats?.resolvedCount || 0,
    whaleAvgEntryPrice: context.whaleStats?.avgEntryPrice || 0,
    whaleProfitFactor: context.whaleStats?.profitFactor || 0,
    whaleCategories: context.whaleStats?.categories || [],
    whalePortfolioValue: context.whaleStats?.portfolioValue || 0,

    // Signal context
    signalType: trade.signalType || 'WHALE_ENTRY',
    consensusWhales: trade.consensusWhales || 1,
    source: trade.source || 'LIVE',

    // Price action at entry
    priceVsWhaleEntry: trade.whaleEntryPrice ? ((trade.price || 0) - trade.whaleEntryPrice) / trade.whaleEntryPrice : 0,
    spreadPct: context.marketData?.spreadPct || 0,
    bidDepth: context.marketData?.bidDepth || 0,
    askDepth: context.marketData?.askDepth || 0,

    // Timing
    hourOfDayUTC: new Date().getUTCHours(),
    dayOfWeek: new Date().toISOString().slice(0, 10),

    // Market timing (if available from Gamma)
    daysToResolution: context.market?.endDate ? Math.ceil((new Date(context.market.endDate) - Date.now()) / 86400000) : null,

    // Position sizing
    copyRatio: CONFIG.execution.copyRatio,
    maxPositionSize: CONFIG.risk.maxPositionSizeUsd,
    riskPctOfBankroll: (trade.valueUsd || 0) / (CONFIG.risk.initialBankroll || 100),

    // Exit config at time of entry (for A/B comparison)
    exitConfig: {
      tp1Pct: CONFIG.execution.exitLogic?.takeProfitPcts?.[0] || 0.15,
      tp2Pct: CONFIG.execution.exitLogic?.takeProfitPcts?.[1] || 0.30,
      stopLossPct: CONFIG.execution.exitLogic?.stopLossPct || 0.20,
      trailingStopPct: CONFIG.execution.exitLogic?.trailingStopPct || 0.05,
      whaleExitEnabled: CONFIG.execution.exitLogic?.whaleExitEnabled ?? true,
    },
  };

  append(pattern);
  return pattern;
}

// ── Log exit pattern (called when a position is closed) ───────────────────────
export function logExitPattern(tradeId, exitDetails, entryContext = {}) {
  const pattern = {
    type: 'EXIT',
    tradeId,
    timestamp: new Date().toISOString(),

    // Exit details
    exitPrice: exitDetails.price || 0,
    exitReason: exitDetails.reason || 'UNKNOWN',
    exitSize: exitDetails.size || 0,
    pnlUsd: exitDetails.pnlUsd || 0,
    pnlPct: exitDetails.pnlPct || 0,
    holdTimeMin: exitDetails.holdTimeMin || 0,

    // Price action during hold
    peakPrice: exitDetails.peakPrice || entryContext.peakPrice || 0,
    troughPrice: exitDetails.troughPrice || entryContext.troughPrice || 0,
    maxGainPct: entryContext.entryPrice && exitDetails.peakPrice
      ? (exitDetails.peakPrice - entryContext.entryPrice) / entryContext.entryPrice : 0,
    maxLossPct: entryContext.entryPrice && exitDetails.troughPrice
      ? (entryContext.entryPrice - exitDetails.troughPrice) / entryContext.entryPrice : 0,

    // Did whale exit before us?
    whaleExited: exitDetails.whaleExited || false,
    whaleExitPrice: exitDetails.whaleExitPrice || null,

    // Market context at exit
    marketLiquidityAtExit: exitDetails.liquidityAtExit || 0,

    // Entry context (for joining)
    entryPrice: entryContext.entryPrice || 0,
    whaleUsername: entryContext.whaleUsername || '',
    whaleTier: entryContext.whaleTier || '',
    signalType: entryContext.signalType || '',
    category: entryContext.category || '',

    // Outcome classification
    outcome: exitDetails.pnlUsd > 0.01 ? 'WIN' : exitDetails.pnlUsd < -0.01 ? 'LOSS' : 'BREAKEVEN',

    // Would hold-to-resolution have been better?
    // (filled at exit time by pattern_analyzer.py since we don't know resolution here)
  };

  append(pattern);
  return pattern;
}

// ── Log skipped/blocked trade (for evaluating missed opportunities) ───────────
export function logSkippedPattern(market, whale, reason, context = {}) {
  const pattern = {
    type: 'SKIPPED',
    timestamp: new Date().toISOString(),
    market: market?.title || '',
    conditionId: market?.conditionId || '',
    category: market?.eventSlug?.split('/')[0] || 'unknown',
    whaleUsername: whale?.username || '',
    whaleTier: whale?.tier || '',
    whaleEntryPrice: context.whaleEntryPrice || 0,
    currentPrice: context.currentPrice || 0,
    skipReason: reason,
    signalType: context.signalType || '',
    hourOfDayUTC: new Date().getUTCHours(),
  };

  append(pattern);
  return pattern;
}
