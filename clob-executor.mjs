// ═══════════════════════════════════════════════════════════════════════════════
//  LAYER 3: CLOB EXECUTOR — Auto-place orders via Polymarket CLOB API
//  Handles L1/L2 auth, order signing, position management, and exits
// ═══════════════════════════════════════════════════════════════════════════════

import { CONFIG } from './config.mjs';
import { CLOB, Gamma, retry, rateLimited } from './polymarket-api.mjs';
import { checkRisk, registerTrade, registerExit, getOpenPositions, updatePositionPrice } from './risk-manager.mjs';
import { sendTelegram } from './telegram-bot.mjs';
import { logTrade, logExit } from './pnl-logger.mjs';
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
  const ourPrice = Math.min(0.99, whaleEntryPrice + CONFIG.execution.slippageBuffer);

  // Get token ID
  const tokenId = market.asset; // The outcome token the whale bought
  if (!tokenId) {
    console.warn('⚠️  No token ID in signal — cannot execute');
    return null;
  }

  // Calculate size in tokens
  const sizeInTokens = Math.ceil(positionSizeUsd / ourPrice);

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

  try {
    // Place the order
    const order = await placeOrder(tokenId, 'BUY', ourPrice, sizeInTokens, marketData);

    // Register the trade
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

// ── Exit management: check open positions and apply exit logic ─────────────────
export async function manageExits() {
  const positions = getOpenPositions();
  if (positions.length === 0) return;

  const { exitLogic } = CONFIG.execution;
  const now = Date.now();

  for (const pos of positions) {
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

      // Fill timeout
      if (pos.status === 'PENDING_FILL') {
        const elapsed = (now - pos.timestamp) / 60000;
        if (elapsed > CONFIG.execution.fillTimeoutMin) {
          // Cancel unfilled order
          await cancelOrder(pos.orderId).catch(() => {});
          pos.status = 'CANCELLED';
          console.log(`⏰ Cancelled unfilled order ${pos.orderId} (${elapsed.toFixed(1)}min)`);
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
