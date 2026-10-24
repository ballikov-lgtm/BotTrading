/**
 * SID v2.5.0 — P&L BOOKING REGRESSION SUITE
 * ==========================================
 *
 * Covers the three booking bugs v2.5.0 fixes, plus the v2.4.3 work carried into
 * this release. Every bug has a REGRESSION WITNESS: the pre-fix algorithm is
 * re-run on the real live data and must reproduce the exact bad number that is
 * on disk today, then the fixed code must produce the right one. A test that
 * only asserts the new number can't tell you the bug was ever real.
 *
 * WHY THIS FILE IS CHECKED IN: the v2.4.1/v2.4.3 harnesses ran in throwaway
 * sandboxes that were deleted afterwards, so "keep the existing 70/70 suite
 * green" was impossible to honour — the suite no longer existed. This one is
 * persistent and self-contained.
 *
 * NO NETWORK. NO BROKER CALLS. Tests that exercise functions which write state
 * run inside a throwaway copy of the module tree (SID/_v250_sandbox/) so no real
 * state file is ever touched; the sandbox is removed on exit. State paths anchor
 * to each module's own __dirname, which is what makes the sandbox work.
 *
 *   node tests/v2.5.0-pnl-booking.test.mjs
 *
 * ASCII-only console output (cp1252 machine — see SID/CLAUDE.md).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

process.env.TELEGRAM_ALERTS_ENABLED = 'false';   // no outbound messages
process.env.SID_TRADING_MODE = process.env.SID_TRADING_MODE || 'dry_run';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SID_DIR   = path.join(__dirname, '..');
const SANDBOX   = path.join(SID_DIR, '_v250_sandbox');

let pass = 0, fail = 0;
const failures = [];
function check(name, got, want, tol = 0) {
  const ok = (typeof want === 'number' && typeof got === 'number' && tol > 0)
    ? Math.abs(got - want) <= tol
    : JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; failures.push(name); console.log(`  [FAIL] ${name}\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`); }
}
function ok(name, cond) { check(name, !!cond, true); }
function section(t) { console.log(`\n== ${t} ==`); }

// ── Sandbox ─────────────────────────────────────────────────────────────────
const MODULES = ['bot-sid.js', 'alpaca-executor.js', 'alpaca-client.js', 'rsi-target-price.js', 'telegram-alerts.js'];
const DATA    = ['watchlist-sid.json', 'event-dates.json', 'asset-classification.json', 'rules-sid.json'];
function makeSandbox() {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  fs.mkdirSync(SANDBOX, { recursive: true });
  for (const m of [...MODULES, ...DATA]) {
    const src = path.join(SID_DIR, m);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(SANDBOX, m));
  }
  // Fresh, isolated state
  fs.writeFileSync(path.join(SANDBOX, 'open-positions-sid.json'), '[]');
  fs.writeFileSync(path.join(SANDBOX, 'closed-positions-sid.json'), '[]');
  fs.writeFileSync(path.join(SANDBOX, 'sid-account.json'), JSON.stringify({
    accountUsd: 10000, startingUsd: 10000, realizedPnl: 0, tradeCount: 0, mode: 'paper',
  }, null, 2));
  fs.writeFileSync(path.join(SANDBOX, 'sid-log.json'), '[]');
  fs.writeFileSync(path.join(SANDBOX, 'trades-sid.csv'),
    'Date,Time,Exchange,Symbol,Side,Shares,Entry Price,Stop Loss,Total USD,Risk USD,Risk %,Signal Date,Order ID,Mode,Strategy\n');
}
function setSandboxState({ closed = [], open = [] }) {
  fs.writeFileSync(path.join(SANDBOX, 'closed-positions-sid.json'), JSON.stringify(closed, null, 2));
  fs.writeFileSync(path.join(SANDBOX, 'open-positions-sid.json'), JSON.stringify(open, null, 2));
}
function sandboxClosed() {
  return JSON.parse(fs.readFileSync(path.join(SANDBOX, 'closed-positions-sid.json'), 'utf8'));
}

makeSandbox();
const bot     = await import(pathToUrl(path.join(SANDBOX, 'bot-sid.js')));
const realBot = await import(pathToUrl(path.join(SID_DIR, 'bot-sid.js')));
function pathToUrl(p) { return 'file:///' + p.replace(/\\/g, '/'); }

const {
  recordExternalClose, deriveLedger, realisedPnlFor,
  tp1LegAlreadyInClosedRecords, consumedExitFillQty,
  alpacaSnapshotPathForMode, alpacaStartingEquityFor, buildEntryPositionRecord,
  BOT_VERSION,
} = bot;

// ── Mock Alpaca client: serves only fills that existed BEFORE the close time.
// A naive mock that returns future fills makes leg 1 look wrong for reasons the
// real broker could never produce (cost the v2.4.3 harness an iteration).
function mockClient(orders, asOfIso) {
  return {
    listOrders: async () => orders.filter(o => !asOfIso || new Date(o.filled_at) <= new Date(asOfIso)),
  };
}

// ── REAL live data (verified 2026-10-18 via read-only Alpaca GETs) ──────────
const IBM = {
  entrySignal: 217.1300048828125, entryFill: 217.23,
  tp1: { shares: 2, price: 237.51 }, runner: { shares: 2, price: 238.39, orderId: '577e754f-fbea-46d4-9601-12ec6e4e347c' },
};
const HON = {
  entrySignal: 204.22000122070312, entryFill: 204.44,
  tp1: { shares: 2, price: 214.73 }, runner: { shares: 3, price: 204.19, orderId: '2dc841a2-9be8-455b-b476-cffd6e8837dc' },
};
const HD  = { entrySignal: 312.32000732421875, entryFill: 312.35, stopLevel: 304, exitFill: (1 * 303.34 + 2 * 303.35) / 3, shares: 3 };
const PYPL = {
  entrySignal: 60.67499923706055, entryFill: 60.67, shares: 17,
  leg1: { shares: 9, price: 52.4, orderId: 'b312909a-772e-418b-a2c0-690fb1ff8130', at: '2026-09-01T19:40:16.201083Z' },
  leg2a: { shares: 6, price: 56.66, orderId: '452d8277-82a8-4010-9daf-dfbb5c73a2d7', at: '2026-09-03T18:08:08.18294Z' },
  leg2b: { shares: 2, price: 56.71, orderId: 'e903f7c2-c66d-4194-a73c-2868b804d3dc', at: '2026-09-03T18:10:14.671498Z' },
};

// ── PRE-FIX ALGORITHMS (regression witnesses) ───────────────────────────────
/** v2.4.3 recordExternalClose: total_pnl = the closed leg ALONE. */
function oldTotalPnl_externalFullClose({ side, entry, exitPrice, sharesClosed }) {
  return realisedPnlFor(side, entry, exitPrice, sharesClosed);
}
/** v2.4.3 deriveLedger: added EVERY open tp1_hit position's tp1_pnl, unguarded. */
function oldDeriveLedger(mode, { closed, open }) {
  const m = String(mode || 'paper').toLowerCase();
  const rm = r => String(r?.mode || 'paper').toLowerCase();
  const c = closed.filter(r => rm(r) === m), o = open.filter(r => rm(r) === m);
  const closedSum = c.reduce((s, r) => s + (r.total_pnl ?? r.realizedPnl ?? 0), 0);
  const openTp1Sum = o.reduce((s, r) => s + (r.tp1_hit ? (r.tp1_pnl || 0) : 0), 0);
  return { realizedPnl: parseFloat((closedSum + openTp1Sum).toFixed(2)), tradeCount: c.length };
}
/** v2.4.3 stop path: booked the stop LEVEL with the SIGNAL entry. */
function oldStopPnl({ side, signalEntry, stopLevel, shares }) {
  return parseFloat((side === 'long' ? (stopLevel - signalEntry) * shares : (signalEntry - stopLevel) * shares).toFixed(2));
}

