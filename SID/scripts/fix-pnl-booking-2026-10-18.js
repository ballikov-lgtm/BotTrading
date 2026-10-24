/**
 * ONE-OFF RECORD CORRECTION — v2.5.0 P&L booking bugs (2026-10-18)
 * =================================================================
 *
 * Retro-fixes the stored PAPER records that the three v2.5.0 bugs corrupted, so
 * the books tie to the real Alpaca paper account. The CODE fixes in bot-sid.js
 * stop it recurring; this repairs the damage already on disk.
 *
 * WHAT WAS WRONG (all verified 2026-10-18 against Alpaca with READ-ONLY GETs —
 * /v2/orders, /v2/account/activities/FILL and /v2/account/activities/FEE):
 *
 *   BUG 1  external full close dropped a bot-booked TP1 leg
 *          IBM  booked +42.52  truth +82.88   (TP1 +40.56 lost)
 *          HON  booked  -0.09  truth +19.83   (TP1 +20.58 lost)
 *   BUG 2  stop exits booked the stop LEVEL, not the real fill
 *          HD   booked -24.96  truth -27.01   (level 304.00 vs fill 303.346667)
 *   BUG 3  entry stored from the SIGNAL bar, not the entry fill
 *          HON  204.22 vs 204.44 | IBM 217.13 vs 217.23 | HD 312.32 vs 312.35
 *          RIOT 19.65  vs 19.665526 | ABT 115.36 vs 115.35 | PYPL 60.675 vs 60.67
 *          (ABT and RIOT were NOT in the original brief — found by auditing all
 *           16 records against real fills rather than only the 5 flagged ones.)
 *   BUG 1b the v2.4.3 PYPL leg-2 fill double-count, never applied to cloud state
 *          leg 2 booked +57.58 at "exit 53.4775" = (2*56.71 + 6*52.40)/8 — six
 *          shares back-filled at leg 1's already-consumed price. Truth +31.98.
 *
 * HOW THE NUMBERS ARE DERIVED (not asserted by hand):
 *   Every leg is recomputed by the BOT'S OWN realisedPnlFor() from the REAL
 *   broker entry fill + the REAL broker exit fills listed below. Each trade's
 *   resulting total is then cross-checked against CASHFLOW_TARGET — the
 *   independent per-symbol (sell proceeds - buy cost) figure computed straight
 *   from Alpaca's FILL activities. Both must agree or the script ABORTS.
 *
 * RECONCILIATION (independent of Alpaca equity — nothing is back-solved):
 *   corrected records sum  = +$543.94
 *   real fee activities    =   -$0.51   (47 rows: TAF 0.14 + CAT 0.27 + REG 0.10)
 *   => expected equity net = +$543.43   = Alpaca equity $100,543.43 EXACTLY.
 *
 * SUPERSEDES scripts/fix-pypl-leg2-2026-09-05.js, which was written against the
 * stale worktree state and never applied to the cloud records. Its target for
 * PYPL leg 2 was +32.02 because it used the STORED entry 60.675; the real entry
 * fill is 60.67, so the correct figure is +31.98. Do not run both.
 *
 * SAFETY
 *   - DRY-RUN BY DEFAULT. `--write` persists.
 *   - ASSERTS the exact pre-state of every field it touches. Any mismatch (incl.
 *     a record that ALREADY carries the corrected value) aborts with exit code 1
 *     and writes nothing. Idempotent in the only sense that matters: a second
 *     --write cannot double-apply, it refuses.
 *   - PAPER ONLY. A record whose mode is not 'paper' is refused outright.
 *   - Touches no open position, no strategy rule, no Alpaca order. Read-only
 *     w.r.t. the broker — this script makes no network calls at all.
 *
 *   node scripts/fix-pnl-booking-2026-10-18.js            # dry-run (DEFAULT)
 *   node scripts/fix-pnl-booking-2026-10-18.js --write    # persist
 *
 * ASCII-only console output (cp1252 machine — see SID/CLAUDE.md).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { realisedPnlFor } from '../bot-sid.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLOSED_PATH = path.join(__dirname, '..', 'closed-positions-sid.json');
const CSV_PATH    = path.join(__dirname, '..', 'trades-sid.csv');

const WRITE = process.argv.includes('--write');
const TAG   = 'v2.5.0-pnl-booking-2026-10-18';
const OK = '[OK]', FAIL = '[FAIL]', WARN = '[WARN]', ARROW = '->';
const money = n => ((Number(n) || 0) >= 0 ? '+' : '-') + '$' + Math.abs(Number(n) || 0).toFixed(2);
const near  = (a, b, tol = 1e-6) => Math.abs(Number(a) - Number(b)) <= tol;

// Weighted average from INDIVIDUAL fills: [[qty, price], ...].
// WHY THIS EXISTS: Alpaca's own order-level `filled_avg_price` is rounded to 6dp,
// and for a multi-price order that rounding is enough to move a leg by a cent and
// break the tie-to-the-broker. RIOT's entry (19.665526 displayed, really
// 747.29/38 = 19.66552631578...) and HD's exit (303.346667 displayed, really
// 910.04/3) both needed fill-level precision. Only orders with a NON-uniform fill
// price use this; single-price orders are already exact.
const wavg = fills => {
  const q = fills.reduce((s, [n]) => s + n, 0);
  const c = fills.reduce((s, [n, p]) => s + n * p, 0);
  return c / q;
};

const problems = [];
const abort = msg => { problems.push(msg); };

// ── Independently-computed per-symbol cash-flow P&L from Alpaca FILL activities
// (sell proceeds - buy cost; every symbol is flat, so this is exact).
const CASHFLOW_TARGET = {
  RIOT: 145.60, ABT: 53.16, IBM: 82.88, HD: -27.01, HON: 19.83, IYR: -19.30,
  PYPL_SHORT: 106.41,   // leg 1 74.43 + leg 2 31.98 (the PYPL long is a separate record)
};
const RECORDS_SUM_TARGET = 543.94;   // all 16 corrected paper records
const FEES_TOTAL         = -0.51;    // 47 real FEE activity rows
const ALPACA_EQUITY_NET  = 543.43;   // $100,543.43 on a $100,000 base

// ── The corrections. `expect` is the exact pre-state (abort on any mismatch).
// `realEntry` / `legs` are REAL broker fills; P&L is recomputed from them.
const CORRECTIONS = [
  {
    label: 'RIOT long (bug 3 — entry from signal)',
    symbol: 'RIOT', id: '71c298f4-58fc-4aaf-a53a-744148aced14', closeDate: '2026-07-23',
    expect: { entry: 19.649999618530273, total_pnl: 146.19, tp1_pnl: 62.4, tp2_pnl: 83.79, pnl_source: 'alpaca_fill' },
    // order 71c298f4, 38 sh across 5 fills at 3 different prices -> wavg from fills
    realEntry: wavg([[12, 19.66], [6, 19.66], [11, 19.67], [8, 19.67], [1, 19.68]]),
    legs: [
      { field: 'tp1_pnl', shares: 19, priceFills: [[8, 22.94], [11, 22.93]] },  // order f435a0f9
      { field: 'tp2_pnl', shares: 19, price: 24.06 },                           // order 103b913d (uniform)
    ],
    target: CASHFLOW_TARGET.RIOT,
  },
  {
    label: 'ABT short (bug 3 — entry from signal)',
    symbol: 'ABT', id: '93fe9b4b-8bc3-4305-aac6-11cb138c1d47', closeDate: '2026-09-08',
    expect: { entry: 115.36000061035156, total_pnl: 53.24, tp1_pnl: 16.16, tp2_pnl: 37.08, pnl_source: 'alpaca_fill' },
    realEntry: 115.35,
    legs: [
      { field: 'tp1_pnl', shares: 4, price: 111.32 },
      { field: 'tp2_pnl', shares: 4, price: 106.09 },
    ],
    target: CASHFLOW_TARGET.ABT,
  },
  {
    label: 'IBM long (bug 1 — TP1 leg dropped + bug 3 entry)',
    symbol: 'IBM', id: '65e9885d-2f58-42c4-8dd6-b99aa47601f1', closeDate: '2026-09-10',
    expect: { entry: 217.1300048828125, total_pnl: 42.52, tp1_pnl: 40.76, exit_pnl: 42.52, is_full_close: true, pnl_source: 'alpaca_fill' },
    realEntry: 217.23,
    legs: [
      { field: 'tp1_pnl',  shares: 2, price: 237.51, alsoSet: { tp1_price: 237.51 } },
      { field: 'exit_pnl', shares: 2, price: 238.39, alsoSet: { exit_price: 238.39 } },
    ],
    setFlags: { tp1_pnl_included: true },
    target: CASHFLOW_TARGET.IBM,
  },
  {
    label: 'HD long (bug 2 — stop LEVEL booked + bug 3 entry)',
    symbol: 'HD', id: 'd115f16b-475c-4d1b-b9a8-affe6c38b5be', closeDate: '2026-09-16',
    expect: { entry: 312.32000732421875, total_pnl: -24.96, tp1_pnl: -24.96, exitPrice: 304, pnl_source: 'estimate' },
    realEntry: 312.35,
    legs: [
      // Full stop-out before TP1: the whole position exits on one leg, which this
      // record stores in tp1_pnl (tp1_reason 'stop') with tp2_pnl 0.
      // 1 @ 303.34 + 2 @ 303.35 -> wavg 910.04/3 (Alpaca displays 303.346667)
      { field: 'tp1_pnl', shares: 3, priceFills: [[1, 303.34], [2, 303.35]],
        alsoSet: { tp1_price: wavg([[1, 303.34], [2, 303.35]]), exitPrice: wavg([[1, 303.34], [2, 303.35]]) } },
    ],
    setFlags: { pnl_source: 'alpaca_fill' },
    target: CASHFLOW_TARGET.HD,
  },
  {
    label: 'IYR long (bug 2 — provenance only; P&L already correct)',
    symbol: 'IYR', id: '5df6a49f-e87b-43da-87f2-d6c68bd80f7e', closeDate: '2026-09-24',
    expect: { entry: 98.93000030517578, total_pnl: -19.3, tp1_pnl: -19.3, exitPrice: 97, pnl_source: 'estimate' },
    realEntry: 98.93,                            // matches the fill; no price change
    legs: [
      { field: 'tp1_pnl', shares: 10, price: 97, alsoSet: { tp1_price: 97, exitPrice: 97 } },
    ],
    setFlags: { pnl_source: 'alpaca_fill' },      // the stop level HAPPENED to equal the fill
    target: CASHFLOW_TARGET.IYR,
  },
  {
    label: 'HON long (bug 1 — TP1 leg dropped + bug 3 entry)',
    symbol: 'HON', id: '6831959f-5bcf-494f-9c46-da712d5a4ab3', closeDate: '2026-10-08',
    expect: { entry: 204.22000122070312, total_pnl: -0.09, tp1_pnl: 21.02, exit_pnl: -0.09, is_full_close: true, pnl_source: 'alpaca_fill' },
    realEntry: 204.44,
    legs: [
      { field: 'tp1_pnl',  shares: 2, price: 214.73, alsoSet: { tp1_price: 214.73 } },
      { field: 'exit_pnl', shares: 3, price: 204.19, alsoSet: { exit_price: 204.19 } },
    ],
    setFlags: { tp1_pnl_included: true },
    target: CASHFLOW_TARGET.HON,
  },
  {
    label: 'PYPL short leg 1 (bug 3 — entry from signal)',
    symbol: 'PYPL', id: '9c344898-9a70-4e0c-9078-56d5432519f0', closeDate: '2026-09-02', exitShares: 9,
    expect: { entry: 60.67499923706055, total_pnl: 74.47, exit_pnl: 74.47, is_full_close: false, pnl_source: 'alpaca_fill' },
    realEntry: 60.67,
    legs: [
      { field: 'exit_pnl', shares: 9, price: 52.4, alsoSet: { exit_price: 52.4 } },
    ],
    target: 74.43,
  },
  {
    label: 'PYPL short leg 2 (bug 1b — fill double-count + bug 3 entry)',
    symbol: 'PYPL', id: '9c344898-9a70-4e0c-9078-56d5432519f0', closeDate: '2026-09-04', exitShares: 8,
    expect: { entry: 60.67499923706055, total_pnl: 57.58, exit_pnl: 57.58, exit_price: 53.4775, is_full_close: true, pnl_source: 'alpaca_fill' },
    realEntry: 60.67,
    legs: [
      // The REAL unconsumed fills. 6 @ 56.66 is order 452d8277 — the v2.4.3 note
      // said that id "was never captured", but /v2/account/activities/FILL has it,
      // so a real id is stamped rather than null.
      { field: 'exit_pnl', shares: 8, price: 56.6725, alsoSet: {
          exit_price: 56.6725,
          exit_fills: [
            { orderId: '452d8277-82a8-4010-9daf-dfbb5c73a2d7', filledAt: '2026-09-03T18:08:08.18294Z', qty: 6, price: 56.66 },
            { orderId: 'e903f7c2-c66d-4194-a73c-2868b804d3dc', filledAt: '2026-09-03T18:10:14.671498Z', qty: 2, price: 56.71 },
          ],
        } },
    ],
    // leg 1 already carries the TP1/first half; this full close must NOT re-add it
    setFlags: { tp1_pnl_included: false, tp1_leg_in_prior_record: true },
    target: 31.98,
  },
];

// ── Load + match ────────────────────────────────────────────────────────────
const closed = JSON.parse(fs.readFileSync(CLOSED_PATH, 'utf8'));
console.log('== SID v2.5.0 P&L booking correction ==');
console.log(`   Mode        : ${WRITE ? 'WRITE' : 'DRY-RUN (default)'}`);
console.log(`   Records file: ${CLOSED_PATH}`);
console.log(`   Records     : ${closed.length}`);
console.log(`   Pre-state sum: ${money(closed.reduce((s, r) => s + (r.total_pnl ?? r.realizedPnl ?? 0), 0))}\n`);

// `--csv-only` re-applies ONLY the trades-sid.csv journal patch, reading the
// already-corrected records. Needed because the record assertions below rightly
// refuse once the JSON carries the correction tag, but the CSV is a separate
// artifact with its own per-row-type column semantics (see patchCsv).
if (process.argv.includes('--csv-only')) {
  if (!WRITE) { console.log(`${WARN} --csv-only needs --write. Nothing done.`); process.exit(0); }
  patchCsv(closed);
  process.exit(0);
}

const planned = [];

for (const c of CORRECTIONS) {
  const idx = closed.findIndex(r =>
    r.symbol === c.symbol &&
    r.id === c.id &&
    r.closeDate === c.closeDate &&
    (c.exitShares === undefined || r.exit_shares === c.exitShares)
  );
  if (idx === -1) { abort(`${c.label}: NO matching record (symbol=${c.symbol} id=${c.id} closeDate=${c.closeDate}${c.exitShares !== undefined ? ` exit_shares=${c.exitShares}` : ''})`); continue; }
  const rec = closed[idx];

  // PAPER-ONLY guard
  const mode = String(rec.mode || 'paper').toLowerCase();
  if (mode !== 'paper') { abort(`${c.label}: record mode is "${mode}" — refusing (paper-only correction)`); continue; }

  // Already corrected? (the explicit "don't double-apply" check)
  if (rec.correction?.tag === TAG) { abort(`${c.label}: ALREADY carries correction.tag "${TAG}" — refusing to re-apply`); continue; }

  // Pre-state assertions
  let mismatch = false;
  for (const [k, v] of Object.entries(c.expect)) {
    const have = rec[k];
    const same = (typeof v === 'number') ? near(have, v) : have === v;
    if (!same) { abort(`${c.label}: pre-state mismatch on "${k}" — expected ${JSON.stringify(v)}, found ${JSON.stringify(have)}`); mismatch = true; }
  }
  if (mismatch) continue;

  // Recompute every leg from the REAL fills with the BOT'S OWN function
  const changes = {};
  let total = 0;
  for (const leg of c.legs) {
    const legPrice = leg.priceFills ? wavg(leg.priceFills) : leg.price;
    const pnl = realisedPnlFor(rec.side, c.realEntry, legPrice, leg.shares);
    changes[leg.field] = pnl;
    total += pnl;
    Object.assign(changes, leg.alsoSet || {});
  }
  total = parseFloat(total.toFixed(2));

  // Cross-check against the independent broker cash-flow figure
  if (!near(total, c.target, 0.005)) {
    abort(`${c.label}: recomputed total ${money(total)} does NOT match the broker cash-flow target ${money(c.target)} — refusing`);
    continue;
  }

  changes.entry       = c.realEntry;
  changes.total_pnl   = total;
  changes.realizedPnl = total;
  if (rec.outcome !== undefined) changes.outcome = total >= 0 ? 'WIN' : 'LOSS';
  if (rec.totalUsd !== undefined && rec.shares_total) {
    changes.totalUsd = parseFloat((rec.shares_total * c.realEntry).toFixed(2));
  }
  Object.assign(changes, c.setFlags || {});

  planned.push({ idx, rec, c, changes, before: { total_pnl: rec.total_pnl, entry: rec.entry } });
}

// ── Report ──────────────────────────────────────────────────────────────────
console.log('-- Planned corrections --');
for (const p of planned) {
  console.log(`\n  ${p.c.label}`);
  console.log(`    record #${p.idx}  ${p.rec.symbol} ${p.rec.side} ${p.rec.shares_total}sh  closed ${p.rec.closeDate}`);
  for (const [k, v] of Object.entries(p.changes)) {
    const before = p.rec[k];
    const bStr = (before && typeof before === 'object') ? JSON.stringify(before).slice(0, 48) + '...' : JSON.stringify(before);
    const aStr = (v && typeof v === 'object') ? JSON.stringify(v).slice(0, 48) + '...' : JSON.stringify(v);
    if (bStr !== aStr) console.log(`      ${k.padEnd(24)} ${String(bStr).padEnd(26)} ${ARROW}  ${aStr}`);
  }
  console.log(`      ${'TRADE TOTAL'.padEnd(24)} ${money(p.before.total_pnl).padEnd(26)} ${ARROW}  ${money(p.changes.total_pnl)}   (broker cash-flow ${money(p.c.target)})`);
}

if (problems.length) {
  console.log(`\n${FAIL} ${problems.length} problem(s) — NOTHING written:`);
  for (const p of problems) console.log(`   - ${p}`);
  process.exit(1);
}
if (planned.length !== CORRECTIONS.length) {
  console.log(`\n${FAIL} planned ${planned.length} of ${CORRECTIONS.length} corrections — NOTHING written`);
  process.exit(1);
}

// ── Projected totals ────────────────────────────────────────────────────────
const projected = closed.map((r, i) => {
  const p = planned.find(x => x.idx === i);
  return p ? { ...r, ...p.changes } : r;
});
const projSum = parseFloat(projected
  .filter(r => String(r.mode || 'paper').toLowerCase() === 'paper')
  .reduce((s, r) => s + (r.total_pnl ?? r.realizedPnl ?? 0), 0).toFixed(2));

console.log('\n-- Reconciliation --');
console.log(`   Corrected records sum : ${money(projSum)}`);
console.log(`   Real fee activities   : ${money(FEES_TOTAL)}   (TAF + CAT + REG, 47 rows)`);
console.log(`   Expected equity net   : ${money(parseFloat((projSum + FEES_TOTAL).toFixed(2)))}`);
console.log(`   Alpaca equity net     : ${money(ALPACA_EQUITY_NET)}`);
const residual = parseFloat((projSum + FEES_TOTAL - ALPACA_EQUITY_NET).toFixed(2));
console.log(`   Residual              : ${money(residual)}`);

if (!near(projSum, RECORDS_SUM_TARGET, 0.005)) {
  console.log(`\n${FAIL} corrected sum ${money(projSum)} != expected ${money(RECORDS_SUM_TARGET)} — NOTHING written`);
  process.exit(1);
}
if (Math.abs(residual) > 0.005) {
  console.log(`\n${FAIL} residual ${money(residual)} is not zero — fills and fees must fully explain equity. NOTHING written`);
  process.exit(1);
}
console.log(`   ${OK} records - fees == Alpaca equity EXACTLY (residual $0.00)`);

// ── Apply ───────────────────────────────────────────────────────────────────
if (!WRITE) {
  console.log(`\n${OK} DRY-RUN complete. ${planned.length} record(s) would change. Nothing written.`);
  console.log('   Re-run with --write to persist, then: node scripts/rederive-ledger.js --write');
  process.exit(0);
}

for (const p of planned) {
  const rec = closed[p.idx];
  const prev = {};
  for (const k of Object.keys(p.changes)) prev[k] = rec[k];
  Object.assign(rec, p.changes);
  rec.correction = {
    tag: TAG,
    appliedAt: new Date().toISOString(),
    reason: p.c.label,
    source: 'Alpaca read-only GETs 2026-10-18 (/v2/orders + /v2/account/activities/FILL)',
    previous: prev,
  };
}
fs.writeFileSync(CLOSED_PATH, JSON.stringify(closed, null, 2));
console.log(`\n${OK} Wrote ${planned.length} corrected record(s) to closed-positions-sid.json`);

patchCsv(closed);
console.log(`\n${OK} DONE. Next: node scripts/rederive-ledger.js --write`);

// ── trades-sid.csv journal rows (secondary — the dashboard reads the JSON) ───
// COLUMN SEMANTICS DIFFER BY ROW TYPE, and getting this wrong silently changes
// what a column MEANS. Taken from the actual writers in bot-sid.js:
//   entry rows   (`Alpaca/<mode>`)  Total USD = shares x ENTRY   | Risk USD = sizing.riskUsd
//                                                                 | Risk %   = sizing.riskPct
//   TP1/TP2 rows (`V2.1/TP1|TP2-*`) Total USD = shares x EXIT     | Risk USD = leg P&L
//                                                                 | Risk %   = P&L / accountUsd
//   extclose rows(`*-extclose`)     Total USD = shares x ENTRY    | Risk USD = leg P&L
//                                                                 | Risk %   = P&L / (shares x entry)
// So: only the ENTRY PRICE and the P&L are wrong here. On TP rows Total USD is
// an EXIT notional and must NOT be recomputed from the entry (the exit prices
// never changed), and Risk % is a share of the ACCOUNT, so it is rescaled by the
// P&L ratio rather than invented from a new denominator.
function patchCsv(closedRecs) {
  const F = {
    ENTRY: 'entry', TP: 'tp', EXT: 'ext',
  };
  const CSV_FIXES = [
    { match: ['2026-07-20', 'RIOT', 'long'],           kind: F.ENTRY, entry: wavg([[12, 19.66], [6, 19.66], [11, 19.67], [8, 19.67], [1, 19.68]]), oldEntry: 19.65 },
    { match: ['2026-07-22', 'RIOT', 'long-tp1'],       kind: F.TP,    entry: wavg([[12, 19.66], [6, 19.66], [11, 19.67], [8, 19.67], [1, 19.68]]), oldEntry: 19.65, id: '71c298f4-58fc-4aaf-a53a-744148aced14', leg: 'tp1_pnl' },
    { match: ['2026-07-23', 'RIOT', 'long-tp2'],       kind: F.TP,    entry: wavg([[12, 19.66], [6, 19.66], [11, 19.67], [8, 19.67], [1, 19.68]]), oldEntry: 19.65, id: '71c298f4-58fc-4aaf-a53a-744148aced14', leg: 'tp2_pnl' },
    { match: ['2026-08-25', 'ABT',  'short'],          kind: F.ENTRY, entry: 115.35, oldEntry: 115.36 },
    { match: ['2026-09-01', 'ABT',  'short-tp1'],      kind: F.TP,    entry: 115.35, oldEntry: 115.36, id: '93fe9b4b-8bc3-4305-aac6-11cb138c1d47', leg: 'tp1_pnl' },
    { match: ['2026-09-08', 'ABT',  'short-tp2'],      kind: F.TP,    entry: 115.35, oldEntry: 115.36, id: '93fe9b4b-8bc3-4305-aac6-11cb138c1d47', leg: 'tp2_pnl' },
    { match: ['2026-07-27', 'IBM',  'long'],           kind: F.ENTRY, entry: 217.23, oldEntry: 217.13 },
    { match: ['2026-08-10', 'IBM',  'long-tp1'],       kind: F.TP,    entry: 217.23, oldEntry: 217.13, id: '65e9885d-2f58-42c4-8dd6-b99aa47601f1', leg: 'tp1_pnl' },
    { match: ['2026-09-10', 'IBM',  'long-extclose'],  kind: F.EXT,   entry: 217.23, oldEntry: 217.13, id: '65e9885d-2f58-42c4-8dd6-b99aa47601f1', leg: 'exit_pnl' },
    { match: ['2026-09-14', 'HD',   'long'],           kind: F.ENTRY, entry: 312.35, oldEntry: 312.32 },
    { match: ['2026-09-15', 'HON',  'long'],           kind: F.ENTRY, entry: 204.44, oldEntry: 204.22 },
    { match: ['2026-10-01', 'HON',  'long-tp1'],       kind: F.TP,    entry: 204.44, oldEntry: 204.22, id: '6831959f-5bcf-494f-9c46-da712d5a4ab3', leg: 'tp1_pnl' },
    { match: ['2026-10-08', 'HON',  'long-extclose'],  kind: F.EXT,   entry: 204.44, oldEntry: 204.22, id: '6831959f-5bcf-494f-9c46-da712d5a4ab3', leg: 'exit_pnl' },
    { match: ['2026-08-17', 'PYPL', 'short'],          kind: F.ENTRY, entry: 60.67, oldEntry: 60.67 },
    { match: ['2026-09-02', 'PYPL', 'short-extclose'], kind: F.EXT,   entry: 60.67, oldEntry: 60.67, pnl: 74.43 },
    { match: ['2026-09-04', 'PYPL', 'short-extclose'], kind: F.EXT,   entry: 60.67, oldEntry: 60.67, pnl: 31.98 },
  ];
  const raw = fs.readFileSync(CSV_PATH, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(/\r?\n/);
  let changed = 0, skipped = 0;
  for (const fix of CSV_FIXES) {
    const [d, sym, side] = fix.match;
    const li = lines.findIndex(l => { const f = l.split(','); return f[0] === d && f[3] === sym && f[4] === side; });
    if (li === -1) { console.log(`   ${WARN} CSV row not found: ${fix.match.join(' ')}`); continue; }
    const f = lines[li].split(',');
    // Idempotence: the Entry Price column must still read the OLD value.
    if (Math.abs(Number(f[6]) - fix.oldEntry) > 0.005) {
      console.log(`   ${WARN} CSV row already patched, left alone: ${fix.match.join(' ')} (entry col = ${f[6]})`);
      skipped++; continue;
    }
    const shares = Number(f[5]);
    f[6] = fix.entry.toFixed(2);                                   // Entry Price -> real fill
    let pnl = fix.pnl;
    if (pnl === undefined && fix.leg) {
      const rec = closedRecs.find(r => r.id === fix.id && r[fix.leg] !== undefined);
      if (rec) pnl = rec[fix.leg];
    }
    if (fix.kind === F.ENTRY) {
      f[8] = (shares * fix.entry).toFixed(2);                      // entry notional
      // Risk USD / Risk % on an entry row are SIZING outputs — untouched.
    } else if (fix.kind === F.TP) {
      // Total USD is the EXIT notional — exit prices did not change, so leave it.
      if (pnl !== undefined) {
        const oldPnl = Number(f[9]);
        f[9] = Number(pnl).toFixed(2);
        // Risk % = P&L / accountUsd. Rescale by the P&L ratio to keep the SAME
        // account denominator rather than inventing a new one.
        if (oldPnl !== 0) f[10] = ((Number(f[10]) * (Number(pnl) / oldPnl))).toFixed(2);
      }
    } else { // EXT
      f[8] = (shares * fix.entry).toFixed(2);                      // entry notional
      if (pnl !== undefined) {
        f[9] = Number(pnl).toFixed(2);
        f[10] = ((Number(pnl) / (shares * fix.entry)) * 100).toFixed(2);
      }
    }
    lines[li] = f.join(',');
    changed++;
  }
  fs.writeFileSync(CSV_PATH, lines.join(eol));
  console.log(`${OK} Patched ${changed} journal row(s) in trades-sid.csv${skipped ? ` (${skipped} already patched, skipped)` : ''}`);
}
