// ═══════════════════════════════════════════════════════════════════════════════
//  LAYER 2: SIGNAL MONITOR
//  WebSocket-based real-time whale monitoring with polling fallback
// ═══════════════════════════════════════════════════════════════════════════════

import { CONFIG } from './config.mjs';
import { Data, Gamma, CLOB, retry, rateLimited } from './polymarket-api.mjs';
import { sendTelegram } from './telegram-bot.mjs';
import fs from 'fs';
import path from 'path';
import { WebSocket } from 'ws';

// ── State: track known positions per whale to detect NEW entries ────────────────
let knownPositions = {}; // { [wallet]: Set(conditionId) }
let consensusTracker = {}; // { [conditionId]: [{ wallet, side, time, size }] }

// ── WebSocket state ────────────────────────────────────────────────────────────
let ws = null;
let wsConnected = false;
let wsDisconnectTime = null; // timestamp when WS went down; null if connected
let wsReconnectAttempts = 0;
let wsReconnectTimer = null;
let pollingFallbackActive = false;
let pollingFallbackTimer = null;
let trackedWhales = []; // reference for reconnects & fallback
let heartbeatTimer = null; // WS PING heartbeat timer

// ── WebSocket endpoint ─────────────────────────────────────────────────────────
const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const WS_RECONNECT_BASE_MS = 1000; // 1s initial backoff
const WS_RECONNECT_MAX_MS = 30000; // 30s max backoff
const POLLING_FALLBACK_DELAY_MS = 60000; // start fallback polling after 60s of WS downtime

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
async function checkWhalePositions(whale, source = 'POLL') {
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

      const signal = await processNewPosition(whale, pos, conditionId, source);
      if (signal) {
        newSignals.push(signal);
      }
    }
  }

  return newSignals;
}

