/**
 * SID v2.6.0 — QUEUE-FOR-OPEN EXITS + RAILWAY CRON RUNNER: REGRESSION SUITE
 * =========================================================================
 *
 * The bug this release fixes (2026-09-09, IBM): TP2 (SMA50 touch) ripened in the
 * last ~35 minutes of the session; the next run landed 21:06 UTC, an hour after
 * the close, swept the resting stop, then hit
 *   `Market closed — refusing to submit close for IBM`
 * and gave up until the next run. Alan then did it by hand: cancel the stop,
 * queue a market sell, filled at the next open (2 @ $238.39).
 *
 * REGRESSION WITNESS (group W): the pre-v2.6.0 code path is driven on the same
 * inputs and must reproduce that exact refusal, BEFORE the new path is asserted
 * to queue the exit instead. A test that only asserts the new behaviour cannot
 * tell you the bug was ever real.
 *
 * Most of this suite drives the REAL exported functions against a REAL
 * AlpacaExecutor wrapping a mock client, so the real sweep / cancel / wait /
 * submit / poll code executes — not a re-implementation of it.
 *
 * NO NETWORK. NO BROKER CALLS. State-writing functions run inside a throwaway
 * copy of the module tree (SID/_v260_sandbox/) so no real state file is ever
 * touched; the sandbox is removed on exit (test Z1 asserts it). State paths
 * anchor to each module's own __dirname, which is what makes the sandbox work.
 *
 *   node tests/v2.6.0-queue-for-open.test.mjs
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
const SANDBOX   = path.join(SID_DIR, '_v260_sandbox');

let pass = 0, fail = 0;
const failures = [];
function check(name, got, want, tol = 0) {
  const ok_ = (typeof want === 'number' && typeof got === 'number' && tol > 0)
    ? Math.abs(got - want) <= tol
    : JSON.stringify(got) === JSON.stringify(want);
  if (ok_) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; failures.push(name); console.log(`  [FAIL] ${name}\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`); }
}
function ok(name, cond) { check(name, !!cond, true); }
function section(t) { console.log(`\n== ${t} ==`); }
function pathToUrl(p) { return 'file:///' + p.replace(/\\/g, '/'); }

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
  resetSandboxState();
}
function resetSandboxState() {
  fs.writeFileSync(path.join(SANDBOX, 'open-positions-sid.json'), '[]');
  fs.writeFileSync(path.join(SANDBOX, 'closed-positions-sid.json'), '[]');
  fs.writeFileSync(path.join(SANDBOX, 'sid-account.json'), JSON.stringify({
    accountUsd: 10000, startingUsd: 10000, realizedPnl: 0, tradeCount: 0, mode: 'paper',
  }, null, 2));
  fs.writeFileSync(path.join(SANDBOX, 'sid-log.json'), '[]');
  fs.writeFileSync(path.join(SANDBOX, 'trades-sid.csv'),
    'Date,Time,Exchange,Symbol,Side,Shares,Entry Price,Stop Loss,Total USD,Risk USD,Risk %,Signal Date,Order ID,Mode,Strategy\n');
}
const sbRead  = f => JSON.parse(fs.readFileSync(path.join(SANDBOX, f), 'utf8'));
const sbWrite = (f, v) => fs.writeFileSync(path.join(SANDBOX, f), JSON.stringify(v, null, 2));
const sbText  = f => fs.readFileSync(path.join(SANDBOX, f), 'utf8');

makeSandbox();
const bot  = await import(pathToUrl(path.join(SANDBOX, 'bot-sid.js')));
const exec = await import(pathToUrl(path.join(SANDBOX, 'alpaca-executor.js')));

const {
  exitClientOrderId, exitTagFor, marketIsOpen, shouldQueueExitForOpen,
  queueExitForOpen, reconcilePendingExits, PENDING_EXIT_DEAD_STATES,
  realisedPnlFor, BOT_VERSION, CONFIG,
} = bot;
const { AlpacaExecutor } = exec;

// ── Mock Alpaca client ──────────────────────────────────────────────────────
// Enforces the two broker behaviours the design depends on:
//   (a) client_order_id uniqueness (the double-sell guard)
//   (b) an open order HOLDS the shares, so a submit with orders still resting is
//       rejected `insufficient qty available` — the v2.2.5/2.2.6/v2.4.2 trap
function makeMockClient({ open = [], activities = [], holdShares = true, rejectTifs = [] } = {}) {
  const st = {
    open: open.map(o => ({ ...o })),
    byId: new Map(),
    activities: activities.slice(),
    submitted: [],
    cancelled: [],
    clientIds: new Set(),
    listOrdersCalls: 0,
  };
  for (const o of st.open) st.byId.set(o.id, o);
  for (const o of open) if (o.client_order_id) st.clientIds.add(o.client_order_id);

  const client = {
    st,
    async listOrders({ status, symbols } = {}) {
      st.listOrdersCalls++;
      return st.open.filter(o =>
        (!symbols || o.symbol === symbols) &&
        (status !== 'open' || o.status === 'open' || o.status === 'new' || o.status === 'accepted'));
    },
    async cancelOrder(id) {
      const o = st.byId.get(id);
      if (!o) { const e = new Error('order not found'); e.status = 404; throw e; }
      o.status = 'canceled';
      st.open = st.open.filter(x => x.id !== id);
      st.cancelled.push(id);
      return o;
    },
    async submitOrder(o) {
      if (o.client_order_id && st.clientIds.has(o.client_order_id)) {
        const e = new Error('client_order_id must be unique');
        e.status = 422;
        throw e;
      }
      if (rejectTifs.includes(o.time_in_force)) {
        const e = new Error(`${o.time_in_force} orders are not accepted at this time`);
        e.status = 422;
        throw e;
      }
      if (holdShares && st.open.some(x => x.symbol === o.symbol)) {
        const e = new Error(`insufficient qty available for order (requested: ${o.qty}, available: 0)`);
        e.status = 403;
        throw e;
      }
      const rec = {
        ...o,
        id: `mock-${st.submitted.length + 1}-${o.time_in_force}`,
        status: o.time_in_force === 'gtc' ? 'open' : 'accepted',
        filled_qty: '0',
        filled_avg_price: null,
        submitted_at: '2026-09-09T21:06:12Z',
      };
      if (o.client_order_id) st.clientIds.add(o.client_order_id);
      st.byId.set(rec.id, rec);
      st.submitted.push(rec);
      if (rec.status === 'open') st.open.push(rec);
      return rec;
    },
    async getOrder(id) {
      const o = st.byId.get(id);
      if (!o) { const e = new Error('order not found'); e.status = 404; throw e; }
      return o;
    },
    async getActivities() { return st.activities; },
  };
  return client;
}

/** Real executor + mock client. `etStamp` drives etMinutesOfDay via the BROKER clock. */
function makeExecutor(client, { isOpen = false, etStamp = '2026-09-09T17:06:12.000000000-04:00' } = {}) {
  const e = new AlpacaExecutor({ mode: 'paper', client, log: { log() {}, error() {}, warn() {} } });
  e.clock   = { is_open: isOpen, timestamp: etStamp, next_open: '2026-09-10T09:30:00-04:00', next_close: '2026-09-10T16:00:00-04:00' };
  e.account = { equity: '100543.43', buying_power: '200000', cash: '100000' };
  return e;
}