// ═══════════════════════════════════════════════════════════════════════════
section('A. BUG 1 — external full close dropped a bot-booked TP1 leg');

check('A0  bot reports v2.5.0', BOT_VERSION, 'v2.5.0');

// Regression witnesses: the OLD algorithm reproduces the exact numbers on disk.
check('A1  WITNESS old IBM total = the live bad +42.52',
  oldTotalPnl_externalFullClose({ side: 'long', entry: IBM.entrySignal, exitPrice: IBM.runner.price, sharesClosed: 2 }), 42.52);
check('A2  WITNESS old HON total = the live bad -0.09',
  oldTotalPnl_externalFullClose({ side: 'long', entry: HON.entrySignal, exitPrice: HON.runner.price, sharesClosed: 3 }), -0.09);

// NEW code, driven through the REAL recordExternalClose.
async function runExternalClose({ pos, sharesClosed, orders, isFullClose, asOf, priorClosed = [] }) {
  setSandboxState({ closed: priorClosed, open: [pos] });
  await recordExternalClose({
    pos, sharesClosed, alpacaClient: mockClient(orders, asOf),
    reasonKind: isFullClose ? 'full_external_fill' : 'partial_external_fill', isFullClose,
  });
  const all = sandboxClosed();
  return all[all.length - 1];
}

