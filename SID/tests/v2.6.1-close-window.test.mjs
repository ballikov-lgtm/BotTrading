/**
 * SID v2.6.1 — CLOSE-WINDOW ENTRY EXECUTION: REGRESSION SUITE
 * ===========================================================
 *
 * THREE measured defects, all of which silently COST ENTRIES:
 *
 *  1. THE RUN NEVER LANDED IN-HOURS. Over the 25 trading days to 2026-10-23,
 *     SEVEN (28%) had no sid.yml run inside market hours at all; every run
 *     arrived after the 20:00 UTC close, where the executor refuses every order.
 *     MCD is the measured miss: `detectEntrySignal` returns LONG on the
 *     2026-10-05 bar AND again on the 2026-10-08 bar, and on both days every run
 *     landed after the bell (05 Oct 21:34 / 22:53 / 00:17 · 08 Oct 20:01 / 21:27
 *     / 23:31 UTC).
 *
 *  2. EVEN AN IN-HOURS RUN WAS JUDGING AN UNFINISHED BAR. An entry is DEFINED as
 *     `entry = close`, so a mid-session scan reads RSI, the MACD direction and
 *     the entry price off a day that has not closed. Hence the close window.
 *
 *  3. AN EXIT CONSUMED THE DAY'S ENTRY BUDGET (FIX A). `countTodayTrades()`
 *     counted every trades-sid.csv row dated today, exits included, and fed the
 *     then-1/day `maxPerDay` gate. On 2026-10-08 (GHA run 37836390871) the bot
 *     booked HON's stop-out at 20:02:09 and at 20:02:10 printed
 *     `Daily entry limit reached (1)` and returned — blocked by the row it had
 *     just written itself.
 *
 * REGRESSION WITNESSES (groups W and T): the PRE-FIX behaviour is driven on the
 * REAL data and must reproduce the exact bad outcome BEFORE the new code is
 * asserted. A test that only checks the new answer cannot tell you the bug was
 * ever real.
 *
 * Group R executes the SHIPPED `resolveEntryWindow` with an injected clock and a
 * fake sleep, so the real control flow runs — the mid-wait abort and the
 * never-sleep-twice guard included — with no network and no real waiting.
 *
 * NO NETWORK. NO BROKER CALLS. NO REAL WAITING. MCD's bars come from
 * `tests/fixtures/` (see that folder's README for provenance). State-reading
 * functions run inside a throwaway copy of the module tree
 * (`SID/_v261_sandbox/`), removed on exit (test Z1 asserts it).
 *
 *   node tests/v2.6.1-close-window.test.mjs
 *
 * ASCII-only console output (cp1252 machine — see SID/CLAUDE.md).
 */

import fs   from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

process.env.TELEGRAM_ALERTS_ENABLED = 'false';
process.env.SID_TRADING_MODE = process.env.SID_TRADING_MODE || 'dry_run';
// Make the suite independent of the shell's own overrides: v2.6.1's defaults are
// part of what is under test.
delete process.env.SID_MAX_PER_DAY;
delete process.env.SID_CLOSE_WINDOW_MIN;
delete process.env.SID_ENTRY_SUBMIT_OFFSET_MIN;
delete process.env.SID_MAX_ENTRY_WAIT_MIN;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SID_DIR   = path.join(__dirname, '..');
const SANDBOX   = path.join(SID_DIR, '_v261_sandbox');
const FIXTURES  = path.join(__dirname, 'fixtures');

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
function semverAtLeast(v, min) {
  const n = String(v || '').replace(/^v/, '').split('.').map(x => parseInt(x, 10) || 0);
  const m = String(min).split('.').map(x => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((n[i] || 0) !== (m[i] || 0)) return (n[i] || 0) > (m[i] || 0); }
  return true;
}

// ── Sandbox ─────────────────────────────────────────────────────────────────
const MODULES = ['bot-sid.js', 'alpaca-executor.js', 'alpaca-client.js', 'rsi-target-price.js', 'telegram-alerts.js'];
const DATA    = ['watchlist-sid.json', 'event-dates.json', 'asset-classification.json', 'rules-sid.json'];
const TRADES_HEADER = 'Date,Time,Exchange,Symbol,Side,Shares,Entry Price,Stop Loss,Total USD,Risk USD,Risk %,Signal Date,Order ID,Mode,Strategy';
function makeSandbox() {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  fs.mkdirSync(SANDBOX, { recursive: true });
  for (const m of [...MODULES, ...DATA]) {
    const src = path.join(SID_DIR, m);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(SANDBOX, m));
  }
  fs.writeFileSync(path.join(SANDBOX, 'open-positions-sid.json'), '[]');
  fs.writeFileSync(path.join(SANDBOX, 'closed-positions-sid.json'), '[]');
  fs.writeFileSync(path.join(SANDBOX, 'sid-log.json'), '[]');
  fs.writeFileSync(path.join(SANDBOX, 'sid-account.json'), JSON.stringify({
    accountUsd: 10000, startingUsd: 10000, realizedPnl: 0, tradeCount: 0, mode: 'paper',
  }, null, 2));
  fs.writeFileSync(path.join(SANDBOX, 'trades-sid.csv'), TRADES_HEADER + '\n');
}
const sbTrades = rows => fs.writeFileSync(path.join(SANDBOX, 'trades-sid.csv'),
  [TRADES_HEADER, ...rows].join('\n') + '\n');

makeSandbox();
const bot    = await import(pathToUrl(path.join(SANDBOX, 'bot-sid.js')));
const runner = await import(pathToUrl(path.join(SID_DIR, 'railway-sid-runner.js')));
const exec   = await import(pathToUrl(path.join(SID_DIR, 'alpaca-executor.js')));

const {
  BOT_VERSION, CONFIG, detectEntrySignal, countTodayEntries, entryBudgetFor, todayString,
} = bot;
const {
  RUNNER_VERSION, etFields, planEntryWindow, resolveEntryWindow,
  CLOSE_WINDOW_MIN, ENTRY_SUBMIT_OFFSET_MIN, MAX_ENTRY_WAIT_MIN,
} = runner;

// ── MCD fixture: the real bars behind the measured miss ─────────────────────
const MCD_CSV = fs.readFileSync(path.join(FIXTURES, 'mcd-daily-to-2026-10-08.csv'), 'utf8');
const MCD_BARS = MCD_CSV.trim().split('\n').slice(1).map(l => {
  const [date, high, low, close] = l.split(',');
  return { date, high: +high, low: +low, close: +close,
           time: Date.parse(date + 'T00:00:00Z'), open: +close, volume: 0 };
});
const mcdUpTo = d => MCD_BARS.filter(b => b.date <= d);

/** A /v2/clock payload. `nc` is next_close. */
const mkClock = (ts, nc, open = true) => ({ is_open: open, timestamp: ts, next_close: nc, next_open: nc });
/** readMarketClock()'s shape, which resolveEntryWindow consumes. */
const mkRead = (raw, note = '') => ({ open: raw?.is_open === true, detail: note || `is_open=${raw?.is_open}`, raw: raw || null });

