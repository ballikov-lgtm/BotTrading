/**
 * SID Manual One-Off Trade — pipeline verification + hybrid S&D trades
 *
 * Driven entirely by env vars (no JSON inputs). Reads:
 *   TRADE_TICKER      — e.g. "MCD"
 *   TRADE_SIDE        — "long" | "short"
 *   TRADE_SHARES      — integer
 *   TRADE_TP1_PRICE   — float (limit close for 50% of position)
 *   TRADE_SL_PRICE    — float (stop close for full position)
 *   TRADE_NOTE        — free text, written to manual-trades-log.json
 *
 * What it does:
 *   1. Submits market entry (buy for long, sell for short)
 *   2. Polls Alpaca until the entry order fills (max 60s)
 *   3. Submits limit close for 50% of shares at TP1_PRICE  (tif=gtc)
 *   4. Submits stop close for ALL shares at SL_PRICE       (tif=gtc)
 *      → After TP1 fires, the stop fires for whatever shares remain.
 *   5. Appends a record to SID/manual-trades-log.json (separate from
 *      open-positions-sid.json so the real bot's state stays clean).
 *
 * Does NOT touch:
 *   - open-positions-sid.json
 *   - closed-positions-sid.json
 *   - sid-account.json
 *
 * TP2 (e.g. RSI 70 exit on the runner) is the user's manual job.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AlpacaClient } from './alpaca-client.js';
import { resolveTradingMode } from './alpaca-executor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Inputs ────────────────────────────────────────────────────────────────
const ticker      = (process.env.TRADE_TICKER || '').toUpperCase().trim();
const side        = (process.env.TRADE_SIDE   || '').toLowerCase().trim();
const shares      = parseInt(process.env.TRADE_SHARES || '0', 10);
const tp1Price    = parseFloat(process.env.TRADE_TP1_PRICE || '0');
const slPrice     = parseFloat(process.env.TRADE_SL_PRICE  || '0');
const note        = process.env.TRADE_NOTE || 'SID manual hybrid trade';

function bail(msg) {
  console.error(`[SID-MANUAL] ERROR: ${msg}`);
  process.exit(1);
}

if (!ticker) bail('TRADE_TICKER is required');
if (!['long', 'short'].includes(side)) bail(`TRADE_SIDE must be long|short, got "${side}"`);
if (!Number.isFinite(shares) || shares <= 0) bail(`TRADE_SHARES must be > 0, got "${shares}"`);
if (!Number.isFinite(tp1Price) || tp1Price <= 0) bail(`TRADE_TP1_PRICE must be > 0, got "${tp1Price}"`);
if (!Number.isFinite(slPrice)  || slPrice  <= 0) bail(`TRADE_SL_PRICE must be > 0, got "${slPrice}"`);

const entrySide = side === 'long' ? 'buy'  : 'sell';
const exitSide  = side === 'long' ? 'sell' : 'buy';
const tp1Qty    = Math.floor(shares / 2);
if (tp1Qty < 1) bail(`Cannot split ${shares} shares into a 50% TP1 — need at least 2 shares`);

// ── Mode + client ──────────────────────────────────────────────────────────
const mode = resolveTradingMode();
console.log(`[SID-MANUAL] mode=${mode}`);
console.log(`[SID-MANUAL] ${ticker} ${side.toUpperCase()} ${shares} shares  TP1=${tp1Price} (${tp1Qty}sh)  SL=${slPrice}  note="${note}"`);

if (mode === 'dry_run') {
  console.log('[SID-MANUAL] dry_run mode — no orders will be sent. Set SID_TRADING_MODE=paper to actually submit.');
  process.exit(0);
}

const keyId  = process.env.ALPACA_KEY_ID;
const secret = process.env.ALPACA_SECRET_KEY;
if (!keyId || !secret) bail('ALPACA_KEY_ID / ALPACA_SECRET_KEY env vars are not set');

const baseUrl = mode === 'live'
  ? 'https://api.alpaca.markets'
  : 'https://paper-api.alpaca.markets';
const client = new AlpacaClient({ keyId, secretKey: secret, baseUrl });

// ── Market-hours guard ─────────────────────────────────────────────────────
const clock = await client.getClock();
if (!clock.is_open) {
  bail(`Market is closed (next open: ${clock.next_open}). Refusing to submit manual trade.`);
}
console.log(`[SID-MANUAL] Market is open. Submitting entry…`);

// ── 1) Submit market entry ─────────────────────────────────────────────────
const ts = Date.now();
const prefix = `HYBRID-${ticker}-${ts}`;
const entryOrder = await client.submitOrder({
  symbol:          ticker,
  qty:             shares,
  side:            entrySide,
  type:            'market',
  time_in_force:   'day',
  client_order_id: `${prefix}-entry`,
});
console.log(`[SID-MANUAL] Entry submitted: ${entryOrder.id} (client_order_id: ${entryOrder.client_order_id})`);

// ── 2) Poll for fill (max 60s) ─────────────────────────────────────────────
let filled = null;
for (let i = 0; i < 30; i++) {
  await new Promise(r => setTimeout(r, 2000));
  const o = await client.getOrder(entryOrder.id);
  console.log(`[SID-MANUAL] Poll ${i+1}: status=${o.status} filled_qty=${o.filled_qty}/${o.qty} filled_avg=${o.filled_avg_price}`);
  if (o.status === 'filled') { filled = o; break; }
  if (['rejected', 'canceled', 'expired'].includes(o.status)) bail(`Entry order ${o.status}: ${o.failed_at || o.canceled_at}`);
}
if (!filled) bail('Entry order did not fill within 60 seconds. Investigate manually on Alpaca.');

const fillPrice = parseFloat(filled.filled_avg_price);
console.log(`[SID-MANUAL] ✅ Entry filled: ${filled.filled_qty} @ $${fillPrice.toFixed(2)}`);

// ── 3) Submit TP1 limit close (50%) ────────────────────────────────────────
const tp1Order = await client.submitOrder({
  symbol:          ticker,
  qty:             tp1Qty,
  side:            exitSide,
  type:            'limit',
  limit_price:     tp1Price,
  time_in_force:   'gtc',
  client_order_id: `${prefix}-tp1`,
});
console.log(`[SID-MANUAL] TP1 limit ${exitSide} ${tp1Qty} @ $${tp1Price} submitted: ${tp1Order.id}`);

// ── 4) Submit SL stop close (full) ─────────────────────────────────────────
const slOrder = await client.submitOrder({
  symbol:          ticker,
  qty:             shares,
  side:            exitSide,
  type:            'stop',
  stop_price:      slPrice,
  time_in_force:   'gtc',
  client_order_id: `${prefix}-sl`,
});
console.log(`[SID-MANUAL] SL stop ${exitSide} ${shares} @ $${slPrice} submitted: ${slOrder.id}`);

// ── 5) Append to manual-trades-log.json (separate from bot state) ──────────
const logPath = path.join(__dirname, 'manual-trades-log.json');
let logArr = [];
try {
  if (fs.existsSync(logPath)) logArr = JSON.parse(fs.readFileSync(logPath, 'utf8'));
  if (!Array.isArray(logArr)) logArr = [];
} catch (e) {
  console.warn(`[SID-MANUAL] Could not read existing log: ${e.message}. Starting fresh.`);
  logArr = [];
}

const record = {
  timestamp:        new Date().toISOString(),
  note,
  ticker,
  side,
  shares_total:     shares,
  tp1_shares:       tp1Qty,
  tp1_price:        tp1Price,
  sl_price:         slPrice,
  entry_fill_price: fillPrice,
  entry_order_id:   entryOrder.id,
  tp1_order_id:     tp1Order.id,
  sl_order_id:      slOrder.id,
  client_order_id_prefix: prefix,
  mode,
};
logArr.push(record);
fs.writeFileSync(logPath, JSON.stringify(logArr, null, 2));
console.log(`[SID-MANUAL] Recorded to ${logPath}`);

console.log('\n[SID-MANUAL] ✅ DONE');
console.log(`   Position: ${shares} shares ${side.toUpperCase()} ${ticker} @ $${fillPrice.toFixed(2)}`);
console.log(`   TP1 (limit ${exitSide} ${tp1Qty} @ $${tp1Price.toFixed(2)})  ← gtc, sits on Alpaca`);
console.log(`   SL  (stop  ${exitSide} ${shares} @ $${slPrice.toFixed(2)})  ← gtc, fires for whatever remains`);
console.log(`   TP2 logic (e.g. RSI 70 exit) is YOUR manual job — Alpaca won't auto-fire that.`);
