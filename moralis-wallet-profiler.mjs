// ═══════════════════════════════════════════════════════════════════════════════
//  WALLET PROFILING (Moralis)
//  Profile tracked whale wallets to determine if they are human specialists,
//  human generalists, or automated bots. Uses on-chain heuristics from Moralis.
// ═══════════════════════════════════════════════════════════════════════════════

import { CONFIG } from './config.mjs';
import fs from 'fs';
import path from 'path';

// ── Constants ──────────────────────────────────────────────────────────────────
const POLYGON_CHAIN = 'polygon';
const BOT_TX_INTERVAL_THRESHOLD_MS = 60_000;      // <60s avg between tx = likely bot
const HUMAN_TX_INTERVAL_THRESHOLD_MS = 600_000;    // >10min avg between tx = likely human
const BOT_CONTRACT_DIVERSITY_THRESHOLD = 5;        // ≤5 unique contracts = likely bot
const HUMAN_CONTRACT_DIVERSITY_THRESHOLD = 15;     // ≥15 unique contracts = likely human
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

// ── Moralis API helper ─────────────────────────────────────────────────────────
async function moralisGet(urlPath) {
  const apiKey = CONFIG.moralis.apiKey || process.env.MORALIS_API_KEY;
  if (!apiKey) {
    console.warn('⚠️  Moralis API key not set — wallet profiling disabled');
    return null;
  }

  const url = `https://deep-index.moralis.io/api/v2.2${urlPath}`;
  try {
    const r = await fetch(url, {
      headers: {
        'X-API-Key': apiKey,
        'Accept': 'application/json',
      },
    });
    if (!r.ok) {
      console.warn(`⚠️  Moralis API ${r.status}: ${await r.text()}`);
      return null;
    }
    return r.json();
  } catch (err) {
    console.warn(`⚠️  Moralis fetch error: ${err.message}`);
    return null;
  }
}

// ── Fetch transaction history for a wallet (last 30 days) ──────────────────────
async function fetchWalletTxs(address) {
  const thirtyDaysAgo = new Date(Date.now() - THIRTY_DAYS_MS).toISOString();
  const allTxs = [];
  let cursor = '';

  // Paginate through transactions
  for (let page = 0; page < 10; page++) { // cap at 10 pages
    let url = `/${address}?chain=${POLYGON_CHAIN}&from_date=${thirtyDaysAgo}&limit=100&order=DESC`;
    if (cursor) url += `&cursor=${cursor}`;
    const data = await moralisGet(url);
    if (!data) break;

    allTxs.push(...(data.result || []));
    cursor = data.cursor;
    if (!cursor || (data.result || []).length < 100) break;
  }

  return allTxs;
}

// ── Fetch wallet's first transaction date (wallet age) ─────────────────────────
async function fetchFirstTxDate(address) {
  const data = await moralisGet(`/${address}?chain=${POLYGON_CHAIN}&limit=1&order=ASC`);
  if (!data || !data.result || data.result.length === 0) return null;
  return data.result[0].block_timestamp || null;
}

// ── Analyze gas price patterns ─────────────────────────────────────────────────
function analyzeGasPrices(txs) {
  if (txs.length === 0) return { avgGasGwei: 0, gasVariationCV: 0, optimizedGas: false };

  const gasPrices = txs.map(tx => {
    const gasPrice = parseInt(tx.gas_price || '0', 10);
    return gasPrice / 1e9; // convert Wei to Gwei
  }).filter(g => g > 0);

  if (gasPrices.length === 0) return { avgGasGwei: 0, gasVariationCV: 0, optimizedGas: false };

  const avg = gasPrices.reduce((a, b) => a + b, 0) / gasPrices.length;
  const variance = gasPrices.reduce((s, v) => s + Math.pow(v - avg, 2), 0) / gasPrices.length;
  const stdDev = Math.sqrt(variance);
  const cv = avg > 0 ? stdDev / avg : 0;

  // Bots tend to use very consistent, optimized gas prices (low variation)
  const optimizedGas = cv < 0.15 && avg < 35; // low variation + low gas = bot pattern

  return { avgGasGwei: avg, gasVariationCV: cv, optimizedGas };
}

// ── Analyze contract interaction diversity ─────────────────────────────────────
function analyzeContractDiversity(txs) {
  const uniqueContracts = new Set();
  for (const tx of txs) {
    if (tx.to_address) uniqueContracts.add(tx.to_address.toLowerCase());
  }
  return {
    uniqueContractCount: uniqueContracts.size,
    contracts: [...uniqueContracts],
  };
}