// ── Process a newly detected position (shared by WS and polling paths) ─────────
async function processNewPosition(whale, pos, conditionId, source) {
  const { address, username } = whale;

  // Filter: position size
  const positionSize = pos.size * pos.avgPrice;
  if (positionSize < CONFIG.monitoring.minPositionSizeUsd) return null;

  // Filter: whale stake percentage
  const stakePct = pos.initialValue / (whale.stats?.portfolioValue || pos.initialValue);
  if (stakePct < CONFIG.monitoring.minWhaleStakePct) return null;

  // Filter: near resolution
  if (isMarketNearResolution(pos)) return null;

  // Filter: crypto candle bots
  const isBot = await detectCryptoCandleBot(conditionId);
  if (isBot) {
    console.log(`🤖 Skipping ${pos.title} — detected crypto candle bot pattern`);
    return null;
  }

  // Filter: market liquidity
  const market = await retry(() =>
    rateLimited(() => Gamma.getMarket(conditionId))
  ).catch(() => null);
  if (market && market.liquidityNum < CONFIG.monitoring.minMarketLiquidity) {
    console.log(`💧 Skipping ${pos.title} — liquidity $${market.liquidityNum} < $${CONFIG.monitoring.minMarketLiquidity}`);
    return null;
  }

  const signal = {
    type: 'WHALE_ENTRY',
    source, // 'LIVE' or 'POLL'
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

  return signal;
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
  const { whale, market, entry, source } = signal;
  const tag = source === 'LIVE' ? '⚡ LIVE' : '⏱️ POLL';
  return [
    `🐋 *WHALE ENTRY DETECTED* ${tag}`,
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
  const { market, consensus, source } = signal;
  const tag = source === 'LIVE' ? '⚡ LIVE' : '⏱️ POLL';
  const whaleList = consensus.whales
    .map(w => `  • ${w.username} — $${w.size.toFixed(0)} @ ${w.entryPrice.toFixed(3)}`)
    .join('\n');
  return [
    `🔥 *CONSENSUS SIGNAL — STRONG* ${tag}`,
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

// ═══════════════════════════════════════════════════════════════════════════════
//  WEBSOCKET CONNECTION MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

function connectWebSocket(whales) {
  console.log(`🔌 Connecting to Polymarket WebSocket: ${WS_URL}`);

  try {
    ws = new WebSocket(WS_URL);
  } catch (err) {
    console.error(`❌ WebSocket construction failed: ${err.message}`);
    scheduleReconnect(whales);
    return;
  }

  ws.onopen = async () => {
    console.log('✅ WebSocket connected — subscribing to whale wallets');
    wsConnected = true;
    wsDisconnectTime = null;
    wsReconnectAttempts = 0;

    // Start heartbeat — send PING every 10 seconds
    heartbeatTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send('PING');
      }
    }, 10000);

    // If polling fallback was active, stop it
    if (pollingFallbackActive) {
      console.log('🔁 WebSocket restored — stopping polling fallback');
      stopPollingFallback();
    }

    // Subscribe to market channel for all active markets
    // We'll get real-time trade events and cross-reference with whale addresses
    // First, fetch all active market token IDs
    console.log('  📡 Fetching active market token IDs...');
    let allTokenIds = [];
    try {
      const marketsResp = await fetch('https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=500&order=volume&ascending=false');
      const markets = await marketsResp.json();
      for (const m of markets) {
        if (m.clobTokenIds) {
          const tokenIds = typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : m.clobTokenIds;
          if (Array.isArray(tokenIds)) {
            allTokenIds.push(...tokenIds);
          }
        }
      }
      console.log(`  📡 ${allTokenIds.length} token IDs from ${markets.length} markets`);
    } catch (err) {
      console.warn(`  ⚠️  Failed to fetch market token IDs: ${err.message}`);
    }

    // Subscribe in batches (WS may have message size limits)
    const BATCH_SIZE = 100;
    for (let i = 0; i < allTokenIds.length; i += BATCH_SIZE) {
      const batch = allTokenIds.slice(i, i + BATCH_SIZE);
      const subMsg = JSON.stringify({
        assets_ids: batch,
        type: 'market',
      });
      try {
        ws.send(subMsg);
      } catch (err) {
        console.error(`  ❌ Failed to subscribe batch ${i}: ${err.message}`);
      }
    }
    console.log(`  📡 Subscribed to ${allTokenIds.length} token IDs in ${Math.ceil(allTokenIds.length / BATCH_SIZE)} batches`);
  };

  ws.onmessage = async (event) => {
    try {
      const msg = JSON.parse(event.data);

      // Polymarket WS may send arrays or single objects
      const messages = Array.isArray(msg) ? msg : [msg];

      for (const m of messages) {
        await handleWebSocketMessage(m, whales);
      }
    } catch (err) {
      // Non-JSON or keepalive messages are fine to ignore
    }
  };

  ws.onerror = (err) => {
    console.error(`❌ WebSocket error: ${err.message || err}`);
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  };

  ws.onclose = (event) => {
    console.log(`🔌 WebSocket disconnected (code: ${event.code}, reason: ${event.reason || 'N/A'})`);
    wsConnected = false;
    wsDisconnectTime = Date.now();

    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }

    // Schedule reconnection
    scheduleReconnect(whales);

    // Start polling fallback after delay if still disconnected
    schedulePollingFallback(whales);
  };
}

// ── Handle incoming WebSocket messages ─────────────────────────────────────────
async function handleWebSocketMessage(msg, whales) {
  // Process last_trade_price events (trade executions on the market channel)
  if (msg.event_type !== 'last_trade_price' && msg.event_type !== 'trade') return;

  // Market channel format: { event_type: 'last_trade_price', market, asset_id, price, side, size, timestamp, ... }
  // User channel format: { event_type: 'trade', trade: { ... } }
  const trade = msg.trade || msg;
  const conditionId = trade.market || trade.condition_id;
  const assetId = trade.asset_id || trade.assetId;
  const side = trade.side;
  const tradeSize = parseFloat(trade.size || 0);
  const tradePrice = parseFloat(trade.price || 0);

  if (!conditionId || !assetId) return;

  // Market channel doesn't include maker/taker addresses.
  // We need to check recent trades via Data API to see if a tracked whale was involved.
  // Use a quick lookup: fetch recent trades for this market and check for whale addresses.
  try {
    const recentTrades = await retry(() =>
      rateLimited(() => Data.getTrades({ market: conditionId, limit: 10 }))
    );

    // Check if any recent trade involves a tracked whale (as taker)
    for (const t of recentTrades) {
      const takerAddr = (t.takerAddress || t.taker_address || '').toLowerCase();
      const whale = whales.find(w => w.address.toLowerCase() === takerAddr);
      if (!whale) continue;

      // Only BUYs (new positions)
      if ((t.side || side) !== 'BUY') continue;

      // Check if this is a new market for this whale
      if (!knownPositions[whale.address]) knownPositions[whale.address] = new Set();
      const isNew = !knownPositions[whale.address].has(conditionId);
      if (!isNew) continue;

      // Mark as known immediately
      knownPositions[whale.address].add(conditionId);

      console.log(`⚡ LIVE trade detected: ${whale.username} BUY on ${conditionId.slice(0, 16)}...`);

      // Fetch full position details
      const positions = await retry(() =>
        rateLimited(() =>
          Data.getPositions(whale.address, {
            sizeThreshold: CONFIG.monitoring.minPositionSizeUsd,
            limit: 500,
            redeemable: false,
          })
        )
      );

      const pos = positions.find(p => p.conditionId === conditionId);
      if (!pos) {
        knownPositions[whale.address].delete(conditionId);
        continue;
      }

      const signal = await processNewPosition(whale, pos, conditionId, 'LIVE');
      if (signal) {
        await emitSignal(signal);
      }

      return; // processed this market, no need to check more trades
    }
  } catch (err) {
    // Non-critical — the polling fallback will catch it
  }
}

