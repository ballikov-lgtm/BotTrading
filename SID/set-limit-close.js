/**
 * SID Set Limit Close — places a GTC limit order against an existing position
 *
 * Use case: you want to set a TP2-style intraday exit at a specific price level
 * (e.g. an S&D zone, a horizontal support/resistance, a Fib level), where
 * Alpaca's matching engine handles the continuous watch automatically. Avoids
 * the bot's daily-poll latency on the runner exit.
 *
 * Env vars (set by the GHA workflow from workflow_dispatch inputs):
 *   TRADE_TICKER       — symbol (e.g. "GOOG")
 *   TRADE_QTY          — shares to close (integer)
 *   TRADE_LIMIT_PRICE  — limit price (float)
 *   TRADE_SIDE         — "buy" to close a short, "sell" to close a long
 *   TRADE_NOTE         — free-text reason for the trade journal (optional)
 *
 * What it does:
 *   1. Confirms a position exists for that ticker (no point submitting if flat)
 *   2. Validates qty doesn't exceed open shares for that position
 *   3. Validates side matches what would actually close (buy for short, sell for long)
 *   4. Submits LIMIT order with GTC TIF, idempotent client_order_id
 *   5. Sends Telegram alert with order ID + level + position context
 *
 * Does NOT touch open-positions-sid.json — the bot reconciles via Alpaca's
 * position list on each scheduled run, so when the limit fills, the bot
 * will see the position closed and update local state automatically.
 *
 * Trigger from anywhere with gh CLI:
 *   gh workflow run sid-set-limit-close.yml \
 *     -f ticker=GOOG -f qty=13 -f limit_price=348 -f side=buy \
 *     -f note="S&D bounce target"
 */

import { AlpacaClient } from './alpaca-client.js';
import { resolveTradingMode } from './alpaca-executor.js';
import { sendMessage } from './telegram-alerts.js';

const ticker     = (process.env.TRADE_TICKER || '').toUpperCase().trim();
const qty        = parseInt(process.env.TRADE_QTY || '0', 10);
const limitPrice = parseFloat(process.env.TRADE_LIMIT_PRICE || '0');
const side       = (process.env.TRADE_SIDE || '').toLowerCase().trim();
const note       = process.env.TRADE_NOTE || 'Manual limit close';

function bail(msg) {
  console.error(`[SID-LIMIT-CLOSE] ERROR: ${msg}`);
  process.exit(1);
}

if (!ticker) bail('TRADE_TICKER is required');
if (!['buy', 'sell'].includes(side)) bail(`TRADE_SIDE must be buy|sell, got "${side}"`);
if (!Number.isFinite(qty) || qty <= 0) bail(`TRADE_QTY must be > 0, got "${qty}"`);
if (!Number.isFinite(limitPrice) || limitPrice <= 0) bail(`TRADE_LIMIT_PRICE must be > 0, got "${limitPrice}"`);

const mode = resolveTradingMode();
console.log(`[SID-LIMIT-CLOSE] mode=${mode}`);
console.log(`[SID-LIMIT-CLOSE] ${side.toUpperCase()} ${qty} ${ticker} @ limit $${limitPrice}  note="${note}"`);

if (mode === 'dry_run') {
  console.log('[SID-LIMIT-CLOSE] dry_run mode — no order will be sent.');
  process.exit(0);
}

const keyId  = process.env.ALPACA_KEY_ID;
const secret = process.env.ALPACA_SECRET_KEY;
if (!keyId || !secret) bail('ALPACA_KEY_ID / ALPACA_SECRET_KEY env vars are not set');

const baseUrl = mode === 'live'
  ? 'https://api.alpaca.markets'
  : 'https://paper-api.alpaca.markets';
const client = new AlpacaClient({ keyId, secretKey: secret, baseUrl });

// ── Sanity check: verify position exists + side makes sense ──────────────
let pos;
try {
  pos = await client.getPosition(ticker);
} catch (e) {
  bail(`No open position for ${ticker} on Alpaca: ${e.message}`);
}

const posQty = parseInt(pos.qty, 10);
const posSide = posQty > 0 ? 'long' : 'short';
console.log(`[SID-LIMIT-CLOSE] Existing position: ${posQty} ${ticker} (${posSide}) @ avg $${pos.avg_entry_price}`);

// "buy" closes a short (cover); "sell" closes a long. Reject mismatches.
const expectedSide = posSide === 'long' ? 'sell' : 'buy';
if (side !== expectedSide) {
  bail(`Side mismatch: position is ${posSide.toUpperCase()} (need ${expectedSide.toUpperCase()} to close), got ${side.toUpperCase()}`);
}

const absPosQty = Math.abs(posQty);
if (qty > absPosQty) {
  bail(`Requested qty ${qty} exceeds open position size ${absPosQty} for ${ticker}`);
}

// ── Submit the limit order ───────────────────────────────────────────────
const ts = Date.now();
const order = await client.submitOrder({
  symbol:          ticker,
  qty:             qty,
  side:            side,
  type:            'limit',
  limit_price:     limitPrice,
  time_in_force:   'gtc',
  client_order_id: `LIMIT-CLOSE-${ticker}-${ts}`,
});

console.log(`[SID-LIMIT-CLOSE] ✅ Limit order submitted`);
console.log(`   Order ID:        ${order.id}`);
console.log(`   Client order ID: ${order.client_order_id}`);
console.log(`   ${side.toUpperCase()} ${qty} ${ticker} @ $${limitPrice} GTC`);
console.log(`   Status: ${order.status}`);

// ── Telegram alert ───────────────────────────────────────────────────────
try {
  const directionEmoji = side === 'buy' ? '🟢' : '🔴';
  const closeDescription = posSide === 'long' ? 'closes long at target' : 'covers short at target';
  await sendMessage(
    `${directionEmoji} <b>SID limit-close placed</b>\n\n` +
    `${ticker} ${side.toUpperCase()} ${qty} @ <b>$${limitPrice.toFixed(2)}</b> GTC\n` +
    `Position: ${absPosQty} ${posSide} @ avg $${parseFloat(pos.avg_entry_price).toFixed(2)} (${closeDescription})\n` +
    `Order: <code>${order.id}</code>\n` +
    `Note: <i>${note}</i>\n\n` +
    `Alpaca matching engine handles intraday fill — no other infra needed.`
  );
  console.log('[SID-LIMIT-CLOSE] ✓ Telegram alert sent');
} catch (e) {
  console.warn(`[SID-LIMIT-CLOSE] Telegram alert failed (non-fatal): ${e.message}`);
}

console.log('\n[SID-LIMIT-CLOSE] Done.');
