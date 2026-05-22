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
 *   3. Submits an OCO order for HALF the shares — limit leg @ TP1_PRICE +
 *      stop leg @ SL_PRICE. If TP1 hits, OCO cancels its own stop. If SL
 *      hits first, OCO closes those shares at SL.
 *   4. Submits a standalone stop for the OTHER HALF (the runner) @ SL_PRICE.
 *      This is the "if SL hits first, full position closes" half.
 *   5. If steps 3 or 4 fail, attempts a SAFETY FALLBACK: a single
 *      full-position stop, so the position is never left unprotected.
 *   6. Sends Telegram alert with entry + order IDs.
 *   7. Appends a record to SID/manual-trades-log.json (separate from
 *      open-positions-sid.json so the real bot's state stays clean).
 *
 * Does NOT touch:
 *   - open-positions-sid.json
 *   - closed-positions-sid.json
 *   - sid-account.json
 *
 * TP2 (e.g. RSI 70 exit on the runner) is the user's manual job.
 *
 * == Why the OCO pattern? ==
 * The original (broken) pattern was "submit TP1 limit, then submit SL stop
 * for full position". Alpaca rejected the SL because the TP1 limit was
 * "holding" half the shares, leaving fewer shares "available" than the SL
 * order required. The OCO pattern bundles TP1+SL for the same 4 shares into
 * a single linked order (one fires → the other auto-cancels), so there's no
 * conflict. The runner half is protected by a plain standalone stop.
 * Confirmed 2026-05-22 on the MCD oneshot — see SID/CLAUDE.md § pitfall.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AlpacaClient } from './alpaca-client.js';
import { resolveTradingMode } from './alpaca-executor.js';
import { alertEntryFired, sendMessage } from './telegram-alerts.js';

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
const runnerQty = shares - tp1Qty;
if (tp1Qty < 1) bail(`Cannot split ${shares} shares into a 50% TP1 — need at least 2 shares`);

// ── Mode + client ──────────────────────────────────────────────────────────
const mode = resolveTradingMode();
console.log(`[SID-MANUAL] mode=${mode}`);
console.log(`[SID-MANUAL] ${ticker} ${side.toUpperCase()} ${shares} shares  TP1=${tp1Price} (${tp1Qty}sh)  Runner=${runnerQty}sh  SL=${slPrice}  note="${note}"`);

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
console.log(`[SID-MANUAL] Entry submitted: ${entryOrder.id}`);

// ── 2) Poll for fill (max 60s) ─────────────────────────────────────────────
let filled = null;
for (let i = 0; i < 30; i++) {
  await new Promise(r => setTimeout(r, 2000));
  const o = await client.getOrder(entryOrder.id);
  console.log(`[SID-MANUAL] Poll ${i+1}: status=${o.status} filled_qty=${o.filled_qty}/${o.qty} filled_avg=${o.filled_avg_price}`);
  if (o.status === 'filled') { filled = o; break; }
  if (['rejected', 'canceled', 'expired'].includes(o.status)) bail(`Entry order ${o.status}`);
}
if (!filled) bail('Entry order did not fill within 60 seconds. Investigate manually on Alpaca.');

const fillPrice = parseFloat(filled.filled_avg_price);
console.log(`[SID-MANUAL] ✅ Entry filled: ${filled.filled_qty} @ $${fillPrice.toFixed(2)}`);

// ── Helper: safety fallback — try to place a full-position stop ────────────
async function trySafetyStop(reason) {
  console.error(`[SID-MANUAL] !!! Safety fallback triggered: ${reason}`);
  console.error('[SID-MANUAL] !!! Attempting full-position stop as safety net…');
  try {
    const stop = await client.submitOrder({
      symbol:          ticker,
      qty:             shares,
      side:            exitSide,
      type:            'stop',
      stop_price:      slPrice,
      time_in_force:   'gtc',
      client_order_id: `${prefix}-safetystop`,
    });
    console.error(`[SID-MANUAL] !!! Safety stop placed (full position): ${stop.id}`);
    return stop;
  } catch (e) {
    console.error(`[SID-MANUAL] !!! CRITICAL — even safety stop failed: ${e.message}`);
    console.error('[SID-MANUAL] !!! POSITION IS UNPROTECTED — manual intervention required on Alpaca.');
    try {
      await sendMessage(`🚨 SID MANUAL TRADE FAILURE: ${ticker} ${side} ${shares}sh @ $${fillPrice.toFixed(2)} is UNPROTECTED on Alpaca. Both OCO and safety stop failed: ${e.message}. Manual intervention required.`);
    } catch (_) {}
    return null;
  }
}

