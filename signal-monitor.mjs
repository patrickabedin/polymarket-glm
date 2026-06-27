// ═══════════════════════════════════════════════════════════════════════════════
//  LAYER 2: SIGNAL MONITOR
//  Polls tracked whale wallets for new positions → detects consensus → emits signals
// ═══════════════════════════════════════════════════════════════════════════════

import { CONFIG } from './config.mjs';
import { Data, Gamma, CLOB, retry, rateLimited } from './polymarket-api.mjs';
import { sendTelegram } from './telegram-bot.mjs';
import fs from 'fs';
import path from 'path';

// ── State: track known positions per whale to detect NEW entries ────────────────
let knownPositions = {}; // { [wallet]: Set(conditionId) }
let consensusTracker = {}; // { [conditionId]: [{ wallet, side, time, size }] }

function loadState() {
  const stateFile = path.resolve(CONFIG.state.dir, 'monitor_state.json');
  if (fs.existsSync(stateFile)) {
    const data = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    knownPositions = data.knownPositions || {};
    // Convert arrays back to Sets
    for (const k of Object.keys(knownPositions)) {
      knownPositions[k] = new Set(knownPositions[k]);
    }
    consensusTracker = data.consensusTracker || {};
  }
}

function saveState() {
  const stateFile = path.resolve(CONFIG.state.dir, 'monitor_state.json');
  const data = {
    knownPositions: {},
    consensusTracker,
    savedAt: new Date().toISOString(),
  };
  for (const k of Object.keys(knownPositions)) {
    data.knownPositions[k] = [...knownPositions[k]];
  }
  fs.writeFileSync(stateFile, JSON.stringify(data, null, 2));
}

// ── Check if market is too close to resolution ─────────────────────────────────
function isMarketNearResolution(position) {
  if (!CONFIG.monitoring.filterMarketsNearResolution) return false;
  if (!position.endDate) return false;
  const endDate = new Date(position.endDate);
  const hoursUntil = (endDate - Date.now()) / 3600000;
  return hoursUntil < CONFIG.monitoring.filterResolutionBufferHours;
}

// ── Detect crypto candle bots (high-frequency, latency-edge) ───────────────────
async function detectCryptoCandleBot(conditionId) {
  if (!CONFIG.monitoring.filterCryptoCandleBots) return false;
  try {
    const trades = await retry(() =>
      rateLimited(() => Data.getTrades({ market: conditionId, limit: 50 }))
    );
    if (trades.length < 10) return false;

    // Check if trade frequency is abnormally high (many trades in 1 minute)
    const now = Date.now();
    const recentTrades = trades.filter(t => (now - t.timestamp * 1000) < 60000);
    return recentTrades.length > CONFIG.monitoring.filterCryptoCandleVolThreshold;
  } catch {
    return false;
  }
}

