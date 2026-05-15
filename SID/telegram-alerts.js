/**
 * Telegram alert integration for SID bot.
 *
 * Sends one of three notification types via Telegram Bot API:
 *
 *   - signal_armed     — daily RSI extreme + RSI(3) confirmation (signal day)
 *   - entry_fired      — bot opened a position (paper or live)
 *   - exit_fired       — bot closed a position (RSI 50 or stop)
 *   - bot_status       — summary of every bot run (positions, P&L, errors)
 *
 * SETUP (one-time, ~2 minutes):
 *   1. On your phone, open Telegram and search @BotFather. Start a chat.
 *   2. Send /newbot. Pick a name (e.g. "SID Trading Bot") and a username
 *      ending in 'bot' (e.g. sid_trading_bot). BotFather replies with a
 *      TOKEN — save it.
 *   3. Search for your new bot in Telegram, start a chat, send any message.
 *   4. Open https://api.telegram.org/bot<TOKEN>/getUpdates in a browser.
 *      Find `"chat":{"id":NUMBER` — that's your chat ID.
 *   5. Add these two repo secrets in GitHub:
 *        TELEGRAM_BOT_TOKEN = <token from step 2>
 *        TELEGRAM_CHAT_ID   = <number from step 4>
 *   6. The next bot run will start sending alerts. To disable temporarily,
 *      set TELEGRAM_ALERTS_ENABLED=false in repo secrets.
 *
 * DESIGN NOTES:
 *   - All sends are best-effort. Telegram failures NEVER block trading.
 *   - Each alert is one POST to api.telegram.org. No external SDK.
 *   - HTML formatting is used for bold/italic. URLs are clickable.
 *   - Messages include a "[PAPER]" or "[LIVE]" tag so you can tell at a
 *     glance which Alpaca account just fired an order.
 */

import fetch from 'node-fetch';

const TG_API_BASE     = 'https://api.telegram.org';
const TG_BOT_TOKEN    = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT_ID      = process.env.TELEGRAM_CHAT_ID   || '';
const TG_ENABLED      = process.env.TELEGRAM_ALERTS_ENABLED !== 'false';
const TG_MAX_RETRIES  = 2;

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Send a "trade armed" alert when a signal arms but hasn't entered yet.
 * Useful for getting eyes on a chart before the entry fires.
 */
export async function alertSignalArmed({ symbol, side, rsi, rsi3, signalDate, mode }) {
  const emoji = side === 'long' ? '🟢' : '🔴';
  const modeTag = formatModeTag(mode);
  const msg = [
    `${emoji} <b>SID SIGNAL ARMED</b> ${modeTag}`,
    ``,
    `<b>${symbol}</b> — ${side.toUpperCase()}`,
    `RSI(14): ${rsi?.toFixed(1)}   RSI(3): ${rsi3?.toFixed(1)}`,
    `Signal day: ${signalDate}`,
    ``,
    `<i>Waiting for daily RSI + MACD direction-align to enter.</i>`,
    `<a href="https://www.tradingview.com/chart/?symbol=${encodeURIComponent(symbol)}">View ${symbol} chart</a>`,
  ].join('\n');
  return sendMessage(msg);
}

/**
 * Send an "entry fired" alert immediately after the bot opens a position.
 * In dry_run mode this still fires so the user can compare to live data.
 */
export async function alertEntryFired({ symbol, side, entryPrice, stopLoss, shares, riskUsd, orderId, mode }) {
  const emoji = side === 'long' ? '🟢' : '🔴';
  const modeTag = formatModeTag(mode);
  const total = (entryPrice * shares).toFixed(2);
  const msg = [
    `${emoji} <b>SID ENTRY FIRED</b> ${modeTag}`,
    ``,
    `<b>${symbol}</b> — ${side.toUpperCase()}  ${shares} sh`,
    `Entry:    $${entryPrice.toFixed(2)}`,
    `Stop:     $${stopLoss.toFixed(2)}`,
    `Position: $${total}   Risk: $${riskUsd?.toFixed(2)}`,
    `Target:   RSI(14) reaches 50`,
    ``,
    `Order ID: <code>${orderId}</code>`,
  ].join('\n');
  return sendMessage(msg);
}

/**
 * Send an "exit fired" alert when a position closes (RSI 50 or stop).
 * Includes realized P&L and updated account balance.
 */
