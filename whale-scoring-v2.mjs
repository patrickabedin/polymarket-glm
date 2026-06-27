// ═══════════════════════════════════════════════════════════════════════════════
//  WHALE SCORING V2 — Enhanced multi-dimensional scoring
//  Replaces the original 5-dimension score with a 10-dimension score (0-100).
// ═══════════════════════════════════════════════════════════════════════════════

import { CONFIG } from './config.mjs';

// ── Scoring dimensions (max points) ────────────────────────────────────────────
const MAX_POINTS = {
  winRate: 15,
  pnlMagnitude: 10,
  timingAccuracy: 15,
  sizingConsistency: 10,
  categorySpecialization: 10,
  streak: 10,
  holdTime: 10,
  riskAdjustedReturn: 10,
  counterConsensus: 5,
  botScore: 5,
};

// ── Compute current winning streak ─────────────────────────────────────────────
function computeStreak(closedPositions) {
  if (!closedPositions || closedPositions.length === 0) return { streak: 0, maxStreak: 0 };

  // Sort by resolution date descending (most recent first)
  const sorted = [...closedPositions]
    .filter(p => p.realizedPnl !== 0)
    .sort((a, b) => {
      const dateA = new Date(a.endDate || a.timestamp || 0).getTime();
      const dateB = new Date(b.endDate || b.timestamp || 0).getTime();
      return dateB - dateA;
    });

  let streak = 0;
  for (const p of sorted) {
    if (p.realizedPnl > 0) {
      streak++;
    } else {
      break; // streak broken
    }
  }

  // Compute max historical streak
  let maxStreak = 0;
  let currentRun = 0;
  for (const p of [...sorted].reverse()) {
    if (p.realizedPnl > 0) {
      currentRun++;
      maxStreak = Math.max(maxStreak, currentRun);
    } else {
      currentRun = 0;
    }
  }

  return { streak, maxStreak };
}

// ── Compute average position hold time ─────────────────────────────────────────
function computeAvgHoldTime(closedPositions) {
  if (!closedPositions || closedPositions.length === 0) return 0;

  const holdTimes = [];
  for (const p of closedPositions) {
    if (p.startDate && p.endDate) {
      const start = new Date(p.startDate).getTime();
      const end = new Date(p.endDate).getTime();
      if (end > start) holdTimes.push((end - start) / 60000); // minutes
    } else if (p.timestamp && p.endDate) {
      const start = new Date(p.timestamp).getTime();
      const end = new Date(p.endDate).getTime();
      if (end > start) holdTimes.push((end - start) / 60000);
    }
  }

  if (holdTimes.length === 0) return 0;
  return holdTimes.reduce((a, b) => a + b, 0) / holdTimes.length;
}

// ── Compute risk-adjusted return (Sharpe-like ratio) ──────────────────────────
function computeRiskAdjustedReturn(closedPositions) {
  if (!closedPositions || closedPositions.length === 0) return 0;

  const pnls = closedPositions
    .filter(p => p.realizedPnl !== 0)
    .map(p => p.realizedPnl);

  if (pnls.length < 2) return 0;

  const avgPnl = pnls.reduce((a, b) => a + b, 0) / pnls.length;
  const variance = pnls.reduce((s, v) => s + Math.pow(v - avgPnl, 2), 0) / pnls.length;
  const stdDev = Math.sqrt(variance);

  if (stdDev === 0) return avgPnl > 0 ? 2 : 0; // all same PnL

  const sharpe = avgPnl / stdDev;
  // Normalize: Sharpe > 1 is excellent, > 2 is elite
  return Math.min(2, sharpe);
}

// ── Compute counter-consensus score ────────────────────────────────────────────
// How often did the whale win on markets where they were in the minority?
function computeCounterConsensus(closedPositions) {
  if (!closedPositions || closedPositions.length === 0) return 0;

  // We approximate "minority" by looking at positions where avgPrice was
  // far from 0.5 (meaning the market strongly expected one outcome, and
  // the whale took the other side). If they won, that's counter-consensus.
  let counterConsensusWins = 0;
  let totalResolved = 0;

  for (const p of closedPositions) {
    if (p.realizedPnl === 0) continue;
    totalResolved++;

    // If avgPrice < 0.30 and they won, they bet on an underdog
    // If avgPrice > 0.70 and they won on YES, that's consensus, not counter
    const isUnderdogBet = p.avgPrice < 0.30;
    const isWin = p.realizedPnl > 0;

    if (isUnderdogBet && isWin) {
      counterConsensusWins++;
    }
  }

  return totalResolved > 0 ? counterConsensusWins / totalResolved : 0;
}