// The ACTUAL sid.yml run start times on the two MCD signal days (from
// `gh run list --workflow=sid.yml`, UTC). Both days: every run after the close.
const RUNS_05_OCT = ['2026-10-05T21:33:49Z', '2026-10-05T22:52:34Z', '2026-10-06T00:16:14Z'];
const RUNS_08_OCT = ['2026-10-08T20:01:56Z', '2026-10-08T21:27:18Z', '2026-10-08T23:31:16Z'];
// EDT session in UTC: 13:30 open, 20:00 close.
const inHoursUtcEdt = iso => {
  const m = /T(\d{2}):(\d{2})/.exec(iso);
  const min = +m[1] * 60 + +m[2];
  return min >= 13 * 60 + 30 && min < 20 * 60;
};

// ═══════════════════════════════════════════════════════════════════════════
section('V. Version + canon (the exact pin lives in the NEWEST suite only)');

check('V1  bot reports v2.6.1', BOT_VERSION, 'v2.6.1');
check('V2  the runner reports v2.6.1 at RUNTIME, in lockstep with the bot', RUNNER_VERSION, BOT_VERSION);

const realSrc = fs.readFileSync(path.join(SID_DIR, 'bot-sid.js'), 'utf8');
const execSrc = fs.readFileSync(path.join(SID_DIR, 'alpaca-executor.js'), 'utf8');
const runSrc  = fs.readFileSync(path.join(SID_DIR, 'railway-sid-runner.js'), 'utf8');

check('V3  RSI extreme thresholds still 30 / 70 (instructor canon)',
  [/const RSI_OVERSOLD\s*=\s*30;/.test(realSrc), /const RSI_OVERBOUGHT\s*=\s*70;/.test(realSrc)], [true, true]);
