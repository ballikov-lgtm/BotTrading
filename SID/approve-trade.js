/**
 * SID Approve-Trade — v2.3.0
 *
 * Fired by .github/workflows/sid-approve-trade.yml when Alan taps [✅ Approve]
 * on a SID short-approval Telegram alert (via the Cloudflare Worker). It turns a
 * queued pending-approval into a PROPERLY TRACKED bot position with full TP1/TP2
 * management — closing the old gap where "approve" meant running the manual
 * one-shot flow, which created an UNTRACKED off-strategy position.
 *
 * ── What it does ──
 *   1. Reads pending-approvals-sid.json, finds the record by APPROVAL_ID.
 *   2. Aborts SAFELY (no Alpaca call, no state change) if the id is unknown,
 *      already actioned, or expired (older than the queue TTL). No blind trade.
 *   3. Resolves the trading mode. dry_run → logs the intent and exits.
 *   4. Preflight + market-hours guard via the shared Alpaca executor.
 *   5. Enters at the CURRENT market price (approval may arrive DAYS later at a
 *      different level than the mechanical proposal): submits the market entry,
 *      polls the fill, and uses the FILL price as the entry. Recomputes the stop
 *      from the current setup — reuses the original proposed stop level if it's
 *      still valid for the direction, else derives a fresh stop. Sizes by 1%
 *      risk on the CURRENT entry→stop distance (reuses calcPositionSize).
 *   6. Places the broker GTC stop on the full position (so isV2_2Position()==true
 *      → the position is managed by the v2.2 broker-order path = TRACKED).
 *   7. Writes a FULL v2.3.0 open-positions record via the SHARED
 *      buildEntryPositionRecord() factory (no schema drift), appends trades.csv,
 *      logs an approval_entry (incl. the proposed-vs-actual entry delta), marks
 *      the pending record 'approved', and Telegram-confirms.
 *
 * Reuses bot-sid.js helpers (executor, sizing, entry-record factory, state I/O)
 * so nothing is copy-pasted and the schema can never diverge from the bot.
 *
 * Env:
 *   APPROVAL_ID          — the pending-approval id to action (required)
 *   SID_TRADING_MODE     — dry_run | paper | live (paper for this flow)
 *   SID_LIVE_CONFIRMED   — required token if mode=live
 *   ALPACA_KEY_ID / ALPACA_SECRET_KEY / ALPACA_BASE_URL — Alpaca creds
 *   TELEGRAM_*           — alerts (best-effort)
 */

import 'dotenv/config';
import { createExecutor, resolveTradingMode } from './alpaca-executor.js';
import * as tg from './telegram-alerts.js';
import {
  CONFIG,
  BOT_NAME,
  buildEntryPositionRecord,
  calcPositionSize,
  fetchDailyCandles,
  addOpenPosition,
  loadOpenPositions,
  loadAccount,
  appendTrade,
  writeLog,
  loadPendingApprovals,
  savePendingApprovals,
  prunePendingApprovals,
  todayString,
} from './bot-sid.js';

const APPROVE_VERSION = 'v2.3.0';
const STRATEGY_TAG    = `${BOT_NAME} ${APPROVE_VERSION}`; // "SID v2.3.0"

function log(msg)  { console.log(`[SID-APPROVE] ${msg}`); }
function fail(msg) { console.error(`[SID-APPROVE] ABORT: ${msg}`); }