// ── Fetch current positions for a whale and detect new ones ────────────────────
async function checkWhalePositions(whale) {
  const { address, username } = whale;
  if (!knownPositions[address]) knownPositions[address] = new Set();

  let positions;
  try {
    positions = await retry(() =>
      rateLimited(() =>
        Data.getPositions(address, {
          sizeThreshold: CONFIG.monitoring.minPositionSizeUsd,
          limit: 500,
          redeemable: false,
        })
      )
    );
  } catch (err) {
    console.warn(`⚠️  Failed to fetch positions for ${username}: ${err.message}`);
    return [];
  }

  const newSignals = [];

  for (const pos of positions) {
    const conditionId = pos.conditionId;
    const isNew = !knownPositions[address].has(conditionId);

    if (isNew) {
      knownPositions[address].add(conditionId);

      // Filter: position size
      const positionSize = pos.size * pos.avgPrice;
      if (positionSize < CONFIG.monitoring.minPositionSizeUsd) continue;

      // Filter: whale stake percentage
      const stakePct = pos.initialValue / (whale.stats?.portfolioValue || pos.initialValue);
      if (stakePct < CONFIG.monitoring.minWhaleStakePct) continue;

      // Filter: near resolution
      if (isMarketNearResolution(pos)) continue;

      // Filter: crypto candle bots
      const isBot = await detectCryptoCandleBot(conditionId);
      if (isBot) {
        console.log(`🤖 Skipping ${pos.title} — detected crypto candle bot pattern`);
        continue;
      }

      // Filter: market liquidity
      const market = await retry(() =>
        rateLimited(() => Gamma.getMarket(conditionId))
      ).catch(() => null);
      if (market && market.liquidityNum < CONFIG.monitoring.minMarketLiquidity) {
        console.log(`💧 Skipping ${pos.title} — liquidity $${market.liquidityNum} < $${CONFIG.monitoring.minMarketLiquidity}`);
        continue;
      }

      const signal = {
        type: 'WHALE_ENTRY',
        whale: { address, username },
        market: {
          conditionId,
          title: pos.title,
          slug: pos.slug,
          eventSlug: pos.eventSlug,
          outcome: pos.outcome,
          outcomeIndex: pos.outcomeIndex,
          asset: pos.asset,
          oppositeAsset: pos.oppositeAsset,
        },
        entry: {
          price: pos.avgPrice,
          size: pos.size,
          valueUsd: positionSize,
          stakePct,
        },
        currentPrice: pos.curPrice,
        timestamp: Date.now(),
        marketData: market ? {
          liquidity: market.liquidityNum,
          volume: market.volumeNum,
          tickSize: market.minimumTickSize,
          negRisk: market.negRisk,
          clobTokenIds: market.clobTokenIds,
        } : null,
      };

      newSignals.push(signal);

      // Add to consensus tracker
      if (!consensusTracker[conditionId]) {
        consensusTracker[conditionId] = [];
      }
      consensusTracker[conditionId].push({
        wallet: address,
        username,
        side: pos.outcome,
        outcomeIndex: pos.outcomeIndex,
        time: Date.now(),
        size: positionSize,
        entryPrice: pos.avgPrice,
      });

      // Check for consensus
      const consensus = checkConsensus(conditionId);
      if (consensus) {
        signal.type = 'CONSENSUS';
        signal.consensus = consensus;
        await sendTelegram(formatConsensusAlert(signal));
      } else {
        await sendTelegram(formatWhaleAlert(signal));
      }
    }
  }

  return newSignals;
}

// ── Check if a market has consensus (3+ whales same side within window) ────────
function checkConsensus(conditionId) {
  const entries = consensusTracker[conditionId] || [];
  const windowMs = CONFIG.monitoring.consensusWindowMin * 60 * 1000;
  const now = Date.now();

  // Filter to entries within the consensus window
  const recent = entries.filter(e => (now - e.time) < windowMs);

  // Group by side (outcome)
  const bySide = {};
  for (const e of recent) {
    const key = e.side;
    if (!bySide[key]) bySide[key] = [];
    bySide[key].push(e);
  }

  // Check if any side has ≥ consensusMinWhales
  for (const [side, wallets] of Object.entries(bySide)) {
    const uniqueWallets = [...new Set(wallets.map(w => w.wallet))];
    if (uniqueWallets.length >= CONFIG.monitoring.consensusMinWhales) {
      return {
        side,
        whaleCount: uniqueWallets.length,
        whales: wallets,
        totalSizeUsd: wallets.reduce((s, w) => s + w.size, 0),
        avgEntryPrice: wallets.reduce((s, w) => s + w.entryPrice, 0) / wallets.length,
      };
    }
  }

  return null;
}

// ── Alert formatters ───────────────────────────────────────────────────────────
function formatWhaleAlert(signal) {
  const { whale, market, entry } = signal;
  return [
    '🐋 *WHALE ENTRY DETECTED*',
    '',
    `*Trader:* ${whale.username}`,
    `*Market:* ${market.title}`,
    `*Side:* ${market.outcome}`,
    `*Entry:* $${entry.price.toFixed(3)} (${entry.valueUsd.toFixed(0)} USD)`,
    `*Stake:* ${(entry.stakePct * 100).toFixed(1)}% of portfolio`,
    `*Current Price:* ${signal.currentPrice?.toFixed(3) || 'N/A'}`,
    '',
    `[View Market](https://polymarket.com/event/${market.eventSlug})`,
  ].join('\n');
}

