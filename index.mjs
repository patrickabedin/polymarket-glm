// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//  POLYMARKET WHALE COPY TRADER — Main Entry Point
//  Orchestrates all layers: Discovery → Profiling → Monitor → Execute → Risk → Alerts
//  Enhanced with: pUSD Flow Tracking, Wallet Profiling, Scoring V2,
//                 PnL Logging, Multi-Source Discovery + Confluence
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

import 'dotenv/config';
import { CONFIG } from './config.mjs';
import { discoverWhales } from './whale-discovery.mjs';
import { startMonitoring } from './signal-monitor.mjs';
import { manageExits, startReconciliation } from './clob-executor.mjs';
import { getPortfolioStatus, getDailyStats } from './risk-manager.mjs';
import { sendTelegram, sendDailySummary } from './telegram-bot.mjs';
import { startPusdTracking } from './moralis-pusd-tracker.mjs';
import { profileWallets } from './moralis-wallet-profiler.mjs';
import { discoverWhalesMultiSource } from './whale-sources-v2.mjs';
import { generateDailySummary as generatePnlDailySummary } from './pnl-logger.mjs';
import fs from 'fs';
import path from 'path';

const startTime = Date.now();

function banner() {
  console.log(`
 ═══════════════════════════════════════════════════════════════════════
  🐋 POLYMARKET WHALE COPY TRADER (Enhanced)
  ───────────────────────────────────────────────────────────────────────
  Layer 1: Whale Discovery   — Leaderboard + Multi-Source + Confluence
  Layer 2: Signal Monitoring — Real-time WS + polling + pUSD flow tracking
  Layer 3: Auto Execution    — CLOB API order placement + PnL logging
  Layer 4: Risk Management   — Position sizing + circuit breakers
  Layer 5: Telegram Alerts   — Signals + trades + daily summary
  ───────────────────────────────────────────────────────────────────────
  Enhancements:
    • pUSD Flow Tracking (Moralis) — pre-signal deposit alerts
    • Wallet Profiling (Moralis)   — human vs bot classification
    • Whale Scoring V2             — 10-dimension enhanced scoring
    • PnL Logger                   — trade-level + daily JSONL logs
    • Multi-Source Discovery       — leaderboard + holders + onchain + social
 ═══════════════════════════════════════════════════════════════════════
  Mode: ${CONFIG.execution.enabled ? '🟢 AUTO-TRADE' : '🟡 ALERT-ONLY'}
  Poll: ${CONFIG.monitoring.pollIntervalSec}s | Consensus: ${CONFIG.monitoring.consensusMinWhales}+ whales
  Max/Trade: $${CONFIG.risk.maxPositionSizeUsd} | Max Daily: ${CONFIG.risk.maxDailyTrades} trades
  Multi-Source: ${CONFIG.multiSource.enabled ? '✅ ON' : '❌ OFF'}
  pUSD Tracking: ${CONFIG.moralis.pusdTracking.enabled ? '✅ ON' : '❌ OFF'}
  Wallet Profiling: ${CONFIG.moralis.walletProfiling.enabled ? '✅ ON' : '❌ OFF'}
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

  let whales;

  if (CONFIG.multiSource.enabled) {
    // Use multi-source discovery with confluence scoring
    console.log('  Using multi-source discovery (leaderboard + holders + onchain + social)');
    const multiSourceWhales = await discoverWhalesMultiSource();

    // Still run the standard discovery pipeline for stats/scoring
    // (multi-source finds wallets, standard pipeline analyzes them)
    whales = await discoverWhales();

    // Merge in multi-source data: add confluence score and sources to each whale
    const multiSourceMap = {};
    for (const w of multiSourceWhales) {
      multiSourceMap[w.address.toLowerCase()] = w;
    }
    for (const whale of whales) {
      const ms = multiSourceMap[whale.address.toLowerCase()];
      if (ms) {
        whale.confluenceScore = ms.confluenceScore;
        whale.sources = ms.sources;
        whale.sourceCount = ms.sourceCount;
      } else {
        whale.confluenceScore = 1.0;
        whale.sources = ['leaderboard'];
        whale.sourceCount = 1;
      }
    }

    // Also add any multi-source-only whales (not on leaderboard) that have high confluence
    for (const ms of multiSourceWhales) {
      const alreadyTracked = whales.find(w => w.address.toLowerCase() === ms.address.toLowerCase());
      if (!alreadyTracked && ms.sourceCount >= 2) {
        // This is a hidden whale found via multiple sources but not on the leaderboard
        // We'd need to analyze them to get full stats, but for now add them with basic info
        console.log(`  📌 Hidden whale from multi-source: ${ms.username} (sources: ${ms.sources.join(', ')})`);
        // Hidden whales are noted but not fully tracked until they pass quality filters
        // A full implementation would run analyzeWallet() on them here
      }
    }
  } else {
    whales = await discoverWhales();
  }

  if (whales.length < CONFIG.discovery.minTrackedWallets) {
    console.warn(`⚠️  Only ${whales.length} whales found (need ≥${CONFIG.discovery.minTrackedWallets})`);
    console.warn('   Continuing with available wallets...');
  }

  // ── Phase 1b: Profile wallets (Moralis) ────────────────────────────────────
  if (CONFIG.moralis.walletProfiling.enabled && CONFIG.moralis.apiKey) {
    console.log('\n🔬 Phase 1b: Wallet Profiling\n');
    try {
      whales = await profileWallets(whales);
    } catch (err) {
      console.warn(`⚠️  Wallet profiling failed: ${err.message}`);
    }
  } else {
    console.log('\n🔬 Wallet profiling skipped (Moralis API key not set or disabled)');
  }

  // ── Startup Telegram notification ───────────────────────────────────────────
  const topWhalesDisplay = whales.slice(0, 5).map((w, i) => {
    const profile = w.profile ? ` [${w.profile.classification}]` : '';
    const confluence = w.confluenceScore ? ` (confluence: ${w.confluenceScore}×)` : '';
    return `  ${i + 1}. ${w.username} — WR ${(w.stats.winRate * 100).toFixed(0)}%, $${w.stats.totalPnl.toFixed(0)} PnL${profile}${confluence}`;
  }).join('\n');

  await sendTelegram([
    '🐋 *Polymarket Whale Copier Started* (Enhanced)',
    '',
    `*Tracked Whales:* ${whales.length}`,
    `*Mode:* ${CONFIG.execution.enabled ? '🟢 AUTO-TRADE' : '🟡 ALERT-ONLY'}`,
    `*Max Position:* $${CONFIG.risk.maxPositionSizeUsd}`,
    `*Consensus:* ${CONFIG.monitoring.consensusMinWhales}+ whales`,
    `*Multi-Source:* ${CONFIG.multiSource.enabled ? '✅' : '❌'}`,
    `*pUSD Tracking:* ${CONFIG.moralis.pusdTracking.enabled ? '✅' : '❌'}`,
    `*Wallet Profiling:* ${CONFIG.moralis.walletProfiling.enabled ? '✅' : '❌'}`,
    '',
    'Top 5:',
    topWhalesDisplay,
  ].join('\n'));

  // ── Phase 2: Start pUSD flow tracking (pre-signal) ──────────────────────────
  if (CONFIG.moralis.pusdTracking.enabled) {
    console.log('\n💵 Phase 2a: Starting pUSD Flow Tracker\n');
    try {
      startPusdTracking(whales);
    } catch (err) {
      console.warn(`⚠️  pUSD tracking failed to start: ${err.message}`);
    }
  }

  // ── Phase 3: Start monitoring (async, runs forever) ─────────────────────────
  console.log('\n📡 Phase 3: Starting signal monitor\n');

  // Start exit management loop (every 30s)
  setInterval(async () => {
    try {
      await manageExits();
    } catch (err) {
      console.warn(`⚠️  Exit management error: ${err.message}`);
    }
  }, 30000);

  // Start order reconciliation loop (every 15s) — Fix 3
  startReconciliation();

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

        // Also generate PnL logger daily summary
        if (CONFIG.pnlLogger.enabled) {
          const pnlSummary = generatePnlDailySummary();
          console.log(`📊 PnL daily summary generated: ${pnlSummary.trades} trades, $${pnlSummary.totalPnl} PnL`);
        }
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
