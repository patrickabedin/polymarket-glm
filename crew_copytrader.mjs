// ═══════════════════════════════════════════════════════════════════════════════
//  CREW COPY-TRADER v4.0.2
//  Confirmed-swap · Cluster-consensus · CrewScore-weighted · Risk-gated · Shadow-mode
//  Fixes: P0-1 CrewScore schema, P0-2 Cluster schema, P0-3 crew.chain, P0-8 DexScreener price,
//         P0-9 APEX interface, P0-10 Stages, P0-11 Webhook, P1.1-P1.7
//
// ── Runtime Fixture Tests Required ──────────────────────────────────────────────
//  Before going live, verify these fixture tests pass:
//    1. Known wallet produces classified BUY and SELL
//    2. Raw transfer webhook does not become BUY
//    3. Webhook BUY and polling BUY produce same normalized shape
//    4. Two independent clusters produce COPY
//    5. Same cluster does not produce COPY
//    6. COPY below 25k net buy is blocked or truly downgraded
//    7. Missing candles produce alert-only
//    8. APEX Stage 1 writes once
//    9. APEX CLOSE_LONG consumed by APEX Manager
//   10. Shadow mode counts unique signals and records simulated exits
// ────────────────────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

import { setTimeout as sleep } from 'node:timers/promises';
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const APP_DIR = '/app/trading_engine';
const DATA_DIR = join(APP_DIR, 'data');

// ── R8 rounding ─────────────────────────────────────────────────────────────────
const R8 = (v) => Math.round(v * 1e8) / 1e8;

// ── Config v4.0.2 ───────────────────────────────────────────────────────────────
const CONFIG = {
  version: '4.0.2',
  // Discovery
  fingerprintEveryMs: 24 * 60 * 60 * 1000,
  crewPerCoin: 25,
  minRealizedUsd: 5000,
  // Live monitoring
  cycleIntervalMs: 5 * 60 * 1000,  // 5 min (was 20)
  walletDelayMs: 250,
  // Classification
  requireDecodedSwap: true,
  minIntentConfidence: 0.85,
  // Consensus
  consensusWindowMs: 6 * 60 * 60 * 1000,
  minCrewWallets: 2,
  minIndependentClusters: 1,
  minWeightedCrewScore: 80,
  minNetBuyUsd: 500,              // legacy — kept for backward compat
  radarMinNetBuyUsd: 0,          // low threshold for radar/testing
  copyMinNetBuyUsd: 25000,         // minimum for COPY execution
  maxMoveFromFirstCrewBuyPct: 18,
  // Radar
  radarMinWallets: 1,
  radarMinCrewScore: 80,
  radarMinLiqUsd: 100000,
  // Liquidity
  minTargetLiqUsdBitget: 500000,
  minTargetLiqUsdDex: 1000000,
  // Safety
  requireRiskGatePass: false,
  // Execution
  apexEnabled: true,
  shadowMode: true,  // start in shadow
  shadowAlerts: true, // send Telegram alerts in shadow mode (marked [SHADOW]) for manual trading
  shadowModeSignalCount: 20,
  maxApexRiskPct: 0.5,
  startingRiskPct: 0.25,
  maxSlippagePct: 1.5,
  // Exit
  exitMinClusters: 2,
  exitMinWeightedCrewScore: 100,
  reduceOnSingleHighScoreSell: true,
  highScoreSellThreshold: 85,
  singleWalletSellPctOfHoldings: 0.3,
  exitIfLiquidityDropsPct: 20,
  maxHoldHours: 18,
  // Protection
  dailyMaxLossR: -2,
  blockReentryAfterExitMs: 12 * 60 * 60 * 1000,
};

// ── Runtime state ───────────────────────────────────────────────────────────────
let shadowMode = CONFIG.shadowMode;
let shadowSignalCount = 0;
let shadowStats = { totalSignals: 0, wouldCopy: 0, wouldRadar: 0, wouldWatch: 0, simulatedPnlUsd: 0 };
let activePositions = new Map();  // tokenContract → position obj
let recentExits = new Map();      // tokenContract → timestamp
let dailyPnlR = 0;
let lastDailyReset = Date.now();
let crewCache = [];               // [{ address, coin, chain, firstSeen, ... }]
let crewScores = new Map();       // address → { score, tier, ... }
let crewClusters = new Map();     // address → clusterId
let clusterGroups = new Map();    // clusterId → [addresses]
let lastFingerprintTs = 0;
// Load persisted fingerprint timestamp to avoid re-running on every restart
try {
  const fpTs = JSON.parse(readFileSync(join(DATA_DIR, 'fingerprint_ts.json'), 'utf8'));
  lastFingerprintTs = fpTs.ts || 0;
} catch {}
let cycleCount = 0;
let lastSignalByToken = new Map(); // P1.2: per-token cooldowns
let shadowPositions = new Map();   // P1.1: shadow mode simulated positions

// ── Fix 4: Canonical chain key everywhere ──────────────────────────────────────
// Normalize all chain variants to a single canonical key.
// 'bsc', 'binance-smart-chain', '56', '0x38' → 'bsc'
// 'eth', 'ethereum', '1', '0x1' → 'eth'
function canonicalChain(chain) {
  if (!chain) return 'bsc';
  const c = String(chain).toLowerCase();
  if (c === 'bsc' || c === 'binance-smart-chain' || c === '56' || c === '0x38') return 'bsc';
  if (c === 'eth' || c === 'ethereum' || c === '1' || c === '0x1') return 'eth';
  return c;
}

// ── P0-3: Helper for crew.chain vs crew.chains ─────────────────────────────────
function getCrewChain(crew) {
  return canonicalChain(crew.chain || (crew.chains && crew.chains[0]) || 'binance-smart-chain');
}

// ── P0-8: Helper for DexScreener priceUsd vs price ─────────────────────────────
function getDexPrice(dexData) {
  return Number(dexData?.priceUsd ?? dexData?.price ?? 0);
}

// ── P1.2: Per-token cooldowns ──────────────────────────────────────────────────
function cooldownOk(token, action) {
  const key = `${action}:${token.toLowerCase()}`;
  const last = lastSignalByToken.get(key) || 0;
  const ttl = action === 'EXIT' ? 6 * 3600000 : 12 * 3600000;
  return Date.now() - last > ttl;
}

function markSignalSent(token, action) {
  const key = `${action}:${token.toLowerCase()}`;
  lastSignalByToken.set(key, Date.now());
}

// ── Lazy module loaders (resolved on droplet) ───────────────────────────────────
async function loadModules() {
  const mod = {
    getTopGainers: null,
    getDexData: null,
    computeTradePlan: null,
    formatPlanBlock: null,
    writeApexPosition: null,
    sendTelegram: null,
    logTelegramAlert: null,
    logSignal: null,
    getWalletActivity: null,
    scoreAllCrew: null,
    getTier: null,
    clusterWallets: null,
    getClusterId: null,
    checkTokenSafety: null,
  };

  try {
    const moralis = await import(`file://${APP_DIR}/core/moralis_wallets.mjs`);
    mod.getTopGainers = moralis.getTopGainers;
  } catch (e) { console.error('[FATAL] cannot load moralis_wallets.mjs:', e.message); }

  try {
    const dex = await import(`file://${APP_DIR}/core/dexscreener.mjs`);
    mod.getDexData = dex.getDexData;
  } catch (e) { console.error('[FATAL] cannot load dexscreener.mjs:', e.message); }

  try {
    const apex = await import(`file://${APP_DIR}/core/apex_plan.mjs`);
    mod.computeTradePlan = apex.computeTradePlan;
    mod.formatPlanBlock = apex.formatPlanBlock;
    mod.writeApexPosition = apex.writeApexPosition;
  } catch (e) { console.error('[FATAL] cannot load apex_plan.mjs:', e.message); }

  try {
    const tg = await import(`file://${APP_DIR}/core/telegram.mjs`);
    mod.sendTelegram = tg.send || tg.sendTelegram || tg.alertInfo || tg.default;
  } catch (e) { console.error('[WARN] cannot load telegram.mjs:', e.message); }

  try {
    const slog = await import(`file://${APP_DIR}/core/signal_logger.mjs`);
    mod.logTelegramAlert = slog.logTelegramAlert || slog.default;
    mod.logSignal = slog.logSignal;
  } catch (e) { console.error('[WARN] cannot load signal_logger.mjs:', e.message); }

  try {
    const classifier = await import(`file://${APP_DIR}/core/tx_classifier.mjs`);
    mod.getWalletActivity = classifier.getWalletActivity;
  } catch (e) { console.error('[FATAL] cannot load tx_classifier.mjs:', e.message); }

  try {
    const scorer = await import(`file://${APP_DIR}/core/crew_scorer.mjs`);
    mod.scoreAllCrew = scorer.scoreAllCrew;
    mod.getTier = scorer.getTier;
  } catch (e) { console.error('[FATAL] cannot load crew_scorer.mjs:', e.message); }

  try {
    const cluster = await import(`file://${APP_DIR}/core/wallet_clusterer.mjs`);
    mod.clusterWallets = cluster.clusterWallets;
    mod.getClusterId = cluster.getClusterId;
  } catch (e) { console.error('[FATAL] cannot load wallet_clusterer.mjs:', e.message); }

  try {
    const risk = await import(`file://${APP_DIR}/core/risk_gate.mjs`);
    mod.checkTokenSafety = risk.checkTokenSafety;
    mod.checkBitgetExecution = risk.checkBitgetExecution;
  } catch (e) { console.error('[FATAL] cannot load risk_gate.mjs:', e.message); }

  // P1.5: Fail-fast on missing required modules
  const required = ['getTopGainers', 'getDexData', 'getWalletActivity', 'scoreAllCrew', 'clusterWallets', 'checkTokenSafety', 'computeTradePlan', 'writeApexPosition'];
  for (const name of required) {
    if (!mod[name]) throw new Error(`Required module missing: ${name}`);
  }

  return mod;
}

let MOD = null;

// ── Utility: ensure data dir ────────────────────────────────────────────────────
function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

