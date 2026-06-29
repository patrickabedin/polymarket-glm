// ═══════════════════════════════════════════════════════════════════════════════
//  LAYER 2: SIGNAL MONITOR
//  WebSocket-based real-time whale monitoring with polling fallback
// ═══════════════════════════════════════════════════════════════════════════════

import { CONFIG } from './config.mjs';
import { Data, Gamma, CLOB, retry, rateLimited } from './polymarket-api.mjs';
import { sendTelegram, sendTelegramHTML } from './telegram-bot.mjs';
import { executeSignal } from './clob-executor.mjs';
import fs from 'fs';
import path from 'path';
import { WebSocket } from 'ws';

// ── Fix 5: resolveTokenId helper — maps outcomeIndex to clobTokenIds from gamma market ──
function resolveTokenId(position, gammaMarket) {
  if (position.asset && position.asset.length > 10) {
    return position.asset;
  }
  if (gammaMarket && gammaMarket.clobTokenIds) {
    const tokenIds = typeof gammaMarket.clobTokenIds === 'string'
      ? JSON.parse(gammaMarket.clobTokenIds)
      : gammaMarket.clobTokenIds;
    if (Array.isArray(tokenIds) && tokenIds.length > 0) {
      const idx = position.outcomeIndex ?? 0;
      if (idx >= 0 && idx < tokenIds.length) {
        return tokenIds[idx];
      }
    }
  }
  return null;
}

// ── State ────────────────────────────────────────────────────────────────────
let knownPositions = {};
let consensusTracker = {};
let alwaysOnPollingTimer = null;

let ws = null;
let wsConnected = false;
let wsDisconnectTime = null;
let wsReconnectAttempts = 0;
let wsReconnectTimer = null;
let pollingFallbackActive = false;
let pollingFallbackTimer = null;
let trackedWhales = [];
let heartbeatTimer = null;

const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const WS_RECONNECT_BASE_MS = 1000;
const WS_RECONNECT_MAX_MS = 30000;
const POLLING_FALLBACK_DELAY_MS = 60000;

function loadState() {
  const stateFile = path.resolve(CONFIG.state.dir, 'monitor_state.json');
  if (fs.existsSync(stateFile)) {
    const data = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    knownPositions = data.knownPositions || {};
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

function isMarketNearResolution(position) {
  if (!CONFIG.monitoring.filterMarketsNearResolution) return false;
  if (!position.endDate) return false;
  const endDate = new Date(position.endDate);
  const hoursUntil = (endDate - Date.now()) / 3600000;
  return hoursUntil < CONFIG.monitoring.filterResolutionBufferHours;
}

async function detectCryptoCandleBot(conditionId) {
  if (!CONFIG.monitoring.filterCryptoCandleBots) return false;
  try {
    const trades = await retry(() =>
      rateLimited(() => Data.getTrades({ market: conditionId, limit: 50 }))
    );
    if (trades.length < 10) return false;
    const now = Date.now();
    const recentTrades = trades.filter(t => (now - t.timestamp * 1000) < 60000);
    return recentTrades.length > CONFIG.monitoring.filterCryptoCandleVolThreshold;
  } catch {
    return false;
  }
}

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
    let tokenId = null;
    if (pos.asset && pos.asset.length > 10) {
      tokenId = pos.asset;
    } else {
      const market = await retry(() => rateLimited(() => Gamma.getMarket(conditionId))).catch(() => null);
      tokenId = resolveTokenId(pos, market);
    }
    if (!tokenId) {
      console.warn(`⚠️  checkWhalePositions: cannot resolve tokenId for ${pos.title} — skipping`);
      continue;
    }
    const posKey = `${conditionId}:${tokenId}`;
    const isNew = !knownPositions[address].has(posKey);

    if (isNew) {
      knownPositions[address].add(posKey);
      const signal = await processNewPosition(whale, pos, conditionId, source);
      if (signal) {
        newSignals.push(signal);
      }
    }
  }

  return newSignals;
}

