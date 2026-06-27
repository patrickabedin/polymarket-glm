// ═══════════════════════════════════════════════════════════════════════════════
//  PUSD FLOW TRACKING (Moralis)
//  Monitor USDC transfers on Polygon to detect whale deposits to Polymarket.
//  A deposit to the exchange is a leading indicator that a trade is imminent.
// ═══════════════════════════════════════════════════════════════════════════════

import { CONFIG } from './config.mjs';
import { sendTelegram } from './telegram-bot.mjs';
import fs from 'fs';
import path from 'path';

// ── Constants ──────────────────────────────────────────────────────────────────
const USDC_CONTRACT = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const POLYMARKET_EXCHANGES = [
  '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E'.toLowerCase(), // CTF Exchange
  '0xC5d563A36AE78145C45a50134d48A1215220f80a'.toLowerCase(), // Neg Risk Adapter
];

const POLL_INTERVAL_MS = 60_000; // 60 seconds
const DECIMALS = 6;

// ── State: track last-seen transfer hash per wallet to avoid duplicate alerts ──
let seenTransfers = new Set(); // set of transaction hashes we've already alerted on
let trackingActive = false;
let pollTimer = null;

// ── Load persisted state ───────────────────────────────────────────────────────
function loadState() {
  const stateFile = path.resolve(CONFIG.state.dir, 'pusd_state.json');
  if (fs.existsSync(stateFile)) {
    const data = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    seenTransfers = new Set(data.seenTransfers || []);
  }
}

function saveState() {
  const stateFile = path.resolve(CONFIG.state.dir, 'pusd_state.json');
  const stateDir = path.dirname(stateFile);
  if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({
    seenTransfers: [...seenTransfers],
    savedAt: new Date().toISOString(),
  }, null, 2));
}

// ── Fetch ERC20 transfers for a wallet from Moralis ────────────────────────────
async function fetchUsdcTransfers(walletAddress) {
  const apiKey = CONFIG.moralis.apiKey || process.env.MORALIS_API_KEY;
  if (!apiKey) {
    console.warn('⚠️  Moralis API key not set — pUSD tracking disabled');
    return [];
  }

  const url = `https://deep-index.moralis.io/api/v2.2/${walletAddress}/erc20/transfers?chain=polygon&token_addresses=${USDC_CONTRACT}&limit=50&order=DESC`;

  try {
    const r = await fetch(url, {
      headers: {
        'X-API-Key': apiKey,
        'Accept': 'application/json',
      },
    });
    if (!r.ok) {
      console.warn(`⚠️  Moralis API ${r.status} for ${walletAddress}: ${await r.text()}`);
      return [];
    }
    const data = await r.json();
    return data.result || [];
  } catch (err) {
    console.warn(`⚠️  Moralis fetch error for ${walletAddress}: ${err.message}`);
    return [];
  }
}

// ── Process transfers for a single whale ──────────────────────────────────────
async function checkWhalePusdFlow(whale) {
  const { address, username } = whale;
  const transfers = await fetchUsdcPusdTransfers(address);

  for (const tx of transfers) {
    // Dedupe by transaction hash + log index
    const txKey = `${tx.transaction_hash}-${tx.log_index}`;
    if (seenTransfers.has(txKey)) continue;

    const fromAddr = (tx.from_address || '').toLowerCase();
    const toAddr = (tx.to_address || '').toLowerCase();
    const value = parseInt(tx.value || '0', 10) / Math.pow(10, DECIMALS);

    // Only alert on meaningful amounts (>$100)
    if (value < 100) {
      seenTransfers.add(txKey);
      continue;
    }

    // Whale SENDS USDC to a Polymarket exchange → deposit (pre-signal)
    if (fromAddr === address.toLowerCase() && POLYMARKET_EXCHANGES.includes(toAddr)) {
      await sendTelegram(
        `💰 PUSD FLOW: ${username} deposited $${value.toLocaleString(undefined, { maximumFractionDigits: 2 })} to Polymarket — may be entering a position soon`
      );
      console.log(`💰 PUSD deposit: ${username} → Polymarket exchange, $${value.toFixed(2)}`);
    }

    // Whale RECEIVES USDC from a Polymarket exchange → withdrawal (may signal exit/realized profit)
    if (toAddr === address.toLowerCase() && POLYMARKET_EXCHANGES.includes(fromAddr)) {
      console.log(`💸 PUSD withdrawal: ${username} ← Polymarket exchange, $${value.toFixed(2)}`);
      // Could emit alert here too, but spec focuses on deposits
    }

    seenTransfers.add(txKey);
  }
}

// ── Alias for clarity ──────────────────────────────────────────────────────────
const fetchUsdcPusdTransfers = fetchUsdcTransfers;

// ── Main polling loop ──────────────────────────────────────────────────────────
async function pollAllWhales(whales) {
  if (!trackingActive) return;

  for (const whale of whales) {
    try {
      await checkWhalePusdFlow(whale);
    } catch (err) {
      console.warn(`⚠️  pUSD tracking error for ${whale.username}: ${err.message}`);
    }
  }

  // Persist seen transfers (cap to prevent unbounded growth)
  if (seenTransfers.size > 10_000) {
    const arr = [...seenTransfers];
    seenTransfers = new Set(arr.slice(-5000));
  }
  saveState();
}

// ── Start pUSD flow tracking ───────────────────────────────────────────────────
export function startPusdTracking(whales) {
  if (!CONFIG.moralis.apiKey && !process.env.MORALIS_API_KEY) {
    console.warn('⚠️  Moralis API key not configured — pUSD flow tracking skipped');
    return;
  }

  console.log(`💵 pUSD Flow Tracker: monitoring ${whales.length} whales (poll: ${POLL_INTERVAL_MS / 1000}s)`);
  trackingActive = true;
  loadState();

  // Initial poll immediately
  pollAllWhales(whales);

  // Then poll on interval
  pollTimer = setInterval(() => pollAllWhales(whales), POLL_INTERVAL_MS);

  // Clean up on process exit
  process.on('SIGINT', () => {
    stopPusdTracking();
  });
  process.on('SIGTERM', () => {
    stopPusdTracking();
  });
}

// ── Stop pUSD flow tracking ────────────────────────────────────────────────────
export function stopPusdTracking() {
  trackingActive = false;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  saveState();
  console.log('💵 pUSD Flow Tracker stopped');
}

// Allow running standalone
if (process.argv[1]?.endsWith('moralis-pusd-tracker.mjs')) {
  console.log('💵 pUSD Flow Tracker — standalone mode');
  console.log('⚠️  This module is designed to be imported. Provide whales via startPusdTracking(whales).');
  process.exit(0);
}