check('V4  RSI no-go zones still 45 / 55', [CONFIG.rsiNoGoLong, CONFIG.rsiNoGoShort], [45, 55]);
check('V5  earnings blackout still 14 days', CONFIG.earningsWindow, 14);
check('V6  TP1 portion still 50%', CONFIG.tp1Portion, 0.5);
check('V7  TP2 timeout still 30 trading days', CONFIG.tp2TimeoutDays, 30);
ok('V8  RSI-50 TP1 trigger intact', /rsi\s*>=\s*50\s*:\s*rsi\s*<=\s*50/.test(realSrc));
ok('V9  TP2 SMA50/SMA200 triggers intact', /sma50_touch/.test(realSrc) && /sma200_touch/.test(realSrc));
ok('V10 earnings blackout still applied in run()', /isWithinEarningsWindow/.test(realSrc));
ok('V11 MACD alignment still computed', /calcMACD/.test(realSrc));
check('V12 AUTO tier is still 80 tickers',
  (realSrc.match(/const AUTO_APPROVED_TICKERS = new Set\(\[([\s\S]*?)\]\)/)[1].match(/'/g).length) / 2, 80);
check('V13 `entry = close` is still how an entry price is defined (the reason the close window exists)',
  [(realSrc.match(/const ep\s*=\s*closes\[i\];/g) || []).length,        // long + short trigger branches
   (realSrc.match(/entry:\s*ep,/g) || []).length], [2, 2]);
check('V14 macdRising is still "MACD today > MACD yesterday", in BOTH places that compute it',
  [/const macdRising\s*=\s*m\s*>\s*prevMacd;/.test(realSrc),        // detectEntrySignal's bar replay
   /macdRising:\s*lastMacd\s*>\s*prevMacd,/.test(realSrc)], [true, true]);  // weeklyDirection
check('V15 RISK OVERLAY: the concurrent cap is still 5 and is the ONLY position limit',
  [CONFIG.maxOpenPositions, CONFIG.maxPerDay], [5, 0]);
check('V16 dashboard version marker is 2.6.1',
  (/STRATEGY_VERSION\s*=\s*'([0-9.]+)'/.exec(fs.readFileSync(path.join(SID_DIR, 'sid-dashboard.js'), 'utf8')) || [])[1], '2.6.1');
ok('V17 and the older suites stay version-AGNOSTIC (>= their own version)',
  semverAtLeast(BOT_VERSION, '2.5.0') && semverAtLeast(BOT_VERSION, '2.6.0'));

// ═══════════════════════════════════════════════════════════════════════════
section('W. REGRESSION WITNESS — the 8 Oct MCD miss, same bars, same clock');

check('W1  the fixture is MCD through the 2026-10-08 bar, 5y deep (the live scan range)',
  [MCD_BARS.length > 1200, MCD_BARS[MCD_BARS.length - 1].date], [true, '2026-10-08']);
check('W2  ...and that bar is the real one: close 236.90, high 237.50, low 230.20',
  [MCD_BARS.at(-1).close, MCD_BARS.at(-1).high, MCD_BARS.at(-1).low], [236.9, 237.5, 230.2]);

// -- the signal existed ------------------------------------------------------
const sig08 = detectEntrySignal(mcdUpTo('2026-10-08'));
const sig05 = detectEntrySignal(mcdUpTo('2026-10-05'));
check('W3  WITNESS the 2026-10-08 bar produces a LONG signal (side/entry/stop/signalDate)',
  [sig08?.signal, sig08?.entry?.toFixed(2), sig08?.stopLoss, sig08?.signalDate],
  ['long', '236.90', 230, '2026-10-07']);
check('W4  WITNESS the 2026-10-05 bar produces a LONG too (the earlier miss)',
  [sig05?.signal, sig05?.entry?.toFixed(2), sig05?.stopLoss, sig05?.signalDate],
  ['long', '233.04', 229, '2026-09-30']);
check('W5  ...and it is bar-specific, not "always long" — 10-06 and 10-07 produce nothing',
  [detectEntrySignal(mcdUpTo('2026-10-06')), detectEntrySignal(mcdUpTo('2026-10-07'))], [null, null]);
check('W6  entry == that bar\'s close, to the cent (this is why T-3 matters)',
  sig08.entry, mcdUpTo('2026-10-08').at(-1).close);

// -- the PRE-v2.6.1 runner never looked --------------------------------------
check('W7  WITNESS not one sid.yml run on 08 Oct landed inside market hours',
  RUNS_08_OCT.filter(inHoursUtcEdt).length, 0);
check('W8  WITNESS same on 05 Oct',
  RUNS_05_OCT.filter(inHoursUtcEdt).length, 0);

// Drive the SHIPPED decision function with each real run time as the clock.
// 20:01 UTC = 16:01 ET, i.e. one minute after the bell -> is_open false.
const et08 = utc => {
  const m = /T(\d{2}):(\d{2})/.exec(utc);
  const min = (+m[1] * 60 + +m[2] + 24 * 60 - 4 * 60) % (24 * 60);   // UTC-4
  const hh = String(Math.floor(min / 60)).padStart(2, '0'), mm = String(min % 60).padStart(2, '0');
  return `2026-10-08T${hh}:${mm}:00.000-04:00`;
};
{
  const phases = RUNS_08_OCT.map(u =>
    planEntryWindow(mkClock(et08(u), '2026-10-09T16:00:00-04:00', false)));
  check('W9  WITNESS every 08 Oct run is a CLOSED cycle -> no entry scan, no wait',
    phases.map(p => [p.phase, p.entryScan, p.waitMs]),
    [['closed', false, 0], ['closed', false, 0], ['closed', false, 0]]);
  ok('W10 WITNESS and the PRE-v2.6.1 gate agrees: `clock.open === true` is false on all three',
    phases.every(p => p.marketOpen === false));
}

// -- v2.6.1 DOES look, at T-3 ------------------------------------------------
{
  // The `*/15 13-23` tick that lands inside the window on an EDT day: 19:45 UTC
  // = 15:45 ET, 15 minutes before the 16:00 ET close.
  const p = planEntryWindow(mkClock('2026-10-08T15:45:00.000-04:00', '2026-10-08T16:00:00-04:00'));
  check('W11 v2.6.1 at the in-window tick: wait 12m to T-3, then scan',
    [p.phase, p.entryScan, p.waitMs / 60000, p.minutesToClose, p.submitEtMin],
    ['wait_then_scan', true, 12, 15, 15 * 60 + 57]);
  const after = planEntryWindow(mkClock('2026-10-08T15:57:00.000-04:00', '2026-10-08T16:00:00-04:00'));
  check('W12 ...and on waking at 15:57 ET it scans immediately (3m to the bell)',
    [after.phase, after.entryScan, after.waitMs], ['scan_now', true, 0]);
  ok('W13 THE WITNESS CLOSES: at that moment the same bars still yield the LONG',
    detectEntrySignal(mcdUpTo('2026-10-08'))?.signal === 'long');
}

// -- honesty: what v2.6.1 does NOT fix on this particular day -----------------
{
  // isWithinPPIWindow() reads `new Date()` so it cannot be driven historically;
  // this re-implements its arithmetic (pre-only, <= earningsWindow days) against
  // the COMMITTED PPI list. Labelled as a re-implementation deliberately.
  const ppi = JSON.parse(fs.readFileSync(path.join(SID_DIR, 'event-dates.json'), 'utf8')).ppi;
  const daysAway = (from, to) => (Date.parse(to) - Date.parse(from + 'T12:00:00Z')) / 86400000;
  const blocker = d => ppi.find(x => { const n = daysAway(d, x); return n >= 0 && n <= CONFIG.earningsWindow; });
  check('W14 HONEST LIMIT: 2026-10-08 was inside the 14-day PPI blackout (next PPI 2026-10-15)',
    blocker('2026-10-08'), '2026-10-15');
  check('W15 ...as was 2026-10-05, so MCD would have been PPI-blocked AFTER the scan either way',
    blocker('2026-10-05'), '2026-10-15');
  ok('W16 ...and the PPI gate is still applied in run() (v2.6.1 did not touch it)',
    /isWithinPPIWindow\(CONFIG\.earningsWindow\)/.test(realSrc));
}

// ═══════════════════════════════════════════════════════════════════════════
section('Q. etFields — the broker clock, and the asserted ET offset');

check('Q1  EDT (-04:00) parses to ET minutes + the session date',
  etFields('2026-10-08T15:45:12.000000000-04:00'),
  { minutes: 15 * 60 + 45, isoDate: '2026-10-08', offset: '-04' });
check('Q2  EST (-05:00) parses identically — DST is the broker\'s problem',
  etFields('2026-01-14T17:06:00.000000000-05:00'),
  { minutes: 17 * 60 + 6, isoDate: '2026-01-14', offset: '-05' });
check('Q3  next_close has no fractional seconds and still parses',
  etFields('2026-11-27T13:00:00-05:00'), { minutes: 13 * 60, isoDate: '2026-11-27', offset: '-05' });
check('Q4  a `Z` (UTC) timestamp is REFUSED — never read UTC digits as ET',
  etFields('2026-10-08T19:45:00Z'), null);
check('Q5  a +01:00 offset is refused too', etFields('2026-10-08T19:45:00+01:00'), null);
check('Q6  junk / missing is refused', [etFields(''), etFields(null), etFields('not a date')], [null, null, null]);
{
  // Pin the two ET readers together so they cannot drift apart unnoticed.
  const e = new exec.AlpacaExecutor({ mode: 'paper', client: {}, log: { log() {}, error() {}, warn() {} } });
  const agree = ts => etFields(ts)?.minutes ?? null;
  check('Q7  agrees with alpaca-executor.js#etMinutesOfDay in BOTH offsets and on `Z`',
    ['2026-10-08T15:45:12.000000000-04:00', '2026-01-14T17:06:00.000000000-05:00', '2026-10-08T19:45:00Z']
      .map(ts => [agree(ts), e.etMinutesOfDay({ timestamp: ts })]),
    [[945, 945], [1026, 1026], [null, null]]);
  ok('Q8  ...and both assert the offset rather than assuming it',
    /\(-0\[45\]\):00\$/.test(runSrc) && /\(-0\[45\]\):00\$/.test(execSrc));
}

// ═══════════════════════════════════════════════════════════════════════════
section('P. planEntryWindow — the close window, both DST regimes');

check('P1  defaults are the briefed numbers (20m window, T-3, 30m cap)',
  [CLOSE_WINDOW_MIN, ENTRY_SUBMIT_OFFSET_MIN, MAX_ENTRY_WAIT_MIN], [20, 3, 30]);

const EDT_CLOSE = '2026-10-08T16:00:00-04:00';
const EST_CLOSE = '2026-11-03T16:00:00-05:00';
const pEdt = (hhmm) => planEntryWindow(mkClock(`2026-10-08T${hhmm}:00.000-04:00`, EDT_CLOSE));
const pEst = (hhmm) => planEntryWindow(mkClock(`2026-11-03T${hhmm}:00.000-05:00`, EST_CLOSE));

check('P2  EDT 15:45 (= the 19:45 UTC tick) -> wait 12m, scan',
  [pEdt('15:45').phase, pEdt('15:45').waitMs / 60000], ['wait_then_scan', 12]);
check('P3  EST 15:45 (= the 20:45 UTC tick) -> identical decision, no code change for DST',
  [pEst('15:45').phase, pEst('15:45').waitMs / 60000], ['wait_then_scan', 12]);
check('P4  EDT 15:40 — the window edge is INCLUSIVE (20m to close)',
  [pEdt('15:40').phase, pEdt('15:40').waitMs / 60000, pEdt('15:40').minutesToClose], ['wait_then_scan', 17, 20]);
check('P5  EDT 15:39 — one minute earlier is OUTSIDE: exits only, no scan',
  [pEdt('15:39').phase, pEdt('15:39').entryScan], ['pre_window', false]);
check('P6  EDT 14:15 mid-session -> pre_window, no scan (105m to the bell)',
  [pEdt('14:15').phase, pEdt('14:15').entryScan, pEdt('14:15').minutesToClose], ['pre_window', false, 105]);
check('P7  EDT 15:57 == T-3 exactly -> scan_now, zero wait',
  [pEdt('15:57').phase, pEdt('15:57').waitMs], ['scan_now', 0]);
check('P8  EDT 15:58 (a late tick) -> still scans, immediately',
  [pEdt('15:58').phase, pEdt('15:58').entryScan, pEdt('15:58').waitMs], ['scan_now', true, 0]);
check('P9  EDT 15:59:59 -> 1m left, scans now (better than not at all)',
  [pEdt('15:59').phase, pEdt('15:59').entryScan], ['scan_now', true]);
check('P10 market CLOSED -> no scan, no wait, whatever the time',
  (() => { const p = planEntryWindow(mkClock('2026-10-08T15:45:00-04:00', EDT_CLOSE, false)); return [p.phase, p.entryScan, p.waitMs]; })(),
  ['closed', false, 0]);
check('P11 a null/absent clock is treated as closed (never enter blind)',
  [planEntryWindow(null).entryScan, planEntryWindow(undefined).entryScan, planEntryWindow({}).entryScan],
  [false, false, false]);
check('P12 is_open true but the clock is UNREADABLE (`Z`) -> no scan',
  (() => { const p = planEntryWindow(mkClock('2026-10-08T19:45:00Z', '2026-10-08T20:00:00Z')); return [p.phase, p.entryScan]; })(),
  ['clock_unreadable', false]);
check('P13 is_open true but next_close belongs to ANOTHER session -> no scan',
  (() => { const p = planEntryWindow(mkClock('2026-10-08T15:45:00-04:00', '2026-10-09T16:00:00-04:00')); return [p.phase, p.entryScan]; })(),
  ['clock_unreadable', false]);
check('P14 is_open true but the close is already past -> no scan',
  (() => { const p = planEntryWindow(mkClock('2026-10-08T16:05:00-04:00', EDT_CLOSE)); return [p.phase, p.entryScan]; })(),
  ['past_close', false]);

// -- the real early-close session in Alpaca's calendar -----------------------
{
  const EARLY = '2026-11-27T13:00:00-05:00';   // confirmed via /v2/calendar: close 13:00
  const a = planEntryWindow(mkClock('2026-11-27T12:45:00.000-05:00', EARLY));
  const b = planEntryWindow(mkClock('2026-11-27T12:30:00.000-05:00', EARLY));
  check('P15 EARLY CLOSE 2026-11-27 (13:00 ET): 12:45 is in-window -> wait 12m to 12:57',
    [a.phase, a.waitMs / 60000, a.submitEtMin], ['wait_then_scan', 12, 12 * 60 + 57]);
  check('P16 ...and 12:30 is outside it — the window follows the BROKER\'s close, not a fixed hour',
    [b.phase, b.entryScan], ['pre_window', false]);
}

// -- bounds + overrides ------------------------------------------------------
check('P17 SID_CLOSE_WINDOW_MIN=0 disables entry scans entirely (documented switch)',
  (() => { const p = planEntryWindow(mkClock('2026-10-08T15:45:00-04:00', EDT_CLOSE), { windowMin: 0 }); return [p.phase, p.entryScan]; })(),
  ['window_disabled', false]);
check('P18 a 35m window (the documented redundancy option) waits 27m from 15:30',
  (() => { const p = planEntryWindow(mkClock('2026-10-08T15:30:00-04:00', EDT_CLOSE), { windowMin: 35 }); return [p.phase, p.waitMs / 60000]; })(),
  ['wait_then_scan', 27]);
check('P19 offset T-15 from 15:45 -> wait 0, scan now',
  (() => { const p = planEntryWindow(mkClock('2026-10-08T15:45:00-04:00', EDT_CLOSE), { windowMin: 20, offsetMin: 15 }); return [p.phase, p.waitMs]; })(),
  ['scan_now', 0]);
check('P20 MAX_ENTRY_WAIT_MIN caps an absurd window (600m window, 60m to close -> 30m not 57m)',
  (() => { const p = planEntryWindow(mkClock('2026-10-08T15:00:00-04:00', EDT_CLOSE), { windowMin: 600, offsetMin: 3, maxWaitMin: 30 }); return [p.phase, p.waitMs / 60000]; })(),
  ['wait_then_scan', 30]);
check('P21 offset 0 STILL wakes a minute before the bell — the wait can never reach the close',
  (() => { const p = planEntryWindow(mkClock('2026-10-08T15:45:00-04:00', EDT_CLOSE), { windowMin: 20, offsetMin: 0 }); return [p.waitMs / 60000, p.minutesToClose]; })(),
  [14, 15]);
check('P22 a negative offset is clamped the same way (never sleeps past the close)',
  (() => { const p = planEntryWindow(mkClock('2026-10-08T15:45:00-04:00', EDT_CLOSE), { windowMin: 20, offsetMin: -99 }); return p.waitMs / 60000; })(),
  14);
ok('P23 INVARIANT over every in-window minute, both regimes: wait < minutesToClose',
  (() => {
    for (const mk2 of [pEdt, pEst]) {
      for (let m = 0; m < 20; m++) {
        const hh = String(15 + Math.floor((40 + m) / 60)).padStart(2, '0');
        const mm = String((40 + m) % 60).padStart(2, '0');
        const p = mk2(`${hh}:${mm}`);
        if (!(p.waitMs / 60000 < p.minutesToClose)) return false;
        if (!p.entryScan) return false;
      }
    }
    return true;
  })());

// ═══════════════════════════════════════════════════════════════════════════
section('R. resolveEntryWindow — the SHIPPED control flow, injected clock + fake sleep');

/** Drive the real function. `clocks` are returned in order from readClock(). */
async function drive(clocks, opts = {}) {
  const log = [];
  const slept = [];
  let i = 0;
  const out = await resolveEntryWindow({
    readClock: async () => clocks[Math.min(i++, clocks.length - 1)],
    sleep:     async ms => { slept.push(ms); },     // NO real waiting
    log:       m => log.push(String(m)),
    opts,
  });
  return { ...out, slept, log: log.join('\n'), clockReads: i };
}

{
  const r = await drive([mkRead(mkClock('2026-10-08T15:45:00-04:00', EDT_CLOSE)),
                         mkRead(mkClock('2026-10-08T15:57:00-04:00', EDT_CLOSE))]);
  check('R1  in-window: sleeps once for 12m, re-reads the clock, THEN scans',
    [r.slept, r.clockReads, r.entryScan, r.phase], [[12 * 60000], 2, true, 'scan_now']);
  ok('R2  ...and it says so in the log', /Close window -- waiting 12m/.test(r.log) && /ENTRY SCAN/.test(r.log));
}
{
  const r = await drive([mkRead(mkClock('2026-10-08T14:15:00-04:00', EDT_CLOSE))]);
  check('R3  outside the window: NO sleep, NO entry scan, ONE clock read',
    [r.slept, r.clockReads, r.entryScan, r.phase], [[], 1, false, 'pre_window']);
  ok('R4  ...and the cycle is announced as CHEAP / exits-only', /CHEAP \(SID_EXITS_ONLY/.test(r.log));
}
{
  const r = await drive([mkRead(mkClock('2026-10-08T20:30:00-04:00', '2026-10-09T16:00:00-04:00', false))]);
  check('R5  market closed: no sleep, no scan', [r.slept, r.entryScan, r.phase], [[], false, 'closed']);
}
{
  // THE SAFETY CASE: the bell goes (or a halt closes the session) mid-wait.
  const r = await drive([mkRead(mkClock('2026-10-08T15:45:00-04:00', EDT_CLOSE)),
                         mkRead(mkClock('2026-10-08T16:00:30-04:00', '2026-10-09T16:00:00-04:00', false))]);
  check('R6  SAFETY: market closed during the wait -> entries ABANDONED, not fired into a shut market',
    [r.slept.length, r.entryScan, r.phase], [1, false, 'closed']);
  ok('R7  ...and it is loud about it', /Entry scan ABANDONED/.test(r.log));
}
{
  // Clock becomes unreadable mid-wait (an API change to `Z`).
  const r = await drive([mkRead(mkClock('2026-10-08T15:45:00-04:00', EDT_CLOSE)),
                         mkRead(mkClock('2026-10-08T19:57:00Z', '2026-10-08T20:00:00Z'))]);
  check('R8  SAFETY: clock unreadable after the wait -> abandoned',
    [r.entryScan, r.phase], [false, 'clock_unreadable']);
}
{
  // Clock unavailable entirely after the wait (network blip) -> raw null.
  const r = await drive([mkRead(mkClock('2026-10-08T15:45:00-04:00', EDT_CLOSE)),
                         { open: null, detail: 'clock unavailable: boom', raw: null }]);
  check('R9  SAFETY: clock unavailable after the wait -> abandoned, still exactly one sleep',
    [r.slept.length, r.entryScan], [1, false]);
}
{
  // Early close MOVED forward while we slept (12:45 -> target 12:57, bell now 12:50).
  const r = await drive([mkRead(mkClock('2026-11-27T12:45:00-05:00', '2026-11-27T13:00:00-05:00')),
                         mkRead(mkClock('2026-11-27T12:57:00-05:00', '2026-11-27T12:50:00-05:00'))]);
  check('R10 SAFETY: the close moved EARLIER during the wait -> past_close, abandoned',
    [r.entryScan, r.phase], [false, 'past_close']);
}
{
  // Broker clock goes BACKWARDS. Must not sleep a second time.
  const r = await drive([mkRead(mkClock('2026-10-08T15:45:00-04:00', EDT_CLOSE)),
                         mkRead(mkClock('2026-10-08T15:41:00-04:00', EDT_CLOSE))]);
  check('R11 SAFETY: a backwards clock scans immediately and NEVER sleeps twice',
    [r.slept.length, r.entryScan], [1, true]);
  ok('R12 ...and logs the anomaly', /Clock moved backwards/.test(r.log));
}
{
  const r = await drive([mkRead(mkClock('2026-11-27T12:45:00-05:00', '2026-11-27T13:00:00-05:00')),
                         mkRead(mkClock('2026-11-27T12:57:00-05:00', '2026-11-27T13:00:00-05:00'))]);
  check('R13 EARLY-CLOSE DAY end to end: wait 12m then scan at 12:57 ET',
    [r.slept, r.entryScan, r.phase], [[12 * 60000], true, 'scan_now']);
}
{
  const r = await drive([mkRead(mkClock('2026-10-08T15:45:00-04:00', EDT_CLOSE))], { windowMin: 0 });
  check('R14 SID_CLOSE_WINDOW_MIN=0: no sleep, no scan, exits still managed',
    [r.slept, r.entryScan, r.phase], [[], false, 'window_disabled']);
}
ok('R15 the waiting cycle NEVER sleeps more than once (bounded by construction)',
  (runSrc.match(/await sleep\(/g) || []).length === 1);
ok('R16 the state pull happens AFTER the wait (so the bot runs on fresh cloud state)',
  runSrc.indexOf('const win = await resolveEntryWindow()') < runSrc.indexOf('Pulling state from'));
ok('R17 the entry scan is gated by plan.entryScan, not by market-open alone',
  /\(entryScan \? \{\} : \{ SID_EXITS_ONLY: 'true' \}\)/.test(runSrc));

// ═══════════════════════════════════════════════════════════════════════════
section('S. The cron expression needs NO change — proven, not asserted');

{
  // Every tick of `*/15 13-23 * * 1-5` (UTC), mapped into each session.
  const ticks = [];
  for (let h = 13; h <= 23; h++) for (const m of [0, 15, 30, 45]) ticks.push(h * 60 + m);
  /** @param closeUtcMin  the session close in UTC minutes  @param offUtc  ET = UTC - offUtc */
  const windowHits = (closeUtcMin, offUtcMin, isoDate, offStr) => ticks.filter(t => {
    if (t >= closeUtcMin) return false;                      // after the bell -> market shut
    const etMin = t - offUtcMin;
    const hh = String(Math.floor(etMin / 60)).padStart(2, '0'), mm = String(etMin % 60).padStart(2, '0');
    const ch = String(Math.floor((closeUtcMin - offUtcMin) / 60)).padStart(2, '0');
    const cm = String((closeUtcMin - offUtcMin) % 60).padStart(2, '0');
    const p = planEntryWindow(mkClock(`${isoDate}T${hh}:${mm}:00.000${offStr}`,
                                      `${isoDate}T${ch}:${cm}:00${offStr}`));
    return p.entryScan === true;
  }).map(t => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`);

  check('S1  EDT normal session (close 20:00 UTC): exactly one tick lands in the window',
    windowHits(20 * 60, 4 * 60, '2026-10-08', '-04:00'), ['19:45']);
  check('S2  EST normal session (close 21:00 UTC): exactly one tick, no cron change needed',
    windowHits(21 * 60, 5 * 60, '2026-11-03', '-05:00'), ['20:45']);
  check('S3  EST early close 2026-11-27 (close 18:00 UTC): exactly one tick',
    windowHits(18 * 60, 5 * 60, '2026-11-27', '-05:00'), ['17:45']);
  check('S4  EDT early close (close 17:00 UTC): exactly one tick',
    windowHits(17 * 60, 4 * 60, '2026-07-03', '-04:00'), ['16:45']);
  ok('S5  ...and the cron hour range 13-23 covers every one of those ticks',
    ['19:45', '20:45', '17:45', '16:45'].every(t => { const h = +t.slice(0, 2); return h >= 13 && h <= 23; }));
}
ok('S6  the deploy doc still carries the UNCHANGED cron expression',
  /\*\/15 13-23 \* \* 1-5/.test(fs.readFileSync(path.join(SID_DIR, 'RAILWAY-DEPLOY.md'), 'utf8')));

// ═══════════════════════════════════════════════════════════════════════════
section('T. FIX A — an EXIT must not consume the day\'s entry budget');

{
  const today = todayString();
  // The REAL 2026-10-08 CSV state: one row, HON's stop-out, no entry.
  const HON_EXIT = `2026-10-08,20:02:09,Alpaca/paper,HON,long-extclose,3,204.44,204.23,613.32,-0.75,-0.12,2026-09-10,EXT-HON-1791489729739,paper,SID v2.4.2`;

  /** The PRE-v2.6.1 counter, verbatim from the shipped code it replaced. */
  const oldCountTodayTrades = (text, day) =>
    text.trim().split('\n').slice(1).filter(l => l.startsWith(day)).length;

  check('T1  WITNESS the old counter returns 1 for the 8 Oct CSV — exactly what blocked the run',
    oldCountTodayTrades(`x\n${HON_EXIT}`, '2026-10-08'), 1);
  ok('T2  WITNESS ...and 1 >= the then-default maxPerDay of 1, so run() returned before the scan',
    oldCountTodayTrades(`x\n${HON_EXIT}`, '2026-10-08') >= 1);

  // Now the REAL new counter, against a sandboxed CSV dated today.
  sbTrades([HON_EXIT.replace('2026-10-08', today)]);
  check('T3  FIXED the new counter returns 0 — an exit is not an entry', countTodayEntries(), 0);

  sbTrades([
    HON_EXIT.replace('2026-10-08', today),
    `${today},14:00:00,Alpaca/paper,MCD,long,4,236.90,230,947.60,27.60,0.28,2026-10-07,ord-1,paper,SID v2.6.1`,
  ]);
  check('T4  one real entry alongside the exit counts as exactly 1', countTodayEntries(), 1);

  sbTrades([
    `${today},09:00:00,Alpaca/paper,A,long,1,1,1,1,1,1,d,o,paper,s`,
    `${today},09:01:00,Alpaca/paper,B,short,1,1,1,1,1,1,d,o,paper,s`,
    `${today},09:02:00,V2.1/TP1,C,long-tp1,1,1,1,1,1,1,d,o,paper,s`,
    `${today},09:03:00,V2.1/TP2-sma50_touch,D,long-tp2,1,1,1,1,1,1,d,o,paper,s`,
    `${today},09:04:00,Alpaca/paper,E,short-extclose,1,1,1,1,1,1,d,o,paper,s`,
    `${today},09:05:00,Alpaca/paper,F,short-tp1,1,1,1,1,1,1,d,o,paper,s`,
    `${today},09:06:00,Alpaca/paper,G,short-tp2,1,1,1,1,1,1,d,o,paper,s`,
    `${today},09:07:00,Alpaca/paper,H,long-extclose,1,1,1,1,1,1,d,o,paper,s`,
    `${today},09:08:00,Alpaca/paper,I,long-manualclose,1,1,1,1,1,1,d,o,paper,s`,
    `${today},09:09:00,V2.1/stop,J,long-exit,1,1,1,1,1,1,d,o,paper,s`,
  ]);
  check('T5  EVERY exit suffix in the repo is excluded; only the two bare sides count', countTodayEntries(), 2);
  check('T6  WITNESS the old counter would have said 10 for that same day',
    oldCountTodayTrades([ 'hdr', ...fs.readFileSync(path.join(SANDBOX, 'trades-sid.csv'), 'utf8').trim().split('\n').slice(1) ].join('\n'), today), 10);

  sbTrades([
    `2026-01-02,09:00:00,Alpaca/paper,A,long,1,1,1,1,1,1,d,o,paper,s`,
    `${today},09:00:00,Alpaca/paper,B,long,1,1,1,1,1,1,d,o,paper,s`,
  ]);
  check('T7  other dates are ignored', countTodayEntries(), 1);

  sbTrades(['', '   ', `${today},09:00:00,Alpaca/paper,A,long,1,1,1,1,1,1,d,o,paper,s`, 'garbage']);
  check('T8  blank / malformed rows do not throw and do not count', countTodayEntries(), 1);

  fs.writeFileSync(path.join(SANDBOX, 'trades-sid.csv'), TRADES_HEADER + '\n');
  check('T9  a header-only CSV counts 0', countTodayEntries(), 0);

  ok('T10 the test is POSITIVE (exactly long/short), not a blacklist of exit suffixes',
    /return side === 'long' \|\| side === 'short';/.test(realSrc) &&
    !/-extclose'\)\s*\|\|/.test(realSrc));
  ok('T11 the old name is gone from the whole file (no caller left on the broken counter)',
    !/countTodayTrades\s*\(/.test(realSrc.replace(/\/\/.*$/gm, '')));
}

// ═══════════════════════════════════════════════════════════════════════════
section('U. FIX B — 5 CONCURRENT is the only position limit; no daily cap');

check('U1  default config: no daily cap (0 = unlimited), 5 concurrent',
  [CONFIG.maxPerDay, CONFIG.maxOpenPositions], [0, 5]);
check('U2  flat account, no cap -> budget 5 (the whole concurrent allowance)',
  entryBudgetFor({ openCount: 0, maxOpenPositions: 5, maxPerDay: 0 }),
  { budget: 5, freeSlots: 5, perDayCap: null, dayAllowance: Infinity, reason: 'ok' });
check('U3  3 already open -> budget 2. Entries stop at 5 CONCURRENT, not at a per-day number',
  entryBudgetFor({ openCount: 3, maxOpenPositions: 5, maxPerDay: 0 }).budget, 2);
check('U4  5 open -> budget 0, and the reason is slots, NOT a daily cap',
  (() => { const b = entryBudgetFor({ openCount: 5, maxOpenPositions: 5, maxPerDay: 0 }); return [b.budget, b.reason]; })(),
  [0, 'no_free_slots']);
check('U5  THE CORRECTION: a day on which positions CLOSED still allows entries. 7 exits booked,',
  (() => {
    // 7 exits today, 2 entries today, 2 still open, no cap configured.
    const b = entryBudgetFor({ openCount: 2, maxOpenPositions: 5, maxPerDay: 0, entriesToday: 2 });
    return [b.budget, b.reason];
  })(), [3, 'ok']);
check('U6  ...and even 20 entries already booked today cannot block it when no cap is set',
  entryBudgetFor({ openCount: 1, maxOpenPositions: 5, maxPerDay: 0, entriesToday: 20 }).budget, 4);
check('U7  a NEGATIVE / junk SID_MAX_PER_DAY is also treated as unlimited',
  [entryBudgetFor({ openCount: 0, maxOpenPositions: 5, maxPerDay: -3 }).budget,
   entryBudgetFor({ openCount: 0, maxOpenPositions: 5, maxPerDay: NaN }).budget], [5, 5]);
check('U8  an EXPLICIT cap of 2 still throttles: 1 booked -> 1 left',
  entryBudgetFor({ openCount: 0, maxOpenPositions: 5, maxPerDay: 2, entriesToday: 1 }).budget, 1);
check('U9  ...and when it is spent the reason is daily_cap',
  (() => { const b = entryBudgetFor({ openCount: 0, maxOpenPositions: 5, maxPerDay: 2, entriesToday: 2 }); return [b.budget, b.reason]; })(),
  [0, 'daily_cap']);
check('U10 an explicit cap LARGER than the free slots is clamped by the slots — the cap cannot be breached',
  entryBudgetFor({ openCount: 4, maxOpenPositions: 5, maxPerDay: 99 }).budget, 1);
ok('U11 INVARIANT: budget + openCount <= maxOpenPositions, for every combination',
  (() => {
    for (let open = 0; open <= 7; open++)
      for (const cap of [0, 1, 2, 5, 99, -1])
        for (const done of [0, 1, 5, 20]) {
          const b = entryBudgetFor({ openCount: open, maxOpenPositions: 5, maxPerDay: cap, entriesToday: done });
          if (b.budget + open > Math.max(5, open)) return false;
          if (b.budget < 0) return false;
        }
    return true;
  })());
ok('U12 run() breaks the entry loop on the CLAMPED budget, never the raw maxPerDay',
  /if \(newEntriesThisRun >= entryBudget\) break;/.test(realSrc) &&
  !/newEntriesThisRun >= CONFIG\.maxPerDay/.test(realSrc));
ok('U13 run() only reads the day counter when a cap is actually configured',
  /const entriesToday = perDayCapSet \? countTodayEntries\(\) : 0;/.test(realSrc));
ok('U14 maxOpenPositions is still env-overridable and untouched at 5',
  /maxOpenPositions: parseInt\(process\.env\.SID_MAX_POSITIONS\)\s*\|\|\s*5/.test(realSrc));
{
  // Real runtime proof of the env plumbing, in a child process (ESM caches the
  // module, so this cannot be done by re-importing in-process).
  // bot-sid.js prints a watchlist/macro banner on import, so TAG the value and
  // extract it rather than trusting the whole of stdout.
  const probe = env => {
    const out = execFileSync(process.execPath,
      ['-e', "import('./SID/bot-sid.js').then(m=>process.stdout.write('<MPD:'+m.CONFIG.maxPerDay+'>'))"],
      { cwd: path.join(SID_DIR, '..'), env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return (/<MPD:(-?\d+)>/.exec(out) || [])[1];
  };
  check('U15 RUNTIME: SID_MAX_PER_DAY unset -> 0 (unlimited)', probe({ SID_MAX_PER_DAY: '' }), '0');
  check('U16 RUNTIME: SID_MAX_PER_DAY=3 -> 3 (the override still works, as sid.yml relies on)',
    probe({ SID_MAX_PER_DAY: '3' }), '3');
  check('U17 RUNTIME: SID_MAX_PER_DAY=0 -> 0 (explicitly unlimited)', probe({ SID_MAX_PER_DAY: '0' }), '0');
}

// ═══════════════════════════════════════════════════════════════════════════
section('X. EXITS ARE UNTOUCHED — the v2.6.0 paths must still be exactly as built');

ok('X1  queue-for-open defaults ON', CONFIG.queueExitsForOpen === true);
ok('X2  weekend exit queue defaults ON', CONFIG.weekendExitQueue === true);
ok('X3  exits-only defaults OFF in the BOT (only the runner turns it on per-cycle)',
  CONFIG.exitsOnly === false);
ok('X4  queueExitAtOpen is still the ONLY order submitter without a market-hours guard',
  /DELIBERATELY HAS NO MARKET-HOURS GUARD/.test(execSrc));
ok('X5  ENTRIES still refuse when the market is shut — both entry paths keep their guard',
  (execSrc.match(/Market closed .{0,4} refusing to submit (entry|market entry)/g) || []).length >= 2 ||
  (execSrc.match(/refusing to submit[^\n]*entry/gi) || []).length >= 2);
ok('X6  ...and entries are still NEVER queued for the next open',
  /a stale entry signal must be re-evaluated against a fresh bar/i.test(execSrc) ||
  /ENTRIES ARE NEVER QUEUED/.test(realSrc));
ok('X7  reconcilePendingExits still runs at the TOP of run()',
  realSrc.indexOf('reconcilePendingExits') < realSrc.indexOf('Weekend guard'));
ok('X8  all four exit paths still route through shouldQueueExitForOpen',
  (realSrc.match(/shouldQueueExitForOpen\(/g) || []).length >= 4);
ok('X9  the v2.6.0 exports are all still present',
  ['exitClientOrderId', 'exitTagFor', 'marketIsOpen', 'shouldQueueExitForOpen', 'queueExitForOpen',
   'reconcilePendingExits', 'bookQueuedExitFill', 'PENDING_EXIT_DEAD_STATES']
    .every(k => typeof bot[k] !== 'undefined'));
ok('X10 the cheap cycle still manages positions before skipping the scan (exits are never skipped)',
  realSrc.indexOf('await checkPositions(executor)') < realSrc.indexOf('Entry scan skipped'));
ok('X11 v2.6.1 touched NO exit mechanics: no cancel/wait/close/stop helper call was added or removed',
  (() => {
    const counts = ['cancelAllOpenOrders(', 'waitForNoOpenOrders(', 'cancelOrderById(',
                    'closePartial(', 'closePosition(', 'placeStop(', 'pollOrderFill(', 'queueExitAtOpen(']
      .map(k => (realSrc.split(k).length - 1));
    // Non-zero everywhere == the v2.6.0 machinery is all still wired in.
    return counts.every(c => c > 0);
  })());

// ═══════════════════════════════════════════════════════════════════════════
section('L. Runner shape + safety invariants (restated so this suite stands alone)');

{
  const rsCode = runSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('L1  ONE-SHOT: no resident scheduler (setInterval) and no global setTimeout in the CODE',
    !/setInterval\s*\(/.test(rsCode) && !/\bsetTimeout\s*\(/.test(rsCode));
  ok('L1b ...the ONE wait is an awaited node:timers/promises delay, bounded and used once',
    /from 'node:timers\/promises'/.test(runSrc) && (rsCode.match(/await sleep\(/g) || []).length === 1);
  ok('L2  runCycle is invoked exactly once, behind the import.meta.url main-guard',
    (rsCode.match(/^\s*runCycle\(\)/gm) || []).length === 1 &&
    /const _isDirectRun = import\.meta\.url === pathToFileURL/.test(rsCode));
  ok('L3  hard-fails on a missing env var (exit 1), NAMES only',
    /missing\.push\('ALPACA_KEY_ID'\)/.test(runSrc) && /process\.exit\(1\)/.test(runSrc));
  ok('L4  NO credential literal fallback anywhere',
    !/(ALPACA_SECRET_KEY|ALPACA_KEY_ID|GITHUB_TOKEN)\s*\|\|\s*['"][^'"]+['"]/.test(runSrc));
  ok('L5  NO credential VALUE is ever logged',
    !/console\.log\([^)]*(GITHUB_TOKEN|SECRET_KEY|KEY_ID)/.test(runSrc));
  ok('L6  the window comes from /v2/clock, never a hardcoded session hour',
    /client\.getClock\(\)/.test(runSrc) && /next_close/.test(runSrc) &&
    !/14:30|9:30|hardcode/.test(runSrc.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')));
  ok('L7  a closed market still runs the cheap cycle via SID_EXITS_ONLY', /SID_EXITS_ONLY: 'true'/.test(runSrc));
  ok('L8  an unreadable clock takes the cheap path (never enter blind)',
    /open: null/.test(runSrc) && /const full\s*=\s*clock\.open === true/.test(runSrc));
  ok('L9  state still goes to main, not Ironclad\'s logs branch',
    /SID_STATE_BRANCH \|\| 'main'/.test(runSrc) && !/'logs'/.test(runSrc));
  ok('L10 sha-aware push with a conflict retry survives', /attempt <= 2/.test(runSrc) && /409/.test(runSrc));
  ok('L11 unchanged files are still not pushed', /before\.content === localText\) \{ skipped\+\+/.test(runSrc));
  ok('L12 a bot crash still pushes whatever the bot DID write',
    /Continuing to the state push so nothing the bot DID write is lost/.test(runSrc));
  ok('L13 commit message still distinguishable from the GHA runner\'s', /SID railway run \$\{commitStamp\}/.test(runSrc));

  // The v2.6.1 cosmetic fix.
  const dryLine = (runSrc.split(/\r?\n/).find(l => /if \(DRY_PUSH\)/.test(l) && /continue;/.test(l)) || '');
  ok('L14 FIXED a dry-push cycle counts as SKIPPED, never as pushed',
    /skipped\+\+;/.test(dryLine) && /dry\+\+;/.test(dryLine) && !/pushed\+\+/.test(dryLine));
  ok('L15 ...and the cycle summary reports pushed=0 on a dry push', /DRY_PUSH[\s\S]{0,120}pushed=0/.test(runSrc));

  // sid.yml must keep its three crons (Phase 1) and stage the same state files.
  const yml = fs.readFileSync(path.join(SID_DIR, '..', '.github', 'workflows', 'sid.yml'), 'utf8');
  ok('L16 the GHA crons are NOT disabled (Phase 1)', (yml.match(/^\s*- cron:/gm) || []).length === 3);
  const staged = new Set((yml.match(/git add '?([^'\s]+)'?/g) || [])
    .flatMap(l => l.replace(/git add '?/, '').replace(/'$/, '').split(/\s+/))
    .filter(x => x.startsWith('SID/')));
  const runnerFiles = new Set((runSrc.match(/\{ p: '([^']+)'/g) || []).map(m => m.replace(/\{ p: '/, '').replace(/'$/, '')));
  check('L17 the runner still pushes every state file sid.yml stages',
    [...staged].filter(s => !s.includes('*')).filter(s => !runnerFiles.has(s)), []);

  const rj = JSON.parse(fs.readFileSync(path.join(SID_DIR, 'railway-sid.json'), 'utf8'));
  check('L18 railway-sid.json still starts SID\'s runner', rj.deploy.startCommand, 'node SID/railway-sid-runner.js');
  check('L19 ...and still cannot restart-loop', rj.deploy.restartPolicyType, 'NEVER');

  // --version is the runtime liveness probe.
  const v = execFileSync(process.execPath, ['railway-sid-runner.js', '--version'],
    { cwd: SID_DIR, encoding: 'utf8' }).trim();
  check('L20 RUNTIME: `node railway-sid-runner.js --version` reports v2.6.1',
    v, 'SID Railway cron runner v2.6.1');
}

// ═══════════════════════════════════════════════════════════════════════════
section('D. Docs follow the code (the ship-check, asserted)');

{
  const doc = fs.readFileSync(path.join(SID_DIR, 'RAILWAY-DEPLOY.md'), 'utf8');
  ok('D1  the deploy doc documents all three new variables',
    /SID_CLOSE_WINDOW_MIN/.test(doc) && /SID_ENTRY_SUBMIT_OFFSET_MIN/.test(doc) && /SID_MAX_ENTRY_WAIT_MIN/.test(doc));
  ok('D2  ...and states whether the cron expression needs changing', /DOES THE CRON EXPRESSION NEED CHANGING/.test(doc));
  ok('D3  ...and explains what happens to the tick that fires during the wait',
    /Railway skips it/.test(doc) && /skipped tick would have been an \*\*exit\*\* cycle/.test(doc));
  ok('D4  ...and documents the SID_MAX_PER_DAY deploy action (delete it if set to 1)',
    /DELETE it/.test(doc) && /SID_MAX_PER_DAY/.test(doc));
  ok('D5  ...and still carries no credential VALUE (names only)',
    /NAMES ONLY/.test(doc) && !/\bPK[A-Z0-9]{10,}\b/.test(doc) && !/\bgh[pousr]_[A-Za-z0-9]{20,}\b/.test(doc));
  ok('D6  ...and keeps the v2.6.0 Phase 2 + fallback sections',
    /Phase 2 — retire the GitHub Actions crons/.test(doc) && /If Railway cron proves unreliable/.test(doc));
  ok('D7  the doc header is v2.6.1', /^# SID on Railway — deploy guide \(v2\.6\.1\)/m.test(doc));

  const rd = fs.readFileSync(path.join(SID_DIR, 'SID-README.md'), 'utf8');
  ok('D8  README current-version line is v2.6.1', /\*\*Current version:\*\* v2\.6\.1/.test(rd));
  ok('D9  README has a v2.6.1 Version History row above v2.6.0',
    rd.indexOf('| v2.6.1 | 24 Oct 2026 |') > -1 &&
    rd.indexOf('| v2.6.1 | 24 Oct 2026 |') < rd.indexOf('| v2.6.0 | 24 Oct 2026 |'));
  ok('D10 README states the no-daily-cap / 5-concurrent rule', /the only position limit/i.test(rd));

  const upd = JSON.parse(fs.readFileSync(path.join(SID_DIR, 'strategy-updates.json'), 'utf8'));
  ok('D11 strategy-updates.json has a RELEASE entry at the TOP for v2.6.1',
    upd[0].category === 'release' && /^V2\.6\.1/.test(upd[0].title) && upd[0].date === '2026-10-24');
  ok('D12 ...and the count badge (derived from array length) incremented to 31', upd.length === 31);
  ok('D13 ...and it is written for a non-technical reader (no code identifiers in the summary)',
    !/countTodayEntries|planEntryWindow|maxPerDay|SID_CLOSE_WINDOW_MIN/.test(upd[0].summary));

  ok('D14 the fixture carries a provenance README (so the data can be re-derived)',
    fs.existsSync(path.join(FIXTURES, 'README.md')) &&
    /query1\.finance\.yahoo\.com|fetchDailyCandles/.test(fs.readFileSync(path.join(FIXTURES, 'README.md'), 'utf8')));
}

// ═══════════════════════════════════════════════════════════════════════════
section('M. Segregation — no other strategy\'s file was touched');

{
  const root = path.join(SID_DIR, '..');
  for (const f of ['railway-runner.js', 'railway.json']) {
    const t = fs.readFileSync(path.join(root, f), 'utf8');
    ok(`M1[${f}] Ironclad's Railway file is untouched by SID`, !/sid/i.test(t.replace(/considered/gi, '')));
  }
  check('M2  the repo-root railway.json still starts IRONCLAD\'s runner',
    JSON.parse(fs.readFileSync(path.join(root, 'railway.json'), 'utf8')).deploy.startCommand,
    'node railway-runner.js');
  ok('M3  SID\'s runner does not reference Ironclad / VWAP / Maven files',
    !/railway-runner\.js'|bot-ironclad|rules-ironclad|hype-state|'bot\.js'|maven/i.test(
      runSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')));
}

// ── Teardown ────────────────────────────────────────────────────────────────
fs.rmSync(SANDBOX, { recursive: true, force: true });
ok('Z1  sandbox removed (no real state file was ever touched)', !fs.existsSync(SANDBOX));
check('Z2  ...and the real trades-sid.csv still has its live row count',
  fs.readFileSync(path.join(SID_DIR, 'trades-sid.csv'), 'utf8').trim().split('\n').length > 20, true);

console.log(`\n${'='.repeat(60)}`);
console.log(`RESULT: ${pass} passed, ${fail} failed, ${pass + fail} total`);
if (fail) { console.log('FAILURES:'); for (const f of failures) console.log('  - ' + f); }
console.log('='.repeat(60));
process.exit(fail ? 1 : 0);
