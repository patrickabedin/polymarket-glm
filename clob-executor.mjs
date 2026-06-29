// ═══════════════════════════════════════════════════════════════════════════════
//  LAYER 3: CLOB EXECUTOR — Auto-place orders via Polymarket CLOB API
//  Handles L1/L2 auth, order signing, position management, and exits
// ═══════════════════════════════════════════════════════════════════════════════

import { CONFIG } from './config.mjs';
import { CLOB, Gamma, Data, retry, rateLimited } from './polymarket-api.mjs';
import { checkRisk, registerTrade, registerExit, setExitOrderMetadata, getOpenPositions, getAllStoredPositions, updatePositionPrice, updatePositionStatus, markTpHit, updatePositionFill, setPendingExitSize, incrementExitRetry, getExitRetries, isEventProcessed, markEventProcessed, makeEventHash } from './risk-manager.mjs';
import { sendTelegram, sendTelegramHTML } from './telegram-bot.mjs';
import { logTrade, logExit, logStatusTransition, logBlockedTrade, logSkippedTrade } from './pnl-logger.mjs';
import { WebSocket } from 'ws';
import fs from 'fs';
import path from 'path';

// ── Fix 10: Systematic resolvePosition helper ─────────────────────────────────
// Resolves a raw order ID (from WS events) to a stored position, handling both
// entry orders and exit (SELL) orders uniformly.
function resolvePosition(rawOrderId) {
  const all = getAllStoredPositions();
  let pos = all.find(p => p.orderId === rawOrderId);
  if (pos) return { pos, entryOrderId: pos.orderId, isExit: false };
  pos = all.find(p => p.exitSellOrderId === rawOrderId);
  if (pos) return { pos, entryOrderId: pos.orderId, isExit: true };
  return { pos: null, entryOrderId: rawOrderId, isExit: false };
}

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
    client.createAndPostOrder(orderArgs, options, OrderType.GTC)
  );

  // Check for error response (CLOB API returns { error, status: 400 } on failure)
  if (response && (response.error || response.status === 400 || !response.success)) {
    const errMsg = response.error || response.errorMsg || `status ${response.status}`;
    console.error(`❌ Order rejected: ${errMsg}`);
    throw new Error(`CLOB order rejected: ${errMsg}`);
  }

  if (!response || !response.orderID) {
    console.error(`❌ Order response missing orderID:`, JSON.stringify(response));
    throw new Error('CLOB order response missing orderID');
  }

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
  return retry(() => client.getOpenOrders());
}

