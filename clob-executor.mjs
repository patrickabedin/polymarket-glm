// ═══════════════════════════════════════════════════════════════════════════════
//  LAYER 3: CLOB EXECUTOR — Auto-place orders via Polymarket CLOB API
//  Handles L1/L2 auth, order signing, position management, and exits
// ═══════════════════════════════════════════════════════════════════════════════

import { CONFIG } from './config.mjs';
import { CLOB, Gamma, retry, rateLimited } from './polymarket-api.mjs';
import { checkRisk, registerTrade, registerExit, getOpenPositions, updatePositionPrice, updatePositionStatus } from './risk-manager.mjs';
import { sendTelegram } from './telegram-bot.mjs';
import { logTrade, logExit, logStatusTransition } from './pnl-logger.mjs';
import fs from 'fs';
import path from 'path';

// ── CLOB Auth Setup ────────────────────────────────────────────────────────────
// Uses viem for wallet signing (same as Polymarket SDK pattern)
let walletClient = null;
let clobClient = null;
let apiCreds = null;

async function initClobClient() {
  if (clobClient) return clobClient;
  if (!CONFIG.execution.privateKey) {
    throw new Error('No private key configured for CLOB execution');
  }

  // Dynamic import of viem (installed on droplet)
  const { createWalletClient, http } = await import('viem');
  const { privateKeyToAccount } = await import('viem/accounts');
  const { polygon } = await import('viem/chains');

  const account = privateKeyToAccount(CONFIG.execution.privateKey);
  walletClient = createWalletClient({
    account,
    chain: polygon,
    transport: http(),
  });

  // Try to import the official SDK, fall back to raw API calls
  try {
    const { ClobClient, SignatureTypeV2 } = await import('@polymarket/clob-client-v2');
    const sigType = CONFIG.execution.signatureType === 3 ? SignatureTypeV2.POLY_1271
      : CONFIG.execution.signatureType === 2 ? SignatureTypeV2.POLY_GNOSIS_SAFE
      : CONFIG.execution.signatureType === 1 ? SignatureTypeV2.POLY_PROXY
      : SignatureTypeV2.EOA;

    const tempClient = new ClobClient({
      host: CONFIG.api.clob,
      chain: CONFIG.api.chainId,
      signer: walletClient,
      signatureType: sigType,
      funderAddress: CONFIG.execution.funderAddress || account.address,
    });
    apiCreds = await tempClient.createOrDeriveApiKey();

    clobClient = new ClobClient({
      host: CONFIG.api.clob,
      chain: CONFIG.api.chainId,
      signer: walletClient,
      creds: apiCreds,
      signatureType: sigType,
      funderAddress: CONFIG.execution.funderAddress || account.address,
    });
    console.log('✅ CLOB client initialized with official SDK (sigType:', sigType + ')');
  } catch (sdkErr) {
    console.warn('⚠️  Polymarket SDK not available, using raw API mode');
    console.warn(`   ${sdkErr.message}`);
    clobClient = { rawMode: true, walletClient, account };
  }

  return clobClient;
}

// ── Place an order ─────────────────────────────────────────────────────────────
async function placeOrder(tokenId, side, price, size, marketData) {
  const client = await initClobClient();

  // Clamp price to valid range
  const tickSize = marketData?.tickSize || '0.01';
  const tick = parseFloat(tickSize);
  price = Math.round(price / tick) * tick;
  price = Math.max(tick, Math.min(1 - tick, price));

  console.log(`📝 Placing ${side} order: ${size} @ ${price} (token: ${tokenId.slice(0, 12)}...)`);

  if (client.rawMode) {
    // Raw API mode — would need manual order signing
    // This requires EIP-712 typed data signing for Polymarket's order format
    throw new Error('Raw API order placement not implemented — install @polymarket/clob-client-v2');
  }

  const { Side, OrderType } = await import('@polymarket/clob-client-v2');

  const orderArgs = {
    tokenID: tokenId,
    price: parseFloat(price.toFixed(4)),
    size: Math.ceil(size),
    side: side === 'BUY' ? Side.BUY : Side.SELL,
  };

  const options = {
    tickSize: String(tickSize),
    negRisk: marketData?.negRisk || false,
    orderType: OrderType.GTC,
  };

  const response = await retry(() =>
    client.createAndPostOrder(orderArgs, options)
  );

  console.log(`✅ Order placed: ID=${response.orderID}, status=${response.status}`);
  return response;
}

// ── Cancel an order ────────────────────────────────────────────────────────────
async function cancelOrder(orderId) {
  const client = await initClobClient();
  if (client.rawMode) throw new Error('Raw mode — cannot cancel');
  return retry(() => client.cancelOrder({ orderID: orderId }));
}