// ── Analyze transaction timing patterns ────────────────────────────────────────
function analyzeTimingPatterns(txs) {
  if (txs.length < 2) return { avgIntervalMs: 0, medianIntervalMs: 0, txCount: txs.length };

  // Sort by timestamp ascending
  const sorted = txs
    .map(tx => new Date(tx.block_timestamp).getTime())
    .sort((a, b) => a - b);

  const intervals = [];
  for (let i = 1; i < sorted.length; i++) {
    intervals.push(sorted[i] - sorted[i - 1]);
  }

  const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  const sortedIntervals = [...intervals].sort((a, b) => a - b);
  const median = sortedIntervals[Math.floor(sortedIntervals.length / 2)];

  return {
    avgIntervalMs: avgInterval,
    medianIntervalMs: median,
    txCount: txs.length,
  };
}

// ── Score a wallet on "human likelihood" (0-100) ───────────────────────────────
function scoreHumanLikelihood(txs, timing, gas, contracts, firstTxDate) {
  let score = 50; // start neutral

  // 1. Transaction interval (max ±20 points)
  if (timing.avgIntervalMs > 0) {
    if (timing.avgIntervalMs < BOT_TX_INTERVAL_THRESHOLD_MS) {
      score -= 20; // very fast = bot-like
    } else if (timing.avgIntervalMs > HUMAN_TX_INTERVAL_THRESHOLD_MS) {
      score += 20; // slow = human-like
    } else {
      // Scale between thresholds
      const t = (timing.avgIntervalMs - BOT_TX_INTERVAL_THRESHOLD_MS) /
                (HUMAN_TX_INTERVAL_THRESHOLD_MS - BOT_TX_INTERVAL_THRESHOLD_MS);
      score += Math.round(t * 20 - 10);
    }
  }

  // 2. Gas price patterns (max ±15 points)
  if (gas.optimizedGas) {
    score -= 15; // highly optimized gas = bot
  } else if (gas.gasVariationCV > 0.4) {
    score += 10; // varied gas = human
  }

  // 3. Contract diversity (max ±20 points)
  if (contracts.uniqueContractCount <= BOT_CONTRACT_DIVERSITY_THRESHOLD) {
    score -= 15; // very few contracts = bot
  } else if (contracts.uniqueContractCount >= HUMAN_CONTRACT_DIVERSITY_THRESHOLD) {
    score += 15; // diverse = human
  } else {
    // Scale between thresholds
    const t = (contracts.uniqueContractCount - BOT_CONTRACT_DIVERSITY_THRESHOLD) /
              (HUMAN_CONTRACT_DIVERSITY_THRESHOLD - BOT_CONTRACT_DIVERSITY_THRESHOLD);
    score += Math.round(t * 15 - 5);
  }

  // 4. Transaction volume (max ±15 points)
  if (timing.txCount > 2000) {
    score -= 15; // extremely high tx count = bot
  } else if (timing.txCount < 500) {
    score += 10; // moderate tx count = human
  }

  // 5. Wallet age (max ±10 points)
  if (firstTxDate) {
    const ageDays = (Date.now() - new Date(firstTxDate).getTime()) / (24 * 3600 * 1000);
    if (ageDays > 365) {
      score += 10; // >1 year old = more likely human
    } else if (ageDays < 30) {
      score -= 10; // very new = possible bot
    } else if (ageDays > 90) {
      score += 5; // >3 months = somewhat established
    }
  }

  // 6. Time-of-day distribution (max ±20 points)
  // Bots trade 24/7; humans have sleep patterns
  if (txs.length > 20) {
    const hours = txs.map(tx => new Date(tx.block_timestamp).getUTCHours());
    const hourCounts = new Array(24).fill(0);
    for (const h of hours) hourCounts[h]++;
    const activeHours = hourCounts.filter(c => c > 0).length;
    if (activeHours >= 23) {
      score -= 20; // active nearly every hour = bot
    } else if (activeHours <= 14) {
      score += 10; // clear activity gaps = human (sleep)
    }
  }

  // Clamp to 0-100
  return Math.max(0, Math.min(100, score));
}

// ── Classify wallet based on score ─────────────────────────────────────────────
function classifyWallet(humanScore, contracts, specialization) {
  if (humanScore < 25) return 'CONFIRMED_BOT';
  if (humanScore < 50) return 'LIKELY_BOT';
  if (specialization > 0.5 && contracts.uniqueContractCount < 20) return 'HUMAN_SPECIALIST';
  return 'HUMAN_GENERALIST';
}