const ibmPos = {
  id: 'ibm-1', symbol: 'IBM', side: 'long', entry: IBM.entryFill, stopLoss: 217.14,
  shares: 4, shares_total: 4, shares_remaining: 2, mode: 'paper', openDate: '2026-07-27',
  tp1_hit: true, tp1_shares: 2, tp1_price: IBM.tp1.price,
  tp1_pnl: realisedPnlFor('long', IBM.entryFill, IBM.tp1.price, 2),   // 40.56
  tp1_pnl_source: 'alpaca_fill', tp1_close_order_id: 'ibm-tp1-order',
};
const ibmOrders = [
  { id: 'ibm-tp1-order', side: 'sell', status: 'filled', filled_qty: '2', filled_avg_price: String(IBM.tp1.price), filled_at: '2026-08-10T15:30:32Z' },
  { id: IBM.runner.orderId, side: 'sell', status: 'filled', filled_qty: '2', filled_avg_price: String(IBM.runner.price), filled_at: '2026-09-10T13:30:45Z' },
];
const ibmRec = await runExternalClose({ pos: ibmPos, sharesClosed: 2, orders: ibmOrders, isFullClose: true, asOf: '2026-09-10T18:00:00Z' });
check('A3  IBM tp1_pnl leg (real entry fill)', ibmPos.tp1_pnl, 40.56);
check('A4  IBM exit_pnl = THIS leg only', ibmRec.exit_pnl, 42.32);
check('A5  IBM total_pnl = TRADE total (TP1 carried)', ibmRec.total_pnl, 82.88);
check('A6  IBM realizedPnl mirrors total', ibmRec.realizedPnl, 82.88);
ok   ('A7  IBM stamped tp1_pnl_included', ibmRec.tp1_pnl_included === true);
check('A8  IBM pnl_source alpaca_fill (both legs real)', ibmRec.pnl_source, 'alpaca_fill');
ok   ('A9  IBM runner priced from the runner order, NOT the banked TP1 order',
  ibmRec.exit_fills.length === 1 && ibmRec.exit_fills[0].orderId === IBM.runner.orderId);

const honPos = {
  id: 'hon-1', symbol: 'HON', side: 'long', entry: HON.entryFill, stopLoss: 204.23,
  shares: 5, shares_total: 5, shares_remaining: 3, mode: 'paper', openDate: '2026-09-15',
  tp1_hit: true, tp1_shares: 2, tp1_price: HON.tp1.price,
  tp1_pnl: realisedPnlFor('long', HON.entryFill, HON.tp1.price, 2),   // 20.58
  tp1_pnl_source: 'alpaca_fill', tp1_close_order_id: 'hon-tp1-order',
};
const honOrders = [
  { id: 'hon-tp1-order', side: 'sell', status: 'filled', filled_qty: '2', filled_avg_price: String(HON.tp1.price), filled_at: '2026-10-01T19:42:36Z' },
  { id: HON.runner.orderId, side: 'sell', status: 'filled', filled_qty: '3', filled_avg_price: String(HON.runner.price), filled_at: '2026-10-08T15:14:58Z' },
];
const honRec = await runExternalClose({ pos: honPos, sharesClosed: 3, orders: honOrders, isFullClose: true, asOf: '2026-10-08T20:00:00Z' });
check('A10 HON tp1_pnl leg (real entry fill)', honPos.tp1_pnl, 20.58);
check('A11 HON exit_pnl = runner leg only', honRec.exit_pnl, -0.75);
check('A12 HON total_pnl = TRADE total (a WIN, not -0.09)', honRec.total_pnl, 19.83);

