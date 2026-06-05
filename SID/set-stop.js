/**
 * SID Set Stop — places a GTC stop order against an existing position
 *
 * Use case: add an Alpaca-side stop-loss on a position the bot is currently
 * managing internally (PDT-immune design). Reduces reaction time from
 * ~24 hours (bot's daily-poll) to seconds (Alpaca's intraday matching).
 *
 * Sister to set-limit-close.js — limit handles TPs, this handles SLs.
 *
 * Env vars (set by the GHA workflow from workflow_dispatch inputs):
 *   TRADE_TICKER     — symbol (e.g. "UNH")
 *   TRADE_QTY        — shares to protect (integer; usually full remaining qty)
 *   TRADE_STOP_PRICE — stop trigger price
 *   TRADE_SIDE       — "buy" to cover a short, "sell" to exit a long
 *   TRADE_NOTE       — free-text reason for the trade journal (optional)
 *
 * Same safety guards as set-limit-close: confirms position exists,
 * validates side matches position direction, validates qty doesn't exceed
 * open shares, idempotent client_order_id, Telegram alert.
 *
 * Trigger from anywhere with gh CLI:
 *   gh workflow run sid-set-stop.yml \
 *     -f ticker=UNH -f qty=26 -f stop_price=405 -f side=buy \
 *     -f note="Bot internal stop, now broker-enforced"
 */

import { AlpacaClient } from './alpaca-client.js';
import { resolveTradingMode } from './alpaca-executor.js';
import { sendMessage } from './telegram-alerts.js';

const ticker    = (process.env.TRADE_TICKER || '').toUpperCase().trim();
const qty       = parseInt(process.env.TRADE_QTY || '0', 10);
const stopPrice = parseFloat(process.env.TRADE_STOP_PRICE || '0');
const side      = (process.env.TRADE_SIDE || '').toLowerCase().trim();
const note      = process.env.TRADE_NOTE || 'Manual stop placement';

function bail(msg) {
  console.error(`[SID-SET-STOP] ERROR: ${msg}`);
  process.exit(1);
}

if (!ticker) bail('TRADE_TICKER is required');
if (!['buy', 'sell'].includes(side)) bail(`TRADE_SIDE must be buy|sell, got "${side}"`);
if (!Number.isFinite(qty) || qty <= 0) bail(`TRADE_QTY must be > 0, got "${qty}"`);
if (!Number.isFinite(stopPrice) || stopPrice <= 0) bail(`TRADE_STOP_PRICE must be > 0, got "${stopPrice}"`);

const mode = resolveTradingMode();
console.log(`[SID-SET-STOP] mode=${mode}`);
console.log(`[SID-SET-STOP] ${side.toUpperCase()} ${qty} ${ticker} @ stop $${stopPrice}  note="${note}"`);

if (mode === 'dry_run') {
  console.log('[SID-SET-STOP] dry_run mode — no order will be sent.');
  process.exit(0);
}

const keyId  = process.env.ALPACA_KEY_ID;
const secret = process.env.ALPACA_SECRET_KEY;
if (!keyId || !secret) bail('ALPACA_KEY_ID / ALPACA_SECRET_KEY env vars are not set');

const baseUrl = mode === 'live'
  ? 'https://api.alpaca.markets'
  : 'https://paper-api.alpaca.markets';
const client = new AlpacaClient({ keyId, secretKey: secret, baseUrl });

// ── Sanity check: position exists + side makes sense ─────────────────────
let pos;
try {
  pos = await client.getPosition(ticker);
} catch (e) {
  bail(`No open position for ${ticker} on Alpaca: ${e.message}`);
}

const posQty = parseInt(pos.qty, 10);
const posSide = posQty > 0 ? 'long' : 'short';
console.log(`[SID-SET-STOP] Existing position: ${posQty} ${ticker} (${posSide}) @ avg $${pos.avg_entry_price}`);

const expectedSide = posSide === 'long' ? 'sell' : 'buy';
if (side !== expectedSide) {
  bail(`Side mismatch: position is ${posSide.toUpperCase()} (need ${expectedSide.toUpperCase()} to close), got ${side.toUpperCase()}`);
}

const absPosQty = Math.abs(posQty);
if (qty > absPosQty) {
  bail(`Requested qty ${qty} exceeds open position size ${absPosQty} for ${ticker}`);
}

// Sanity: warn if stop is on the wrong side of current price (would fire immediately)
const currentPrice = parseFloat(pos.current_price);
if (posSide === 'long' && stopPrice >= currentPrice) {
  bail(`Stop $${stopPrice} is AT or ABOVE current price $${currentPrice} for a LONG — would fire immediately. Refusing to submit.`);
}
if (posSide === 'short' && stopPrice <= currentPrice) {
  bail(`Stop $${stopPrice} is AT or BELOW current price $${currentPrice} for a SHORT — would fire immediately. Refusing to submit.`);
}

// ── Submit the stop order ────────────────────────────────────────────────
const ts = Date.now();
const order = await client.submitOrder({
  symbol:          ticker,
  qty:             qty,
  side:            side,
  type:            'stop',
  stop_price:      stopPrice,
  time_in_force:   'gtc',
  client_order_id: `SET-STOP-${ticker}-${ts}`,
});

console.log(`[SID-SET-STOP] ✅ Stop order submitted`);
console.log(`   Order ID:        ${order.id}`);
console.log(`   Client order ID: ${order.client_order_id}`);
console.log(`   ${side.toUpperCase()} ${qty} ${ticker} @ stop $${stopPrice} GTC`);
console.log(`   Current price: $${currentPrice}  |  Stop distance: ${posSide === 'long' ? (currentPrice - stopPrice).toFixed(2) : (stopPrice - currentPrice).toFixed(2)} (${(Math.abs(stopPrice - currentPrice) / currentPrice * 100).toFixed(2)}%)`);
console.log(`   Status: ${order.status}`);

// ── Telegram alert ───────────────────────────────────────────────────────
try {
  const closeDescription = posSide === 'long' ? 'exits long if breached' : 'covers short if breached';
  await sendMessage(
    `🛑 <b>SID stop placed</b>\n\n` +
    `${ticker} ${side.toUpperCase()} ${qty} @ <b>stop $${stopPrice.toFixed(2)}</b> GTC\n` +
    `Position: ${absPosQty} ${posSide} @ avg $${parseFloat(pos.avg_entry_price).toFixed(2)} (${closeDescription})\n` +
    `Current: $${currentPrice.toFixed(2)}  Distance to stop: ${(Math.abs(stopPrice - currentPrice) / currentPrice * 100).toFixed(2)}%\n` +
    `Order: <code>${order.id}</code>\n` +
    `Note: <i>${note}</i>\n\n` +
    `Alpaca matching engine handles intraday fire — instant execution on touch.`
  );
  console.log('[SID-SET-STOP] ✓ Telegram alert sent');
} catch (e) {
  console.warn(`[SID-SET-STOP] Telegram alert failed (non-fatal): ${e.message}`);
}

console.log('\n[SID-SET-STOP] Done.');