// ── Get open orders ────────────────────────────────────────────────────────────
async function getOpenOrders() {
  const client = await initClobClient();
  if (client.rawMode) return [];
  return retry(() => client.getOrders({ status: 'LIVE' }));
}

// ── Check entry quality against live orderbook (Fix 9) ─────────────────────────
async function checkEntryQuality(tokenId, whaleEntryPrice, marketData) {
  const checks = [];

  // 1. Get orderbook
  const book = await retry(() =>
    rateLimited(() => CLOB.getOrderBook(tokenId))
  );

  // 2. Spread check
  const bestBid = book.bids?.[0] ? parseFloat(book.bids[0].price) : 0;
  const bestAsk = book.asks?.[0] ? parseFloat(book.asks[0].price) : 1;
  const spread = bestAsk - bestBid;
  const spreadPct = spread / bestAsk;
  if (spreadPct > 0.03) {
    checks.push({ pass: false, reason: `Spread ${(spreadPct * 100).toFixed(1)}% > 3% max` });
  } else {
    checks.push({ pass: true });
  }

  // 3. Slippage check
  if (bestAsk > whaleEntryPrice + CONFIG.execution.slippageBuffer) {
    checks.push({ pass: false, reason: `Ask ${bestAsk.toFixed(3)} > whale entry ${whaleEntryPrice.toFixed(3)} + ${CONFIG.execution.slippageBuffer} slippage` });
  } else {
    checks.push({ pass: true });
  }

  // 4. Depth check — can we fill our size?
  const ourSize = CONFIG.risk.maxPositionSizeUsd / bestAsk;
  const askDepth = book.asks?.reduce((s, a) => s + parseFloat(a.size), 0) || 0;
  if (askDepth < ourSize) {
    checks.push({ pass: false, reason: `Ask depth ${askDepth.toFixed(0)} < our size ${ourSize.toFixed(0)}` });
  } else {
    checks.push({ pass: true });
  }

  // 5. Max entry price
  if (bestAsk > 0.85) {
    checks.push({ pass: false, reason: `Ask ${bestAsk.toFixed(3)} > 0.85 max entry price` });
  } else {
    checks.push({ pass: true });
  }

  const allPass = checks.every(c => c.pass);
  const failedChecks = checks.filter(c => !c.pass).map(c => c.reason);
  return { pass: allPass, bestAsk, bestBid, spread: spreadPct, failedChecks };
}

// ── Execute a signal: place a copy order ────────────────────────────────────────
export async function executeSignal(signal) {
  const { market, entry, consensus, whale } = signal;

  // Risk check
  const riskCheck = checkRisk(signal);
  if (!riskCheck.allowed) {
    console.log(`🚫 Risk gate blocked trade: ${riskCheck.reason}`);
    if (CONFIG.telegram.alertOnRiskBreach) {
      await sendTelegram(`🚫 *Trade blocked by risk gate:*\n\n${riskCheck.reason}\n\nMarket: ${market.title}`);
    }
    return null;
  }

  // Determine position size
  const whaleValue = consensus?.totalSizeUsd || entry.valueUsd;
  let positionSizeUsd = Math.min(
    whaleValue * CONFIG.execution.copyRatio,
    CONFIG.risk.maxPositionSizeUsd
  );

  // Determine entry price (whale's entry + slippage buffer)
  const whaleEntryPrice = consensus?.avgEntryPrice || entry.price;

  // Get token ID
  const tokenId = market.asset; // The outcome token the whale bought
  if (!tokenId) {
    console.warn('⚠️  No token ID in signal — cannot execute');
    return null;
  }

  // Get market data for tick size / neg risk
  let marketData = signal.marketData;
  if (!marketData) {
    const m = await retry(() => rateLimited(() => Gamma.getMarket(market.conditionId)));
    marketData = m ? {
      tickSize: m.minimumTickSize,
      negRisk: m.negRisk,
      clobTokenIds: m.clobTokenIds,
    } : null;
  }

  // Fix 9: Entry quality checks before placing the order
  const quality = await checkEntryQuality(tokenId, whaleEntryPrice, marketData);
  if (!quality.pass) {
    await sendTelegram(`🚫 Trade skipped — entry quality checks failed:\n${quality.failedChecks.join('\n')}\n\nMarket: ${market.title}`);
    console.log(`🚫 Entry quality checks failed for ${market.title}:\n${quality.failedChecks.join('\n')}`);
    return null;
  }

  // Use the best ask as our entry price for instant fill
  const ourPrice = quality.bestAsk;

  // Calculate size in tokens
  const sizeInTokens = Math.ceil(positionSizeUsd / ourPrice);

  try {
    // Place the order
    const order = await placeOrder(tokenId, 'BUY', ourPrice, sizeInTokens, marketData);

    // Register the trade with market metadata (Fix 6)
    const trade = {
      orderId: order.orderID,
      signalType: signal.type,
      market: market.title,
      conditionId: market.conditionId,
      tokenId,
      side: 'BUY',
      price: ourPrice,
      size: sizeInTokens,
      valueUsd: positionSizeUsd,
      whaleAddress: whale.address,
      whaleUsername: whale.username,
      consensusWhales: consensus?.whaleCount || 1,
      timestamp: Date.now(),
      status: 'PENDING_FILL',
      // Market metadata for category tracking (Fix 6)
      marketSlug: market.slug || '',
      eventSlug: market.eventSlug || '',
      category: market.eventSlug?.split('/')[0] || 'unknown',
      assetId: market.asset || '',
    };

    registerTrade(trade);

    // Log to PnL logger
    if (CONFIG.pnlLogger.enabled) {
      logTrade({
        ...trade,
        market: market.title,
        conditionId: market.conditionId,
        whaleEntryPrice: whaleEntryPrice,
      });
    }

    // Alert
    if (CONFIG.telegram.alertOnTrade) {
      const consensusNote = consensus
        ? `\n*Consensus:* ${consensus.whaleCount} whales`
        : `\n*Following:* ${whale.username}`;
      await sendTelegram([
        '🎯 *COPY TRADE EXECUTED*',
        '',
        `*Market:* ${market.title}`,
        `*Side:* ${market.outcome}`,
        `*Entry:* ${ourPrice.toFixed(3)}`,
        `*Size:* ${sizeInTokens} tokens ($${positionSizeUsd.toFixed(2)})`,
        consensusNote,
        `*Order ID:* ${order.orderID}`,
        '',
        '⏳ Awaiting fill...',
      ].join('\n'));
    }

    return trade;
  } catch (err) {
    console.error(`❌ Order failed: ${err.message}`);
    await sendTelegram(`❌ *Order Failed*\n\nMarket: ${market.title}\nError: ${err.message}`);
    return null;
  }
}

