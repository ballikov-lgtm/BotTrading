import 'dotenv/config';
import fetch from 'node-fetch';
import fs from 'fs';

import { createExecutor, resolveTradingMode } from './alpaca-executor.js';
import * as tg from './telegram-alerts.js';

// ── Config ────────────────────────────────────────────────────────────────────

const CONFIG = {
  accountUsd:       parseFloat(process.env.SID_ACCOUNT_USD)     || 10000,  // V2 paper start ($10K matches backtest)
  riskPct:          parseFloat(process.env.SID_RISK_PCT)         || 0.01,   // V2 default 1% per instructor S3_Ep4
  maxPositionPct:   parseFloat(process.env.SID_MAX_POS_PCT)      || 0.10,   // 10% of account max per trade
  maxOpenPositions: parseInt(process.env.SID_MAX_POSITIONS)      || 3,      // Never hold more than 3 at once
  maxPerDay:        parseInt(process.env.SID_MAX_PER_DAY)        || 1,      // Max new entries per run
  earningsWindow:   parseInt(process.env.SID_EARNINGS_WINDOW)    || 14,     // Skip if earnings within N days
  rsiNoGoLong:      parseFloat(process.env.SID_RSI_NOGO_LONG)    || 45,     // V2: reject long entry if RSI >= this
  rsiNoGoShort:     parseFloat(process.env.SID_RSI_NOGO_SHORT)   || 55,     // V2: reject short entry if RSI <= this
  useWeeklyDirection: process.env.SID_WEEKLY_DIRECTION !== 'false',         // V2: require weekly RSI OR MACD to align with trade direction (default ON)
  paperTrading:     process.env.SID_PAPER !== 'false',                       // legacy flag — still honoured for trade-log labelling
  tradingMode:      resolveTradingMode(),                                    // 'dry_run' | 'paper' | 'live' — controls Alpaca execution
  // V2.1 dynamic-TP parameters ──────────────────────────────────────────────
  tp1Portion:       parseFloat(process.env.SID_TP1_PORTION)      || 0.50,   // V2.1: fraction of position closed at TP1 (RSI 50)
  tp2TimeoutDays:   parseInt(process.env.SID_TP2_TIMEOUT_DAYS)   || 30,     // V2.1: max trading days to hold remaining 50% after TP1
  useDynamicTp:     process.env.SID_DYNAMIC_TP !== 'false',                  // V2.1: enable TP1+TP2 partial exits (default ON). Set false to revert to v2.0 single-exit behaviour.
};

// ── V2 Approval Tiers (see SID/docs/V2-TELEGRAM-APPROVAL-SPEC.md) ────────────
// AUTO: 80 tickers proven via 5y V1 backtest — bot fires automatically
// HUMAN: 32 high-vol/crypto/new — Telegram approval required (deferred to v2.1)
const AUTO_APPROVED_TICKERS = new Set([
  'AAPL','ABBV','ABT','ADBE','AMAT','AMD','AMZN','AVGO','AXP','B',
  'BA','BLK','CAT','COST','CRM','CVX','DE','DIA','DIS','EEM',
  'EFA','F','GDX','GE','GLD','GOOG','GS','HD','HON','IBB',
  'IBM','INTC','IWM','IYR','JNJ','JPM','KHC','LLY','LMT','LRCX',
  'MCD','MDLZ','META','MRK','NKE','NOW','NUGT','NVDA','ORCL','PFE',
  'PYPL','QQQ','RIOT','RTX','SBUX','SCHW','SLV','SPY','SQQQ','TGT',
  'TNA','TQQQ','TSLA','TZA','UNH','V','WFC','WMT','XHB','XLC',
  'XLE','XLF','XLI','XLK','XLP','XLRE','XLU','XLV','XLY','XOM',
]);

// ── Bot identity ──────────────────────────────────────────────────────────────
const BOT_NAME    = 'SID';
const BOT_VERSION = 'v2.1'; // V2.1: dynamic TP1+TP2 partial exits (paper trading, 2026-05-18)
// Version history:
//   v1.0 initial RSI(14) + MACD(12,26,9), daily, US stocks/ETFs
//   v1.1 15-min intraday entry confirmation
//   v1.2 instructor-aligned: sticky RSI signal, MACD direction-align entry
//   v1.3 RSI overbought 70->75, RSI(3) rebound-zone confirm
//   v1.4 weekly 50/200 SMA trend filter (locked at tag sid-v1.4-baseline)
//   v1.5 earnings rule clarified to pre-only (block 14 days BEFORE earnings)
//   v1.6 PPI blackout + REFINED 47 watchlist (locked at tag sid-v1.6-baseline)
//   v1.7 VIX >= 30 gate + 80-ticker tier1 expansion (locked at sid-v1-method-baseline)
//   v2.1 V2.1 DYNAMIC TP LAUNCH (2026-05-18, paper trading):
//        - Entry rules unchanged from v2.0 (v2-weekly-or remains the entry stack)
//        - NEW EXIT MODEL — TP1 + TP2 partial exits per instructor S3_P1 / S3_P2:
//          • TP1 = RSI 50 → close 50% of position. Move stop to break-even on
//            remaining 50%. Locks in the half-position profit guaranteed by
//            the v2.0 exit while keeping a runner for the bigger move.
//          • TP2 = whichever fires first on the remaining 50%:
//              - Price touches 50-day SMA (instructor's "first MA target")
//              - Price touches 200-day SMA (instructor's "trend MA target")
//              - Break-even stop hit (price returns to entry)
//              - 30-trading-day timeout (close at next-day open)
//        - Backtest validation on tier1 80-ticker AUTO universe, 5 years
//          (1% risk per trade, fixed $200 risk in the simulator):
//            V2.0 baseline: 296 trades, 70.3% WR, PF 2.57, total +$26,750
//            V2.1 dynamic : 302 trades, 69.5% WR, PF 2.55, total +$28,046
//          V2.1 BEATS V2 by +$1,296 (+4.8%) over 5 years with essentially the
//          same trade count. TP2 uplift on winners is +$24,733 (+115% more
//          than what V2 captures by closing fully at RSI 50). The 14-day-
//          timeout variant adds another +$403 (+0.1pp WR).
//          NOTE: an earlier version of the V2.1 backtest reported only 67
//          trades / +$7,759 — that was a data-window bug (insufficient
//          indicator warmup) in the backtest's main() loop, not a strategy
//          issue. Fixed 2026-05-18 to match V2's 10y download (5y warmup +
//          5y trade window). The live bot's entry detection in this file
//          was always correct.
//        - SCHEMA CHANGE — open-positions-sid.json entries gain:
//            tp1_hit, tp1_date, tp1_price, tp1_shares, tp1_pnl, tp1_idx,
//            shares_total, shares_remaining, orig_stop
//          Legacy v2.0 positions are upgraded on first read (tp1_hit=false).
//        - SCHEMA CHANGE — closed-positions-sid.json adds:
//            tp1_*, tp2_*, total_pnl, exit_strategy
//        - Toggle: SID_DYNAMIC_TP=false reverts to v2.0 single-exit at RSI 50.
//        - DEFERRED to v2.2: Rating engine, short counter-trend gate, Telegram
//          approval flow for HUMAN tier, dashboard Signal Watch widget.
//   v2.0 V2 METHOD LAUNCH (2026-05-16, paper trading):
//        - RSI 70 not 75 (already in bot from v1.3)
//        - NEW: RSI 45/55 no-go zone at entry (instructor S2_Ep3)
//        - NEW: 1% risk default (instructor S3_Ep4)
//        - NEW: AUTO/HUMAN tier routing — HUMAN tier currently LOG-only,
//          Telegram approval flow deferred to v2.1
//        - NEW: PDT-IMMUNE DESIGN — bot manages stops itself instead of
//          submitting Alpaca stop orders. Stop checks happen on each daily
//          run; if breached, the bot submits a market close at next-day
//          open. Guarantees entry and exit are on different calendar days
//          → no day trades ever → no PDT classification at sub-$25K
//          accounts. Trade-off: stop fills at next-morning open price,
//          ±1-2% slippage vs the exact stop level.
//        - NEW: WEEKLY RSI / MACD DIRECTION CHECK at entry (OR mode):
//          require either weekly RSI rising OR weekly MACD rising for
//          longs (mirror for shorts). Resampling groups daily candles by
//          their Monday-key so the in-progress week is addressable. This
//          completes the full V2 method (v2-weekly-or backtest variant):
//          64.9% WR / PF 2.04 / 34.7% CAGR / 7.95% max DD over 5y on
//          113-ticker universe.
//        - Toggle: SID_WEEKLY_DIRECTION=false to disable the weekly gate
//          (falls back to v2-nogo-only behaviour: ~56% WR / more trades).
//        - DEFERRED to v2.1: Telegram approval flow for HUMAN-tier signals
//          (currently LOG-only).