async function processNewPosition(whale, pos, conditionId, source) {
  const { address, username } = whale;

  const positionSize = pos.size * pos.avgPrice;
  if (positionSize < CONFIG.monitoring.minPositionSizeUsd) return null;

  const stakePct = pos.initialValue / (whale.stats?.portfolioValue || pos.initialValue);
  if (stakePct < CONFIG.monitoring.minWhaleStakePct) return null;

  if (isMarketNearResolution(pos)) return null;

  const isBot = await detectCryptoCandleBot(conditionId);
  if (isBot) {
    console.log(`🤖 Skipping ${pos.title} — detected crypto candle bot pattern`);
    return null;
  }

  const market = await retry(() =>
    rateLimited(() => Gamma.getMarket(conditionId))
  ).catch(() => null);
  if (market && market.liquidityNum < CONFIG.monitoring.minMarketLiquidity) {
    console.log(`💧 Skipping ${pos.title} — liquidity $${market.liquidityNum} < $${CONFIG.monitoring.minMarketLiquidity}`);
    return null;
  }

  const resolvedTokenId = resolveTokenId(pos, market);
  if (!resolvedTokenId) {
    console.warn(`⚠️  Cannot resolve tokenId for ${pos.title} — skipping`);
    await sendTelegram(`⚠️ *Cannot resolve tokenId*\n\nMarket: ${pos.title}\noutcomeIndex: ${pos.outcomeIndex}\nasset: ${pos.asset || 'missing'}\n\nTrade skipped — clobTokenIds not available.`);
    return null;
  }

  const signal = {
    type: 'WHALE_ENTRY',
    source,
    whale: { address, username },
    market: {
      conditionId,
      title: pos.title,
      slug: pos.slug,
      eventSlug: pos.eventSlug,
      outcome: pos.outcome,
      outcomeIndex: pos.outcomeIndex,
      asset: resolvedTokenId,
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
      tickSize: market.orderPriceMinTickSize || market.minimumTickSize || '0.01',
      negRisk: market.negRisk,
      clobTokenIds: market.clobTokenIds,
    } : null,
  };

  // Tier/consensus
  const tier = whale.tier || 'tierB';
  const weight = tier === 'tierAPlus' ? CONFIG.consensus.eliteSharpWeight
    : tier === 'tierA' ? CONFIG.consensus.whaleWeight
    : tier === 'tierB' ? CONFIG.consensus.sharpWeight
    : 0.5;

  const tokenId = resolvedTokenId;
  const consensusKey = `${conditionId}:${tokenId}`;
  if (!consensusTracker[consensusKey]) {
    consensusTracker[consensusKey] = [];
  }
  consensusTracker[consensusKey].push({
    wallet: address,
    username,
    side: pos.outcome,
    outcomeIndex: pos.outcomeIndex,
    time: Date.now(),
    size: positionSize,
    entryPrice: pos.avgPrice,
    tier,
    weight,
  });

  const consensus = checkWeightedConsensus(consensusKey);
  let shouldExecute = false;

  if (consensus) {
    signal.type = 'CONSENSUS';
    signal.consensus = consensus;
    await sendTelegramHTML(formatConsensusAlert(signal));
    shouldExecute = CONFIG.execution.tradeConsensus;
  } else if (tier === 'tierAPlus' && CONFIG.traderTiers.tierAPlus.autoTradeStandalone) {
    signal.type = 'ELITE_SHARP';
    signal.eliteSharp = { tier: 'A+', trader: username };
    await sendTelegramHTML(formatEliteSharpAlert(signal));
    shouldExecute = CONFIG.execution.tradeEliteSharp;
  } else {
    await sendTelegramHTML(formatWhaleAlert(signal));
    shouldExecute = CONFIG.execution.tradeSingleWhale;
  }

  // Execute trade if enabled
  if (shouldExecute && CONFIG.execution.enabled) {
    try {
      console.log(`📤 Executing ${signal.type} signal for ${pos.title}...`);
      await executeSignal(signal);
    } catch (err) {
      console.error(`❌ Execute signal failed: ${err.message}`);
      await sendTelegram(`❌ *Trade execution failed*\n\nMarket: ${pos.title}\nError: ${err.message}`);
    }
  }

  saveState();
  return signal;
}

function checkWeightedConsensus(consensusKey) {
  const entries = consensusTracker[consensusKey] || [];
  const windowMs = CONFIG.consensus.windowMin * 60 * 1000;
  const now = Date.now();
  const recent = entries.filter(e => (now - e.time) < windowMs);

  const bySide = {};
  for (const e of recent) {
    const key = CONFIG.consensus.sameOutcomeOnly ? e.side : 'ANY';
    if (!bySide[key]) bySide[key] = [];
    bySide[key].push(e);
  }

  for (const [side, traders] of Object.entries(bySide)) {
    const uniqueWallets = [...new Set(traders.map(w => w.wallet))];
    const weightedScore = traders.reduce((s, w) => s + (w.weight || 1), 0);

    if (weightedScore >= CONFIG.consensus.minWeightedScore && uniqueWallets.length >= CONFIG.consensus.minUniqueTraders) {
      return {
        side,
        whaleCount: uniqueWallets.length,
        weightedScore: Math.round(weightedScore * 100) / 100,
        whales: traders,
        totalSizeUsd: traders.reduce((s, w) => s + w.size, 0),
        avgEntryPrice: traders.reduce((s, w) => s + w.entryPrice, 0) / traders.length,
      };
    }
  }

  return null;
}

