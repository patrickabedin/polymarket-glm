// ═══════════════════════════════════════════════════════════════════════════════
//  POLYMARKET WHALE COPY TRADER — Main Entry Point
//  Orchestrates all 5 layers: Discovery → Monitor → Execute → Risk → Alerts
// ═══════════════════════════════════════════════════════════════════════════════

import { CONFIG } from './config.mjs';
import { discoverWhales } from './whale-discovery.mjs';
import { startMonitoring } from './signal-monitor.mjs';
import { manageExits } from './clob-executor.mjs';
import { getPortfolioStatus, getDailyStats } from './risk-manager.mjs';
import { sendTelegram, sendDailySummary } from './telegram-bot.mjs';
import fs from 'fs';
import path from 'path';

const startTime = Date.now();

function banner() {
  console.log(`
 ═══════════════════════════════════════════════════════════════════════
  🐋 POLYMARKET WHALE COPY TRADER
  ───────────────────────────────────────────────────────────────────────
  Layer 1: Whale Discovery   — Leaderboard scan + wallet scoring
  Layer 2: Signal Monitoring — Real-time position polling + consensus
  Layer 3: Auto Execution    — CLOB API order placement
  Layer 4: Risk Management   — Position sizing + circuit breakers
  Layer 5: Telegram Alerts   — Signals + trades + daily summary
 ═══════════════════════════════════════════════════════════════════════
  Mode: ${CONFIG.execution.enabled ? '🟢 AUTO-TRADE' : '🟡 ALERT-ONLY'}
  Poll: ${CONFIG.monitoring.pollIntervalSec}s | Consensus: ${CONFIG.monitoring.consensusMinWhales}+ whales
  Max/Trade: $${CONFIG.risk.maxPositionSizeUsd} | Max Daily: ${CONFIG.risk.maxDailyTrades} trades
 ═══════════════════════════════════════════════════════════════════════
`);
}

async function main() {
  banner();

  // Ensure state directory exists
  const stateDir = path.resolve(CONFIG.state.dir);
  if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });

  // ── Phase 1: Discover whales ────────────────────────────────────────────────
  console.log('\n🔍 Phase 1: Whale Discovery\n');
  const whales = await discoverWhales();

  if (whales.length < CONFIG.discovery.minTrackedWallets) {
    console.warn(`⚠️  Only ${whales.length} whales found (need ≥${CONFIG.discovery.minTrackedWallets})`);
    console.warn('   Continuing with available wallets...');
  }

  await sendTelegram([
    '🐋 *Polymarket Whale Copier Started*',
    '',
    `*Tracked Whales:* ${whales.length}`,
    `*Mode:* ${CONFIG.execution.enabled ? '🟢 AUTO-TRADE' : '🟡 ALERT-ONLY'}`,
    `*Max Position:* $${CONFIG.risk.maxPositionSizeUsd}`,
    `*Consensus:* ${CONFIG.monitoring.consensusMinWhales}+ whales`,
    '',
    'Top 5:',
    ...whales.slice(0, 5).map((w, i) =>
      `  ${i + 1}. ${w.username} — WR ${(w.stats.winRate * 100).toFixed(0)}%, $${w.stats.totalPnl.toFixed(0)} PnL`
    ),
  ].join('\n'));

  // ── Phase 2: Start monitoring (async, runs forever) ─────────────────────────
  console.log('\n📡 Phase 2: Starting signal monitor\n');

  // Start exit management loop (every 30s)
  setInterval(async () => {
    try {
      await manageExits();
    } catch (err) {
      console.warn(`⚠️  Exit management error: ${err.message}`);
    }
  }, 30000);

  // Daily summary cron (check every 5min if it's summary time)
  let lastSummaryDate = new Date().toISOString().slice(0, 10);
  setInterval(async () => {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const hourUtc = now.getUTCHours();

    if (today !== lastSummaryDate && hourUtc >= CONFIG.telegram.dailySummaryHour) {
      lastSummaryDate = today;
      try {
        const stats = getDailyStats();
        const portfolio = getPortfolioStatus();
        await sendDailySummary(stats, portfolio);
      } catch (err) {
        console.warn(`⚠️  Daily summary error: ${err.message}`);
      }
    }
  }, 300000); // 5 min

  // Start monitoring (blocks forever)
  await startMonitoring(whales);
}

// ── Graceful shutdown ──────────────────────────────────────────────────────────
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down...');
  const uptime = ((Date.now() - startTime) / 3600000).toFixed(2);
  await sendTelegram(`🛑 Whale Copier stopped (uptime: ${uptime}h)`).catch(() => {});
  process.exit(0);
});

process.on('uncaughtException', async (err) => {
  console.error('💥 Uncaught exception:', err);
  await sendTelegram(`💥 *Crash:* ${err.message}`).catch(() => {});
  // Don't exit — try to keep running
});

main().catch(err => {
  console.error('❌ Fatal:', err);
  process.exit(1);
});
