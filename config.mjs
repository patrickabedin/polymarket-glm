// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//  POLYMARKET WHALE COPY TRADER — Configuration
//  All 5 layers in one engine: Discovery → Monitor → Execute → Risk → Alerts
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
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
    minTotalStake: 1000,                 // ≥$1,000 total stake (lowered from 5000 for tiered discovery)

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
    alwaysOnPollIntervalSec: 120,        // always-on polling interval (parallel with WS)
  },

  // ── Layer 3: Execution ────────────────────────────────────────────────────
  // Edge first, frequency second. No qualified signals today = no trades is correct.
  execution: {
    enabled: true,                       // auto-trade (Patrick said "must auto trade")
    copyRatio: 0.05,                     // copy 5% of whale's position size
    slippageBuffer: 0.04,                // limit order 4% above whale's entry (loosened — polling delay means price moves)
    orderType: 'GTC',                    // Good-til-cancelled limit orders
    fillTimeoutMin: 30,                  // cancel if not filled in 30min

    // Signal-type trading toggles
    tradeSingleWhale: true,             // trade on individual whale entries
    tradeConsensus: true,                // trade on consensus signals
    tradeEliteSharp: true,               // trade on elite sharp (A+ standalone) signals

    // Exit order timeout and reprice
    exitOrderTimeoutMin: 10,             // cancel exit if not filled in 10min
    exitRepriceEnabled: true,            // reprice exit at current best bid on timeout
    exitMaxRetries: 3,                   // max reprice attempts before returning to FILLED

    // Independent exit logic (don't blindly follow exits)
    exitLogic: {
      takeProfitPcts: [0.15, 0.30],     // TP1 at +15% from entry, TP2 at +30%
      scaleOutFraction: 0.5,             // sell half at first TP
      stopLossPct: 0.20,                // hard stop at -20% from entry
      trailingStopEnabled: true,
      trailingStopPct: 0.05,            // 5% trailing stop from peak
      holdToResolution: false,           // if none of above hit, hold to resolution
      whaleExitEnabled: true,           // exit when whale sells
    },

    // Wallet (MUST be set via env)
    privateKey: process.env.POLY_PRIVATE_KEY || '',
    funderAddress: process.env.POLY_FUNDER_ADDRESS || '',
    signatureType: 3,                    // 3 = POLY_1271 (EIP-1271 smart contract wallet)
  },

  // ── Trader Tiers ─────────────────────────────────────────────────────────────
  traderTiers: {
    tierA: {
      minWinRate: 0.80, minResolved: 30, maxAvgEntryPrice: 0.55,
      minProfitFactor: 1.5, minRecentActivityDays: 7,
      autoTradeStandalone: false,
    },
    tierAPlus: {
      minWinRate: 0.90, minResolved: 50, maxAvgEntryPrice: 0.50,
      minProfitFactor: 2.0, autoTradeStandalone: true,
      maxStandaloneSizeUsd: 2,
    },
    tierB: {
      minWinRate: 0.65, minResolved: 25, maxAvgEntryPrice: 0.60,
      minProfitFactor: 1.2,
    },
    tierC: {
      minWinRate: 0.55, minResolved: 10,
    },
  },

  // ── Consensus (weighted scoring) ──────────────────────────────────────────────
  consensus: {
    minWeightedScore: 3.0, whaleWeight: 1.5, sharpWeight: 1.0,
    eliteSharpWeight: 2.0, minUniqueTraders: 2, windowMin: 30,
    sameOutcomeOnly: true,
  },

  // ── Layer 4: Risk Management ──────────────────────────────────────────────────
  risk: {
    initialBankroll: 99.26,                // starting balance for tracking
    // ── $5 max checklist ──
    // copyRatio * whaleValue capped to this → $5
    // tradeEliteSharp maxStandaloneSizeUsd also capped to $2
    // NEVER increase without explicit approval
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

  // ── Moralis (on-chain) ────────────────────────────────────────────
  moralis: {
    apiKey: process.env.MORALIS_API_KEY || '',
    chain: 'polygon',
    // pUSD flow tracking
    pusdTracking: {
      enabled: false,  // disabled — requires Moralis (not needed for core trading)
      pollIntervalSec: 60,
      minDepositAlertUsd: 100,
    },
    // Wallet profiling
    walletProfiling: {
      enabled: false,  // disabled — requires Moralis (not needed for core trading)
      refreshIntervalHours: 24,
    },
  },

  // ── Multi-Source Discovery ─────────────────────────────────────────────────────
  multiSource: {
    enabled: true,
    // Sources to use (all enabled by default)
    sources: ['leaderboard', 'holders', 'onchain', 'social'],
    // Confluence bonuses
    confluenceBonus: {
      twoSources: 0.20,    // +20%
      threePlusSources: 0.40, // +40%
    },
    // Holders discovery
    holdersMinMarkets: 3,        // wallet must be in 3+ winning market holders
    holdersMinMarketVolume: 10000,
    // On-chain discovery
    onchainMinRedemptions: 3,    // wallet must have 3+ redemptions
    onchainMinTotalUsd: 1000,    // and $1000+ total redeemed
  },

  // ── PnL Logger ─────────────────────────────────────────────────────────
  pnlLogger: {
    enabled: true,
    dailySummaryHour: 8, // 08:00 UTC
    tradeLogFile: 'data/pnl_log.jsonl',
    dailyLogFile: 'data/pnl_daily.jsonl',
  },

  // ── State ──────────────────────────────────────────────────────────────
  state: {
    dir: './data',
    whaleDb: 'data/whales.json',
    positionsDb: 'data/positions.json',
    tradesDb: 'data/trades.json',
    logFile: 'data/polymarket_copier.jsonl',
  },
};

// Validate critical config
const DUMMY_KEY = /^0x0{64}$/i;
const DUMMY_FUNDER = /^0x0{40}$/i;
if (CONFIG.execution.enabled) {
  if (!CONFIG.execution.privateKey || DUMMY_KEY.test(CONFIG.execution.privateKey)) {
    console.warn('⚠️  POLY_PRIVATE_KEY is missing or a dummy zero key — execution disabled (alert-only mode)');
    CONFIG.execution.enabled = false;
  } else if (!CONFIG.execution.funderAddress || DUMMY_FUNDER.test(CONFIG.execution.funderAddress)) {
    console.warn('⚠️  POLY_FUNDER_ADDRESS is missing or a dummy zero address — execution disabled (alert-only mode)');
    CONFIG.execution.enabled = false;
  }
}