// ── Alert formatters ───────────────────────────────────────────────────────────

function formatWhaleAlert(signal) {
  const m = signal.market;
  const e = signal.entry;
  const w = signal.whale;
  const url = `https://polymarket.com/event/${m.eventSlug || m.slug || ''}`;
  return [
    '🐋 <b>Whale Entry Detected</b>',
    '',
    `📊 <b>Market:</b> ${m.title}`,
    `🎯 <b>Outcome:</b> ${m.outcome}`,
    `💰 <b>Entry Price:</b> $${e.price.toFixed(3)}`,
    `💵 <b>Position Size:</b> $${e.valueUsd.toFixed(0)}`,
    `🐋 <b>Trader:</b> ${w.username}`,
    `📡 <b>Source:</b> ${signal.source}`,
    '',
    `🔗 <a href="${url}">View on Polymarket</a>`,
  ].join('\n');
}

function formatConsensusAlert(signal) {
  const m = signal.market;
  const c = signal.consensus;
  const url = `https://polymarket.com/event/${m.eventSlug || m.slug || ''}`;
  const whaleList = c.whales.slice(0, 5).map(w =>
    `   • ${w.username} — $${w.size.toFixed(0)} @ $${w.entryPrice.toFixed(3)} (${w.tier})`
  ).join('\n');
  return [
    '🎯 <b>CONSENSUS Signal — Multiple Whales Aligned</b>',
    '',
    `📊 <b>Market:</b> ${m.title}`,
    `🎯 <b>Side:</b> ${c.side}`,
    `🐋 <b>Whales:</b> ${c.whaleCount} (weighted score: ${c.weightedScore})`,
    `💵 <b>Total Size:</b> $${c.totalSizeUsd.toFixed(0)}`,
    `💰 <b>Avg Entry:</b> $${c.avgEntryPrice.toFixed(3)}`,
    '',
    '<b>Traders:</b>',
    whaleList,
    '',
    `🔗 <a href="${url}">View on Polymarket</a>`,
  ].join('\n');
}

function formatEliteSharpAlert(signal) {
  const m = signal.market;
  const e = signal.entry;
  const w = signal.whale;
  const url = `https://polymarket.com/event/${m.eventSlug || m.slug || ''}`;
  return [
    '⭐ <b>ELITE SHARP (A+) Entry</b>',
    '',
    `📊 <b>Market:</b> ${m.title}`,
    `🎯 <b>Outcome:</b> ${m.outcome}`,
    `💰 <b>Entry Price:</b> $${e.price.toFixed(3)}`,
    `💵 <b>Position Size:</b> $${e.valueUsd.toFixed(0)}`,
    `🐋 <b>Elite Trader:</b> ${w.username}`,
    `📡 <b>Source:</b> ${signal.source}`,
    '',
    `🔗 <a href="${url}">View on Polymarket</a>`,
  ].join('\n');
}

// ── WebSocket connection ──────────────────────────────────────────────────────

function connectWebSocket(whales) {
  trackedWhales = whales;

  console.log(`🔌 Connecting to Polymarket WebSocket (${WS_URL})...`);

  ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    wsConnected = true;
    wsDisconnectTime = null;
    wsReconnectAttempts = 0;
    console.log('✅ WebSocket connected');

    // Subscribe to all tracked whale activity
    // The Polymarket WS subscribes to market channels; we subscribe to
    // tokens that our tracked whales have positions in
    const subscribeMsg = {
      type: 'market',
      assets_ids: getSubscribedTokens(whales),
    };
    ws.send(JSON.stringify(subscribeMsg));
    console.log(`📡 Subscribed to ${subscribeMsg.assets_ids.length} token IDs`);

    // Heartbeat
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, 30000);
  });

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      // WebSocket messages are price-change events, not position changes.
      // The actual whale position detection is done via polling.
      // WS is used for real-time price awareness on subscribed tokens.
      if (msg.type === 'book' || msg.type === 'price_change' || msg.type === 'tick_size_change') {
        // Price update — could be used for real-time PnL tracking
        // For now, just log occasionally
        if (Math.random() < 0.01) {
          console.log(`📊 WS price update on token ${msg.asset_id?.slice(0, 8)}...`);
        }
      }
    } catch (err) {
      // Non-JSON or parse error — ignore
    }
  });

  ws.on('close', () => {
    wsConnected = false;
    wsDisconnectTime = Date.now();
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    console.warn('⚠️  WebSocket disconnected — starting polling fallback');

    // Start polling fallback after delay
    if (!pollingFallbackTimer) {
      pollingFallbackTimer = setTimeout(() => {
        if (!wsConnected) {
          pollingFallbackActive = true;
          startPollingFallback(whales);
        }
      }, POLLING_FALLBACK_DELAY_MS);
    }

    // Reconnect with backoff
    scheduleReconnect(whales);
  });

  ws.on('error', (err) => {
    console.warn(`⚠️  WebSocket error: ${err.message}`);
  });
}

