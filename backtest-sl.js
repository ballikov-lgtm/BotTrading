// backtest-sl.js — Ironclad Rule Comparison Backtest  (v2.0)
// ─────────────────────────────────────────────────────────────────────────────
// Tests SEVEN rule sets against the same 5-day 15m candle window and outputs
// every detected signal as a row in backtest-sl.csv (Excel-compatible).
//
//  RULE A   — Baseline     : Take all signals. No filters.
//  RULE B   — SL Cap       : Skip if SL distance > 2% from entry.
//  RULE C   — Cooldown     : Skip if symbol was stopped out (LOSS) within 3h.
//  RULE D   — TP1 ATR      : Skip if TP1 is less than 1× LTF ATR from entry.
//  RULE E   — B+C+D        : All three original filters must pass.
//  RULE F   — BTC Trend    : Block entries that go against the BTC daily trend.
//                             BTC BULL → only LONGs across all symbols.
//                             BTC BEAR → only SHORTs across all symbols.
//                             BTC NEUTRAL → both directions allowed.
//  RULE G   — Wider SL     : Same entry signal but SL buffered at ATR × 1.0
//                             (instead of 0.5). Smaller position size, more
//                             room to breathe. Separate simulation.
//  RULE C+F  — Cool+BTC   : Both cooldown AND BTC trend filter must pass.
//  RULE C+F+G — All new   : Cooldown + BTC filter + wider SL.
//
// Summary table shows: A, C, F, G, C+F, C+F+G
// B/D/E are still in the CSV for reference.
//
// This script is READ-ONLY — it does not touch any live trading files.
// Run with:  node backtest-sl.js
// ─────────────────────────────────────────────────────────────────────────────

import fetch from 'node-fetch';
import fs    from 'fs';

// ── Config ────────────────────────────────────────────────────────────────────

const SYMBOLS = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT',
  'LINKUSDT', 'HYPEUSDT', 'VIRTUALUSDT',
  'APTUSDT',  'ONDOUSDT', 'JUPUSDT',
];

const PORTFOLIO_USD  = 500;
const LEVERAGE       = 3;
const MAX_TRADE_USD  = 50;

// Rule thresholds
const MAX_SL_PCT       = 0.02;   // Rule B: skip if SL > 2% from entry
const COOLDOWN_HOURS   = 3;      // Rule C: 3-hour cooldown after clean stop-out
const MIN_TP1_ATR      = 1.0;    // Rule D: TP1 must be ≥ 1× LTF ATR from entry
const SL_ATR_MULT_WIDE = 1.0;    // Rule G: wider SL multiplier (vs 0.5 baseline)
const SL_ATR_MULT_BASE = 0.5;    // Baseline SL multiplier (matches bot-ironclad.js)
const MIN_STOP_PCT     = 0.003;  // Minimum SL distance as pct of entry (both rules)

const SPLITS         = [0.40, 0.35, 0.25];
const LOOKBACK_BARS  = 480;    // ~5 days (96 bars/day × 5)
const LTF_CONTEXT    = 100;
const OUTPUT_PATH    = './backtest-sl.csv';
const BITGET_BASE    = 'https://api.bitget.com';

// ── Fetch Candles ─────────────────────────────────────────────────────────────

async function fetchCandles(symbol, granularity, limit) {
  const url  = `${BITGET_BASE}/api/v2/mix/market/candles?symbol=${symbol}&productType=USDT-FUTURES&granularity=${granularity}&limit=${limit}`;
  const res  = await fetch(url);
  const json = await res.json();
  if (!Array.isArray(json.data))
    throw new Error(`No candle data for ${symbol} ${granularity}: ${JSON.stringify(json).slice(0, 200)}`);
  return json.data.reverse().map(c => ({
    time:  parseInt(c[0]),
    open:  parseFloat(c[1]),
    high:  parseFloat(c[2]),
    low:   parseFloat(c[3]),
    close: parseFloat(c[4]),
  }));
}

// ── Indicators (exact copies from bot-ironclad.js) ────────────────────────────

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return 0;
  const trs = candles.slice(1).map((c, i) => {
    const p = candles[i];
    return Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
  });
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calcEMA(candles, period) {
  if (candles.length < period) return null;
  const k = 2 / (period + 1);
  let ema = candles.slice(0, period).reduce((s, c) => s + c.close, 0) / period;
  for (let i = period; i < candles.length; i++) ema = candles[i].close * k + ema * (1 - k);
  return ema;
}

