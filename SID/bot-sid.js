import 'dotenv/config';
import fetch from 'node-fetch';
import fs from 'fs';

import { createExecutor, resolveTradingMode } from './alpaca-executor.js';
import { rsiTargetPrice } from './rsi-target-price.js';
import * as tg from './telegram-alerts.js';

// ── Config ────────────────────────────────────────────────────────────────────

// Parse an integer env var, falling back to `def` when unset/blank/non-numeric.
// Unlike `parseInt(x) || def`, this correctly preserves a legitimate 0 value
// (needed for rearmCooldownLong, whose validated value IS 0).
function intEnv(raw, def) {
  if (raw === undefined || raw === null || raw === '') return def;
  const v = parseInt(raw, 10);
  return Number.isNaN(v) ? def : v;
}

const CONFIG = {
  // V2.2: accountUsd is set per-run from the internal ledger (loadAccount)
  // for compounding sizing. The SID_ACCOUNT_USD env var becomes a fallback
  // only when the ledger is unreadable. See top of main() for the override.
  accountUsd:       parseFloat(process.env.SID_ACCOUNT_USD)     || 30000,  // V2.2 fallback only
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
  // ── ENTRY ARM state-machine parameters (parity with backtest-sid-bot-parity.py) ──
  // These bring detectEntrySignal into EXACT agreement with the validated
  // backtest config (tier1, 5y → 280 trades / 73.9% WR / PF 3.19 / +$31,426
  // at $200 fixed risk). The old "episode scan" had no arm timeout, no RSI(3)
  // confirmation and no weekly-SMA arm gate — far too loose. See the bar-by-bar
  // replay in detectEntrySignal().
  armTimeoutDays:     intEnv(process.env.SID_ARM_TIMEOUT_DAYS,    3),       // arm expires this many trading days after the oversold/overbought signal if no entry triggers
  rearmCooldownLong:  intEnv(process.env.SID_REARM_COOLDOWN_LONG, 0),       // trading-day lockout before a LONG can re-arm after its arm expires unfired (0 = free re-arm)
  rearmCooldownShort: intEnv(process.env.SID_REARM_COOLDOWN_SHORT,5),       // trading-day lockout before a SHORT can re-arm after its arm expires unfired
  armReplayBars:      intEnv(process.env.SID_ARM_REPLAY_BARS,     40),      // how many trailing daily bars to replay the arm machine over (>> 3d arm + 5d cooldown so today's state is fully determined)
};

// ── RSI thresholds (named to match backtest-sid-bot-parity.py constants) ─────
// These were previously inline literals throughout the bot. Naming them keeps
// detectEntrySignal's replay byte-for-byte readable against the backtest.
const RSI_PERIOD     = 14;   // daily/weekly RSI lookback (Wilder)
const RSI3_PERIOD    = 3;    // RSI(3) rebound confirmation lookback
const RSI_OVERSOLD   = 30;   // long arm: daily RSI < 30  (and RSI(3) < 30)
const RSI_OVERBOUGHT = 70;   // short arm: daily RSI > 70 (and RSI(3) > 70)  [LOCKED core rule]

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
const BOT_VERSION = 'v2.2.1'; // V2.2.1 HYBRID: shorts use intraday-touch RSI-50 TP1, longs revert to v2.1 close-based TP1, both keep broker-enforced GTC stops + internal-ledger compounding (paper trading, 2026-06-09)
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

// ── External close recorder (FIX tasks #25 + #26, 2026-06-05) ────────────────
// When syncPositions detects that Alpaca closed shares we didn't fire ourselves
// (stop fills, OCO fills, manual broker-side closes), this records the close
// properly in: closed-positions-sid.json, trades-sid.csv, sid-account.json +
// Telegram alert. Queries Alpaca's filled orders to find the actual exit
// price; falls back to the position's stop level if order history is
// unavailable.
async function recordExternalClose({ pos, sharesClosed, alpacaClient, reasonKind, isFullClose }) {
  // ── Find the actual exit price from Alpaca's order history ─────────
  let exitPrice = null;
  let fillsUsed = [];
  try {
    const oppositeSide = pos.side === 'long' ? 'sell' : 'buy';
    const afterIso = pos.openDate ? `${pos.openDate}T00:00:00Z` : undefined;
    const orders = await alpacaClient.listOrders({
      symbols: pos.symbol,
      status:  'closed', // includes filled + canceled
      after:   afterIso,
      limit:   100,
    });
    const fills = (orders || []).filter(o =>
      o &&
      String(o.side || '').toLowerCase() === oppositeSide &&
      String(o.status || '').toLowerCase() === 'filled' &&
      parseFloat(o.filled_qty || 0) > 0
    );
    if (fills.length > 0) {
      // For a PARTIAL external close, use the most recent fill closest to
      // sharesClosed. For a FULL close, weighted-average across all fills
      // up to sharesClosed.
      let qtyCounted = 0;
      let costCounted = 0;
      const sortedFills = fills.sort((a, b) => new Date(b.filled_at || b.updated_at || b.created_at) - new Date(a.filled_at || a.updated_at || a.created_at));
      for (const f of sortedFills) {
        if (qtyCounted >= sharesClosed) break;
        const q = parseFloat(f.filled_qty);
        const p = parseFloat(f.filled_avg_price);
        const take = Math.min(q, sharesClosed - qtyCounted);
        qtyCounted += take;
        costCounted += take * p;
        fillsUsed.push({
          orderId: f.id,
          filledAt: f.filled_at || f.updated_at,
          qty: take,
          price: parseFloat(p.toFixed(4)),
        });
      }
      if (qtyCounted > 0) exitPrice = costCounted / qtyCounted;
    }
  } catch (err) {
    console.warn(`[recordExternalClose] Failed to query Alpaca orders for ${pos.symbol} exit price: ${err.message}`);
  }

  // Fallback: use the bot's tracked stop level. For Alpaca-side stops set at
  // bot's stopLoss, this is usually within a few cents of actual fill.
  if (exitPrice === null || !Number.isFinite(exitPrice)) {
    exitPrice = pos.stopLoss;
    console.warn(`[recordExternalClose] No Alpaca fills found for ${pos.symbol} — using stopLoss $${exitPrice} as approximation`);
  }

  // ── Compute realised P&L ───────────────────────────────────────────
  const entry = pos.entry;
  const pnl = pos.side === 'long'
    ? (exitPrice - entry) * sharesClosed
    : (entry - exitPrice) * sharesClosed;
  const pnlRounded = parseFloat(pnl.toFixed(2));
  const exitPriceRounded = parseFloat(exitPrice.toFixed(4));

  // ── Append to closed-positions-sid.json ─────────────────────────────
  const closed = loadClosedPositions();
  const closedRec = {
    ...pos,
    closeDate: todayString(),
    closeTime: new Date().toISOString().slice(11, 19),
    exit_strategy: reasonKind,
    exit_price:    exitPriceRounded,
    exit_pnl:      pnlRounded,
    exit_shares:   sharesClosed,
    exit_fills:    fillsUsed,
    total_pnl:     pnlRounded,
    realizedPnl:   pnlRounded,
    is_full_close: isFullClose,
  };
  closed.push(closedRec);
  saveClosedPositions(closed);

  // ── Append row to trades-sid.csv ────────────────────────────────────
  const totalUsd = (sharesClosed * entry).toFixed(2);
  const riskPct  = ((pnl / (sharesClosed * entry)) * 100).toFixed(2);
  appendTrade([
    todayString(),
    new Date().toISOString().slice(11, 19),
    'Alpaca/' + (pos.mode || 'paper'),
    pos.symbol,
    `${pos.side}-extclose`,
    sharesClosed,
    entry.toFixed(2),
    pos.stopLoss != null ? pos.stopLoss.toFixed(2) : '',
    totalUsd,
    pnlRounded,
    riskPct,
    pos.signalDate || '',
    `EXT-${pos.symbol}-${Date.now()}`,
    pos.mode || 'paper',
    pos.strategy || 'SID v2.1',
  ].join(','));

  // ── Update account state ────────────────────────────────────────────
  updateAccount(pnlRounded);

  // ── Telegram alert ──────────────────────────────────────────────────
  const pnlEmoji = pnlRounded >= 0 ? '📈' : '📉';
  const sign = pnlRounded >= 0 ? '+' : '';
  try {
    await tg.sendMessage(
      `${pnlEmoji} <b>SID external close detected</b>\n\n` +
      `${pos.symbol} ${pos.side.toUpperCase()} ${sharesClosed}sh ${isFullClose ? '(FULL)' : '(PARTIAL)'}\n` +
      `Entry: $${entry.toFixed(2)}  Exit: $${exitPriceRounded.toFixed(2)}\n` +
      `Realized P&amp;L: <b>${sign}$${pnlRounded.toFixed(2)}</b>\n` +
      `Reason: ${reasonKind}\n\n` +
      `Trade journal + account auto-updated. Position freed for new entries.`
    );
  } catch (e) {
    console.warn(`[recordExternalClose] Telegram alert failed: ${e.message}`);
  }

  writeLog({
    kind:        'external_close_recorded',
    symbol:      pos.symbol,
    sharesClosed,
    exitPrice:   exitPriceRounded,
    pnl:         pnlRounded,
    reason:      reasonKind,
    isFullClose,
    fillsUsed,
  });
}