// ── Emit a signal to execution layer and log ───────────────────────────────────
async function emitSignal(signal) {
  console.log(`📡 Signal: ${signal.type} — ${signal.whale.username} → ${signal.market.title} [${signal.source}]`);

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

// ── Reconnection with exponential backoff ──────────────────────────────────────
function scheduleReconnect(whales) {
  if (wsReconnectTimer) return; // already scheduled

  wsReconnectAttempts++;
  const delay = Math.min(
    WS_RECONNECT_BASE_MS * Math.pow(2, wsReconnectAttempts - 1),
    WS_RECONNECT_MAX_MS
  );

  console.log(`🔄 Reconnecting WebSocket in ${(delay / 1000).toFixed(1)}s (attempt ${wsReconnectAttempts})...`);

  wsReconnectTimer = setTimeout(() => {
    wsReconnectTimer = null;
    connectWebSocket(whales);
  }, delay);
}

// ── Polling fallback: starts if WS has been down for >60s ──────────────────────
function schedulePollingFallback(whales) {
  if (pollingFallbackActive) return; // already running

  const checkDelay = POLLING_FALLBACK_DELAY_MS;

  setTimeout(() => {
    // Only start polling if WS is still down after the delay
    if (!wsConnected && !pollingFallbackActive) {
      console.log('⏱️  WebSocket down >60s — starting polling fallback');
      startPollingFallback(whales);
    }
  }, checkDelay);
}

function startPollingFallback(whales) {
  pollingFallbackActive = true;

  const pollOnce = async () => {
    if (!pollingFallbackActive) return;

    if (wsConnected) {
      stopPollingFallback();
      return;
    }

    console.log('⏱️  Running polling fallback cycle...');
    for (const whale of whales) {
      try {
        const signals = await checkWhalePositions(whale, 'POLL');
        for (const signal of signals) {
          await emitSignal(signal);
        }
      } catch (err) {
        console.warn(`⚠️  Fallback poll error for ${whale.username}: ${err.message}`);
      }
    }
    saveState();
  };

  // Run immediately
  pollOnce();

  // Then on interval
  pollingFallbackTimer = setInterval(pollOnce, CONFIG.monitoring.pollIntervalSec * 1000);
}

function stopPollingFallback() {
  pollingFallbackActive = false;
  if (pollingFallbackTimer) {
    clearInterval(pollingFallbackTimer);
    pollingFallbackTimer = null;
  }
}

// ── Main monitoring entry point ────────────────────────────────────────────────
export async function startMonitoring(whales) {
  console.log(' ═══════════════════════════════════════════════════════');
  console.log(` 📡 SIGNAL MONITOR — Tracking ${whales.length} whales`);
  console.log(` 🔌 Mode: WebSocket (real-time) with polling fallback`);
  console.log(` ⏱️  Fallback poll interval: ${CONFIG.monitoring.pollIntervalSec}s`);
  console.log(' ═══════════════════════════════════════════════════════');

  loadState();
  trackedWhales = whales;

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

  // Start WebSocket connection
  connectWebSocket(whales);

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down signal monitor...');
    if (ws) {
      try { ws.close(); } catch {}
    }
    stopPollingFallback();
    if (wsReconnectTimer) {
      clearTimeout(wsReconnectTimer);
    }
    saveState();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    if (ws) {
      try { ws.close(); } catch {}
    }
    stopPollingFallback();
    if (wsReconnectTimer) {
      clearTimeout(wsReconnectTimer);
    }
    saveState();
    process.exit(0);
  });
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