const TRADES_PATH     = './trades-sid.csv';
const POSITIONS_PATH  = './open-positions-sid.json';
const CLOSED_PATH     = './closed-positions-sid.json';
const ACCOUNT_PATH    = './sid-account.json';
const SAFETY_LOG_PATH = './sid-log.json';
const WATCHLIST_PATH  = './watchlist-sid.json';
const EVENT_DATES_PATH= './event-dates.json';

// ── Watchlist (loaded from watchlist-sid.json — currently REFINED 47) ─────────
// The watchlist file is the canonical trade list. Edit watchlist-sid.json's
// top-level `tickers` array to change what the bot trades; the bot picks it up
// automatically on the next run. Falls back to a hardcoded list if the file is
// missing / malformed (so the bot is robust to deploy issues).
const HARDCODED_FALLBACK_WATCHLIST = [
  'DIA','IWM','QQQ','SPY','AAPL','AMD','AMZN','BA','CAT','COST',
  'DIS','GOOG','GS','HD','IBM','INTC','JPM','META','MCD','PYPL',
  'TGT','TSLA','WMT','XLC','XLE','XLF','XLI','XLK','XLP','XLRE','XLU','XLV','XLY',
];
function loadWatchlist() {
  try {
    const j = JSON.parse(fs.readFileSync(WATCHLIST_PATH, 'utf8'));
    if (Array.isArray(j.tickers) && j.tickers.length > 0) {
      console.log(`Watchlist : loaded ${j.tickers.length} tickers from ${WATCHLIST_PATH} (version ${j.version || '?'})`);
      return j.tickers;
    }
  } catch (err) {
    console.warn(`⚠  Could not load ${WATCHLIST_PATH}: ${err.message} — using hardcoded fallback`);
  }
  return HARDCODED_FALLBACK_WATCHLIST;
}
const WATCHLIST = loadWatchlist();

// ── Macro event dates (PPI only — FOMC/CPI tested and REJECTED in backtest) ──
// PPI dates are loaded from event-dates.json. The 14-day PRE-PPI blackout
// blocks ARMING during the run-up to a PPI release; trading is permitted
// the day after each release.
//
// FOMC and CPI windows were tested in the v1.7 validation backtest and found
// to be HARMFUL (drops WR from 60% -> 49% on 5-year favourites sample). They
// are intentionally NOT consumed by the bot even though the dates are in the
// event-dates.json file (preserved for future research).
function loadPPIDates() {
  try {
    const j = JSON.parse(fs.readFileSync(EVENT_DATES_PATH, 'utf8'));
    if (Array.isArray(j.ppi)) {
      console.log(`Macro     : loaded ${j.ppi.length} PPI dates from ${EVENT_DATES_PATH}`);
      return j.ppi;
    }
  } catch (err) {
    console.warn(`⚠  Could not load PPI dates from ${EVENT_DATES_PATH}: ${err.message} — PPI filter disabled`);
  }
  return [];
}
const PPI_DATES = loadPPIDates();

// ── v1.7 VIX gate ────────────────────────────────────────────────────────────
// Block new entries on high-fear days (VIX >= 30). VIX is the market's
// implied-volatility / fear index — when it spikes, indices are pricing in
// big moves. Historically, oversold bounces during VIX>=30 regimes are
// disproportionately false bounces (e.g. Sept 2022 FOMC + UK crisis cluster
// in our backtest). The gate doesn't close existing positions — it only
// blocks new ARMing for the day.
//
// Per-run check: bot wakes once a day, checks yesterday's VIX close. If
// >= 30, no new entries today. Tomorrow morning: re-check fresh.
const VIX_GATE_THRESHOLD = 30.0;

async function fetchVixYesterdayClose() {
  // Fetches VIX history and returns most-recent close + ISO date.
  // Returns { vix: number, date: string } or null on failure.
  try {
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/^VIX?interval=1d&range=10d';
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const result = json?.chart?.result?.[0];
    if (!result) throw new Error('no chart data');
    const ts = result.timestamp || [];
    const closes = result.indicators?.quote?.[0]?.close || [];
    // Find most recent non-null close
    for (let i = ts.length - 1; i >= 0; i--) {
      if (closes[i] != null && !isNaN(closes[i])) {
        return {
          vix: parseFloat(closes[i].toFixed(2)),
          date: new Date(ts[i] * 1000).toISOString().slice(0, 10),
        };
      }
    }
    return null;
  } catch (err) {
    console.warn(`⚠  VIX fetch failed: ${err.message} — VIX gate skipped (trade normally)`);
    return null;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function todayString() {
  return new Date().toISOString().slice(0, 10);
}

function writeLog(entry) {
  let log = [];
  if (fs.existsSync(SAFETY_LOG_PATH)) {
    try { log = JSON.parse(fs.readFileSync(SAFETY_LOG_PATH, 'utf8')); } catch {}
  }
  log.unshift({ timestamp: new Date().toISOString(), ...entry });
  fs.writeFileSync(SAFETY_LOG_PATH, JSON.stringify(log.slice(0, 500), null, 2));
}

function appendTrade(row) {
  const header = 'Date,Time,Exchange,Symbol,Side,Shares,Entry Price,Stop Loss,Total USD,Risk USD,Risk %,Signal Date,Order ID,Mode,Strategy';
  if (!fs.existsSync(TRADES_PATH)) fs.writeFileSync(TRADES_PATH, header + '\n');
  fs.appendFileSync(TRADES_PATH, row + '\n');
}

function countTodayTrades() {
  if (!fs.existsSync(TRADES_PATH)) return 0;
  const today = todayString();
  const lines = fs.readFileSync(TRADES_PATH, 'utf8').trim().split('\n');
  return lines.slice(1).filter(l => l.startsWith(today)).length;
}

// ── Compounding Account State ─────────────────────────────────────────────────
// The account value grows (or shrinks) with every closed trade.
// Position sizing always uses the CURRENT account value so gains compound
// automatically over time. Starting value is $5,000; each exit updates the balance.

function loadAccount() {
  try {
    if (fs.existsSync(ACCOUNT_PATH)) return JSON.parse(fs.readFileSync(ACCOUNT_PATH, 'utf8'));
  } catch {}
  // First run — seed with the configured starting amount
  const initial = {
    accountUsd:    CONFIG.accountUsd,
    startingUsd:   CONFIG.accountUsd,
    realizedPnl:   0,
    tradeCount:    0,
    lastUpdated:   todayString(),
  };
  fs.writeFileSync(ACCOUNT_PATH, JSON.stringify(initial, null, 2));
  return initial;
}

function updateAccount(realizedPnl) {
  const account      = loadAccount();
  account.accountUsd  = parseFloat((account.accountUsd + realizedPnl).toFixed(2));
  account.realizedPnl = parseFloat((account.realizedPnl + realizedPnl).toFixed(2));
  account.tradeCount += 1;
  account.lastUpdated = todayString();
  fs.writeFileSync(ACCOUNT_PATH, JSON.stringify(account, null, 2));
  return account;
}

// ── Position Tracking ─────────────────────────────────────────────────────────

function loadOpenPositions() {
  try {
    if (fs.existsSync(POSITIONS_PATH)) return JSON.parse(fs.readFileSync(POSITIONS_PATH, 'utf8'));
  } catch {}
  return [];
}

function saveOpenPositions(p) {
  fs.writeFileSync(POSITIONS_PATH, JSON.stringify(p, null, 2));
}

function loadClosedPositions() {
  try {
    if (fs.existsSync(CLOSED_PATH)) return JSON.parse(fs.readFileSync(CLOSED_PATH, 'utf8'));
  } catch {}
  return [];
}

function saveClosedPositions(p) {
  fs.writeFileSync(CLOSED_PATH, JSON.stringify(p, null, 2));
}

function addOpenPosition(pos) {
  const open = loadOpenPositions();
  if (open.some(p => p.id === pos.id)) return;
  open.push(pos);
  saveOpenPositions(open);
}

// ── Market Data (Yahoo Finance — no API key needed) ───────────────────────────

async function fetchDailyCandles(symbol, range = '6mo') {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=${range}`;
  const res  = await fetch(url, {
    headers: {
      'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Accept':          'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(`No chart data returned`);

  const timestamps = result.timestamp || [];
  const q = result.indicators.quote[0];

  return timestamps
    .map((ts, i) => ({
      time:   ts * 1000,
      date:   new Date(ts * 1000).toISOString().slice(0, 10),
      open:   q.open[i],
      high:   q.high[i],
      low:    q.low[i],
      close:  q.close[i],
      volume: q.volume[i],
    }))
    .filter(c => c.close !== null && c.close !== undefined && !isNaN(c.close));
}

// ── Earnings Date Check ───────────────────────────────────────────────────────
// Skip any trade if an earnings date falls within the CONFIG.earningsWindow.
// Uses Yahoo Finance's quoteSummary — no API key required.

async function fetchEarningsDates(symbol) {
  try {
    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${symbol}?modules=calendarEvents`;
    const res  = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    });
    const json = await res.json();
    const dates = json?.quoteSummary?.result?.[0]?.calendarEvents?.earnings?.earningsDate || [];
    return dates.map(d => d.fmt || new Date(d.raw * 1000).toISOString().slice(0, 10));
  } catch {
    return []; // If check fails, let the trade through with a warning
  }
}