// ── Main scoring function ──────────────────────────────────────────────────────
// stats: the wallet stats from Data API (same as whale-discovery.mjs analyzeWallet)
// profile: optional wallet profile from moralis-wallet-profiler.mjs
// closedPositions: optional array of closed positions for advanced metrics
export function scoreWalletV2(stats, profile = null, closedPositions = null) {
  // ── Existing dimensions (from stats) ────────────────────────────────────────
  const winScore = Math.min(1, stats.winRate / CONFIG.discovery.minWinRate) * MAX_POINTS.winRate;

  const pnlScore = Math.min(1, Math.log10(Math.max(1, stats.totalPnl)) / 6) * MAX_POINTS.pnlMagnitude;

  const timingScore = (stats.timingAccuracy || 0) * MAX_POINTS.timingAccuracy;

  const sizingScore = (stats.sizingScore || 0) * MAX_POINTS.consistency || 0;
  const sizingNormalized = (stats.sizingScore || 0) * MAX_POINTS.sizingConsistency;

  const specScore = (stats.specialization || 0) * MAX_POINTS.categorySpecialization;

  // ── New dimensions ──────────────────────────────────────────────────────────

  // Streak factor (0-10): current winning streak normalized
  const { streak, maxStreak } = closedPositions
    ? computeStreak(closedPositions)
    : { streak: 0, maxStreak: 0 };
  const streakScore = Math.min(1, streak / 10) * MAX_POINTS.streak; // 10+ streak = max

  // Position hold time (0-10): longer holds = more conviction
  // <30min = scalper (low), 1-7 days = swing (good), >7 days = conviction (max)
  const avgHoldMin = closedPositions ? computeAvgHoldTime(closedPositions) : 0;
  let holdTimeNormalized;
  if (avgHoldMin === 0) {
    holdTimeNormalized = 0.3; // unknown, give partial credit
  } else if (avgHoldMin < 30) {
    holdTimeNormalized = 0.2; // scalper
  } else if (avgHoldMin < 180) { // <3 hours
    holdTimeNormalized = 0.4;
  } else if (avgHoldMin < 1440) { // <1 day
    holdTimeNormalized = 0.6;
  } else if (avgHoldMin < 10080) { // <7 days
    holdTimeNormalized = 0.8;
  } else {
    holdTimeNormalized = 1.0; // 7+ days = high conviction
  }
  const holdTimeScore = holdTimeNormalized * MAX_POINTS.holdTime;

  // Risk-adjusted return (0-10): Sharpe-like ratio
  const sharpe = closedPositions
    ? computeRiskAdjustedReturn(closedPositions)
    : 0;
  const riskAdjustedScore = (sharpe / 2) * MAX_POINTS.riskAdjustedReturn; // normalize 0-2 → 0-10

  // Counter-consensus (0-5): winning on underdog bets
  const counterConsensusRate = closedPositions
    ? computeCounterConsensus(closedPositions)
    : 0;
  const counterConsensusScore = counterConsensusRate * MAX_POINTS.counterConsensus;

  // Bot score (0-5): lower bot likelihood = more points
  // humanScore is 0-100, 100 = definitely human
  const humanScore = profile?.humanScore ?? 50;
  const botScore = (humanScore / 100) * MAX_POINTS.botScore;

  // ── Total score ─────────────────────────────────────────────────────────────
  const totalScore = Math.round(
    winScore +
    pnlScore +
    timingScore +
    sizingNormalized +
    specScore +
    streakScore +
    holdTimeScore +
    riskAdjustedScore +
    counterConsensusScore +
    botScore
  );

  return {
    score: Math.min(100, totalScore),
    components: {
      winRate: { points: winScore, max: MAX_POINTS.winRate },
      pnlMagnitude: { points: pnlScore, max: MAX_POINTS.pnlMagnitude },
      timingAccuracy: { points: timingScore, max: MAX_POINTS.timingAccuracy },
      sizingConsistency: { points: sizingNormalized, max: MAX_POINTS.sizingConsistency },
      categorySpecialization: { points: specScore, max: MAX_POINTS.categorySpecialization },
      streak: { points: streakScore, max: MAX_POINTS.streak, currentStreak: streak, maxStreak },
      holdTime: { points: holdTimeScore, max: MAX_POINTS.holdTime, avgHoldMin },
      riskAdjustedReturn: { points: riskAdjustedScore, max: MAX_POINTS.riskAdjustedReturn, sharpe },
      counterConsensus: { points: counterConsensusScore, max: MAX_POINTS.counterConsensus, rate: counterConsensusRate },
      botScore: { points: botScore, max: MAX_POINTS.botScore, humanScore },
    },
    maxPossible: 100,
  };
}

// Allow running standalone
if (process.argv[1]?.endsWith('whale-scoring-v2.mjs')) {
  console.log('📊 Whale Scoring V2 — standalone test');
  const testStats = {
    winRate: 0.82,
    totalPnl: 50000,
    timingAccuracy: 0.75,
    sizingScore: 0.80,
    specialization: 0.60,
  };
  const testProfile = { humanScore: 85 };
  const result = scoreWalletV2(testStats, testProfile);
  console.log('Score:', result.score, '/ 100');
  for (const [dim, data] of Object.entries(result.components)) {
    console.log(`  ${dim}: ${data.points.toFixed(1)}/${data.max}`);
  }
  process.exit(0);
}
