/**
 * SID account reconciliation — makes ALPACA THE SOURCE OF TRUTH.
 *
 * WHY THIS EXISTS
 * ───────────────
 * SID's internal accounting drifted away from the real Alpaca paper account:
 *   - The ledger (sid-account.json realizedPnl) carries a PHANTOM loss: the MCD
 *     record was deleted from closed-positions-sid.json but its -$78.14 was
 *     never removed from the running realizedPnl counter, and tradeCount counts
 *     ledger EVENTS (TP1 partials, TP2 runner closes) not distinct positions.
 *   - The closed records book SIMULATED prices (TP1 at the RSI-50 bar close, TP2
 *     at the historical SMA50-touch bar), NOT the real Alpaca fill on the run
 *     day. On multi-day-late runner closes the two diverge a lot (e.g. a runner
 *     booked at the SMA50 touch weeks ago actually filled at today's price).
 *
 * WHAT THIS DOES
 * ──────────────
 * Pulls Alpaca's REAL data (FILL activities + account equity), matches each
 * closed SID position to its actual fills, computes the true per-position
 * realised P&L, and:
 *   - Rewrites each closed record's P&L to the Alpaca-fill-derived value,
 *     stamping pnl_source:"alpaca_fill" when matched, "estimate" on fallback.
 *   - Re-derives sid-account.json realizedPnl (= Σ corrected records),
 *     accountUsd (= startingUsd + realizedPnl), tradeCount (= distinct closed
 *     positions) — killing the phantom loss + inflated count.
 *   - Writes alpaca-account-sid.json — a snapshot of the REAL Alpaca equity for
 *     the dashboard headline (Phase 2 re-points the dashboard at this file).
 *
 * IT NEVER GUESSES: any position it can't match to real fills keeps its existing
 * (estimate) P&L and is flagged pnl_source:"estimate" so untrustworthy rows are
 * always visible. It never silently trusts an unverified number.
 *
 * MODES
 * ─────
 *   --dry-run   (DEFAULT) — prints the before/after table, writes NOTHING.
 *   --write               — persists the corrected files.
 *
 * This is a READ-ONLY-BY-DEFAULT diagnostic. bot-sid.js is NOT touched; this
 * tool is entirely additive and independent of the bot's run path.
 *
 * Console output is ASCII-only ([OK]/[FAIL]/->) — this machine's console is
 * cp1252 and unicode ticks crash mid-print (see SID/CLAUDE.md).
 *
 * Alpaca keys live only in the cloud (GHA secrets). Run via the
 * sid-reconcile.yml workflow_dispatch to produce the real numbers.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { AlpacaClient } from './alpaca-client.js';
import { resolveTradingMode } from './alpaca-executor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Paths (relative to SID/, matching bot-sid.js) ────────────────────────────
const CLOSED_PATH        = path.join(__dirname, 'closed-positions-sid.json');
const ACCOUNT_PATH       = path.join(__dirname, 'sid-account.json');
const ALPACA_SNAP_PATH   = path.join(__dirname, 'alpaca-account-sid.json');

const STARTING_LEDGER_USD  = 10000;    // internal sizing base (unchanged)
const STARTING_ALPACA_USD  = 100000;   // Alpaca paper base (can't be set lower)

// ── CLI ──────────────────────────────────────────────────────────────────────
const args    = process.argv.slice(2);
const WRITE   = args.includes('--write');
const DRY_RUN = !WRITE;   // dry-run is the DEFAULT

// ── Console helpers (ASCII only — cp1252 trap) ───────────────────────────────
const OK   = '[OK]';
const FAIL = '[FAIL]';
const WARN = '[WARN]';
const ARROW = '->';
function money(n)  { const v = Number(n) || 0; return (v >= 0 ? '+' : '-') + '$' + Math.abs(v).toFixed(2); }
function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }
function padl(s, n){ s = String(s); return s.length >= n ? s : ' '.repeat(n - s.length) + s; }

// ── Mode / base URL (mirrors alpaca-executor.baseUrlForMode) ─────────────────
function baseUrlForMode(mode) {
  if (mode === 'live')  return 'https://api.alpaca.markets';
  if (mode === 'paper') return 'https://paper-api.alpaca.markets';
  return null;
}

// ── File IO ──────────────────────────────────────────────────────────────────
function loadJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

// ── Fill-side classification ─────────────────────────────────────────────────
// For a LONG position:  entry = buy,        exit = sell.
// For a SHORT position: entry = sell_short, exit = buy (buy_to_cover).
// Alpaca FILL activities carry side in {buy, sell, sell_short, buy_to_cover}.
// We normalise to "entryFill"/"exitFill" per the position DIRECTION when
// allocating (a buy is an entry for a long but an exit for a short).
function fillSideKind(fill) {
  const side = String(fill.side || '').toLowerCase();
  if (side === 'buy' || side === 'buy_to_cover') return 'buy';
  if (side === 'sell' || side === 'sell_short')  return 'sell';
  return null;
}
function fillQty(fill)   { const q = parseFloat(fill.qty);   return Number.isFinite(q) ? q : 0; }
function fillPrice(fill) { const p = parseFloat(fill.price); return Number.isFinite(p) ? p : 0; }
function fillMs(fill)    { const t = Date.parse(fill.transaction_time || fill.transactionTime || ''); return Number.isFinite(t) ? t : 0; }

// ── FIFO per-symbol fill allocation ──────────────────────────────────────────
// Disambiguates multiple same-symbol positions (e.g. the 3 UNH shorts) and does
// NOT cap the exit search at the record's closeDate (the real close can post
// days after the recorded target date — e.g. PYPL/ADBE runners sold 2026-07-17
// vs recorded closeDate 07-02/07-15). For each symbol we build two FIFO queues:
//   - "buy" fills (buys / buys-to-cover), time-ordered
//   - "sell" fills (sells / short-sells), time-ordered
// Positions are consumed in OPEN-DATE order. Each position draws its entry leg
// from the queue matching its entry side and its exit leg from the other queue,
// each up to shares_total. Because entries are chronological, the first UNH
// short's entry short-sells are consumed before the second's, etc. — no
// cross-contamination. A position is "matched" only when BOTH legs fully cover
// shares_total (a complete real round trip); otherwise we keep the estimate.
//
// Returns { alloc, leftovers }:
//   alloc     — Map pos-identity -> { pnl, matched, entryQty, exitQty, entryAvg,
//               exitAvg, note }
//   leftovers — Map symbol -> { buyQ, sellQ } of the FIFO lots STILL unconsumed
//               after all known positions took their slices. A symbol whose
//               leftovers contain a complete round-trip (matched buy + sell qty)
//               is an ORPHAN trade missing from the records (e.g. the dropped MCD
//               paper trade) — reconstructOrphans() rebuilds a record for it.
function allocateFillsFIFO(positions, allFills) {
  const result = new Map();
  const leftovers = new Map();
  // Group positions + fills by symbol.
  const bySymbolPos   = new Map();
  const bySymbolFills = new Map();
  for (const pos of positions) {
    const s = String(pos.symbol).toUpperCase();
    if (!bySymbolPos.has(s)) bySymbolPos.set(s, []);
    bySymbolPos.get(s).push(pos);
  }
  for (const f of allFills) {
    const s = String(f.symbol || '').toUpperCase();
    if (!s) continue;
    if (!bySymbolFills.has(s)) bySymbolFills.set(s, []);
    bySymbolFills.get(s).push(f);
  }

  // Draw `need` shares from a FIFO queue of { qtyLeft, price, ms } lots.
  // Returns { qty, cost } consumed (mutates the lots' qtyLeft in place).
  function draw(queue, need, afterMs) {
    let qty = 0, cost = 0;
    for (const lot of queue) {
      if (qty >= need - 1e-9) break;
      if (lot.qtyLeft <= 0) continue;
      // Exit legs must occur at/after the entry (afterMs); a fill strictly
      // before the position opened can't be its exit. Entry legs pass afterMs
      // = null so no constraint.
      if (afterMs != null && lot.ms < afterMs - 1) continue;
      const take = Math.min(lot.qtyLeft, need - qty);
      qty  += take;
      cost += take * lot.price;
      lot.qtyLeft -= take;
    }
    return { qty, cost };
  }

  // Iterate over EVERY symbol that has fills — not only symbols with a record —
  // so a symbol whose entire trade was dropped from the records (MCD) still
  // builds its queues and surfaces as a leftover round-trip.
  const allSymbols = new Set([...bySymbolPos.keys(), ...bySymbolFills.keys()]);
  for (const sym of allSymbols) {
    const posList = (bySymbolPos.get(sym) || []).slice();
    // Positions in real chronological open order.
    posList.sort((a, b) => String(a.openDate || '').localeCompare(String(b.openDate || '')) ||
                            String(a.openTime || '').localeCompare(String(b.openTime || '')));
    // Two FIFO queues of remaining fill quantity, time-ordered.
    const fillsForSym = (bySymbolFills.get(sym) || []).slice()
      .sort((a, b) => fillMs(a) - fillMs(b));
    const buyQ  = [];  // { qtyLeft, price, ms }
    const sellQ = [];
    for (const f of fillsForSym) {
      const kind = fillSideKind(f);
      if (kind === 'buy')  buyQ.push({ qtyLeft: fillQty(f), price: fillPrice(f), ms: fillMs(f) });
      if (kind === 'sell') sellQ.push({ qtyLeft: fillQty(f), price: fillPrice(f), ms: fillMs(f) });
    }

    for (const pos of posList) {
      const need = pos.shares_total ?? pos.shares ?? 0;
      const openMs = pos.openDate ? Date.parse(`${pos.openDate}T00:00:00Z`) : -Infinity;
      const isLong = pos.side === 'long';
      // Entry leg first (no time floor), then exit leg constrained to >= entry.
      const entryQueue = isLong ? buyQ  : sellQ;
      const exitQueue  = isLong ? sellQ : buyQ;
      const entry = draw(entryQueue, need, null);
      const exit  = draw(exitQueue,  need, openMs);

      const entryAvg = entry.qty ? entry.cost / entry.qty : null;
      const exitAvg  = exit.qty  ? exit.cost  / exit.qty  : null;
      // Realised P&L: (exit proceeds) - (entry cost) for a long; for a short the
      // entry is the sell (proceeds) and exit is the buy (cost), so it's
      // (entry proceeds) - (exit cost). In both cases:
      //   long:  exit.cost(=sell proceeds) - entry.cost(=buy cost)
      //   short: entry.cost(=sell proceeds) - exit.cost(=buy cost)
      const pnl = isLong ? (exit.cost - entry.cost) : (entry.cost - exit.cost);
      const matched = need > 0 && entry.qty >= need - 0.5 && exit.qty >= need - 0.5;

      result.set(pos, {
        pnl: parseFloat(pnl.toFixed(2)),
        matched,
        entryQty: parseFloat(entry.qty.toFixed(4)),
        exitQty:  parseFloat(exit.qty.toFixed(4)),
        entryAvg, exitAvg,
        note: matched ? '' : `partial fills (entry ${entry.qty}/${need}, exit ${exit.qty}/${need})`,
      });
    }

    // Capture whatever is left after all known positions took their slices.
    const buyLeft  = buyQ.filter(l => l.qtyLeft > 1e-9);
    const sellLeft = sellQ.filter(l => l.qtyLeft > 1e-9);
    if (buyLeft.length || sellLeft.length) {
      leftovers.set(sym, { buyQ: buyLeft, sellQ: sellLeft });
    }
  }
  return { alloc: result, leftovers };
}

// ── Orphan reconstruction ────────────────────────────────────────────────────
// After known records take their fill slices, any symbol left with a COMPLETE
// round-trip in its leftover lots (matched buy qty + sell qty) is a trade that
// was dropped from closed-positions-sid.json (e.g. the MCD paper stop-out that
// vanished at commit a40456fc). We rebuild a closed record for it from the real
// fills — real entry/exit prices + dates, mode:"paper", pnl_source:"alpaca_fill",
// reconstructed:true. Side is inferred from which leg came FIRST in time (an
// early buy => long; an early sell => short).
// Returns an array of reconstructed closed-position records.
function reconstructOrphans(leftovers, reconcileMode = 'paper') {
  const recs = [];
  for (const [sym, { buyQ, sellQ }] of leftovers) {
    const buyQty  = buyQ.reduce((s, l) => s + l.qtyLeft, 0);
    const sellQty = sellQ.reduce((s, l) => s + l.qtyLeft, 0);
    // Need BOTH legs to reconstruct a realised trade. A one-legged leftover
    // (only buys, or only sells) is an OPEN position or a data-window edge — we
    // do NOT invent an exit for it. Skip (it stays unmatched, flagged below).
    const roundTrip = Math.min(buyQty, sellQty);
    if (roundTrip < 0.5) continue;

    const firstBuyMs  = buyQ.length  ? Math.min(...buyQ.map(l => l.ms))  : Infinity;
    const firstSellMs = sellQ.length ? Math.min(...sellQ.map(l => l.ms)) : Infinity;
    const isLong = firstBuyMs <= firstSellMs;   // whichever leg opened first

    const entryLots = isLong ? buyQ  : sellQ;
    const exitLots  = isLong ? sellQ : buyQ;
    // Consume up to roundTrip from each leg (FIFO) for the reconstructed trade.
    function take(lots, need) {
      let qty = 0, cost = 0, firstMs = Infinity, lastMs = -Infinity;
      for (const l of lots) {
        if (qty >= need - 1e-9) break;
        if (l.qtyLeft <= 0) continue;
        const t = Math.min(l.qtyLeft, need - qty);
        qty += t; cost += t * l.price; l.qtyLeft -= t;
        firstMs = Math.min(firstMs, l.ms); lastMs = Math.max(lastMs, l.ms);
      }
      return { qty, cost, avg: qty ? cost / qty : null, firstMs, lastMs };
    }
    const entry = take(entryLots, roundTrip);
    const exit  = take(exitLots,  roundTrip);
    const pnl = isLong ? (exit.cost - entry.cost) : (entry.cost - exit.cost);
    const openDate  = Number.isFinite(entry.firstMs) ? new Date(entry.firstMs).toISOString().slice(0, 10) : null;
    const closeDate = Number.isFinite(exit.lastMs)   ? new Date(exit.lastMs).toISOString().slice(0, 10)   : null;

    recs.push({
      symbol: sym,
      side: isLong ? 'long' : 'short',
      entry: entry.avg != null ? parseFloat(entry.avg.toFixed(4)) : null,
      exit_price: exit.avg != null ? parseFloat(exit.avg.toFixed(4)) : null,
      shares_total: Math.round(roundTrip),
      shares: Math.round(roundTrip),
      openDate,
      closeDate,
      exit_strategy: 'reconstructed_from_fills',
      total_pnl: parseFloat(pnl.toFixed(2)),
      realizedPnl: parseFloat(pnl.toFixed(2)),
      mode: reconcileMode,   // matches the Alpaca account reconciled (paper now)
      strategy: 'SID (reconstructed from Alpaca fills)',
      pnl_source: 'alpaca_fill',
      reconstructed: true,
      reconciled_at: new Date().toISOString().slice(0, 10),
    });
  }
  return recs;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('== SID Account Reconciliation (Alpaca = source of truth) ==');
  console.log(`   Mode: ${DRY_RUN ? 'DRY-RUN (default) - writes NOTHING' : 'WRITE - will persist corrected files'}`);
  console.log('');

  const allClosed = loadJSON(CLOSED_PATH, null);
  const account = loadJSON(ACCOUNT_PATH, null);
  if (!Array.isArray(allClosed)) {
    console.error(`${FAIL} Could not read ${CLOSED_PATH}`);
    process.exit(1);
  }

  // ── PAPER / LIVE SEGREGATION (hard guard — go-live safety) ────────────────
  // The reconcile ONLY ever touches records matching the Alpaca account it is
  // reconciling against. Right now that account is PAPER, so we reconcile ONLY
  // mode:"paper" records (records with no mode are legacy paper — the V2 paper
  // launch predates the mode field). Any mode:"live" record is QUARANTINED:
  // passed through byte-for-byte, never re-priced, never summed into the paper
  // ledger. The user's design: when they go live a FRESH live ledger starts
  // (tradeCount 0, mode:live) and this paper history stays separate forever —
  // paper P&L must NEVER leak into a future live ledger or the live-only tax
  // report. reconcileMode is the account's own mode (paper unless the Alpaca
  // account resolves to live), so a future live run reconciles the live set and
  // quarantines paper symmetrically.
  const reconcileMode = (resolveTradingMode() === 'live') ? 'live' : 'paper';
  const recMode = (r) => String(r.mode || 'paper').toLowerCase();
  const closed        = allClosed.filter(r => recMode(r) === reconcileMode);
  const quarantined   = allClosed.filter(r => recMode(r) !== reconcileMode);

  console.log(`${OK} Loaded ${allClosed.length} closed record(s) from closed-positions-sid.json`);
  console.log(`${OK} Reconcile scope: ${reconcileMode.toUpperCase()} set = ${closed.length} record(s); ${quarantined.length} other-mode record(s) QUARANTINED (untouched)`);
  if (quarantined.length) {
    const q = quarantined.reduce((acc, r) => { acc[recMode(r)] = (acc[recMode(r)] || 0) + 1; return acc; }, {});
    console.log(`       Quarantined by mode: ${Object.entries(q).map(([m, n]) => `${m}:${n}`).join(', ')} — these pass through unchanged, never re-priced or summed`);
  }
  if (account) {
    console.log(`${OK} Loaded ledger: realizedPnl ${money(account.realizedPnl)}  tradeCount ${account.tradeCount}  accountUsd $${account.accountUsd}`);
  } else {
    console.log(`${WARN} sid-account.json not found — will re-derive from records`);
  }
  console.log('');

  // ── Connect to Alpaca (paper/live via resolveTradingMode) ────────────────
  const mode = resolveTradingMode();
  let client = null;
  let alpacaOk = false;
  let alpacaEquity = null;
  if (mode === 'dry_run') {
    console.log(`${WARN} SID_TRADING_MODE=dry_run (or unset) - no Alpaca keys in scope.`);
    console.log(`       This is EXPECTED locally. Run in the cloud via sid-reconcile.yml`);
    console.log(`       (workflow_dispatch) where the ALPACA_* secrets exist.`);
    console.log(`       Every position will be reported as pnl_source:"estimate".`);
  } else {
    try {
      client = new AlpacaClient({ baseUrl: baseUrlForMode(mode) });
      const acct = await client.getAccount();
      alpacaEquity = parseFloat(acct.equity);
      alpacaOk = true;
      console.log(`${OK} Connected to Alpaca (${mode}). Real account equity: $${alpacaEquity.toFixed(2)}`);
    } catch (err) {
      console.log(`${FAIL} Alpaca connection failed: ${err.message}`);
      console.log(`       Falling back to estimates for every position (nothing trusted blindly).`);
    }
  }
  console.log('');

  // ── Pull FILL activities ──────────────────────────────────────────────────
  // FIFO allocation works purely off the FILL stream (symbol + side + qty +
  // price + time), so we DON'T need to resolve client_order_ids — which also
  // avoids the earlier trap where the exit market-close carried no SID prefix.
  let fills = [];
  if (alpacaOk) {
    // WIDE lower bound (SID paper inception) so ORPHAN trades dropped from the
    // records are still captured. The old "earliest record openDate" bound would
    // miss a symbol whose entire record was deleted if its open predates the
    // surviving records. The upper end is left open (now) so late runner exits
    // (e.g. 2026-07-17) are always included even when a record's closeDate is an
    // earlier target date. SID V2 paper started 2026-05-16; 2026-05-01 is a safe
    // margin. Env-overridable via SID_RECONCILE_SINCE=YYYY-MM-DD.
    const sinceDate = process.env.SID_RECONCILE_SINCE || '2026-05-01';
    const afterIso = `${sinceDate}T00:00:00Z`;
    try {
      fills = await client.getActivities({ activity_types: 'FILL', after: afterIso, page_size: 100, direction: 'asc' });
      console.log(`${OK} Pulled ${fills.length} FILL activity record(s) from Alpaca since ${sinceDate}`);
    } catch (err) {
      console.log(`${FAIL} getActivities failed: ${err.message} — will estimate all positions`);
    }
  }
  console.log('');

  // ── Reconcile each position ──────────────────────────────────────────────
  // FIFO-allocate all fills across same-symbol positions in open-date order.
  // This disambiguates the 3 UNH shorts and searches exits through NOW (not the
  // record's closeDate), so runners that closed days after their recorded target
  // date (PYPL/ADBE on 2026-07-17) get their real exit fills.
  const { alloc, leftovers } = (alpacaOk && fills.length)
    ? allocateFillsFIFO(closed, fills)
    : { alloc: new Map(), leftovers: new Map() };

  const rows = [];
  const corrected = [];
  let sumCorrected = 0;

  for (const pos of closed) {
    const oldPnl = pos.total_pnl ?? pos.realizedPnl ?? 0;
    const need   = pos.shares_total ?? pos.shares ?? 0;

    let newPnl = oldPnl;
    let source = 'estimate';
    let detail = '';
    const a = alloc.get(pos);
    if (alpacaOk && a && a.matched) {
      newPnl = a.pnl;
      source = 'alpaca_fill';
      detail = `entry~$${a.entryAvg != null ? a.entryAvg.toFixed(2) : '?'} exit~$${a.exitAvg != null ? a.exitAvg.toFixed(2) : '?'} (${a.entryQty}/${a.exitQty} of ${need})`;
    } else if (alpacaOk && a) {
      detail = `${a.note || 'incomplete fills'} - kept estimate`;
    } else if (alpacaOk) {
      detail = 'no fills for symbol - kept estimate';
    } else {
      detail = 'offline - kept estimate';
    }

    sumCorrected += newPnl;
    rows.push({
      symbol: pos.symbol, side: pos.side, closeDate: pos.closeDate || '',
      oldPnl, newPnl, source, detail, delta: parseFloat((newPnl - oldPnl).toFixed(2)),
    });

    // Build the corrected record (additive stamp; only overwrite P&L fields).
    corrected.push({
      ...pos,
      total_pnl:   parseFloat(newPnl.toFixed(2)),
      realizedPnl: parseFloat(newPnl.toFixed(2)),
      pnl_source:  source,
      reconciled_at: new Date().toISOString().slice(0, 10),
    });
  }

  // ── Reconstruct ORPHAN trades (dropped from records but real on Alpaca) ───
  // The MCD paper stop-out (−$78.14) was deleted from closed-positions-sid.json
  // at commit a40456fc but never removed from the account totals, so the books
  // are ~$78 short of the paper account. Any symbol with a complete leftover
  // round-trip is such an orphan — rebuild it from the real fills.
  const reconstructed = alpacaOk ? reconstructOrphans(leftovers, reconcileMode) : [];

  // ── MCD manual fallback (PAPER ONLY) ──────────────────────────────────────
  // If MCD's real fills are NOT in Alpaca's returned activity (window too tight,
  // paper history pruned, etc.) it won't be reconstructed above. Re-add the
  // KNOWN MCD record (−$78.14, from git commit 76a98edd) so the paper books
  // still tie — flagged reconstructed_manual so it's clearly not fill-derived.
  // NEVER fabricate a number: this uses the exact figure that was manually
  // reconciled from the two Alpaca stop-fill screenshots on 2026-06-05.
  // GUARDED to reconcileMode==='paper' — MCD is a PAPER trade and must NEVER be
  // injected into a live reconcile / live ledger / live tax report.
  const MCD_KNOWN = {
    symbol: 'MCD', side: 'long', entry: 281.67, exit_price: 271.9025,
    shares_total: 8, shares: 8, openDate: '2026-05-22', closeDate: '2026-06-04',
    exit_strategy: 'external_stop_fill', total_pnl: -78.14, realizedPnl: -78.14,
    mode: 'paper', strategy: 'SID v2.1 (hybrid S&D — manual entry, Alpaca-side stops)',
    pnl_source: 'reconstructed_manual', reconstructed: true,
    reconstructed_note: 'MCD paper stop-out dropped from records at commit a40456fc; ' +
      'known -$78.14 from git 76a98edd (two Alpaca stop fills: 4sh @ $271.88 May 26 + ' +
      '4sh @ $271.925 Jun 04). PAPER ONLY — must never appear in the live tax report.',
    reconciled_at: new Date().toISOString().slice(0, 10),
  };
  const alreadyHaveMcd = [...allClosed, ...reconstructed].some(r => String(r.symbol).toUpperCase() === 'MCD');
  const mcdFallbackUsed = alpacaOk && reconcileMode === 'paper' && !alreadyHaveMcd;
  if (mcdFallbackUsed) reconstructed.push(MCD_KNOWN);

  // Fold reconstructed records into the corrected set + total.
  for (const rec of reconstructed) {
    corrected.push(rec);
    sumCorrected += rec.total_pnl;
    rows.push({
      symbol: rec.symbol, side: rec.side, closeDate: rec.closeDate || '',
      oldPnl: 0, newPnl: rec.total_pnl, source: rec.pnl_source,
      delta: parseFloat((rec.total_pnl).toFixed(2)),
      detail: rec.pnl_source === 'reconstructed_manual'
        ? 'RECONSTRUCTED (manual known figure — orphan not in Alpaca window)'
        : `RECONSTRUCTED from fills (entry~$${rec.entry} exit~$${rec.exit_price}, ${rec.shares_total}sh)`,
    });
  }

  sumCorrected = parseFloat(sumCorrected.toFixed(2));

  // ── Print the before/after table ─────────────────────────────────────────
  console.log('== Per-position reconciliation ==');
  console.log(`   ${pad('SYMBOL',7)} ${pad('SIDE',6)} ${pad('CLOSED',11)} ${padl('OLD P&L',10)} ${padl('NEW P&L',10)} ${padl('DELTA',9)}  SOURCE / NOTE`);
  console.log('   ' + '-'.repeat(88));
  for (const r of rows) {
    const tag = (r.source === 'alpaca_fill') ? OK
              : (r.source === 'reconstructed_manual') ? WARN
              : WARN;
    console.log(`   ${pad(r.symbol,7)} ${pad(r.side,6)} ${pad(r.closeDate,11)} ${padl(money(r.oldPnl),10)} ${padl(money(r.newPnl),10)} ${padl(money(r.delta),9)}  ${tag} ${r.source} ${r.detail ? ARROW + ' ' + r.detail : ''}`);
  }
  console.log('   ' + '-'.repeat(88));

  const oldRecordsSum = parseFloat(closed.reduce((s, p) => s + (p.total_pnl ?? p.realizedPnl ?? 0), 0).toFixed(2));
  const matchedCount  = rows.filter(r => r.source === 'alpaca_fill').length;
  const reconManualCount = rows.filter(r => r.source === 'reconstructed_manual').length;
  const estimateCount = rows.filter(r => r.source === 'estimate').length;
  const reconstructedCount = reconstructed.length;

  console.log('');
  console.log('== Ledger reconciliation (internal $10K sizing base) ==');
  console.log(`   ${pad('',34)} ${padl('BEFORE',12)} ${padl('AFTER',12)}`);
  console.log(`   ${pad('realizedPnl (Sigma records)',34)} ${padl(money(account?.realizedPnl ?? oldRecordsSum),12)} ${padl(money(sumCorrected),12)}`);
  console.log(`   ${pad('tradeCount (distinct positions)',34)} ${padl(String(account?.tradeCount ?? '?'),12)} ${padl(String(corrected.length),12)}`);
  console.log(`   ${pad('accountUsd (10000 + realizedPnl)',34)} ${padl('$' + (account?.accountUsd ?? (STARTING_LEDGER_USD + oldRecordsSum)).toFixed(2),12)} ${padl('$' + (STARTING_LEDGER_USD + sumCorrected).toFixed(2),12)}`);
  console.log('');
  if (reconstructedCount) {
    console.log(`   Reconstructed orphans: ${reconstructedCount} trade(s) re-added (dropped from records but real on the paper account)`);
  }
  console.log(`   Old records sum:      ${money(oldRecordsSum)}   (what the dashboard headline shows today)`);
  const breakdown = [`${matchedCount} matched to Alpaca fills`];
  if (reconManualCount) breakdown.push(`${reconManualCount} reconstructed (manual known figure)`);
  if (estimateCount)    breakdown.push(`${estimateCount} kept as estimate`);
  console.log(`   Corrected records:    ${money(sumCorrected)}   (${breakdown.join(', ')})`);
  if (alpacaOk && alpacaEquity != null) {
    const alpacaNet = parseFloat((alpacaEquity - STARTING_ALPACA_USD).toFixed(2));
    console.log(`   Alpaca equity:        $${alpacaEquity.toFixed(2)}  -> net ${money(alpacaNet)} on $${STARTING_ALPACA_USD} base (SOURCE OF TRUTH)`);
    const gap = parseFloat((alpacaNet - sumCorrected).toFixed(2));
    // With 0 estimates the residual is "unmatched fills / trades not in records",
    // not "see estimate rows". A small non-zero gap after reconstruction is
    // typically fees/rounding on the paper account.
    let gapNote;
    if (Math.abs(gap) < 1)         gapNote = `${OK} reconciled to the dollar`;
    else if (estimateCount === 0)  gapNote = `${WARN} residual = unmatched fills / trades not in records (likely fees/rounding)`;
    else                           gapNote = `${WARN} residual — see the estimate rows above`;
    console.log(`   Corrected vs Alpaca:  gap ${money(gap)}  ${gapNote}`);
  } else {
    console.log(`   Alpaca equity:        (unavailable offline - run in cloud to compare against +$182.18)`);
  }
  console.log('');

  // ── Build the Alpaca equity snapshot for the dashboard headline ──────────
  const snapshot = {
    equity:         alpacaOk && alpacaEquity != null ? parseFloat(alpacaEquity.toFixed(2)) : null,
    startingEquity: STARTING_ALPACA_USD,
    netPnl:         alpacaOk && alpacaEquity != null ? parseFloat((alpacaEquity - STARTING_ALPACA_USD).toFixed(2)) : null,
    source:         'alpaca',
    mode,
    asOf:           new Date().toISOString(),
    reconciledRecords:   matchedCount,
    reconstructedRecords: reconstructedCount,
    estimateRecords:     estimateCount,
  };

  // ── Write or dry-run ─────────────────────────────────────────────────────
  if (DRY_RUN) {
    console.log(`${OK} DRY-RUN complete. No files written. Re-run with --write to persist.`);
    console.log('     Files that WOULD change:');
    console.log(`       - closed-positions-sid.json  (P&L rewritten + pnl_source stamped${reconstructedCount ? `; +${reconstructedCount} reconstructed orphan record(s)` : ''})`);
    console.log('       - sid-account.json           (realizedPnl/accountUsd/tradeCount re-derived)');
    console.log('       - alpaca-account-sid.json    (real Alpaca equity snapshot, NEW)');
    return;
  }

  // WRITE mode — guard: refuse to overwrite good records with all-estimates.
  if (!alpacaOk) {
    console.log(`${FAIL} --write refused: no live Alpaca connection, so every record would be an`);
    console.log(`       estimate and nothing would be corrected. Run --write ONLY in the cloud`);
    console.log(`       (sid-reconcile.yml) where the ALPACA_* secrets exist. Aborting.`);
    process.exit(1);
  }

  // SEGREGATION: the written file = reconciled-scope records + the QUARANTINED
  // other-mode records passed through byte-for-byte. Never drop the quarantined
  // set (that would delete e.g. live history) and never merge its P&L into the
  // reconciled ledger. Order: reconciled scope first, then quarantined.
  const fileOut = [...corrected, ...quarantined];
  fs.writeFileSync(CLOSED_PATH, JSON.stringify(fileOut, null, 2));
  console.log(`${OK} Wrote ${fileOut.length} record(s) to closed-positions-sid.json (${corrected.length} reconciled ${reconcileMode}, ${quarantined.length} quarantined pass-through)`);

  // The ledger being re-derived is the RECONCILED-MODE ledger only. sid-account.json
  // tracks one mode's account (paper now); its realizedPnl/tradeCount reflect the
  // reconciled scope, never the quarantined records. When the user goes live, a
  // FRESH live ledger is started separately (mode:live, tradeCount 0) — this tool
  // reconciles whichever mode the Alpaca account resolves to.
  const newAccount = {
    ...(account || {}),
    accountUsd:  parseFloat((STARTING_LEDGER_USD + sumCorrected).toFixed(2)),
    startingUsd: STARTING_LEDGER_USD,
    realizedPnl: sumCorrected,
    tradeCount:  corrected.length,
    lastUpdated: new Date().toISOString().slice(0, 10),
    mode:        reconcileMode,
    reconciledFromAlpaca: true,
    reconciledAt: new Date().toISOString().slice(0, 10),
  };
  fs.writeFileSync(ACCOUNT_PATH, JSON.stringify(newAccount, null, 2));
  console.log(`${OK} Re-derived sid-account.json (${reconcileMode}): realizedPnl ${money(sumCorrected)}  tradeCount ${corrected.length}  accountUsd $${newAccount.accountUsd}`);

  fs.writeFileSync(ALPACA_SNAP_PATH, JSON.stringify(snapshot, null, 2));
  console.log(`${OK} Wrote alpaca-account-sid.json: equity $${snapshot.equity}  netPnl ${money(snapshot.netPnl)}`);

  console.log('');
  console.log(`${OK} WRITE complete.`);
}

main().catch(err => {
  console.error(`${FAIL} Reconciliation crashed: ${err.stack || err.message}`);
  process.exit(1);
});