// ── Check entry quality against live orderbook (Fix 9) ─────────────────────────
async function checkEntryQuality(tokenId, whaleEntryPrice, marketData, intendedSizeUsd, debugContext = {}) {
  const checks = [];

  // 1. Get orderbook
  let book;
  try {
    book = await retry(() => rateLimited(() => CLOB.getOrderBook(tokenId)));
  } catch (e) {
    console.error(`❌ Failed to fetch orderbook for tokenId ${tokenId}: ${e.message}`);
    checks.push({ pass: false, reason: `Orderbook fetch failed: ${e.message}` });
    return { pass: false, bestAsk: 1, bestBid: 0, spread: 1, failedChecks: ['Orderbook fetch failed'], debug: debugContext };
  }

  // 2. Sort orderbook defensively (do not trust array order)
  const sortedBids = (book.bids || []).map(b => ({ price: parseFloat(b.price), size: parseFloat(b.size) }))
    .sort((a, b) => b.price - a.price); // highest first
  const sortedAsks = (book.asks || []).map(a => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
    .sort((a, b) => a.price - b.price); // lowest first

  const bestBid = sortedBids[0]?.price || 0;
  const bestAsk = sortedAsks[0]?.price || 1;
  const spread = bestAsk - bestBid;
  const spreadPct = bestAsk > 0 ? spread / bestAsk : 1;

  // 3. Fetch CLOB midpoint for price dislocation check
  let midpoint = null;
  try {
    midpoint = await retry(() => rateLimited(() => CLOB.getMidpoint(tokenId)));
    midpoint = midpoint ? parseFloat(midpoint) : null;
  } catch { /* midpoint is optional */ }

  // 4. Build debug info
  const debug = {
    marketTitle: debugContext.marketTitle || '',
    conditionId: debugContext.conditionId || '',
    outcome: debugContext.outcome || '',
    tokenId: tokenId,
    traderEntryPrice: whaleEntryPrice,
    whaleEntryPrice,
    bestBid,
    bestAsk,
    spread: spreadPct,
    midpoint,
    topBids: sortedBids.slice(0, 5),
    topAsks: sortedAsks.slice(0, 5),
    allTokenIds: debugContext.allTokenIds || [],
    gammaPrice: debugContext.gammaPrice || null,
    signalType: debugContext.signalType || '',
  };

  // 5. Price dislocation check
  if (midpoint !== null && Math.abs(midpoint - bestAsk) > 0.10) {
    console.warn(`⚠️  PRICE_DISLOCATION: midpoint=${midpoint?.toFixed(3)} vs bestAsk=${bestAsk.toFixed(3)} for tokenId=${tokenId.slice(0, 12)}...`);
    debug.priceDislocation = true;
  }

  // 6. Spread check
  if (spreadPct > 0.06) {
    checks.push({ pass: false, reason: `Spread ${(spreadPct * 100).toFixed(1)}% > 6% max` });
  } else {
    checks.push({ pass: true });
  }

  // 7. Slippage check
  if (bestAsk > whaleEntryPrice + CONFIG.execution.slippageBuffer) {
    checks.push({ pass: false, reason: `Ask ${bestAsk.toFixed(3)} > whale entry ${whaleEntryPrice.toFixed(3)} + ${CONFIG.execution.slippageBuffer} slippage` });
  } else {
    checks.push({ pass: true });
  }

  // 8. Depth check — Fix 10: use actual intended size, not always maxPositionSizeUsd
  const ourSize = (intendedSizeUsd || CONFIG.risk.maxPositionSizeUsd) / bestAsk;
  const askDepthAtPrice = sortedAsks.filter(a => a.price <= bestAsk).reduce((s, a) => s + a.size, 0);
  if (askDepthAtPrice < ourSize) {
    checks.push({ pass: false, reason: `Ask depth at ${bestAsk.toFixed(3)} (${askDepthAtPrice.toFixed(0)}) < our size ${ourSize.toFixed(0)}` });
  } else {
    checks.push({ pass: true });
  }

  // 9. Max entry price
  if (bestAsk > 0.92) {
    checks.push({ pass: false, reason: `Ask ${bestAsk.toFixed(3)} > 0.92 max entry price` });
  } else {
    checks.push({ pass: true });
  }

  const allPass = checks.every(c => c.pass);
  const failedChecks = checks.filter(c => !c.pass).map(c => c.reason);
  return { pass: allPass, bestAsk, bestBid, spread: spreadPct, failedChecks, debug };
}

// ── Execute a signal: place a copy order ────────────────────────────────────────
export async function executeSignal(signal) {
  const { market, entry, consensus, whale } = signal;

  // Fix 2: Calculate intendedSizeUsd BEFORE risk check and pass it
  const whaleValue = consensus?.totalSizeUsd || entry.valueUsd;
  let positionSizeUsd = Math.min(
    whaleValue * CONFIG.execution.copyRatio,
    CONFIG.risk.maxPositionSizeUsd
  );

  // Fix 8: A+ standalone size cap
  if (signal.type === 'ELITE_SHARP') {
    const cap = CONFIG.traderTiers.tierAPlus.maxStandaloneSizeUsd;
    if (positionSizeUsd > cap) {
      console.log(`📊 A+ standalone: size capped to $${cap} (was $${positionSizeUsd.toFixed(2)})`);
      positionSizeUsd = Math.min(positionSizeUsd, cap);
    }
  }

  // Risk check — pass our intended size, not the whale's
  const riskCheck = checkRisk(signal, positionSizeUsd);
  if (!riskCheck.allowed) {
    console.log(`🚫 Risk gate blocked trade: ${riskCheck.reason}`);
    if (CONFIG.pnlLogger.enabled) {
      logBlockedTrade(riskCheck.reason, market.title || market.slug || 'N/A');
    }
    if (CONFIG.telegram.alertOnRiskBreach) {
      await sendTelegram(`🚫 *Trade blocked by risk gate:*\n\n${riskCheck.reason}\n\nMarket: ${market.title}`);
    }
    return null;
  }

  // Determine position size
  // (already calculated above as positionSizeUsd)
  // Determine entry price (whale's entry + slippage buffer)
  const whaleEntryPrice = consensus?.avgEntryPrice || entry.price;

  // Fix 8 (v1.3.2): Declare marketData BEFORE tokenId resolution block.
  // Previously marketData was referenced in the tokenId fallback block before being declared,
  // which could cause a ReferenceError if market.asset is invalid.
  let marketData = signal.marketData;
  if (!marketData) {
    const m = await retry(() => rateLimited(() => Gamma.getMarket(market.conditionId)));
    marketData = m ? {
      tickSize: m.orderPriceMinTickSize || m.minimumTickSize || '0.01',
      negRisk: m.negRisk,
      clobTokenIds: m.clobTokenIds,
    } : null;
  }

  // Get token ID
  // Fix 5: Validate tokenId — never use outcomeIndex (0/1) as a CLOB tokenId
  let tokenId = market.asset;
  if (!tokenId || tokenId.length < 10) {
    // Try to resolve from marketData.clobTokenIds
    if (marketData?.clobTokenIds) {
      const tokenIds = typeof marketData.clobTokenIds === 'string'
        ? JSON.parse(marketData.clobTokenIds)
        : marketData.clobTokenIds;
      if (Array.isArray(tokenIds) && tokenIds.length > 0) {
        const idx = market.outcomeIndex ?? 0;
        if (idx >= 0 && idx < tokenIds.length) {
          tokenId = tokenIds[idx];
          console.log(`🔧 Resolved tokenId from clobTokenIds[${idx}]: ${tokenId.slice(0, 16)}...`);
        }
      }
    }
  }
  if (!tokenId || tokenId.length < 10) {
    console.warn(`⚠️  No valid token ID for market ${market.title} (asset=${market.asset}, outcomeIndex=${market.outcomeIndex}) — cannot execute`);
    await sendTelegram(`⚠️ *Cannot execute trade — no valid tokenId*\n\nMarket: ${market.title}\nasset: ${market.asset || 'missing'}\noutcomeIndex: ${market.outcomeIndex ?? 'N/A'}\n\nTrade skipped — tokenId could not be resolved.`);
    return null;
  }

  // Fix 9/10: Entry quality checks — pass actual intended size + debug context
  const debugContext = {
    marketTitle: market.title || market.slug || '',
    conditionId: market.conditionId || '',
    outcome: market.outcome || '',
    allTokenIds: marketData?.clobTokenIds || [],
    signalType: signal.type || '',
  };
  const quality = await checkEntryQuality(tokenId, whaleEntryPrice, marketData, positionSizeUsd, debugContext);
  if (!quality.pass) {
    if (CONFIG.pnlLogger.enabled) {
      logSkippedTrade(quality.failedChecks.join('; '), market.title || market.slug || 'N/A');
    }
    // Rich debug alert with full orderbook context
    const d = quality.debug || {};
    const topBidsStr = (d.topBids || []).slice(0, 5).map(b => `  ${b.price.toFixed(3)} × ${b.size.toFixed(0)}`).join('\n') || '  (empty)';
    const topAsksStr = (d.topAsks || []).slice(0, 5).map(a => `  ${a.price.toFixed(3)} × ${a.size.toFixed(0)}`).join('\n') || '  (empty)';
    const allTokensStr = (d.allTokenIds || []).length > 0 ? JSON.stringify(d.allTokenIds) : 'N/A';
    const dislocationWarning = d.priceDislocation ? '\n⚠️ <b>PRICE_DISLOCATION detected</b> — midpoint far from best ask!' : '';
    await sendTelegram([
      `🚫 <b>TRADE SKIPPED — Debug Report</b>`,
      ``,
      `📊 <b>Market:</b> ${d.marketTitle || market.title}`,
      `🆔 <b>conditionId:</b> <code>${d.conditionId || 'N/A'}</code>`,
      `🎯 <b>Outcome:</b> ${d.outcome || 'N/A'}`,
      `🎫 <b>tokenId (selected):</b> <code>${(d.tokenId || '').slice(0, 20)}...</code>`,
      `📋 <b>all clobTokenIds:</b> <code>${allTokensStr}</code>`,
      `📡 <b>Signal type:</b> ${d.signalType || 'N/A'}`,
      ``,
      `💰 <b>Trader entry:</b> ${d.whaleEntryPrice?.toFixed(3) || 'N/A'}`,
      `📈 <b>CLOB midpoint:</b> ${d.midpoint?.toFixed(3) || 'N/A'}`,
      `🔵 <b>Best bid:</b> ${d.bestBid?.toFixed(3) || '0'}`,
      `🔴 <b>Best ask:</b> ${d.bestAsk?.toFixed(3) || '1'}`,
      `📐 <b>Spread:</b> ${((d.spread || 0) * 100).toFixed(1)}%`,
      ``,
      `<b>Top 5 Bids:</b>\n<pre>${topBidsStr}</pre>`,
      `<b>Top 5 Asks:</b>\n<pre>${topAsksStr}</pre>`,
      ``,
      `<b>Skip reasons:</b>\n${quality.failedChecks.join('\n')}`,
      dislocationWarning,
    ].join('\n'));
    console.log(`🚫 Entry quality checks failed for ${market.title}:\n${quality.failedChecks.join('\n')}`);
    console.log(`   tokenId: ${tokenId.slice(0, 20)}... | bestBid: ${d.bestBid} | bestAsk: ${d.bestAsk} | midpoint: ${d.midpoint}`);
    return null;
  }

  // Use the best ask as our entry price for instant fill
  const ourPrice = quality.bestAsk;

  // Fix 12: Use Math.floor (not Math.ceil) to avoid exceeding $5 cap
  const sizeInTokens = Math.floor(positionSizeUsd / ourPrice);
  const actualCost = sizeInTokens * ourPrice;

  // Fix 9: Block zero-token orders
  if (sizeInTokens < 1) {
    console.log(`🚫 Trade skipped — size too small ($${positionSizeUsd.toFixed(2)} / price ${ourPrice.toFixed(3)} = 0 tokens)`);
    await sendTelegram(`🚫 *Trade skipped — size too small*\n\n$${positionSizeUsd.toFixed(2)} / price ${ourPrice.toFixed(3)} = 0 tokens\nMarket: ${market.title}`);
    return null;
  }

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
      valueUsd: actualCost, // Fix 12: actual cost after flooring
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
      // Fix 9: Include marketData in the trade object
      marketData: marketData || null,
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
      const whaleName = consensus ? `${consensus.whaleCount} whales (consensus)` : whale.username;
      const whaleTier = whale.tier ? whale.tier.replace('tier','') : 'B';
      const marketUrl = market.slug ? `https://polymarket.com/event/${market.eventSlug || market.slug}` : '';
      await sendTelegramHTML([
        '🎯 <b>COPY TRADE EXECUTED</b>',
        '',
        `📊 <b>Market:</b> <a href="${marketUrl}">${market.title}</a>`,
        `🎯 <b>Outcome:</b> ${market.outcome}`,
        `💰 <b>Entry:</b> $${ourPrice.toFixed(3)}`,
        `📦 <b>Size:</b> ${sizeInTokens} tokens ($${actualCost.toFixed(2)})`,
        `🐋 <b>Following:</b> ${whaleName} [Tier ${whaleTier}]`,
        `🆔 <b>Order ID:</b> <code>${order.orderID}</code>`,
        '',
        '⏳ <i>Awaiting fill...</i>',
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
    p.orderId && p.orderId !== 'undefined' && p.orderId !== undefined &&
    (p.status === 'PENDING_FILL' || p.status === 'SUBMITTED' || p.status === 'LIVE' ||
    p.status === 'RECONCILE_UNKNOWN' ||
    // Fix 3: Also reconcile exit lifecycle states
    p.status === 'EXIT_SUBMITTED' || p.status === 'EXIT_LIVE' || p.status === 'EXIT_PARTIALLY_FILLED')
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
    const isExitOrder = pos.status.startsWith('EXIT_');
    // For exit orders, check the SELL order ID if available
    const checkOrderId = isExitOrder ? (pos.exitSellOrderId || pos.orderId) : pos.orderId;
    const isInOpenOrders = openOrderIds.has(checkOrderId);
    const previousStatus = pos.status;

    if (isExitOrder) {
      // Fix 3: Reconcile exit orders
      if (isInOpenOrders) {
        // Exit order is still live on the book
        if (pos.status === 'EXIT_SUBMITTED') {
          updatePositionStatus(pos.orderId, 'EXIT_LIVE');
          console.log(`📋 Exit order ${checkOrderId} is EXIT_LIVE on book (${pos.market})`);
        }
        // If EXIT_PARTIALLY_FILLED, stay in that state
      } else {
        // Exit order not in open orders — either filled or cancelled
        let wasCancelled = false;
        let orderDetail = null;
        try {
          const client = await initClobClient();
          if (!client.rawMode) {
            orderDetail = await retry(() => client.getOrder(checkOrderId));
            if (orderDetail?.status === 'CANCELED' || orderDetail?.status === 'CANCELLED') {
              wasCancelled = true;
            }
            // Check for partial fill via size_matched
            const sizeMatched = parseFloat(orderDetail?.size_matched || 0);
            const originalSize = parseFloat(orderDetail?.original_size || orderDetail?.size || 0);
            if (sizeMatched > 0 && originalSize > 0 && sizeMatched < originalSize) {
              // Partially filled then cancelled
              wasCancelled = true;
              // Register partial exit — Fix 6: pass cumulativeFilledSize
              if (sizeMatched > 0) {
                const result = registerExit(pos.orderId, {
                  size: sizeMatched,
                  price: parseFloat(orderDetail?.price || pos.exitPrice || 0),
                  reason: pos.exitReason || 'Partial exit fill',
                  sellOrderId: checkOrderId,
                  cumulativeFilledSize: sizeMatched,
                });
                if (CONFIG.pnlLogger.enabled && result.booked) {
                  logExit(pos.orderId, { size: sizeMatched, price: parseFloat(orderDetail?.price || pos.exitPrice || 0), reason: pos.exitReason || 'Partial exit fill', sellOrderId: checkOrderId });
                }
              }
            }
          }
        } catch {
          // Fix 4: If we can't get order details, mark as RECONCILE_UNKNOWN, don't assume filled
          updatePositionStatus(pos.orderId, 'RECONCILE_UNKNOWN');
          console.warn(`⚠️  Reconciliation: cannot fetch exit order ${checkOrderId} — marked RECONCILE_UNKNOWN (will retry next cycle)`);
          continue;
        }

        if (wasCancelled) {
          // Fix 9: If partial fill occurred, registerExit was already called above for the filled portion
          // Clear exit metadata and return position to FILLED (not EXIT_CANCELLED) so manageExits continues
          const { clearExitMetadata } = await import('./risk-manager.mjs');
          clearExitMetadata(pos.orderId);
          updatePositionStatus(pos.orderId, 'FILLED');
          if (CONFIG.pnlLogger.enabled) {
            logStatusTransition(pos.orderId, previousStatus, 'FILLED', pos.market);
          }
          console.log(`❌ Exit order ${checkOrderId} CANCELLED — position returned to FILLED (${pos.market})`);
        } else {
          // Exit order filled — register the exit
          let fillSize = pos.exitSize || pos.size;
          let fillPrice = pos.exitPrice || 0;
          if (orderDetail) {
            fillSize = parseFloat(orderDetail.size_matched || fillSize);
            fillPrice = parseFloat(orderDetail.price || fillPrice);
          }

          // Fix 7: Event idempotence for exit fill in reconciliation
          const exitEventHash = makeEventHash(pos.orderId, 'RECONCILE_EXIT_FILL', fillSize, fillPrice);
          if (isEventProcessed(pos.orderId, exitEventHash)) {
            console.log(`⏭️  Reconciliation: exit fill already processed for ${pos.orderId} (${fillSize}@${fillPrice})`);
            continue;
          }

          updatePositionStatus(pos.orderId, 'EXIT_FILLED');
          // Fix 6: Pass cumulativeFilledSize for idempotent partial-fill tracking
          const result = registerExit(pos.orderId, {
            size: fillSize,
            price: fillPrice,
            reason: pos.exitReason || 'Exit order filled',
            sellOrderId: checkOrderId,
            cumulativeFilledSize: fillSize,
          });
          markEventProcessed(pos.orderId, exitEventHash);
          if (CONFIG.pnlLogger.enabled && result.booked) {
            logExit(pos.orderId, { size: fillSize, price: fillPrice, reason: pos.exitReason || 'Exit order filled', sellOrderId: checkOrderId });
            logStatusTransition(pos.orderId, previousStatus, 'EXIT_FILLED', pos.market);
          }
          console.log(`✅ Exit order ${checkOrderId} FILLED (${pos.market})`);
          // Rich exit filled alert with win/loss verdict
          const exitPnl = (fillPrice - (pos.entryPrice || 0)) * fillSize;
          const exitPnlPct = pos.entryPrice ? ((fillPrice - pos.entryPrice) / pos.entryPrice * 100) : 0;
          const verdict = exitPnl >= 0 ? '🏆 WIN' : '💀 LOSS';
          const pnlEmoji = exitPnl >= 0 ? '🟢' : '🔴';
          const pnlSign = exitPnl >= 0 ? '+' : '';
          await sendTelegramHTML([
            `${verdict} — <b>POSITION CLOSED</b>`,
            '',
            `📊 <b>Market:</b> ${pos.market}`,
            `📝 <b>Exit Reason:</b> ${pos.exitReason || 'Exit order filled'}`,
            `💰 <b>Entry:</b> $${(pos.entryPrice || 0).toFixed(3)} → <b>Exit:</b> $${fillPrice.toFixed(3)}`,
            `📦 <b>Size:</b> ${fillSize} tokens`,
            `${pnlEmoji} <b>Realized PnL:</b> ${pnlSign}$${exitPnl.toFixed(2)} (${pnlSign}${exitPnlPct.toFixed(1)}%)`,
            `🆔 <b>Sell Order:</b> <code>${checkOrderId}</code>`,
          ].join('\n'));
        }
      }
    } else {
      // Original entry order reconciliation
      if (isInOpenOrders) {
        // Order is still live on the book
        if (pos.status !== 'LIVE') {
          updatePositionStatus(pos.orderId, 'LIVE');
          if (CONFIG.pnlLogger.enabled) {
            logStatusTransition(pos.orderId, previousStatus, 'LIVE', pos.market);
          }
          console.log(`📋 Order ${pos.orderId} is LIVE on book (${pos.market})`);
        }
      } else {
        // Order is NOT in open orders — either filled or cancelled
        let wasCancelled = false;
        let orderDetail = null;
        try {
          const client = await initClobClient();
          if (!client.rawMode) {
            orderDetail = await retry(() => client.getOrder(pos.orderId));
            if (orderDetail?.status === 'CANCELED' || orderDetail?.status === 'CANCELLED') {
              wasCancelled = true;
            }
          }
        } catch {
          // Fix 4: If we can't get order details, mark as RECONCILE_UNKNOWN, don't assume filled
          updatePositionStatus(pos.orderId, 'RECONCILE_UNKNOWN');
          console.warn(`⚠️  Reconciliation: cannot fetch order ${pos.orderId} — marked RECONCILE_UNKNOWN (will retry next cycle)`);
          continue;
        }

        if (wasCancelled) {
          updatePositionStatus(pos.orderId, 'CANCELLED');
          if (CONFIG.pnlLogger.enabled) {
            logStatusTransition(pos.orderId, previousStatus, 'CANCELLED', pos.market);
          }
          console.log(`❌ Order ${pos.orderId} CANCELLED (${pos.market})`);
        } else {
          // Order not in open orders and not cancelled → filled
          // Verify with order detail if available
          const sizeMatched = orderDetail ? parseFloat(orderDetail.size_matched || 0) : 0;
          if (orderDetail && sizeMatched === 0) {
            // No match size — not actually filled, unknown state
            updatePositionStatus(pos.orderId, 'RECONCILE_UNKNOWN');
            console.warn(`⚠️  Reconciliation: order ${pos.orderId} not in open orders but size_matched=0 — RECONCILE_UNKNOWN`);
            continue;
          }
          // Fix 1/7: Use actual filled size/price from orderDetail and persist via updatePositionFill
          const fillSize = orderDetail ? parseFloat(orderDetail.size_matched || 0) : 0;
          const fillPrice = orderDetail ? parseFloat(orderDetail.price || 0) : 0;
          // Fix 7: Event idempotence in reconciliation
          const entryOrderId = pos.orderId;
          const eventHash = makeEventHash(entryOrderId, 'RECONCILE_FILL', fillSize, fillPrice);
          if (isEventProcessed(entryOrderId, eventHash)) {
            console.log(`⏭️  Reconciliation: event already processed for ${entryOrderId} (fill ${fillSize}@${fillPrice})`);
            continue;
          }
          if (fillSize > 0 && fillPrice > 0) {
            // Fix 1: Persist fill via updatePositionFill (not local mutation)
            const actualCost = fillSize * fillPrice;
            updatePositionFill(pos.orderId, fillSize, fillPrice, actualCost);
          }
          // Check for partial fill
          if (orderDetail && fillSize > 0) {
            const originalSize = parseFloat(orderDetail.original_size || orderDetail.size || 0);
            if (originalSize > 0 && fillSize < originalSize) {
              updatePositionStatus(pos.orderId, 'PARTIALLY_FILLED');
              markEventProcessed(entryOrderId, eventHash);
              if (CONFIG.pnlLogger.enabled) {
                logStatusTransition(pos.orderId, previousStatus, 'PARTIALLY_FILLED', pos.market);
              }
              console.log(`🔶 Order ${pos.orderId} PARTIALLY_FILLED ${fillSize}/${originalSize} (${pos.market})`);
              await sendTelegram(`🔶 *Order Partially Filled*\n\nMarket: ${pos.market}\nFilled: ${fillSize}/${originalSize}\nOrder ID: ${pos.orderId}`);
              continue;
            }
          }
          updatePositionStatus(pos.orderId, 'FILLED');
          markEventProcessed(entryOrderId, eventHash);
          if (CONFIG.pnlLogger.enabled) {
            logStatusTransition(pos.orderId, previousStatus, 'FILLED', pos.market);
          }
          console.log(`✅ Order ${pos.orderId} FILLED (${pos.market}) size=${fillSize || pos.size}`);
          await sendTelegramHTML([
            '✅ <b>ORDER FILLED</b>',
            '',
            `📊 <b>Market:</b> ${pos.market}`,
            `💰 <b>Entry:</b> $${pos.entryPrice?.toFixed(3) || 'N/A'}`,
            `📦 <b>Size:</b> ${fillSize || pos.size} tokens`,
            `🆔 <b>Order ID:</b> <code>${pos.orderId}</code>`,
            `💼 <b>Position value:</b> $${((fillSize || pos.size) * (pos.entryPrice || 0)).toFixed(2)}`,
          ].join('\n'));
        }
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

// ── Fix 2/3: User WS message handler with correct status parsing ──────────────
async function handleUserWsMessage(m) {
  // Polymarket user events: event_type is 'order' or 'trade',
  // but the lifecycle stage is in m.type (for orders) or m.status (for trades)
  const eventType = (m.event_type || '').toLowerCase();

  // Handle order events (PLACEMENT, UPDATE, CANCELLATION)
  if (eventType === 'order') {
    const orderId = m.order_id || m.orderID || m.id;
    const orderLifecycle = (m.type || '').toUpperCase();
    if (!orderId) return;

    console.log(`📋 WS order event: ${orderId} → ${orderLifecycle}`);

    // Fix 3: Use resolvePosition to distinguish entry vs exit orders
    const { pos: resolvedPos, entryOrderId, isExit } = resolvePosition(orderId);
    if (!resolvedPos) {
      console.log(`📋 WS order event for unknown order ${orderId} — ignoring`);
      return;
    }

    if (orderLifecycle === 'PLACEMENT') {
      // Fix 3: EXIT orders → EXIT_LIVE, entry orders → LIVE
      if (isExit) {
        updatePositionStatus(entryOrderId, 'EXIT_LIVE');
        console.log(`📋 Exit order ${orderId} → EXIT_LIVE (entry: ${entryOrderId})`);
      } else {
        updatePositionStatus(entryOrderId, 'LIVE');
      }
    } else if (orderLifecycle === 'UPDATE') {
      // Fix 3: Log only, no status change for either entry or exit
      console.log(`📋 WS order update: ${orderId} (staying in current state, isExit=${isExit})`);
    } else if (orderLifecycle === 'CANCELLATION') {
      // Fix 3: Exit cancellation → clearExitMetadata + FILLED; entry cancellation → CANCELLED
      if (isExit) {
        const { clearExitMetadata } = await import('./risk-manager.mjs');
        clearExitMetadata(entryOrderId);
        updatePositionStatus(entryOrderId, 'FILLED');
        if (CONFIG.pnlLogger.enabled) {
          logStatusTransition(entryOrderId, 'EXIT_LIVE', 'FILLED', resolvedPos.market || '');
        }
        console.log(`📋 Exit order ${orderId} CANCELLED — position returned to FILLED (${entryOrderId})`);
      } else {
        updatePositionStatus(entryOrderId, 'CANCELLED');
        if (CONFIG.pnlLogger.enabled) {
          logStatusTransition(entryOrderId, 'LIVE', 'CANCELLED', resolvedPos.market || '');
        }
      }
    }
    return;
  }

  // Handle trade events (MATCHED, MINED, CONFIRMED, FAILED, etc.)
  if (eventType === 'trade') {
    const orderId = m.order_id || m.orderID || m.id;
    // Fix 2: Use m.status for the specific trade lifecycle stage
    const tradeStatus = (m.status || m.type || '').toUpperCase();
    if (!orderId) return;

    const sizeMatched = parseFloat(m.size_matched || 0);
    const originalSize = parseFloat(m.original_size || m.size || 0);

    console.log(`📊 WS trade event: ${orderId} → ${tradeStatus} (matched: ${sizeMatched}/${originalSize})`);

    // Fix 10: Use systematic resolvePosition helper for all WS event handling
    const { pos: resolvedPos, entryOrderId: resolvedEntryId, isExit: resolvedIsExit } = resolvePosition(orderId);
    let entryOrderId = resolvedEntryId;
    let pos = resolvedPos;
    // Fix 8: Use resolvedIsExit as the source of truth for entry vs exit, not m.side
    const isExitOrder = resolvedIsExit;
    if (pos && isExitOrder) {
      console.log(`🔗 SELL order ${orderId} → entry position ${entryOrderId}`);
    }

    // Fix 7: Event idempotence — compute hash and check
    const eventHash = makeEventHash(entryOrderId, `WS_${tradeStatus}`, sizeMatched, parseFloat(m.price || 0));
    if (isEventProcessed(entryOrderId, eventHash)) {
      console.log(`⏭️  WS: event already processed for ${entryOrderId} (${tradeStatus} ${sizeMatched}@${m.price || 0})`);
      return;
    }

    if (tradeStatus === 'MATCHED') {
      // Fix 7: Use m.size_matched as actual fill size, m.price as actual fill price
      const actualFillSize = sizeMatched;
      const actualFillPrice = parseFloat(m.price || 0);
      // Check for partial vs full fill
      if (originalSize > 0 && actualFillSize >= originalSize) {
        // Full fill
        if (isExitOrder) {
          // Exit order filled — now register the exit
          updatePositionStatus(entryOrderId, 'EXIT_FILLED');
          if (pos) {
            // Fix 5/6: Pass cumulativeFilledSize, check return value for logExit
            const result = registerExit(entryOrderId, {
              size: actualFillSize,
              price: actualFillPrice,
              reason: pos.exitReason || 'Exit order filled',
              sellOrderId: orderId,
              cumulativeFilledSize: actualFillSize,
            });
            if (CONFIG.pnlLogger.enabled && result.booked) {
              logExit(entryOrderId, { size: actualFillSize, price: actualFillPrice, reason: pos.exitReason || 'Exit order filled', sellOrderId: orderId });
            }
          }
        } else {
          // Fix 1: Persist fill via updatePositionFill (not local mutation)
          const actualCost = actualFillSize * actualFillPrice;
          updatePositionFill(orderId, actualFillSize, actualFillPrice, actualCost);
          updatePositionStatus(orderId, 'FILLED');
          if (CONFIG.pnlLogger.enabled) {
            logStatusTransition(orderId, 'LIVE', 'FILLED', '');
          }
        }
      } else if (actualFillSize > 0) {
        // Partial fill
        if (isExitOrder) {
          updatePositionStatus(entryOrderId, 'EXIT_PARTIALLY_FILLED');
          // Fix 5/6: Register partial exit with cumulativeFilledSize, check return
          if (pos) {
            const result = registerExit(entryOrderId, {
              size: actualFillSize,
              price: actualFillPrice,
              reason: pos.exitReason || 'Partial exit fill',
              sellOrderId: orderId,
              cumulativeFilledSize: actualFillSize,
            });
          }
        } else {
          // Fix 1: Persist partial fill via updatePositionFill
          const actualCost = actualFillSize * actualFillPrice;
          updatePositionFill(orderId, actualFillSize, actualFillPrice, actualCost);
          // Fix 6 (v1.3.2): Use PARTIALLY_FILLED (not LIVE) so the filled portion counts as
          // position value AND the unfilled remainder counts as pending exposure.
          // PARTIALLY_FILLED is in isExposureStatus() and valueStatuses, so it's counted
          // in both risk exposure and portfolio value.
          if (pos) {
            pos.filledSize = actualFillSize;
            pos.filledCost = actualCost;
            pos.averageFillPrice = actualFillPrice;
            pos.remainingOpenOrderSize = originalSize - actualFillSize;
          }
          updatePositionStatus(orderId, 'PARTIALLY_FILLED');
        }
      }
    } else if (tradeStatus === 'MINED') {
      // Trade mined — confirmed on chain, treat as confirmed
      console.log(`⛏️  WS trade mined: ${orderId}`);
    } else if (tradeStatus === 'CONFIRMED') {
      // Trade confirmed — final fill confirmation
      // Fix 7: Use actual fill size/price
      const confirmFillSize = sizeMatched || originalSize;
      const confirmFillPrice = parseFloat(m.price || 0);
      if (isExitOrder) {
        updatePositionStatus(entryOrderId, 'EXIT_FILLED');
        if (pos) {
          // Fix 5/6: Check return value before logging
          const result = registerExit(entryOrderId, {
            size: confirmFillSize,
            price: confirmFillPrice,
            reason: pos.exitReason || 'Exit order confirmed',
            sellOrderId: orderId,
            cumulativeFilledSize: confirmFillSize,
          });
          if (CONFIG.pnlLogger.enabled && result.booked) {
            logExit(entryOrderId, { size: confirmFillSize, price: confirmFillPrice, reason: pos.exitReason || 'Exit order confirmed', sellOrderId: orderId });
          }
        }
      } else {
        // Fix 1: Persist fill via updatePositionFill
        const actualCost = confirmFillSize * confirmFillPrice;
        updatePositionFill(orderId, confirmFillSize, confirmFillPrice, actualCost);
        updatePositionStatus(orderId, 'FILLED');
        if (CONFIG.pnlLogger.enabled) {
          logStatusTransition(orderId, 'LIVE', 'FILLED', '');
        }
      }
    } else if (tradeStatus === 'RETRYING') {
      // Trade retrying — stay in current state
      console.log(`🔄 WS trade retrying: ${orderId} (staying in current state)`);
    } else if (tradeStatus === 'FAILED') {
      // Trade failed
      if (isExitOrder) {
        updatePositionStatus(entryOrderId, 'EXIT_FAILED');
        await sendTelegram(`⚠️ Exit order FAILED for ${entryOrderId}`);
      } else {
        updatePositionStatus(orderId, 'CANCELLED');
        if (CONFIG.pnlLogger.enabled) {
          logStatusTransition(orderId, 'LIVE', 'CANCELLED', '');
        }
      }
    }
    // Fix 7: Mark event as processed after handling
    markEventProcessed(entryOrderId, eventHash);
    return;
  }
}

// ── Fix 10: Authenticated /ws/user WebSocket for real-time order updates ──────
let userWs = null;
let userWsReconnectTimer = null;
let userWsHeartbeatTimer = null;

export function startUserWebSocket() {
  if (!CONFIG.execution.privateKey) return;
  const WS_USER_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/user';
  console.log('🔌 Connecting to user WebSocket for order updates...');

  const connect = async () => {
    try {
      const client = await initClobClient();
      if (client.rawMode) return; // no user WS in raw mode

      // Get auth credentials for WS subscription
      const { ApiKeyCreds } = await import('@polymarket/clob-client-v2');
      const creds = apiCreds;
      if (!creds) return;

      userWs = new WebSocket(WS_USER_URL);

      userWs.onopen = () => {
        console.log('✅ User WebSocket connected — subscribing to order updates');
        // Fix 1: Use correct SDK credential field names (key/secret/passphrase)
        const subMsg = JSON.stringify({
          auth: {
            apiKey: creds.key,
            secret: creds.secret,
            passphrase: creds.passphrase,
          },
          type: 'user',
          custom_feature_enabled: true,
        });
        userWs.send(subMsg);

        // Fix 2: Heartbeat — send PING every 10 seconds (same as market WS)
        if (userWsHeartbeatTimer) clearInterval(userWsHeartbeatTimer);
        userWsHeartbeatTimer = setInterval(() => {
          if (userWs && userWs.readyState === WebSocket.OPEN) {
            userWs.send('PING');
          }
        }, 10000);
      };

      userWs.onmessage = async (event) => {
        try {
          const msg = JSON.parse(event.data);
          const messages = Array.isArray(msg) ? msg : [msg];
          for (const m of messages) {
            await handleUserWsMessage(m);
          }
        } catch { /* non-JSON */ }
      };

      userWs.onerror = (err) => {
        console.warn(`⚠️  User WebSocket error: ${err.message || err}`);
      };

      userWs.onclose = () => {
        console.log('🔌 User WebSocket disconnected — will reconnect in 5s');
        if (userWsHeartbeatTimer) { clearInterval(userWsHeartbeatTimer); userWsHeartbeatTimer = null; }
        if (userWsReconnectTimer) clearTimeout(userWsReconnectTimer);
        userWsReconnectTimer = setTimeout(connect, 5000);
      };
    } catch (err) {
      console.warn(`⚠️  User WebSocket init failed: ${err.message}`);
      if (userWsReconnectTimer) clearTimeout(userWsReconnectTimer);
      userWsReconnectTimer = setTimeout(connect, 10000);
    }
  };

  connect();
}

// ── Exit management: check open positions and apply exit logic ─────────────────
export async function manageExits() {
  const positions = getOpenPositions();
  if (positions.length === 0) return;

  const { exitLogic } = CONFIG.execution;
  const now = Date.now();

  for (const pos of positions) {
    // Fix 3: Check pending fill timeout for PENDING, SUBMITTED, and LIVE orders
    if (pos.status === 'PENDING_FILL' || pos.status === 'SUBMITTED' || pos.status === 'LIVE') {
      const elapsed = (now - pos.timestamp) / 60000;
      if (elapsed > CONFIG.execution.fillTimeoutMin) {
        await cancelOrder(pos.orderId).catch(() => {});
        updatePositionStatus(pos.orderId, 'CANCELLED');
        console.log(`⏰ Cancelled unfilled order ${pos.orderId} (${elapsed.toFixed(1)}min)`);
        await sendTelegramHTML([
        '⏰ <b>ORDER CANCELLED — UNFILLED</b>',
        '',
        `📊 <b>Market:</b> ${pos.market}`,
        `⏱️ <b>Timeout:</b> ${elapsed.toFixed(1)} min`,
        `🆔 <b>Order ID:</b> <code>${pos.orderId}</code>`,
        `<i>Order expired without fill — capital released.</i>`,
      ].join('\n'));
        continue;
      }
      // Still pending/live — skip exit checks but DO count in risk exposure
      continue;
    }

    // Fix 8: Check EXIT_SUBMITTED/EXIT_LIVE positions for timeout
    if (pos.status === 'EXIT_SUBMITTED' || pos.status === 'EXIT_LIVE' || pos.status === 'EXIT_PARTIALLY_FILLED') {
      const exitElapsed = (now - (pos.exitSubmittedAt || pos.timestamp)) / 60000;
      if (exitElapsed > CONFIG.execution.exitOrderTimeoutMin) {
        // Fix 5: Read exitRetries from persisted state
        const exitRetries = getExitRetries(pos.orderId);
        if (CONFIG.execution.exitRepriceEnabled && exitRetries < CONFIG.execution.exitMaxRetries) {
          // Cancel exit order, reprice at current best bid
          console.log(`⏰ Exit order timeout for ${pos.market} — repricing (retry ${exitRetries + 1}/${CONFIG.execution.exitMaxRetries})`);
          await cancelOrder(pos.exitSellOrderId).catch(() => {});
          // Fetch current best bid
          try {
            const book = await retry(() => rateLimited(() => CLOB.getOrderBook(pos.tokenId)));
            // Fix 7: Sort bids by highest price first before using bestBid
            const sortedBids = (book.bids || []).map(b => ({ price: parseFloat(b.price), size: parseFloat(b.size) })).sort((a, b) => b.price - a.price);
            const newBestBid = sortedBids[0]?.price || 0;
            if (newBestBid > 0) {
              // Fix 7: Use unfilled portion of THIS exit order, not pos.size - pendingExitSize
              const unfilledExitSize = pos.exitSize - (pos.exitFillsByOrderId?.[pos.exitSellOrderId] || 0);
              if (unfilledExitSize > 0) {
                const reorder = await placeOrder(pos.tokenId, 'SELL', newBestBid, unfilledExitSize, pos.marketData);
                // Fix 4: Persist pendingExitSize via setExitOrderMetadata
                setExitOrderMetadata(pos.orderId, reorder.orderID, unfilledExitSize, newBestBid, pos.exitReason || 'Exit reprice', pos.pendingExitSize || 0);
                updatePositionStatus(pos.orderId, 'EXIT_SUBMITTED');
                // Fix 5: Persist exit retry via incrementExitRetry
                incrementExitRetry(pos.orderId);
                console.log(`📋 Exit repriced to ${newBestBid.toFixed(3)} for ${unfilledExitSize} tokens (new order: ${reorder.orderID})`);
              }
            } else {
              // No bids — return to FILLED
              const { clearExitMetadata } = await import('./risk-manager.mjs');
              clearExitMetadata(pos.orderId);
              updatePositionStatus(pos.orderId, 'FILLED');
              console.log(`⚠️  No bids for ${pos.market} — exit returned to FILLED`);
            }
          } catch (err) {
            console.warn(`⚠️  Exit reprice failed for ${pos.market}: ${err.message}`);
          }
        } else {
          // Max retries reached — return to FILLED
          const { clearExitMetadata } = await import('./risk-manager.mjs');
          clearExitMetadata(pos.orderId);
          updatePositionStatus(pos.orderId, 'FILLED');
          console.log(`⏰ Exit max retries reached for ${pos.market} — returned to FILLED`);
        }
      }
      continue;
    }

    // Fix 6: Include PARTIALLY_FILLED positions in exit management
    if (pos.status !== 'FILLED' && pos.status !== 'OPEN' && pos.status !== 'PARTIALLY_FILLED') continue;

    try {
      // Fix 5: Exit pricing — use orderbook best bid for SELL exits
      const book = await retry(() =>
        rateLimited(() => CLOB.getOrderBook(pos.tokenId))
      );
      // Fix 7: Sort bids by highest price first before using bestBid
      const sortedExitBids = (book.bids || []).map(b => ({ price: parseFloat(b.price), size: parseFloat(b.size) })).sort((a, b) => b.price - a.price);
      const bestBid = sortedExitBids[0]?.price || 0;
      const bidDepth = sortedExitBids.reduce((s, b) => s + b.size, 0);

      if (bestBid === 0) {
        console.warn(`⚠️  No bids for ${pos.market} — cannot exit`);
        continue;
      }

      const currentPrice = bestBid;
      const peakPrice = Math.max(pos.peakPrice || currentPrice, currentPrice);
      updatePositionPrice(pos.orderId, currentPrice, peakPrice);

      let shouldExit = false;
      let exitReason = '';

      // ── Whale exit check: if the whale we copied sold, we sell too ──
      if (exitLogic.whaleExitEnabled !== false && pos.whaleAddress) {
        try {
          const whalePositions = await retry(() =>
            rateLimited(() =>
              Data.getPositions(pos.whaleAddress, {
                sizeThreshold: 0.01,
                limit: 500,
                redeemable: false,
              })
            )
          );
          // Check if whale still holds THIS market
          const stillHolds = whalePositions.some(wp =>
            wp.conditionId === pos.conditionId &&
            wp.size > 0.01
          );
          if (!stillHolds) {
            shouldExit = true;
            exitReason = `Whale ${pos.whaleUsername || pos.whaleAddress?.slice(0,8)} exited — following`;
            const remainingSize = pos.size - (pos.pendingExitSize || 0);
            if (remainingSize > 0) {
              console.log(`🐋 Whale exit detected for ${pos.market} — selling ${remainingSize} tokens`);
              await exitPosition(pos, remainingSize, currentPrice, exitReason);
            }
            continue;
          }
        } catch (e) {
          // Non-fatal — if we can't check whale position, continue with TP/SL
        }
      }

      // Take profit (scale out)
      if (!pos.tp1Hit && currentPrice >= exitLogic.takeProfitRatios[0]) {
        shouldExit = true;
        exitReason = `TP1 at ${currentPrice.toFixed(3)}`;
        // Scale out: sell half
        const exitSize = Math.floor(pos.size * exitLogic.scaleOutFraction);
        if (exitSize > 0) {
          // Fix 5 (v1.3.2): Only mark TP hit and set pendingExitSize if exitPosition actually placed a sell order
          const exitResult = await exitPosition(pos, exitSize, currentPrice, exitReason);
          if (exitResult && exitResult.submitted) {
            // Fix 4: Persist TP1 hit via markTpHit (not local mutation)
            markTpHit(pos.orderId, 'tp1Hit');
            pos.tp1Hit = true; // Also set locally for immediate use
            // Fix 9: Do NOT reduce pos.size here — that happens in registerExit() when the SELL is confirmed filled
            // Instead, store pendingExitSize so we know how much is pending
            // Fix 4: Persist pendingExitSize via setPendingExitSize
            const newPending = (pos.pendingExitSize || 0) + exitResult.size;
            setPendingExitSize(pos.orderId, newPending);
            pos.pendingExitSize = newPending; // Also set locally for immediate use in this loop
          } else {
            console.warn(`⚠️  TP1 exit not submitted for ${pos.market} — exitPosition failed/skipped, TP1 NOT marked`);
          }
        }
      }

      if (!pos.tp2Hit && currentPrice >= exitLogic.takeProfitRatios[1]) {
        shouldExit = true;
        exitReason = `TP2 at ${currentPrice.toFixed(3)}`;
        // Fix 9: Account for pendingExitSize — only sell the remaining unfilled portion
        const remainingSize = pos.size - (pos.pendingExitSize || 0);
        if (remainingSize > 0) {
          // Fix 5 (v1.3.2): Only mark TP2 hit if exitPosition actually placed a sell order
          const exitResult = await exitPosition(pos, remainingSize, currentPrice, exitReason);
          if (exitResult && exitResult.submitted) {
            markTpHit(pos.orderId, 'tp2Hit');
            pos.tp2Hit = true;
          } else {
            console.warn(`⚠️  TP2 exit not submitted for ${pos.market} — TP2 NOT marked`);
          }
        }
        continue;
      }

      // Stop loss
      if (currentPrice <= exitLogic.stopLossPrice) {
        shouldExit = true;
        exitReason = `Stop loss at ${currentPrice.toFixed(3)}`;
        // Fix 9: Account for pendingExitSize
        const remainingSize = pos.size - (pos.pendingExitSize || 0);
        if (remainingSize > 0) {
          await exitPosition(pos, remainingSize, currentPrice, exitReason);
        }
        continue;
      }

      // Trailing stop
      if (exitLogic.trailingStopEnabled && peakPrice > pos.entryPrice) {
        const trailingStop = peakPrice * (1 - exitLogic.trailingStopPct);
        if (currentPrice <= trailingStop && currentPrice < peakPrice) {
          shouldExit = true;
          exitReason = `Trailing stop at ${currentPrice.toFixed(3)} (peak: ${peakPrice.toFixed(3)})`;
          // Fix 9: Account for pendingExitSize
          const remainingSize = pos.size - (pos.pendingExitSize || 0);
          if (remainingSize > 0) {
            await exitPosition(pos, remainingSize, currentPrice, exitReason);
          }
          continue;
        }
      }
    } catch (err) {
      console.warn(`⚠️  Exit check failed for ${pos.market}: ${err.message}`);
    }
  }
}

// ── Exit a position (Fix 3: don't register exit until fill confirmed) ─────────
async function exitPosition(pos, size, price, reason) {
  try {
    // Fix 8: Enforce bid depth before placing SELL
    const book = await retry(() => rateLimited(() => CLOB.getOrderBook(pos.tokenId)));
    // Fix 7: Sort bids by highest price first before using bestBid
    const sortedExitBids = (book.bids || []).map(b => ({ price: parseFloat(b.price), size: parseFloat(b.size) })).sort((a, b) => b.price - a.price);
    const bestBid = sortedExitBids[0]?.price || 0;
    // Fix 7: Only check depth at best bid level (where our SELL order goes)
    const bidDepth = sortedExitBids.filter(b => b.price >= bestBid).reduce((s, b) => s + b.size, 0);

    if (bidDepth === 0 || bestBid === 0) {
      console.warn(`⚠️  No bid depth for ${pos.market} — cannot exit`);
      await sendTelegram(`⚠️ *Cannot exit ${pos.market}* — no bids in orderbook`);
      return { submitted: false };
    }

    let exitSize = size;
    let exitPrice = bestBid; // Use best bid for SELL

    if (bidDepth < exitSize) {
      if (bidDepth > 0) {
        // Partial exit only available depth
        console.warn(`⚠️  Bid depth ${bidDepth} < exit size ${exitSize} for ${pos.market} — partial exit only`);
        exitSize = Math.floor(bidDepth);
        if (exitSize === 0) {
          console.warn(`⚠️  Bid depth too small after flooring — skipping exit`);
          return { submitted: false };
        }
      } else {
        console.warn(`⚠️  Zero bid depth for ${pos.market} — skipping exit`);
        await sendTelegram(`⚠️ *Skipping exit for ${pos.market}* — zero bid depth`);
        return { submitted: false };
      }
    }

    const order = await placeOrder(pos.tokenId, 'SELL', exitPrice, exitSize, pos.marketData);

    // Fix 3: Set EXIT_SUBMITTED — do NOT call registerExit yet
    // The reconciliation loop / user WS will detect fill and call registerExit
    updatePositionStatus(pos.orderId, 'EXIT_SUBMITTED');
    // Fix 1: Persist exit metadata to risk_state.json (not just in-memory)
    setExitOrderMetadata(pos.orderId, order.orderID, exitSize, exitPrice, reason);

    // Fix 5: Do NOT call logExit here — logExit should only be called after confirmed fill
    // logExit is called from reconciliation/WS handler when the SELL fill is confirmed

    if (CONFIG.telegram.alertOnExit) {
      const pnl = (exitPrice - pos.entryPrice) * exitSize;
      const pnlPct = ((exitPrice - pos.entryPrice) / pos.entryPrice * 100);
      const pnlEmoji = pnl >= 0 ? '🟢' : '🔴';
      const pnlSign = pnl >= 0 ? '+' : '';
      await sendTelegramHTML([
        '💸 <b>EXIT ORDER SUBMITTED</b>',
        '',
        `📊 <b>Market:</b> ${pos.market}`,
        `📝 <b>Reason:</b> ${reason}`,
        `💰 <b>Exit Price:</b> $${exitPrice.toFixed(3)}`,
        `📦 <b>Size:</b> ${exitSize} tokens`,
        `${pnlEmoji} <b>PnL (est):</b> ${pnlSign}$${pnl.toFixed(2)} (${pnlSign}${pnlPct.toFixed(1)}%)`,
        `🆔 <b>Order ID:</b> <code>${order.orderID}</code>`,
        `<i>Awaiting fill...</i>`,
      ].join('\n'));
    }

    // Fix 5 (v1.3.2): Return success only after order is actually placed
    return { submitted: true, orderId: order.orderID, size: exitSize };
  } catch (err) {
    console.error(`❌ Exit failed for ${pos.market}: ${err.message}`);
    return { submitted: false };
  }
}