function calcEMALevels(candles) {
  return {
    ema21:  calcEMA(candles, 21),
    ema50:  calcEMA(candles, 50),
    ema100: calcEMA(candles, 100),
    ema200: calcEMA(candles, 200),
  };
}

const FIB_RATIOS = [0.236, 0.382, 0.5, 0.618, 0.786, 1.0, 1.272, 1.618];

function calcFibLevels(direction, htfHighs, htfLows) {
  if (!htfHighs.length || !htfLows.length) return [];
  const high = htfHighs[htfHighs.length - 1].price;
  const low  = htfLows[htfLows.length  - 1].price;
  const rng  = high - low;
  if (rng <= 0) return [];
  return direction === 'long'
    ? FIB_RATIOS.map(r => low  + rng * r)
    : FIB_RATIOS.map(r => high - rng * r);
}

function calcTakeProfitLevels(direction, entry, stopLoss, ema, htfHighs, htfLows) {
  const risk       = Math.abs(entry - stopLoss);
  const candidates = [
    ema.ema21, ema.ema50, ema.ema100, ema.ema200,
    ...htfHighs.map(s => s.price),
    ...htfLows.map(s  => s.price),
    ...calcFibLevels(direction, htfHighs, htfLows),
  ].filter(Boolean);

  let levels = direction === 'long'
    ? candidates.filter(p => p > entry * 1.002).sort((a, b) => a - b)
    : candidates.filter(p => p < entry * 0.998).sort((a, b) => b - a);

  const deduped = [];
  for (const lvl of levels)
    if (!deduped.length || Math.abs(lvl - deduped[deduped.length - 1]) / entry > 0.003)
      deduped.push(lvl);

  const fb = direction === 'long'
    ? [entry + risk * 1.5, entry + risk * 2.5, entry + risk * 4.0]
    : [entry - risk * 1.5, entry - risk * 2.5, entry - risk * 4.0];

  const raw    = [deduped[0] ?? fb[0], deduped[1] ?? fb[1], deduped[2] ?? fb[2]];
  const sorted = raw.sort(direction === 'long' ? (a, b) => a - b : (a, b) => b - a);
  const [tp1, tp2, tp3] = sorted.map(t => parseFloat(t.toFixed(4)));
  const rr = t => parseFloat((Math.abs(t - entry) / risk).toFixed(2));
  return { tp1, tp2, tp3, rr1: rr(tp1), rr2: rr(tp2), rr3: rr(tp3) };
}

function detectSwings(candles, lookback = 2) {
  const highs = [], lows = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const c = candles[i];
    if (candles.slice(i - lookback, i).every(p => p.high <= c.high) &&
        candles.slice(i + 1, i + lookback + 1).every(p => p.high <= c.high))
      highs.push({ index: i, price: c.high, time: c.time });
    if (candles.slice(i - lookback, i).every(p => p.low >= c.low) &&
        candles.slice(i + 1, i + lookback + 1).every(p => p.low >= c.low))
      lows.push({ index: i, price: c.low, time: c.time });
  }
  return { swingHighs: highs, swingLows: lows };
}

function detectTrend(candles, lookback = 2, swingCount = 2, atrThreshold = 0.5) {
  const atr = calcATR(candles);
  const min  = atr * atrThreshold;
  const { swingHighs, swingLows } = detectSwings(candles, lookback);
  const fH = swingHighs.filter((s, i) => i === 0 || Math.abs(s.price - swingHighs[i-1].price) >= min);
  const fL = swingLows.filter( (s, i) => i === 0 || Math.abs(s.price - swingLows[i-1].price)  >= min);
  if (fH.length < swingCount || fL.length < swingCount)
    return { trend: 'neutral', swingHighs: fH, swingLows: fL };
  const rH = fH.slice(-swingCount);
  const rL = fL.slice(-swingCount);
  const hh = rH.every((s, i) => i === 0 || s.price > rH[i-1].price);
  const hl = rL.every((s, i) => i === 0 || s.price > rL[i-1].price);
  const lh = rH.every((s, i) => i === 0 || s.price < rH[i-1].price);
  const ll = rL.every((s, i) => i === 0 || s.price < rL[i-1].price);
  const trend = (hh && hl) ? 'bull' : (lh && ll) ? 'bear' : 'neutral';
  return { trend, swingHighs: fH, swingLows: fL };
}