// ── Utility: read JSON file safely ──────────────────────────────────────────────
function readJsonSafe(path, fallback) {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

// ── Utility: append JSONL ───────────────────────────────────────────────────────
function appendJsonl(path, obj) {
  appendFileSync(path, JSON.stringify(obj) + '\n');
}

// ── Utility: log ────────────────────────────────────────────────────────────────
function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

// ── Load crew scores + clusters from disk or rebuild ────────────────────────────
async function loadCrewMetadata() {
  const scoresPath = join(DATA_DIR, 'crew_scores.json');
  const clustersPath = join(DATA_DIR, 'wallet_clusters.json');

  let scoresData = readJsonSafe(scoresPath, null);
  let clustersData = readJsonSafe(clustersPath, null);

  // P0-1: Treat empty {} score file as invalid
  const scoresEmpty = !scoresData || Object.keys(scoresData).length === 0;
  if (scoresEmpty && MOD.scoreAllCrew && crewCache.length > 0) {
    log('[CREW] No crew_scores.json found (or empty) — running scoreAllCrew()...');
    try {
      const crewWalletsData = readJsonSafe(join(DATA_DIR, 'crew_wallets.json'), {});
      const walletObjs = Object.values(crewWalletsData).map(w => ({
        address: w.addr,
        rugCount: (w.sources || []).length,
        realizedUsd: w.totalRealizedUsd || 0,
        lastActiveTs: Math.floor((w.firstSeen || Date.now()) / 1000),
      }));
      scoresData = await MOD.scoreAllCrew(walletObjs);
      writeFileSync(scoresPath, JSON.stringify(scoresData, null, 2));
    } catch (e) {
      log(`[ERROR] scoreAllCrew failed: ${e.message}`);
      scoresData = {};
    }
  }

  if (!clustersData && MOD.clusterWallets && crewCache.length > 0) {
    log('[CREW] No wallet_clusters.json found — running clusterWallets()...');
    try {
      clustersData = await MOD.clusterWallets(crewCache.map(c => c.address));
      writeFileSync(clustersPath, JSON.stringify(clustersData, null, 2));
    } catch (e) {
      log(`[ERROR] clusterWallets failed: ${e.message}`);
      clustersData = {};
    }
  }

  // Build maps
  crewScores.clear();
  crewClusters.clear();
  clusterGroups.clear();

  // P0-1: Fix CrewScore schema mismatch — scorer writes { crewScore, rugCount, totalRealizedUsd, tier }
  if (scoresData) {
    for (const [addr, info] of Object.entries(scoresData)) {
      const score = info.score ?? info.crewScore ?? 0;
      crewScores.set(addr.toLowerCase(), {
        score,
        tier: info.tier || (MOD.getTier ? MOD.getTier(score) : 'D'),
      });
    }
  }

  // P0-2: Fix Cluster schema mismatch — support both { wallet: clusterId } and { clusterId: [wallets] }
  if (clustersData) {
    for (const [key, val] of Object.entries(clustersData)) {
      if (Array.isArray(val)) {
        // clusterId -> [wallets]
        const clusterId = key;
        for (const wallet of val) {
          const lc = wallet.toLowerCase();
          crewClusters.set(lc, clusterId);
          if (!clusterGroups.has(clusterId)) clusterGroups.set(clusterId, []);
          clusterGroups.get(clusterId).push(lc);
        }
      } else {
        // wallet -> clusterId
        const lc = key.toLowerCase();
        const clusterId = val;
        crewClusters.set(lc, clusterId);
        if (!clusterGroups.has(clusterId)) clusterGroups.set(clusterId, []);
        clusterGroups.get(clusterId).push(lc);
      }
    }
  }

  log(`[CREW] Loaded ${crewScores.size} scores, ${crewClusters.size} cluster mappings (${clusterGroups.size} clusters)`);
}

// ── Fingerprinting: discover crew wallets ───────────────────────────────────────
async function runFingerprinting() {
  log('[FINGERPRINT] Starting crew discovery...');
  try {
    const watchlist = readJsonSafe(join(DATA_DIR, 'post_rug_watchlist.json'), {});
    const contractMap = readJsonSafe(join(DATA_DIR, 'contract_map.json'), {});
    const watchSymbols = Object.keys(watchlist);
    log(`[FINGERPRINT] Processing ${watchSymbols.length} watchlist coins...`);

    const walletMap = new Map();
    let processed = 0, skipped = 0;

    for (const sym of watchSymbols) {
      const entry = watchlist[sym];
      const contractEntry = entry?.contract || contractMap[sym]?.contract;
      const chain = canonicalChain(entry?.chain || contractMap[sym]?.chain || 'binance-smart-chain');

      if (!contractEntry) {
        log(`[FINGERPRINT] ${sym} — no contract address, skipping`);
        skipped++;
        continue;
      }

      try {
        const gainers = await MOD.getTopGainers(contractEntry, chain, CONFIG.crewPerCoin);
        if (!gainers || gainers.length === 0) {
          log(`[FINGERPRINT] ${sym} — no top gainers returned`);
          processed++;
          continue;
        }

        for (const g of gainers) {
          const addr = (g.addr || '').toLowerCase();
          if (!addr || addr === '0x000000000000000000000000000000000000dead') continue;
          if (g.realizedProfitUsd < CONFIG.minRealizedUsd) continue;

          if (!walletMap.has(addr)) {
            walletMap.set(addr, {
              address: addr,
              sources: [sym],
              totalRealizedUsd: g.realizedProfitUsd,
              chains: [chain],
              firstSeen: Date.now(),
              lastActive: Date.now(),
              swapCount: g.trades || 1,
            });
          } else {
            const w = walletMap.get(addr);
            if (!w.sources.includes(sym)) w.sources.push(sym);
            w.totalRealizedUsd += g.realizedProfitUsd;
            if (!w.chains.includes(chain)) w.chains.push(chain);
            w.lastActive = Date.now();
            w.swapCount += (g.trades || 1);
          }
        }
        processed++;
        log(`[FINGERPRINT] ${sym} — ${gainers.length} gainers found`);
      } catch (e) {
        log(`[FINGERPRINT] ${sym} — error: ${e.message}`);
      }
      await sleep(CONFIG.walletDelayMs);
    }

    const allWallets = [...walletMap.values()].sort((a, b) => b.totalRealizedUsd - a.totalRealizedUsd);
    crewCache = allWallets.filter(w => w.sources.length >= 2);
    const singleRug = allWallets.filter(w => w.sources.length < 2);

    log(`[FINGERPRINT] Done. ${processed} coins processed, ${skipped} skipped. ${allWallets.length} total wallets, ${crewCache.length} multi-rug crew, ${singleRug.length} single-rug`);
    if (allWallets.length === 0 && processed > 0) {
      log(`[FINGERPRINT] ⚠️  ALL ${processed} coins returned 0 gainers — Moralis API may be down or key invalid!`);
    }

    const crewOut = {};
    for (const w of allWallets) {
      crewOut[w.address] = {
        addr: w.address,
        chain: w.chains[0],
        chains: w.chains,
        sources: w.sources,
        totalRealizedUsd: w.totalRealizedUsd,
        firstSeen: w.firstSeen,
        isCrew: w.sources.length >= 2,
        crewType: w.sources.length >= 2 ? 'multi-rug' : 'single-rug',
      };
    }
    writeFileSync(join(DATA_DIR, 'crew_wallets.json'), JSON.stringify(crewOut, null, 2));
    writeFileSync(join(DATA_DIR, 'crew_cache.json'), JSON.stringify(crewCache, null, 2));

    await loadCrewMetadata();

    lastFingerprintTs = Date.now();
    try { writeFileSync(join(DATA_DIR, 'fingerprint_ts.json'), JSON.stringify({ ts: lastFingerprintTs })); } catch {}
  } catch (e) {
    log(`[FINGERPRINT] Error: ${e.message}`);
  }
}

// ── Signal Scoring (0-100) ──────────────────────────────────────────────────────
function computeSignalScore(params) {
  const {
    crewQuality,        // 0-25
    clusterIndependence,// 0-20
    netBuyUsd,          // 0-15
    timingCompression,  // 0-10
    liquidityQuality,   // 0-10
    contractSafety,     // 0-10
    pricePosition,      // 0-5
    exchangeDepth,      // 0-5
  } = params;

  return R8(
    (crewQuality || 0) +
    (clusterIndependence || 0) +
    (netBuyUsd || 0) +
    (timingCompression || 0) +
    (liquidityQuality || 0) +
    (contractSafety || 0) +
    (pricePosition || 0) +
    (exchangeDepth || 0)
  );
}

function scoreToAction(score) {
  if (score >= 85) return 'STRONG_COPY';
  if (score >= 70) return 'COPY';
  if (score >= 55) return 'WATCH';
  if (score >= 40) return 'RADAR';
  return 'IGNORE';
}

// ── Sub-score calculators ───────────────────────────────────────────────────────
function calcCrewQualityScore(buyers) {
  if (!buyers || buyers.length === 0) return 0;
  const validBuyers = buyers.filter(b => (b.crewScore || 0) >= 60);
  if (validBuyers.length === 0) return 0;
  const sum = validBuyers.reduce((s, b) => s + b.crewScore, 0);
  return Math.min(25, R8(sum / (CONFIG.minCrewWallets * 100) * 25));
}

function calcClusterIndependenceScore(uniqueClusters) {
  if (uniqueClusters <= 1) return 0;
  if (uniqueClusters === 2) return 10;
  if (uniqueClusters === 3) return 15;
  return 20;
}

function calcNetBuyScore(netBuyUsd) {
  if (netBuyUsd >= 200000) return 15;
  if (netBuyUsd >= 100000) return 12;
  if (netBuyUsd >= 50000) return 8;
  if (netBuyUsd >= 25000) return 5;
  return Math.max(0, R8(netBuyUsd / 25000 * 5));
}

function calcTimingScore(buyTimestamps) {
  if (!buyTimestamps || buyTimestamps.length < 2) return 0;
  const sorted = [...buyTimestamps].sort((a, b) => a - b);
  const span = sorted[sorted.length - 1] - sorted[0];
  const spanMin = span / 60000;
  if (spanMin <= 30) return 10;
  if (spanMin <= 60) return 7;
  if (spanMin <= 120) return 5;
  if (spanMin <= 360) return 3;
  return 1;
}

function calcLiquidityScore(liqUsd, isDex) {
  const threshold = isDex ? CONFIG.minTargetLiqUsdDex : CONFIG.minTargetLiqUsdBitget;
  if (liqUsd >= threshold * 5) return 10;
  if (liqUsd >= threshold * 2) return 8;
  if (liqUsd >= threshold) return 5;
  if (liqUsd >= threshold * 0.5) return 3;
  return 0;
}

function calcSafetyScore(safetyResult) {
  if (!safetyResult) return 0;
  if (safetyResult.passed === false) return 0;
  const warnings = safetyResult.warnings || [];
  if (warnings.length === 0) return 10;
  if (warnings.length === 1) return 6;
  return 3;
}

function calcPricePositionScore(movePct) {
  if (movePct <= 0) return 5;
  if (movePct <= 5) return 4;
  if (movePct <= 10) return 3;
  if (movePct <= 15) return 1;
  return 0;
}

function calcExchangeDepthScore(dexData) {
  if (!dexData || !dexData.exchanges) return 0;
  const count = dexData.exchanges.length;
  if (count >= 3) return 5;
  if (count >= 2) return 3;
  if (count >= 1) return 2;
  return 0;
}

// ── Check price move from first crew buy ────────────────────────────────────────
async function checkPriceMove(firstBuyPrice, currentPrice) {
  if (!firstBuyPrice || !currentPrice || firstBuyPrice <= 0) return 0;
  return R8(((currentPrice - firstBuyPrice) / firstBuyPrice) * 100);
}

// ── Risk gate wrapper (Fix 4: Check Bitget first, pass cex/dex mode to risk_gate) ──
async function runRiskGate(tokenContract, chain, dexData) {
  try {
    // Fix 4: Check Bitget tradeability FIRST to determine cex vs dex mode
    // If token is tradeable on Bitget, use relaxed (CEX) liquidity thresholds
    // If not, use stricter (DEX-only) thresholds
    let bitgetTradeable = false;
    try {
      // Extract symbol from dexData or tokenContract
      const symbol = dexData?.baseToken?.symbol || dexData?.symbol || null;
      if (symbol && MOD.checkBitgetExecution) {
        const bitgetResult = await MOD.checkBitgetExecution(symbol);
        bitgetTradeable = bitgetResult?.ok === true;
      }
    } catch {
      // If Bitget check fails, assume not tradeable (conservative)
    }

    // Fix 2: Pass dexOnly flag AND isBitgetTradeable flag to checkTokenSafety
    // For Bitget-tradeable tokens, LP lock is skipped in checkTokenSafety
    const isDexOnly = !bitgetTradeable && !dexData?.listedOnCex;
    const result = await MOD.checkTokenSafety(tokenContract, chain, dexData, {
      dexOnly: isDexOnly,
      isBitgetTradeable,
    });
    return result;
  } catch (e) {
    log(`[RISK_GATE] Error checking ${tokenContract}: ${e.message}`);
    return { passed: false, error: e.message, warnings: ['risk_gate_error'] };
  }
}

// ── Build rich HTML alert message (COPY / STRONG_COPY only) ──────────────────
function buildRichAlert(action, params) {
  const {
    symbol, signalScore, action: act,
    clusters, netBuyUsd, liquidityUsd, safetyResult,
    tradePlan, crewBuyers, firstBuyPrice, currentPrice, movePct,
    tokenAddress, chain,
  } = params;

  const isStrong = action === 'STRONG_COPY';
  const header = isStrong ? '🐺🐺 WOLFPACK STRONG COPY' : '🐺 WOLFPACK COPY';
  const urgency = isStrong ? '🔴 HIGH CONVICTION' : '🟡 CONVICTION';

  // Compute net buy with fallback: if netBuyUsd is 0, estimate from crew buyer count × avg position
  let displayNetBuy = netBuyUsd || 0;
  if (displayNetBuy === 0 && crewBuyers && crewBuyers.length > 0) {
    // Estimate: use DexScreener price × sum of valueFormatted from crew buys
    const price = currentPrice || firstBuyPrice || 0;
    const totalTokens = crewBuyers.reduce((s, b) => s + (b.valueFormatted || 0), 0);
    if (price > 0 && totalTokens > 0) {
      displayNetBuy = totalTokens * price;
    }
  }

  const lines = [];
  lines.push(`<b>${header}</b>`);
  lines.push(`<b>${urgency} — CREW IS BUYING</b>`);
  lines.push('');
  lines.push(`<b>📊 Token:</b> ${symbol} (${chain.toUpperCase()})`);
  lines.push(`<b>🎯 Direction:</b> LONG`);
  lines.push(`<b>📈 Score:</b> ${signalScore}/100`);
  lines.push('');
  lines.push(`<b>🐋 Crew Buyers:</b> ${crewBuyers?.length || 0} wallets across ${clusters} cluster(s)`);
  lines.push(`<b>💰 Net Buy:</b> $${displayNetBuy.toLocaleString(undefined, {maximumFractionDigits: 0})}`);
  lines.push(`<b>💧 Liquidity:</b> $${(liquidityUsd || 0).toLocaleString()}`);
  lines.push(`<b>💵 Price:</b> $${R8(currentPrice || 0)}`);
  const move = movePct || 0;
  const moveEmoji = move > 5 ? '🚀' : move > 0 ? '📈' : '📉';
  lines.push(`<b>${moveEmoji} Move from crew entry:</b> ${move >= 0 ? '+' : ''}${move.toFixed(1)}%`);
  lines.push('');

  // Call to action
  lines.push('<b>⚡ ACTION:</b>');
  const dexUrl = `https://dexscreener.com/${chain === 'bsc' ? 'bsc' : 'ethereum'}/${tokenAddress}`;
  lines.push(`• Check chart: <a href="${dexUrl}">DexScreener</a>`);
  if (tradePlan) {
    lines.push(`• Trade plan: ${tradePlan}`);
  }
  lines.push('');

  // Crew buyer details
  if (crewBuyers && crewBuyers.length > 0) {
    lines.push('<b>── Crew Buyers ──</b>');
    for (const b of crewBuyers.slice(0, 8)) {
      const shortAddr = `${b.address.slice(0, 6)}...${b.address.slice(-4)}`;
      const usdStr = (b.usdValue || 0) > 0 ? `$${(b.usdValue || 0).toLocaleString(undefined, {maximumFractionDigits: 0})}` : 'N/A';
      lines.push(`  • <code>${shortAddr}</code> | Score: ${b.crewScore} (${b.tier}) | ${usdStr}`);
    }
  }

  lines.push('');
  lines.push(`<i>⏰ ${new Date().toISOString()}</i>`);
  lines.push(`<i>Shadow mode — manual execution required</i>`);

  return lines.join('\n');
}

// ── Build alert message (legacy, kept for non-Telegram logging) ──────────────
function buildAlertMessage(action, params) {
  const {
    symbol, signalScore, action: act,
    clusters, netBuyUsd, liquidityUsd, safetyResult,
    tradePlan, crewBuyers, firstBuyPrice, currentPrice, movePct,
  } = params;

  const lines = [];
  const emoji = action === 'STRONG_COPY' || action === 'COPY' ? '🐺' : action === 'EXIT' ? '🚪' : action === 'ALERT_ONLY' ? '⚠️' : '📡';
  const actionLabel = action === 'STRONG_COPY' ? 'STRONG COPY' :
                      action === 'COPY' ? 'COPY' :
                      action === 'WATCH' ? 'WATCH' :
                      action === 'RADAR' ? 'RADAR' :
                      action === 'ALERT_ONLY' ? 'ALERT ONLY' : 'EXIT';

  lines.push(`${emoji} CREW ${actionLabel} · ${symbol} · LONG`);
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push(`Score: ${signalScore}/100 (${act})`);
  lines.push(`Crew Buyers: ${crewBuyers?.length || 0} | Clusters: ${clusters}`);
  lines.push(`Net Buy: $${(netBuyUsd || 0).toLocaleString()}`);
  lines.push(`Liquidity: $${(liquidityUsd || 0).toLocaleString()}`);
  lines.push(`Price: $${R8(currentPrice || 0)} (move: ${(movePct || 0) >= 0 ? '+' : ''}${movePct || 0}% from crew)`);
  lines.push(`Safety: ${safetyResult?.passed ? '✅ PASS' : '❌ FAIL'}${safetyResult?.warnings?.length ? ` (${safetyResult.warnings.length} warnings)` : ''}`);

  if (tradePlan) {
    lines.push('');
    lines.push('── Trade Plan ──');
    lines.push(tradePlan);
  }

  if (action === 'STRONG_COPY' || action === 'COPY') {
    lines.push('');
    lines.push('── Crew Buyers ──');
    for (const b of (crewBuyers || []).slice(0, 5)) {
      lines.push(`  ${b.address.slice(0, 8)}...${b.address.slice(-4)} | Score: ${b.crewScore} (${b.tier}) | Cluster: ${b.clusterId} | $${(b.usdValue || 0).toLocaleString()}`);
    }
  }

  lines.push('');
  lines.push(`⏰ ${new Date().toISOString()}`);

  return lines.join('\n');
}

// ── Shadow mode logging ─────────────────────────────────────────────────────────
function logShadow(signal) {
  const path = join(DATA_DIR, 'crew_v4_shadow.jsonl');
  appendJsonl(path, { ts: Date.now(), ...signal });
  shadowSignalCount++;
  shadowStats.totalSignals++;

  if (signal.action === 'STRONG_COPY' || signal.action === 'COPY') {
    shadowStats.wouldCopy++;
  } else if (signal.action === 'WATCH') {
    shadowStats.wouldWatch++;
  } else if (signal.action === 'RADAR') {
    shadowStats.wouldRadar++;
  }

  log(`[SHADOW] Signal #${shadowSignalCount}: ${signal.action} ${signal.symbol} score=${signal.signalScore} (wouldCopy=${shadowStats.wouldCopy})`);

  // P1.1: Check if we should exit shadow mode using simulated PnL
  if (shadowSignalCount >= CONFIG.shadowModeSignalCount) {
    const expectancy = shadowStats.simulatedPnlUsd / Math.max(1, shadowStats.wouldCopy);
    if (expectancy > 0) {
      log(`[SHADOW] ${shadowSignalCount} signals reached. Positive expectancy ($${expectancy.toFixed(2)}/trade). Switching to LIVE mode.`);
      shadowMode = false;
    } else {
      log(`[SHADOW] ${shadowSignalCount} signals reached but negative expectancy ($${expectancy.toFixed(2)}/trade). Extending shadow mode.`);
      shadowSignalCount = 0;
    }
  }
}

// ── P1.1: Shadow mode simulated PnL tracking ───────────────────────────────────
function trackShadowEntry(signal, dexData) {
  const tokenKey = signal.tokenAddress.toLowerCase();
  shadowPositions.set(tokenKey, {
    symbol: signal.symbol,
    tokenAddress: signal.tokenAddress,
    chain: signal.chain,
    entryPrice: getDexPrice(dexData),
    entryLiquidityUsd: dexData?.liquidityUsd || 0, // Fix 9: store entry liquidity for comparison
    entryTime: Date.now(),
    signalScore: signal.signalScore,
    sizeUsd: 1000, // simulated $1000 per trade
  });
}

function trackShadowExit(tokenAddress, exitPrice) {
  const tokenKey = tokenAddress.toLowerCase();
  const pos = shadowPositions.get(tokenKey);
  if (!pos) return;
  const realizedPnl = ((exitPrice - pos.entryPrice) / pos.entryPrice) * pos.sizeUsd;
  shadowStats.simulatedPnlUsd += realizedPnl;
  shadowPositions.delete(tokenKey);
  log(`[SHADOW-PNL] Closed ${pos.symbol}: entry=$${pos.entryPrice} exit=$${exitPrice} PnL=$${realizedPnl.toFixed(2)} (total: $${shadowStats.simulatedPnlUsd.toFixed(2)})`);
}

// ── P0-9: Helper to read 1H candles from Valkey ────────────────────────────────
async function readCandlesFromValkey(symbol, chain) {
  try {
    const valkeyCfg = readJsonSafe(join(DATA_DIR, 'valkey_config.json'), null);
    if (!valkeyCfg?.host) return null;
    const { createClient } = await import('redis');
    const client = createClient({
      socket: { host: valkeyCfg.host, port: valkeyCfg.port, tls: valkeyCfg.tls ?? true },
      password: valkeyCfg.password,
    });
    client.on('error', () => {});
    await client.connect();
    const key = `candles:1h:${chain}:${symbol}`;
    const raw = await client.get(key);
    await client.quit();
    if (!raw) return null;
    const candles = JSON.parse(raw);
    if (!Array.isArray(candles) || candles.length === 0) return null;
    return candles;
  } catch (e) {
    return null;
  }
}

// ── Fix 8: Bitget execution check wrapper ─────────────────────────────────────
async function checkBitget(symbol) {
  try {
    if (!MOD.checkBitgetExecution) return { ok: true, reason: 'checkBitgetExecution not loaded — skipping' };
    return await MOD.checkBitgetExecution(symbol);
  } catch (e) {
    log(`[BITGET] Error checking ${symbol}: ${e.message}`);
    return { ok: false, reason: e.message };
  }
}

// ── Execute COPY signal ─────────────────────────────────────────────────────────
async function executeCopy(signal, dexData) {
  const { symbol, tokenAddress, chain, signalScore, action, tradePlan } = signal;

  // P1.2: Check cooldown
  if (!cooldownOk(tokenAddress, 'COPY')) {
    log(`[COPY] Cooldown active for ${symbol} — skipping`);
    return;
  }

  if (shadowMode) {
    logShadow(signal);
    // P1.1: Track simulated position
    trackShadowEntry(signal, dexData);
    // Fix 8: Apply cooldowns in shadow mode too, so repeated signals don't inflate the 20-signal threshold
    markSignalSent(tokenAddress, 'COPY');
    // Only send Telegram for COPY and STRONG_COPY — skip WATCH/RADAR noise
    if (CONFIG.shadowAlerts && MOD.sendTelegram && (action === 'COPY' || action === 'STRONG_COPY')) {
      const shadowMsg = buildRichAlert(action, {
        ...signal,
        tradePlan,
        liquidityUsd: dexData?.liquidityUsd || 0,
        currentPrice: getDexPrice(dexData),
      });
      try { await MOD.sendTelegram(shadowMsg); } catch (e) { log(`[TELEGRAM] Shadow alert failed: ${e.message}`); }
    }
    // Fix 8: Log shadow signal to jsonl
    appendJsonl(join(DATA_DIR, 'crew_copytrader.jsonl'), {
      ts: Date.now(),
      type: 'COPY',
      symbol,
      tokenAddress,
      chain,
      signalScore,
      action,
      clusters: signal.clusters,
      netBuyUsd: signal.netBuyUsd,
      crewBuyers: signal.crewBuyers?.length || 0,
      shadowMode: true,
    });
    log(`[COPY] Shadow ${action} for ${symbol} (score=${signalScore})`);
    return;
  }

  // Live mode: send alert + drop APEX position + log
  // Only send Telegram for COPY and STRONG_COPY
  if (action === 'COPY' || action === 'STRONG_COPY') {
    const alertMsg = buildRichAlert(action, {
      ...signal,
      tradePlan,
      liquidityUsd: dexData?.liquidityUsd || 0,
      currentPrice: getDexPrice(dexData),
    });
    if (MOD.sendTelegram) {
      try {
        await MOD.sendTelegram(alertMsg);
      } catch (e) {
        log(`[TELEGRAM] Send failed: ${e.message}`);
      }
    }
  }

  // Log to signal logger
  if (MOD.logSignal) {
    try {
      await MOD.logSignal({
        type: 'CREW_COPY',
        symbol,
        tokenAddress,
        chain,
        score: signalScore,
        action,
        clusters: signal.clusters,
        netBuyUsd: signal.netBuyUsd,
        timestamp: Date.now(),
      });
    } catch (e) {
      log(`[SIGNAL_LOG] Error: ${e.message}`);
    }
  }

  // P0-9 + P0-10: APEX execution — only write Stage 1, store pending stages
  if (CONFIG.apexEnabled && MOD.writeApexPosition) {
    try {
      const riskPct = action === 'STRONG_COPY' ? CONFIG.maxApexRiskPct : CONFIG.startingRiskPct;
      const baseSize = riskPct / 100;
      const currentPrice = getDexPrice(dexData);

      // Fix 5: Read 1H candles for APEX — if missing, do NOT write APEX, alert only
      let candles1h = await readCandlesFromValkey(symbol, chain);
      if (!candles1h) {
        log(`[APEX] No real candle data for ${symbol} — skipping APEX write, alert only`);
        signal.action = 'ALERT_ONLY';
        signal.apexSkipped = true;
        // Fix 7: Alert clearly states APEX is skipped — do NOT treat as executable
        if (MOD.sendTelegram) {
          try { await MOD.sendTelegram(`⚠️ ALERT ONLY / APEX SKIPPED — No candle data for ${symbol}. Manual execution required.`); } catch (e) { /* non-fatal */ }
        }
        // Alert was already sent above (Telegram + signal logger). Skip APEX position.
        markSignalSent(tokenAddress, 'COPY');
        appendJsonl(join(DATA_DIR, 'crew_copytrader.jsonl'), {
          ts: Date.now(),
          type: 'COPY',
          symbol,
          tokenAddress,
          chain,
          signalScore,
          action,
          clusters: signal.clusters,
          netBuyUsd: signal.netBuyUsd,
          crewBuyers: signal.crewBuyers?.length || 0,
          shadowMode: false,
          apexSkipped: 'no_candle_data',
        });
        log(`[COPY] Executed ${action} for ${symbol} (score=${signalScore}) — APEX skipped (no candles)`);
        return;
      }

      // P0-9: Call computeTradePlan with correct signature (candles1h, price, side)
      const plan = MOD.computeTradePlan(candles1h, currentPrice, 'LONG');

      // Fix 6: Null-plan guard — if plan is null (insufficient candles), alert only
      if (!plan) {
        log(`[APEX] APEX plan null — alert only, no position written for ${symbol}`);
        signal.action = 'ALERT_ONLY';
        signal.apexSkipped = true;
        // Fix 7: Alert clearly states APEX is skipped — do NOT treat as executable
        if (MOD.sendTelegram) {
          try { await MOD.sendTelegram(`⚠️ ALERT ONLY / APEX SKIPPED — APEX plan null for ${symbol}. Manual execution required.`); } catch (e) { /* non-fatal */ }
        }
        markSignalSent(tokenAddress, 'COPY');
        appendJsonl(join(DATA_DIR, 'crew_copytrader.jsonl'), {
          ts: Date.now(),
          type: 'COPY',
          symbol,
          tokenAddress,
          chain,
          signalScore,
          action,
          clusters: signal.clusters,
          netBuyUsd: signal.netBuyUsd,
          crewBuyers: signal.crewBuyers?.length || 0,
          shadowMode: false,
          apexSkipped: 'null_plan',
          alertOnly: true,
        });
        log(`[COPY] Executed ${action} for ${symbol} (score=${signalScore}) — APEX plan null, alert only`);
        return;
      }

      // P0-9: Call writeApexPosition with correct interface
      const writeResult = await MOD.writeApexPosition({
        engine: 'CREW_COPYTRADER',
        symbol,
        side: 'LONG',
        entry: plan.entry || plan.entryPrice || currentPrice,
        stop: plan.stop || plan.stopLoss || currentPrice * 0.85,
        meta: {
          tokenAddress,
          chain,
          signalScore,
          crewBuyers: signal.crewBuyers?.length || 0,
          riskPct,
          stage: 1,
        },
      });

      // P0-10: Only mark position active if file was written successfully
      if (writeResult !== false && writeResult?.error !== true) {
        // P0-10: Only write Stage 1 (40%) at initial COPY signal
        activePositions.set(tokenAddress.toLowerCase(), {
          symbol,
          tokenAddress,
          chain,
          entryPrice: currentPrice,
          entryTime: Date.now(),
          signalScore,
          stagesFilled: 1,
          pendingStages: {
            stage2: { condition: 'SECOND_CONFIRMATION', filled: false },
            stage3: { condition: 'MOMENTUM_LIQUIDITY_CONFIRM', filled: false },
          },
          liquidityAtEntry: dexData?.liquidityUsd || 0,
          riskPct,
          baseSize,
          plan,
        });
        log(`[APEX] Stage 1 position written for ${symbol} (risk=${riskPct}%, entry=${currentPrice})`);
      } else {
        log(`[APEX] writeApexPosition returned error for ${symbol} — position not activated`);
      }
    } catch (e) {
      log(`[APEX] Error writing position: ${e.message}`);
    }
  }

  markSignalSent(tokenAddress, 'COPY');

  // Log to crew_copytrader.jsonl
  appendJsonl(join(DATA_DIR, 'crew_copytrader.jsonl'), {
    ts: Date.now(),
    type: 'COPY',
    symbol,
    tokenAddress,
    chain,
    signalScore,
    action,
    clusters: signal.clusters,
    netBuyUsd: signal.netBuyUsd,
    crewBuyers: signal.crewBuyers?.length || 0,
    shadowMode: false,
  });

  log(`[COPY] Executed ${action} for ${symbol} (score=${signalScore})`);
}

// ── P0-10: Check scale-ins for pending stages ──────────────────────────────────
async function checkScaleIns() {
  for (const [tokenKey, position] of activePositions) {
    if (!position.pendingStages) continue;

    const { symbol, tokenAddress, chain, riskPct, baseSize } = position;
    let dexData = null;
    try {
      dexData = await MOD.getDexData(tokenAddress, chain);
    } catch (e) {
      continue;
    }
    if (!dexData) continue;

    const currentPrice = getDexPrice(dexData);
    const moveFromEntry = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;

    // Stage 2: Second confirmation — price hasn't dropped more than 5% and new crew buys
    if (!position.pendingStages.stage2.filled) {
      if (moveFromEntry > -5) {
        // Fix 7: Query crew wallets with token filter, not token as wallet
        try {
          let recentBuys = [];
          for (const crew of crewCache) {
            if (getCrewChain(crew) !== chain) continue;
            const crewActivity = await MOD.getWalletActivity(crew.address, chain, { tokenFilter: tokenAddress, limit: 10 });
            if (!crewActivity) continue;
            const crewBuys = crewActivity.filter(a =>
              a.side === 'BUY' &&
              a.intentConfidence >= CONFIG.minIntentConfidence &&
              crewScores.has(crew.address.toLowerCase()) &&
              new Date(a.blockTime || a.timestamp || 0).getTime() > position.entryTime
            );
            recentBuys.push(...crewBuys);
            if (recentBuys.length >= 1) break;
          }
          if (recentBuys.length >= 1) {
            // Write Stage 2 position
            if (CONFIG.apexEnabled && MOD.writeApexPosition) {
              // Fix 5: Do not create fake candles — skip APEX if no real candle data
              const candles1h = await readCandlesFromValkey(symbol, chain);
              if (!candles1h) {
                log(`[SCALE-IN] No candle data for ${symbol} — skipping Stage 2 APEX write`);
                // Fix 7: Do NOT mark stage as filled if APEX write was skipped
                continue;
              }
              const plan = MOD.computeTradePlan(candles1h, currentPrice, 'LONG');
              // Fix 7: Null-plan guard for scale-ins
              if (!plan) {
                log(`[SCALE-IN] APEX plan null for ${symbol} Stage 2 — not marking as filled`);
                continue;
              }
              const stage2WriteResult = await MOD.writeApexPosition({
                engine: 'CREW_COPYTRADER',
                symbol,
                side: 'LONG',
                entry: plan.entry || plan.entryPrice || currentPrice,
                stop: plan.stop || plan.stopLoss || currentPrice * 0.85,
                meta: { tokenAddress, chain, signalScore: position.signalScore, stage: 2, riskPct },
              });
              // Fix 7: Only mark Stage 2 as filled AFTER confirmed successful APEX write
              if (stage2WriteResult !== false && stage2WriteResult?.error !== true) {
                position.pendingStages.stage2.filled = true;
                position.stagesFilled = 2;
                log(`[SCALE-IN] Stage 2 filled for ${symbol} at $${currentPrice}`);
              } else {
                log(`[SCALE-IN] Stage 2 APEX write FAILED for ${symbol} — not marking as filled`);
              }
            }
          }
        } catch (e) { /* non-fatal */ }
      }
    }

    // Stage 3: Momentum + liquidity confirmation
    if (!position.pendingStages.stage3.filled && position.pendingStages.stage2.filled) {
      const liqUsd = dexData.liquidityUsd || 0;
      const liqOk = liqUsd >= position.liquidityAtEntry * 1.2;
      const momentumOk = moveFromEntry > 3; // up at least 3%
      if (liqOk && momentumOk) {
        if (CONFIG.apexEnabled && MOD.writeApexPosition) {
          // Fix 5: Do not create fake candles — skip APEX if no real candle data
          const candles1h = await readCandlesFromValkey(symbol, chain);
          if (!candles1h) {
            log(`[SCALE-IN] No candle data for ${symbol} — skipping Stage 3 APEX write`);
            // Fix 7: Do NOT mark stage as filled if APEX write was skipped
            continue;
          }
          const plan = MOD.computeTradePlan(candles1h, currentPrice, 'LONG');
          // Fix 7: Null-plan guard for scale-ins
          if (!plan) {
            log(`[SCALE-IN] APEX plan null for ${symbol} Stage 3 — not marking as filled`);
            continue;
          }
          const stage3WriteResult = await MOD.writeApexPosition({
            engine: 'CREW_COPYTRADER',
            symbol,
            side: 'LONG',
            entry: plan.entry || plan.entryPrice || currentPrice,
            stop: plan.stop || plan.stopLoss || currentPrice * 0.85,
            meta: { tokenAddress, chain, signalScore: position.signalScore, stage: 3, riskPct },
          });
          // Fix 7: Only mark Stage 3 as filled AFTER confirmed successful APEX write
          if (stage3WriteResult !== false && stage3WriteResult?.error !== true) {
            position.pendingStages.stage3.filled = true;
            position.stagesFilled = 3;
            log(`[SCALE-IN] Stage 3 filled for ${symbol} at $${currentPrice}`);
          } else {
            log(`[SCALE-IN] Stage 3 APEX write FAILED for ${symbol} — not marking as filled`);
          }
        }
      }
    }
  }
}

// ── Execute Radar (alert only) ──────────────────────────────────────────────────
async function executeRadar(signal) {
  // P1.2: Check cooldown (Fix 8: apply in shadow mode too)
  if (!cooldownOk(signal.tokenAddress, 'RADAR')) {
    log(`[RADAR] Cooldown active for ${signal.symbol} — skipping`);
    return;
  }

  if (shadowMode) {
    logShadow(signal);
    markSignalSent(signal.tokenAddress, 'RADAR');
    return;
  }

  // RADAR signals are not sent to Telegram — only COPY/STRONG_COPY alerts
  markSignalSent(signal.tokenAddress, 'RADAR');

  appendJsonl(join(DATA_DIR, 'crew_copytrader.jsonl'), {
    ts: Date.now(),
    type: 'RADAR',
    symbol: signal.symbol,
    tokenAddress: signal.tokenAddress,
    chain: signal.chain,
    signalScore: signal.signalScore,
    shadowMode: false,
  });

  log(`[RADAR] Alerted ${signal.symbol} (score=${signal.signalScore})`);
}

// ── Check exit conditions for active positions ─────────────────────────────────
async function checkExits(dexDataCache) {
  for (const [tokenKey, position] of activePositions) {
    const { symbol, tokenAddress, chain, entryPrice, entryTime, liquidityAtEntry } = position;

    // Max hold time
    const holdHours = (Date.now() - entryTime) / 3600000;
    if (holdHours >= CONFIG.maxHoldHours) {
      await executeExit(position, 'MAX_HOLD_TIME', dexDataCache);
      continue;
    }

    // Get fresh dex data
    let dexData = null;
    try {
      dexData = await MOD.getDexData(tokenAddress, chain);
    } catch (e) {
      log(`[EXIT] Error fetching dex data for ${symbol}: ${e.message}`);
      continue;
    }

    if (!dexData) continue;

    // P0-8: Use getDexPrice for current price
    const currentPrice = getDexPrice(dexData);

    // Hard exit: liquidity drop
    const currentLiq = dexData.liquidityUsd || 0;
    if (liquidityAtEntry > 0) {
      const liqDropPct = ((liquidityAtEntry - currentLiq) / liquidityAtEntry) * 100;
      if (liqDropPct >= CONFIG.exitIfLiquidityDropsPct) {
        await executeExit(position, 'LIQUIDITY_DROP', dexDataCache, { liqDropPct });
        continue;
      }
    }

    // Fix 7: Check crew sells by querying crew wallets with token filter
    try {
      let allActivity = [];
      for (const crew of crewCache) {
        if (getCrewChain(crew) !== chain) continue;
        const crewActivity = await MOD.getWalletActivity(crew.address, chain, { tokenFilter: tokenAddress, limit: 20 });
        if (!crewActivity) continue;
        for (const a of crewActivity) {
          allActivity.push({ ...a, wallet: crew.address });
        }
      }
      if (allActivity.length > 0) {
        const sells = allActivity.filter(a =>
          a.side === 'SELL' &&
          a.intentConfidence >= CONFIG.minIntentConfidence &&
          crewScores.has(a.wallet?.toLowerCase())
        );

        if (sells.length > 0) {
          // Check for high-score seller
          const highScoreSells = sells.filter(s => {
            const score = crewScores.get(s.wallet?.toLowerCase())?.score || 0;
            return score >= CONFIG.highScoreSellThreshold;
          });

          // P1.4: executeReduce dedup
          for (const sell of highScoreSells) {
            if (sell.pctOfHoldings >= CONFIG.singleWalletSellPctOfHoldings) {
              if (CONFIG.reduceOnSingleHighScoreSell) {
                position.reductions = position.reductions || {};
                if (!position.reductions.HIGH_SCORE_SELL) {
                  await executeReduce(position, 'HIGH_SCORE_SELL', { seller: sell.wallet, pct: sell.pctOfHoldings });
                  position.reductions.HIGH_SCORE_SELL = Date.now();
                }
              }
            }
          }

          // Hard exit: 2+ clusters sell
          const sellingClusters = new Set();
          for (const s of sells) {
            const cid = crewClusters.get(s.wallet?.toLowerCase());
            if (cid) sellingClusters.add(cid);
          }

          if (sellingClusters.size >= CONFIG.exitMinClusters) {
            await executeExit(position, 'MULTI_CLUSTER_SELL', dexDataCache, { sellingClusters: [...sellingClusters] });
            continue;
          }

          // Hard exit: crew net flow negative
          const crewBuys = allActivity.filter(a =>
            a.side === 'BUY' && crewScores.has(a.wallet?.toLowerCase())
          );
          const buyUsd = crewBuys.reduce((s, b) => s + (b.usdValue || 0), 0);
          const sellUsd = sells.reduce((s, x) => s + (x.usdValue || 0), 0);
          if (sellUsd > buyUsd) {
            await executeExit(position, 'CREW_NET_NEGATIVE', dexDataCache, { buyUsd, sellUsd });
            continue;
          }
        }
      }
    } catch (e) {
      log(`[EXIT] Error checking crew sells for ${symbol}: ${e.message}`);
    }

    // Check LP status from dex data
    if (dexData.lpLocked === false) {
      await executeExit(position, 'LP_UNLOCKED', dexDataCache);
      continue;
    }

    // Check tax changes
    if (dexData.buyTax != null && dexData.buyTax > 10) {
      await executeExit(position, 'TAX_INCREASED', dexDataCache, { buyTax: dexData.buyTax });
      continue;
    }
  }
}

// ── Execute exit ────────────────────────────────────────────────────────────────
async function executeExit(position, reason, dexDataCache, extra = {}) {
  const { symbol, tokenAddress, chain } = position;

  // P1.2: Check cooldown for EXIT
  if (!cooldownOk(tokenAddress, 'EXIT')) {
    log(`[EXIT] Cooldown active for ${symbol} — skipping`);
    return;
  }

  if (shadowMode) {
    logShadow({
      type: 'EXIT',
      symbol,
      tokenAddress,
      chain,
      reason,
      ...extra,
      action: 'EXIT',
      signalScore: position.signalScore,
    });
    // P1.1: Track simulated exit PnL
    let exitPrice = position.entryPrice;
    try {
      const dexData = await MOD.getDexData(tokenAddress, chain);
      if (dexData) exitPrice = getDexPrice(dexData);
    } catch (e) { /* use entry as fallback */ }
    trackShadowExit(tokenAddress, exitPrice);
    activePositions.delete(tokenAddress.toLowerCase());
    recentExits.set(tokenAddress.toLowerCase(), Date.now());
    // Shadow exit alert
    if (CONFIG.shadowAlerts && MOD.sendTelegram) {
      const exitMsg = [
        `🔴 [SHADOW] CREW EXIT · ${symbol} · CLOSE LONG`,
        '━━━━━━━━━━━━━━━━━━━━━━━━━',
        `Reason: ${reason}`,
        `Entry Score: ${position.signalScore}/100`,
        `Hold Time: ${((Date.now() - position.entryTime) / 3600000).toFixed(1)}h`,
        `Sim PnL: $${(((exitPrice - position.entryPrice) / position.entryPrice) * 1000).toFixed(2)}`,
        `⏰ ${new Date().toISOString()}`,
      ].join('\n');
      try { await MOD.sendTelegram(exitMsg); } catch (e) { log(`[TELEGRAM] Shadow exit failed: ${e.message}`); }
    }
    return;
  }

  const msg = [
    `🚪 CREW EXIT · ${symbol} · CLOSE LONG`,
    '━━━━━━━━━━━━━━━━━━━━━━━━━',
    `Reason: ${reason}`,
    `Entry Score: ${position.signalScore}/100`,
    `Hold Time: ${((Date.now() - position.entryTime) / 3600000).toFixed(1)}h`,
  ];
  if (extra.liqDropPct) msg.push(`Liquidity Drop: ${extra.liqDropPct.toFixed(1)}%`);
  if (extra.buyUsd) msg.push(`Crew Buy: $${extra.buyUsd.toLocaleString()} | Sell: $${extra.sellUsd.toLocaleString()}`);
  msg.push(`⏰ ${new Date().toISOString()}`);

  if (MOD.sendTelegram) {
    try { await MOD.sendTelegram(msg.join('\n')); } catch (e) { log(`[TELEGRAM] Exit send failed: ${e.message}`); }
  }

  // Fix 6: Write a proper close file to data/apex_positions/closed/ instead of
  // calling writeApexPosition with side EXIT (which only supports LONG/SHORT)
  //
  // ═══ APEX Manager Consumption Contract ═══════════════════════════════════════
  // The Crew Copy-Trader writes position files that the APEX Manager must consume:
  //
  // 1. OPEN positions:
  //    - Written via writeApexPosition() to data/apex_positions/
  //    - Fields: { engine, symbol, side: 'LONG', entry, stop, meta: { stage, ... } }
  //    - APEX Manager reads these and opens/adds to futures positions
  //
  // 2. CLOSE positions (full exit):
  //    - Written as JSON files to data/apex_positions/closed/
  //    - Fields: { action: 'CLOSE_LONG', symbol, tokenId, reason, timestamp, ... }
  //    - APEX Manager must watch this directory and close the corresponding position
  //    - File naming: {symbol}_{timestamp}.json
  //
  // 3. REDUCE positions (partial exit):
  //    - Written via writeApexPosition() with meta.action = 'REDUCE_LONG'
  //    - Fields: { engine, symbol, side: 'LONG', entry, stop, meta: { action: 'REDUCE_LONG', reduce: true, stage: 0, ... } }
  //    - APEX Manager must check meta.action — if 'REDUCE_LONG', reduce position size
  //      (do NOT add exposure or open a new position)
  //    - The `reduce: true` flag is a secondary indicator; `action: 'REDUCE_LONG'` is primary
  //
  // APEX Manager MUST:
  //   - Watch data/apex_positions/ for new position files (open/add)
  //   - Watch data/apex_positions/closed/ for CLOSE_LONG files (close all)
  //   - Check meta.action field on every position file:
  //     - undefined or 'OPEN' → add/open position
  //     - 'REDUCE_LONG' → reduce position size (NEVER add)
  //     - 'CLOSE_LONG' → close entire position
  // ═══════════════════════════════════════════════════════════════════════════════
  let closeFileWritten = false;
  try {
    if (CONFIG.apexEnabled) {
      const closedDir = join(DATA_DIR, 'apex_positions', 'closed');
      // Fix 6: Warn if the closed/ directory doesn't exist, then create it
      if (!existsSync(closedDir)) {
        log(`[APEX] WARNING: closed positions directory does not exist: ${closedDir} — creating it`);
        mkdirSync(closedDir, { recursive: true });
        log(`[APEX] Created closed positions directory: ${closedDir}`);
      }
      const closeRecord = {
        action: 'CLOSE_LONG',
        symbol,
        tokenId: tokenAddress,
        reason,
        timestamp: Date.now(),
        exitTime: new Date().toISOString(),
        engine: 'CREW_COPYTRADER',
        signalScore: position.signalScore,
        holdHours: (Date.now() - position.entryTime) / 3600000,
      };
      const closeFile = join(closedDir, `${symbol}_${Date.now()}.json`);
      writeFileSync(closeFile, JSON.stringify(closeRecord, null, 2));
      // Fix 6: Log the EXACT file path written
      log(`[APEX] Close file written: ${closeFile} (${reason})`);
      // Fix 6: Verify the file exists on disk
      if (existsSync(closeFile)) {
        log(`[APEX] Verified close file exists: ${closeFile}`);
        closeFileWritten = true;
      } else {
        log(`[APEX] ERROR: Close file was NOT written successfully: ${closeFile}`);
      }
      log(`[APEX] APEX Manager must watch: ${closedDir} for CLOSE_LONG actions`);
    } else {
      closeFileWritten = true; // APEX disabled, no file to write
    }
  } catch (e) {
    log(`[APEX] Exit close file write failed: ${e.message}`);
  }

  // Fix 5: Only delete from activePositions after close file is successfully written and verified
  if (!closeFileWritten) {
    log(`[EXIT] ${symbol} — close file write FAILED, keeping position active for retry`);
    return;
  }

  markSignalSent(tokenAddress, 'EXIT');

  appendJsonl(join(DATA_DIR, 'crew_copytrader.jsonl'), {
    ts: Date.now(),
    type: 'EXIT',
    symbol,
    tokenAddress,
    chain,
    reason,
    signalScore: position.signalScore,
    holdHours: (Date.now() - position.entryTime) / 3600000,
    shadowMode: false,
  });

  activePositions.delete(tokenAddress.toLowerCase());
  recentExits.set(tokenAddress.toLowerCase(), Date.now());

  log(`[EXIT] ${symbol} — ${reason}`);
}

// ── Execute reduce (partial exit) ───────────────────────────────────────────────
async function executeReduce(position, reason, extra = {}) {
  const { symbol, tokenAddress, chain } = position;

  if (shadowMode) {
    logShadow({
      type: 'REDUCE',
      symbol,
      tokenAddress,
      chain,
      reason,
      ...extra,
      action: 'REDUCE',
      signalScore: position.signalScore,
    });
    return;
  }

  const msg = [
    `⚡ CREW REDUCE · ${symbol} · PARTIAL CLOSE`,
    `Reason: ${reason}`,
  ];

  if (MOD.sendTelegram) {
    try { await MOD.sendTelegram(msg.join('\n')); } catch (e) { log(`[TELEGRAM] Reduce send failed: ${e.message}`); }
  }

  // P0-9: Use correct APEX interface for reduce — write a reduce-size LONG position
  // Fix 6: APEX Manager must handle action='REDUCE_LONG' as a reduce, not a new position
  // The `action: 'REDUCE_LONG'` field is the PRIMARY indicator; `reduce: true` is secondary
  if (CONFIG.apexEnabled && MOD.writeApexPosition) {
    try {
      const currentPrice = getDexPrice(await MOD.getDexData(tokenAddress, chain).catch(() => ({})));
      const reduceMeta = {
        action: 'REDUCE_LONG',  // Fix 6: Explicit action field — APEX Manager must NOT add exposure
        tokenAddress,
        chain,
        reason,
        reduce: true,  // Fix 6: Secondary indicator for backward compatibility
        stage: 0,      // stage 0 = reduce/scale-out
        riskPct: position.riskPct || 0,
        symbol,
        engine: 'CREW_COPYTRADER',
      };
      log(`[APEX] Writing REDUCE_LONG for ${symbol}: action=REDUCE_LONG, reason=${reason}`);
      await MOD.writeApexPosition({
        engine: 'CREW_COPYTRADER',
        symbol,
        side: 'LONG',
        entry: currentPrice || position.entryPrice,
        stop: position.plan?.stop || position.entryPrice * 0.85,
        meta: reduceMeta,
      });
    } catch (e) {
      log(`[APEX] Reduce write failed: ${e.message}`);
    }
  }

  log(`[REDUCE] ${symbol} — ${reason}`);
}

// ── P0-11: Webhook event handler ───────────────────────────────────────────────
// Fix 2: Webhook events are raw (no side/intentConfidence) — pass through tx_classifier
async function handleWebhookEvent(evt) {
  try {
    // Expected raw shape: { wallet, chain, tokenAddress, from, to, token, value, usdValue, txHash, logIndex, eventType, timestamp }
    const { wallet, chain, tokenAddress, timestamp, txHash } = evt;

    if (!tokenAddress || !wallet) return;

    const walletLc = String(wallet).toLowerCase();
    const tokenLc = String(tokenAddress).toLowerCase();

    // Only process if wallet is in our crew
    if (!crewScores.has(walletLc)) return;

    const evtChain = canonicalChain(chain || 'binance-smart-chain');

    // Fix 3: Use forceRefresh=true so webhook events don't hit stale 5-minute cache
    // Also implement retry-by-txHash: Moralis history may not have indexed the tx yet
    // when the webhook arrives. Retry 3 times with 2s delay before giving up.
    let classifiedEvents = [];
    if (MOD.getWalletActivity) {
      const maxRetries = 3;
      const retryDelayMs = 2000;
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const activity = await MOD.getWalletActivity(walletLc, evtChain, { tokenFilter: tokenAddress, limit: 5 }, { forceRefresh: true });
          if (activity && activity.length > 0) {
            // Find the event matching this txHash
            const matching = activity.filter(a =>
              a.txHash?.toLowerCase() === (txHash || '').toLowerCase() &&
              a.tokenAddress?.toLowerCase() === tokenLc
            );
            if (matching.length > 0) {
              classifiedEvents = matching;
              break; // Found it — no more retries needed
            }
          }
          // Not found yet — retry if attempts remain
          if (attempt < maxRetries) {
            log(`[WEBHOOK] tx ${txHash?.slice(0, 16)}... not found in history (attempt ${attempt}/${maxRetries}), retrying in ${retryDelayMs}ms...`);
            await sleep(retryDelayMs);
          } else {
            log(`[WEBHOOK] tx ${txHash?.slice(0, 16)}... not found after ${maxRetries} retries — Moralis history may be lagging`);
          }
        } catch (e) {
          log(`[WEBHOOK] tx_classifier query failed for ${walletLc.slice(0, 8)}... (attempt ${attempt}/${maxRetries}): ${e.message}`);
          if (attempt < maxRetries) {
            await sleep(retryDelayMs);
          } else {
            return;
          }
        }
      }
    }

    // Process each classified event
    for (const classified of classifiedEvents) {
      const evtSide = classified.side === 'BUY' ? 'BUY' :
                      classified.side === 'SELL' ? 'SELL' : null;
      if (!evtSide) continue; // TRANSFER, AIRDROP, etc — not a swap signal

      // Only process if confidence meets threshold
      if ((classified.intentConfidence || 0) < CONFIG.minIntentConfidence) continue;

      const ts = classified.timestamp || (timestamp ? new Date(timestamp).getTime() : Date.now());
      const cutoff = Date.now() - CONFIG.consensusWindowMs;
      if (ts < cutoff) continue;

      const tokenKey = `${canonicalChain(evtChain)}:${tokenAddress}`.toLowerCase();

      // Feed into buysByToken/sellsByToken via a shared accumulator
      if (!global._webhookBuys) global._webhookBuys = new Map();
      if (!global._webhookSells) global._webhookSells = new Map();

      const target = evtSide === 'BUY' ? global._webhookBuys : global._webhookSells;
      if (!target.has(tokenKey)) {
        target.set(tokenKey, {
          symbol: classified.symbol || 'UNKNOWN',
          chain: evtChain,
          tokenAddress,
          wallets: [],
        });
      }
      target.get(tokenKey).wallets.push({
        addr: walletLc,
        usdValue: classified.usdValue || evt.usdValue || 0,
        ts,
        confidence: classified.intentConfidence || 0,
      });

      log(`[WEBHOOK] ${evtSide} ${classified.symbol || tokenAddress.slice(0, 8)} by ${walletLc.slice(0, 8)}... ($${classified.usdValue || 0}) via tx_classifier`);

      // Trigger immediate consensus check for this token (only for BUYs)
      if (evtSide === 'BUY') {
        checkWebhookConsensus(tokenKey, evtSide, evtChain, tokenAddress, classified.symbol || 'UNKNOWN');
      }
    }
  } catch (e) {
    log(`[WEBHOOK] handleWebhookEvent error: ${e.message}`);
  }
}

