// ═══════════════════════════════════════════════════════════════════════════════
//  MULTI-SOURCE WHALE DISCOVERY + CONFLUENCE
//  Expands beyond the Polymarket leaderboard to find hidden whales from
//  holders data, on-chain redemption events, and social signals.
// ═══════════════════════════════════════════════════════════════════════════════

import { CONFIG } from './config.mjs';
import { Data, Gamma, retry, rateLimited } from './polymarket-api.mjs';
import fs from 'fs';
import path from 'path';

// ── Polymarket exchange contract on Polygon (for on-chain scanning) ────────────
const CTF_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E'.toLowerCase();

// ═══════════════════════════════════════════════════════════════════════════════
//  SOURCE 1: Polymarket Leaderboard (existing approach)
// ═══════════════════════════════════════════════════════════════════════════════
async function discoverFromLeaderboard() {
  const all = [];
  const seen = new Set();

  for (const category of CONFIG.discovery.leaderboardCategories) {
    console.log(`  📊 Leaderboard: ${category}...`);
    try {
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
        if (!addr || seen.has(addr)) continue;
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
          source: 'leaderboard',
        });
      }
    } catch (err) {
      console.warn(`  ⚠️  Leaderboard fetch failed for ${category}: ${err.message}`);
    }
  }

  console.log(`  📊 Leaderboard: ${all.length} unique wallets`);
  return all;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SOURCE 2: Polymarket Holders API — cross-reference top holders across