function detectEntry(ltfCandles, htfTrend, lookback = 2) {
  const { swingHighs, swingLows } = detectSwings(ltfCandles, lookback);
  const price = ltfCandles[ltfCandles.length - 1].close;
  const atr   = calcATR(ltfCandles);

  if (htfTrend === 'bull' && swingLows.length >= 1) {
    const sw = swingLows[swingLows.length - 1];
    if (price > ltfCandles[sw.index].high) {
      const sl = parseFloat(Math.min(sw.price - atr * SL_ATR_MULT_BASE, price * (1 - MIN_STOP_PCT)).toFixed(4));
      return { signal: 'long', entry: price, stopLoss: sl, swingRef: sw.price, ltfAtr: atr };
    }
  }
  if (htfTrend === 'bear' && swingHighs.length >= 1) {
    const sw = swingHighs[swingHighs.length - 1];
    if (price < ltfCandles[sw.index].low) {
      const sl = parseFloat(Math.max(sw.price + atr * SL_ATR_MULT_BASE, price * (1 + MIN_STOP_PCT)).toFixed(4));
      return { signal: 'short', entry: price, stopLoss: sl, swingRef: sw.price, ltfAtr: atr };
    }
  }
  return null;
}

function calcQuantity(entry, stopLoss) {
  const riskUsd = PORTFOLIO_USD * 0.01;
  const slPct   = Math.abs(entry - stopLoss) / entry;
  return parseFloat((Math.min(riskUsd / (slPct * LEVERAGE), MAX_TRADE_USD) / entry).toFixed(6));
}

// ── Trade Simulation ──────────────────────────────────────────────────────────

function simulateTrade(side, entry, stopLoss, tp1, tp2, tp3, qty, futureCandles) {
  let currentSl = stopLoss;
  let tp1Hit = false, tp2Hit = false;
  let remaining = 1.0;
  const closes  = [];

  for (const c of futureCandles) {
    const d    = new Date(c.time).toISOString();
    const date = d.slice(0, 10);
    const time = d.slice(11, 19);

    if (side === 'long') {
      if (c.low <= currentSl) {
        closes.push({ price: currentSl, level: 'SL', date, time, pnl: (currentSl - entry) * qty * remaining * LEVERAGE });
        return { outcome: closes.some(x => x.level !== 'SL') ? 'BE' : 'LOSS', closes, exitLevel: 'SL', exitPrice: currentSl, resolveTime: c.time };
      }
      if (!tp1Hit && c.high >= tp1) {
        closes.push({ price: tp1, level: 'TP1', date, time, pnl: (tp1 - entry) * qty * SPLITS[0] * LEVERAGE });
        tp1Hit = true; remaining -= SPLITS[0]; currentSl = entry;
      }
      if (tp1Hit && !tp2Hit && c.high >= tp2) {
        closes.push({ price: tp2, level: 'TP2', date, time, pnl: (tp2 - entry) * qty * SPLITS[1] * LEVERAGE });
        tp2Hit = true; remaining -= SPLITS[1]; currentSl = tp1;
      }
      if (tp2Hit && c.high >= tp3) {
        closes.push({ price: tp3, level: 'TP3', date, time, pnl: (tp3 - entry) * qty * SPLITS[2] * LEVERAGE });
        return { outcome: 'WIN', closes, exitLevel: 'TP3', exitPrice: tp3, resolveTime: c.time };
      }
    } else {
      if (c.high >= currentSl) {
        closes.push({ price: currentSl, level: 'SL', date, time, pnl: (entry - currentSl) * qty * remaining * LEVERAGE });
        return { outcome: closes.some(x => x.level !== 'SL') ? 'BE' : 'LOSS', closes, exitLevel: 'SL', exitPrice: currentSl, resolveTime: c.time };
      }
      if (!tp1Hit && c.low <= tp1) {
        closes.push({ price: tp1, level: 'TP1', date, time, pnl: (entry - tp1) * qty * SPLITS[0] * LEVERAGE });
        tp1Hit = true; remaining -= SPLITS[0]; currentSl = entry;
      }
      if (tp1Hit && !tp2Hit && c.low <= tp2) {
        closes.push({ price: tp2, level: 'TP2', date, time, pnl: (entry - tp2) * qty * SPLITS[1] * LEVERAGE });
        tp2Hit = true; remaining -= SPLITS[1]; currentSl = tp1;
      }
      if (tp2Hit && c.low <= tp3) {
        closes.push({ price: tp3, level: 'TP3', date, time, pnl: (entry - tp3) * qty * SPLITS[2] * LEVERAGE });
        return { outcome: 'WIN', closes, exitLevel: 'TP3', exitPrice: tp3, resolveTime: c.time };
      }
    }
  }

  const last = closes[closes.length - 1];
  const out  = tp2Hit ? 'WIN_PARTIAL' : tp1Hit ? 'BE_PARTIAL' : 'OPEN';
  return { outcome: out, closes, exitLevel: last?.level ?? 'OPEN', exitPrice: null, resolveTime: null };
}

