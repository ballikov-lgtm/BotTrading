/**
 * SID Manual One-Off Close — discretionary close of a single open position.
 *
 * BUILT 2026-07-01 for the unwanted UNH bullish-asset short (id
 * d9bca959-f4e3-4fa0-bcf0-bfca2cb8c272, 2 sh @ $416.52, opened 2026-06-30 below
 * the 439-440 supply zone the v2.2.4 approval gate now guards against). It is
 * written generically (env-driven) so it can close any single open SID position
 * on approval, not just this one.
 *
 * DIFFERS from manual-trade.js: that OPENS a discretionary position and does NOT
 * touch bot state. This one CLOSES a position tracked in open-positions-sid.json
 * and DOES reconcile bot state (closed-positions-sid.json, trades-sid.csv,
 * sid-account.json, sid-log.json) + Telegram-confirms — because the position is
 * a real bot position that must leave the open ledger cleanly so the slot frees.
 *
 * What it does (in order), when run against a paper/live account:
 *   1. Loads open-positions-sid.json, finds the target position by CLOSE_POS_ID
 *      (or CLOSE_SYMBOL fallback). Aborts safely if not found.
 *   2. Market-hours guard (refuses if the market is closed).
 *   3. Cancels the broker stop order (CLOSE_STOP_ORDER_ID, or the position's
 *      brokerStopOrderId) so it can't double-fire against the cover order.
 *      Also sweeps any lingering open orders on the symbol (e.g. a resting -tp1).
 *   4. Submits a market order to FLATTEN the remaining shares (buy-to-cover for a
 *      short, sell for a long) and polls for the fill.
 *   5. Reconciles bot state:
 *        - removes the position from open-positions-sid.json
 *        - appends a closed record to closed-positions-sid.json (with exit
 *          price/date + reason)
 *        - appends a row to trades-sid.csv
 *        - updates sid-account.json with realised P&L
 *        - writes a `manual_close` entry to sid-log.json
 *   6. Telegram-confirms the close.
 *
 * Inputs (env vars — all optional except where noted):
 *   CLOSE_POS_ID        — the position id in open-positions-sid.json (preferred)
 *   CLOSE_SYMBOL        — fallback / cross-check symbol (e.g. "UNH")
 *   CLOSE_STOP_ORDER_ID — the broker stop order id to cancel (else uses the
 *                         position's brokerStopOrderId)
 *   CLOSE_REASON        — free text stored on the closed record + journal
 *   SID_TRADING_MODE    — dry_run (default) | paper | live  (same gating as the bot)
 *   SID_LIVE_CONFIRMED  — required token for live (defence-in-depth)
 *   ALPACA_KEY_ID / ALPACA_SECRET_KEY — creds
 *
 * SAFETY:
 *   - dry_run mode (default) prints the plan and exits WITHOUT touching Alpaca or
 *     any state file. Set SID_TRADING_MODE=paper to actually flatten.
 *   - If the entry position isn't found locally it aborts (does NOT blind-flatten
 *     the symbol on Alpaca) — prevents clobbering an unrelated position.
 *   - If the cover order doesn't fill, state is NOT reconciled (the next bot run's
 *     syncPositions would catch a genuine external fill anyway).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AlpacaClient } from './alpaca-client.js';
import { resolveTradingMode } from './alpaca-executor.js';
import { sendMessage } from './telegram-alerts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const POSITIONS_PATH  = path.join(__dirname, 'open-positions-sid.json');
const CLOSED_PATH     = path.join(__dirname, 'closed-positions-sid.json');
const ACCOUNT_PATH    = path.join(__dirname, 'sid-account.json');
const TRADES_PATH     = path.join(__dirname, 'trades-sid.csv');
const SAFETY_LOG_PATH = path.join(__dirname, 'sid-log.json');

// ── Inputs ──────────────────────────────────────────────────────────────────
const posId        = (process.env.CLOSE_POS_ID || '').trim();
const symbolIn     = (process.env.CLOSE_SYMBOL || '').toUpperCase().trim();
const stopOrderIn  = (process.env.CLOSE_STOP_ORDER_ID || '').trim();
const closeReason  = process.env.CLOSE_REASON
  || 'manual close — unwanted bullish-asset short below supply zone';

function bail(msg) {
  console.error(`[SID-CLOSE] ERROR: ${msg}`);
  process.exit(1);
}

if (!posId && !symbolIn) bail('Provide CLOSE_POS_ID (preferred) or CLOSE_SYMBOL');

// ── Small local helpers (mirror bot-sid.js so state stays schema-consistent) ──
function todayString() { return new Date().toISOString().slice(0, 10); }

function readJSON(p, fallback) {
  try { if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
  return fallback;
}
function writeJSON(p, obj) { fs.writeFileSync(p, JSON.stringify(obj, null, 2)); }

function writeLog(entry) {
  let log = readJSON(SAFETY_LOG_PATH, []);
  if (!Array.isArray(log)) log = [];
  log.unshift({ timestamp: new Date().toISOString(), ...entry });
  writeJSON(SAFETY_LOG_PATH, log.slice(0, 500));
}

function appendTrade(row) {
  const header = 'Date,Time,Exchange,Symbol,Side,Shares,Entry Price,Stop Loss,Total USD,Risk USD,Risk %,Signal Date,Order ID,Mode,Strategy';
  if (!fs.existsSync(TRADES_PATH)) fs.writeFileSync(TRADES_PATH, header + '\n');
  fs.appendFileSync(TRADES_PATH, row + '\n');
}

function updateAccount(realizedPnl) {
  const account = readJSON(ACCOUNT_PATH, null);
  if (!account) return null;
  account.accountUsd  = parseFloat((account.accountUsd + realizedPnl).toFixed(2));
  account.realizedPnl = parseFloat((account.realizedPnl + realizedPnl).toFixed(2));
  account.tradeCount += 1;
  account.lastUpdated = todayString();
  writeJSON(ACCOUNT_PATH, account);
  return account;
}

// ── Locate the target position in the LOCAL open ledger ───────────────────────
const openPositions = readJSON(POSITIONS_PATH, []);
if (!Array.isArray(openPositions)) bail('open-positions-sid.json is not an array');

const pos = openPositions.find(p =>
  (posId    && p.id === posId) ||
  (!posId   && symbolIn && String(p.symbol).toUpperCase() === symbolIn)
);
if (!pos) {
  bail(`Target position not found in open-positions-sid.json ` +
       `(CLOSE_POS_ID="${posId}" CLOSE_SYMBOL="${symbolIn}"). ` +
       `Nothing closed. Verify the id/symbol against the live state file.`);
}
if (symbolIn && String(pos.symbol).toUpperCase() !== symbolIn) {
  bail(`Symbol mismatch: position ${pos.id} is ${pos.symbol}, but CLOSE_SYMBOL="${symbolIn}". Aborting for safety.`);
}

const symbol   = String(pos.symbol).toUpperCase();
const side     = String(pos.side).toLowerCase();               // 'long' | 'short'
const coverQty = pos.shares_remaining ?? pos.shares;           // shares to flatten
const exitSide = side === 'long' ? 'sell' : 'buy';             // buy-to-cover a short
const stopOrderId = stopOrderIn || pos.brokerStopOrderId || null;

// ── Mode + client ─────────────────────────────────────────────────────────────
const mode = resolveTradingMode();
console.log(`[SID-CLOSE] mode=${mode}`);
console.log(`[SID-CLOSE] target: ${symbol} ${side.toUpperCase()} ${coverQty}sh (entry $${pos.entry}) id=${pos.id}`);
console.log(`[SID-CLOSE] plan: cancel stop ${stopOrderId || '(none)'} → ${exitSide.toUpperCase()} ${coverQty} ${symbol} @ market → reconcile state`);
console.log(`[SID-CLOSE] reason: "${closeReason}"`);

if (mode === 'dry_run') {
  console.log('[SID-CLOSE] dry_run — no Alpaca calls, no state changes. Set SID_TRADING_MODE=paper to actually close.');
  process.exit(0);
}

if (!Number.isFinite(coverQty) || coverQty <= 0) bail(`Nothing to close — coverQty=${coverQty}`);

const keyId  = process.env.ALPACA_KEY_ID;
const secret = process.env.ALPACA_SECRET_KEY;
if (!keyId || !secret) bail('ALPACA_KEY_ID / ALPACA_SECRET_KEY env vars are not set');

const baseUrl = mode === 'live'
  ? 'https://api.alpaca.markets'
  : 'https://paper-api.alpaca.markets';
const client = new AlpacaClient({ keyId, secretKey: secret, baseUrl });

// ── Market-hours guard ────────────────────────────────────────────────────────
const clock = await client.getClock();
if (!clock.is_open) {
  bail(`Market is closed (next open: ${clock.next_open}). Refusing to submit the close (a market cover would fill at next open — re-run during RTH).`);
}
console.log('[SID-CLOSE] Market is open. Proceeding.');

// ── 1) Cancel the broker stop (and sweep any other open orders on the symbol) ──
if (stopOrderId) {
  try {
    await client.cancelOrder(stopOrderId);
    console.log(`[SID-CLOSE] ✓ Cancelled stop order ${stopOrderId}`);
  } catch (e) {
    console.warn(`[SID-CLOSE] ⚠ Could not cancel stop ${stopOrderId} (may already be gone): ${e.message}`);
  }
}
// Belt-and-braces: cancel any lingering open orders on the symbol (e.g. -tp1
// resting limit) so nothing races the cover order or holds shares.
try {
  const openOrders = await client.listOrders({ status: 'open', symbols: symbol, limit: 50 });
  for (const o of (openOrders || [])) {
    if (o.id === stopOrderId) continue;
    try {
      await client.cancelOrder(o.id);
      console.log(`[SID-CLOSE] ✓ Cancelled lingering open order ${o.id} (${o.type} ${o.side})`);
    } catch (e) {
      console.warn(`[SID-CLOSE] ⚠ Could not cancel order ${o.id}: ${e.message}`);
    }
  }
} catch (e) {
  console.warn(`[SID-CLOSE] ⚠ Could not list open orders for ${symbol}: ${e.message}`);
}
// Give Alpaca a moment to release held shares before the cover order.
await new Promise(r => setTimeout(r, 1200));

// ── 2) Submit the flattening market order + poll for fill ─────────────────────
const ts = Date.now();
let coverOrder;
try {
  coverOrder = await client.submitOrder({
    symbol,
    qty:             coverQty,
    side:            exitSide,           // buy-to-cover for a short; sell for a long
    type:            'market',
    time_in_force:   'day',
    client_order_id: `MANCLOSE-${symbol}-${ts}`,
  });
  console.log(`[SID-CLOSE] Cover order submitted: ${coverOrder.id} (${exitSide} ${coverQty} ${symbol} @ market)`);
} catch (e) {
  bail(`Cover order submission FAILED: ${e.message}. Position NOT closed, state NOT changed. Check Alpaca UI.`);
}

let filled = null;
for (let i = 0; i < 30; i++) {
  await new Promise(r => setTimeout(r, 2000));
  const o = await client.getOrder(coverOrder.id);
  console.log(`[SID-CLOSE] Poll ${i + 1}: status=${o.status} filled_qty=${o.filled_qty}/${o.qty} filled_avg=${o.filled_avg_price}`);
  if (o.status === 'filled') { filled = o; break; }
  if (['rejected', 'canceled', 'expired'].includes(o.status)) {
    bail(`Cover order ${o.status}. Position NOT closed, state NOT changed. Investigate on Alpaca.`);
  }
}
if (!filled) {
  bail('Cover order did not fill within 60s. State NOT reconciled — re-check Alpaca; the next SID bot run will reconcile a genuine fill via syncPositions.');
}

const exitPrice = parseFloat(filled.filled_avg_price);
console.log(`[SID-CLOSE] ✅ Covered: ${filled.filled_qty} @ $${exitPrice.toFixed(2)}`);

// ── 3) Reconcile bot state ────────────────────────────────────────────────────
// Realised P&L on the closed shares (short: entry - exit; long: exit - entry).
const realizedPnl = parseFloat((
  side === 'long'
    ? (exitPrice - pos.entry) * coverQty
    : (pos.entry - exitPrice) * coverQty
).toFixed(2));

// (a) remove from open ledger
const remainingOpen = openPositions.filter(p => p.id !== pos.id);
writeJSON(POSITIONS_PATH, remainingOpen);

// (b) append to closed ledger (schema mirrors bot-sid.js closed records +
//     v2.0-compat fields the dashboard reads)
const account = updateAccount(realizedPnl);
const outcome = realizedPnl >= 0 ? 'WIN' : 'LOSS';
const closed  = readJSON(CLOSED_PATH, []);
if (!Array.isArray(closed)) bail('closed-positions-sid.json is not an array — refusing to overwrite');
closed.push({
  ...pos,
  closeDate:      todayString(),
  closeTime:      new Date().toISOString().slice(11, 19),
  exit_strategy:  'manual-close',
  exit_price:     parseFloat(exitPrice.toFixed(4)),
  exit_pnl:       realizedPnl,
  exit_shares:    coverQty,
  exit_reason:    closeReason,
  total_pnl:      realizedPnl,
  realizedPnl,
  is_full_close:  true,
  cover_order_id: coverOrder.id,
  cancelled_stop_order_id: stopOrderId || null,
  // v2.0-compat fields the dashboard's live tiles read
  exitLevel:      'manual',
  exitPrice:      parseFloat(exitPrice.toFixed(4)),
  outcome,
  accountAfter:   account ? account.accountUsd : null,
});
writeJSON(CLOSED_PATH, closed);

// (c) append to trades-sid.csv
const totalUsd = (coverQty * pos.entry).toFixed(2);
const riskPct  = ((realizedPnl / (coverQty * pos.entry)) * 100).toFixed(2);
appendTrade([
  todayString(),
  new Date().toISOString().slice(11, 19),
  `Alpaca/${pos.mode || mode}`,
  symbol,
  `${side}-manualclose`,
  coverQty,
  pos.entry.toFixed(2),
  pos.stopLoss != null ? pos.stopLoss.toFixed(2) : '',
  totalUsd,
  realizedPnl,
  riskPct,
  pos.signalDate || '',
  coverOrder.id,
  pos.mode || mode,
  pos.strategy || 'SID',
].join(','));

// (d) journal entry
writeLog({
  kind:         'manual_close',
  symbol,
  side,
  sharesClosed: coverQty,
  entry:        pos.entry,
  exitPrice:    parseFloat(exitPrice.toFixed(4)),
  pnl:          realizedPnl,
  reason:       closeReason,
  cover_order_id: coverOrder.id,
  cancelled_stop_order_id: stopOrderId || null,
  positionId:   pos.id,
});

// ── 4) Telegram confirm ───────────────────────────────────────────────────────
const emoji = realizedPnl >= 0 ? '📈' : '📉';
const sign  = realizedPnl >= 0 ? '+' : '';
try {
  await sendMessage(
    `${emoji} <b>SID manual close</b> <i>[${mode.toUpperCase()}]</i>\n\n` +
    `${symbol} ${side.toUpperCase()} ${coverQty}sh closed @ $${exitPrice.toFixed(2)}\n` +
    `Entry: $${pos.entry.toFixed(2)}  Realized P&amp;L: <b>${sign}$${realizedPnl.toFixed(2)}</b>\n` +
    `Reason: ${closeReason}\n` +
    (account ? `Account: $${account.accountUsd.toFixed(2)}\n` : '') +
    `\nStop cancelled, cover filled, state reconciled. Slot freed.`
  );
  console.log('[SID-CLOSE] ✓ Telegram confirmation sent');
} catch (e) {
  console.warn(`[SID-CLOSE] Telegram confirm failed (non-fatal): ${e.message}`);
}

console.log('\n[SID-CLOSE] ✅ DONE');
console.log(`   Closed  : ${coverQty} ${symbol} ${side.toUpperCase()} @ $${exitPrice.toFixed(2)}`);
console.log(`   P&L     : ${sign}$${realizedPnl.toFixed(2)}  (${outcome})`);
console.log(`   State   : removed from open, appended to closed + trades.csv + account + log.`);
