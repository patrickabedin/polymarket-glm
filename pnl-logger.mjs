// ═══════════════════════════════════════════════════════════════════════════════
//  PNL LOGGER — Trade-level and daily summary logging for performance analysis
//  Logs every trade entry/exit to JSONL files and generates daily rollups.
// ═══════════════════════════════════════════════════════════════════════════════

import { CONFIG } from './config.mjs';
import fs from 'fs';
import path from 'path';

// ── File paths ─────────────────────────────────────────────────────────────────
const TRADE_LOG = path.resolve(CONFIG.state.dir, 'pnl_log.jsonl');
const DAILY_LOG = path.resolve(CONFIG.state.dir, 'pnl_daily.jsonl');

// ── Ensure data directory exists ───────────────────────────────────────────────
function ensureDataDir() {
  const dir = path.resolve(CONFIG.state.dir);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ── Append a JSON line to a file ───────────────────────────────────────────────
function appendJsonl(filePath, obj) {
  ensureDataDir();
  fs.appendFileSync(filePath, JSON.stringify(obj) + '\n');
}

// ── Read all trades from pnl_log.jsonl ─────────────────────────────────────────
function readAllTrades() {
  if (!fs.existsSync(TRADE_LOG)) return [];
  const lines = fs.readFileSync(TRADE_LOG, 'utf8').trim().split('\n').filter(Boolean);
  return lines.map(line => {
    try { return JSON.parse(line); }
    catch { return null; }
  }).filter(Boolean);
}

// ── Log a new trade entry ──────────────────────────────────────────────────────
// Call this from clob-executor.mjs when a trade is executed.
export function logTrade(trade) {
  const entry = {
    tradeId: trade.orderId || trade.tradeId || `trade_${Date.now()}`,
    timestamp: new Date().toISOString(),
    market: trade.market || '',
    conditionId: trade.conditionId || '',
    side: trade.side || 'BUY',
    entryPrice: trade.price || trade.entryPrice || 0,
    size: trade.size || 0,
    costUsd: trade.valueUsd || trade.costUsd || 0,
    whale: trade.whaleUsername || trade.whale || '',
    whaleAddress: trade.whaleAddress || '',
    whaleEntryPrice: trade.whaleEntryPrice || 0,
    signalType: trade.signalType || 'WHALE_ENTRY',
    source: trade.source || 'LIVE',
    consensusWhales: trade.consensusWhales || 1,
    status: 'OPEN',
    exitPrice: null,
    exitReason: null,
    exitTimestamp: null,
    pnlUsd: null,
    pnlPct: null,
    holdTimeMin: null,
  };

  appendJsonl(TRADE_LOG, entry);
  console.log(`📝 PnL Logger: logged trade ${entry.tradeId} (${entry.market})`);
  return entry;
}

// ── Log a status transition (Fix 3 — reconciliation) ──────────────────────────
export function logStatusTransition(tradeId, fromStatus, toStatus, market) {
  const record = {
    type: 'STATUS_TRANSITION',
    tradeId,
    market: market || '',
    fromStatus,
    toStatus,
    timestamp: new Date().toISOString(),
  };
  appendJsonl(TRADE_LOG, record);
  console.log(`📝 PnL Logger: ${tradeId} ${fromStatus} → ${toStatus}`);
  return record;
}

// ── Log a trade exit (update existing trade) ──────────────────────────────────
// Call this from clob-executor.mjs / risk-manager.mjs when a position is exited.
// Since JSONL is append-only, we write an "exit" record that references the trade.
export function logExit(tradeId, exitDetails) {
  // Read existing trades to find the entry for enrichment
  const trades = readAllTrades();
  const entry = trades.find(t => t.tradeId === tradeId && t.status === 'OPEN');

  const exitRecord = {
    type: 'EXIT',
    tradeId,
    exitTimestamp: new Date().toISOString(),
    exitPrice: exitDetails.price || 0,
    exitReason: exitDetails.reason || 'UNKNOWN',
    exitSize: exitDetails.size || 0,
  };

  // Compute PnL if we have entry data
  if (entry) {
    const entryCost = entry.costUsd || (entry.entryPrice * entry.size);
    const exitValue = exitDetails.price * (exitDetails.size || entry.size);
    const sizeRatio = entry.size > 0 ? ((exitDetails.size || entry.size) / entry.size) : 1;
    const pnlUsd = exitValue - (entryCost * sizeRatio);
    const pnlPct = entryCost > 0 ? (pnlUsd / (entryCost * sizeRatio)) * 100 : 0;

    const entryTime = new Date(entry.timestamp).getTime();
    const exitTime = new Date(exitRecord.exitTimestamp).getTime();
    const holdTimeMin = Math.round((exitTime - entryTime) / 60000);

    exitRecord.pnlUsd = pnlUsd;
    exitRecord.pnlPct = pnlPct;
    exitRecord.holdTimeMin = holdTimeMin;
    exitRecord.market = entry.market;
  }

  appendJsonl(TRADE_LOG, exitRecord);
  console.log(`📝 PnL Logger: logged exit for ${tradeId} (PnL: $${exitRecord.pnlUsd?.toFixed(2) || 'N/A'})`);
  return exitRecord;
}

// ── Generate daily summary (called at 08:00 UTC) ──────────────────────────────
export function generateDailySummary(targetDate = null) {
  // Default to yesterday's date (since this runs at 08:00 UTC for the previous day)
  const date = targetDate || new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  const trades = readAllTrades();

  // Build a map of trade entries with their exits
  const tradeMap = {};
  for (const t of trades) {
    if (t.type === 'EXIT') {
      if (tradeMap[t.tradeId]) {
        tradeMap[t.tradeId].exit = t;
      }
    } else {
      tradeMap[t.tradeId] = { entry: t, exit: null };
    }
  }

  // Filter to trades that have a date matching the target date
  // A trade belongs to a day if it was entered OR exited on that date
  const dayTrades = [];
  for (const { entry, exit } of Object.values(tradeMap)) {
    const entryDate = entry.timestamp?.slice(0, 10);
    const exitDate = exit?.exitTimestamp?.slice(0, 10);

    if (entryDate === date || exitDate === date) {
      // Merge entry + exit into a single record
      dayTrades.push({
        ...entry,
        status: exit ? 'CLOSED' : 'OPEN',
        exitPrice: exit?.exitPrice || null,
        exitReason: exit?.exitReason || null,
        exitTimestamp: exit?.exitTimestamp || null,
        pnlUsd: exit?.pnlUsd ?? null,
        pnlPct: exit?.pnlPct ?? null,
        holdTimeMin: exit?.holdTimeMin ?? null,
      });
    }
  }

  // Compute summary stats
  const closedTrades = dayTrades.filter(t => t.pnlUsd !== null);
  const wins = closedTrades.filter(t => t.pnlUsd > 0);
  const losses = closedTrades.filter(t => t.pnlUsd <= 0);
  const totalPnl = closedTrades.reduce((s, t) => s + t.pnlUsd, 0);
  const totalVolume = dayTrades.reduce((s, t) => s + (t.costUsd || 0), 0);
  const avgHoldTime = closedTrades.length > 0
    ? Math.round(closedTrades.reduce((s, t) => s + (t.holdTimeMin || 0), 0) / closedTrades.length)
    : 0;

  // Best and worst trades
  let bestTrade = null;
  let worstTrade = null;
  for (const t of closedTrades) {
    if (!bestTrade || t.pnlUsd > bestTrade.pnl) {
      bestTrade = { market: t.market, pnl: t.pnlUsd, tradeId: t.tradeId };
    }
    if (!worstTrade || t.pnlUsd < worstTrade.pnl) {
      worstTrade = { market: t.market, pnl: t.pnlUsd, tradeId: t.tradeId };
    }
  }

  const summary = {
    date,
    trades: dayTrades.length,
    closedTrades: closedTrades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: closedTrades.length > 0 ? wins.length / closedTrades.length : 0,
    totalPnl: Math.round(totalPnl * 100) / 100,
    totalVolume: Math.round(totalVolume * 100) / 100,
    avgHoldTimeMin: avgHoldTime,
    bestTrade: bestTrade || { market: 'N/A', pnl: 0 },
    worstTrade: worstTrade || { market: 'N/A', pnl: 0 },
    generatedAt: new Date().toISOString(),
  };

  appendJsonl(DAILY_LOG, summary);
  console.log(`📊 PnL Logger: daily summary for ${date} — ${summary.trades} trades, PnL $${summary.totalPnl}`);
  return summary;
}

// ── Get recent trade log entries (for dashboard/reporting) ─────────────────────
export function getRecentTrades(limit = 50) {
  const trades = readAllTrades();
  return trades.slice(-limit);
}

// ── Get daily summaries ────────────────────────────────────────────────────────
export function getDailySummaries(limit = 30) {
  if (!fs.existsSync(DAILY_LOG)) return [];
  const lines = fs.readFileSync(DAILY_LOG, 'utf8').trim().split('\n').filter(Boolean);
  return lines.slice(-limit).map(line => {
    try { return JSON.parse(line); }
    catch { return null; }
  }).filter(Boolean);
}

// Allow running standalone
if (process.argv[1]?.endsWith('pnl-logger.mjs')) {
  console.log('📊 PnL Logger — standalone test');
  ensureDataDir();

  // Log a test trade
  const testTrade = logTrade({
    orderId: 'test_001',
    market: 'Test Market',
    conditionId: '0xtest',
    side: 'BUY',
    price: 0.36,
    size: 10,
    valueUsd: 3.60,
    whaleUsername: 'TestWhale',
    signalType: 'CONSENSUS',
    source: 'LIVE',
  });

  // Log a test exit
  logExit('test_001', { price: 0.85, size: 10, reason: 'TP1 at 0.850' });

  // Generate daily summary
  const summary = generateDailySummary();
  console.log('Daily summary:', summary);

  process.exit(0);
}
