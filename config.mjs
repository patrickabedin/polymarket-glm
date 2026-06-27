// ═══════════════════════════════════════════════════════════════════════════════
//  POLYMARKET WHALE COPY TRADER — Configuration
//  All 5 layers in one engine: Discovery → Monitor → Execute → Risk → Alerts
// ═══════════════════════════════════════════════════════════════════════════════

export const CONFIG = {
  // ── Layer 1: Whale Discovery ──────────────────────────────────────────────────
  discovery: {
    leaderboardCategories: ['OVERALL', 'POLITICS', 'CRYPTO', 'SPORTS'],
    leaderboardTimePeriod: 'ALL',        // ALL = most stable cohort
    leaderboardOrderBy: 'PNL',
    topN: 50,                             // pull top 50 per category
    dedupAcrossCategories: true,

    // Wallet quality filters (from Patrick's research)
    minWinRate: 0.75,                     // ≥75% win rate
    minResolvedPositions: 10,             // ≥10 resolved positions
    maxAvgEntryPrice: 0.60,              // ≤0.60 avg entry (filters late scalpers)
    minTotalStake: 5000,                 // ≥$5,000 total stake

    // Scoring weights
    scoreWeights: {
      timingAccuracy: 0.30,              // entry before big price moves
      sizingConsistency: 0.20,           // consistent bet sizing (not reckless)
      categorySpecialization: 0.20,      // focused edge in 1-2 categories
      winRate: 0.20,                      // raw win rate
      pnlMagnitude: 0.10,                // absolute PnL
    },

    refreshIntervalMin: 60,              // re-rank whales every hour
    maxTrackedWallets: 20,               // track top 20
    minTrackedWallets: 5,                // need at least 5 for consensus
  },

  // ── Layer 2: Signal Monitoring ────────────────────────────────────────────────
  monitoring: {
    pollIntervalSec: 30,                 // poll whale positions every 30s
    consensusMinWhales: 3,               // 3+ whales in same market = strong signal
    consensusWindowMin: 10,              // within 10-minute window
    minPositionSizeUsd: 500,             // ignore tiny trades
    minWhaleStakePct: 0.01,             // whale must bet ≥1% of their book

    // Filter out
    filterMarketsNearResolution: true,
    filterResolutionBufferHours: 24,     // skip markets resolving <24h
    filterCryptoCandleBots: true,        // detect & skip latency-edge bots
    filterCryptoCandleVolThreshold: 50,  // if 1m vol >50x avg → likely bot
    minMarketLiquidity: 5000,            // market must have ≥$5k liquidity
  },

  // ── Layer 3: Execution ────────────────────────────────────────────────────────
  execution: {
    enabled: true,                       // auto-trade (Patrick said "must auto trade")
    copyRatio: 0.05,                     // copy 5% of whale's position size
    slippageBuffer: 0.02,                // limit order 2% above whale's entry
    orderType: 'GTC',                    // Good-til-cancelled limit orders
    fillTimeoutMin: 30,                  // cancel if not filled in 30min

    // Independent exit logic (don't blindly follow exits)
    exitLogic: {
      takeProfitRatios: [0.85, 0.90],   // scale out at 0.85 and 0.90
      scaleOutFraction: 0.5,             // sell half at first TP
      stopLossPrice: 0.20,              // hard stop if price drops to 0.20
      trailingStopEnabled: true,
      trailingStopPct: 0.10,            // 10% trailing stop from peak
      holdToResolution: true,           // if none of above hit, hold to resolution
    },

    // Wallet (MUST be set via env)
    privateKey: process.env.POLY_PRIVATE_KEY || '',
    funderAddress: process.env.POLY_FUNDER_ADDRESS || '',
    signatureType: 3,                    // 3 = POLY_1271 (EIP-1271 smart contract wallet)
  },

  // ── Layer 4: Risk Management ──────────────────────────────────────────────────
  risk: {
    maxPositionSizeUsd: 5,              // max $5 per trade (5% of $99 bankroll)
    maxDailyTrades: 5,
    maxConcurrentPositions: 8,
    maxConcurrentPerCategory: 3,         // max 3 in same category
    maxPortfolioDrawdownPct: 0.15,      // pause if drawdown >15%
    minBalanceUsd: 10,                   // stop if balance < $10
    dailyLossLimitUsd: 15,              // stop trading if daily loss > $15
    cooldownAfterLossMin: 30,           // 30min cooldown after a loss
  },

  // ── Layer 5: Telegram Alerts ──────────────────────────────────────────────────
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || '',
    alertOnWhaleEntry: true,
    alertOnConsensus: true,
    alertOnTrade: true,
    alertOnExit: true,
    alertOnRiskBreach: true,
    dailySummaryEnabled: true,
    dailySummaryHour: 8,                 // 8 AM UTC
  },

  // ── API Endpoints ──────────────────────────────────────────────────────────────
  api: {
    gamma: 'https://gamma-api.polymarket.com',
    data: 'https://data-api.polymarket.com',
    clob: 'https://clob.polymarket.com',
    chainId: 137,                        // Polygon mainnet
  },

  // ── Moralis (on-chain) ────────────────────────────────────────────────────────
  moralis: {
    apiKey: process.env.MORALIS_API_KEY || '',
    chain: 'polygon',
  },

  // ── State ──────────────────────────────────────────────────────────────────────
  state: {
    dir: './data',
    whaleDb: 'data/whales.json',
    positionsDb: 'data/positions.json',
    tradesDb: 'data/trades.json',
    logFile: 'data/polymarket_copier.jsonl',
  },
};

// Validate critical config
if (CONFIG.execution.enabled && !CONFIG.execution.privateKey) {
  console.warn('⚠️  POLY_PRIVATE_KEY not set — execution disabled (alert-only mode)');
  CONFIG.execution.enabled = false;
}