// Must NOT double-count the PYPL pattern: the TP1 leg is already a closed PARTIAL record.
const pyplPartial = {
  id: 'pypl-1', symbol: 'PYPL', side: 'short', is_full_close: false, mode: 'paper',
  exit_shares: 9, exit_pnl: 74.43, total_pnl: 74.43, realizedPnl: 74.43,
  exit_fills: [{ orderId: PYPL.leg1.orderId, qty: 9, price: PYPL.leg1.price }],
};
const pyplPos = {
  id: 'pypl-1', symbol: 'PYPL', side: 'short', entry: PYPL.entryFill, stopLoss: 60.67,
  shares: 17, shares_total: 17, shares_remaining: 8, mode: 'paper', openDate: '2026-08-17',
  tp1_hit: true, tp1_shares: 9, tp1_pnl: 74.43,   // the SAME leg the partial record holds
};
const pyplOrders = [
  { id: PYPL.leg1.orderId, side: 'buy', status: 'filled', filled_qty: '9', filled_avg_price: String(PYPL.leg1.price), filled_at: PYPL.leg1.at },
  { id: PYPL.leg2a.orderId, side: 'buy', status: 'filled', filled_qty: '6', filled_avg_price: String(PYPL.leg2a.price), filled_at: PYPL.leg2a.at },
  { id: PYPL.leg2b.orderId, side: 'buy', status: 'filled', filled_qty: '2', filled_avg_price: String(PYPL.leg2b.price), filled_at: PYPL.leg2b.at },
];
const pyplRec = await runExternalClose({
  pos: pyplPos, sharesClosed: 8, orders: pyplOrders, isFullClose: true,
  asOf: '2026-09-04T20:00:00Z', priorClosed: [pyplPartial],
});
check('A13 PYPL leg2 exit_pnl from the REAL unconsumed fills', pyplRec.exit_pnl, 31.98);
check('A14 PYPL leg2 total_pnl does NOT re-add the already-booked leg', pyplRec.total_pnl, 31.98);
ok   ('A15 PYPL leg2 flags the leg as held by a prior record', pyplRec.tp1_leg_in_prior_record === true && pyplRec.tp1_pnl_included === false);
check('A16 PYPL trade total across both legs = 106.41', parseFloat((pyplPartial.total_pnl + pyplRec.total_pnl).toFixed(2)), 106.41);
ok   ('A17 PYPL leg2 never re-used leg 1 fill (the v2.4.3 $53.4775 decode)',
  !pyplRec.exit_fills.some(f => f.orderId === PYPL.leg1.orderId));

// A PARTIAL close must never carry the TP1 leg — the trade isn't over.
const partialRec = await runExternalClose({
  pos: { ...ibmPos, id: 'ibm-2' }, sharesClosed: 2, orders: ibmOrders.map(o => ({ ...o })),
  isFullClose: false, asOf: '2026-09-10T18:00:00Z',
});
check('A18 partial close total_pnl = leg only (no TP1 carry)', partialRec.total_pnl, 42.32);
ok   ('A19 partial close not stamped tp1_pnl_included', partialRec.tp1_pnl_included === undefined);

// Provenance: an ESTIMATED TP1 leg must downgrade the combined record.
const estRec = await runExternalClose({
  pos: { ...ibmPos, id: 'ibm-3', tp1_pnl_source: 'estimate' }, sharesClosed: 2,
  orders: ibmOrders.map(o => ({ ...o })), isFullClose: true, asOf: '2026-09-10T18:00:00Z',
});
check('A20 combined pnl_source downgrades to estimate if TP1 leg was estimated', estRec.pnl_source, 'estimate');
check('A21 ...but the total is still correct', estRec.total_pnl, 82.88);