// ── Profile a single wallet ────────────────────────────────────────────────────
async function profileWallet(whale) {
  const { address, username } = whale;
  console.log(`  🔬 Profiling ${username} (${address.slice(0, 10)}...)`);

  const [txs, firstTxDate] = await Promise.all([
    fetchWalletTxs(address),
    fetchFirstTxDate(address),
  ]);

  if (!txs || txs.length === 0) {
    return {
      address,
      username,
      profile: {
        humanScore: 50,
        classification: 'UNKNOWN',
        txCount30d: 0,
        avgIntervalMs: 0,
        firstTxDate: firstTxDate,
        avgGasGwei: 0,
        uniqueContracts: 0,
        optimizedGas: false,
        activeHours: 0,
      },
    };
  }

  const timing = analyzeTimingPatterns(txs);
  const gas = analyzeGasPrices(txs);
  const contracts = analyzeContractDiversity(txs);
  const humanScore = scoreHumanLikelihood(txs, timing, gas, contracts, firstTxDate);

  // Determine specialization (what fraction of txs go to top 3 contracts)
  const contractCounts = {};
  for (const tx of txs) {
    const c = (tx.to_address || '').toLowerCase();
    if (c) contractCounts[c] = (contractCounts[c] || 0) + 1;
  }
  const top3 = Object.values(contractCounts).sort((a, b) => b - a).slice(0, 3);
  const top3Sum = top3.reduce((a, b) => a + b, 0);
  const specialization = txs.length > 0 ? top3Sum / txs.length : 0;

  const classification = classifyWallet(humanScore, contracts, specialization);

  return {
    address,
    username,
    profile: {
      humanScore,
      classification,
      txCount30d: timing.txCount,
      avgIntervalMs: timing.avgIntervalMs,
      medianIntervalMs: timing.medianIntervalMs,
      firstTxDate,
      avgGasGwei: gas.avgGasGwei,
      gasVariationCV: gas.gasVariationCV,
      optimizedGas: gas.optimizedGas,
      uniqueContracts: contracts.uniqueContractCount,
      specialization,
      activeHours: new Set(txs.map(tx => new Date(tx.block_timestamp).getUTCHours())).size,
    },
  };
}

// ── Profile multiple wallets and save results ──────────────────────────────────
export async function profileWallets(whales) {
  console.log(' ═══════════════════════════════════════════════════════');
  console.log(` 🔬 WALLET PROFILING — Analyzing ${whales.length} whales via Moralis`);
  console.log(' ═══════════════════════════════════════════════════════');

  const profiles = [];
  for (let i = 0; i < whales.length; i++) {
    const whale = whales[i];
    process.stdout.write(`\r  Profiling ${i + 1}/${whales.length}: ${whale.username}...`);
    try {
      const result = await profileWallet(whale);
      profiles.push(result);
    } catch (err) {
      console.warn(`\n  ⚠️  Failed to profile ${whale.username}: ${err.message}`);
      profiles.push({
        address: whale.address,
        username: whale.username,
        profile: {
          humanScore: 50,
          classification: 'UNKNOWN',
          txCount30d: 0,
          avgIntervalMs: 0,
        },
      });
    }
  }
  console.log('');

  // Save to data/wallet_profiles.json
  const stateDir = path.resolve(CONFIG.state.dir);
  if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });

  const outputFile = {
    profiledAt: new Date().toISOString(),
    walletCount: profiles.length,
    profiles,
  };

  const outPath = path.resolve(CONFIG.state.dir, 'wallet_profiles.json');
  fs.writeFileSync(outPath, JSON.stringify(outputFile, null, 2));

  // Print summary
  console.log('  Classification Summary:');
  const byClass = {};
  for (const p of profiles) {
    const c = p.profile.classification;
    byClass[c] = (byClass[c] || 0) + 1;
  }
  for (const [cls, count] of Object.entries(byClass).sort()) {
    console.log(`    ${cls}: ${count}`);
  }
  console.log(`  ✅ Profiles saved to ${outPath}\n`);

  // Return enriched whale data (merge profile into whale object)
  return whales.map(whale => {
    const prof = profiles.find(p => p.address === whale.address);
    return {
      ...whale,
      profile: prof?.profile || { humanScore: 50, classification: 'UNKNOWN' },
    };
  });
}

// Allow running standalone
if (process.argv[1]?.endsWith('moralis-wallet-profiler.mjs')) {
  console.log('🔬 Wallet Profiler — standalone mode');
  console.log('⚠️  This module is designed to be imported. Provide whales via profileWallets(whales).');
  process.exit(0);
}