// ── V2.2: Broker order maintenance ─────────────────────────────────────────────
// Helpers that keep the broker-side resting stop + intraday TP1 limit in sync
// with what the bot expects. Run each bot cycle for every v2.2 position.

const V2_2_PRICE_DRIFT_TOLERANCE = 0.05;   // dollar threshold for "materially different" TP1 limit price
const V2_2_TP1_RECOMPUTE_RSI     = 50;

/** Is this position managed by V2.2 broker-side orders? */
function isV2_2Position(pos) {
  // Either explicitly tagged v2.2 OR has a brokerStopOrderId stamped at entry.
  // V2.1 GOOG runner (pre-migration) has neither → returns false → keeps legacy
  // daily-poll management.
  return (typeof pos.strategy === 'string' && pos.strategy.includes('v2.2'))
      || !!pos.brokerStopOrderId;
}

/** Find an open Alpaca order by client_order_id suffix (e.g. "-tp1" or "-stop"). */
async function findOpenOrder(alpacaClient, symbol, clientOrderIdSuffix) {
  try {
    const orders = await alpacaClient.listOrders({ status: 'open', symbols: symbol, limit: 50 });
    return (orders || []).find(o =>
      o && typeof o.client_order_id === 'string' &&
      o.client_order_id.endsWith(clientOrderIdSuffix)
    );
  } catch (err) {
    console.warn(`[V2.2] findOpenOrder failed for ${symbol}: ${err.message}`);
    return null;
  }
}

/**
 * V2.2 — Maintain the broker-side resting stop and intraday TP1 limit for a
 * single open position. Called from checkPositions once per run per v2.2 position.
 *
 * Semantics:
 *   - Stop side: opposite of the entry. Stop price = pos.entry if tp1_hit (BE
 *     on the runner) else pos.stopLoss.
 *   - TP1 limit: only placed while tp1_hit === false. Price is recomputed each
 *     run via rsiTargetPrice(closes, 14, 50) — the level the next bar's close
 *     would have to print for RSI to equal 50. If the existing -tp1 order's
 *     limit_price drifts more than V2_2_PRICE_DRIFT_TOLERANCE from the new
 *     target, cancel and resubmit.
 *
 * Idempotent — safe to call every run.
 */