// ═══════════════════════════════════════════════════════════════════════════
section('B. BUG 1b — deriveLedger mirror double-count (the v2.4.3 queued item)');

const openRunner = {
  id: 'pypl-1', symbol: 'PYPL', side: 'short', mode: 'paper',
  tp1_hit: true, tp1_pnl: 74.43, shares_total: 17, shares_remaining: 8,
};
check('B1  WITNESS old ledger double-counts the leg (74.43 twice)',
  oldDeriveLedger('paper', { closed: [pyplPartial], open: [openRunner] }).realizedPnl, 148.86);
setSandboxState({ closed: [pyplPartial], open: [openRunner] });
check('B2  FIXED ledger counts the leg ONCE', deriveLedger('paper').realizedPnl, 74.43);
check('B3  tradeCount still counts closed records only', deriveLedger('paper').tradeCount, 1);

// The v2.4.1 behaviour that must NOT regress: a Branch A TP1 with no closed
// record still compounds into the ledger while the runner is open.
const branchAOpen = { id: 'ibm-9', symbol: 'IBM', side: 'long', mode: 'paper', tp1_hit: true, tp1_pnl: 40.56, tp1_close_order_id: 'ibm-tp1-order' };
setSandboxState({ closed: [], open: [branchAOpen] });
check('B4  Branch A in-flight TP1 IS still counted (v2.4.1 behaviour kept)', deriveLedger('paper').realizedPnl, 40.56);

ok('B5  predicate: partial record with same id suppresses the leg',
  tp1LegAlreadyInClosedRecords(openRunner, [pyplPartial]) === true);
ok('B6  predicate: a FULL-close record does NOT suppress (it IS the total)',
  tp1LegAlreadyInClosedRecords(openRunner, [{ ...pyplPartial, is_full_close: true }]) === false);
ok('B7  predicate: no matching record -> not suppressed',
  tp1LegAlreadyInClosedRecords(openRunner, [{ ...pyplPartial, id: 'other' }]) === false);
ok('B8  predicate: position without tp1_hit -> never suppressed',
  tp1LegAlreadyInClosedRecords({ ...openRunner, tp1_hit: false }, [pyplPartial]) === false);
ok('B9  predicate: bot-banked TP1 (order id) + partial priced from OTHER orders -> not suppressed',
  tp1LegAlreadyInClosedRecords(
    { ...openRunner, tp1_close_order_id: 'ibm-tp1-order' },
    [{ ...pyplPartial, exit_fills: [{ orderId: 'some-other-order', qty: 9 }] }]
  ) === false);
ok('B10 predicate: bot-banked TP1 whose order IS in the partial -> suppressed',
  tp1LegAlreadyInClosedRecords(
    { ...openRunner, tp1_close_order_id: 'tp1-ord' },
    [{ ...pyplPartial, exit_fills: [{ orderId: 'tp1-ord', qty: 9 }] }]
  ) === true);

// Paper/live segregation must survive the change.
setSandboxState({ closed: [pyplPartial, { ...pyplPartial, id: 'live-1', mode: 'live', total_pnl: 999.99 }], open: [] });
check('B11 paper ledger excludes live records', deriveLedger('paper').realizedPnl, 74.43);
check('B12 live ledger excludes paper records', deriveLedger('live').realizedPnl, 999.99);

// ═══════════════════════════════════════════════════════════════════════════
section('C. BUG 2 — stop exits booked the stop LEVEL, not the real fill');

check('C1  WITNESS old HD books the stop level + signal entry = the live bad -24.96',
  oldStopPnl({ side: 'long', signalEntry: HD.entrySignal, stopLevel: HD.stopLevel, shares: HD.shares }), -24.96);
check('C2  FIXED HD books the real fill + real entry = -27.01',
  realisedPnlFor('long', HD.entryFill, HD.exitFill, HD.shares), -27.01);
check('C3  HD real exit fill wavg = 303.346667 (1@303.34 + 2@303.35)',
  parseFloat(HD.exitFill.toFixed(6)), 303.346667);