function scheduleReconnect(whales) {
  if (wsReconnectTimer) return;
  wsReconnectAttempts++;
  const delay = Math.min(
    WS_RECONNECT_BASE_MS * Math.pow(2, wsReconnectAttempts - 1),
    WS_RECONNECT_MAX_MS
  );
  console.log(`🔄 Reconnecting WebSocket in ${Math.round(delay / 1000)}s (attempt ${wsReconnectAttempts})...`);
  wsReconnectTimer = setTimeout(() => {
    wsReconnectTimer = null;
    connectWebSocket(whales);
  }, delay);
}

function getSubscribedTokens(whales) {
  // Collect all known token IDs from whale positions
  const tokens = new Set();
  for (const whale of whales) {
    // If whale has cached positions with token IDs, include them
    if (whale.knownTokens) {
      for (const t of whale.knownTokens) tokens.add(t);
    }
  }
  // If we have tracked positions in knownPositions, include those tokens
  for (const wallet of Object.keys(knownPositions)) {
    for (const posKey of knownPositions[wallet]) {
      const tokenId = posKey.split(':')[1];
      if (tokenId) tokens.add(tokenId);
    }
  }
  return [...tokens];
}

// ── Polling (always-on, parallel with WS) ────────────────────────────────────

function startAlwaysOnPolling(whales) {
  const intervalMs = CONFIG.monitoring.alwaysOnPollIntervalSec * 1000;
  console.log(`🔄 Starting always-on polling every ${CONFIG.monitoring.alwaysOnPollIntervalSec}s (${whales.length} whales)`);

  // Initial poll immediately
  pollAllWhales(whales);

  if (alwaysOnPollingTimer) clearInterval(alwaysOnPollingTimer);
  alwaysOnPollingTimer = setInterval(() => {
    pollAllWhales(whales);
  }, intervalMs);
}

function startPollingFallback(whales) {
  console.log(`🔄 Starting polling fallback (every ${CONFIG.monitoring.pollIntervalSec}s)`);
  const intervalMs = CONFIG.monitoring.pollIntervalSec * 1000;

  pollAllWhales(whales);

  if (pollingFallbackTimer) clearInterval(pollingFallbackTimer);
  pollingFallbackTimer = setInterval(() => {
    pollAllWhales(whales);
  }, intervalMs);
}

async function pollAllWhales(whales) {
  let totalNew = 0;
  for (const whale of whales) {
    try {
      const signals = await checkWhalePositions(whale, 'POLL');
      totalNew += signals.length;
    } catch (err) {
      console.warn(`⚠️  Poll error for ${whale.username}: ${err.message}`);
    }
    // Small delay between whales to avoid rate limits
    await new Promise(r => setTimeout(r, 500));
  }
  if (totalNew > 0) {
    console.log(`📊 Poll complete: ${totalNew} new signal(s) detected`);
    saveState();
  }
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function startMonitoring(whales) {
  console.log(`\n📡 Signal Monitor starting with ${whales.length} whales`);

  // Load persisted state
  loadState();
  console.log(`📁 Loaded state: ${Object.keys(knownPositions).length} tracked wallets`);

  // Start always-on polling (runs in parallel with WS for redundancy)
  startAlwaysOnPolling(whales);

  // Connect WebSocket
  connectWebSocket(whales);

  // Initial state snapshot
  console.log(`📊 Initial state: ${whales.length} whales, ${getSubscribedTokens(whales).length} tracked tokens`);
  console.log(`🔄 Polling every ${CONFIG.monitoring.alwaysOnPollIntervalSec}s (always-on)`);
  console.log(`⚡ WS: ${wsConnected ? 'connected' : 'connecting...'}\n`);

  // Save state periodically
  setInterval(() => {
    saveState();
  }, 60000); // every 1min

  // Keep the process alive (this function blocks forever)
  return new Promise(() => {});
}