// ── P0-11: Immediate consensus check from webhook events ──────────────────────
async function checkWebhookConsensus(tokenKey, side, chain, tokenAddress, symbol) {
  try {
    if (side !== 'BUY') return;
    if (activePositions.has(tokenAddress.toLowerCase())) return;
    if (recentExits.has(tokenAddress.toLowerCase()) &&
        Date.now() - recentExits.get(tokenAddress.toLowerCase()) < CONFIG.blockReentryAfterExitMs) return;

    const buys = global._webhookBuys?.get(tokenKey);
    if (!buys || buys.wallets.length < CONFIG.minCrewWallets) return;

    // Check unique clusters
    const buyingClusters = new Set();
    let netBuyUsd = 0;
    const crewBuys = [];

    for (const b of buys.wallets) {
      const crewScoreInfo = crewScores.get(b.addr);
      if (!crewScoreInfo || crewScoreInfo.score < 60) continue;
      const clusterId = crewClusters.get(b.addr) || ('unclustered_' + b.addr.slice(0, 10));
      buyingClusters.add(clusterId);
      netBuyUsd += b.usdValue || 0;
      crewBuys.push({
        address: b.addr,
        usdValue: b.usdValue || 0,
        timestamp: b.ts,
        price: 0,
        crewScore: crewScoreInfo.score,
        tier: crewScoreInfo.tier,
        clusterId,
      });
    }

    if (crewBuys.length < CONFIG.minCrewWallets) return;
    if (buyingClusters.size < CONFIG.minIndependentClusters) return;

    const weightedScore = crewBuys.reduce((s, b) => s + b.crewScore, 0);
    if (weightedScore < CONFIG.minWeightedCrewScore) return;
    // Fix 5: Use radarMinNetBuyUsd as initial gate for webhook consensus
    if (netBuyUsd < CONFIG.radarMinNetBuyUsd) return;

    // Fetch dex data
    let dexData = null;
    try {
      dexData = await MOD.getDexData(tokenAddress, chain);
    } catch (e) {
      return;
    }
    if (!dexData) return;

    const currentPrice = getDexPrice(dexData);

    // Run risk gate
    let safetyResult = null;
    if (CONFIG.requireRiskGatePass) {
      safetyResult = await runRiskGate(tokenAddress, chain, dexData);
      if (!safetyResult || safetyResult.passed === false) {
        log(`[WEBHOOK] ${symbol}: risk gate FAILED — skipping`);
        return;
      }
    }

    // Compute signal score
    const isDex = !dexData.listedOnCex;
    const signalScore = computeSignalScore({
      crewQuality: calcCrewQualityScore(crewBuys),
      clusterIndependence: calcClusterIndependenceScore(buyingClusters.size),
      netBuyUsd: calcNetBuyScore(netBuyUsd),
      timingCompression: calcTimingScore(crewBuys.map(b => b.timestamp)),
      liquidityQuality: calcLiquidityScore(dexData.liquidityUsd || 0, isDex),
      contractSafety: calcSafetyScore(safetyResult),
      pricePosition: calcPricePositionScore(0),
      exchangeDepth: calcExchangeDepthScore(dexData),
    });

    let action = scoreToAction(signalScore);
    if (action === 'IGNORE') return;

    // Fix 2: COPY downgrade must actually change the action variable
    if ((action === 'COPY' || action === 'STRONG_COPY') && netBuyUsd < CONFIG.copyMinNetBuyUsd) {
      if (netBuyUsd < CONFIG.radarMinNetBuyUsd) {
        log(`[DOWNGRADE] [WEBHOOK] ${symbol}: netBuyUsd $${netBuyUsd} < radarMin $${CONFIG.radarMinNetBuyUsd} → action=WATCH (skipping)`);
        return;
      }
      action = 'RADAR';
      log(`[DOWNGRADE] [WEBHOOK] ${symbol}: netBuyUsd $${netBuyUsd} < copyMin $${CONFIG.copyMinNetBuyUsd} → action=RADAR`);
    }

    // Build trade plan
    let tradePlan = null;
    if ((action === 'COPY' || action === 'STRONG_COPY') && MOD.computeTradePlan) {
      try {
        // Fix 5: Do not create fake candles — if no real candle data, skip trade plan
        let candles1h = await readCandlesFromValkey(symbol, chain);
        if (!candles1h) {
          log(`[WEBHOOK] No real candle data for ${symbol} — APEX/trade plan skipped`);
          // Fix 9: Set ALERT_ONLY on signal
          // Signal not built yet, will be set below
          // Fix 7: Alert clearly states APEX is skipped
          if (MOD.sendTelegram) {
            try { await MOD.sendTelegram(`⚠️ ALERT ONLY / APEX SKIPPED — No candle data for ${symbol} (webhook signal). Manual execution required.`); } catch (e) { /* non-fatal */ }
          }
        } else {
          const plan = MOD.computeTradePlan(candles1h, currentPrice, 'LONG');
          if (MOD.formatPlanBlock) {
            tradePlan = MOD.formatPlanBlock(plan);
          } else {
            tradePlan = JSON.stringify(plan, null, 2);
          }
        }
      } catch (e) {
        log(`[WEBHOOK] Trade plan error for ${symbol}: ${e.message}`);
      }
    }

    const signal = {
      symbol,
      tokenAddress,
      chain,
      signalScore,
      action,
      clusters: buyingClusters.size,
      netBuyUsd,
      crewBuyers: crewBuys,
      firstBuyPrice: currentPrice,
      currentPrice,
      movePct: 0,
      liquidityUsd: dexData.liquidityUsd || 0,
      safetyResult,
      tradePlan,
    };

    // Fix 9: If no trade plan due to no candle data, mark as ALERT_ONLY
    if (!tradePlan && (action === 'COPY' || action === 'STRONG_COPY')) {
      signal.action = 'ALERT_ONLY';
      signal.apexSkipped = true;
    }

    if (action === 'STRONG_COPY' || action === 'COPY') {
      // Fix 8: Verify symbol is tradeable on Bitget before COPY execution
      const bitgetResult = await checkBitget(symbol);
      if (!bitgetResult.ok) {
        log(`[BITGET] [WEBHOOK] ${symbol}: ${bitgetResult.reason} — downgrading COPY to RADAR`);
        action = 'RADAR';
        signal.action = 'RADAR';
      }
    }

    if (signal.action === 'ALERT_ONLY') {
      // Fix 9: Alert only — APEX skipped, no execution
      log(`[ALERT_ONLY] [WEBHOOK] ${symbol} score=${signalScore} — APEX skipped, alert only`);
      if (MOD.sendTelegram) {
        const alertMsg = buildAlertMessage('ALERT_ONLY', { ...signal, liquidityUsd: dexData.liquidityUsd || 0 });
        try { await MOD.sendTelegram(alertMsg); } catch (e) { /* non-fatal */ }
      }
      if (shadowMode) logShadow(signal);
    } else if (action === 'STRONG_COPY' || action === 'COPY') {
      await executeCopy(signal, dexData);
    } else if (action === 'RADAR') {
      if (crewBuys.length >= CONFIG.radarMinWallets &&
          weightedScore >= CONFIG.radarMinCrewScore &&
          (dexData.liquidityUsd || 0) >= CONFIG.radarMinLiqUsd) {
        await executeRadar(signal);
      }
    }

    // Clear processed webhook buys for this token
    global._webhookBuys?.delete(tokenKey);
  } catch (e) {
    // swallow
  }
}

