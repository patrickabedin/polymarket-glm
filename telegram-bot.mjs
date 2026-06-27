// ═══════════════════════════════════════════════════════════════════════════════
//  LAYER 5: TELEGRAM BOT — Alerts, dashboard, approve/reject
// ═══════════════════════════════════════════════════════════════════════════════

import { CONFIG } from './config.mjs';

// ── Send a Telegram message ────────────────────────────────────────────────────
export async function sendTelegram(text) {
  if (!CONFIG.telegram.botToken || !CONFIG.telegram.chatId) {
    console.warn('⚠️  Telegram not configured — message not sent');
    return;
  }

  try {
    const url = `https://api.telegram.org/bot${CONFIG.telegram.botToken}/sendMessage`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CONFIG.telegram.chatId,
        text,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      }),
    });
    if (!r.ok) {
      const err = await r.text();
      console.warn(`⚠️  Telegram send failed: ${r.status} ${err}`);
    }
  } catch (err) {
    console.warn(`⚠️  Telegram error: ${err.message}`);
  }
}

// ── Send a photo/image ──────────────────────────────────────────────────────────
export async function sendTelegramPhoto(photoUrl, caption) {
  if (!CONFIG.telegram.botToken || !CONFIG.telegram.chatId) return;

  try {
    const url = `https://api.telegram.org/bot${CONFIG.telegram.botToken}/sendPhoto`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CONFIG.telegram.chatId,
        photo: photoUrl,
        caption: caption || '',
        parse_mode: 'Markdown',
      }),
    });
    if (!r.ok) console.warn(`⚠️  Telegram photo failed: ${r.status}`);
  } catch (err) {
    console.warn(`⚠️  Telegram photo error: ${err.message}`);
  }
}

// ── Daily summary ──────────────────────────────────────────────────────────────
export async function sendDailySummary(stats, portfolio) {
  const lines = [
    '📊 *DAILY SUMMARY — Polymarket Whale Copier*',
    '',
    `*Date:* ${new Date().toISOString().slice(0, 10)}`,
    '',
    '*Trading:*',
    `  • Trades: ${stats.trades}`,
    `  • Wins: ${stats.wins} | Losses: ${stats.losses}`,
    `  • Win Rate: ${stats.trades > 0 ? ((stats.wins / stats.trades) * 100).toFixed(1) : 0}%`,
    `  • Realized PnL: $${stats.pnl.toFixed(2)}`,
    `  • Volume: $${stats.volume.toFixed(2)}`,
    '',
    '*Portfolio:*',
    `  • Active Positions: ${portfolio.activePositions}`,
    `  • Portfolio Value: $${portfolio.totalValue.toFixed(2)}`,
    `  • Unrealized PnL: $${portfolio.unrealizedPnl.toFixed(2)}`,
    `  • Status: ${portfolio.paused ? '⚠️ PAUSED — ' + portfolio.pauseReason : '✅ Active'}`,
  ];

  if (portfolio.cooldownRemaining > 0) {
    lines.push(`  • Cooldown: ${Math.ceil(portfolio.cooldownRemaining / 60000)}min remaining`);
  }

  await sendTelegram(lines.join('\n'));
}
