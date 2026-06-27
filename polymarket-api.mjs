// ═══════════════════════════════════════════════════════════════════════════════
//  POLYMARKET API CLIENT — Gamma + Data + CLOB
// ═══════════════════════════════════════════════════════════════════════════════

import { CONFIG } from './config.mjs';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Gamma API (public, no auth) ────────────────────────────────────────────────
export const Gamma = {
  async getMarkets(opts = {}) {
    const params = new URLSearchParams({
      active: 'true',
      closed: 'false',
      limit: String(opts.limit || 100),
      offset: String(opts.offset || 0),
      order: opts.order || 'volume',
      ascending: 'false',
      ...(opts.volume_num_min ? { volume_num_min: String(opts.volume_num_min) } : {}),
      ...(opts.liquidity_num_min ? { liquidity_num_min: String(opts.liquidity_num_min) } : {}),
    });
    const url = `${CONFIG.api.gamma}/markets?${params}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Gamma markets ${r.status}: ${await r.text()}`);
    return r.json();
  },

  async getMarket(conditionId) {
    const url = `${CONFIG.api.gamma}/markets?condition_ids=${conditionId}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Gamma market ${r.status}`);
    const arr = await r.json();
    return arr[0] || null;
  },

  async getEvents(opts = {}) {
    const params = new URLSearchParams({
      limit: String(opts.limit || 50),
      offset: String(opts.offset || 0),
      ...(opts.tag_id ? { tag_id: String(opts.tag_id) } : {}),
    });
    const url = `${CONFIG.api.gamma}/events?${params}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Gamma events ${r.status}`);
    return r.json();
  },

  async searchMarkets(query) {
    const url = `${CONFIG.api.gamma}/public-search?query=${encodeURIComponent(query)}&limit=10`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Gamma search ${r.status}`);
    return r.json();
  },
};

// ── Data API (public, no auth) ─────────────────────────────────────────────────
export const Data = {
  async getLeaderboard(opts = {}) {
    const params = new URLSearchParams({
      category: opts.category || 'OVERALL',
      timePeriod: opts.timePeriod || 'ALL',
      orderBy: opts.orderBy || 'PNL',
      limit: String(opts.limit || 50),
      offset: String(opts.offset || 0),
    });
    const url = `${CONFIG.api.data}/v1/leaderboard?${params}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Data leaderboard ${r.status}: ${await r.text()}`);
    return r.json();
  },

  async getPositions(wallet, opts = {}) {
    const params = new URLSearchParams({
      user: wallet,
      sizeThreshold: String(opts.sizeThreshold || 1),
      limit: String(opts.limit || 500),
      sortBy: opts.sortBy || 'CURRENT',
      sortDirection: 'DESC',
      ...(opts.redeemable !== undefined ? { redeemable: String(opts.redeemable) } : {}),
    });
    const url = `${CONFIG.api.data}/positions?${params}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Data positions ${r.status}: ${await r.text()}`);
    return r.json();
  },

  async getClosedPositions(wallet, opts = {}) {
    const params = new URLSearchParams({
      user: wallet,
      limit: String(opts.limit || 500),
      offset: String(opts.offset || 0),
    });
    const url = `${CONFIG.api.data}/closed-positions?${params}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Data closed-positions ${r.status}`);
    return r.json();
  },

  async getTrades(opts = {}) {
    const params = new URLSearchParams({
      limit: String(opts.limit || 100),
      offset: String(opts.offset || 0),
      takerOnly: String(opts.takerOnly ?? true),
      ...(opts.user ? { user: opts.user } : {}),
      ...(opts.market ? { market: opts.market } : {}),
      ...(opts.side ? { side: opts.side } : {}),
    });
    const url = `${CONFIG.api.data}/trades?${params}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Data trades ${r.status}`);
    return r.json();
  },

  async getActivity(wallet, opts = {}) {
    const params = new URLSearchParams({
      user: wallet,
      limit: String(opts.limit || 100),
      offset: String(opts.offset || 0),
    });
    const url = `${CONFIG.api.data}/activity?${params}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Data activity ${r.status}`);
    return r.json();
  },

  async getValue(wallet) {
    const url = `${CONFIG.api.data}/value?user=${wallet}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Data value ${r.status}`);
    return r.json();
  },

  async getHolders(conditionId, opts = {}) {
    const params = new URLSearchParams({
      market: conditionId,
      limit: String(opts.limit || 100),
    });
    const url = `${CONFIG.api.data}/holders?${params}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Data holders ${r.status}`);
    return r.json();
  },
};

// ── CLOB API (public for prices, auth for trading) ────────────────────────────
export const CLOB = {
  async getPrice(tokenId) {
    const url = `${CONFIG.api.clob}/price?token_id=${tokenId}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`CLOB price ${r.status}`);
    return r.json();
  },

  async getPrices(tokenIds) {
    const url = `${CONFIG.api.clob}/prices`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tokens: tokenIds.map(id => ({ token_id: id })) }),
    });
    if (!r.ok) throw new Error(`CLOB prices ${r.status}`);
    return r.json();
  },

  async getOrderBook(tokenId) {
    const url = `${CONFIG.api.clob}/book?token_id=${tokenId}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`CLOB book ${r.status}`);
    return r.json();
  },

  async getMidpoint(tokenId) {
    const url = `${CONFIG.api.clob}/midpoint?token_id=${tokenId}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`CLOB midpoint ${r.status}`);
    return r.json();
  },

  async getSpread(tokenId) {
    const url = `${CONFIG.api.clob}/spread?token_id=${tokenId}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`CLOB spread ${r.status}`);
    return r.json();
  },

  async getPricesHistory(tokenId, opts = {}) {
    const params = new URLSearchParams({
      token_id: tokenId,
      ...(opts.interval ? { interval: opts.interval } : {}),
      ...(opts.fidelity ? { fidelity: String(opts.fidelity) } : {}),
    });
    const url = `${CONFIG.api.clob}/prices-history?${params}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`CLOB prices-history ${r.status}`);
    return r.json();
  },

  // ── Authenticated endpoints (requires wallet) ────────────────────────────────
  // These are implemented in the Execution module (clob-executor.mjs) which
  // handles L1/L2 auth, order signing, and submission via the SDK.
};

// ── Rate limit helper ──────────────────────────────────────────────────────────
const rateLimitState = { lastRequest: 0, minIntervalMs: 100 };

export async function rateLimited(fn) {
  const now = Date.now();
  const elapsed = now - rateLimitState.lastRequest;
  if (elapsed < rateLimitState.minIntervalMs) {
    await sleep(rateLimitState.minIntervalMs - elapsed);
  }
  rateLimitState.lastRequest = Date.now();
  return fn();
}

// ── Retry helper ────────────────────────────────────────────────────────────────
export async function retry(fn, maxRetries = 3, backoffMs = 1000) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === maxRetries - 1) throw err;
      console.warn(`Retry ${i + 1}/${maxRetries}: ${err.message}`);
      await sleep(backoffMs * Math.pow(2, i));
    }
  }
}