// ── Order Lifecycle Reconciliation (Fix 3) ─────────────────────────────────────
let reconciliationTimer = null;

export async function reconcileOrders() {
  const positions = getOpenPositions();
  const pendingOrders = positions.filter(p =>
    p.status === 'PENDING_FILL' || p.status === 'SUBMITTED'
  );

  if (pendingOrders.length === 0) return;

  let openOrders;
  try {
    openOrders = await getOpenOrders();
  } catch (err) {
    console.warn(`⚠️  Reconciliation: failed to fetch open orders: ${err.message}`);
    return;
  }

  const openOrderIds = new Set(openOrders.map(o => o.orderID || o.id));

  for (const pos of pendingOrders) {
    const isInOpenOrders = openOrderIds.has(pos.orderId);
    const previousStatus = pos.status;

    if (isInOpenOrders) {
      // Order is still live on the book
      if (pos.status !== 'LIVE' && pos.status !== 'SUBMITTED') {
        updatePositionStatus(pos.orderId, 'LIVE');
        if (CONFIG.pnlLogger.enabled) {
          logStatusTransition(pos.orderId, previousStatus, 'LIVE', pos.market);
        }
        console.log(`📋 Order ${pos.orderId} is LIVE on book (${pos.market})`);
      }
    } else {
      // Order is NOT in open orders — either filled or cancelled
      // Try to determine if it was cancelled
      let wasCancelled = false;
      try {
        const client = await initClobClient();
        if (!client.rawMode) {
          const orderDetail = await retry(() => client.getOrder(pos.orderId));
          if (orderDetail?.status === 'CANCELED' || orderDetail?.status === 'CANCELLED') {
            wasCancelled = true;
          }
        }
      } catch {
        // If we can't get order details, assume filled (not in open orders, no cancel confirmation)
      }

      if (wasCancelled) {
        updatePositionStatus(pos.orderId, 'CANCELLED');
        if (CONFIG.pnlLogger.enabled) {
          logStatusTransition(pos.orderId, previousStatus, 'CANCELLED', pos.market);
        }
        console.log(`❌ Order ${pos.orderId} CANCELLED (${pos.market})`);
      } else {
        // Order not in open orders and not cancelled → filled
        updatePositionStatus(pos.orderId, 'FILLED');
        if (CONFIG.pnlLogger.enabled) {
          logStatusTransition(pos.orderId, previousStatus, 'FILLED', pos.market);
        }
        console.log(`✅ Order ${pos.orderId} FILLED (${pos.market})`);
        await sendTelegram(`✅ *Order Filled*\n\nMarket: ${pos.market}\nOrder ID: ${pos.orderId}\nEntry: ${pos.entryPrice?.toFixed(3) || 'N/A'}`);
      }
    }
  }
}