function isWithinEarningsWindow(earningsDates, windowDays) {
  // v1.5 rule clarification — block trade ONLY if earnings is within the
  // next `windowDays` calendar days (i.e., we're inside the pre-earnings
  // window). Past earnings dates no longer block — trading the day after
  // earnings is permitted and is in fact often a high-confidence entry
  // because the announcement risk has just been removed.
  const today = new Date();
  for (const dateStr of earningsDates) {
    const earningsDate = new Date(dateStr);
    const daysFromNow = (earningsDate - today) / (1000 * 60 * 60 * 24);
    if (daysFromNow >= 0 && daysFromNow <= windowDays) {
      return { blocked: true, date: dateStr, daysAway: Math.round(daysFromNow) };
    }
  }
  return { blocked: false };
}

function isWithinPPIWindow(windowDays) {
  // v1.6 macro filter — block trading 14 days BEFORE a PPI release.
  // Same logic as earnings: pre-only (allow day after).
  // Backtest evidence (v1.7 validation): PPI lift on REFINED 47 watchlist
  // takes WR from 66.9% to 74.8% with PF jumping 2.11 -> 3.20.
  const today = new Date();
  for (const dateStr of PPI_DATES) {
    const eventDate = new Date(dateStr);
    const daysFromNow = (eventDate - today) / (1000 * 60 * 60 * 24);
    if (daysFromNow >= 0 && daysFromNow <= windowDays) {
      return { blocked: true, date: dateStr, daysAway: Math.round(daysFromNow) };
    }
  }
  return { blocked: false };
}

// ── Indicators ────────────────────────────────────────────────────────────────

// RSI(14) using Wilder's smoothing method
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return closes.map(() => null);
  const result = new Array(period).fill(null);

  // Seed: simple average of first `period` changes
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff;
    else avgLoss += Math.abs(diff);
  }
  avgGain /= period;
  avgLoss /= period;

  const rsi0 = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  result.push(parseFloat(rsi0.toFixed(2)));

  // Wilder smoothing for remaining candles
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0))  / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
    const rs  = avgLoss === 0 ? 100 : avgGain / avgLoss;
    result.push(parseFloat((100 - 100 / (1 + rs)).toFixed(2)));
  }
  return result;
}

// EMA with standard multiplier
function calcEMAArray(values, period) {
  const k = 2 / (period + 1);
  const result = [];
  let ema = null;
  for (const v of values) {
    if (v === null || v === undefined || isNaN(v)) { result.push(null); continue; }
    ema = ema === null ? v : v * k + ema * (1 - k);
    result.push(parseFloat(ema.toFixed(6)));
  }
  return result;
}

// MACD(12, 26, 9) — default TradingView settings, histogram hidden per strategy
function calcMACD(closes) {
  const ema12    = calcEMAArray(closes, 12);
  const ema26    = calcEMAArray(closes, 26);
  const macdLine = ema12.map((v, i) => (v !== null && ema26[i] !== null) ? parseFloat((v - ema26[i]).toFixed(6)) : null);
  const signal   = calcEMAArray(macdLine, 9);
  return { macdLine, signal };
}

// Simple Moving Average — used for V2.1 TP2 detection (50d and 200d MAs).
// Returns an array of the same length as `values`; entries before `period`
// bars of history are null.
function calcSMA(values, period) {
  const result = [];
  let sum = 0;
  let count = 0;
  const window = [];
  for (const v of values) {
    if (v === null || v === undefined || isNaN(v)) {
      result.push(null);
      // Keep window in sync so we don't drift; treat missing as a reset
      continue;
    }
    window.push(v);
    sum += v;
    count++;
    if (window.length > period) {
      sum -= window.shift();
      count--;
    }
    result.push(window.length === period ? parseFloat((sum / period).toFixed(6)) : null);
  }
  return result;
}

// ── Weekly Resampling & Direction Check (V2 method) ───────────────────────────
// Groups daily candles by their week's Monday-key so the IN-PROGRESS week is
// addressable. The current week's "close" is the most recent daily close
// (so the weekly indicator reflects the partial week's data, matching the
// backtest's Friday-resample-then-shift-back-to-Monday alignment).

function resampleWeekly(candles) {
  if (!candles || candles.length === 0) return [];
  const byWeek = new Map();
  for (const c of candles) {
    if (c.close === null || c.close === undefined || isNaN(c.close)) continue;
    const d = new Date(c.date);
    const day = d.getUTCDay();                // 0=Sun, 1=Mon, ..., 6=Sat
    const mondayOffset = day === 0 ? -6 : 1 - day;
    d.setUTCDate(d.getUTCDate() + mondayOffset);
    const key = d.toISOString().slice(0, 10); // YYYY-MM-DD of that week's Monday
    // Iteration is chronological → the last daily close in each week wins.
    byWeek.set(key, c.close);
  }
  const keys = Array.from(byWeek.keys()).sort();
  return keys.map(k => ({ date: k, close: byWeek.get(k) }));
}

// V2 weekly direction check. Returns:
//   { rsiRising, macdRising, weeklyRsi, weeklyMacd, enoughHistory }
// rising/falling are computed as this-week's-partial value vs the prior
// fully-formed weekly value (week-over-week 1-bar slope).
function weeklyDirection(candles) {
  const weekly = resampleWeekly(candles);
  if (weekly.length < 30) {
    return { rsiRising: null, macdRising: null, enoughHistory: false };
  }
  const closes = weekly.map(w => w.close);
  const rsiArr = calcRSI(closes);
  const { macdLine } = calcMACD(closes);
  const n = closes.length;
  const lastRsi  = rsiArr[n - 1];
  const prevRsi  = rsiArr[n - 2];
  const lastMacd = macdLine[n - 1];
  const prevMacd = macdLine[n - 2];
  if (lastRsi == null || prevRsi == null || lastMacd == null || prevMacd == null) {
    return { rsiRising: null, macdRising: null, enoughHistory: false };
  }
  return {
    rsiRising:    lastRsi  > prevRsi,
    macdRising:   lastMacd > prevMacd,
    weeklyRsi:    lastRsi,
    weeklyMacd:   lastMacd,
    enoughHistory: true,
  };
}

// ── Signal Detection ──────────────────────────────────────────────────────────
// Returns a signal object or null.
// Logic follows the SID V2 method checklist:
//   1. RSI went below 30 (oversold signal) — note the signal date
//   2. RSI & MACD both pointing in same direction today
//   3. V2: RSI at entry < 45 (long) / > 55 (short) — no-go zone
//   4. V2: Weekly RSI OR Weekly MACD aligned with trade direction
//   5. Stop = lowest low (signal date → entry date) rounded to whole dollar
//   6. Take profit: RSI reaches 50 (monitored separately)

