// ═══════════════════════════════════════════════════════════════════════════════
//  LAYER 1: WHALE DISCOVERY
//  Scans Polymarket leaderboard → filters → scores → ranks top wallets
// ═══════════════════════════════════════════════════════════════════════════════

import { CONFIG } from './config.mjs';
import { Data, Gamma, retry, rateLimited } from './polymarket-api.mjs';
import { scoreWalletV2 } from './whale-scoring-v2.mjs';
import fs from 'fs';
import path from 'path';

// ── Fetch leaderboard across categories ────────────────────────────────────────
async function fetchLeaderboard() {
  const all = [];
  const seen = new Set();

  for (const category of CONFIG.discovery.leaderboardCategories) {
    console.log(`📊 Fetching ${category} leaderboard...`);
    const entries = await retry(() =>
      rateLimited(() =>
        Data.getLeaderboard({
          category,
          timePeriod: CONFIG.discovery.leaderboardTimePeriod,
          orderBy: CONFIG.discovery.leaderboardOrderBy,
          limit: CONFIG.discovery.topN,
        })
      )
    );

    for (const entry of entries) {
      const addr = entry.proxyWallet?.toLowerCase();
      if (!addr || (CONFIG.discovery.dedupAcrossCategories && seen.has(addr))) continue;
      seen.add(addr);

      all.push({
        address: addr,
        username: entry.userName || 'anon',
        pnl: entry.pnl || 0,
        volume: entry.vol || 0,
        rank: parseInt(entry.rank) || 9999,
        profileImage: entry.profileImage || '',
        xUsername: entry.xUsername || '',
        verifiedBadge: entry.verifiedBadge || false,
        category,
      });
    }
  }

  console.log(`📊 Leaderboard: ${all.length} unique wallets across ${CONFIG.discovery.leaderboardCategories.length} categories`);
  return all;
}

// ── Fetch closed positions for win rate / entry price analysis ──────────────────
async function analyzeWallet(address) {
  try {
    const [closedPositions, openPositions, value] = await Promise.all([
      retry(() => rateLimited(() => Data.getClosedPositions(address, { limit: 500 }))),
      retry(() => rateLimited(() => Data.getPositions(address, { limit: 500, redeemable: false }))),
      retry(() => rateLimited(() => Data.getValue(address))).catch(() => null),
    ]);

    // Win rate from closed positions
    const resolved = closedPositions.filter(p => p.redeemable || p.realizedPnl !== 0);
    const wins = resolved.filter(p => p.realizedPnl > 0);
    const losses = resolved.filter(p => p.realizedPnl <= 0);
    const winRate = resolved.length > 0 ? wins.length / resolved.length : 0;

    // Average entry price
    const allPositions = [...resolved, ...openPositions];
    const avgEntryPrice = allPositions.length > 0
      ? allPositions.reduce((s, p) => s + (p.avgPrice || 0), 0) / allPositions.length
      : 0;

    // Total stake (sum of initialValue across all positions)
    const totalStake = allPositions.reduce((s, p) => s + (p.initialValue || 0), 0);

    // Category specialization
    const categoryMap = {};
    for (const p of allPositions) {
      const slug = p.eventSlug || p.slug || 'unknown';
      const cat = slug.split('/')[0] || 'unknown';
      categoryMap[cat] = (categoryMap[cat] || 0) + 1;
    }
    const topCategory = Object.entries(categoryMap).sort((a, b) => b[1] - a[1])[0];
    const specialization = topCategory
      ? topCategory[1] / allPositions.length
      : 0;

    // Sizing consistency (coefficient of variation of initialValue)
    const stakes = allPositions.map(p => p.initialValue || 0).filter(v => v > 0);
    const avgStake = stakes.length > 0 ? stakes.reduce((a, b) => a + b, 0) / stakes.length : 0;
    const variance = stakes.length > 1
      ? stakes.reduce((s, v) => s + Math.pow(v - avgStake, 2), 0) / stakes.length
      : 0;
    const stdDev = Math.sqrt(variance);
    const sizingCV = avgStake > 0 ? stdDev / avgStake : 1; // lower = more consistent
    const sizingScore = Math.max(0, 1 - sizingCV); // 0-1, higher = better

    // Timing accuracy: how often did they enter before the price moved significantly?
    // Approximated: % of winning positions where avgPrice < curPrice (bought low)
    const timedWins = wins.filter(p => p.avgPrice < p.curPrice).length;
    const timingAccuracy = wins.length > 0 ? timedWins / wins.length : 0;

    // PnL magnitude (normalized)
    const totalPnl = closedPositions.reduce((s, p) => s + (p.realizedPnl || 0), 0);

    return {
      address,
      resolvedCount: resolved.length,
      openCount: openPositions.length,
      winRate,
      avgEntryPrice,
      totalStake,
      totalPnl,
      topCategory: topCategory ? topCategory[0] : 'unknown',
      specialization,
      sizingScore,
      timingAccuracy,
      portfolioValue: value?.value || 0,
    };
  } catch (err) {
    console.warn(`⚠️  Failed to analyze ${address}: ${err.message}`);
    return null;
  }
}