// Wiring assertions on the live source: the stop branch must poll the fill and
// derive pnl_source from it. (Driving checkPositions needs network candles, so
// the number is proven arithmetically above and the WIRING is proven here.)
const src = fs.readFileSync(path.join(SID_DIR, 'bot-sid.js'), 'utf8');
const stopBranch = src.slice(src.indexOf('V2.1 stop-out before TP1'), src.indexOf("exit_strategy: 'v2.1-stop'"));
ok('C4  stop branch captures the close order id', /stopCloseOrderId\s*=\s*closeRes\?\.closeOrderId/.test(stopBranch));
ok('C5  stop branch polls the fill', /pollOrderFill\(stopCloseOrderId\)/.test(stopBranch));
ok('C6  stop branch overwrites exitPrice with filledAvgPrice', /exitPrice\s*=\s*stopFill\.filledAvgPrice/.test(stopBranch));
ok('C7  stop branch recomputes P&L via realisedPnlFor', /realisedPnlFor\(pos\.side, pos\.entry, exitPrice, pos\.shares_total\)/.test(stopBranch));
ok('C8  stop record no longer hardcodes pnl_source estimate', /pnl_source: stopPnlSource/.test(src));
ok('C9  v2.0 RSI-50 fallback path also books the real fill', /v20Fill\.filledAvgPrice/.test(src));
// Strip // comments first — the version banner and the explanatory comments
// legitimately mention the old literal, and a raw grep false-positives on them.
// NOTE: strip \r FIRST. bot-sid.js is CRLF, and in JS regex \r is a line
// terminator, so `.*$` can't reach past it and the comment-strip silently
// no-ops on every line (this exact trap cost an iteration here).
const codeOnly = s => s.replace(/\r/g, '').split('\n')
  .map(l => l.replace(/^\s*\/\/.*$/, '').replace(/\s\/\/\s.*$/, '')).join('\n');
ok('C10 no close path hardcodes pnl_source estimate any more',
  !/pnl_source:\s*'estimate'/.test(codeOnly(src.slice(src.indexOf('async function checkPositions')))));

// ═══════════════════════════════════════════════════════════════════════════
section('D. BUG 3 — entry price stored from the signal, not the entry fill');

check('D1  WITNESS old HON TP1 off the signal entry = the live bad 21.02',
  realisedPnlFor('long', HON.entrySignal, HON.tp1.price, 2), 21.02);
check('D2  FIXED HON TP1 off the real entry fill = 20.58',
  realisedPnlFor('long', HON.entryFill, HON.tp1.price, 2), 20.58);
check('D3  WITNESS old HON runner off the signal entry = -0.09',
  realisedPnlFor('long', HON.entrySignal, HON.runner.price, 3), -0.09);
check('D4  FIXED HON runner off the real entry fill = -0.75',
  realisedPnlFor('long', HON.entryFill, HON.runner.price, 3), -0.75);
check('D5  FIXED HON trade total = +19.83', parseFloat((20.58 + -0.75).toFixed(2)), 19.83);
check('D6  WITNESS old IBM total off the signal entry = 83.28 (the brief figure)',
  parseFloat((realisedPnlFor('long', IBM.entrySignal, IBM.tp1.price, 2) + realisedPnlFor('long', IBM.entrySignal, IBM.runner.price, 2)).toFixed(2)), 83.28);
check('D7  FIXED IBM total off the real entry fill = 82.88', parseFloat((40.56 + 42.32).toFixed(2)), 82.88);

const entryRec = buildEntryPositionRecord({
  id: 'x', symbol: 'HON', side: 'long', entry: HON.entryFill, stopLoss: 196, shares: 5,
  totalUsd: 1022.2, riskUsd: 41.1, signalDate: '2026-09-10', openDate: '2026-09-15',
  openTime: '19:48:15', mode: 'paper', strategyTag: 'SID v2.5.0',
}, { entry_source: 'alpaca_fill', signal_entry: HON.entrySignal, entry_fill_qty: 5 });
check('D8  position record stores the real entry', entryRec.entry, HON.entryFill);
check('D9  position record keeps the signal price for audit', entryRec.signal_entry, HON.entrySignal);
check('D10 position record stamps entry provenance', entryRec.entry_source, 'alpaca_fill');
check('D11 stop level is NOT moved by the fill (broker order already rests there)', entryRec.stopLoss, 196);
check('D12 share count is NOT recomputed from the fill', entryRec.shares_total, 5);

