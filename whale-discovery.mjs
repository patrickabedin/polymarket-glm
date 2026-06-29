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
export async function analyzeWallet(address) {
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
      closedPositions: resolved,  // raw closed positions for v2 scoring
      openPositions: openPositions, // Fix 11: expose open positions for recent activity checks
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

// ── Fix 3/11: Classify trader into tiers (A+, A, B, C) with real profit factor ──
export function classifyTraderTier(stats) {
  const tiers = CONFIG.traderTiers;

  // Fix 11: Compute real profit factor from closed positions
  const closedPositions = stats.closedPositions || [];
  const winningTrades = closedPositions.filter(p => (p.realizedPnl || 0) > 0);
  const losingTrades = closedPositions.filter(p => (p.realizedPnl || 0) <= 0);
  const grossProfit = winningTrades.reduce((s, p) => s + (p.realizedPnl || 0), 0);
  const grossLoss = Math.abs(losingTrades.reduce((s, p) => s + (p.realizedPnl || 0), 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0);

  // Fix 11: Compute total volume from all positions
  const allPositions = [...closedPositions, ...(stats.openPositions || [])];
  const totalVolume = allPositions.reduce((s, p) => s + (p.initialValue || 0), 0);

  // Fix 11: Check recent activity — has the trader opened any position in last minRecentActivityDays?
  const now = Date.now();
  const minRecentActivityDays = tiers.tierA.minRecentActivityDays;
  const recentCutoff = now - (minRecentActivityDays * 24 * 60 * 60 * 1000);
  const recentActivity = allPositions.some(p => {
    // Check multiple possible timestamp fields (closed positions have 'timestamp', open have 'endDate')
    const posTime = p.createdAt || p.timestamp || p.date || p.endDate;
    if (!posTime) return false;
    const ms = typeof posTime === 'number'
      ? (posTime > 1e12 ? posTime : posTime * 1000)  // epoch sec vs ms
      : new Date(posTime).getTime();
    return ms > recentCutoff;
  });

  console.log(`📊 Tier classification metrics for ${stats.address}: WR=${(stats.winRate * 100).toFixed(1)}% resolved=${stats.resolvedCount} avgEntry=${stats.avgEntryPrice.toFixed(3)} PF=${profitFactor === Infinity ? '∞' : profitFactor.toFixed(2)} grossProfit=$${grossProfit.toFixed(0)} grossLoss=$${grossLoss.toFixed(0)} recentActivity=${recentActivity} totalVolume=$${totalVolume.toFixed(0)}`);

  // Tier A+ (elite sharp): ≥90% WR, ≥50 resolved, ≤0.50 avg entry, ≥2.0 PF, recent activity
  if (
    stats.winRate >= tiers.tierAPlus.minWinRate &&
    stats.resolvedCount >= tiers.tierAPlus.minResolved &&
    stats.avgEntryPrice <= tiers.tierAPlus.maxAvgEntryPrice &&
    profitFactor >= tiers.tierAPlus.minProfitFactor &&
    recentActivity
  ) {
    console.log(`  → Classified as Tier A+ (recentActivity=${recentActivity})`);
    return 'tierAPlus';
  }

  // Tier A: ≥80% WR, ≥30 resolved, ≤0.55 avg entry, ≥1.5 PF, recent activity within 7 days
  if (
    stats.winRate >= tiers.tierA.minWinRate &&
    stats.resolvedCount >= tiers.tierA.minResolved &&
    stats.avgEntryPrice <= tiers.tierA.maxAvgEntryPrice &&
    profitFactor >= tiers.tierA.minProfitFactor &&
    recentActivity
  ) {
    return 'tierA';
  }

  // Tier B: ≥65% WR, ≥25 resolved, ≤0.60 avg entry, ≥1.2 PF
  if (
    stats.winRate >= tiers.tierB.minWinRate &&
    stats.resolvedCount >= tiers.tierB.minResolved &&
    stats.avgEntryPrice <= tiers.tierB.maxAvgEntryPrice &&
    profitFactor >= (tiers.tierB.minProfitFactor || 0)
  ) {
    return 'tierB';
  }

  // Tier C: ≥55% WR, ≥10 resolved (minimum bar)
  if (
    stats.winRate >= tiers.tierC.minWinRate &&
    stats.resolvedCount >= tiers.tierC.minResolved
  ) {
    return 'tierC';
  }

  return null; // doesn't qualify
}

// ── Filter wallets by quality criteria (Fix 3: expanded for tiers) ─────────────
function filterWhales(wallets) {
  // Fix 9: Pre-filter only removes obviously unqualified wallets; classifyTraderTier decides tier

  // Fix 9: Lower pre-filter to Tier C minimum (55%) to let classifyTraderTier decide
  // Only remove obviously unqualified wallets
  const basicFiltered = wallets.filter(w => {
    if (!w.stats) return false;
    if (w.stats.winRate < 0.55) return false;  // Tier C minimum
    if (w.stats.resolvedCount < 10) return false;  // minimum resolved positions
    if (w.stats.totalPnl < 0) return false;  // skip negative PnL wallets
    return true;
  });

  // Second pass: classify into tiers, keep A+, A, B (drop C for tracking)
  const tiered = basicFiltered.map(w => {
    const tier = classifyTraderTier(w.stats);
    w.tier = tier;
    return w;
  }).filter(w => w.tier && w.tier !== 'tierC'); // Track A+, A, B only

  console.log(`📊 Tier classification: ${tiered.filter(w => w.tier === 'tierAPlus').length} A+, ${tiered.filter(w => w.tier === 'tierA').length} A, ${tiered.filter(w => w.tier === 'tierB').length} B`);

  return tiered;
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

  // Fix 3: Cap tracked whales at 50 (was 20)
  const MAX_TRACKED = 50;
  const topWhales = scored.slice(0, MAX_TRACKED);

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
      tier: w.tier || 'tierB', // Fix 3: store trader tier
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