function detectEntrySignal(candles) {
  const closes = candles.map(c => c.close);
  const rsiArr = calcRSI(closes);
  const { macdLine } = calcMACD(closes);

  const n = closes.length;
  const rsiNow  = rsiArr[n - 1];
  const rsiPrev = rsiArr[n - 2];
  const macdNow  = macdLine[n - 1];
  const macdPrev = macdLine[n - 2];

  if (!rsiNow || !rsiPrev || !macdNow || !macdPrev) return null;

  // ── Long setup: RSI was oversold (<30), now both RSI and MACD pointing UP ───
  // Find the most recent oversold episode start (RSI crossing below 30)
  let oversoldIdx = null;
  for (let i = n - 1; i >= 1; i--) {
    if (rsiArr[i] === null) continue;
    // If RSI is back above 50, the episode is over — stop looking
    if (rsiArr[i] >= 50 && i < n - 1) { oversoldIdx = null; break; }
    if (rsiArr[i] < 30 && (rsiArr[i - 1] === null || rsiArr[i - 1] >= 30)) {
      oversoldIdx = i; // First candle of the oversold episode
      break;
    }
  }

  if (oversoldIdx !== null && rsiNow > rsiPrev && macdNow > macdPrev) {
    // Both RSI and MACD pointing up — valid long entry (V1 logic)
    // V2 no-go zone: reject if RSI already too close to RSI 50 (instructor S2_Ep3)
    if (rsiNow >= CONFIG.rsiNoGoLong) {
      return {
        signal: null,
        rejectReason: `V2 no-go zone: RSI ${rsiNow.toFixed(1)} >= ${CONFIG.rsiNoGoLong} for long entry (too close to RSI 50 TP)`,
      };
    }
    // V2 weekly direction (OR mode): require weekly RSI OR weekly MACD rising.
    // Best WR/PF/CAGR combo in the backtest (v2-weekly-or = 64.9% WR over 5y).
    if (CONFIG.useWeeklyDirection) {
      const wk = weeklyDirection(candles);
      if (!wk.enoughHistory) {
        return {
          signal: null,
          rejectReason: `V2 weekly direction: insufficient weekly history (need 30+ weeks)`,
        };
      }
      if (!(wk.rsiRising || wk.macdRising)) {
        return {
          signal: null,
          rejectReason: `V2 weekly direction: both weekly RSI (${wk.weeklyRsi?.toFixed(1)}) and MACD (${wk.weeklyMacd?.toFixed(4)}) falling — RED FLAG for long`,
        };
      }
    }
    const signalDate  = candles[oversoldIdx].date;
    const episodeCandles = candles.slice(oversoldIdx); // Signal date → today
    const lowestLow   = Math.min(...episodeCandles.map(c => c.low));
    const stopLoss    = Math.floor(lowestLow);         // Rounded DOWN to whole dollar

    return {
      signal:     'long',
      entry:      closes[n - 1],
      stopLoss,
      signalDate,
      entryDate:  candles[n - 1].date,
      rsiAtEntry: rsiNow,
      rsiAtSignal: rsiArr[oversoldIdx],
      reason:     `RSI oversold (${rsiArr[oversoldIdx]}) on ${signalDate} → RSI(${rsiNow.toFixed(1)}) & MACD both pointing up`,
    };
  }

  // ── Short setup: RSI was overbought (>70), now both RSI and MACD pointing DOWN
  let overboughtIdx = null;
  for (let i = n - 1; i >= 1; i--) {
    if (rsiArr[i] === null) continue;
    if (rsiArr[i] <= 50 && i < n - 1) { overboughtIdx = null; break; }
    if (rsiArr[i] > 70 && (rsiArr[i - 1] === null || rsiArr[i - 1] <= 70)) {
      overboughtIdx = i;
      break;
    }
  }

  if (overboughtIdx !== null && rsiNow < rsiPrev && macdNow < macdPrev) {
    // V2 no-go zone: reject if RSI too close to RSI 50 (mirror of long check)
    if (rsiNow <= CONFIG.rsiNoGoShort) {
      return {
        signal: null,
        rejectReason: `V2 no-go zone: RSI ${rsiNow.toFixed(1)} <= ${CONFIG.rsiNoGoShort} for short entry (too close to RSI 50 TP)`,
      };
    }
    // V2 weekly direction (OR mode): require weekly RSI OR weekly MACD FALLING.
    if (CONFIG.useWeeklyDirection) {
      const wk = weeklyDirection(candles);
      if (!wk.enoughHistory) {
        return {
          signal: null,
          rejectReason: `V2 weekly direction: insufficient weekly history (need 30+ weeks)`,
        };
      }
      if (!((!wk.rsiRising) || (!wk.macdRising))) {
        return {
          signal: null,
          rejectReason: `V2 weekly direction: both weekly RSI (${wk.weeklyRsi?.toFixed(1)}) and MACD (${wk.weeklyMacd?.toFixed(4)}) rising — RED FLAG for short`,
        };
      }
    }
    const signalDate  = candles[overboughtIdx].date;
    const episodeCandles = candles.slice(overboughtIdx);
    const highestHigh = Math.max(...episodeCandles.map(c => c.high));
    const stopLoss    = Math.ceil(highestHigh);        // Rounded UP to whole dollar

    return {
      signal:     'short',
      entry:      closes[n - 1],
      stopLoss,
      signalDate,
      entryDate:  candles[n - 1].date,
      rsiAtEntry: rsiNow,
      rsiAtSignal: rsiArr[overboughtIdx],
      reason:     `RSI overbought (${rsiArr[overboughtIdx]}) on ${signalDate} → RSI(${rsiNow.toFixed(1)}) & MACD both pointing down`,
    };
  }

  return null;
}

// ── Position Sizing ───────────────────────────────────────────────────────────
// Follows the SID formula exactly:
//   Risk Amount   = Account × Risk %
//   Risk per Share = |Entry - StopLoss|
//   % Risk/Pos    = Risk per Share ÷ Entry
//   Position $    = Risk Amount ÷ % Risk/Pos   (capped at maxPositionPct of account)
//   Shares        = floor(Position $ ÷ Entry)  — always round DOWN

function calcPositionSize(entry, stopLoss) {
  const riskAmount    = CONFIG.accountUsd * CONFIG.riskPct;
  const riskPerShare  = Math.abs(entry - stopLoss);
  if (riskPerShare <= 0) return null;

  const riskPct       = riskPerShare / entry;
  const positionUsd   = riskAmount / riskPct;
  const maxUsd        = CONFIG.accountUsd * CONFIG.maxPositionPct; // Cap at 10%
  const cappedUsd     = Math.min(positionUsd, maxUsd);
  const shares        = Math.floor(cappedUsd / entry);            // Always round DOWN

  if (shares < 1) return null; // Position too small to open

  return {
    shares,
    totalUsd:  parseFloat((shares * entry).toFixed(2)),
    riskUsd:   parseFloat((shares * riskPerShare).toFixed(2)),
    riskPct:   parseFloat((riskPerShare / entry * 100).toFixed(2)),
  };
}

// ── Position Monitor — V2.1 Dynamic TP1 / TP2 Exit ────────────────────────────
// V2.1 introduces a two-stage exit. Per instructor S3_P1 (long) / S3_P2 (short):
//
//   TP1 (RSI 50)
//     - Close half the position.
//     - Move stop on the remaining half to break-even (entry price).
//     - "WR" is now defined as did-TP1-fire-or-not, so a TP1+breakeven-stop
//       outcome is still a WIN — the half-position profit is banked.
//
//   TP2 (whichever of these the remaining 50% hits first)
//     - Price touches the 50-day SMA (first MA target)
//     - Price touches the 200-day SMA (trend MA target)
//     - Break-even stop hit (price returns to entry — the runner round-trips)
//     - 30-trading-day timeout (close at next-day open)
//
// PDT-immune design preserved: the bot does not place broker-side stops. On
// each daily run it scans post-entry candles and submits market orders for
// any exits hit — which fill next morning, never same-day.
//
// Schema additions to open-positions-sid.json (per position):
//   tp1_hit            : boolean — has the RSI 50 partial fired yet?
//   tp1_date           : 'YYYY-MM-DD' — set when TP1 fires
//   tp1_price          : number — fill (close-of-bar that hit RSI 50)
//   tp1_shares         : int    — number of shares closed at TP1
//   tp1_pnl            : number — realised $ from the TP1 partial
//   tp1_rsi            : number — RSI value at the TP1 bar
//   shares_total       : int    — original share count (immutable after entry)
//   shares_remaining   : int    — current runners after TP1 partial close
//   orig_stop          : number — entry-time stop level (kept for record)
//
// Backwards compat: positions opened under v2.0 (no tp1_* fields) are upgraded
// to the v2.1 schema on first read with tp1_hit=false. They then participate
// in the V2.1 exit logic from that point forward.
//
// Toggle: SID_DYNAMIC_TP=false falls back to v2.0 behaviour (full close at
// RSI 50, no TP2). Useful for A/B comparisons or emergency revert.