export async function alertExitFired({ symbol, side, exitPrice, exitReason, realizedPnl, accountAfter, mode }) {
  const win    = realizedPnl >= 0;
  const emoji  = win ? '✅' : '❌';
  const modeTag = formatModeTag(mode);
  const sign   = realizedPnl >= 0 ? '+' : '';
  const reasonText = exitReason === 'rsi50' ? 'RSI 50 reached' : 'Stop loss hit';
  const msg = [
    `${emoji} <b>SID EXIT — ${win ? 'WIN' : 'LOSS'}</b> ${modeTag}`,
    ``,
    `<b>${symbol}</b> — ${side.toUpperCase()} closed @ $${exitPrice?.toFixed(2)}`,
    `Reason:    ${reasonText}`,
    `Realized:  ${sign}$${realizedPnl?.toFixed(2)}`,
    accountAfter ? `Account:   $${accountAfter.toFixed(2)}` : '',
  ].filter(Boolean).join('\n');
  return sendMessage(msg);
}

/**
 * Send a daily run summary. Called at the end of every bot run, win or lose.
 */
export async function alertBotStatus({ openCount, newEntries, closedToday, accountUsd, mode, errors = [] }) {
  const modeTag = formatModeTag(mode);
  const errBlock = errors.length
    ? `\n⚠️  <b>${errors.length} error(s)</b>:\n${errors.slice(0, 3).map(e => `  • ${escape(e)}`).join('\n')}`
    : '';
  const msg = [
    `📊 <b>SID Run Complete</b> ${modeTag}`,
    ``,
    `Open positions:    ${openCount}`,
    `New entries:       ${newEntries}`,
    `Closed today:      ${closedToday}`,
    `Account balance:   $${accountUsd?.toFixed(2)}`,
    errBlock,
  ].filter(Boolean).join('\n');
  return sendMessage(msg);
}

// ── Internals ───────────────────────────────────────────────────────────

function formatModeTag(mode) {
  if (!mode || mode === 'dry_run') return '<i>[DRY RUN]</i>';
  if (mode === 'paper')            return '<i>[PAPER]</i>';
  if (mode === 'live')             return '<b>[LIVE]</b>';
  return `<i>[${mode}]</i>`;
}

function escape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Best-effort send. Returns { sent: boolean, reason?: string } — never throws.
 * Logs to console on failure but never blocks the caller.
 */
export async function sendMessage(text) {
  if (!TG_ENABLED) return { sent: false, reason: 'TELEGRAM_ALERTS_ENABLED=false' };
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
    return { sent: false, reason: 'TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set' };
  }

  const url = `${TG_API_BASE}/bot${TG_BOT_TOKEN}/sendMessage`;
  const body = {
    chat_id: TG_CHAT_ID,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: false,
  };

  let attempt = 0;
  while (attempt <= TG_MAX_RETRIES) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) return { sent: true };
      const text = await res.text();
      console.warn(`[Telegram] HTTP ${res.status} attempt ${attempt + 1}: ${text.slice(0, 200)}`);
      if (res.status === 429 || res.status >= 500) {
        // backoff + retry
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        attempt++;
        continue;
      }
      return { sent: false, reason: `HTTP ${res.status}` };
    } catch (err) {
      console.warn(`[Telegram] Send failed attempt ${attempt + 1}: ${err.message}`);
      attempt++;
      if (attempt > TG_MAX_RETRIES) return { sent: false, reason: err.message };
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
  return { sent: false, reason: 'max retries exceeded' };
}

// ── CLI quick test ──────────────────────────────────────────────────────
// Run `node telegram-alerts.js test` to send a test message and verify
// your setup. The bot run does NOT do this — it's a manual sanity check.

if (process.argv[1] && process.argv[1].endsWith('telegram-alerts.js') && process.argv[2] === 'test') {
  (async () => {
    console.log('Sending Telegram test message...');
    console.log(`Bot token set:  ${TG_BOT_TOKEN ? 'yes' : 'NO — set TELEGRAM_BOT_TOKEN'}`);
    console.log(`Chat ID set:    ${TG_CHAT_ID ? 'yes' : 'NO — set TELEGRAM_CHAT_ID'}`);
    console.log(`Alerts enabled: ${TG_ENABLED}`);
    const result = await sendMessage(
      '✅ <b>SID Telegram test</b>\n\nIf you see this, your bot/chat config is working.\n\nNo trades have been placed.'
    );
    console.log(result.sent ? 'OK — check Telegram' : `FAIL — ${result.reason}`);
    process.exit(result.sent ? 0 : 1);
  })();
}