async function maintainV2_2BrokerOrders(pos, executor, closes) {
  if (!executor || !pos.clientOrderIdPrefix) {
    // Either dry_run or missing prefix (legacy position). Skip.
    return;
  }
  const client = executor.client;
  const exitSide = pos.side === 'long' ? 'sell' : 'buy';
  const prefix = pos.clientOrderIdPrefix;

  // ── Resting stop ────────────────────────────────────────────────────────
  const expectedStopPrice = pos.tp1_hit ? parseFloat(pos.entry.toFixed(2)) : pos.stopLoss;
  const existingStop = await findOpenOrder(client, pos.symbol, '-stop');
  const stopShares = pos.shares_remaining ?? pos.shares;

  if (!existingStop) {
    try {
      const stopOrder = await client.submitOrder({
        symbol:          pos.symbol,
        qty:             stopShares,
        side:            exitSide,
        type:            'stop',
        stop_price:      expectedStopPrice,
        time_in_force:   'gtc',
        client_order_id: `${prefix}-stop-${Date.now()}`,
      });
      pos.brokerStopOrderId = stopOrder.id;
      console.log(`  [V2.2] Placed missing stop for ${pos.symbol}: ${stopShares}sh @ $${expectedStopPrice} (id ${stopOrder.id})`);
    } catch (err) {
      console.warn(`  [V2.2] Stop placement failed for ${pos.symbol}: ${err.message}`);
    }
  } else {
    const existingStopPrice = parseFloat(existingStop.stop_price);
    const existingStopQty   = parseInt(existingStop.qty, 10);
    const priceMismatch = Math.abs(existingStopPrice - expectedStopPrice) > V2_2_PRICE_DRIFT_TOLERANCE;
    const qtyMismatch   = existingStopQty !== stopShares;
    if (priceMismatch || qtyMismatch) {
      console.log(`  [V2.2] Refreshing stop for ${pos.symbol}: ${existingStopQty}sh @ $${existingStopPrice} → ${stopShares}sh @ $${expectedStopPrice}`);
      try {
        await client.cancelOrder(existingStop.id);
        await new Promise(r => setTimeout(r, 800));
        const stopOrder = await client.submitOrder({
          symbol:          pos.symbol,
          qty:             stopShares,
          side:            exitSide,
          type:            'stop',
          stop_price:      expectedStopPrice,
          time_in_force:   'gtc',
          client_order_id: `${prefix}-stop-${Date.now()}`,
        });
        pos.brokerStopOrderId = stopOrder.id;
      } catch (err) {
        console.warn(`  [V2.2] Stop refresh failed for ${pos.symbol}: ${err.message}`);
      }
    }
  }

  // ── V2.2.1 HYBRID: resting TP1 limit is SHORT-only ─────────────────────
  // Per-side backtest decomposition: shorts strictly benefit from intraday-touch
  // TP1 (higher WR AND PnL), but longs gave up $2.3k of PnL on the v2.2 model
  // because the bullish equity drift books a bigger TP1 partial when price
  // closes past 50 than when it locks exactly at 50 intraday. So longs revert
  // to v2.1 close-based TP1 (handled in checkPositions Branch A daily-poll):
  if (pos.side === 'long') {
    // Belt-and-braces: cancel any stale TP1 limit from v2.2-era state
    const staleTp1 = await findOpenOrder(client, pos.symbol, '-tp1');
    if (staleTp1) {
      console.log(`  [V2.2.1] Cancelling stale -tp1 limit for ${pos.symbol} (long uses v2.1 close-based TP1)`);
      try { await client.cancelOrder(staleTp1.id); } catch (_) {}
    }
    return;
  }

  // ── Resting TP1 limit (SHORT only, while tp1_hit === false) ──────────────
  if (pos.tp1_hit) {
    // Belt-and-braces: kill any stale TP1 order if somehow still active
    const staleTp1 = await findOpenOrder(client, pos.symbol, '-tp1');
    if (staleTp1) {
      console.log(`  [V2.2] Cancelling stale -tp1 order for ${pos.symbol} (tp1_hit=true)`);
      try { await client.cancelOrder(staleTp1.id); } catch (_) {}
    }
    return;
  }

  // Compute the RSI-50 target price for the next bar
  const tp1Target = rsiTargetPrice(closes, 14, V2_2_TP1_RECOMPUTE_RSI);
  if (!Number.isFinite(tp1Target) || tp1Target <= 0) {
    console.warn(`  [V2.2] rsiTargetPrice returned ${tp1Target} for ${pos.symbol} — TP1 limit not placed this run`);
    return;
  }

  const tp1Qty = Math.floor(pos.shares_total * CONFIG.tp1Portion);
  if (tp1Qty < 1) {
    console.warn(`  [V2.2] ${pos.symbol} share count too small to split — no TP1 limit placed`);
    return;
  }

  const existingTp1 = await findOpenOrder(client, pos.symbol, '-tp1');
  if (!existingTp1) {
    try {
      const tp1Order = await client.submitOrder({
        symbol:          pos.symbol,
        qty:             tp1Qty,
        side:            exitSide,
        type:            'limit',
        limit_price:     tp1Target,
        time_in_force:   'gtc',
        client_order_id: `${prefix}-tp1-${Date.now()}`,
      });
      console.log(`  [V2.2] Placed TP1 limit for ${pos.symbol}: ${tp1Qty}sh @ $${tp1Target} (id ${tp1Order.id})`);
    } catch (err) {
      console.warn(`  [V2.2] TP1 limit placement failed for ${pos.symbol}: ${err.message}`);
    }
  } else {
    const existingTp1Price = parseFloat(existingTp1.limit_price);
    if (Math.abs(existingTp1Price - tp1Target) > V2_2_PRICE_DRIFT_TOLERANCE) {
      console.log(`  [V2.2] TP1 limit drift on ${pos.symbol}: was $${existingTp1Price} → now $${tp1Target} (re-pricing)`);
      try {
        await client.cancelOrder(existingTp1.id);
        await new Promise(r => setTimeout(r, 800));
        await client.submitOrder({
          symbol:          pos.symbol,
          qty:             tp1Qty,
          side:            exitSide,
          type:            'limit',
          limit_price:     tp1Target,
          time_in_force:   'gtc',
          client_order_id: `${prefix}-tp1-${Date.now()}`,
        });
      } catch (err) {
        console.warn(`  [V2.2] TP1 limit refresh failed for ${pos.symbol}: ${err.message}`);
      }
    } else {
      // Already at the right price — leave it
    }
  }
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

// ── Weekly series aligned to daily bars (EXACT backtest parity) ───────────────
// The validated backtest (backtest-sid-bot-parity.py) derives four daily-aligned
// weekly booleans that gate the ARM and TRIGGER of detectEntrySignal. They use
// TWO different W-FRI reindex conventions which must be replicated exactly:
//
//   1. Weekly SMA50/200 ARM gate  (sma_long_ok / sma_short_ok)
//        weekly_close = Close.resample('W-FRI').last()
//        wfast/wslow  = rolling(50/200).mean()
//        (wfast > wslow).reindex(daily, ffill)        ← NO index shift
//      → a daily bar uses the most recent COMPLETED W-FRI week (Mon-Thu use the
//        prior Friday; a Friday uses its own week). No intra-week lookahead.
//
//   2. Weekly RSI/MACD TRIGGER direction (wk_rsi_rising / wk_macd_rising)
//        w_rsi/w_macd rising = value > value.shift(1)  on weekly bars
//        index shifted back 4 days (Fri→Mon) THEN reindex(daily, ffill)
//      → a daily bar Mon-Fri uses THIS week's Friday value (this matches the
//        live weeklyDirection() result at the final bar: in-progress week vs
//        prior completed week).
//
// `requires >= 200 weekly bars for the SMA gate (else default true, as backtest)
// and >= 30 for the direction gate (else default false, as backtest).
// Returns arrays indexed 1:1 with `candles`.
function buildWeeklyDailyAligned(candles) {
  const n = candles.length;
  const smaLongOk  = new Array(n).fill(true);   // backtest default when <200 weekly bars
  const smaShortOk = new Array(n).fill(true);
  const wkRsiRising  = new Array(n).fill(false); // backtest default when <30 weekly bars
  const wkMacdRising = new Array(n).fill(false);

  // ── Resample to W-FRI weekly buckets: key = the Friday ending each week. ──
  // Match pandas 'W-FRI': each daily bar belongs to the week ending on the
  // next (or same) Friday. Bucket value = last daily close in that week.
  // We track each bucket's Friday date (ms) and its last close.
  const buckets = []; // { friMs, monMs, close }
  const byFri = new Map();
  for (const c of candles) {
    if (c.close === null || c.close === undefined || isNaN(c.close)) continue;
    const d = new Date(c.date + 'T00:00:00Z');
    const dow = d.getUTCDay();             // 0=Sun .. 6=Sat
    // days until that week's Friday (5). Sat(6)/Sun(0) belong to the NEXT Friday.
    let addToFri;
    if (dow === 6)      addToFri = 6;      // Sat → +6 (next Fri)
    else if (dow === 0) addToFri = 5;      // Sun → +5 (next Fri)
    else                addToFri = 5 - dow; // Mon..Fri → this week's Fri
    const fri = new Date(d);
    fri.setUTCDate(fri.getUTCDate() + addToFri);
    const friMs = fri.getTime();
    const monMs = friMs - 4 * 86400000;    // Fri→Mon shift (the -4d the backtest applies)
    if (byFri.has(friMs)) {
      byFri.get(friMs).close = c.close;    // chronological → last close in week wins
    } else {
      const b = { friMs, monMs, close: c.close };
      byFri.set(friMs, b);
      buckets.push(b);
    }
  }
  buckets.sort((a, b) => a.friMs - b.friMs);
  const W = buckets.length;
  const wCloses = buckets.map(b => b.close);

  // ── (1) Weekly SMA50/200 arm gate (no shift) ──
  if (W >= 200) {
    const wSma50  = calcSMA(wCloses, 50);
    const wSma200 = calcSMA(wCloses, 200);
    const longOkW  = wCloses.map((_, i) =>
      (wSma50[i] != null && wSma200[i] != null) ? (wSma50[i] > wSma200[i]) : null);
    const shortOkW = wCloses.map((_, i) =>
      (wSma50[i] != null && wSma200[i] != null) ? (wSma50[i] < wSma200[i]) : null);
    // ffill weekly→daily on the Friday (no-shift) anchor: a daily bar takes the
    // most recent weekly bucket whose Friday date <= the daily bar's date.
    let wi = -1;
    for (let i = 0; i < n; i++) {
      const dMs = new Date(candles[i].date + 'T00:00:00Z').getTime();
      while (wi + 1 < W && buckets[wi + 1].friMs <= dMs) wi++;
      if (wi >= 0 && longOkW[wi] != null) {
        smaLongOk[i]  = longOkW[wi];
        smaShortOk[i] = shortOkW[wi];
      } else {
        // Before the first valid weekly SMA → pandas NaN → .fillna(False)
        smaLongOk[i]  = false;
        smaShortOk[i] = false;
      }
    }
  }
  // else: leave defaults (true) — matches backtest's <200 branch.

  // ── (2) Weekly RSI/MACD rising trigger gate (shift -4d = Mon anchor) ──
  if (W >= 30) {
    const wRsi  = calcRSI(wCloses, RSI_PERIOD);
    const { macdLine: wMacd } = calcMACD(wCloses);
    const rsiRiseW  = wCloses.map((_, i) =>
      (i > 0 && wRsi[i]  != null && wRsi[i - 1]  != null) ? (wRsi[i]  > wRsi[i - 1])  : null);
    const macdRiseW = wCloses.map((_, i) =>
      (i > 0 && wMacd[i] != null && wMacd[i - 1] != null) ? (wMacd[i] > wMacd[i - 1]) : null);
    // ffill on the Monday (shifted) anchor: a daily bar takes the most recent
    // weekly bucket whose Monday date <= the daily bar's date.
    let wi = -1;
    for (let i = 0; i < n; i++) {
      const dMs = new Date(candles[i].date + 'T00:00:00Z').getTime();
      while (wi + 1 < W && buckets[wi + 1].monMs <= dMs) wi++;
      if (wi >= 0 && rsiRiseW[wi] != null) {
        wkRsiRising[i]  = rsiRiseW[wi];
        wkMacdRising[i] = macdRiseW[wi] != null ? macdRiseW[wi] : false;
      } else {
        wkRsiRising[i]  = false;   // pandas NaN → .fillna(False)
        wkMacdRising[i] = false;
      }
    }
  }
  // else: leave defaults (false) — matches backtest's <30 branch (both False).

  return { smaLongOk, smaShortOk, wkRsiRising, wkMacdRising };
}

// ── Long-term-bullish classification (for the MANUAL-WATCH short flag) ─────────
// Identifies an asset in a stable long-term uptrend so we can flag SHORT runners
// against it for manual S/R-level monitoring. Earned from the GOOG 2026-06 trade
// + the TP2-RSI experiment (SID/strategy-test-vault/tp2-rsi-experiment/): shorts
// on long-term-bullish names rarely reach daily oversold before bouncing, so the
// mechanical TP2 (RSI never arrives, SMA can round-trip) has a blind spot. The
// fix is a human eyeballing support — this flag tells the trader WHICH runners
// need that attention.
//
// NOTE: the backtest's hybrid classifier uses WEEKLY EMA50/EMA200/MACD/SMA200
// (needs ~5y of data for the weekly 200-bar windows). The live position monitor
// only fetches 2y, so here we use a DAILY-trend proxy that is computable from
// that window and stable through the kind of pullback you short into:
//   price > daily SMA200  AND  daily SMA50 > daily SMA200  (golden-cross regime)
// This is a reminder heuristic, not a P&L-routing decision, so the proxy is
// appropriate. Deliberately omits a MACD term — the daily MACD line flips
// negative during the very pullbacks we care about, which would suppress the
// flag exactly when it's wanted (the weekly MACD the backtest uses does not).
function longTermBullish(candles) {
  if (!candles || candles.length < 200) {
    return { bullish: false, enoughHistory: false };
  }
  const closes = candles.map(c => c.close);
  const sma50  = calcSMA(closes, 50);
  const sma200 = calcSMA(closes, 200);
  const n = closes.length;
  const price = closes[n - 1];
  const s50   = sma50[n - 1];
  const s200  = sma200[n - 1];
  if (price == null || s50 == null || s200 == null) {
    return { bullish: false, enoughHistory: false };
  }
  const priceAboveSma200 = price > s200;
  const goldenCross      = s50 > s200;
  return {
    bullish: priceAboveSma200 && goldenCross,
    enoughHistory: true,
    priceAboveSma200,
    goldenCross,
    sma50: s50,
    sma200: s200,
  };
}

// ── Signal Detection ──────────────────────────────────────────────────────────
// Returns a signal object, a {signal:null, rejectReason} log object, or null.
//
// ⚠ REWRITTEN 2026-06-29 to be an EXACT bar-by-bar replay of the validated
// backtest's arm/trigger/cooldown state machine (backtest-sid-bot-parity.py,
// SID_BOT_PARITY=false SID_REARM_COOLDOWN_LONG=0 SID_REARM_COOLDOWN_SHORT=5 →
// 280 trades / 73.9% WR / PF 3.19 / +$31,426 over 5y tier1, $200 fixed risk).
//
// The OLD implementation was a one-shot "episode scan" with NO arm timeout, NO
// RSI(3) confirmation and NO weekly-SMA arm gate — far too loose. It would, for
// example, still fire ADBE's 2026-06-17 signal as a 2026-06-26 entry even though
// the 3-day arm has long since expired. The replay fixes this.
//
// detectEntrySignal is called ONCE per run, only when the bot is FLAT on this
// ticker, with ~2y of daily candles. Its job: "does an entry TRIGGER on the
// LAST (today's) bar?" We answer it by replaying the backtest arm machine over
// the trailing CONFIG.armReplayBars bars from a clean state (armDir=null,
// rearmCooldown=0). 40 bars >> the 3-day arm + 5-day short cooldown, so today's
// arm/cooldown state is fully determined regardless of the seed.
//
// State machine (verbatim from the backtest), per bar in order:
//   ARM   — re-arm cooldown countdown (only while disarmed); compute RSI(3)
//           and weekly-SMA50/200 arm gates; arm LONG (rsi<30) or SHORT (rsi>70)
//           if eligible and not side-blocked; else, if already armed, age the
//           arm (days_since_arm++, accumulate arm low/high) and expire it after
//           ARM_TIMEOUT_DAYS — on expiry, set the side-specific re-arm cooldown.
//   TRIGGER — for the active arm side, require RSI+MACD aligned, no-go zone OK,
//           and the weekly RSI-OR-MACD direction filter. On fire: stop =
//           floor(armLow) / ceil(armHigh), entry = close, reset arm.
//
// PARITY NOTES:
//   • Earnings/PPI/VIX gates are NOT applied here — the CALLER applies them
//     after this returns (unchanged behaviour). The backtest folds earnings
//     into arming/expiry; the bot deliberately keeps it in the caller. Net
//     effect on the entry set is negligible (an earnings-blocked trigger is
//     skipped by the caller anyway), and verified against the backtest CSV.
//   • Cooldown is applied on arm EXPIRY only (matches the backtest); a
//     successful trigger just resets the arm with no cooldown.
//   • A trigger on a NON-final bar means the backtest would have been holding a
//     position there → the bot would not be scanning today → we reset arm and
//     keep replaying, but only a FINAL-bar trigger returns a signal.

function detectEntrySignal(candles) {
  const closes = candles.map(c => c.close);
  const n = closes.length;
  if (n < 40) return null;

  const rsiArr   = calcRSI(closes, RSI_PERIOD);
  const rsi3Arr  = calcRSI(closes, RSI3_PERIOD);
  const { macdLine } = calcMACD(closes);
  const wk = buildWeeklyDailyAligned(candles);

  const ARM_TIMEOUT  = CONFIG.armTimeoutDays;
  const CD_LONG      = CONFIG.rearmCooldownLong;
  const CD_SHORT     = CONFIG.rearmCooldownShort;

  // Replay window: trailing armReplayBars, but never start before index 1.
  const start = Math.max(1, n - CONFIG.armReplayBars);

  // Seed prev from the bar immediately before the window (the backtest's prev is
  // always the previous PROCESSED bar). If that bar's indicators are null we
  // fall back to per-bar warmup handling inside the loop.
  let prevRsi  = (start - 1 >= 0) ? rsiArr[start - 1]   : null;
  let prevMacd = (start - 1 >= 0) ? macdLine[start - 1] : null;

  // Arm state (clean initial state, per the replay design).
  let armDir = null;            // 'long' | 'short' | null
  let armLow = null, armHigh = null;
  let armSignalIdx = null;      // bar index where the active arm was set (= signalDate)
  let daysSinceArm = 0;
  let rearmCooldown = 0;        // trading-day lockout after an arm expires unfired
  let cooldownSide = null;      // 'long' | 'short' — which side the lockout applies to

  let finalSignal = null;       // set only if a trigger fires on the LAST bar

  for (let i = start; i < n; i++) {
    const rsi  = rsiArr[i];
    const m    = macdLine[i];
    const rsi3 = rsi3Arr[i];

    // Warmup-skip (mirrors the backtest: needs current RSI/MACD AND a prev).
    if (rsi == null || m == null || prevRsi == null || prevMacd == null) {
      prevRsi = rsi; prevMacd = m;
      continue;
    }

    const rsiRising   = rsi > prevRsi;
    const rsiFalling  = rsi < prevRsi;
    const macdRising  = m   > prevMacd;
    const macdFalling = m   < prevMacd;

    const isLast = (i === n - 1);

    // ── ARM (verbatim from backtest) ──────────────────────────────────────
    const rsi3OkLong  = rsi3 != null && rsi3 < RSI_OVERSOLD;
    const rsi3OkShort = rsi3 != null && rsi3 > RSI_OVERBOUGHT;
    const wkLong  = wk.smaLongOk[i];   // weekly SMA50 > SMA200 (no-shift ffill)
    const wkShort = wk.smaShortOk[i];  // weekly SMA50 < SMA200

    // Re-arm cooldown countdown — only ticks while disarmed (matches backtest).
    if (armDir === null && rearmCooldown > 0) {
      rearmCooldown -= 1;
      if (rearmCooldown === 0) cooldownSide = null;
    }

    const armLongGate  = rsi3OkLong  && wkLong;
    const armShortGate = rsi3OkShort && wkShort;
    const longBlocked  = rearmCooldown > 0 && cooldownSide === 'long';
    const shortBlocked = rearmCooldown > 0 && cooldownSide === 'short';

    if (armDir === null) {
      if (rsi < RSI_OVERSOLD && armLongGate && !longBlocked) {
        armDir = 'long';
        armLow = candles[i].low; armHigh = candles[i].high;
        armSignalIdx = i; daysSinceArm = 0;
      } else if (rsi > RSI_OVERBOUGHT && armShortGate && !shortBlocked) {
        armDir = 'short';
        armLow = candles[i].low; armHigh = candles[i].high;
        armSignalIdx = i; daysSinceArm = 0;
      }
    } else {
      daysSinceArm += 1;
      armLow  = Math.min(armLow,  candles[i].low);
      armHigh = Math.max(armHigh, candles[i].high);
      const expired = daysSinceArm > ARM_TIMEOUT;
      if (expired) {
        const cd = (armDir === 'long') ? CD_LONG : CD_SHORT;
        if (cd > 0) { rearmCooldown = cd; cooldownSide = armDir; }
        armDir = null; armLow = null; armHigh = null; armSignalIdx = null;
      }
    }

    // ── TRIGGER (v2-weekly-or, verbatim from backtest) ────────────────────
    if (armDir === 'long') {
      const nogoOk   = rsi < CONFIG.rsiNoGoLong;
      const weeklyOk = !CONFIG.useWeeklyDirection || (wk.wkRsiRising[i] || wk.wkMacdRising[i]);
      if (rsiRising && macdRising && nogoOk && weeklyOk) {
        const stop = Math.floor(armLow);
        const ep   = closes[i];
        if (ep > stop) {
          if (isLast) {
            finalSignal = {
              signal:     'long',
              entry:      ep,
              stopLoss:   stop,
              signalDate: candles[armSignalIdx].date,
              entryDate:  candles[i].date,
              rsiAtEntry: rsi,
              rsiAtSignal: rsiArr[armSignalIdx],
              reason:     `RSI armed long (RSI ${rsiArr[armSignalIdx]?.toFixed(1)}) on ${candles[armSignalIdx].date} → RSI(${rsi.toFixed(1)}) & MACD both up, ${daysSinceArm}d into 3d arm`,
            };
          }
          // reset arm (no cooldown on a successful trigger — matches backtest)
          armDir = null; armLow = null; armHigh = null; armSignalIdx = null;
        }
      }
    } else if (armDir === 'short') {
      const nogoOk   = rsi > CONFIG.rsiNoGoShort;
      const weeklyOk = !CONFIG.useWeeklyDirection || ((!wk.wkRsiRising[i]) || (!wk.wkMacdRising[i]));
      if (rsiFalling && macdFalling && nogoOk && weeklyOk) {
        const stop = Math.ceil(armHigh);
        const ep   = closes[i];
        if (stop > ep) {
          if (isLast) {
            finalSignal = {
              signal:     'short',
              entry:      ep,
              stopLoss:   stop,
              signalDate: candles[armSignalIdx].date,
              entryDate:  candles[i].date,
              rsiAtEntry: rsi,
              rsiAtSignal: rsiArr[armSignalIdx],
              reason:     `RSI armed short (RSI ${rsiArr[armSignalIdx]?.toFixed(1)}) on ${candles[armSignalIdx].date} → RSI(${rsi.toFixed(1)}) & MACD both down, ${daysSinceArm}d into 3d arm`,
            };
          }
          armDir = null; armLow = null; armHigh = null; armSignalIdx = null;
        }
      }
    }

    prevRsi = rsi; prevMacd = m;
  }

  return finalSignal; // null if no trigger fires on today's bar
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
  const manualWatchList = [];   // bullish-asset SHORT runners that need manual S/R monitoring
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

    // ── MANUAL-WATCH flag: SHORT runner on a long-term-bullish asset ────────
    // Computed every run so the flag stays current as the trend evolves. Only
    // SHORTs get flagged — longs ride the bullish drift, shorts fight it (the
    // dangerous subset where the mechanical TP2 has a blind spot). See
    // longTermBullish() + SID/strategy-test-vault/tp2-rsi-experiment/README.md.
    pos.manual_watch = false;
    pos.manual_watch_reason = null;
    if (pos.side === 'short') {
      const ltb = longTermBullish(candles);
      if (ltb.bullish) {
        const phase = pos.tp1_hit
          ? 'RUNNER — watch support for TP2 exit (RSI may never reach oversold)'
          : 'bullish-asset short — plan an S/R exit for the runner after TP1';
        pos.manual_watch = true;
        pos.manual_watch_reason = phase;
        manualWatchList.push({ symbol: pos.symbol, entry: pos.entry, tp1_hit: !!pos.tp1_hit, reason: phase });
        console.log(`\n    ⚠ MANUAL-WATCH: ${pos.symbol} SHORT on long-term-bullish asset (price>$${ltb.sma200?.toFixed(2)} SMA200, 50>200). ${phase}`);
        process.stdout.write(`  ▶ ${pos.symbol} (cont.) … `);
      }
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

    // ── V2.2 broker-order maintenance ──────────────────────────────────────
    // For positions managed by V2.2 (broker-side stops + intraday TP1 limit),
    // ensure the resting orders are in sync with current state. V2.1 legacy
    // positions (e.g. open GOOG runner) are managed by the daily-poll logic
    // below and skip this step.
    const posIsV2_2 = isV2_2Position(pos);
    if (posIsV2_2 && executor) {
      await maintainV2_2BrokerOrders(pos, executor, closes);
    }

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
        // V2.2.1 HYBRID routing:
        //   SHORTS: broker-side resting GTC stop + resting GTC TP1 limit handle
        //           both exits. syncPositions detects fills and updates state
        //           before this point. Skip Branch A entirely.
        //   LONGS:  broker-side resting GTC stop handles the stop. TP1 uses
        //           v2.1 close-based daily-poll (no resting TP1 limit on Alpaca
        //           per backtest evidence that close-based longs book bigger
        //           partials in bullish markets). Skip the stop simulation
        //           below but DO process the RSI 50 close-based TP1 check.
        if (posIsV2_2 && pos.side === 'short') continue;
        const skipStopSim = posIsV2_2;  // long v2.2 still needs TP1 check

        // Original stop check — full stop-out before TP1 = full loss on shares_total
        // (Skipped for any v2.2 position — broker GTC stop fires intraday and
        //  syncPositions records it. Re-doing it here would double-fire.)
        if (skipStopSim) {
          // Just process the TP1 close-based check below (longs only by now)
        } else {
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
        }  // end !skipStopSim

        // RSI 50 check — TP1 trigger (v2.1 close-based, fires for v2.1 positions
        // and v2.2.1 LONGS — v2.2.1 SHORTS already `continue`d above)
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
        // BE stop — direction-aware penny rounding, ALWAYS locks ≥ 1¢/share profit.
        // Replaces the old Math.round(entry) which was direction-blind: a long
        // entry of $281.49 used to round DOWN to $281 (tiny loss), and a short
        // entry of $381.84 used to round UP to $382 (tiny loss). Now: round to
        // nearest cent first (float-safe), then bias 1¢ in the favourable
        // direction (long: 1¢ above entry; short: 1¢ below). Guarantees
        // post-TP1 BE stop never closes at a small loss.
        const beCents = Math.round(pos.entry * 100);
        const beBias  = pos.side === 'long' ? 1 : -1;
        pos.stopLoss  = (beCents + beBias) / 100;
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

      // FIX 2026-06-02 — SMA touch semantics: previous logic ONLY checked STRADDLE
      // (low ≤ sma ≤ high). That correctly catches the common case where a bar's
      // range includes the SMA, but MISSES gap-throughs where the previous bar
      // closed on one side of the SMA and the current bar opens fully on the other
      // side (e.g., GOOG short runner with SMA50 at $347 and current price $358 —
      // if GOOG gaps down to open at $345 and bounces to close $349, bar high $349
      // is BELOW SMA $347 wait that's above, let me redo — if SMA $347 and bar
      // opens $343, low $341, high $345, close $344, bar entirely below SMA but
      // previous close was $358 ABOVE SMA → crossed via gap, straddle misses).
      //
      // Helper checks BOTH cases:
      //   1. Straddle: bar's range includes the SMA (the common in-bar touch)
      //   2. Gap-cross: prevClose was on one side, currClose on the other (the gap case)
      // Audit task #11 MED finding resolved.
      const prevClose = i > 0 ? candles[i - 1].close : null;
      const crossedSMA = (ma) =>
        ma !== null && (
          (c.low <= ma && ma <= c.high) ||                                    // touched the SMA in-bar
          (prevClose !== null && Math.sign(prevClose - ma) !== Math.sign(c.close - ma))  // gapped across SMA
        );
      if (pos.side === 'long') {
        // V2.2: BE stop is broker-managed → skip the daily-poll BE check, keep SMA exits
        if (!posIsV2_2 && c.low <= pos.stopLoss) {
          tp2Hit = true; tp2Reason = 'breakeven_stop'; tp2ExitPrice = pos.stopLoss;
        } else if (crossedSMA(ma50)) {
          tp2Hit = true; tp2Reason = 'sma50_touch';  tp2ExitPrice = ma50;
        } else if (crossedSMA(ma200)) {
          tp2Hit = true; tp2Reason = 'sma200_touch'; tp2ExitPrice = ma200;
        }
      } else { // short
        // V2.2: BE stop is broker-managed → skip the daily-poll BE check, keep SMA exits
        if (!posIsV2_2 && c.high >= pos.stopLoss) {
          tp2Hit = true; tp2Reason = 'breakeven_stop'; tp2ExitPrice = pos.stopLoss;
        } else if (crossedSMA(ma50)) {
          tp2Hit = true; tp2Reason = 'sma50_touch';  tp2ExitPrice = ma50;
        } else if (crossedSMA(ma200)) {
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

  // MANUAL-WATCH Telegram reminder — one consolidated message per run so the
  // trader is nudged to eyeball support on bullish-asset short runners.
  if (manualWatchList.length) {
    await tg.alertManualWatch({ positions: manualWatchList, mode: CONFIG.tradingMode }).catch(() => {});
  }
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

    // V2.2: size off the internal ledger, NOT Alpaca equity. The internal
    // ledger represents the compounding $30k target equity for live; sizing
    // against Alpaca's actual paper equity ($100k) inflates positions to
    // ~3× what they should be. Internal-ledger sizing keeps paper positions
    // representative of what the live account will actually do.
    if (preflight.equity > 0) {
      console.log(`[Alpaca] Broker equity: $${preflight.equity.toFixed(2)}  (informational — NOT used for sizing)`);
      console.log(`[Alpaca] Buying pwr  : $${preflight.buyingPower.toFixed(2)}`);
      console.log(`[Alpaca] Market open : ${preflight.marketOpen ? 'YES' : 'NO'}  next open: ${preflight.nextOpen}`);
      console.log(`[Sizing] V2.2 internal-ledger basis: $${CONFIG.accountUsd.toFixed(2)} (1% risk = $${(CONFIG.accountUsd * CONFIG.riskPct).toFixed(2)})`);

      // PRE-LIVE GUARD (spec §7): when going live, halt if broker equity
      // diverges from internal ledger by > 10% — catches funding gaps or
      // residual paper-account contamination before any real-money entry.
      if (CONFIG.tradingMode === 'live') {
        const divergence = Math.abs(preflight.equity - CONFIG.accountUsd) / CONFIG.accountUsd;
        if (divergence > 0.10) {
          console.error(`\n🚫 LIVE GUARD — broker equity $${preflight.equity.toFixed(2)} diverges from ledger $${CONFIG.accountUsd.toFixed(2)} by ${(divergence*100).toFixed(1)}% (>10%).`);
          console.error('   Refusing to submit entries. Reconcile the ledger before re-running.');
          writeLog({ kind: 'live_guard_halt', brokerEquity: preflight.equity, ledger: CONFIG.accountUsd, divergencePct: divergence });
          try { await tg.sendMessage(`🚫 SID LIVE GUARD halt — broker $${preflight.equity.toFixed(0)} vs ledger $${CONFIG.accountUsd.toFixed(0)} (${(divergence*100).toFixed(1)}% divergence). No entries until reconciled.`); } catch {}
          return;
        }
      }
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
      const { stillOpen, closedExternally, partialClosed } = await executor.syncPositions(localOpen);

      // ── Handle partial external closes (FIX task #25, 2026-06-05) ─────
      // Bot used to silently keep local qty unchanged when Alpaca showed a
      // smaller position. Now: detect, record the partial close in the journal,
      // and update local qty to match Alpaca truth.
      if (partialClosed.length) {
        console.log(`[Alpaca] Reconciliation: ${partialClosed.length} partial close(s) detected`);
        for (const event of partialClosed) {
          const { pos, prevQty, newQty, deltaShares } = event;
          console.log(`           - ${pos.symbol} ${pos.side}: ${prevQty} → ${newQty} (${deltaShares} sh closed externally)`);
          await recordExternalClose({
            pos,
            sharesClosed:  deltaShares,
            alpacaClient:  executor.client,
            reasonKind:    'partial_external_fill',
            isFullClose:   false,
          });

          // ── V2.2 TP1 fill detection ──────────────────────────────────────
          // If this partial close was the resting TP1 limit firing on a V2.2
          // position, mark tp1_hit + populate tp1_* fields on the live record
          // in stillOpen. maintainV2_2BrokerOrders on the next checkPositions
          // cycle will then refresh the broker stop to BE for the runner.
          //
          // Heuristic: posIsV2_2 + the partial close is ~50% of shares_total
          // (matches CONFIG.tp1Portion). Robust for paper-validation purposes;
          // would be tightened to client_order_id matching for live.
          const livePos = stillOpen.find(p => p.id === pos.id);
          if (livePos && isV2_2Position(livePos) && !livePos.tp1_hit) {
            const expectedTp1Qty = Math.floor(livePos.shares_total * CONFIG.tp1Portion);
            const tolerance = Math.max(1, Math.floor(expectedTp1Qty * 0.10)); // 10% slack on share count
            if (Math.abs(deltaShares - expectedTp1Qty) <= tolerance) {
              // Pull the best-guess fill price from Alpaca for the tp1_price field
              let tp1FillPrice = livePos.entry;  // safe fallback
              try {
                const orders = await executor.client.listOrders({ symbols: pos.symbol, status: 'closed', limit: 50 });
                const exitSide = livePos.side === 'long' ? 'sell' : 'buy';
                const fills = (orders || []).filter(o =>
                  o.side === exitSide &&
                  o.status === 'filled' &&
                  parseFloat(o.filled_qty || 0) > 0 &&
                  typeof o.client_order_id === 'string' &&
                  o.client_order_id.includes('-tp1')
                );
                if (fills.length > 0) {
                  // Weighted-avg of -tp1 fills
                  let tq = 0, tc = 0;
                  for (const f of fills) {
                    const q = parseFloat(f.filled_qty);
                    const p = parseFloat(f.filled_avg_price);
                    tq += q;
                    tc += q * p;
                  }
                  if (tq > 0) tp1FillPrice = tc / tq;
                }
              } catch (_) { /* fall back to entry */ }
              const tp1Pnl = livePos.side === 'long'
                ? (tp1FillPrice - livePos.entry) * deltaShares
                : (livePos.entry - tp1FillPrice) * deltaShares;
              livePos.tp1_hit    = true;
              livePos.tp1_date   = todayString();
              livePos.tp1_price  = parseFloat(tp1FillPrice.toFixed(4));
              livePos.tp1_shares = deltaShares;
              livePos.tp1_pnl    = parseFloat(tp1Pnl.toFixed(2));
              livePos.tp1_reason = 'rsi50_intraday';
              livePos.stopLoss   = parseFloat(livePos.entry.toFixed(2));  // BE for runner
              console.log(`  [V2.2] TP1 fill detected on ${livePos.symbol}: ${deltaShares}sh @ ~$${tp1FillPrice.toFixed(2)} → marking tp1_hit, stop migrates to BE next cycle`);
              try {
                await tg.sendMessage(
                  `🎯 <b>SID V2.2 TP1 filled</b>\n\n` +
                  `${livePos.symbol} ${livePos.side.toUpperCase()} ${deltaShares}sh @ $${tp1FillPrice.toFixed(2)}\n` +
                  `Entry: $${livePos.entry.toFixed(2)}  P&amp;L: ${tp1Pnl >= 0 ? '+' : ''}$${tp1Pnl.toFixed(2)}\n` +
                  `Runner ${livePos.shares_remaining}sh — stop migrates to BE this run.`
                );
              } catch (_) {}
            }
          }
        }
      }

      // ── Handle full external closes (FIX task #26, 2026-06-05) ────────
      // Bot used to log to safety log + remove from open-positions but never
      // write to closed-positions / trades.csv / sid-account. Now: full
      // journal update.
      if (closedExternally.length) {
        console.log(`[Alpaca] Reconciliation: ${closedExternally.length} position(s) closed externally (stop fills?)`);
        for (const pos of closedExternally) {
          const qtyClosed = pos.shares_remaining ?? pos.shares;
          console.log(`           - ${pos.symbol} ${pos.side} ${qtyClosed}sh (entry $${pos.entry})`);
          await recordExternalClose({
            pos,
            sharesClosed:  qtyClosed,
            alpacaClient:  executor.client,
            reasonKind:    'full_external_fill',
            isFullClose:   true,
          });
        }
      }

      if (partialClosed.length || closedExternally.length) {
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
    // BUG-FIX 2026-05-21: was `fetchDailyCandles(symbol)` (default '6mo'),
    // which resamples to ~26-28 weekly bars — below the weekly-direction
    // check's required 30.
    // BUG-FIX 2026-06-28: bumped 2y → 5y. The v2.3 entry overhaul added a
    // weekly SMA50/200 ARM gate which needs ≥200 weekly bars (~4y). With only
    // 2y (~104 weekly bars) that gate silently defaults to TRUE (inert), making
    // the live bot LOOSER than the validated backtest — it would arm longs in
    // weekly downtrends the backtest rejects. 5y (~260 weekly bars) seasons the
    // weekly SMA200/RSI/MACD so detectEntrySignal matches the backtest live.
    let candles;
    try {
      candles = await fetchDailyCandles(symbol, '5y');
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
    let orderId             = `SID-DRYRUN-${Date.now()}`;
    let exchange            = 'Yahoo/DryRun';
    let modeLabel           = 'dry_run';
    let stopOrderId         = null;     // V2.2: broker GTC stop placed alongside entry
    let clientOrderIdPrefix = null;     // V2.2: needed to find/refresh resting TP1 limit

    if (executor) {
      try {
        const result        = await executor.openEntry({ signal, sizing, symbol });
        orderId             = result.entryOrderId;
        stopOrderId         = result.stopOrderId;
        clientOrderIdPrefix = result.clientOrderIdPrefix;
        exchange            = `Alpaca/${CONFIG.tradingMode}`;
        modeLabel           = CONFIG.tradingMode;
        console.log(`    Order ID : ${orderId} (stop ${stopOrderId})`);
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
      // V2.2: broker-order tracking for resting stop + intraday TP1 limit
      brokerStopOrderId:   stopOrderId,
      clientOrderIdPrefix: clientOrderIdPrefix,
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

// Only auto-run the bot when this file is executed directly (e.g. `node
// bot-sid.js`, which is how sid.yml invokes it). When imported (e.g. by a test
// harness), skip the side-effecting run() so the pure functions can be unit
// tested in isolation.
import { pathToFileURL } from 'url';
const _isDirectRun = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (_isDirectRun) {
  run().catch(err => {
    console.error('Fatal error:', err.message);
    process.exit(1);
  });
}

// Exports for test harnesses (do NOT affect the direct-run path above).
export {
  detectEntrySignal,
  buildWeeklyDailyAligned,
  weeklyDirection,
  longTermBullish,
  calcRSI,
  calcMACD,
  calcSMA,
  CONFIG,
};