async function checkPositions(executor = null) {
  const openPositions   = loadOpenPositions();
  const closedPositions = loadClosedPositions();

  if (!openPositions.length) {
    console.log('\n── SID Position Monitor: No open positions ──');
    return;
  }

  console.log(`\n── SID Position Monitor: ${openPositions.length} open position(s) ──  [Dynamic TP ${CONFIG.useDynamicTp ? 'ON' : 'OFF (v2.0 fallback)'}]`);

  const stillOpen = [];
  let numClosed = 0;

  for (const pos of openPositions) {
    // Upgrade legacy v2.0 positions to V2.1 schema on first read
    if (typeof pos.tp1_hit === 'undefined') {
      pos.tp1_hit          = false;
      pos.orig_stop        = pos.stopLoss;
      pos.shares_total     = pos.shares;
      pos.shares_remaining = pos.shares;
      console.log(`  ▶ ${pos.symbol} — legacy v2.0 position upgraded to v2.1 schema in-place`);
    }

    const tp1Tag = pos.tp1_hit ? ' [TP1✓]' : '';
    process.stdout.write(`  ▶ ${pos.symbol} ${pos.side.toUpperCase()} @ $${pos.entry}${tp1Tag} (entry ${pos.openDate}) … `);

    // V2.1 needs ~200 trading-day SMA → fetch 2y of history (was 6mo in v2.0)
    let candles;
    try {
      candles = await fetchDailyCandles(pos.symbol, '2y');
    } catch (err) {
      console.log(`candles unavailable — skipping (${err.message})`);
      stillOpen.push(pos);
      continue;
    }

    // Where do we start scanning post-position-state? If TP1 already fired,
    // start AFTER the TP1 date (TP1 partial is already booked). Otherwise
    // start AFTER entry.
    const scanFromDate = pos.tp1_hit ? pos.tp1_date : pos.openDate;
    const newBars = candles.filter(c => c.date > scanFromDate);
    if (!newBars.length) {
      console.log('no new daily bars yet');
      stillOpen.push(pos);
      continue;
    }

    const closes  = candles.map(c => c.close);
    const rsiArr  = calcRSI(closes);
    const sma50Arr  = CONFIG.useDynamicTp ? calcSMA(closes, 50)  : null;
    const sma200Arr = CONFIG.useDynamicTp ? calcSMA(closes, 200) : null;

    // tp1_date may exist on legacy data — locate its index in *this* run's
    // candles array (yfinance can shift indices vs prior runs) for accurate
    // bars-since-TP1 timeout calc.
    const tp1IdxInCandles = pos.tp1_hit
      ? candles.findIndex(c => c.date === pos.tp1_date)
      : -1;

    // Walk forward through post-scan-date candles. Multiple exit events can
    // fire in a single run if the bot has been quiet (e.g. TP1 day 5, TP2 day
    // 20). They are processed in chronological order.
    let positionHandled = false; // set true once we either close fully or fail-out

    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      if (c.date <= scanFromDate) continue;
      const rsi = rsiArr[i];
      if (rsi === null) continue;

      // ── Branch A: TP1 not yet hit ─────────────────────────────────────────
      if (!pos.tp1_hit) {
        // Original stop check — full stop-out before TP1 = full loss on shares_total
        const stopHit = pos.side === 'long'
          ? c.low  <= pos.stopLoss
          : c.high >= pos.stopLoss;

        if (stopHit) {
          const exitPrice   = pos.stopLoss;
          const realizedPnl = parseFloat((
            pos.side === 'long'
              ? (exitPrice - pos.entry) * pos.shares_total
              : (pos.entry - exitPrice) * pos.shares_total
          ).toFixed(2));

          if (executor) {
            try {
              await executor.closePosition(pos, `V2.1 stop-out before TP1 — stop $${pos.stopLoss} breached ${c.date}`);
            } catch (err) {
              console.log(`\n    🚫 Alpaca close FAILED: ${err.message} — position stays open, will retry next run`);
              writeLog({ kind: 'close_fail', symbol: pos.symbol, error: err.message });
              stillOpen.push(pos);
              positionHandled = true;
              break;
            }
          }

          const acct = updateAccount(realizedPnl);
          const outcome = realizedPnl >= 0 ? 'WIN' : 'LOSS';
          const icon = realizedPnl >= 0 ? '✅' : '❌';

          closedPositions.push({
            ...pos,
            // V2.1 fields
            tp1_date: c.date,
            tp1_price: exitPrice,
            tp1_shares: pos.shares_total,
            tp1_pnl: realizedPnl,
            tp1_reason: 'stop',
            tp1_rsi: rsi,
            tp2_shares: 0,
            tp2_pnl: 0,
            tp2_reason: 'stopped_before_tp1',
            total_pnl: realizedPnl,
            exit_strategy: 'v2.1-stop',
            // v2.0-compat fields the dashboard reads
            exitLevel: 'sl',
            exitPrice,
            exitRsi: rsi,
            closeDate: c.date,
            realizedPnl,
            outcome,
            accountAfter: acct.accountUsd,
          });

          tg.alertExitFired({
            symbol: pos.symbol, side: pos.side, exitPrice,
            exitReason: 'sl', realizedPnl, accountAfter: acct.accountUsd,
            mode: pos.mode || CONFIG.tradingMode,
          }).catch(() => {});

          console.log(`${icon} STOPPED OUT before TP1 — $${exitPrice.toFixed(2)} on ${c.date}`);
          console.log(`    Realized P&L : ${realizedPnl >= 0 ? '+' : ''}$${realizedPnl}`);
          console.log(`    Account now  : $${acct.accountUsd.toFixed(2)}`);
          numClosed++;
          positionHandled = true;
          break;
        }

        // RSI 50 check — TP1 trigger
        const rsi50Hit = pos.side === 'long' ? rsi >= 50 : rsi <= 50;
        if (!rsi50Hit) continue;

        // V2.0 fallback: full close at RSI 50 if dynamic TP disabled
        if (!CONFIG.useDynamicTp) {
          const exitPrice   = c.close;
          const realizedPnl = parseFloat((
            pos.side === 'long'
              ? (exitPrice - pos.entry) * pos.shares_total
              : (pos.entry - exitPrice) * pos.shares_total
          ).toFixed(2));

          if (executor) {
            try {
              await executor.closePosition(pos, `V2.0 fallback exit — RSI 50 reached (${rsi.toFixed(1)})`);
            } catch (err) {
              console.log(`\n    🚫 Alpaca close FAILED: ${err.message} — position stays open, will retry next run`);
              writeLog({ kind: 'close_fail', symbol: pos.symbol, error: err.message });
              stillOpen.push(pos);
              positionHandled = true;
              break;
            }
          }

          const acct = updateAccount(realizedPnl);
          const outcome = realizedPnl >= 0 ? 'WIN' : 'LOSS';
          const icon = realizedPnl >= 0 ? '✅' : '❌';
          closedPositions.push({
            ...pos,
            exitLevel: 'rsi50', exitPrice, exitRsi: rsi,
            closeDate: c.date, realizedPnl, outcome,
            accountAfter: acct.accountUsd,
            exit_strategy: 'v2.0-rsi50-full',
          });
          tg.alertExitFired({
            symbol: pos.symbol, side: pos.side, exitPrice,
            exitReason: 'rsi50', realizedPnl, accountAfter: acct.accountUsd,
            mode: pos.mode || CONFIG.tradingMode,
          }).catch(() => {});
          console.log(`${icon} ${outcome} — RSI 50 reached @ $${exitPrice.toFixed(2)} on ${c.date}`);
          console.log(`    Realized P&L : ${realizedPnl >= 0 ? '+' : ''}$${realizedPnl}`);
          numClosed++;
          positionHandled = true;
          break;
        }

        // V2.1 default — partial 50% close at RSI 50
        const exitPrice  = c.close;
        const tp1Shares  = Math.max(1, Math.floor(pos.shares_total * CONFIG.tp1Portion));
        const tp1Pnl     = parseFloat((
          pos.side === 'long'
            ? (exitPrice - pos.entry) * tp1Shares
            : (pos.entry - exitPrice) * tp1Shares
        ).toFixed(2));

        if (executor) {
          try {
            await executor.closePartial(pos, tp1Shares, `V2.1 TP1 — RSI ${rsi.toFixed(1)} reached, closing ${tp1Shares} sh (50%)`);
          } catch (err) {
            console.log(`\n    🚫 Alpaca TP1 partial close FAILED: ${err.message} — position stays at full size, will retry next run`);
            writeLog({ kind: 'tp1_close_fail', symbol: pos.symbol, error: err.message });
            stillOpen.push(pos);
            positionHandled = true;
            break;
          }
        }

        // Mutate position in place — KEEPS it open for TP2 scan
        pos.tp1_hit          = true;
        pos.tp1_date         = c.date;
        pos.tp1_price        = exitPrice;
        pos.tp1_shares       = tp1Shares;
        pos.tp1_pnl          = tp1Pnl;
        pos.tp1_reason       = 'rsi50';
        pos.tp1_rsi          = rsi;
        pos.shares_remaining = pos.shares_total - tp1Shares;
        pos.stopLoss         = Math.round(pos.entry); // break-even stop (whole dollar)
        // Book TP1 partial P&L immediately so account compounds
        const acctAfterTp1 = updateAccount(tp1Pnl);
        appendTrade([
          c.date,
          (new Date()).toISOString().slice(11, 19),
          'V2.1/TP1',
          pos.symbol,
          `${pos.side}-tp1`,
          tp1Shares,
          pos.entry.toFixed(2),
          pos.stopLoss,
          (tp1Shares * exitPrice).toFixed(2),
          tp1Pnl,
          ((tp1Pnl / acctAfterTp1.accountUsd) * 100).toFixed(2),
          pos.signalDate,
          `TP1-${pos.id}`,
          pos.mode || CONFIG.tradingMode,
          `${BOT_NAME} v2.1`,
        ].join(','));

        tg.alertExitFired({
          symbol: pos.symbol, side: pos.side, exitPrice,
          exitReason: 'tp1_rsi50', realizedPnl: tp1Pnl,
          accountAfter: acctAfterTp1.accountUsd,
          mode: pos.mode || CONFIG.tradingMode,
        }).catch(() => {});

        console.log(`✓ TP1 PARTIAL — RSI ${rsi.toFixed(1)} on ${c.date}: sold ${tp1Shares}/${pos.shares_total} sh @ $${exitPrice.toFixed(2)}`);
        console.log(`    TP1 P&L     : +$${tp1Pnl}   Account: $${acctAfterTp1.accountUsd.toFixed(2)}`);
        console.log(`    Runner      : ${pos.shares_remaining} sh, stop -> $${pos.stopLoss} (break-even)`);
        // KEEP WALKING — TP2 may fire later in this same scan
        continue;
      }

      // ── Branch B: TP1 already hit — scan for TP2 ─────────────────────────
      const ma50  = sma50Arr  ? sma50Arr[i]  : null;
      const ma200 = sma200Arr ? sma200Arr[i] : null;

      let tp2Hit       = false;
      let tp2Reason    = null;
      let tp2ExitPrice = null;

      if (pos.side === 'long') {
        if (c.low <= pos.stopLoss) {
          tp2Hit = true; tp2Reason = 'breakeven_stop'; tp2ExitPrice = pos.stopLoss;
        } else if (ma50 !== null && c.low <= ma50 && ma50 <= c.high) {
          tp2Hit = true; tp2Reason = 'sma50_touch';  tp2ExitPrice = ma50;
        } else if (ma200 !== null && c.low <= ma200 && ma200 <= c.high) {
          tp2Hit = true; tp2Reason = 'sma200_touch'; tp2ExitPrice = ma200;
        }
      } else { // short
        if (c.high >= pos.stopLoss) {
          tp2Hit = true; tp2Reason = 'breakeven_stop'; tp2ExitPrice = pos.stopLoss;
        } else if (ma50 !== null && c.low <= ma50 && ma50 <= c.high) {
          tp2Hit = true; tp2Reason = 'sma50_touch';  tp2ExitPrice = ma50;
        } else if (ma200 !== null && c.low <= ma200 && ma200 <= c.high) {
          tp2Hit = true; tp2Reason = 'sma200_touch'; tp2ExitPrice = ma200;
        }
      }

      // Timeout check (only if no other exit fired)
      if (!tp2Hit && tp1IdxInCandles >= 0) {
        const barsSinceTp1 = i - tp1IdxInCandles;
        if (barsSinceTp1 >= CONFIG.tp2TimeoutDays) {
          tp2Hit       = true;
          tp2Reason    = 'timeout';
          tp2ExitPrice = c.close;
        }
      }

      if (!tp2Hit) continue;

      // TP2 fires — close the remaining 50%
      const tp2Pnl = parseFloat((
        pos.side === 'long'
          ? (tp2ExitPrice - pos.entry) * pos.shares_remaining
          : (pos.entry - tp2ExitPrice) * pos.shares_remaining
      ).toFixed(2));

      if (executor) {
        try {
          await executor.closePosition(pos, `V2.1 TP2 (${tp2Reason}) on ${c.date}`);
        } catch (err) {
          console.log(`\n    🚫 Alpaca TP2 close FAILED: ${err.message} — position stays open, will retry next run`);
          writeLog({ kind: 'tp2_close_fail', symbol: pos.symbol, error: err.message });
          stillOpen.push(pos);
          positionHandled = true;
          break;
        }
      }

      const acctAfterTp2 = updateAccount(tp2Pnl);
      const totalPnl     = parseFloat(((pos.tp1_pnl || 0) + tp2Pnl).toFixed(2));
      const outcome      = totalPnl >= 0 ? 'WIN' : 'LOSS';
      const icon         = totalPnl >= 0 ? '✅' : '❌';

      closedPositions.push({
        ...pos,
        tp2_date: c.date,
        tp2_price: tp2ExitPrice,
        tp2_shares: pos.shares_remaining,
        tp2_pnl: tp2Pnl,
        tp2_reason: tp2Reason,
        tp2_rsi: rsi,
        total_pnl: totalPnl,
        exit_strategy: 'v2.1-tp1+tp2',
        // v2.0-compat fields the dashboard reads
        exitLevel: tp2Reason,
        exitPrice: tp2ExitPrice,
        exitRsi: rsi,
        closeDate: c.date,
        realizedPnl: totalPnl,
        outcome,
        accountAfter: acctAfterTp2.accountUsd,
      });

      appendTrade([
        c.date,
        (new Date()).toISOString().slice(11, 19),
        `V2.1/TP2-${tp2Reason}`,
        pos.symbol,
        `${pos.side}-tp2`,
        pos.shares_remaining,
        pos.entry.toFixed(2),
        pos.stopLoss,
        (pos.shares_remaining * tp2ExitPrice).toFixed(2),
        tp2Pnl,
        ((tp2Pnl / acctAfterTp2.accountUsd) * 100).toFixed(2),
        pos.signalDate,
        `TP2-${pos.id}`,
        pos.mode || CONFIG.tradingMode,
        `${BOT_NAME} v2.1`,
      ].join(','));

      tg.alertExitFired({
        symbol: pos.symbol, side: pos.side, exitPrice: tp2ExitPrice,
        exitReason: `tp2_${tp2Reason}`, realizedPnl: tp2Pnl,
        accountAfter: acctAfterTp2.accountUsd,
        mode: pos.mode || CONFIG.tradingMode,
      }).catch(() => {});

      const labels = {
        sma50_touch:    '50d SMA touched',
        sma200_touch:   '200d SMA touched',
        breakeven_stop: 'break-even stop hit',
        timeout:        `${CONFIG.tp2TimeoutDays}-day timeout`,
      };
      console.log(`${icon} TP2 FULL CLOSE — ${labels[tp2Reason] || tp2Reason} @ $${tp2ExitPrice.toFixed(2)} on ${c.date}`);
      console.log(`    TP2 P&L     : ${tp2Pnl >= 0 ? '+' : ''}$${tp2Pnl}   Total trade P&L: ${totalPnl >= 0 ? '+' : ''}$${totalPnl}`);
      console.log(`    Account now : $${acctAfterTp2.accountUsd.toFixed(2)}`);
      numClosed++;
      positionHandled = true;
      break;
    }

    if (!positionHandled) {
      // Still open — report current status
      const lastRsi    = rsiArr[rsiArr.length - 1];
      const lastClose  = closes[closes.length - 1];
      if (pos.tp1_hit) {
        const lastSma50  = sma50Arr  ? sma50Arr[sma50Arr.length - 1]   : null;
        const lastSma200 = sma200Arr ? sma200Arr[sma200Arr.length - 1] : null;
        const sma50Str   = lastSma50  != null ? `$${lastSma50.toFixed(2)}`  : '—';
        const sma200Str  = lastSma200 != null ? `$${lastSma200.toFixed(2)}` : '—';
        console.log(`runner open (RSI ${lastRsi?.toFixed(1) ?? '—'}, ${pos.shares_remaining} sh @ last $${lastClose?.toFixed(2)}, SMA50 ${sma50Str}, SMA200 ${sma200Str}, BE stop $${pos.stopLoss})`);
      } else {
        console.log(`still open (RSI ${lastRsi?.toFixed(1) ?? '—'}, waiting for RSI 50)`);
      }
      stillOpen.push(pos);
    }
  }

  saveOpenPositions(stillOpen);
  saveClosedPositions(closedPositions);
  console.log(`  ── ${numClosed} closed this run, ${stillOpen.length} still open ──`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  // Load current compounded account balance — overrides the static CONFIG value.
  // This ensures every run sizes positions against the CURRENT account value,
  // compounding gains (or absorbing losses) automatically over time.
  const account = loadAccount();
  CONFIG.accountUsd = account.accountUsd;

  const growthPct  = ((account.accountUsd - account.startingUsd) / account.startingUsd * 100).toFixed(2);
  const growthSign = growthPct >= 0 ? '+' : '';

  console.log(`\n══ SID Bot run ${new Date().toISOString()} ══`);
  console.log(`Account : $${account.accountUsd.toFixed(2)}  (started $${account.startingUsd}  ${growthSign}${growthPct}%  ${account.tradeCount} closed trades)`);
  console.log(`Sizing  : ${(CONFIG.riskPct * 100).toFixed(1)}% risk/trade  Max position: ${(CONFIG.maxPositionPct * 100).toFixed(0)}% = $${(CONFIG.accountUsd * CONFIG.maxPositionPct).toFixed(2)}`);
  console.log(`Max open: ${CONFIG.maxOpenPositions}  Earnings window: ${CONFIG.earningsWindow} days  Mode: ${CONFIG.tradingMode.toUpperCase()}`);
  console.log(`Symbols : ${WATCHLIST.length} stocks/ETFs`);
  console.log(`─`.repeat(60));

  // ── Alpaca executor — created only when SID_TRADING_MODE != dry_run ──────
  // Returns null in dry_run mode. Returns a paper/live executor otherwise.
  // From here on, "executor" is the single touchpoint for any order action.
  const executor = createExecutor();

  if (executor) {
    const preflight = await executor.preflight();
    if (!preflight.ok) {
      console.error(`\n🚫 Alpaca preflight failed (${preflight.reason}): ${preflight.detail}`);
      console.error('   Aborting run to avoid placing orders in an unknown state.');
      writeLog({ kind: 'preflight_fail', reason: preflight.reason, detail: preflight.detail });
      return;
    }

    // Trust Alpaca's account equity over the local compounding ledger when
    // we're actually trading through them. This means the bot sizes against
    // the real broker balance including fills, dividends, and FX.
    if (preflight.equity > 0) {
      CONFIG.accountUsd = preflight.equity;
      console.log(`[Alpaca] Equity     : $${preflight.equity.toFixed(2)}  (used for position sizing this run)`);
      console.log(`[Alpaca] Buying pwr : $${preflight.buyingPower.toFixed(2)}`);
      console.log(`[Alpaca] Market open: ${preflight.marketOpen ? 'YES' : 'NO'}  next open: ${preflight.nextOpen}`);
    }

    if (!preflight.marketOpen) {
      console.log(`\n⏸  Market is closed — will read positions but place no orders this run.`);
    }

    // Sync local open positions against Alpaca's authoritative view.
    // Any positions Alpaca no longer has (because a stop filled overnight, say)
    // get pulled out of open-positions-sid.json. The local position monitor
    // (checkPositions) still runs for RSI 50 evaluation on what remains.
    try {
      const localOpen = loadOpenPositions();
      const { stillOpen, closedExternally } = await executor.syncPositions(localOpen);
      if (closedExternally.length) {
        console.log(`[Alpaca] Reconciliation: ${closedExternally.length} position(s) closed externally (stop fills?)`);
        for (const pos of closedExternally) {
          console.log(`           - ${pos.symbol} ${pos.side} ${pos.shares}sh @ $${pos.entry}`);
          writeLog({ kind: 'external_close', symbol: pos.symbol, position: pos });
        }
        saveOpenPositions(stillOpen);
      }
    } catch (err) {
      console.error(`[Alpaca] Position sync failed: ${err.message} — continuing with local data`);
      writeLog({ kind: 'sync_fail', error: err.message });
    }
  }

  // ── Weekend guard (stocks/ETFs only — markets are closed Sat/Sun) ─────────
  // Any signal fired on a weekend is driven by Friday's stale close price.
  // False entries are guaranteed — do nothing until Monday open.
  const dayOfWeek = new Date().getUTCDay(); // 0=Sun, 6=Sat
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    const dayName = dayOfWeek === 6 ? 'Saturday' : 'Sunday';
    console.log(`\n🚫 Weekend guard — ${dayName} UTC. Stock markets closed, no action taken.`);
    console.log(`   Open positions will be reviewed at Monday market open.`);
    console.log(`\n══ SID run complete ══`);
    return;
  }

  // Step 0: Check open positions for RSI-50 exits
  await checkPositions(executor);

  // Step 1: Check if we're already at the position limit
  const openPositions = loadOpenPositions();
  if (openPositions.length >= CONFIG.maxOpenPositions) {
    console.log(`\n⚠️  At max open positions (${openPositions.length}/${CONFIG.maxOpenPositions}) — no new entries this run`);
    console.log(`\n══ SID run complete ══`);
    return;
  }

  // Step 2: Check daily new-entry limit
  if (countTodayTrades() >= CONFIG.maxPerDay) {
    console.log(`\n⚠️  Daily entry limit reached (${CONFIG.maxPerDay}) — no new entries today`);
    console.log(`\n══ SID run complete ══`);
    return;
  }

  // Step 2.5: VIX gate (v1.7) — skip new entries on high-fear days
  // The gate blocks new ARMing only. Open positions keep running (with their
  // stops). If VIX data fetch fails, we trade normally (fail-open).
  const vixSnap = await fetchVixYesterdayClose();
  if (vixSnap) {
    if (vixSnap.vix >= VIX_GATE_THRESHOLD) {
      console.log(`\n🔴 VIX gate ACTIVE — VIX closed at ${vixSnap.vix} on ${vixSnap.date} (threshold ${VIX_GATE_THRESHOLD})`);
      console.log(`   Skipping new entries today. Existing positions continue.`);
      writeLog({ kind: 'vix_gate_active', vix: vixSnap.vix, date: vixSnap.date });
      // Send Telegram alert (best-effort)
      tg.sendMessage(
        `🔴 <b>SID VIX gate ACTIVE</b>\n\n`
        + `VIX closed at <b>${vixSnap.vix}</b> on ${vixSnap.date} (threshold ${VIX_GATE_THRESHOLD}).\n\n`
        + `No new entries today. Open positions continue normally.\n\n`
        + `<i>Gate auto-clears when VIX drops below ${VIX_GATE_THRESHOLD}.</i>`
      ).catch(() => {});
      console.log(`\n══ SID run complete (VIX gate) ══`);
      return;
    } else {
      console.log(`\n✓ VIX gate clear — VIX at ${vixSnap.vix} (< ${VIX_GATE_THRESHOLD})`);
    }
  }

  // Track symbols already open (don't double-enter)
  const openSymbols = new Set(openPositions.map(p => p.symbol));
  let newEntriesThisRun = 0;

  // Step 3: Scan watchlist for entry signals
  console.log('\n── Scanning watchlist ──');

  for (const symbol of WATCHLIST) {
    if (newEntriesThisRun >= CONFIG.maxPerDay) break;
    if (openSymbols.has(symbol)) {
      console.log(`  ${symbol.padEnd(6)} → Already open — skipping`);
      continue;
    }

    process.stdout.write(`  ${symbol.padEnd(6)} → `);

    // Fetch daily candles
    let candles;
    try {
      candles = await fetchDailyCandles(symbol);
      await new Promise(r => setTimeout(r, 300)); // Polite rate limit for Yahoo
    } catch (err) {
      console.log(`Data unavailable (${err.message})`);
      writeLog({ symbol, signal: null, reason: `Data fetch failed: ${err.message}` });
      continue;
    }

    if (candles.length < 40) {
      console.log('Not enough history');
      continue;
    }

    // Detect entry signal
    const signal = detectEntrySignal(candles);
    if (!signal) {
      const closes = candles.map(c => c.close);
      const rsiArr = calcRSI(closes);
      const rsiNow = rsiArr[rsiArr.length - 1];
      console.log(`No signal (RSI ${rsiNow?.toFixed(1) ?? '—'})`);
      writeLog({ symbol, signal: null, reason: 'No RSI/MACD entry alignment' });
      continue;
    }

    // V2 signal-detector can return {signal: null, rejectReason} for no-go zone
    if (!signal.signal && signal.rejectReason) {
      console.log(`🚫 ${signal.rejectReason}`);
      writeLog({ symbol, signal: null, reason: signal.rejectReason });
      continue;
    }

    // V2 AUTO/HUMAN tier routing
    if (!AUTO_APPROVED_TICKERS.has(symbol)) {
      console.log(`⚠️  HUMAN-tier signal (${symbol} ${signal.signal.toUpperCase()}) — Telegram approval not yet wired (v2.1). Skipping.`);
      writeLog({
        symbol,
        signal: signal.signal,
        reason: `HUMAN-tier: requires Telegram approval (deferred to v2.1)`,
        v2_tier: 'HUMAN',
        proposed_entry: signal.entry,
        proposed_stop: signal.stopLoss,
        proposed_rsi: signal.rsiAtEntry,
      });
      continue;
    }

    // Earnings blackout check — critical rule, never bypass
    const earningsDates = await fetchEarningsDates(symbol);
    const earningsCheck = isWithinEarningsWindow(earningsDates, CONFIG.earningsWindow);
    if (earningsCheck.blocked) {
      console.log(`🚫 Earnings blackout — ${earningsCheck.date} is ${earningsCheck.daysAway} days away (${CONFIG.earningsWindow}-day rule)`);
      writeLog({ symbol, signal: signal.signal, reason: `Earnings blackout: ${earningsCheck.date}` });
      continue;
    }

    // v1.6 PPI blackout — 14 days before next PPI release. Applies to ALL
    // tickers (macro event, not per-ticker). FOMC/CPI deliberately NOT
    // applied (backtest showed they hurt — see header comments).
    const ppiCheck = isWithinPPIWindow(CONFIG.earningsWindow);
    if (ppiCheck.blocked) {
      console.log(`🚫 PPI blackout — ${ppiCheck.date} is ${ppiCheck.daysAway} days away (${CONFIG.earningsWindow}-day rule)`);
      writeLog({ symbol, signal: signal.signal, reason: `PPI blackout: ${ppiCheck.date}` });
      continue;
    }

    // Calculate position size
    const sizing = calcPositionSize(signal.entry, signal.stopLoss);
    if (!sizing) {
      console.log(`Position too small to open (entry $${signal.entry.toFixed(2)} stop $${signal.stopLoss})`);
      writeLog({ symbol, signal: signal.signal, reason: 'Position size < 1 share' });
      continue;
    }

    // All checks passed — prepare the trade record
    const now     = new Date();

    console.log(`✓ ${signal.signal.toUpperCase()}`);
    console.log(`    Entry    : $${signal.entry.toFixed(2)}`);
    console.log(`    Stop     : $${signal.stopLoss}  (lowest/highest ${signal.signal === 'long' ? 'low' : 'high'} since ${signal.signalDate})`);
    console.log(`    Shares   : ${sizing.shares}`);
    console.log(`    Value    : $${sizing.totalUsd}  (${(sizing.totalUsd / CONFIG.accountUsd * 100).toFixed(1)}% of account)`);
    console.log(`    Risk     : $${sizing.riskUsd}  (${sizing.riskPct}% of position, ${(sizing.riskUsd / CONFIG.accountUsd * 100).toFixed(2)}% of account)`);
    console.log(`    Exit     : When RSI reaches 50`);
    console.log(`    Reason   : ${signal.reason}`);
    if (earningsDates.length) {
      console.log(`    Earnings : Next → ${earningsDates[0]} (${Math.round((new Date(earningsDates[0]) - now) / 86400000)} days away) ✅ clear`);
    }

    // ── Submit to Alpaca (paper or live) ─────────────────────────────────────
    // In dry_run mode (executor=null) we just record the trade locally as before.
    // In paper/live mode we place a real order and use Alpaca's order ID as the
    // canonical identifier — this lets us reconcile later.
    let orderId   = `SID-DRYRUN-${Date.now()}`;
    let exchange  = 'Yahoo/DryRun';
    let modeLabel = 'dry_run';

    if (executor) {
      try {
        const result = await executor.openEntry({ signal, sizing, symbol });
        orderId   = result.entryOrderId;
        exchange  = `Alpaca/${CONFIG.tradingMode}`;
        modeLabel = CONFIG.tradingMode;
        console.log(`    Order ID : ${orderId} (stop ${result.stopOrderId})`);
      } catch (err) {
        console.log(`    🚫 Alpaca entry FAILED: ${err.message}`);
        writeLog({
          kind:   'order_fail',
          symbol,
          signal: signal.signal,
          error:  err.message,
          status: err.status,
          body:   err.body,
        });
        // Don't record this trade locally — the signal didn't actually open
        continue;
      }
    }

    const row = [
      now.toISOString().slice(0, 10),
      now.toISOString().slice(11, 19),
      exchange,
      symbol,
      signal.signal,
      sizing.shares,
      signal.entry.toFixed(2),
      signal.stopLoss,
      sizing.totalUsd,
      sizing.riskUsd,
      sizing.riskPct,
      signal.signalDate,
      orderId,
      modeLabel,
      `${BOT_NAME} ${BOT_VERSION}`,
    ].join(',');

    appendTrade(row);

    addOpenPosition({
      id:               orderId,
      symbol,
      side:             signal.signal,
      entry:            signal.entry,
      stopLoss:         signal.stopLoss,
      shares:           sizing.shares,       // legacy field — kept for back-compat
      shares_total:     sizing.shares,        // V2.1: immutable original size
      shares_remaining: sizing.shares,        // V2.1: drops to 50% after TP1
      orig_stop:        signal.stopLoss,      // V2.1: kept for record; stopLoss field moves to BE after TP1
      tp1_hit:          false,                // V2.1: flips true at RSI 50
      totalUsd:         sizing.totalUsd,
      riskUsd:          sizing.riskUsd,
      signalDate:       signal.signalDate,
      openDate:         now.toISOString().slice(0, 10),
      openTime:         now.toISOString().slice(11, 19),
      mode:             modeLabel,
      strategy:         `${BOT_NAME} ${BOT_VERSION}`,
    });

    // Fire Telegram alert (best-effort, never blocks trading)
    tg.alertEntryFired({
      symbol,
      side:        signal.signal,
      entryPrice:  signal.entry,
      stopLoss:    signal.stopLoss,
      shares:      sizing.shares,
      riskUsd:     sizing.riskUsd,
      orderId,
      mode:        modeLabel,
    }).catch(() => {}); // swallow — best effort

    writeLog({
      symbol,
      signal:       signal.signal,
      entry:        signal.entry,
      stopLoss:     signal.stopLoss,
      shares:       sizing.shares,
      totalUsd:     sizing.totalUsd,
      riskUsd:      sizing.riskUsd,
      rsiAtSignal:  signal.rsiAtSignal,
      rsiAtEntry:   signal.rsiAtEntry,
      signalDate:   signal.signalDate,
      earningsDates,
      orderId,
      reason:       signal.reason,
    });

    openSymbols.add(symbol);
    newEntriesThisRun++;
  }

  if (newEntriesThisRun === 0) {
    console.log('\n  No entry signals found this run');
  }

  console.log(`\n══ SID run complete — ${newEntriesThisRun} new trade(s) ══`);

  // Final Telegram run-summary (best-effort)
  const finalAccount = loadAccount();
  const finalOpen = loadOpenPositions();
  await tg.alertBotStatus({
    openCount:   finalOpen.length,
    newEntries:  newEntriesThisRun,
    closedToday: 0, // checkPositions already sent per-exit alerts
    accountUsd:  finalAccount.accountUsd,
    mode:        CONFIG.tradingMode,
  }).catch(() => {});
}

run().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