// ── P0-11: Webhook subscriber setup ────────────────────────────────────────────
async function setupWebhookSubscriber() {
  try {
    const valkeyCfg = readJsonSafe(join(DATA_DIR, 'valkey_config.json'), null);
    if (!valkeyCfg?.host) {
      log('[WEBHOOK] No Valkey config — webhook integration disabled');
      return;
    }
    const { createClient } = await import('redis');
    const sub = createClient({
      socket: { host: valkeyCfg.host, port: valkeyCfg.port, tls: valkeyCfg.tls ?? true },
      password: valkeyCfg.password,
    });
    sub.on('error', () => {});
    await sub.connect();
    await sub.subscribe('crew:webhook:event', (msg) => {
      try {
        const evt = JSON.parse(msg);
        handleWebhookEvent(evt);
      } catch (e) { /* swallow */ }
    });
    log('[WEBHOOK] Subscribed to crew:webhook:event — real-time mode active');
  } catch (e) {
    log(`[WEBHOOK] Valkey subscription failed: ${e.message} — polling fallback only`);
  }
}

// ── Main monitoring cycle ───────────────────────────────────────────────────────
async function runCycle() {
  cycleCount++;
  log(`[CYCLE] #${cycleCount} starting (shadow=${shadowMode}, positions=${activePositions.size})`);

  // Daily PnL reset
  if (Date.now() - lastDailyReset > 24 * 60 * 60 * 1000) {
    dailyPnlR = 0;
    lastDailyReset = Date.now();
  }

  // Check daily loss limit
  if (dailyPnlR <= CONFIG.dailyMaxLossR) {
    log(`[CYCLE] Daily loss limit hit (${dailyPnlR}R). Skipping cycle.`);
    return;
  }

  // Refresh fingerprinting if stale
  if (Date.now() - lastFingerprintTs > CONFIG.fingerprintEveryMs) {
    await runFingerprinting();
    await loadCrewMetadata();
  }

  // Check exits on active positions first
  if (activePositions.size > 0) {
    await checkExits();
    // P0-10: Check scale-ins for pending stages
    await checkScaleIns();
  }

  // Fix 8: Run shadow exit simulation for shadowPositions every cycle
  if (shadowMode && shadowPositions.size > 0) {
    for (const [tokenKey, shadowPos] of shadowPositions) {
      try {
        const dexData = await MOD.getDexData(shadowPos.tokenAddress, shadowPos.chain);
        if (!dexData) continue;
        const currentPrice = getDexPrice(dexData);
        const holdHours = (Date.now() - shadowPos.entryTime) / 3600000;

        // Simulate exit conditions: max hold time
        if (holdHours >= CONFIG.maxHoldHours) {
          trackShadowExit(shadowPos.tokenAddress, currentPrice);
          log(`[SHADOW-EXIT] ${shadowPos.symbol} — MAX_HOLD_TIME (${holdHours.toFixed(1)}h)`);
          continue;
        }

        // Fix 9: Compare current liquidity against entryLiquidityUsd (not entryPrice)
        // Old code compared liquidity against price — wrong units
        if (shadowPos.entryLiquidityUsd > 0) {
          const currentLiq = dexData.liquidityUsd || 0;
          const liqDropPct = ((shadowPos.entryLiquidityUsd - currentLiq) / shadowPos.entryLiquidityUsd) * 100;
          if (liqDropPct >= CONFIG.exitIfLiquidityDropsPct) {
            trackShadowExit(shadowPos.tokenAddress, currentPrice);
            log(`[SHADOW-EXIT] ${shadowPos.symbol} — LIQUIDITY_DROP (${liqDropPct.toFixed(1)}% drop from $${shadowPos.entryLiquidityUsd})`);
            continue;
          }
        }

        // Simulate stop-loss: if price dropped 15% from entry
        if (shadowPos.entryPrice > 0 && currentPrice < shadowPos.entryPrice * 0.85) {
          trackShadowExit(shadowPos.tokenAddress, currentPrice);
          log(`[SHADOW-EXIT] ${shadowPos.symbol} — STOP_LOSS (price $${currentPrice} < entry $${shadowPos.entryPrice} * 0.85)`);
          continue;
        }
      } catch (e) {
        // non-fatal
      }
    }
  }

  // Poll each crew wallet for recent activity (what they're buying/selling NOW)
  log(`[CYCLE] Polling ${crewCache.length} crew wallets for activity...`);
  const buysByToken = new Map();
  const sellsByToken = new Map();

  // P0-11: Merge webhook-buffered events into cycle maps
  if (global._webhookBuys) {
    for (const [key, val] of global._webhookBuys) {
      if (!buysByToken.has(key)) {
        buysByToken.set(key, { symbol: val.symbol, chain: val.chain, tokenAddress: val.tokenAddress, wallets: [] });
      }
      buysByToken.get(key).wallets.push(...val.wallets);
    }
  }
  if (global._webhookSells) {
    for (const [key, val] of global._webhookSells) {
      if (!sellsByToken.has(key)) {
        sellsByToken.set(key, { symbol: val.symbol, chain: val.chain, tokenAddress: val.tokenAddress, wallets: [] });
      }
      sellsByToken.get(key).wallets.push(...val.wallets);
    }
  }

  for (const crew of crewCache) {
    const walletAddr = crew.address;
    if (!walletAddr) continue;
    // P0-3: Use getCrewChain helper
    const chain = getCrewChain(crew);

    try {
      const activity = await MOD.getWalletActivity(walletAddr, chain, null);
      if (!activity || activity.length === 0) continue;

      const cutoff = Date.now() - CONFIG.consensusWindowMs;
      const recent = activity.filter(a => {
        const ts = new Date(a.blockTime || 0).getTime();
        return ts > cutoff;
      });

      for (const evt of recent) {
        if (!evt.tokenAddress || !evt.symbol) continue;
        const tokenKey = `${canonicalChain(chain)}:${evt.tokenAddress}`.toLowerCase();

        if (evt.side === 'BUY' && evt.intentConfidence >= CONFIG.minIntentConfidence) {
          if (!buysByToken.has(tokenKey)) {
            buysByToken.set(tokenKey, { symbol: evt.symbol, chain, tokenAddress: evt.tokenAddress, wallets: [] });
          }
          buysByToken.get(tokenKey).wallets.push({
            addr: walletAddr,
            usdValue: evt.usdValue || 0,
            ts: new Date(evt.blockTime || 0).getTime(),
            confidence: evt.intentConfidence,
          });
        }

        if (evt.side === 'SELL' && evt.intentConfidence >= CONFIG.minIntentConfidence) {
          if (!sellsByToken.has(tokenKey)) {
            sellsByToken.set(tokenKey, { symbol: evt.symbol, chain, tokenAddress: evt.tokenAddress, wallets: [] });
          }
          sellsByToken.get(tokenKey).wallets.push({
            addr: walletAddr,
            usdValue: evt.usdValue || 0,
            ts: new Date(evt.blockTime || 0).getTime(),
            confidence: evt.intentConfidence,
          });
        }
      }
    } catch (e) {
      // don't crash on one wallet
    }
    await sleep(CONFIG.walletDelayMs);
  }

  log(`[CYCLE] Found ${buysByToken.size} buy-tokens, ${sellsByToken.size} sell-tokens across ${crewCache.length} crew wallets`);

  // Check for consensus on buy tokens
  for (const [tokenKey, buyInfo] of buysByToken) {
    const { tokenAddress, chain, symbol } = buyInfo;
    const exitTs = recentExits.get(tokenAddress.toLowerCase());
    if (exitTs && Date.now() - exitTs < CONFIG.blockReentryAfterExitMs) {
      continue;
    }

    if (activePositions.has(tokenAddress.toLowerCase())) {
      continue;
    }

    try {
      const crewBuys = [];
      const allActivity = [];
      const buyTimestamps = [];
      let firstBuyPrice = null;
      let netBuyUsd = 0;

      for (const crew of crewCache) {
        // P0-3: Use getCrewChain helper
        if (getCrewChain(crew) !== chain) continue;

        try {
          const activity = await MOD.getWalletActivity(crew.address, chain, { tokenFilter: tokenAddress, limit: 20 });
          if (!activity) continue;

          for (const evt of activity) {
            allActivity.push({ ...evt, wallet: crew.address });

            if (evt.side === 'BUY' &&
                evt.intentConfidence >= CONFIG.minIntentConfidence &&
                Date.now() - evt.timestamp <= CONFIG.consensusWindowMs) {

              const crewScoreInfo = crewScores.get(crew.address.toLowerCase());
              const score = crewScoreInfo?.score || 0;
              const tier = crewScoreInfo?.tier || 'D';

              if (score >= 60) {
                // Fix: Compute USD value from token amount × DexScreener price if Moralis doesn't provide it
                let buyUsd = evt.usdValue || 0;
                let buyPrice = evt.price || 0;
                if (buyUsd === 0 && evt.valueFormatted && evt.valueFormatted > 0) {
                  // Try to use firstBuyPrice or fetch from DexScreener later
                  // For now, use valueFormatted as token amount; price will be filled after DexScreener fetch
                  buyUsd = 0; // will be computed after we get dexData
                }
                crewBuys.push({
                  address: crew.address,
                  usdValue: buyUsd,
                  valueFormatted: evt.valueFormatted || 0,
                  timestamp: evt.timestamp,
                  price: buyPrice,
                  crewScore: score,
                  tier,
                  clusterId: crewClusters.get(crew.address.toLowerCase()) || ('unclustered_' + crew.address.slice(2, 12)),
                });
                netBuyUsd += buyUsd;
                buyTimestamps.push(evt.timestamp);

                if (!firstBuyPrice || evt.price < firstBuyPrice) {
                  firstBuyPrice = evt.price;
                }
              }
            }
          }
        } catch (e) {
          // Per-wallet errors are non-fatal
        }

        await sleep(CONFIG.walletDelayMs);
      }

      if (crewBuys.length === 0) continue;

      crewBuys.sort((a, b) => a.timestamp - b.timestamp);

      const buyingClusters = new Set(crewBuys.map(b => b.clusterId));
      const uniqueClusters = buyingClusters.size;
      const weightedScore = crewBuys.reduce((s, b) => s + b.crewScore, 0);

      log(`[DIAG] ${symbol} crewBuys=${crewBuys.length} clusters=${uniqueClusters} weightedScore=${weightedScore} netBuyUsd=${netBuyUsd} gates: wallets=${crewBuys.length >= CONFIG.minCrewWallets} clusters=${uniqueClusters >= CONFIG.minIndependentClusters} score=${weightedScore >= CONFIG.minWeightedCrewScore} usd=${netBuyUsd >= CONFIG.minNetBuyUsd}`);

      if (crewBuys.length < CONFIG.minCrewWallets) continue;
      if (uniqueClusters < CONFIG.minIndependentClusters) continue;
      if (weightedScore < CONFIG.minWeightedCrewScore) continue;
      // Fix 5: Use radarMinNetBuyUsd as the initial gate (radar-level)
      if (netBuyUsd < CONFIG.radarMinNetBuyUsd) continue;

      let dexData = null;
      try {
        dexData = await MOD.getDexData(tokenAddress, chain);
      } catch (e) {
        log(`[CYCLE] DexScreener error for ${symbol}: ${e.message}`);
        continue;
      }
      if (!dexData) continue;

      // P0-8: Use getDexPrice helper
      const currentPrice = getDexPrice(dexData);

      // Fix: Fill in netBuyUsd using DexScreener price × token amounts if Moralis didn't provide USD values
      if (netBuyUsd === 0 && currentPrice > 0) {
        for (const b of crewBuys) {
          if (b.usdValue === 0 && b.valueFormatted > 0) {
            b.usdValue = b.valueFormatted * currentPrice;
            b.price = currentPrice;
            netBuyUsd += b.usdValue;
          }
        }
        if (firstBuyPrice === null || firstBuyPrice === 0) {
          firstBuyPrice = currentPrice;
        }
        log(`[CYCLE] ${symbol}: computed netBuyUsd=$${netBuyUsd.toFixed(0)} from ${crewBuys.length} buys × price $${currentPrice}`);
      }

      const movePct = firstBuyPrice ? await checkPriceMove(firstBuyPrice, currentPrice) : 0;
      if (movePct > CONFIG.maxMoveFromFirstCrewBuyPct) {
        log(`[CYCLE] ${symbol}: move ${movePct.toFixed(1)}% > ${CONFIG.maxMoveFromFirstCrewBuyPct}% — skipping`);
        continue;
      }

      let safetyResult = null;
      if (CONFIG.requireRiskGatePass) {
        safetyResult = await runRiskGate(tokenAddress, chain, dexData);
        if (!safetyResult || safetyResult.passed === false) {
          log(`[CYCLE] ${symbol}: risk gate FAILED — skipping`);
        if (safetyResult?.reasons) log(`[RISK_GATE] ${symbol} reasons: ${safetyResult.reasons.join('; ')}`);
          continue;
        }
      }

      const isDex = !dexData.listedOnCex;
      const signalScore = computeSignalScore({
        crewQuality: calcCrewQualityScore(crewBuys),
        clusterIndependence: calcClusterIndependenceScore(uniqueClusters),
        netBuyUsd: calcNetBuyScore(netBuyUsd),
        timingCompression: calcTimingScore(buyTimestamps),
        liquidityQuality: calcLiquidityScore(dexData.liquidityUsd || 0, isDex),
        contractSafety: calcSafetyScore(safetyResult),
        pricePosition: calcPricePositionScore(movePct),
        exchangeDepth: calcExchangeDepthScore(dexData),
      });

      let action = scoreToAction(signalScore);
      if (action === 'IGNORE') continue;

      // Fix 2: COPY downgrade must actually change the action variable
      if ((action === 'COPY' || action === 'STRONG_COPY') && netBuyUsd < CONFIG.copyMinNetBuyUsd) {
        // Truly downgrade — change the action variable, not just log
        if (netBuyUsd < CONFIG.radarMinNetBuyUsd) {
          log(`[DOWNGRADE] ${symbol}: netBuyUsd $${netBuyUsd} < radarMin $${CONFIG.radarMinNetBuyUsd} → action=WATCH (skipping)`);
          continue; // below radar threshold, skip entirely
        }
        action = 'RADAR';
        log(`[DOWNGRADE] ${symbol}: netBuyUsd $${netBuyUsd} < copyMin $${CONFIG.copyMinNetBuyUsd} → action=RADAR`);
      }

      // P0-9: Build trade plan using correct APEX interface
      let tradePlan = null;
      if ((action === 'COPY' || action === 'STRONG_COPY') && MOD.computeTradePlan) {
        try {
          // Fix 5: Read 1H candles from Valkey cache — do NOT create fake candles
          let candles1h = await readCandlesFromValkey(symbol, chain);
          if (!candles1h) {
            log(`[CYCLE] No real candle data for ${symbol} — trade plan/APEX skipped`);
            // Fix 7: Alert clearly states APEX is skipped
            if (MOD.sendTelegram) {
              try { await MOD.sendTelegram(`⚠️ ALERT ONLY / APEX SKIPPED — No candle data for ${symbol} (cycle signal). Manual execution required.`); } catch (e) { /* non-fatal */ }
            }
          } else {
            // P0-9: Call with correct signature (candles1h, price, side)
            const plan = MOD.computeTradePlan(candles1h, currentPrice, 'LONG');
            if (MOD.formatPlanBlock) {
              tradePlan = MOD.formatPlanBlock(plan);
            } else {
              tradePlan = JSON.stringify(plan, null, 2);
            }
          }
        } catch (e) {
          log(`[CYCLE] Trade plan error for ${symbol}: ${e.message}`);
        }
      }

      const signal = {
        symbol,
        tokenAddress,
        chain,
        signalScore,
        action,
        clusters: uniqueClusters,
        netBuyUsd,
        crewBuyers: crewBuys,
        firstBuyPrice,
        currentPrice,
        movePct,
        liquidityUsd: dexData.liquidityUsd || 0,
        safetyResult,
        tradePlan,
      };

      // Fix 9: If no trade plan due to no candle data, mark as ALERT_ONLY
      if (!tradePlan && (action === 'COPY' || action === 'STRONG_COPY')) {
        signal.action = 'ALERT_ONLY';
        signal.apexSkipped = true;
      }

      if (action === 'STRONG_COPY' || action === 'COPY') {
        // Fix 8: Verify symbol is tradeable on Bitget before COPY execution
        const bitgetResult = await checkBitget(symbol);
        if (!bitgetResult.ok) {
          log(`[BITGET] ${symbol}: ${bitgetResult.reason} — downgrading COPY to RADAR`);
          action = 'RADAR';
          // Fix 4: Update signal.action to match the downgraded action
          signal.action = 'RADAR';
        }
      }

      if (signal.action === 'ALERT_ONLY') {
        // Fix 9: Alert only — APEX skipped, no execution
        log(`[ALERT_ONLY] ${symbol} score=${signalScore} — APEX skipped, alert only`);
        // ALERT_ONLY signals are not sent to Telegram — only COPY/STRONG_COPY alerts
        if (shadowMode) logShadow(signal);
        appendJsonl(join(DATA_DIR, 'crew_copytrader.jsonl'), {
          ts: Date.now(), type: 'ALERT_ONLY', symbol, tokenAddress, chain, signalScore, shadowMode,
        });
      } else if (action === 'STRONG_COPY' || action === 'COPY') {
        await executeCopy(signal, dexData);
      } else if (action === 'WATCH') {
        log(`[WATCH] ${symbol} score=${signalScore} — plan prepared, waiting for confirmation`);
        if (shadowMode) {
          logShadow(signal);
        }
      } else if (action === 'RADAR') {
        if (crewBuys.length >= CONFIG.radarMinWallets &&
            weightedScore >= CONFIG.radarMinCrewScore &&
            (dexData.liquidityUsd || 0) >= CONFIG.radarMinLiqUsd) {
          await executeRadar(signal);
        }
      }
    } catch (e) {
      log(`[CYCLE] Error processing ${symbol} (${tokenAddress}): ${e.message}`);
    }
  }

  // P1.3: Check sellsByToken for EXIT signals — if ≥2 clusters sell same token, fire EXIT
  for (const [tokenKey, sellInfo] of sellsByToken) {
    const { tokenAddress, chain, symbol } = sellInfo;

    if (!activePositions.has(tokenAddress.toLowerCase())) continue;

    const sellingClusters = new Set();
    let sellUsd = 0;
    for (const s of sellInfo.wallets) {
      const cid = crewClusters.get(s.addr?.toLowerCase());
      if (cid) sellingClusters.add(cid);
      sellUsd += s.usdValue || 0;
    }

    if (sellingClusters.size >= CONFIG.exitMinClusters) {
      const position = activePositions.get(tokenAddress.toLowerCase());
      if (position) {
        await executeExit(position, 'MULTI_CLUSTER_SELL_WEBHOOK', null, { sellingClusters: [...sellingClusters], sellUsd });
      }
    }
  }

  // Clear webhook buffers after cycle processing
  if (global._webhookBuys) global._webhookBuys.clear();
  if (global._webhookSells) global._webhookSells.clear();

  log(`[CYCLE] #${cycleCount} complete (positions=${activePositions.size}, shadow=${shadowMode})`);
}