function formatConsensusAlert(signal) {
  const { market, consensus } = signal;
  const whaleList = consensus.whales
    .map(w => `  • ${w.username} — $${w.size.toFixed(0)} @ ${w.entryPrice.toFixed(3)}`)
    .join('\n');
  return [
    '🔥 *CONSENSUS SIGNAL — STRONG*',
    '',
    `*Market:* ${market.title}`,
    `*Side:* ${consensus.side}`,
    `*Whales:* ${consensus.whaleCount} agree`,
    `*Total Stake:* $${consensus.totalSizeUsd.toFixed(0)}`,
    `*Avg Entry:* ${consensus.avgEntryPrice.toFixed(3)}`,
    '',
    '*Whales entering:*',
    whaleList,
    '',
    `[View Market](https://polymarket.com/event/${market.eventSlug})`,
  ].join('\n');
}

// ── Main monitoring loop ────────────────────────────────────────────────────────
export async function startMonitoring(whales) {
  console.log(' ═══════════════════════════════════════════════════════');
  console.log(` 📡 SIGNAL MONITOR — Tracking ${whales.length} whales`);
  console.log(` ⏱️  Poll interval: ${CONFIG.monitoring.pollIntervalSec}s`);
  console.log(' ═══════════════════════════════════════════════════════');

  loadState();

  // Initial snapshot of all positions (so we don't alert on existing positions)
  console.log('📸 Taking initial position snapshot...');
  for (const whale of whales) {
    try {
      const positions = await retry(() =>
        rateLimited(() =>
          Data.getPositions(whale.address, {
            sizeThreshold: CONFIG.monitoring.minPositionSizeUsd,
            limit: 500,
            redeemable: false,
          })
        )
      );
      if (!knownPositions[whale.address]) knownPositions[whale.address] = new Set();
      for (const p of positions) {
        knownPositions[whale.address].add(p.conditionId);
      }
      console.log(`  ${whale.username}: ${positions.length} known positions`);
    } catch (err) {
      console.warn(`  ⚠️  ${whale.username}: ${err.message}`);
    }
  }
  saveState();
  console.log('✅ Initial snapshot complete. Now monitoring for new entries.\n');

  // Polling loop
  while (true) {
    const cycleStart = Date.now();

    for (const whale of whales) {
      try {
        const signals = await checkWhalePositions(whale);
        if (signals.length > 0) {
          // Emit signals to execution layer
          for (const signal of signals) {
            console.log(`📡 Signal: ${signal.type} — ${whale.username} → ${signal.market.title}`);
            // Write to log
            const logLine = JSON.stringify({
              ...signal,
              loggedAt: new Date().toISOString(),
            });
            fs.appendFileSync(
              path.resolve(CONFIG.state.logFile),
              logLine + '\n'
            );

            // Emit to execution layer (imported dynamically to avoid circular deps)
            const { executeSignal } = await import('./clob-executor.mjs');
            if (CONFIG.execution.enabled && (signal.type === 'CONSENSUS' || signal.type === 'WHALE_ENTRY')) {
              await executeSignal(signal).catch(err =>
                console.error(`❌ Execution error: ${err.message}`)
              );
            }
          }
        }
      } catch (err) {
        console.warn(`⚠️  Error checking ${whale.username}: ${err.message}`);
      }
    }

    saveState();

    const elapsed = Date.now() - cycleStart;
    const waitMs = Math.max(0, CONFIG.monitoring.pollIntervalSec * 1000 - elapsed);
    if (waitMs > 0) {
      await new Promise(r => setTimeout(r, waitMs));
    }
  }
}

// Clean old consensus entries periodically
setInterval(() => {
  const windowMs = CONFIG.monitoring.consensusWindowMin * 60 * 1000 * 4; // keep 4x window
  const now = Date.now();
  for (const cid of Object.keys(consensusTracker)) {
    consensusTracker[cid] = consensusTracker[cid].filter(e => (now - e.time) < windowMs);
    if (consensusTracker[cid].length === 0) delete consensusTracker[cid];
  }
}, 60000); // every minute