// ── Backtest a Single Symbol ──────────────────────────────────────────────────
// Rules B/C/D/F/G are evaluated per-signal but position tracking (nextFreeIdx)
// is always driven by the BASELINE (Rule A) so all rules see the same signals.
// Cooldown state is tracked from Rule A outcomes to ensure a fair comparison.

async function backtestSymbol(symbol, dailyCandles, ltfCandles, btcDailyCandles) {
  const results     = [];
  const startIdx    = Math.max(LTF_CONTEXT, ltfCandles.length - LOOKBACK_BARS);
  let nextFreeIdx   = startIdx;
  let cooldownUntil = 0;   // ms timestamp — updated from Rule A LOSS outcomes

  for (let i = startIdx; i < ltfCandles.length - 1; i++) {
    if (i < nextFreeIdx) continue;

    const bar = ltfCandles[i];

    // Only use fully-closed daily candles (1D candle closing = open + 24h)
    const availDaily = dailyCandles.filter(d => d.time + 86_400_000 <= bar.time);
    if (availDaily.length < 15) continue;

    const avail15m = ltfCandles.slice(Math.max(0, i - LTF_CONTEXT + 1), i + 1);
    if (avail15m.length < 20) continue;

    const htf = detectTrend(availDaily, 2, 2, 0.5);
    if (htf.trend === 'neutral') continue;

    const sig = detectEntry(avail15m, htf.trend, 2);
    if (!sig) continue;

    // ── Indicators ───────────────────────────────────────────────────────────
    const ema     = calcEMALevels(availDaily);
    const tps     = calcTakeProfitLevels(sig.signal, sig.entry, sig.stopLoss, ema, htf.swingHighs, htf.swingLows);
    const ltfAtr  = sig.ltfAtr ?? calcATR(avail15m);
    const slPct   = Math.abs(sig.entry - sig.stopLoss) / sig.entry;
    const tp1Dist = Math.abs(tps.tp1 - sig.entry);
    const qty     = calcQuantity(sig.entry, sig.stopLoss);

    // ── Rule F: BTC master trend filter ──────────────────────────────────────
    // Only use BTC daily candles that closed BEFORE this signal bar
    const availBtc  = btcDailyCandles.filter(d => d.time + 86_400_000 <= bar.time);
    const btcResult = availBtc.length >= 15 ? detectTrend(availBtc, 2, 2, 0.5) : { trend: 'neutral' };
    const btcTrend  = btcResult.trend;
    // BULL → only allow LONGs; BEAR → only allow SHORTs; NEUTRAL → allow both
    const ruleF_ok  = btcTrend === 'neutral'
                   || (btcTrend === 'bull' && sig.signal === 'long')
                   || (btcTrend === 'bear' && sig.signal === 'short');

    // ── Rule G: Wider SL (ATR × 1.0 instead of 0.5) ──────────────────────────
    const slG = sig.signal === 'long'
      ? parseFloat(Math.min(sig.swingRef - ltfAtr * SL_ATR_MULT_WIDE, sig.entry * (1 - MIN_STOP_PCT)).toFixed(4))
      : parseFloat(Math.max(sig.swingRef + ltfAtr * SL_ATR_MULT_WIDE, sig.entry * (1 + MIN_STOP_PCT)).toFixed(4));
    const slPctG = Math.abs(sig.entry - slG) / sig.entry;
    const tpsG   = calcTakeProfitLevels(sig.signal, sig.entry, slG, ema, htf.swingHighs, htf.swingLows);
    const qtyG   = calcQuantity(sig.entry, slG);

    // ── Rule evaluation — original rules ──────────────────────────────────────
    const ruleB_ok = slPct   <= MAX_SL_PCT;               // SL ≤ 2%
    const ruleC_ok = bar.time >= cooldownUntil;            // not on cooldown
    const ruleD_ok = tp1Dist >= ltfAtr * MIN_TP1_ATR;     // TP1 far enough

    // ── Combo rules ───────────────────────────────────────────────────────────
    const ruleCF_ok  = ruleC_ok && ruleF_ok;              // cooldown + BTC trend
    const ruleCFG_ok = ruleC_ok && ruleF_ok;              // same filter, wider SL sim

    // ── Simulate Rule A (baseline SL) ─────────────────────────────────────────
    const future = ltfCandles.slice(i + 1);
    const sim    = simulateTrade(sig.signal, sig.entry, sig.stopLoss, tps.tp1, tps.tp2, tps.tp3, qty, future);
    const pnl    = parseFloat(sim.closes.reduce((s, c) => s + c.pnl, 0).toFixed(2));

    // ── Simulate Rule G (wider SL) ────────────────────────────────────────────
    const simG  = simulateTrade(sig.signal, sig.entry, slG, tpsG.tp1, tpsG.tp2, tpsG.tp3, qtyG, future);
    const pnlG  = parseFloat(simG.closes.reduce((s, c) => s + c.pnl, 0).toFixed(2));

    // Advance position tracker based on Rule A outcome
    if (sim.resolveTime) {
      for (let j = i + 1; j < ltfCandles.length; j++) {
        if (ltfCandles[j].time >= sim.resolveTime) { nextFreeIdx = j + 1; break; }
      }
    } else {
      nextFreeIdx = ltfCandles.length;
    }

    // Update cooldown from Rule A LOSS outcomes — only clean losses trigger it
    if (sim.outcome === 'LOSS' && sim.resolveTime) {
      cooldownUntil = sim.resolveTime + COOLDOWN_HOURS * 3_600_000;
    }

    // ── Per-rule P&L ──────────────────────────────────────────────────────────
    const pnlB   = ruleB_ok   ? pnl  : 0;
    const pnlC   = ruleC_ok   ? pnl  : 0;
    const pnlD   = ruleD_ok   ? pnl  : 0;
    const ruleE_ok = ruleB_ok && ruleC_ok && ruleD_ok;
    const pnlE   = ruleE_ok   ? pnl  : 0;
    const pnlF   = ruleF_ok   ? pnl  : 0;    // Rule F: same sim as A (just filtered)
    const pnlCF  = ruleCF_ok  ? pnl  : 0;    // C+F: baseline sim
    const pnlCFG = ruleCFG_ok ? pnlG : 0;    // C+F+G: wider SL sim

    // ── Action strings ────────────────────────────────────────────────────────
    const actionB   = ruleB_ok   ? 'TAKEN' : 'SKIP_SL_2PCT';
    const actionC   = ruleC_ok   ? 'TAKEN' : 'BLOCK_COOLDOWN';
    const actionD   = ruleD_ok   ? 'TAKEN' : 'SKIP_TP1_ATR';
    const actionE   = ruleE_ok   ? 'TAKEN'
                    : !ruleB_ok  ? 'SKIP_SL_2PCT'
                    : !ruleC_ok  ? 'BLOCK_COOLDOWN'
                    :              'SKIP_TP1_ATR';
    const actionF   = ruleF_ok   ? 'TAKEN' : `BLOCK_BTC_${btcTrend.toUpperCase()}`;
    const actionCF  = ruleCF_ok  ? 'TAKEN'
                    : !ruleC_ok  ? 'BLOCK_COOLDOWN'
                    :              `BLOCK_BTC_${btcTrend.toUpperCase()}`;
    const actionCFG = ruleCFG_ok ? 'TAKEN_WIDE_SL'
                    : !ruleC_ok  ? 'BLOCK_COOLDOWN'
                    :              `BLOCK_BTC_${btcTrend.toUpperCase()}`;

    const date = new Date(bar.time).toISOString().slice(0, 10);
    const time = new Date(bar.time).toISOString().slice(11, 19);

    results.push({
      // ── Signal info ──────────────────────────────────────────────────────────
      Date:             date,
      Time:             time,
      Symbol:           symbol,
      Side:             sig.signal.toUpperCase(),
      Entry:            parseFloat(sig.entry.toFixed(4)),
      StopLoss:         parseFloat(sig.stopLoss.toFixed(4)),
      SwingRef:         parseFloat(sig.swingRef.toFixed(4)),
      SL_Dist_Pct:      parseFloat((slPct * 100).toFixed(2)),
      TP1:              parseFloat(tps.tp1.toFixed(4)),
      TP1_Dist:         parseFloat(tp1Dist.toFixed(4)),
      LTF_ATR:          parseFloat(ltfAtr.toFixed(4)),
      TP1_vs_ATR:       parseFloat((tp1Dist / ltfAtr).toFixed(2)),
      TP2:              parseFloat(tps.tp2.toFixed(4)),
      TP3:              parseFloat(tps.tp3.toFixed(4)),
      RR1:              tps.rr1,
      RR2:              tps.rr2,
      RR3:              tps.rr3,
      Size_USD:         parseFloat((qty * sig.entry).toFixed(2)),
      // ── Rule A — Baseline (no filters) ───────────────────────────────────────
      A_Outcome:        sim.outcome,
      A_Exit:           sim.exitLevel,
      A_Exit_Price:     sim.exitPrice != null ? parseFloat(sim.exitPrice.toFixed(4)) : '',
      A_PnL:            pnl,
      // ── Rule B — SL ≤ 2% ─────────────────────────────────────────────────────
      B_SL_Under2pct:   ruleB_ok ? 'YES' : 'NO',
      B_Action:         actionB,
      B_Outcome:        ruleB_ok  ? sim.outcome : 'SKIPPED',
      B_PnL:            pnlB,
      // ── Rule C — 3-hour cooldown after loss ───────────────────────────────────
      C_On_Cooldown:    ruleC_ok ? 'NO' : 'YES',
      C_Action:         actionC,
      C_Outcome:        ruleC_ok  ? sim.outcome : 'BLOCKED',
      C_PnL:            pnlC,
      // ── Rule D — TP1 ≥ 1× ATR ────────────────────────────────────────────────
      D_TP1_ATR_OK:     ruleD_ok ? 'YES' : 'NO',
      D_Action:         actionD,
      D_Outcome:        ruleD_ok  ? sim.outcome : 'FILTERED',
      D_PnL:            pnlD,
      // ── Rule E — All original filters combined (B + C + D) ────────────────────
      E_Action:         actionE,
      E_Outcome:        ruleE_ok  ? sim.outcome : 'BLOCKED',
      E_PnL:            pnlE,
      // ── Rule F — BTC master trend filter ──────────────────────────────────────
      BTC_Trend:        btcTrend,
      F_Aligned:        ruleF_ok ? 'YES' : 'NO',
      F_Action:         actionF,
      F_Outcome:        ruleF_ok  ? sim.outcome : 'BLOCKED',
      F_PnL:            pnlF,
      // ── Rule G — Wider SL (ATR × 1.0) ─────────────────────────────────────────
      G_SL:             parseFloat(slG.toFixed(4)),
      G_SL_Pct:         parseFloat((slPctG * 100).toFixed(2)),
      G_Size_USD:       parseFloat((qtyG * sig.entry).toFixed(2)),
      G_TP1:            parseFloat(tpsG.tp1.toFixed(4)),
      G_Outcome:        simG.outcome,
      G_PnL:            pnlG,
      // ── Rule C+F — Cooldown + BTC filter (baseline SL sim) ────────────────────
      CF_Action:        actionCF,
      CF_Outcome:       ruleCF_ok  ? sim.outcome : 'BLOCKED',
      CF_PnL:           pnlCF,
      // ── Rule C+F+G — Cooldown + BTC filter + wider SL ─────────────────────────
      CFG_Action:       actionCFG,
      CFG_Outcome:      ruleCFG_ok ? simG.outcome : 'BLOCKED',
      CFG_PnL:          pnlCFG,
      // ── P&L vs baseline ──────────────────────────────────────────────────────
      B_vs_A:           parseFloat((pnlB   - pnl).toFixed(2)),
      C_vs_A:           parseFloat((pnlC   - pnl).toFixed(2)),
      D_vs_A:           parseFloat((pnlD   - pnl).toFixed(2)),
      E_vs_A:           parseFloat((pnlE   - pnl).toFixed(2)),
      F_vs_A:           parseFloat((pnlF   - pnl).toFixed(2)),
      CF_vs_A:          parseFloat((pnlCF  - pnl).toFixed(2)),
      CFG_vs_A:         parseFloat((pnlCFG - pnl).toFixed(2)),
    });

    // Console line
    const flags = [
      !ruleC_ok ? 'COOL' : '',
      !ruleF_ok ? `BTC_${btcTrend.toUpperCase()}` : '',
    ].filter(Boolean).join(' ');
    const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
    const gStr   = pnlG >= 0 ? `+$${pnlG.toFixed(2)}` : `-$${Math.abs(pnlG).toFixed(2)}`;
    console.log(`    ${date} ${time} ${sig.signal.toUpperCase().padEnd(5)} @ ${sig.entry.toFixed(4)}  BTC:${btcTrend.padEnd(7)}  SL:${(slPct*100).toFixed(2)}%→${(slPctG*100).toFixed(2)}%  A:${pnlStr} G:${gStr}${flags ? '  ← ' + flags : ''}`);
  }

  return results;
}