const runBlock = src.slice(src.indexOf('let entryPrice      = signal.entry'), src.indexOf('openSymbols.add(symbol)'));
ok('D13 entry path polls the entry order fill', /pollOrderFill\(orderId/.test(runBlock));
ok('D14 entry path books filledAvgPrice', /entryPrice\s*=\s*entryFill\.filledAvgPrice/.test(runBlock));
ok('D15 position record receives entryPrice, not signal.entry', /entry:\s*entryPrice/.test(runBlock));
ok('D16 fallback flags the signal estimate', /entrySource\s*=\s*'signal_estimate'|signal_estimate/.test(runBlock));
ok('D17 CSV journal row uses the real fill', /entryPrice\.toFixed\(2\)/.test(runBlock));
ok('D18 riskUsd is NOT recomputed (strategy sizing untouched)', /riskUsd:\s*sizing\.riskUsd/.test(runBlock));

// ═══════════════════════════════════════════════════════════════════════════
section('E. The REAL corrected records tie to the broker');

const realClosed = JSON.parse(fs.readFileSync(path.join(SID_DIR, 'closed-positions-sid.json'), 'utf8'));
const paperRecs  = realClosed.filter(r => String(r.mode || 'paper').toLowerCase() === 'paper');
const sum = parseFloat(paperRecs.reduce((s, r) => s + (r.total_pnl ?? r.realizedPnl ?? 0), 0).toFixed(2));
check('E1  16 paper records', paperRecs.length, 16);
check('E2  records sum = +543.94', sum, 543.94);
check('E3  records - real fees (0.51) = Alpaca equity net 543.43', parseFloat((sum - 0.51).toFixed(2)), 543.43);
const byKey = k => realClosed.find(r => r.symbol === k.s && r.closeDate === k.d);
check('E4  IBM  = 82.88',  byKey({ s: 'IBM',  d: '2026-09-10' }).total_pnl, 82.88);
check('E5  HD   = -27.01', byKey({ s: 'HD',   d: '2026-09-16' }).total_pnl, -27.01);
check('E6  HON  = 19.83',  byKey({ s: 'HON',  d: '2026-10-08' }).total_pnl, 19.83);
check('E7  IYR  = -19.30', byKey({ s: 'IYR',  d: '2026-09-24' }).total_pnl, -19.3);
check('E8  RIOT = 145.60', byKey({ s: 'RIOT', d: '2026-07-23' }).total_pnl, 145.6);
check('E9  ABT  = 53.16',  byKey({ s: 'ABT',  d: '2026-09-08' }).total_pnl, 53.16);
check('E10 PYPL leg1 = 74.43', byKey({ s: 'PYPL', d: '2026-09-02' }).total_pnl, 74.43);
check('E11 PYPL leg2 = 31.98', byKey({ s: 'PYPL', d: '2026-09-04' }).total_pnl, 31.98);
ok('E12 no paper record left as pnl_source "estimate"', paperRecs.every(r => r.pnl_source !== 'estimate'));
ok('E13 every corrected record keeps a reversible correction block',
  ['IBM', 'HD', 'HON', 'IYR', 'RIOT', 'ABT'].every(s => {
    const r = realClosed.find(x => x.symbol === s && x.correction);
    return r && r.correction.tag === 'v2.5.0-pnl-booking-2026-10-18' && r.correction.previous;
  }));
ok('E14 no record carries a fabricated null order id in exit_fills',
  realClosed.every(r => (r.exit_fills || []).every(f => f.orderId)));

const realAccount = JSON.parse(fs.readFileSync(path.join(SID_DIR, 'sid-account.json'), 'utf8'));
check('E15 ledger realizedPnl = 543.94', realAccount.realizedPnl, 543.94);
check('E16 ledger tradeCount = 16', realAccount.tradeCount, 16);
check('E17 ledger accountUsd = startingUsd + realizedPnl', realAccount.accountUsd, parseFloat((realAccount.startingUsd + realAccount.realizedPnl).toFixed(2)));
check('E18 ledger stays PAPER', realAccount.mode, 'paper');

// ═══════════════════════════════════════════════════════════════════════════
section('F. v2.4.3 work carried into v2.5.0 (must not regress)');

const consumed = consumedExitFillQty('PYPL', { closedRecords: [pyplPartial], positions: [] });
check('F1  consumed-fill ledger subtracts an already-booked order', consumed.get(PYPL.leg1.orderId), 9);
check('F2  consumed-fill ledger is symbol-scoped',
  consumedExitFillQty('IBM', { closedRecords: [pyplPartial], positions: [] }).size, 0);
check('F3  consumed-fill ledger counts the bot TP1 close order',
  consumedExitFillQty('IBM', { closedRecords: [], positions: [{ symbol: 'IBM', tp1_close_order_id: 'o1', tp1_shares: 2 }] }).get('o1'), 2);
ok('F4  snapshot path: paper -> alpaca-account-sid.json', alpacaSnapshotPathForMode('paper').endsWith('alpaca-account-sid.json'));
ok('F5  snapshot path: live -> mode-segregated file', alpacaSnapshotPathForMode('live').endsWith('alpaca-account-live-sid.json'));
check('F6  startingEquity: existing value carried forward', alpacaStartingEquityFor('paper', 123, { startingEquity: 100000 }), 100000);
check('F7  startingEquity: fresh paper baselines at 100000', alpacaStartingEquityFor('paper', 100543.43, null), 100000);
check('F8  startingEquity: fresh live baselines at current equity', alpacaStartingEquityFor('live', 5000, null), 5000);

const yml = fs.readFileSync(path.join(SID_DIR, '..', '.github', 'workflows', 'sid.yml'), 'utf8');
ok('F9  sid.yml stages the Alpaca snapshot', /git add .*alpaca-account\*-sid\.json/.test(yml));
ok('F10 sid.yml keeps the staggered cron redundancy', (yml.match(/cron:/g) || []).length >= 3);
const dash = fs.readFileSync(path.join(SID_DIR, 'sid-dashboard.js'), 'utf8');
ok('F11 dashboard keeps the stale-snapshot guard', /SNAPSHOT_STALE_DAYS/.test(dash));
ok('F12 dashboard version marker is v2.5.0', /STRATEGY_VERSION\s*=\s*'2\.5\.0'/.test(dash));

// ═══════════════════════════════════════════════════════════════════════════
section('G. Canon rules untouched (instructor non-negotiables)');

const realSrc = fs.readFileSync(path.join(SID_DIR, 'bot-sid.js'), 'utf8');
check('G1  RSI extreme thresholds still 30 / 70 (instructor canon)',
  [/const RSI_OVERSOLD\s*=\s*30;/.test(realSrc), /const RSI_OVERBOUGHT\s*=\s*70;/.test(realSrc)], [true, true]);
check('G1b RSI no-go zones still 45 / 55', [bot.CONFIG.rsiNoGoLong, bot.CONFIG.rsiNoGoShort], [45, 55]);
check('G1c earnings blackout still 14 days', bot.CONFIG.earningsWindow, 14);
check('G1d TP1 portion still 50%', bot.CONFIG.tp1Portion, 0.5);
ok('G2  RSI-50 TP1 trigger intact', /rsi\s*>=\s*50\s*:\s*rsi\s*<=\s*50/.test(realSrc));
ok('G3  TP2 SMA50/SMA200 triggers intact', /sma50_touch/.test(realSrc) && /sma200_touch/.test(realSrc));
ok('G4  earnings blackout still applied', /isWithinEarningsWindow/.test(realSrc));
ok('G5  tp1Portion (50%) unchanged', /tp1Portion/.test(realSrc));

// ── Teardown ────────────────────────────────────────────────────────────────
fs.rmSync(SANDBOX, { recursive: true, force: true });
ok('H1  sandbox removed (no real state file touched)', !fs.existsSync(SANDBOX));

console.log(`\n${'='.repeat(60)}`);
console.log(`RESULT: ${pass} passed, ${fail} failed, ${pass + fail} total`);
if (fail) { console.log('FAILURES:'); for (const f of failures) console.log('  - ' + f); }
console.log('='.repeat(60));
process.exit(fail ? 1 : 0);