// ── Status command ─────────────────────────────────────────────────────────────
function printStatus() {
  console.log('\n═══════════════════════════════════════════════');
  console.log('  CREW COPY-TRADER v4.0.2 — STATUS');
  console.log('═══════════════════════════════════════════════\n');
  console.log(`Mode: ${shadowMode ? 'SHADOW' : 'LIVE'}`);
  console.log(`Shadow signals: ${shadowSignalCount}/${CONFIG.shadowModeSignalCount}`);
  console.log(`Shadow stats: ${JSON.stringify(shadowStats)}`);
  console.log(`Crew wallets: ${crewCache.length}`);
  console.log(`Crew scores: ${crewScores.size}`);
  console.log(`Clusters: ${clusterGroups.size}`);
  console.log(`Active positions: ${activePositions.size}`);
  console.log(`Recent exits: ${recentExits.size}`);
  console.log(`Daily PnL: ${dailyPnlR}R`);
  console.log(`Cycle count: ${cycleCount}`);
  console.log(`Last fingerprint: ${lastFingerprintTs ? new Date(lastFingerprintTs).toISOString() : 'never'}\n`);

  if (crewCache.length > 0) {
    console.log('── Top Crew Wallets ──');
    const sorted = [...crewCache].sort((a, b) => (crewScores.get(b.address.toLowerCase())?.score || 0) - (crewScores.get(a.address.toLowerCase())?.score || 0));
    for (const c of sorted.slice(0, 10)) {
      const sc = crewScores.get(c.address.toLowerCase());
      const cid = crewClusters.get(c.address.toLowerCase()) || '?';
      console.log(`  ${c.address.slice(0, 10)}... | Score: ${sc?.score || 0} (${sc?.tier || 'D'}) | Cluster: ${cid} | ${c.coin || '?'} | $${(c.totalRealizedUsd || 0).toLocaleString()}`);
    }
  }

  if (activePositions.size > 0) {
    console.log('\n── Active Positions ──');
    for (const [key, pos] of activePositions) {
      const holdH = ((Date.now() - pos.entryTime) / 3600000).toFixed(1);
      const stages = pos.stagesFilled || 1;
      const pending = pos.pendingStages ? ` (s2:${pos.pendingStages.stage2.filled ? '✓' : '·'} s3:${pos.pendingStages.stage3.filled ? '✓' : '·'})` : '';
      console.log(`  ${pos.symbol} | Score: ${pos.signalScore} | Entry: $${R8(pos.entryPrice)} | Hold: ${holdH}h | Stages: ${stages}/3${pending}`);
    }
  }

  console.log('');
}