// ── CSV Writer ────────────────────────────────────────────────────────────────

function writeCSV(rows) {
  if (!rows.length) { console.log('\nNo signals detected.'); return; }
  const headers = Object.keys(rows[0]);
  const lines   = [
    headers.join(','),
    ...rows.map(r => headers.map(h => {
      const v = r[h] ?? '';
      return String(v).includes(',') ? `"${v}"` : v;
    }).join(',')),
  ];
  fs.writeFileSync(OUTPUT_PATH, lines.join('\n'));
  console.log(`\n✅  CSV written → ${OUTPUT_PATH}  (${rows.length} signals)`);
}

// ── Summary ───────────────────────────────────────────────────────────────────

function printSummary(all) {
  const OPEN = ['OPEN', 'WIN_PARTIAL', 'BE_PARTIAL'];
  const resolved = all.filter(r => !OPEN.includes(r.A_Outcome));

  function stats(rows, pnlKey, outcomeKey, actionKey) {
    const taken  = rows.filter(r => r[actionKey] === 'TAKEN' && !OPEN.includes(r[outcomeKey]));
    const takenW = rows.filter(r => r[actionKey] === 'TAKEN_WIDE_SL' && !OPEN.includes(r[outcomeKey]));
    const allTkn = [...taken, ...takenW];
    const skip   = rows.filter(r => r[actionKey] !== 'TAKEN' && r[actionKey] !== 'TAKEN_WIDE_SL').length;
    const wins   = allTkn.filter(r => r[outcomeKey] === 'WIN').length;
    const losses = allTkn.filter(r => r[outcomeKey] === 'LOSS').length;
    const bes    = allTkn.filter(r => r[outcomeKey] === 'BE').length;
    const wr     = allTkn.length ? Math.round(wins / allTkn.length * 100) : 0;
    const tp1r   = allTkn.length ? Math.round((wins + bes) / allTkn.length * 100) : 0;
    const pnl    = rows.reduce((s, r) => s + (r[pnlKey] ?? 0), 0);
    return { taken: allTkn.length, skip, wins, losses, bes, wr, tp1r, pnl };
  }

  // Rule A stats (no action col — everything taken)
  const aWins   = resolved.filter(r => r.A_Outcome === 'WIN').length;
  const aLosses = resolved.filter(r => r.A_Outcome === 'LOSS').length;
  const aBEs    = resolved.filter(r => r.A_Outcome === 'BE').length;
  const aTp1r   = resolved.length ? Math.round((aWins + aBEs) / resolved.length * 100) : 0;
  const aPnl    = resolved.reduce((s, r) => s + r.A_PnL, 0);

  const c   = stats(all, 'C_PnL',   'C_Outcome',   'C_Action');
  const f   = stats(all, 'F_PnL',   'F_Outcome',   'F_Action');
  const g   = stats(all, 'G_PnL',   'G_Outcome',   'A_Action');   // G runs on all signals, use A_Action as proxy
  const cf  = stats(all, 'CF_PnL',  'CF_Outcome',  'CF_Action');
  const cfg = stats(all, 'CFG_PnL', 'CFG_Outcome', 'CFG_Action');

  // Rule G: all signals run (same as A but different sim) — compute manually
  const gResolved = resolved;  // same signals as A
  const gWins     = gResolved.filter(r => r.G_Outcome === 'WIN').length;
  const gLosses   = gResolved.filter(r => r.G_Outcome === 'LOSS').length;
  const gBEs      = gResolved.filter(r => r.G_Outcome === 'BE').length;
  const gTp1r     = gResolved.length ? Math.round((gWins + gBEs) / gResolved.length * 100) : 0;
  const gPnl      = resolved.reduce((s, r) => s + r.G_PnL, 0);

  const fmt  = n => (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(2);
  const pad  = (s, n) => String(s).padEnd(n);

  console.log(`\n╔════════════════════════════════════════════════════════════════════════════╗`);
  console.log(`║              IRONCLAD RULE COMPARISON — LAST 5 DAYS (v2.0)               ║`);
  console.log(`╠════════════════════════════════════════════════════════════════════════════╣`);
  console.log(`║  Total signals : ${pad(all.length, 58)} ║`);
  console.log(`║  Resolved      : ${pad(resolved.length, 58)} ║`);
  console.log(`╠══════════════════╦════════╦════════╦════════╦════════╦════════╦════════╣`);
  console.log(`║  Metric          ║   A    ║   C    ║   F    ║   G    ║  C+F   ║ C+F+G  ║`);
  console.log(`║                  ║ Base   ║ Cool3h ║BTC Trd ║ WideSL ║Cl+BTC  ║All New ║`);
  console.log(`╠══════════════════╬════════╬════════╬════════╬════════╬════════╬════════╣`);

  const row = (label, vals) => {
    const cells = vals.map(v => String(v).padEnd(6));
    console.log(`║  ${pad(label, 16)} ║ ${cells[0]} ║ ${cells[1]} ║ ${cells[2]} ║ ${cells[3]} ║ ${cells[4]} ║ ${cells[5]} ║`);
  };

  row('Taken',       [resolved.length,           c.taken,   f.taken,   gResolved.length, cf.taken,  cfg.taken]);
  row('Skipped',     [0,                          c.skip,    f.skip,    0,                cf.skip,   cfg.skip]);
  row('WIN (TP3)',   [aWins,                      c.wins,    f.wins,    gWins,            cf.wins,   cfg.wins]);
  row('LOSS',        [aLosses,                    c.losses,  f.losses,  gLosses,          cf.losses, cfg.losses]);
  row('BE (TP1+)',   [aBEs,                       c.bes,     f.bes,     gBEs,             cf.bes,    cfg.bes]);
  row('TP1+ rate',  [`${aTp1r}%`,               `${c.tp1r}%`,`${f.tp1r}%`,`${gTp1r}%`,`${cf.tp1r}%`,`${cfg.tp1r}%`]);
  row('Total P&L',  [fmt(aPnl),                  fmt(c.pnl),fmt(f.pnl),fmt(gPnl),       fmt(cf.pnl),fmt(cfg.pnl)]);
  row('vs Baseline',[`—`,                        fmt(c.pnl-aPnl),fmt(f.pnl-aPnl),fmt(gPnl-aPnl),fmt(cf.pnl-aPnl),fmt(cfg.pnl-aPnl)]);

  console.log(`╚══════════════════╩════════╩════════╩════════╩════════╩════════╩════════╝`);
  console.log(`\n  A=Baseline  C=3h cooldown  F=BTC trend gate  G=Wider SL (ATR×1.0)`);
  console.log(`  C+F = cooldown + BTC filter (same SL)   C+F+G = all three new rules`);
  console.log(`  TP1+ rate = % of taken trades where at least TP1 was hit (WIN or BE)`);
  console.log(`  G runs all signals — position size is smaller due to wider SL`);
  console.log(`  Open the CSV in Excel → Data → Filter (Ctrl+Shift+L) for full drill-down\n`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  console.log('══ Ironclad Rule Comparison Backtest (v2.0) ══');
  console.log(`New rules: F=BTC daily trend gate  G=wider SL (ATR×${SL_ATR_MULT_WIDE})`);
  console.log(`Window: ~5 days  |  ${SYMBOLS.length} symbols  |  ${LEVERAGE}x leverage\n`);

  // Fetch BTC daily candles ONCE — used as master trend filter for all symbols
  console.log('▶ Fetching BTC daily candles for master trend filter...');
  let btcDailyCandles;
  try {
    btcDailyCandles = await fetchCandles('BTCUSDT', '1D', 200);
    console.log(`  ✓ ${btcDailyCandles.length} BTC daily candles loaded\n`);
  } catch (err) {
    console.error(`  ✗ Failed to fetch BTC daily candles: ${err.message}`);
    process.exit(1);
  }

  const allResults = [];

  for (const symbol of SYMBOLS) {
    process.stdout.write(`▶ ${symbol} — fetching... `);
    try {
      const [dailyCandles, ltfCandles] = await Promise.all([
        fetchCandles(symbol, '1D',  200),
        fetchCandles(symbol, '15m', 500),
      ]);
      process.stdout.write(`${dailyCandles.length}d / ${ltfCandles.length}×15m\n`);
      const res = await backtestSymbol(symbol, dailyCandles, ltfCandles, btcDailyCandles);
      if (!res.length) console.log(`  (no signals)`);
      allResults.push(...res);
    } catch (err) {
      console.log(`\n  ✗ ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 350));
  }

  writeCSV(allResults);
  printSummary(allResults);
}

run().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