// ── Score a wallet ──────────────────────────────────────────────────────────────
function scoreWallet(stats) {
  const w = CONFIG.discovery.scoreWeights;

  // Normalize components to 0-1
  const winScore = Math.min(1, stats.winRate / CONFIG.discovery.minWinRate);
  const pnlScore = Math.min(1, Math.log10(Math.max(1, stats.totalPnl)) / 6); // log scale, $1M = 1.0
  const specScore = stats.specialization;
  const timingScore = stats.timingAccuracy;
  const sizingScore = stats.sizingScore;

  const score =
    winScore * w.winRate +
    pnlScore * w.pnlMagnitude +
    specScore * w.categorySpecialization +
    timingScore * w.timingAccuracy +
    sizingScore * w.sizingConsistency;

  return {
    score,
    components: { winScore, pnlScore, specScore, timingScore, sizingScore },
  };
}

// ── Filter wallets by quality criteria ─────────────────────────────────────────
function filterWhales(wallets) {
  const { minWinRate, minResolvedPositions, maxAvgEntryPrice, minTotalStake } = CONFIG.discovery;

  return wallets.filter(w => {
    if (!w.stats) return false;
    if (w.stats.winRate < minWinRate) return false;
    if (w.stats.resolvedCount < minResolvedPositions) return false;
    if (w.stats.avgEntryPrice > maxAvgEntryPrice) return false;
    if (w.stats.totalStake < minTotalStake) return false;
    return true;
  });
}

// ── Main discovery pipeline ─────────────────────────────────────────────────────
export async function discoverWhales() {
  console.log(' ═══════════════════════════════════════════════════════');
  console.log(' 🐋 WHALE DISCOVERY — Scanning Polymarket leaderboards');
  console.log(' ═══════════════════════════════════════════════════════');

  // 1. Fetch leaderboard
  const leaderboard = await fetchLeaderboard();

  // 2. Analyze each wallet (batch, but with rate limiting)
  const analyzed = [];
  for (let i = 0; i < leaderboard.length; i++) {
    const w = leaderboard[i];
    process.stdout.write(`\r🔍 Analyzing ${i + 1}/${leaderboard.length}: ${w.username}...`);
    const stats = await analyzeWallet(w.address);
    if (stats) {
      analyzed.push({ ...w, stats });
    }
  }
  console.log('');

  // 3. Filter by quality criteria
  const filtered = filterWhales(analyzed);
  console.log(`✅ ${filtered.length}/${analyzed.length} wallets pass quality filters`);

  // 4. Score and rank (using enhanced V2 scoring with 10 dimensions)
  const scored = filtered.map(w => {
    const { score, components } = scoreWalletV2(w.stats, w.profile || null, w.stats.closedPositions || null);
    return { ...w, score, scoreComponents: components };
  }).sort((a, b) => b.score - a.score);

  // 5. Take top N
  const topWhales = scored.slice(0, CONFIG.discovery.maxTrackedWallets);

  // 6. Save to state
  const stateDir = path.resolve(CONFIG.state.dir);
  if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });

  const whaleDb = {
    updatedAt: new Date().toISOString(),
    totalAnalyzed: analyzed.length,
    totalFiltered: filtered.length,
    whales: topWhales.map(w => ({
      address: w.address,
      username: w.username,
      category: w.category,
      score: w.score,
      scoreComponents: w.scoreComponents,
      stats: {
        winRate: w.stats.winRate,
        resolvedCount: w.stats.resolvedCount,
        avgEntryPrice: w.stats.avgEntryPrice,
        totalStake: w.stats.totalStake,
        totalPnl: w.stats.totalPnl,
        topCategory: w.stats.topCategory,
        specialization: w.stats.specialization,
        timingAccuracy: w.stats.timingAccuracy,
        sizingScore: w.stats.sizingScore,
        portfolioValue: w.stats.portfolioValue,
      },
      pnl: w.pnl,
      volume: w.volume,
      rank: w.rank,
      xUsername: w.xUsername,
      verifiedBadge: w.verifiedBadge,
    })),
  };

  fs.writeFileSync(
    path.resolve(CONFIG.state.whaleDb),
    JSON.stringify(whaleDb, null, 2)
  );

  console.log(`🐋 Top ${topWhales.length} whales saved to ${CONFIG.state.whaleDb}`);
  console.log('   Rank | Score | WR%   | Resolved | AvgEntry | PnL       | Username');
  console.log('   ─────┼──────┼───────┼──────────┼──────────┼───────────┼───────────');
  for (const w of topWhales.slice(0, 10)) {
    console.log(
      `   ${String(w.rank).padStart(4)} | ${w.score.toFixed(2)} | ${(w.stats.winRate * 100).toFixed(0)}%  | ${String(w.stats.resolvedCount).padStart(8)} | ${w.stats.avgEntryPrice.toFixed(3)}    | $${w.stats.totalPnl.toFixed(0).padStart(8)} | ${w.username}`
    );
  }

  return topWhales;
}

// Allow running standalone
if (process.argv[1]?.endsWith('whale-discovery.mjs')) {
  discoverWhales().then(() => process.exit(0)).catch(err => {
    console.error('❌', err);
    process.exit(1);
  });
}