// Start the reconciliation loop
export function startReconciliation() {
  if (reconciliationTimer) return;
  console.log('🔄 Starting order reconciliation loop (15s interval)');
  reconciliationTimer = setInterval(async () => {
    try {
      await reconcileOrders();
    } catch (err) {
      console.warn(`⚠️  Reconciliation error: ${err.message}`);
    }
  }, 15000);
}

// ── Exit management: check open positions and apply exit logic ─────────────────
export async function manageExits() {
  const positions = getOpenPositions();
  if (positions.length === 0) return;

  const { exitLogic } = CONFIG.execution;
  const now = Date.now();

  for (const pos of positions) {
    // Fix 4: Check pending fill timeout FIRST, before status filter
    if (pos.status === 'PENDING_FILL' || pos.status === 'SUBMITTED') {
      const elapsed = (now - pos.timestamp) / 60000;
      if (elapsed > CONFIG.execution.fillTimeoutMin) {
        await cancelOrder(pos.orderId).catch(() => {});
        updatePositionStatus(pos.orderId, 'CANCELLED');
        console.log(`⏰ Cancelled unfilled order ${pos.orderId} (${elapsed.toFixed(1)}min)`);
        await sendTelegram(`⏰ Order cancelled (unfilled for ${elapsed.toFixed(1)}min): ${pos.market}`);
        continue;
      }
      // Still pending — skip exit checks but DO count in risk exposure
      continue;
    }

    if (pos.status !== 'FILLED' && pos.status !== 'OPEN') continue;

    try {
      // Get current price
      const priceData = await retry(() =>
        rateLimited(() => CLOB.getPrice(pos.tokenId))
      );
      const currentPrice = parseFloat(priceData.price);
      const peakPrice = Math.max(pos.peakPrice || currentPrice, currentPrice);
      updatePositionPrice(pos.orderId, currentPrice, peakPrice);

      let shouldExit = false;
      let exitReason = '';

      // Take profit (scale out)
      if (!pos.tp1Hit && currentPrice >= exitLogic.takeProfitRatios[0]) {
        shouldExit = true;
        exitReason = `TP1 at ${currentPrice.toFixed(3)}`;
        pos.tp1Hit = true;
        // Scale out: sell half
        const exitSize = Math.floor(pos.size * exitLogic.scaleOutFraction);
        if (exitSize > 0) {
          await exitPosition(pos, exitSize, currentPrice, exitReason);
          // Keep remainder open for TP2
          pos.size -= exitSize;
        }
      }

      if (!pos.tp2Hit && currentPrice >= exitLogic.takeProfitRatios[1]) {
        shouldExit = true;
        exitReason = `TP2 at ${currentPrice.toFixed(3)}`;
        pos.tp2Hit = true;
        await exitPosition(pos, pos.size, currentPrice, exitReason);
        continue;
      }

      // Stop loss
      if (currentPrice <= exitLogic.stopLossPrice) {
        shouldExit = true;
        exitReason = `Stop loss at ${currentPrice.toFixed(3)}`;
        await exitPosition(pos, pos.size, currentPrice, exitReason);
        continue;
      }

      // Trailing stop
      if (exitLogic.trailingStopEnabled && peakPrice > pos.entryPrice) {
        const trailingStop = peakPrice * (1 - exitLogic.trailingStopPct);
        if (currentPrice <= trailingStop && currentPrice < peakPrice) {
          shouldExit = true;
          exitReason = `Trailing stop at ${currentPrice.toFixed(3)} (peak: ${peakPrice.toFixed(3)})`;
          await exitPosition(pos, pos.size, currentPrice, exitReason);
          continue;
        }
      }
    } catch (err) {
      console.warn(`⚠️  Exit check failed for ${pos.market}: ${err.message}`);
    }
  }
}

// ── Exit a position ────────────────────────────────────────────────────────────
async function exitPosition(pos, size, price, reason) {
  try {
    const order = await placeOrder(pos.tokenId, 'SELL', price, size, pos.marketData);
    registerExit(pos.orderId, { size, price, reason, sellOrderId: order.orderID });

    // Log exit to PnL logger
    if (CONFIG.pnlLogger.enabled) {
      logExit(pos.orderId, { size, price, reason, sellOrderId: order.orderID });
    }

    if (CONFIG.telegram.alertOnExit) {
      const pnl = (price - pos.entryPrice) * size;
      const pnlPct = ((price - pos.entryPrice) / pos.entryPrice * 100);
      await sendTelegram([
        '💰 *POSITION EXITED*',
        '',
        `*Market:* ${pos.market}`,
        `*Reason:* ${reason}`,
        `*Exit Price:* ${price.toFixed(3)}`,
        `*Size:* ${size} tokens`,
        `*PnL:* ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnlPct.toFixed(1)}%)`,
        `*Order ID:* ${order.orderID}`,
      ].join('\n'));
    }
  } catch (err) {
    console.error(`❌ Exit failed for ${pos.market}: ${err.message}`);
  }
}