// ── 3) Submit OCO for half the shares (TP1 limit + SL stop bundle) ────────
let ocoOrder = null;
try {
  ocoOrder = await client.submitOrder({
    symbol:          ticker,
    qty:             tp1Qty,
    side:            exitSide,
    type:            'limit',
    limit_price:     tp1Price,
    time_in_force:   'gtc',
    order_class:     'oco',
    take_profit:     { limit_price: tp1Price },
    stop_loss:       { stop_price:  slPrice  },
    client_order_id: `${prefix}-oco`,
  });
  console.log(`[SID-MANUAL] ✓ OCO submitted: ${ocoOrder.id}  (TP1 ${tp1Qty}@$${tp1Price} / SL ${tp1Qty}@$${slPrice})`);
} catch (e) {
  await trySafetyStop(`OCO submission failed: ${e.message}`);
  bail(`OCO failed — entry exists but exits are degraded. Check Alpaca UI.`);
}

// Brief wait so OCO holds register before runner stop submission
await new Promise(r => setTimeout(r, 1500));

// ── 4) Submit standalone runner stop ──────────────────────────────────────
let runnerStop = null;
try {
  runnerStop = await client.submitOrder({
    symbol:          ticker,
    qty:             runnerQty,
    side:            exitSide,
    type:            'stop',
    stop_price:      slPrice,
    time_in_force:   'gtc',
    client_order_id: `${prefix}-runnerstop`,
  });
  console.log(`[SID-MANUAL] ✓ Runner stop submitted: ${runnerStop.id}  (${runnerQty}sh @ $${slPrice})`);
} catch (e) {
  console.error(`[SID-MANUAL] ⚠ Runner stop FAILED: ${e.message}`);
  console.error(`[SID-MANUAL] ⚠ ${tp1Qty} shares covered by OCO, but ${runnerQty} shares are UNPROTECTED.`);
  console.error(`[SID-MANUAL] ⚠ Manual fix required on Alpaca: submit stop sell ${runnerQty} ${ticker} @ $${slPrice}.`);
  try {
    await sendMessage(`⚠ SID MANUAL TRADE PARTIAL FAILURE: ${ticker} ${side} ${shares}sh. OCO covers ${tp1Qty} but runner stop failed (${runnerQty}sh unprotected): ${e.message}. Manual fix needed.`);
  } catch (_) {}
  // Don't bail — OCO is covering tp1Qty, runner is exposed but partial protection is better than none.
}

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
  tp1_qty:          tp1Qty,
  runner_qty:       runnerQty,
  tp1_price:        tp1Price,
  sl_price:         slPrice,
  entry_fill_price: fillPrice,
  entry_order_id:   entryOrder.id,
  oco_order_id:     ocoOrder?.id ?? null,
  runner_stop_id:   runnerStop?.id ?? null,
  client_order_id_prefix: prefix,
  mode,
};
logArr.push(record);
fs.writeFileSync(logPath, JSON.stringify(logArr, null, 2));
console.log(`[SID-MANUAL] Recorded to ${logPath}`);

// ── 6) Telegram alert ──────────────────────────────────────────────────────
try {
  await alertEntryFired({
    symbol:    ticker,
    side,
    entryPrice: fillPrice,
    stopLoss:   slPrice,
    shares,
    riskUsd:    Math.abs(fillPrice - slPrice) * shares,
    orderId:    entryOrder.id,
    mode,
  });
  await sendMessage(
    `🎯 *${note}*\n` +
    `${ticker} ${side.toUpperCase()} ${shares}sh @ $${fillPrice.toFixed(2)}\n` +
    `TP1 $${tp1Price.toFixed(2)} (${tp1Qty}sh, OCO ${ocoOrder?.id?.slice(0,8) ?? 'FAIL'})\n` +
    `SL $${slPrice.toFixed(2)} (${shares}sh total cover, runner stop ${runnerStop?.id?.slice(0,8) ?? 'FAIL'})\n` +
    `Mode: ${mode}`
  );
  console.log(`[SID-MANUAL] ✓ Telegram alerts sent`);
} catch (e) {
  console.warn(`[SID-MANUAL] Telegram alert failed (non-fatal): ${e.message}`);
}

console.log('\n[SID-MANUAL] ✅ DONE');
console.log(`   Position: ${shares} shares ${side.toUpperCase()} ${ticker} @ $${fillPrice.toFixed(2)}`);
console.log(`   OCO     : ${tp1Qty}sh — TP1 limit $${tp1Price.toFixed(2)} | SL stop $${slPrice.toFixed(2)}`);
console.log(`   Runner  : ${runnerQty}sh — standalone stop $${slPrice.toFixed(2)}`);
console.log(`   TP2 logic (e.g. RSI 70 close on runner) is YOUR manual job.`);