// ── The REAL live IBM trade this release is named after ─────────────────────
const IBM_RUNNER = () => ({
  id: 'ibm-pos-1', symbol: 'IBM', side: 'long',
  entry: 217.23, stopLoss: 217.24, orig_stop: 213.0,
  shares: 4, shares_total: 4, shares_remaining: 2,
  tp1_hit: true, tp1_date: '2026-09-02', tp1_price: 237.51, tp1_shares: 2,
  tp1_pnl: 40.56, tp1_reason: 'rsi50', tp1_pnl_source: 'alpaca_fill',
  tp1_close_order_id: 'ibm-tp1-order',
  totalUsd: 868.92, riskUsd: 100, signalDate: '2026-08-14',
  openDate: '2026-08-15', mode: 'paper', strategy: 'SID v2.5.0',
  brokerStopOrderId: 'ibm-be-stop', clientOrderIdPrefix: 'SID-IBM-20260814-long',
});
const IBM_BE_STOP = {
  id: 'ibm-be-stop', symbol: 'IBM', status: 'open', side: 'sell', qty: '2',
  client_order_id: 'SID-IBM-20260814-long-stop-1757000000000', type: 'stop',
};

// ═══════════════════════════════════════════════════════════════════════════
section('V. Version + canon');

check('V1  bot reports v2.6.0', BOT_VERSION, 'v2.6.0');
check('V2  queue-for-open defaults ON', CONFIG.queueExitsForOpen, true);
check('V3  weekend exit queue defaults ON', CONFIG.weekendExitQueue, true);
check('V4  exits-only defaults OFF (a normal run still scans for entries)', CONFIG.exitsOnly, false);

const realSrc = fs.readFileSync(path.join(SID_DIR, 'bot-sid.js'), 'utf8');
const execSrc = fs.readFileSync(path.join(SID_DIR, 'alpaca-executor.js'), 'utf8');

check('V5  RSI extreme thresholds still 30 / 70 (instructor canon)',
  [/const RSI_OVERSOLD\s*=\s*30;/.test(realSrc), /const RSI_OVERBOUGHT\s*=\s*70;/.test(realSrc)], [true, true]);