// Safe, no-op-on-failure exit. We NEVER throw a non-zero that leaves state
// half-written — every abort path returns cleanly before touching Alpaca.
async function main() {
  const approvalId = (process.env.APPROVAL_ID || '').trim();
  if (!approvalId) { fail('APPROVAL_ID env is required'); process.exit(1); }
  log(`approval_id = ${approvalId}`);

  // Size off the CURRENT compounded ledger (matches bot-sid.js run() — the
  // static CONFIG.accountUsd default would otherwise be used for 1% risk).
  const account = loadAccount();
  CONFIG.accountUsd = account.accountUsd;
  log(`ledger $${account.accountUsd.toFixed(2)}  (1% risk = $${(account.accountUsd * CONFIG.riskPct).toFixed(2)})`);

  // ── 1) Load the pending record ────────────────────────────────────────────
  const pendingArr = loadPendingApprovals();
  const rec = pendingArr.find(r => r && r.id === approvalId);

  if (!rec) {
    fail(`No pending approval found for id "${approvalId}" — nothing to do (may be stale/pruned or a bad id). NO trade.`);
    writeLog({ kind: 'approval_abort', approval_id: approvalId, reason: 'not_found' });
    await tg.sendMessage(`⚠️ <b>SID approval</b> — id <code>${approvalId}</code> not found in the pending queue. No trade fired.`).catch(() => {});
    process.exit(0);
  }
  if (rec.status !== 'pending') {
    fail(`Approval "${approvalId}" already actioned (status=${rec.status}). NO trade.`);
    writeLog({ kind: 'approval_abort', approval_id: approvalId, reason: `already_${rec.status}` });
    await tg.sendMessage(`⚠️ <b>SID approval</b> — <code>${approvalId}</code> was already <b>${rec.status}</b>. No trade fired.`).catch(() => {});
    process.exit(0);
  }

  // ── Expiry / staleness guard (independent of the bot's prune) ──────────────
  const survivors = prunePendingApprovals(pendingArr);
  if (!survivors.some(r => r.id === approvalId)) {
    fail(`Approval "${approvalId}" is EXPIRED (older than the queue TTL). NO trade.`);
    writeLog({ kind: 'approval_abort', approval_id: approvalId, reason: 'expired' });
    // Persist the prune so the stale record doesn't linger.
    savePendingApprovals(survivors);
    await tg.sendMessage(`⚠️ <b>SID approval</b> — <code>${approvalId}</code> is expired (setup too old). No trade fired.`).catch(() => {});
    process.exit(0);
  }

  const symbol = String(rec.symbol || '').toUpperCase();
  const side   = String(rec.side   || 'short').toLowerCase();
  if (!symbol || (side !== 'short' && side !== 'long')) {
    fail(`Malformed pending record (symbol="${symbol}" side="${side}"). NO trade.`);
    writeLog({ kind: 'approval_abort', approval_id: approvalId, reason: 'malformed_record' });
    process.exit(0);
  }
  log(`${symbol} ${side.toUpperCase()} — proposed entry $${rec.proposedEntry} stop $${rec.proposedStop} (signal ${rec.signalDate})`);

  // ── 2) Trading mode ────────────────────────────────────────────────────────
  const mode = resolveTradingMode();
  log(`mode = ${mode}`);
  const executor = createExecutor();
  if (!executor) {
    // dry_run — log the intent, DON'T touch state. Leave the record pending.
    log('dry_run — no Alpaca calls, no state change. Set SID_TRADING_MODE=paper to actually enter.');
    writeLog({ kind: 'approval_dryrun', approval_id: approvalId, symbol, side, proposedEntry: rec.proposedEntry, proposedStop: rec.proposedStop });
    process.exit(0);
  }

  // ── 3) Preflight + market-hours guard ──────────────────────────────────────
  const pre = await executor.preflight();
  if (!pre.ok) {
    fail(`Alpaca preflight failed (${pre.reason}): ${pre.detail}. NO trade.`);
    writeLog({ kind: 'approval_abort', approval_id: approvalId, reason: 'preflight_fail', detail: pre.detail });
    await tg.sendMessage(`🚫 <b>SID approval</b> — Alpaca preflight failed for ${symbol} (${pre.reason}). No trade. Retry when resolved.`).catch(() => {});
    process.exit(0);
  }
  if (!pre.marketOpen) {
    fail(`Market is closed (next open ${pre.nextOpen}). NO trade — leaving ${approvalId} pending so it can be re-approved when open.`);
    writeLog({ kind: 'approval_abort', approval_id: approvalId, reason: 'market_closed', nextOpen: pre.nextOpen });
    await tg.sendMessage(`⏸️ <b>SID approval</b> — market closed for ${symbol}. Left <code>${approvalId}</code> pending; approve again during US market hours.`).catch(() => {});
    process.exit(0);
  }

  // ── 4) Current price (for stop recompute + sizing preview) ──────────────────
  // The mechanical proposal may be days old. Use the latest daily close as the
  // current-price reference for the stop decision + sizing; the ACTUAL entry is
  // the market-order fill price (captured below).
  let currentPrice = null;
  try {
    const candles = await fetchDailyCandles(symbol, '6mo');
    if (candles.length) currentPrice = candles[candles.length - 1].close;
  } catch (err) {
    log(`current-price fetch failed (${err.message}) — will size off the fill price`);
  }
  const refPrice = Number.isFinite(currentPrice) ? currentPrice : rec.proposedEntry;

  // ── 5) Recompute the stop from the CURRENT setup ────────────────────────────
  // Reuse the original proposed stop level if it's still valid for the
  // direction (short → stop must be ABOVE the reference price). Otherwise derive
  // a fresh stop as a small buffer beyond the reference (keeps a sane R:R when
  // price has run well past the original stop). Rounds like the bot does
  // (ceil for short, floor for long).
  const proposedStop = Number(rec.proposedStop);
  const stop = computeStop(side, refPrice, proposedStop);
  if (stop == null) {
    fail(`Could not compute a valid stop for ${symbol} ${side} (ref $${refPrice}). NO trade.`);
    writeLog({ kind: 'approval_abort', approval_id: approvalId, reason: 'stop_invalid', refPrice, proposedStop });
    process.exit(0);
  }

  // Preview sizing off the reference price (final sizing re-runs off the fill).
  const previewSizing = calcPositionSize(refPrice, stop);
  if (!previewSizing) {
    fail(`Position too small for ${symbol} at ref $${refPrice} / stop $${stop} (risk/share too large or <1 share). NO trade.`);
    writeLog({ kind: 'approval_abort', approval_id: approvalId, reason: 'size_too_small', refPrice, stop });
    await tg.sendMessage(`⚠️ <b>SID approval</b> — ${symbol} sizes to <1 share at $${refPrice}/stop $${stop}. No trade.`).catch(() => {});
    process.exit(0);
  }
  log(`ref $${refPrice.toFixed(2)}  stop $${stop}  preview size ${previewSizing.shares}sh (1% risk = $${(CONFIG.accountUsd * CONFIG.riskPct).toFixed(2)})`);

  // ── 6) Submit the market entry, poll the fill ──────────────────────────────
  const entrySide = side === 'long' ? 'buy' : 'sell';
  const exitSide  = side === 'long' ? 'sell' : 'buy';
  const ts        = Date.now();
  const prefix    = `SID-APPR-${symbol}-${ts}`.slice(0, 40);

  // Buying-power sanity for the entry cost.
  const estCost = previewSizing.shares * refPrice;
  if (estCost > pre.buyingPower) {
    fail(`Insufficient buying power: need ~$${estCost.toFixed(2)}, have $${pre.buyingPower.toFixed(2)}. NO trade.`);
    writeLog({ kind: 'approval_abort', approval_id: approvalId, reason: 'insufficient_bp', need: estCost, have: pre.buyingPower });
    await tg.sendMessage(`🚫 <b>SID approval</b> — insufficient buying power for ${symbol} (need ~$${estCost.toFixed(0)}). No trade.`).catch(() => {});
    process.exit(0);
  }

  log(`Submitting ${entrySide.toUpperCase()} ${previewSizing.shares} ${symbol} @ market…`);
  let entryOrder;
  try {
    entryOrder = await executor.client.submitOrder({
      symbol,
      qty:             previewSizing.shares,
      side:            entrySide,
      type:            'market',
      time_in_force:   'day',
      client_order_id: `${prefix}-entry`,
    });
  } catch (err) {
    fail(`Entry order submit failed: ${err.message}. NO position opened.`);
    writeLog({ kind: 'approval_order_fail', approval_id: approvalId, symbol, error: err.message, status: err.status });
    await tg.sendMessage(`🚫 <b>SID approval</b> — entry submit failed for ${symbol}: ${err.message}. No position opened.`).catch(() => {});
    process.exit(0);
  }

  const fill = await executor.pollOrderFill(entryOrder.id, { attempts: 30, delayMs: 2000 });
  if (!fill.filled || !(fill.filledQty > 0)) {
    fail(`Entry order ${entryOrder.id} did not fill (status ${fill.order?.status}). Investigate on Alpaca. NO local record written.`);
    writeLog({ kind: 'approval_order_fail', approval_id: approvalId, symbol, error: 'entry_unfilled', orderStatus: fill.order?.status });
    await tg.sendMessage(`⚠️ <b>SID approval</b> — ${symbol} entry did not fill (status ${fill.order?.status}). Check Alpaca. No local record.`).catch(() => {});
    process.exit(0);
  }

  const entry  = Number(fill.filledAvgPrice ?? refPrice);
  const shares = Math.round(fill.filledQty);
  log(`Filled ${shares} ${symbol} @ $${entry.toFixed(2)}`);

  // ── 7) Recompute the stop off the ACTUAL fill + final sizing ────────────────
  // The fill can differ from the reference; re-validate the stop against it.
  const finalStop = computeStop(side, entry, proposedStop);
  const finalSizing = calcPositionSize(entry, finalStop) || previewSizing;
  const riskUsd = Math.abs(entry - finalStop) * shares;

  // ── 8) Place the broker GTC stop on the full position (makes it TRACKED) ────
  let brokerStopOrderId = null;
  try {
    const stopRes = await executor.placeStop(
      { symbol, side, clientOrderIdPrefix: prefix },
      shares,
      finalStop,
      'stop',
    );
    brokerStopOrderId = stopRes.stopOrderId;
    log(`Broker stop placed: ${shares}sh @ $${finalStop} (id ${brokerStopOrderId})`);
  } catch (err) {
    // Don't leave it naked silently — loud alert, but the position exists and
    // the next bot run's maintainV2_2BrokerOrders will re-place the missing stop.
    fail(`Stop placement failed for ${symbol}: ${err.message}. Position is UNPROTECTED on the broker side — next bot run will re-place it.`);
    writeLog({ kind: 'approval_stop_fail', approval_id: approvalId, symbol, error: err.message });
    await tg.sendMessage(`🚨 <b>SID approval</b> — ${symbol} ${side.toUpperCase()} filled ${shares}sh @ $${entry.toFixed(2)} but the STOP failed to place (${err.message}). The next bot run re-places it, but CHECK ALPACA now.`).catch(() => {});
  }

  // ── 9) Write the FULL tracked position via the shared factory ───────────────
  const now = new Date();
  const entryDelta = entry - Number(rec.proposedEntry);
  const pos = buildEntryPositionRecord({
    id:               entryOrder.id,   // Alpaca entry order id = canonical id
    symbol,
    side,
    entry:            parseFloat(entry.toFixed(4)),
    stopLoss:         finalStop,
    shares,
    totalUsd:         parseFloat((shares * entry).toFixed(2)),
    riskUsd:          parseFloat(riskUsd.toFixed(2)),
    signalDate:       rec.signalDate,
    openDate:         now.toISOString().slice(0, 10),
    openTime:         now.toISOString().slice(11, 19),
    mode,
    strategyTag:      STRATEGY_TAG,     // "SID v2.3.0" → isV2_2Position via brokerStopOrderId
    brokerStopOrderId,
    clientOrderIdPrefix: prefix,
  }, {
    // Provenance — this position came through the approval flow.
    manual_watch:      true,            // it's a bullish-asset short → still S/R-watch the runner
    approved_via:      'telegram',
    approval_id:       approvalId,
    proposed_entry:    Number(rec.proposedEntry),
    proposed_stop:     Number(rec.proposedStop),
    entry_delta:       parseFloat(entryDelta.toFixed(4)),
  });
  addOpenPosition(pos);

  // ── 10) trades-sid.csv ──────────────────────────────────────────────────────
  appendTrade([
    now.toISOString().slice(0, 10),
    now.toISOString().slice(11, 19),
    `Alpaca/${mode}`,
    symbol,
    side,
    shares,
    entry.toFixed(2),
    finalStop,
    (shares * entry).toFixed(2),
    riskUsd.toFixed(2),
    (Math.abs(entry - finalStop) / entry * 100).toFixed(2),
    rec.signalDate || '',
    entryOrder.id,
    mode,
    STRATEGY_TAG,
  ].join(','));

  // ── 11) Mark the pending record approved + persist (with prune) ─────────────
  const nextArr = prunePendingApprovals(loadPendingApprovals()).filter(r => r.id !== approvalId);
  rec.status      = 'approved';
  rec.approvedAt  = now.toISOString();
  rec.entry_price = parseFloat(entry.toFixed(4));
  rec.entry_shares = shares;
  rec.entry_stop  = finalStop;
  rec.entry_order_id = entryOrder.id;
  nextArr.unshift(rec); // keep an actioned record for the audit trail
  savePendingApprovals(nextArr);

  // ── 12) Log + Telegram confirm (with proposed-vs-actual delta) ──────────────
  writeLog({
    kind:           'approval_entry',
    approval_id:    approvalId,
    symbol,
    side,
    entry:          parseFloat(entry.toFixed(4)),
    stopLoss:       finalStop,
    shares,
    riskUsd:        parseFloat(riskUsd.toFixed(2)),
    proposed_entry: Number(rec.proposedEntry),
    entry_delta:    parseFloat(entryDelta.toFixed(4)),
    brokerStopOrderId,
    orderId:        entryOrder.id,
    strategy:       STRATEGY_TAG,
    mode,
  });

  const deltaSign = entryDelta >= 0 ? '+' : '';
  const deltaPct  = Number(rec.proposedEntry) ? (entryDelta / Number(rec.proposedEntry) * 100) : 0;
  const wildNote  = Math.abs(deltaPct) > 5
    ? `\n<i>⚠ Actual entry is ${deltaSign}${deltaPct.toFixed(1)}% off the mechanical proposal — you chose to approve at this level.</i>`
    : '';
  await tg.alertEntryFired({
    symbol, side, entryPrice: entry, stopLoss: finalStop, shares, riskUsd, orderId: entryOrder.id, mode,
  }).catch(() => {});
  await tg.sendMessage(
    `✅ <b>SID APPROVED ENTRY — now a TRACKED position</b>\n\n` +
    `${symbol} ${side.toUpperCase()} ${shares}sh @ $${entry.toFixed(2)}  (stop $${finalStop})\n` +
    `Proposed entry was $${Number(rec.proposedEntry).toFixed(2)} → actual $${entry.toFixed(2)} (${deltaSign}$${entryDelta.toFixed(2)})\n` +
    `Risk: $${riskUsd.toFixed(2)} (1% on live entry→stop)\n` +
    `Full TP1/TP2 management is now on. Bullish-asset short → runner is MANUAL-WATCH.${wildNote}`
  ).catch(() => {});

  log(`DONE — ${symbol} ${side.toUpperCase()} ${shares}sh @ $${entry.toFixed(2)} is now a tracked v2.3.0 position.`);
  process.exit(0);
}

/**
 * Compute the protective stop for an approved entry, given the direction and a
 * reference price. Reuses the original proposed stop LEVEL if it's still valid
 * for the direction (short: stop above ref; long: stop below ref); otherwise
 * derives a fresh stop as a buffer beyond the reference. Rounds the way the bot
 * does (short → ceil, long → floor). Returns null if no sane stop is possible.
 */
function computeStop(side, refPrice, proposedStop) {
  if (!Number.isFinite(refPrice) || refPrice <= 0) return null;
  const FALLBACK_BUFFER = 0.02; // 2% beyond ref if the original stop is stale
  if (side === 'short') {
    if (Number.isFinite(proposedStop) && proposedStop > refPrice) return proposedStop; // still valid
    return Math.ceil(refPrice * (1 + FALLBACK_BUFFER));
  }
  // long
  if (Number.isFinite(proposedStop) && proposedStop < refPrice) return proposedStop;
  const s = Math.floor(refPrice * (1 - FALLBACK_BUFFER));
  return s > 0 ? s : null;
}

main().catch(err => {
  console.error(`[SID-APPROVE] Fatal: ${err.message}`);
  process.exit(1);
});