//  multiple resolved winning markets. Wallets in top holders of 3+ winning
//  markets = hidden whales not on the leaderboard.
// ═══════════════════════════════════════════════════════════════════════════════
async function discoverFromHolders() {
  console.log('  👥 Holders: scanning high-volume resolved markets...');

  // Fix 13: Fetch CLOSED markets for holders discovery (was fetching active=true/closed=false)
  const markets = await retry(() =>
    rateLimited(() =>
      Gamma.getMarkets({ limit: 100, order: 'volume', active: false, closed: true })
    )
  ).catch(() => []);

  // Filter to resolved markets with significant volume
  const resolvedMarkets = markets.filter(m =>
    m.closed === true &&
    (m.volumeNum || 0) > 10000
  ).slice(0, 20); // check top 20 resolved markets

  console.log(`  👥 Holders: scanning ${resolvedMarkets.length} resolved markets`);

  // Map: wallet → list of markets where they're a top holder
  const holderMap = {}; // { address: [{ conditionId, market, position, size }] }

  for (const market of resolvedMarkets) {
    const conditionId = market.conditionId;
    if (!conditionId) continue;

    try {
      const holders = await retry(() =>
        rateLimited(() =>
          Data.getHolders(conditionId, { limit: 100 })
        )
      );

      // Determine the winning outcome
      const winningOutcome = market.outcome || null;

      for (let i = 0; i < holders.length; i++) {
        const holder = holders[i];
        const addr = (holder.address || holder.user || '').toLowerCase();
        if (!addr) continue;

        // Only track holders of the winning outcome
        if (winningOutcome && holder.outcome && holder.outcome !== winningOutcome) {
          continue;
        }

        if (!holderMap[addr]) {
          holderMap[addr] = {
            address: addr,
            username: holder.username || 'anon',
            markets: [],
            source: 'holders',
          };
        }

        holderMap[addr].markets.push({
          conditionId,
          market: market.question || market.title || '',
          position: i + 1,
          size: holder.size || 0,
          value: holder.value || 0,
        });
      }
    } catch (err) {
      console.warn(`  ⚠️  Holders fetch failed for ${conditionId?.slice(0, 16)}: ${err.message}`);
    }
  }

  // Filter: wallets that appear in top holders of 3+ winning markets
  const hiddenWhales = Object.values(holderMap)
    .filter(w => w.markets.length >= 3)
    .map(w => ({
      address: w.address,
      username: w.username,
      holderMarketCount: w.markets.length,
      totalHolderValue: w.markets.reduce((s, m) => s + (m.value || 0), 0),
      source: 'holders',
    }));

  console.log(`  👥 Holders: ${hiddenWhales.length} hidden whales (in 3+ winning markets)`);
  return hiddenWhales;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SOURCE 3: On-chain scanners — query Moralis for wallets that have interacted
//  with the CTF Exchange contract to redeem winning positions.
// ═══════════════════════════════════════════════════════════════════════════════
async function discoverFromOnchain() {
  console.log('  ⛓️  On-chain: scanning CTF Exchange interactions via Moralis...');

  const apiKey = CONFIG.moralis.apiKey || process.env.MORALIS_API_KEY;
  if (!apiKey) {
    console.warn('  ⚠️  Moralis API key not set — on-chain discovery skipped');
    return [];
  }

  // Fetch recent transactions to the CTF Exchange contract
  // We look for "redeem" function calls which indicate profitable traders
  try {
    const url = `https://deep-index.moralis.io/api/v2.2/${CTF_EXCHANGE}/erc20/transfers?chain=polygon&limit=500&order=DESC`;
    const r = await fetch(url, {
      headers: {
        'X-API-Key': apiKey,
        'Accept': 'application/json',
      },
    });

    if (!r.ok) {
      console.warn(`  ⚠️  Moralis on-chain API ${r.status}`);
      return [];
    }

    const data = await r.json();
    const transfers = data.result || [];

    // Count USDC withdrawals from the exchange (these are redemptions of winning positions)
    const redeemerMap = {}; // { address: { count, totalValue } }

    for (const tx of transfers) {
      const fromAddr = (tx.from_address || '').toLowerCase();
      const toAddr = (tx.to_address || '').toLowerCase();

      // If the exchange is sending USDC TO a wallet, that wallet redeemed winnings
      if (fromAddr === CTF_EXCHANGE && toAddr !== CTF_EXCHANGE) {
        const value = parseInt(tx.value || '0', 10) / 1e6; // USDC has 6 decimals
        if (!redeemerMap[toAddr]) {
          redeemerMap[toAddr] = { address: toAddr, count: 0, totalValue: 0 };
        }
        redeemerMap[toAddr].count++;
        redeemerMap[toAddr].totalValue += value;
      }
    }

    // Filter: wallets that have redeemed 3+ times with >$1000 total
    const onchainWhales = Object.values(redeemerMap)
      .filter(w => w.count >= 3 && w.totalValue >= 1000)
      .map(w => ({
        address: w.address,
        username: 'anon',
        redemptionCount: w.count,
        totalRedeemedUsd: Math.round(w.totalValue),
        source: 'onchain',
      }));

    console.log(`  ⛓️  On-chain: ${onchainWhales.length} wallets with 3+ redemptions`);
    return onchainWhales;
  } catch (err) {
    console.warn(`  ⚠️  On-chain discovery failed: ${err.message}`);
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SOURCE 4: Social signals — scrape Polymarket public profile pages for
//  wallets with verified Twitter/X accounts (social proof of expertise).
// ═══════════════════════════════════════════════════════════════════════════════
async function discoverFromSocial() {
  console.log('  🐦 Social: scanning Polymarket profiles for verified X accounts...');

  // Fetch leaderboard with X/Twitter data
  const socialWhales = [];

  try {
    // The leaderboard API already returns xUsername and verifiedBadge
    // We re-fetch with a focus on social proof
    const entries = await retry(() =>
      rateLimited(() =>
        Data.getLeaderboard({
          category: 'OVERALL',
          timePeriod: 'ALL',
          orderBy: 'PNL',
          limit: 100,
        })
      )
    );

    for (const entry of entries) {
      const addr = entry.proxyWallet?.toLowerCase();
      const xUsername = entry.xUsername || '';
      const verified = entry.verifiedBadge || false;

      if (addr && (xUsername || verified)) {
        socialWhales.push({
          address: addr,
          username: entry.userName || 'anon',
          xUsername,
          verifiedBadge: verified,
          pnl: entry.pnl || 0,
          source: 'social',
        });
      }
    }

    console.log(`  🐦 Social: ${socialWhales.length} wallets with social proof`);
  } catch (err) {
    console.warn(`  ⚠️  Social discovery failed: ${err.message}`);
  }

  return socialWhales;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  CONFLUENCE SCORING — When a whale appears in multiple sources,
//  their confluence score increases.
// ═══════════════════════════════════════════════════════════════════════════════
function applyConfluenceScore(aggregatedWhales) {
  return aggregatedWhales.map(whale => {
    const sourceCount = whale.sources.length;

    let confluenceMultiplier = 1.0;
    if (sourceCount >= 3) {
      confluenceMultiplier = 1.4; // +40% bonus
    } else if (sourceCount === 2) {
      confluenceMultiplier = 1.2; // +20% bonus
    }

    return {
      ...whale,
      confluenceScore: Math.round(confluenceMultiplier * 100) / 100,
      sourceCount,
    };
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  MAIN: Multi-source whale discovery with confluence
// ═══════════════════════════════════════════════════════════════════════════════
export async function discoverWhalesMultiSource() {
  console.log(' ═══════════════════════════════════════════════════════');
  console.log(' 🐋 MULTI-SOURCE WHALE DISCOVERY');
  console.log(' ═══════════════════════════════════════════════════════');

  // Run all discovery sources in parallel (except holders which depends on markets)
  const [leaderboardWhales, holdersWhales, onchainWhales, socialWhales] = await Promise.all([
    discoverFromLeaderboard(),
    discoverFromHolders(),
    discoverFromOnchain(),
    discoverFromSocial(),
  ]);

  // ── Aggregate and deduplicate ───────────────────────────────────────────────
  const whaleMap = {}; // { address: { ...whaleData, sources: [] } }

  const allSources = [
    { whales: leaderboardWhales, name: 'leaderboard' },
    { whales: holdersWhales, name: 'holders' },
    { whales: onchainWhales, name: 'onchain' },
    { whales: socialWhales, name: 'social' },
  ];

  for (const { whales, name } of allSources) {
    for (const whale of whales) {
      const addr = whale.address.toLowerCase();
      if (!whaleMap[addr]) {
        whaleMap[addr] = {
          address: addr,
          username: whale.username || 'anon',
          pnl: whale.pnl || 0,
          volume: whale.volume || 0,
          xUsername: whale.xUsername || '',
          verifiedBadge: whale.verifiedBadge || false,
          sources: [],
          sourceDetails: {},
        };
      }

      // Track which sources found this whale
      if (!whaleMap[addr].sources.includes(name)) {
        whaleMap[addr].sources.push(name);
      }

      // Merge source-specific data
      whaleMap[addr].sourceDetails[name] = {
        holderMarketCount: whale.holderMarketCount,
        totalHolderValue: whale.totalHolderValue,
        redemptionCount: whale.redemptionCount,
        totalRedeemedUsd: whale.totalRedeemedUsd,
        xUsername: whale.xUsername,
      };

      // Update username if we have a better one
      if (whale.username && whale.username !== 'anon' && whaleMap[addr].username === 'anon') {
        whaleMap[addr].username = whale.username;
      }

      // Update PnL/volume if leaderboard has data
      if (name === 'leaderboard') {
        whaleMap[addr].pnl = whale.pnl || whaleMap[addr].pnl;
        whaleMap[addr].volume = whale.volume || whaleMap[addr].volume;
        whaleMap[addr].rank = whale.rank;
      }
    }
  }

  // ── Apply confluence scoring ────────────────────────────────────────────────
  let aggregated = Object.values(whaleMap);
  aggregated = applyConfluenceScore(aggregated);

  // ── Sort by confluence score (desc), then by PnL (desc) ──────────────────────
  aggregated.sort((a, b) => {
    if (b.confluenceScore !== a.confluenceScore) {
      return b.confluenceScore - a.confluenceScore;
    }
    return (b.pnl || 0) - (a.pnl || 0);
  });

  // ── Save to data/whales_multisource.json ────────────────────────────────────
  const stateDir = path.resolve(CONFIG.state.dir);
  if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });

  const output = {
    discoveredAt: new Date().toISOString(),
    totalWhales: aggregated.length,
    sourceStats: {
      leaderboard: leaderboardWhales.length,
      holders: holdersWhales.length,
      onchain: onchainWhales.length,
      social: socialWhales.length,
    },
    whales: aggregated,
  };

  const outPath = path.resolve(CONFIG.state.dir, 'whales_multisource.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));

  console.log(`\n  ✅ Multi-source discovery complete:`);
  console.log(`     Total unique whales: ${aggregated.length}`);
  console.log(`     Sources: leaderboard=${leaderboardWhales.length}, holders=${holdersWhales.length}, onchain=${onchainWhales.length}, social=${socialWhales.length}`);

  // Print confluence distribution
  const bySourceCount = {};
  for (const w of aggregated) {
    bySourceCount[w.sourceCount] = (bySourceCount[w.sourceCount] || 0) + 1;
  }
  console.log('     Confluence distribution:');
  for (const [count, num] of Object.entries(bySourceCount).sort((a, b) => b[0] - a[0])) {
    console.log(`       ${count} source(s): ${num} whales (×${count >= 3 ? '1.4' : count === 2 ? '1.2' : '1.0'} bonus)`);
  }

  console.log(`     Saved to ${outPath}\n`);

  return aggregated;
}

// Allow running standalone
if (process.argv[1]?.endsWith('whale-sources-v2.mjs')) {
  discoverWhalesMultiSource()
    .then(() => process.exit(0))
    .catch(err => {
      console.error('❌', err);
      process.exit(1);
    });
}