check('V6  RSI no-go zones still 45 / 55', [CONFIG.rsiNoGoLong, CONFIG.rsiNoGoShort], [45, 55]);
check('V7  earnings blackout still 14 days', CONFIG.earningsWindow, 14);
check('V8  TP1 portion still 50%', CONFIG.tp1Portion, 0.5);
check('V9  TP2 timeout still 30 trading days', CONFIG.tp2TimeoutDays, 30);
ok('V10 RSI-50 TP1 trigger intact', /rsi\s*>=\s*50\s*:\s*rsi\s*<=\s*50/.test(realSrc));
ok('V11 TP2 SMA50/SMA200 triggers intact', /sma50_touch/.test(realSrc) && /sma200_touch/.test(realSrc));
ok('V12 earnings blackout still applied in run()', /isWithinEarningsWindow/.test(realSrc));
ok('V13 MACD alignment still computed', /calcMACD/.test(realSrc));
check('V14 AUTO tier is still 80 tickers',
  (realSrc.match(/const AUTO_APPROVED_TICKERS = new Set\(\[([\s\S]*?)\]\)/)[1].match(/'/g).length) / 2, 80);

// ═══════════════════════════════════════════════════════════════════════════
section('W. REGRESSION WITNESS — the pre-v2.6.0 path reproduces the live failure');

{
  const client = makeMockClient({ open: [IBM_BE_STOP] });
  const ex = makeExecutor(client, { isOpen: false });
  let caught = null;
  try { await ex.closePosition(IBM_RUNNER(), 'V2.1 TP2 (sma50_touch) on 2026-09-09'); }
  catch (err) { caught = err.message; }
  // The exact string from the live 2026-09-09 21:06 UTC run.
  check('W1  WITNESS pre-v2.6.0 closePosition refuses with the live message', caught,
    'Market closed — refusing to submit close for IBM');
  ok('W2  WITNESS and it submitted NOTHING — the exit was simply lost for the day',
    client.st.submitted.length === 0);
  // The new decision function would have routed AWAY from that call.
  ok('W3  v2.6.0 would have taken the queue path on that same closed-market run',
    shouldQueueExitForOpen(ex) === true);
}

// ═══════════════════════════════════════════════════════════════════════════
section('A. Deterministic exit client_order_id (the broker-level double-sell guard)');

check('A1  id is stable for (symbol, tag, date)',
  exitClientOrderId('IBM', 'tp2', '20261026'), 'SID-IBM-tp2-20261026');
ok('A2  id is DETERMINISTIC — two independent computations collide (that is the point)',
  exitClientOrderId('IBM', 'tp2', '20261026') === exitClientOrderId('IBM', 'tp2', '20261026'));
ok('A3  a different exit kind on the same day does NOT collide',
  exitClientOrderId('IBM', 'tp1', '20261026') !== exitClientOrderId('IBM', 'tp2', '20261026'));
ok('A4  a different day does NOT collide (one legitimate re-queue per day)',
  exitClientOrderId('IBM', 'tp2', '20261027') !== exitClientOrderId('IBM', 'tp2', '20261026'));
ok('A5  a different symbol does NOT collide',
  exitClientOrderId('HON', 'tp2', '20261026') !== exitClientOrderId('IBM', 'tp2', '20261026'));
check('A6  a retry attempt gets a fresh id (a rejected order keeps its id at Alpaca)',
  exitClientOrderId('IBM', 'tp2', '20261026', 2), 'SID-IBM-tp2-20261026-a2');
ok('A7  but the retry id is STILL deterministic (attempt lives in committed state)',
  exitClientOrderId('IBM', 'tp2', '20261026', 2) === exitClientOrderId('IBM', 'tp2', '20261026', 2));
ok('A8  no timestamp / randomness anywhere in the id',
  !/\d{13}/.test(exitClientOrderId('IBM', 'tp2', '20261026')));
ok('A9  id stays inside Alpaca\'s client_order_id limit even for a long symbol',
  exitClientOrderId('GOOGL', 'tp2', '20261026', 99).length <= 48);
check('A10 every v2.6.0 exit reason maps to a tag',
  ['tp1_rsi50', 'tp2_sma50_touch', 'tp2_sma200_touch', 'tp2_breakeven_stop', 'tp2_timeout', 'stop', 'v20_rsi50']
    .map(exitTagFor),
  ['tp1', 'tp2', 'tp2', 'tp2', 'tp2', 'stp', 'r50']);

// ═══════════════════════════════════════════════════════════════════════════
section('B. The clock gate — DST-correct, and the documented OPG dead zone');

{
  const mk = stamp => makeExecutor(makeMockClient(), { isOpen: false, etStamp: stamp });

  // Alpaca docs: OPG is REJECTED between 09:28 and 19:00 ET; after 19:00 it is
  // queued to the following day's opening auction.
  check('B1  17:06 ET (= the 21:06 UTC IBM run, EDT) is in the OPG dead zone -> day',
    mk('2026-09-09T17:06:12.000000000-04:00').queuedExitTif(1), 'day');
  check('B2  19:30 ET -> opg (queued to the next opening auction)',
    mk('2026-09-09T19:30:00.000000000-04:00').queuedExitTif(1), 'opg');
  check('B3  08:00 ET pre-open -> opg (today\'s opening auction)',
    mk('2026-09-10T08:00:00.000000000-04:00').queuedExitTif(1), 'opg');
  check('B4  09:28 ET exactly -> day (the cutoff is inclusive of the reject window)',
    mk('2026-09-10T09:28:00.000000000-04:00').queuedExitTif(1), 'day');
  check('B5  09:27 ET -> opg (still inside the pre-open window)',
    mk('2026-09-10T09:27:59.000000000-04:00').queuedExitTif(1), 'opg');
  check('B6  19:00 ET exactly -> opg', mk('2026-09-09T19:00:00.000000000-04:00').queuedExitTif(1), 'opg');

  // DST: the SAME UTC instant is a different ET wall clock in EST vs EDT, and the
  // broker's own offset is what resolves it. 22:06 UTC in January is 17:06 EST.
  check('B7  DST — EDT stamp (-04:00) 17:06 reads as 17:06 ET',
    mk('2026-09-09T17:06:00.000000000-04:00').etMinutesOfDay(), 17 * 60 + 6);
  check('B8  DST — EST stamp (-05:00) 17:06 also reads as 17:06 ET (offset moves, digits are ET)',
    mk('2026-01-14T17:06:00.000000000-05:00').etMinutesOfDay(), 17 * 60 + 6);
  check('B9  DST — an EST evening (19:30 -05:00) still picks opg',
    mk('2026-01-14T19:30:00.000000000-05:00').queuedExitTif(1), 'opg');
  check('B10 DST — an EST mid-afternoon (16:30 -05:00) still picks day',
    mk('2026-01-14T16:30:00.000000000-05:00').queuedExitTif(1), 'day');

  // A UTC ('Z') or non-ET timestamp must NOT be read as ET digits.
  check('B11 a Z (UTC) timestamp is refused rather than misread as ET',
    mk('2026-09-09T21:06:00Z').etMinutesOfDay(), null);
  check('B12 ...and the unknown-clock fallback is the broader-window tif',
    mk('2026-09-09T21:06:00Z').queuedExitTif(1), 'day');
  check('B13 a missing clock is refused too', makeExecutor(makeMockClient()).etMinutesOfDay({}), null);

  // Retries alternate so a wrong guess self-corrects on the next cycle.
  const e = mk('2026-09-09T17:06:12.000000000-04:00');
  check('B14 retries alternate the tif (attempt 1/2/3/4)',
    [1, 2, 3, 4].map(n => e.queuedExitTif(n)), ['day', 'opg', 'day', 'opg']);

  // The gate itself.
  ok('B15 market OPEN -> do NOT queue, close immediately',
    shouldQueueExitForOpen(makeExecutor(makeMockClient(), { isOpen: true })) === false);
  ok('B16 marketIsOpen reads the BROKER clock, and a missing clock is "not open"',
    marketIsOpen(makeExecutor(makeMockClient(), { isOpen: true })) === true &&
    marketIsOpen({}) === false && marketIsOpen(null) === false);
  ok('B17 no executor (dry_run) -> never queues', shouldQueueExitForOpen(null) === false);
}

// ═══════════════════════════════════════════════════════════════════════════
section('C. A closed-market exit queues EXACTLY ONE order, after sweeping');

let queuedPos = null;
{
  const client = makeMockClient({ open: [IBM_BE_STOP] });
  const ex = makeExecutor(client, { isOpen: false, etStamp: '2026-09-09T19:30:00.000000000-04:00' });
  const pos = IBM_RUNNER();

  const res = await queueExitForOpen({
    pos, executor: ex, qty: 2, isFullClose: true, reason: 'tp2_sma50_touch',
    booking: { trigger_date: '2026-09-09', trigger_rsi: 61.2, estimate_price: 235.1, tp2_reason: 'sma50_touch', exit_level: 'sma50_touch', exit_strategy: 'v2.1-tp1+tp2' },
  });

  ok('C1  queued', res.queued === true);
  check('C2  EXACTLY ONE order submitted', client.st.submitted.length, 1);
  const o = client.st.submitted[0];
  check('C3  it is a MARKET order', o.type, 'market');
  check('C4  tif opg at 19:30 ET', o.time_in_force, 'opg');
  check('C5  correct exit side for a long', o.side, 'sell');
  check('C6  correct qty (the runner only)', o.qty, 2);
  check('C7  deterministic client_order_id', o.client_order_id, 'SID-IBM-tp2-20260909'.replace('20260909', bot.todayString().replace(/-/g, '')));
  ok('C8  the resting BE stop was SWEPT FIRST (shares cannot be freed otherwise)',
    client.st.cancelled.includes('ibm-be-stop'));
  ok('C9  the dead stop id is cleared off the record', pos.brokerStopOrderId === null);

  const pe = pos.pending_exit;
  ok('C10 pending_exit recorded', !!pe);
  check('C11 pending_exit carries the order id', pe.order_id, o.id);
  check('C12 ...the reason', pe.reason, 'tp2_sma50_touch');
  check('C13 ...the share count', pe.shares, 2);
  check('C14 ...kind=full for a TP2', pe.kind, 'full');
  check('C15 ...status queued', pe.status, 'queued');
  ok('C16 ...a queued timestamp', typeof pe.queued_at === 'string' && pe.queued_at.length > 10);
  check('C17 ...and the trigger data needed to book it', [pe.booking.trigger_date, pe.booking.trigger_rsi, pe.booking.tp2_reason],
    ['2026-09-09', 61.2, 'sma50_touch']);
  check('C18 attempt counter persisted on the position', pos.exit_queue_attempts, 1);
  queuedPos = pos;
}

// A TP1 partial must NOT book anything yet.
{
  const client = makeMockClient({ open: [{ ...IBM_BE_STOP, id: 'full-stop', qty: '4' }] });
  const ex = makeExecutor(client, { isOpen: false, etStamp: '2026-09-09T19:30:00.000000000-04:00' });
  const pos = { ...IBM_RUNNER(), tp1_hit: false, shares_remaining: 4, tp1_pnl: undefined, tp1_date: undefined, tp1_price: undefined, tp1_shares: undefined, brokerStopOrderId: 'full-stop', stopLoss: 213.0 };
  delete pos.tp1_close_order_id;
  const res = await queueExitForOpen({
    pos, executor: ex, qty: 2, isFullClose: false, reason: 'tp1_rsi50',
    booking: { trigger_date: '2026-09-09', trigger_rsi: 50.4, estimate_price: 237.5, be_price: 217.24, runner_shares: 2, tp1_reason: 'rsi50' },
  });
  ok('C19 TP1 partial queued', res.queued === true);
  check('C20 kind=partial', pos.pending_exit.kind, 'partial');
  ok('C21 tp1_hit STAYS FALSE — the shares are ordered, not sold', pos.tp1_hit === false);
  ok('C22 no TP1 P&L is booked at queue time', pos.tp1_pnl === undefined);
  check('C23 shares_remaining untouched until the fill', pos.shares_remaining, 4);
  check('C24 the BE price is carried for the reconcile to apply', pos.pending_exit.booking.be_price, 217.24);
  ok('C25 the TP1 client_order_id uses the tp1 tag', /-tp1-/.test(pos.pending_exit.client_order_id));
}

// ═══════════════════════════════════════════════════════════════════════════
section('D. Single-fire — a pending exit is never double-queued');

ok('D1  checkPositions SKIPS any position carrying a pending_exit (local guard)',
  /if \(pos\.pending_exit\?\.order_id\) \{[\s\S]{0,400}?stillOpen\.push\(pos\);\s*continue;/.test(realSrc));
ok('D2  ...and it skips BEFORE the candle fetch, so it costs nothing',
  realSrc.indexOf('if (pos.pending_exit?.order_id)') < realSrc.indexOf("candles = await fetchDailyCandles(pos.symbol, '2y')"));

{
  // The BROKER-level guard: two processes that both decide to queue the same exit
  // on the same day compute the SAME client_order_id, so Alpaca rejects the second.
  const client = makeMockClient({ open: [IBM_BE_STOP] });
  const exA = makeExecutor(client, { isOpen: false, etStamp: '2026-09-09T19:30:00.000000000-04:00' });
  const exB = makeExecutor(client, { isOpen: false, etStamp: '2026-09-09T19:30:30.000000000-04:00' });
  const posA = IBM_RUNNER();
  const posB = IBM_RUNNER();   // a SECOND runner reading the same (stale) committed state

  const a = await queueExitForOpen({ pos: posA, executor: exA, qty: 2, isFullClose: true, reason: 'tp2_sma50_touch', booking: {} });
  const b = await queueExitForOpen({ pos: posB, executor: exB, qty: 2, isFullClose: true, reason: 'tp2_sma50_touch', booking: {} });

  ok('D3  the first submission is accepted', a.queued === true);
  ok('D4  the CONCURRENT second is REJECTED BY THE BROKER as a duplicate', b.queued === false);
  ok('D5  ...with Alpaca\'s uniqueness error, not a local check',
    /client_order_id must be unique/.test(b.error || ''));
  const sells = client.st.submitted.filter(o => o.side === 'sell' && o.type === 'market');
  check('D6  so EXACTLY ONE market sell exists at the broker — no double-sell', sells.length, 1);
  ok('D7  the loser re-protects rather than leaving the position naked+unqueued',
    b.reprotected === true && !!posB.brokerStopOrderId);
  ok('D8  ...and does NOT stamp a pending_exit it does not own', !posB.pending_exit);
}

// ═══════════════════════════════════════════════════════════════════════════
section('E. Rejected submission falls back to today\'s behaviour');

{
  // Both tifs refused (e.g. a venue/holiday case we guessed wrong about).
  const client = makeMockClient({ open: [IBM_BE_STOP], rejectTifs: ['opg', 'day'] });
  const ex = makeExecutor(client, { isOpen: false, etStamp: '2026-09-09T19:30:00.000000000-04:00' });
  const pos = IBM_RUNNER();
  const res = await queueExitForOpen({ pos, executor: ex, qty: 2, isFullClose: true, reason: 'tp2_sma50_touch', booking: {} });
  ok('E1  not queued', res.queued === false);
  ok('E2  the position is RE-PROTECTED with a stop — never naked AND unqueued', res.reprotected === true);
  ok('E3  a fresh stop order id is on the record', typeof pos.brokerStopOrderId === 'string');
  ok('E4  no pending_exit is stamped for an order that does not exist', !pos.pending_exit);
  check('E5  the attempt counter advanced so the retry gets a fresh id', pos.exit_queue_attempts, 1);
  const stops = client.st.submitted.filter(o => o.type === 'stop');
  check('E6  exactly one protective stop was placed', stops.length, 1);
  check('E7  it covers the full remaining qty', stops[0].qty, 2);
}
{
  // A PDT-safe position must NOT get a broker stop on the fallback — that would
  // break the v2.4.0 PDT-immunity guarantee (a resting stop can fill same-day).
  const client = makeMockClient({ rejectTifs: ['opg', 'day'] });
  const ex = makeExecutor(client, { isOpen: false, etStamp: '2026-09-09T19:30:00.000000000-04:00' });
  const pos = { ...IBM_RUNNER(), pdt_safe: true, brokerStopOrderId: null, clientOrderIdPrefix: null };
  const res = await queueExitForOpen({ pos, executor: ex, qty: 2, isFullClose: true, reason: 'tp2_sma50_touch', booking: {} });
  ok('E8  PDT-safe: not queued', res.queued === false);
  ok('E9  PDT-safe: NO stop placed (PDT-immunity preserved)',
    client.st.submitted.filter(o => o.type === 'stop').length === 0 && res.reprotected === false);
  ok('E10 PDT-safe: brokerStopOrderId stays null', pos.brokerStopOrderId === null);
}

// ═══════════════════════════════════════════════════════════════════════════
section('F. Weighted real fill price (the v2.5.0 6dp-rounding pitfall)');

{
  // HD's real exit: 1 @ 303.34 + 2 @ 303.35 = 910.04/3. Alpaca's order-level
  // filled_avg_price shows the ROUNDED 303.346667.
  const order = {
    id: 'o-hd', filled_qty: '3', filled_avg_price: '303.346667',
    submitted_at: '2026-09-09T13:35:00Z', filled_at: '2026-09-10T13:30:02Z',
  };
  const acts = [
    { order_id: 'o-hd', qty: '1', price: '303.34', activity_type: 'FILL' },
    { order_id: 'o-hd', qty: '2', price: '303.35', activity_type: 'FILL' },
    { order_id: 'other', qty: '9', price: '1.00',  activity_type: 'FILL' },
  ];
  const ex = makeExecutor(makeMockClient({ activities: acts }));
  const fp = await ex.weightedFillPrice(order);
  check('F1  weighted from the per-fill rows, not the rounded order average',
    fp.price, 910.04 / 3, 1e-12);
  ok('F2  ...and it is NOT the rounded value', Math.abs(fp.price - 303.346667) > 1e-9);
  check('F3  flagged as a weighted multi-price average', fp.source, 'fill_rows_weighted');
  check('F4  other orders\' fills are excluded', fp.qty, 3);
  check('F5  the per-execution exit_fills stamp is produced (consumedExitFillQty needs it)',
    fp.fills, [{ orderId: 'o-hd', qty: 1, price: 303.34 }, { orderId: 'o-hd', qty: 2, price: 303.35 }]);

  const single = await makeExecutor(makeMockClient({
    activities: [{ order_id: 'o-s', qty: '2', price: '238.39' }],
  })).weightedFillPrice({ id: 'o-s', filled_qty: '2', filled_avg_price: '238.39' });
  check('F6  a single-price order is exact and flagged as such', [single.price, single.source], [238.39, 'fill_rows_single_price']);

  const none = await makeExecutor(makeMockClient({ activities: [] }))
    .weightedFillPrice({ id: 'o-n', filled_qty: '2', filled_avg_price: '238.39' });
  check('F7  no activity rows -> documented fallback to the order average', [none.price, none.source], [238.39, 'order_avg']);
}

// ═══════════════════════════════════════════════════════════════════════════
section('G. Reconcile — FILLED (the IBM exit Alan had to do by hand)');

{
  resetSandboxState();
  const pos = { ...queuedPos };    // the TP2 queued in group C
  sbWrite('open-positions-sid.json', [pos]);

  const filledOrder = {
    id: pos.pending_exit.order_id, symbol: 'IBM', status: 'filled',
    filled_qty: '2', filled_avg_price: '238.39',
    submitted_at: '2026-09-09T23:30:00Z', filled_at: '2026-09-10T13:30:01Z',
  };
  const client = makeMockClient({
    open: [], holdShares: false,
    activities: [{ order_id: filledOrder.id, qty: '2', price: '238.39' }],
  });
  client.st.byId.set(filledOrder.id, filledOrder);
  const ex = makeExecutor(client, { isOpen: true, etStamp: '2026-09-10T09:35:00.000000000-04:00' });

  const r = await reconcilePendingExits(ex);
  check('G1  one queued exit reconciled as FILLED', [r.checked, r.filled, r.stillOpen, r.dead], [1, 1, 0, 0]);

  const open = sbRead('open-positions-sid.json');
  const closed = sbRead('closed-positions-sid.json');
  check('G2  the position is now CLOSED (out of open-positions)', open.length, 0);
  check('G3  ...and appended to closed-positions', closed.length, 1);

  const rec = closed[0];
  // The real numbers: entry 217.23, TP1 2sh @ 237.51 = +40.56, runner 2sh @ 238.39 = +42.32
  check('G4  the runner leg books at the REAL fill, not the SMA estimate', rec.tp2_price, 238.39);
  check('G5  runner leg P&L', rec.tp2_pnl, realisedPnlFor('long', 217.23, 238.39, 2));
  check('G6  the trade total CARRIES the bot-booked TP1 leg (the v2.5.0 fix)',
    rec.total_pnl, parseFloat((40.56 + realisedPnlFor('long', 217.23, 238.39, 2)).toFixed(2)));
  check('G7  outcome WIN', rec.outcome, 'WIN');
  check('G8  provenance is a real fill, not an estimate', rec.pnl_source, 'alpaca_fill');
  check('G9  flagged as having been queued for the open', rec.exit_queued_for_open, true);
  check('G10 the TP2 reason survives from the trigger data', rec.tp2_reason, 'sma50_touch');
  check('G11 dashboard-compat exitPrice/closeDate present', [rec.exitPrice, rec.closeDate], [238.39, '2026-09-09']);
  check('G12 exit_fills stamped so a later close cannot re-use these fills',
    rec.exit_fills, [{ orderId: filledOrder.id, qty: 2, price: 238.39 }]);
  ok('G13 the pending_exit block is gone from the closed record', !rec.pending_exit);

  const acct = sbRead('sid-account.json');
  check('G14 the ledger is re-derived from records (never a counter)', acct.realizedPnl, rec.total_pnl);
  check('G15 tradeCount from distinct closed records', acct.tradeCount, 1);
  ok('G16 a trades-sid.csv journal row was appended', /IBM,long-tp2,2,/.test(sbText('trades-sid.csv')));
}

// TP1 partial fill: books the leg, keeps the runner, restores the BE stop.
{
  resetSandboxState();
  const pos = {
    ...IBM_RUNNER(), tp1_hit: false, shares_remaining: 4, stopLoss: 213.0,
    brokerStopOrderId: null, tp1_pnl: undefined, tp1_date: undefined,
    pending_exit: {
      order_id: 'q-tp1', client_order_id: 'SID-IBM-tp1-20260909', time_in_force: 'opg',
      status: 'queued', reason: 'tp1_rsi50', kind: 'partial', shares: 2,
      queued_at: '2026-09-09T23:30:00Z', attempt: 1,
      booking: { trigger_date: '2026-09-09', trigger_rsi: 50.4, estimate_price: 237.0, be_price: 217.24, runner_shares: 2, tp1_reason: 'rsi50' },
    },
  };
  delete pos.tp1_close_order_id;
  sbWrite('open-positions-sid.json', [pos]);

  const filled = { id: 'q-tp1', symbol: 'IBM', status: 'filled', filled_qty: '2', filled_avg_price: '237.51', submitted_at: '2026-09-09T23:30:00Z', filled_at: '2026-09-10T13:30:01Z' };
  const client = makeMockClient({ open: [], holdShares: false, activities: [{ order_id: 'q-tp1', qty: '2', price: '237.51' }] });
  client.st.byId.set('q-tp1', filled);
  const ex = makeExecutor(client, { isOpen: true, etStamp: '2026-09-10T09:35:00.000000000-04:00' });

  const r = await reconcilePendingExits(ex);
  check('G17 reconciled as filled', [r.checked, r.filled], [1, 1]);
  const open = sbRead('open-positions-sid.json');
  check('G18 the position STAYS OPEN as the runner', open.length, 1);
  check('G19 nothing was written to closed-positions', sbRead('closed-positions-sid.json').length, 0);
  const p = open[0];
  ok('G20 tp1_hit flips only NOW, on the confirmed fill', p.tp1_hit === true);
  check('G21 tp1_price is the real fill', p.tp1_price, 237.51);
  check('G22 tp1_pnl from the real fill', p.tp1_pnl, realisedPnlFor('long', 217.23, 237.51, 2));
  check('G23 tp1_shares = the filled qty', p.tp1_shares, 2);
  check('G24 shares_remaining dropped to the runner', p.shares_remaining, 2);
  check('G25 the stop MIGRATED to break-even', p.stopLoss, 217.24);
  check('G26 provenance alpaca_fill', p.tp1_pnl_source, 'alpaca_fill');
  check('G27 the TP1 order id is stamped so a later close cannot re-use its fill', p.tp1_close_order_id, 'q-tp1');
  ok('G28 flagged as banked at the open', p.tp1_queued_for_open === true);
  ok('G29 pending_exit cleared', !p.pending_exit);
  const stops = client.st.submitted.filter(o => o.type === 'stop');
  check('G30 the BE stop was RESTORED on the remainder (1 order)', stops.length, 1);
  check('G31 ...on the runner qty only', stops[0].qty, 2);
  check('G32 ...at the break-even price', stops[0].stop_price, 217.24);
  check('G33 ...and tracked on the record', p.brokerStopOrderId, stops[0].id);
  check('G34 the in-flight TP1 leg compounds into the ledger', sbRead('sid-account.json').realizedPnl, p.tp1_pnl);
  check('G35 tradeCount stays 0 (no closed record yet)', sbRead('sid-account.json').tradeCount, 0);
}

// ═══════════════════════════════════════════════════════════════════════════
section('H. Reconcile — STILL OPEN / ACCEPTED: leave it strictly alone');

for (const st of ['accepted', 'new', 'held', 'pending_new', 'partially_filled']) {
  resetSandboxState();
  const pos = { ...IBM_RUNNER(), brokerStopOrderId: null, pending_exit: {
    order_id: 'q-open', client_order_id: 'SID-IBM-tp2-20260909', time_in_force: 'opg',
    status: 'queued', reason: 'tp2_sma50_touch', kind: 'full', shares: 2, attempt: 1, booking: {},
  } };
  sbWrite('open-positions-sid.json', [pos]);
  const client = makeMockClient({ open: [], holdShares: false });
  client.st.byId.set('q-open', { id: 'q-open', symbol: 'IBM', status: st, filled_qty: '0' });
  const ex = makeExecutor(client, { isOpen: false });
  const r = await reconcilePendingExits(ex);
  const p = sbRead('open-positions-sid.json')[0];
  ok(`H1[${st}] left pending, nothing booked, nothing submitted`,
    r.stillOpen === 1 && r.filled === 0 && r.dead === 0 &&
    !!p.pending_exit && p.pending_exit.order_id === 'q-open' &&
    sbRead('closed-positions-sid.json').length === 0 &&
    client.st.submitted.length === 0 && client.st.cancelled.length === 0);
}

// ═══════════════════════════════════════════════════════════════════════════
section('I. Reconcile — DEAD (cancelled / rejected / expired / vanished)');

for (const st of ['canceled', 'rejected', 'expired']) {
  resetSandboxState();
  const pos = { ...IBM_RUNNER(), brokerStopOrderId: null, pending_exit: {
    order_id: 'q-dead', client_order_id: 'SID-IBM-tp2-20260909', time_in_force: 'opg',
    status: 'queued', reason: 'tp2_sma50_touch', kind: 'full', shares: 2, attempt: 1, booking: {},
  } };
  sbWrite('open-positions-sid.json', [pos]);
  const client = makeMockClient({ open: [], holdShares: false });
  client.st.byId.set('q-dead', { id: 'q-dead', symbol: 'IBM', status: st, filled_qty: '0' });
  const ex = makeExecutor(client, { isOpen: false });
  const r = await reconcilePendingExits(ex);
  const p = sbRead('open-positions-sid.json')[0];
  const stops = client.st.submitted.filter(o => o.type === 'stop');
  ok(`I1[${st}] pending_exit cleared + IMMEDIATELY re-protected with a stop on the runner`,
    r.dead === 1 && r.filled === 0 && !p.pending_exit &&
    stops.length === 1 && stops[0].qty === 2 && p.brokerStopOrderId === stops[0].id);
  ok(`I2[${st}] nothing was booked for an order that never filled`,
    sbRead('closed-positions-sid.json').length === 0);
  ok(`I3[${st}] the loud alarm is journaled`,
    sbRead('sid-log.json').some(e => e.kind === 'pending_exit_dropped' && e.broker_status === st));
}
{
  // Order gone entirely (404) -> same dead handling.
  resetSandboxState();
  sbWrite('open-positions-sid.json', [{ ...IBM_RUNNER(), brokerStopOrderId: null, pending_exit: {
    order_id: 'q-gone', status: 'queued', reason: 'tp2_sma50_touch', kind: 'full', shares: 2, attempt: 1, booking: {},
  } }]);
  const client = makeMockClient({ open: [], holdShares: false });
  const ex = makeExecutor(client, { isOpen: false });
  const r = await reconcilePendingExits(ex);
  ok('I4  a 404 (order not at Alpaca at all) is treated as dropped + re-protected',
    r.dead === 1 && client.st.submitted.filter(o => o.type === 'stop').length === 1);
}
{
  // A TRANSIENT lookup failure is NOT evidence the order is dead. Re-protecting
  // here would double-hold the shares and block the live order from filling.
  resetSandboxState();
  sbWrite('open-positions-sid.json', [{ ...IBM_RUNNER(), brokerStopOrderId: null, pending_exit: {
    order_id: 'q-flaky', status: 'queued', reason: 'tp2_sma50_touch', kind: 'full', shares: 2, attempt: 1, booking: {},
  } }]);
  const client = makeMockClient({ open: [], holdShares: false });
  client.getOrder = async () => { const e = new Error('503 upstream'); e.status = 503; throw e; };
  const ex = makeExecutor(client, { isOpen: false });
  const r = await reconcilePendingExits(ex);
  const p = sbRead('open-positions-sid.json')[0];
  ok('I5  a 5xx lookup error leaves the pending exit ALONE (no re-protect, no booking)',
    r.stillOpen === 1 && r.dead === 0 && !!p.pending_exit && client.st.submitted.length === 0);
}
{
  // An UNDER-FILLED full exit must NOT book a full close — that would drop the
  // position from our books while the broker still holds the remainder.
  resetSandboxState();
  sbWrite('open-positions-sid.json', [{ ...IBM_RUNNER(), brokerStopOrderId: null, pending_exit: {
    order_id: 'q-under', client_order_id: 'SID-IBM-tp2-20260909', time_in_force: 'opg',
    status: 'queued', reason: 'tp2_sma50_touch', kind: 'full', shares: 2, attempt: 1, booking: {},
  } }]);
  const client = makeMockClient({ open: [], holdShares: false, activities: [{ order_id: 'q-under', qty: '1', price: '238.39' }] });
  client.st.byId.set('q-under', { id: 'q-under', symbol: 'IBM', status: 'filled', filled_qty: '1', filled_avg_price: '238.39', submitted_at: '2026-09-09T23:30:00Z', filled_at: '2026-09-10T13:30:01Z' });
  const ex = makeExecutor(client, { isOpen: true, etStamp: '2026-09-10T09:35:00.000000000-04:00' });
  const r = await reconcilePendingExits(ex);
  const open = sbRead('open-positions-sid.json');
  ok('I9  an under-filled FULL exit books NOTHING (no orphaned broker shares)',
    sbRead('closed-positions-sid.json').length === 0 && open.length === 1 && !open[0].pending_exit);
  ok('I10 ...the remainder is re-protected and the next sync is left to book the filled part',
    client.st.submitted.filter(o => o.type === 'stop').length === 1 &&
    sbRead('sid-log.json').some(e => e.kind === 'pending_exit_partial_fill' && e.filled === 1 && e.requested === 2));
  // The ledger IS re-derived (any mutated reconcile re-derives from the saved
  // files), but nothing from the under-fill is booked: the only P&L it can see is
  // the position's pre-existing in-flight TP1 leg, which the v2.4.1 design
  // deliberately compounds into sizing while the runner is open.
  check('I11 ...and the ledger shows ONLY the pre-existing in-flight TP1 leg',
    sbRead('sid-account.json').realizedPnl, 40.56);
  check('I12 ...with no closed trade counted', sbRead('sid-account.json').tradeCount, 0);
  void r;
}
{
  resetSandboxState();
  const r = await reconcilePendingExits(makeExecutor(makeMockClient()));
  check('I6  no pending exits -> a cheap no-op', [r.checked, r.filled, r.dead], [0, 0, 0]);
  check('I7  dry_run (no executor) -> no-op', (await reconcilePendingExits(null)).checked, 0);
}
check('I8  the dead-state list covers every Alpaca terminal non-fill state',
  PENDING_EXIT_DEAD_STATES.includes('canceled') && PENDING_EXIT_DEAD_STATES.includes('cancelled') &&
  PENDING_EXIT_DEAD_STATES.includes('rejected') && PENDING_EXIT_DEAD_STATES.includes('expired'), true);

// ═══════════════════════════════════════════════════════════════════════════
section('N. TWO queued exits filling in one reconcile must not double-count');
// Found while writing this suite: the first draft handed deriveLedger
// `openPositions.filter(p => p !== pos)`, so on the SECOND booking the FIRST
// (already-closed) position was still in the "open" set and its tp1_pnl was
// added on top of its own full-close record — which already carries that leg
// (tp1LegAlreadyInClosedRecords returns FALSE for a full-close record BY DESIGN,
// because a full record IS the trade total). Witnessed below, then fixed by
// passing the exact set (processed-and-still-open + not-yet-processed).

{
  resetSandboxState();
  const mk = (id, sym, entry, tp1Pnl, oid) => ({
    id, symbol: sym, side: 'long', entry, stopLoss: entry + 0.01,
    shares: 4, shares_total: 4, shares_remaining: 2,
    tp1_hit: true, tp1_date: '2026-09-02', tp1_price: entry + 20, tp1_shares: 2,
    tp1_pnl: tp1Pnl, tp1_pnl_source: 'alpaca_fill', tp1_close_order_id: `${id}-tp1`,
    signalDate: '2026-08-14', openDate: '2026-08-15', mode: 'paper',
    brokerStopOrderId: null, clientOrderIdPrefix: `SID-${sym}-20260814-long`,
    pending_exit: {
      order_id: oid, client_order_id: `SID-${sym}-tp2-20260909`, time_in_force: 'opg',
      status: 'queued', reason: 'tp2_sma50_touch', kind: 'full', shares: 2, attempt: 1,
      booking: { trigger_date: '2026-09-09', trigger_rsi: 60, tp2_reason: 'sma50_touch' },
    },
  });
  const p1 = mk('ibm-pos-1', 'IBM', 217.23, 40.56, 'q-ibm');
  const p2 = mk('hon-pos-1', 'HON', 204.44, 20.58, 'q-hon');
  sbWrite('open-positions-sid.json', [p1, p2]);

  const client = makeMockClient({ open: [], holdShares: false, activities: [
    { order_id: 'q-ibm', qty: '2', price: '238.39' },
    { order_id: 'q-hon', qty: '2', price: '210.00' },
  ] });
  client.st.byId.set('q-ibm', { id: 'q-ibm', symbol: 'IBM', status: 'filled', filled_qty: '2', filled_avg_price: '238.39', submitted_at: '2026-09-09T23:30:00Z', filled_at: '2026-09-10T13:30:01Z' });
  client.st.byId.set('q-hon', { id: 'q-hon', symbol: 'HON', status: 'filled', filled_qty: '2', filled_avg_price: '210.00', submitted_at: '2026-09-09T23:30:00Z', filled_at: '2026-09-10T13:30:01Z' });
  const ex = makeExecutor(client, { isOpen: true, etStamp: '2026-09-10T09:35:00.000000000-04:00' });

  const r = await reconcilePendingExits(ex);
  check('N1  both reconciled as filled', [r.checked, r.filled], [2, 2]);
  const closed = sbRead('closed-positions-sid.json');
  check('N2  two closed records', closed.length, 2);
  const want = parseFloat((
    (40.56 + realisedPnlFor('long', 217.23, 238.39, 2)) +
    (20.58 + realisedPnlFor('long', 204.44, 210.00, 2))
  ).toFixed(2));
  check('N3  each record total carries its OWN TP1 leg once',
    parseFloat(closed.reduce((s, x) => s + x.total_pnl, 0).toFixed(2)), want);
  check('N4  the ledger equals the record sum — no TP1 leg counted twice',
    sbRead('sid-account.json').realizedPnl, want);
  check('N5  tradeCount = 2', sbRead('sid-account.json').tradeCount, 2);
  check('N6  no position left open', sbRead('open-positions-sid.json').length, 0);

  // WITNESS: the buggy open set inflates the ledger by the FIRST position's TP1 leg.
  const buggyOpenSet = [p1];                  // what `filter(p => p !== p2)` produced
  const buggy = bot.deriveLedger('paper', { closed, open: buggyOpenSet });
  check('N7  WITNESS the pre-fix open set inflated the ledger by IBM\'s TP1 leg',
    buggy.realizedPnl, parseFloat((want + 40.56).toFixed(2)));
}

// ═══════════════════════════════════════════════════════════════════════════
section('J. ENTRIES still refuse when the market is closed (never queued)');

{
  const ex = makeExecutor(makeMockClient(), { isOpen: false });
  const signal = { signal: 'long', entry: 100, stopLoss: 95, signalDate: '2026-09-09' };
  const sizing = { shares: 3, totalUsd: 300, riskUsd: 15, riskPct: 5 };
  let e1 = null, e2 = null;
  try { await ex.openEntry({ signal, sizing, symbol: 'IBM' }); } catch (err) { e1 = err.message; }
  try { await ex.openEntryNoStop({ signal, sizing, symbol: 'IBM' }); } catch (err) { e2 = err.message; }
  ok('J1  openEntry still refuses on a closed market', /Market closed/.test(e1 || ''));
  ok('J2  openEntryNoStop (PDT-safe) still refuses too', /Market closed/.test(e2 || ''));
  ok('J3  the two entry guards are still literally in the source',
    (execSrc.match(/Market closed — refusing to submit entry/g) || []).length === 2);
  ok('J4  queueExitAtOpen is the ONLY submitter without a market-hours guard',
    /async queueExitAtOpen\(\{[\s\S]{0,900}?submitOrder/.test(execSrc) &&
    !/async queueExitAtOpen\(\{[\s\S]{0,400}?clock\?\.is_open/.test(execSrc));
  ok('J5  no entry path can reach the queue helper',
    !/openEntry[\s\S]{0,200}queueExitForOpen/.test(realSrc));
  ok('J6  the close/partial-close market guards are untouched',
    /Market closed — refusing to submit partial close/.test(execSrc) &&
    /Market closed — refusing to submit close/.test(execSrc));
}

// ═══════════════════════════════════════════════════════════════════════════
section('K. checkPositions wiring — all four exit paths route to the queue');

ok('K1  reconcile runs BEFORE syncPositions (otherwise an overnight fill books twice)',
  realSrc.indexOf('await reconcilePendingExits(executor)') < realSrc.indexOf('await executor.syncPositions(localOpen)'));
ok('K2  the pre-TP1 stop path queues when closed',
  /if \(stopHit\) \{[\s\S]{0,1200}?shouldQueueExitForOpen\(executor\)[\s\S]{0,400}?reason: 'stop'/.test(realSrc));
ok('K3  the TP1 partial path queues when closed',
  /shouldQueueExitForOpen\(executor\)[\s\S]{0,500}?reason: 'tp1_rsi50'/.test(realSrc));
ok('K4  the TP2 runner path queues when closed',
  /shouldQueueExitForOpen\(executor\)[\s\S]{0,500}?reason: `tp2_\$\{tp2Reason\}`/.test(realSrc));
ok('K5  the v2.0 RSI-50 fallback path queues when closed',
  /shouldQueueExitForOpen\(executor\)[\s\S]{0,500}?reason: 'v20_rsi50'/.test(realSrc));
check('K6  exactly four exit paths consult the gate (and nothing else does)',
  (realSrc.match(/if \(shouldQueueExitForOpen\(executor\)\)/g) || []).length, 4);
ok('K7  each queue call pushes the position back to stillOpen so pending_exit persists',
  (realSrc.match(/await queueExitForOpen\(\{[\s\S]{0,900}?\}\);\s*\n\s*stillOpen\.push\(pos\);/g) || []).length === 4);
ok('K8  the sweep uses cancelAllOpenOrders + waitForNoOpenOrders (shares cannot free otherwise)',
  /queueExitForOpen[\s\S]{0,2600}?cancelAllOpenOrders\(pos\.symbol\)[\s\S]{0,200}?waitForNoOpenOrders\(pos\.symbol\)/.test(realSrc));
// 4 sweeps: maintainV2_2BrokerOrders reset, Branch A TP1 close, Branch B TP2 close
// (the three pre-v2.6.0 ones, unchanged) + the new queue-for-open sweep.
ok('K9  the v2.2.5/2.2.6/v2.4.2 in-hours cancel-first close mechanics are untouched',
  (realSrc.match(/await executor\.cancelAllOpenOrders\(pos\.symbol\)/g) || []).length === 4 &&
  /await executor\.closePartial\(pos, tp1Shares/.test(realSrc) &&
  /await executor\.pollOrderFill\(closeOrderId\)/.test(realSrc) &&
  /const lingeringStop = await findOpenOrder\(executor\.client, pos\.symbol, '-stop'\)/.test(realSrc));
ok('K10 the weekend guard no longer returns before checkPositions',
  realSrc.indexOf('isWeekendUtc && !CONFIG.weekendExitQueue') < realSrc.indexOf('await checkPositions(executor)') &&
  /if \(isWeekendUtc \|\| CONFIG\.exitsOnly\) \{/.test(realSrc) &&
  realSrc.indexOf('if (isWeekendUtc || CONFIG.exitsOnly)') > realSrc.indexOf('await checkPositions(executor)'));
ok('K11 exits-only skips the ENTRY SCAN only (checkPositions still runs)',
  /Entry scan skipped/.test(realSrc));

// ═══════════════════════════════════════════════════════════════════════════
section('L. Railway cron runner — shape, safety, no credentials');

{
  const rs = fs.readFileSync(path.join(SID_DIR, 'railway-sid-runner.js'), 'utf8');
  // Strip comments first — the doc block DISCUSSES setInterval as the documented
  // fallback, which must not be mistaken for using one.
  const rsCode = rs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('L1  ONE-SHOT: no setInterval / setTimeout scheduler in the CODE',
    !/setInterval\s*\(/.test(rsCode) && !/setTimeout\s*\(/.test(rsCode));
  ok('L1b ...and runCycle is invoked exactly once, behind a main-guard',
    (rsCode.match(/^\s*runCycle\(\)/gm) || []).length === 1 &&
    /const _isDirectRun = import\.meta\.url === pathToFileURL/.test(rsCode));
  ok('L2  it exits so Railway does not skip the next cron run', /process\.exit\(0\)/.test(rs));
  ok('L3  hard-fails on a missing env var (exit 1), reporting NAMES only',
    /missing\.push\('ALPACA_KEY_ID'\)/.test(rs) && /process\.exit\(1\)/.test(rs));
  ok('L4  NO credential literal fallback anywhere',
    !/(ALPACA_SECRET_KEY|ALPACA_KEY_ID|GITHUB_TOKEN)\s*\|\|\s*['"][^'"]+['"]/.test(rs));
  ok('L5  the token is only ever read from env, never logged',
    /process\.env\.SID_GITHUB_TOKEN \|\| process\.env\.GITHUB_TOKEN \|\| ''/.test(rs) &&
    !/console\.log\([^)]*GITHUB_TOKEN/.test(rs));
  ok('L6  refuses live mode without SID_LIVE_CONFIRMED', /SID_TRADING_MODE=live without SID_LIVE_CONFIRMED/.test(rs));
  ok('L7  market gating comes from Alpaca /v2/clock, never a hardcoded calendar',
    /client\.getClock\(\)/.test(rs) && !/14:30|9:30|hardcode/.test(rs.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')));
  ok('L8  a closed market still runs the cheap cycle via SID_EXITS_ONLY',
    /SID_EXITS_ONLY: 'true'/.test(rs));
  ok('L9  an unreadable clock takes the cheap path (never enter blind)',
    /open: null/.test(rs) && /const full\s*=\s*clock\.open === true/.test(rs));
  ok('L10 state goes to main (dashboard builds from main), not Ironclad\'s logs branch',
    /SID_STATE_BRANCH \|\| 'main'/.test(rs) && !/'logs'/.test(rs));
  ok('L11 uses the GitHub Contents API, not the git CLI', /contents\//.test(rs) && !/execSync\('git/.test(rs));
  ok('L12 sha-aware push with a conflict retry', /attempt <= 2/.test(rs) && /409/.test(rs));
  ok('L13 unchanged files are not pushed (no clobber, no redeploy churn)',
    /before\.content === localText\) \{ skipped\+\+/.test(rs));
  ok('L14 a bot crash still pushes whatever state the bot DID write',
    /Continuing to the state push so nothing the bot DID write is lost/.test(rs));
  ok('L15 commit message is distinguishable from the GHA runner\'s',
    /SID railway run \$\{commitStamp\}/.test(rs));

  // The runner's state list must match what sid.yml stages, or the two runners
  // keep different books.
  const yml = fs.readFileSync(path.join(SID_DIR, '..', '.github', 'workflows', 'sid.yml'), 'utf8');
  const staged = new Set((yml.match(/git add '?([^'\s]+)'?/g) || [])
    .flatMap(l => l.replace(/git add '?/, '').replace(/'$/, '').split(/\s+/))
    .filter(x => x.startsWith('SID/')));
  const runnerFiles = new Set((rs.match(/\{ p: '([^']+)'/g) || []).map(m => m.replace(/\{ p: '/, '').replace(/'$/, '')));
  const yamlGlobbed = [...staged].some(s => s.includes('alpaca-account*'));
  const missingFromRunner = [...staged]
    .filter(s => !s.includes('*'))
    .filter(s => !runnerFiles.has(s));
  check('L16 the runner pushes every state file sid.yml stages', missingFromRunner, []);
  ok('L17 ...including the mode-segregated Alpaca snapshots sid.yml globs',
    yamlGlobbed && runnerFiles.has('SID/alpaca-account-sid.json') && runnerFiles.has('SID/alpaca-account-live-sid.json'));
  ok('L18 sid.yml now also stages the approval queue (the v2.4.3 flagged gap)',
    staged.has('SID/pending-approvals-sid.json') && runnerFiles.has('SID/pending-approvals-sid.json'));
  ok('L19 the GHA crons are NOT disabled in this release (Phase 1)',
    (yml.match(/^\s*- cron:/gm) || []).length === 3);

  const rj = JSON.parse(fs.readFileSync(path.join(SID_DIR, 'railway-sid.json'), 'utf8'));
  check('L20 railway-sid.json starts the SID runner', rj.deploy.startCommand, 'node SID/railway-sid-runner.js');
  check('L21 ...and cannot restart-loop a failing cron run', rj.deploy.restartPolicyType, 'NEVER');

  // Import the runner for real — the main-guard means this must have NO side
  // effects (no env assertion, no network, no cycle).
  const runner = await import(pathToUrl(path.join(SID_DIR, 'railway-sid-runner.js')));
  check('L28 the runner reports v2.6.0 at RUNTIME, in lockstep with the bot',
    runner.RUNNER_VERSION, BOT_VERSION);
  ok('L29 importing it is side-effect free (main-guard, like bot-sid.js)',
    typeof runner.runCycle === 'function' && typeof runner.assertEnv === 'function');

  // Conflict resolution — the Phase-1 "Railway and GHA both wrote main" case.
  check('L30 byId merge: remote kept, local wins on an id tie, new local appended',
    JSON.parse(runner.mergeById(
      JSON.stringify([{ id: 'a', v: 1 }, { id: 'b', v: 1 }]),
      JSON.stringify([{ id: 'a', v: 2 }, { id: 'b', v: 1 }, { id: 'c', v: 9 }]))),
    [{ id: 'a', v: 2 }, { id: 'b', v: 1 }, { id: 'c', v: 9 }]);
  check('L31 byId merge: a record only the REMOTE has is never dropped',
    JSON.parse(runner.mergeById(
      JSON.stringify([{ id: 'a' }, { id: 'remote-only' }]),
      JSON.stringify([{ id: 'a' }]))).map(x => x.id),
    ['a', 'remote-only']);
  check('L32 csv merge: header kept once, rows de-duped, local-only appended',
    runner.mergeCsvAppend('H\nr1\nr2\n', 'H\nr1\nr2\nr3\n'), 'H\nr1\nr2\nr3\n');
  check('L33 csv merge: a row only the REMOTE has survives',
    runner.mergeCsvAppend('H\nremote\n', 'H\nlocal\n'), 'H\nremote\nlocal\n');
  check('L34 csv merge handles CRLF without duplicating rows',
    runner.mergeCsvAppend('H\r\nr1\r\n', 'H\nr1\nr2\n'), 'H\nr1\nr2\n');
  check('L35 open-positions conflicts resolve to LOCAL (we just acted at the broker)',
    runner.resolveConflict('SID/open-positions-sid.json', 'local', '[{"id":"remote"}]', '[{"id":"local"}]').text,
    '[{"id":"local"}]');
  ok('L36 a merge that throws falls back to LOCAL rather than losing our write',
    runner.resolveConflict('SID/closed-positions-sid.json', 'byId', 'not json', '[{"id":"local"}]').text === '[{"id":"local"}]');

  const doc = fs.readFileSync(path.join(SID_DIR, 'RAILWAY-DEPLOY.md'), 'utf8');
  ok('L22 the deploy doc describes a Cron Schedule, not a worker', /Cron Schedule/.test(doc));
  ok('L23 ...gives the start command', /node SID\/railway-sid-runner\.js/.test(doc));
  ok('L24 ...covers both DST regimes in the cron window', /\*\/15 13-23 \* \* 1-5/.test(doc));
  ok('L25 ...documents the always-on loop as the fallback', /If Railway cron proves unreliable/.test(doc));
  ok('L26 ...documents Phase 2 without doing it', /Phase 2 — retire the GitHub Actions crons/.test(doc));
  ok('L27 ...and contains NO credential value (names only)',
    /NAMES ONLY/.test(doc) && !/\bPK[A-Z0-9]{10,}\b/.test(doc) && !/\bgh[pousr]_[A-Za-z0-9]{20,}\b/.test(doc));
}

// ═══════════════════════════════════════════════════════════════════════════
section('M. Ironclad / VWAP segregation');

{
  const root = path.join(SID_DIR, '..');
  for (const f of ['railway-runner.js', 'railway.json']) {
    const t = fs.readFileSync(path.join(root, f), 'utf8');
    ok(`M1[${f}] Ironclad's file is untouched by SID`, !/sid/i.test(t.replace(/considered/gi, '')));
  }
  const rj = JSON.parse(fs.readFileSync(path.join(root, 'railway.json'), 'utf8'));
  check('M2  the repo-root railway.json still starts IRONCLAD\'s runner',
    rj.deploy.startCommand, 'node railway-runner.js');
}

// ── Teardown ────────────────────────────────────────────────────────────────
fs.rmSync(SANDBOX, { recursive: true, force: true });
ok('Z1  sandbox removed (no real state file was ever touched)', !fs.existsSync(SANDBOX));

console.log(`\n${'='.repeat(60)}`);
console.log(`RESULT: ${pass} passed, ${fail} failed, ${pass + fail} total`);
if (fail) { console.log('FAILURES:'); for (const f of failures) console.log('  - ' + f); }
console.log('='.repeat(60));
process.exit(fail ? 1 : 0);