// ── Main ────────────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] || 'daemon';

  log(`[MAIN] Crew Copy-Trader v4.0.2 starting (cmd=${cmd})`);

  ensureDataDir();
  MOD = await loadModules();

  // Load crew cache from disk
  const crewPath = join(DATA_DIR, 'crew_cache.json');
  const savedCrew = readJsonSafe(crewPath, []);
  if (Array.isArray(savedCrew) && savedCrew.length > 0) {
    crewCache = savedCrew;
    log(`[MAIN] Loaded ${crewCache.length} crew wallets from cache`);
  }

  // Load crew scores + clusters
  await loadCrewMetadata();

  // P0-11: Setup webhook subscriber for real-time events
  await setupWebhookSubscriber();

  switch (cmd) {
    case '--once':
      await runCycle();
      break;

    case '--fingerprint':
      await runFingerprinting();
      await loadCrewMetadata();
      await loadCrewMetadata();
      console.log(`Fingerprinting complete. ${crewCache.length} crew wallets, ${crewScores.size} scores, ${clusterGroups.size} clusters.`);
      break;

    case '--status':
      printStatus();
      break;

    case '--shadow-off':
      shadowMode = false;
      console.log('Shadow mode OFF. Engine is now LIVE.');
      writeFileSync(join(DATA_DIR, 'crew_v4_live_mode.flag'), JSON.stringify({ ts: Date.now(), triggeredBy: 'cli' }));
      break;

    case 'daemon':
    default:
      log('[MAIN] Starting daemon mode...');
      await runCycle();
      log(`[MAIN] Scheduling cycles every ${CONFIG.cycleIntervalMs / 60000} minutes`);
      while (true) {
        await sleep(CONFIG.cycleIntervalMs);
        try {
          await runCycle();
        } catch (e) {
          log(`[MAIN] Cycle error: ${e.message}`);
        }
      }
  }
}

main().catch(e => {
  console.error(`[FATAL] ${e.message}`);
  process.exit(1);
});
