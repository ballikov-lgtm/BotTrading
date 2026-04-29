// backtest-sl.js — Ironclad Stop Loss Rule Comparison
// ─────────────────────────────────────────────────────────────────────────────
// Compares TWO stop loss rules over the last 5 days of 15m candle data:
//
//   CURRENT RULE  — Place SL just below 15m swing low (- ATR × 0.5).
//                   Trade taken regardless of how far SL is from entry.
//
//   PROPOSED RULE — Same SL placement, but SKIP the trade if SL distance
//                   from entry exceeds 2%. Removes wide-stop setups that
//                   produce outsized losses relative to the risk taken.
//
// Output: backtest-sl.csv  (Excel-compatible, all filters on every column)
// This script is READ-ONLY — it does not touch any live trading files.
// ─────────────────────────────────────────────────────────────────────────────

import fetch from 'node-fetch';
import fs    from 'fs';

// ── Config ────────────────────────────────────────────────────────────────────

const SYMBOLS = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT',
  'LINKUSDT', 'HYPEUSDT', 'VIRTUALUSDT',
  'APTUSDT',  'ONDOUSDT', 'JUPUSDT',
];

const PORTFOLIO_USD  = 500;    // Same as live bot
const LEVERAGE       = 3;      // Same as live bot
const MAX_TRADE_USD  = 50;     // Same as live bot
const MAX_SL_PCT     = 0.02;   // Proposed: skip if SL > 2% from entry
const SPLITS         = [0.40, 0.35, 0.25]; // TP1 / TP2 / TP3 position fractions

const LOOKBACK_BARS  = 480;    // ~5 days (96 bars/day × 5)
const LTF_CONTEXT    = 100;    // 15m bars of history for indicators
const OUTPUT_PATH    = './backtest-sl.csv';
const BITGET_BASE    = 'https://api.bitget.com';

// ── Fetch Candles (Public — no auth needed) ───────────────────────────────────

async function fetchCandles(symbol, granularity, limit) {
  const url  = `${BITGET_BASE}/api/v2/mix/market/candles?symbol=${symbol}&productType=USDT-FUTURES&granularity=${granularity}&limit=${limit}`;
  const res  = await fetch(url);
  const json = await res.json();
  if (!Array.isArray(json.data)) {
    throw new Error(`No candle data for ${symbol} ${granularity}: ${JSON.stringify(json).slice(0, 200)}`);
  }
  // BitGet returns newest first — reverse to chronological order
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
  const high  = htfHighs[htfHighs.length - 1].price;
  const low   = htfLows[htfLows.length  - 1].price;
  const range = high - low;
  if (range <= 0) return [];
  if (direction === 'long') return FIB_RATIOS.map(r => low  + range * r);
  return FIB_RATIOS.map(r => high - range * r);
}

function calcTakeProfitLevels(direction, entry, stopLoss, ema, htfHighs, htfLows) {
  const risk       = Math.abs(entry - stopLoss);
  const candidates = [
    ema.ema21, ema.ema50, ema.ema100, ema.ema200,
    ...htfHighs.map(s => s.price),
    ...htfLows.map(s  => s.price),
    ...calcFibLevels(direction, htfHighs, htfLows),
  ].filter(Boolean);

  let levels;
  if (direction === 'long') {
    levels = candidates.filter(p => p > entry * 1.002).sort((a, b) => a - b);
  } else {
    levels = candidates.filter(p => p < entry * 0.998).sort((a, b) => b - a);
  }

  // De-duplicate levels within 0.3% of each other
  const deduped = [];
  for (const lvl of levels) {
    if (!deduped.length || Math.abs(lvl - deduped[deduped.length - 1]) / entry > 0.003) {
      deduped.push(lvl);
    }
  }

  // Fallback R:R multiples if not enough S/R levels found
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
  return { trend, swingHighs: fH, swingLows: fL, atr };
}

function detectEntry(ltfCandles, htfTrend, lookback = 2) {
  const { swingHighs, swingLows } = detectSwings(ltfCandles, lookback);
  const price        = ltfCandles[ltfCandles.length - 1].close;
  const atr          = calcATR(ltfCandles);
  const MIN_STOP_PCT = 0.003;

  if (htfTrend === 'bull' && swingLows.length >= 1) {
    const sw      = swingLows[swingLows.length - 1];
    const swHigh  = ltfCandles[sw.index].high;
    if (price > swHigh) {
      const sl = parseFloat(Math.min(sw.price - atr * 0.5, price * (1 - MIN_STOP_PCT)).toFixed(4));
      return { signal: 'long', entry: price, stopLoss: sl, swingRef: sw.price };
    }
  }

  if (htfTrend === 'bear' && swingHighs.length >= 1) {
    const sw     = swingHighs[swingHighs.length - 1];
    const swLow  = ltfCandles[sw.index].low;
    if (price < swLow) {
      const sl = parseFloat(Math.max(sw.price + atr * 0.5, price * (1 + MIN_STOP_PCT)).toFixed(4));
      return { signal: 'short', entry: price, stopLoss: sl, swingRef: sw.price };
    }
  }
  return null;
}

function calcQuantity(entry, stopLoss) {
  const riskUsd  = PORTFOLIO_USD * 0.01;
  const slPct    = Math.abs(entry - stopLoss) / entry;
  const sizeUsd  = Math.min(riskUsd / (slPct * LEVERAGE), MAX_TRADE_USD);
  return parseFloat((sizeUsd / entry).toFixed(6));
}

// ── Trade Simulation ──────────────────────────────────────────────────────────
// Walks candles chronologically and applies the 3-TP trailing SL plan:
//   SL hit first (pessimistic) on any candle where both SL and TP are reachable.
//   TP1 → close 40%, SL trails to break-even
//   TP2 → close 35%, SL trails to TP1
//   TP3 → close final 25%, fully exited
//
// Returns outcome, partial close list, final exit details, and the candle timestamp
// at which the position was resolved (so the caller knows when to start looking
// for the next entry).

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
      // SL checked first on every candle (pessimistic)
      if (c.low <= currentSl) {
        const pnl = (currentSl - entry) * qty * remaining * LEVERAGE;
        closes.push({ price: currentSl, level: 'SL', date, time, pnl });
        const out = closes.some(x => x.level !== 'SL') ? 'BE' : 'LOSS';
        return { outcome: out, closes, exitLevel: 'SL', exitPrice: currentSl, resolveTime: c.time };
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

    } else { // short

      if (c.high >= currentSl) {
        const pnl = (entry - currentSl) * qty * remaining * LEVERAGE;
        closes.push({ price: currentSl, level: 'SL', date, time, pnl });
        const out = closes.some(x => x.level !== 'SL') ? 'BE' : 'LOSS';
        return { outcome: out, closes, exitLevel: 'SL', exitPrice: currentSl, resolveTime: c.time };
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

  // Reached end of available candle data — position not yet resolved
  const last = closes[closes.length - 1];
  const out  = tp2Hit ? 'WIN_PARTIAL' : tp1Hit ? 'BE_PARTIAL' : 'OPEN';
  return { outcome: out, closes, exitLevel: last?.level ?? 'OPEN', exitPrice: null, resolveTime: null };
}

// ── Backtest a Single Symbol ──────────────────────────────────────────────────
// Walks every 15m bar in the backtest window. When a signal is detected, the
// full position lifecycle is simulated immediately using subsequent bars.
// nextFreeIdx prevents re-entering while a position is already active.

async function backtestSymbol(symbol, dailyCandles, ltfCandles) {
  const results    = [];
  const startIdx   = Math.max(LTF_CONTEXT, ltfCandles.length - LOOKBACK_BARS);
  let nextFreeIdx  = startIdx;

  for (let i = startIdx; i < ltfCandles.length - 1; i++) {
    if (i < nextFreeIdx) continue;

    const bar = ltfCandles[i];

    // Only use fully-closed daily candles — a 1D candle starting at T closes at T + 24h
    const availDaily = dailyCandles.filter(d => d.time + 86_400_000 <= bar.time);
    if (availDaily.length < 15) continue;

    // Sliding 15m context window (LTF_CONTEXT bars up to and including current)
    const avail15m = ltfCandles.slice(Math.max(0, i - LTF_CONTEXT + 1), i + 1);
    if (avail15m.length < 20) continue;

    // ── Step 1: Detect HTF trend ──────────────────────────────────────────────
    const htf = detectTrend(availDaily, 2, 2, 0.5);
    if (htf.trend === 'neutral') continue;

    // ── Step 2: Detect LTF entry ──────────────────────────────────────────────
    const sig = detectEntry(avail15m, htf.trend, 2);
    if (!sig) continue;

    // ── Step 3: Calculate TPs ─────────────────────────────────────────────────
    const ema = calcEMALevels(availDaily);
    const tps = calcTakeProfitLevels(sig.signal, sig.entry, sig.stopLoss, ema, htf.swingHighs, htf.swingLows);

    const slPct  = Math.abs(sig.entry - sig.stopLoss) / sig.entry;
    const under2 = slPct <= MAX_SL_PCT;
    const qty    = calcQuantity(sig.entry, sig.stopLoss);

    // ── Step 4: Simulate using all candles after entry bar ────────────────────
    const future = ltfCandles.slice(i + 1);
    const sim    = simulateTrade(sig.signal, sig.entry, sig.stopLoss, tps.tp1, tps.tp2, tps.tp3, qty, future);
    const pnl    = parseFloat(sim.closes.reduce((s, c) => s + c.pnl, 0).toFixed(2));

    // ── Step 5: Advance past the resolved position ────────────────────────────
    if (sim.resolveTime) {
      // Find the index of the candle where the trade resolved, then skip to i+1
      for (let j = i + 1; j < ltfCandles.length; j++) {
        if (ltfCandles[j].time >= sim.resolveTime) { nextFreeIdx = j + 1; break; }
      }
    } else {
      // Trade still open — no more data to simulate; stop looking for this symbol
      nextFreeIdx = ltfCandles.length;
    }

    // ── Step 6: Record result ─────────────────────────────────────────────────
    const date = new Date(bar.time).toISOString().slice(0, 10);
    const time = new Date(bar.time).toISOString().slice(11, 19);

    // PnL_Difference: how the NEW rule performs vs CURRENT rule for this trade
    //  - Trade taken under both rules: difference = 0
    //  - Trade SKIPPED by new rule   : difference = how much we saved/missed by not taking it
    //    e.g. current was -$3.50 (loss) → new saves +$3.50
    //    e.g. current was +$5.00 (win)  → new misses -$5.00
    const pnlDiff = parseFloat((under2 ? 0 : -pnl).toFixed(2));

    results.push({
      Date:               date,
      Time:               time,
      Symbol:             symbol,
      Side:               sig.signal.toUpperCase(),
      Entry:              parseFloat(sig.entry.toFixed(4)),
      StopLoss:           parseFloat(sig.stopLoss.toFixed(4)),
      SwingRef:           parseFloat(sig.swingRef.toFixed(4)),
      SL_Dist_Pct:        parseFloat((slPct * 100).toFixed(2)),
      SL_Under_2pct:      under2 ? 'YES' : 'NO',
      TP1:                parseFloat(tps.tp1.toFixed(4)),
      TP2:                parseFloat(tps.tp2.toFixed(4)),
      TP3:                parseFloat(tps.tp3.toFixed(4)),
      RR1:                tps.rr1,
      RR2:                tps.rr2,
      RR3:                tps.rr3,
      Size_USD:           parseFloat((qty * sig.entry).toFixed(2)),
      // ── CURRENT RULE: all signals taken ────────────────────────────────────
      Current_Outcome:    sim.outcome,
      Current_Exit_Level: sim.exitLevel,
      Current_Exit_Price: sim.exitPrice != null ? parseFloat(sim.exitPrice.toFixed(4)) : '',
      Current_PnL_USD:    pnl,
      // ── NEW RULE: skip if SL > 2% ──────────────────────────────────────────
      New_Rule_Action:    under2 ? 'TAKEN' : 'SKIPPED',
      New_Outcome:        under2 ? sim.outcome : 'SKIPPED',
      New_Exit_Level:     under2 ? sim.exitLevel : 'SKIPPED',
      New_Exit_Price:     under2 && sim.exitPrice != null ? parseFloat(sim.exitPrice.toFixed(4)) : '',
      New_PnL_USD:        under2 ? pnl : 0,
      PnL_Difference:     pnlDiff,
    });

    const flag   = under2 ? '' : ' ← WOULD SKIP (SL > 2%)';
    const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
    console.log(`    ${date} ${time} ${sig.signal.toUpperCase().padEnd(5)} @ ${sig.entry.toFixed(4)}  SL:${(slPct*100).toFixed(2)}%  → ${sim.outcome.padEnd(12)} ${pnlStr}${flag}`);
  }

  return results;
}

// ── CSV Writer ────────────────────────────────────────────────────────────────

function writeCSV(rows) {
  if (!rows.length) {
    console.log('\nNo signals detected — nothing to write.');
    return;
  }
  const headers = Object.keys(rows[0]);
  const lines   = [
    headers.join(','),
    ...rows.map(r =>
      headers.map(h => {
        const v = r[h] ?? '';
        return String(v).includes(',') ? `"${v}"` : v;
      }).join(',')
    ),
  ];
  fs.writeFileSync(OUTPUT_PATH, lines.join('\n'));
  console.log(`\n✅  CSV written → ${OUTPUT_PATH}  (${rows.length} signals)`);
}

// ── Summary Table ─────────────────────────────────────────────────────────────

function printSummary(results) {
  // Exclude OPEN / PARTIAL outcomes from win rate (incomplete data)
  const OPEN_OUTCOMES = ['OPEN', 'WIN_PARTIAL', 'BE_PARTIAL'];
  const resolved      = results.filter(r => !OPEN_OUTCOMES.includes(r.Current_Outcome));

  const cWins   = resolved.filter(r => r.Current_Outcome === 'WIN').length;
  const cLosses = resolved.filter(r => r.Current_Outcome === 'LOSS').length;
  const cBE     = resolved.filter(r => r.Current_Outcome === 'BE').length;
  const cPnl    = resolved.reduce((s, r) => s + r.Current_PnL_USD, 0);

  const newTaken   = results.filter(r => r.New_Rule_Action === 'TAKEN' && !OPEN_OUTCOMES.includes(r.New_Outcome));
  const skipped    = results.filter(r => r.New_Rule_Action === 'SKIPPED');
  const nWins      = newTaken.filter(r => r.New_Outcome === 'WIN').length;
  const nLosses    = newTaken.filter(r => r.New_Outcome === 'LOSS').length;
  const nBE        = newTaken.filter(r => r.New_Outcome === 'BE').length;
  const nPnl       = results.reduce((s, r) => s + r.New_PnL_USD, 0);

  const skippedLosses = skipped.filter(r => r.Current_Outcome === 'LOSS' || r.Current_Outcome === 'BE').length;
  const skippedWins   = skipped.filter(r => r.Current_Outcome === 'WIN').length;
  const skippedPnl    = skipped.reduce((s, r) => s + r.Current_PnL_USD, 0);

  const fmt = (n) => (n >= 0 ? '+' : '') + '$' + Math.abs(n).toFixed(2);

  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║              IRONCLAD SL BACKTEST SUMMARY                   ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║  Period        : Last 5 days of 15m candle data              ║`);
  console.log(`║  Symbols       : ${SYMBOLS.length} crypto pairs                             ║`);
  console.log(`║  Total signals : ${String(results.length).padEnd(44)} ║`);
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log('║  CURRENT RULE — Take all signals (no SL cap)                 ║');
  console.log(`║    Resolved    : ${String(resolved.length).padEnd(44)} ║`);
  console.log(`║    WIN/LOSS/BE : ${cWins}/${cLosses}/${cBE}${' '.repeat(42 - String(cWins+'/'+cLosses+'/'+cBE).length)} ║`);
  console.log(`║    Win rate    : ${String(resolved.length ? Math.round(cWins/resolved.length*100) : 0).padEnd(3)}%${' '.repeat(41)} ║`);
  console.log(`║    Total P&L   : ${fmt(cPnl).padEnd(44)} ║`);
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log('║  NEW RULE — Skip if SL > 2% from entry                       ║');
  console.log(`║    Taken       : ${String(newTaken.length).padEnd(44)} ║`);
  console.log(`║    Skipped     : ${String(skipped.length).padEnd(44)} ║`);
  console.log(`║    WIN/LOSS/BE : ${nWins}/${nLosses}/${nBE}${' '.repeat(42 - String(nWins+'/'+nLosses+'/'+nBE).length)} ║`);
  console.log(`║    Win rate    : ${String(newTaken.length ? Math.round(nWins/newTaken.length*100) : 0).padEnd(3)}%${' '.repeat(41)} ║`);
  console.log(`║    Total P&L   : ${fmt(nPnl).padEnd(44)} ║`);
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log('║  SKIPPED TRADES BREAKDOWN                                    ║');
  console.log(`║    Losses/BE avoided   : ${String(skippedLosses).padEnd(36)} ║`);
  console.log(`║    Wins missed         : ${String(skippedWins).padEnd(36)} ║`);
  console.log(`║    P&L of skipped set  : ${fmt(skippedPnl).padEnd(36)} ║`);
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║  NET DIFFERENCE (new vs current): ${fmt(nPnl - cPnl).padEnd(28)} ║`);
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`Open the CSV in Excel: Data → Filter (Ctrl+Shift+L) for full analysis.`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  console.log('══ Ironclad Stop Loss Backtest ══');
  console.log(`Comparing: CURRENT (no cap) vs NEW (skip SL > ${MAX_SL_PCT * 100}%)`);
  console.log(`Window: last ~5 days  |  Symbols: ${SYMBOLS.length}  |  Leverage: ${LEVERAGE}x\n`);

  const allResults = [];

  for (const symbol of SYMBOLS) {
    process.stdout.write(`▶ ${symbol} — fetching candles... `);
    try {
      const [dailyCandles, ltfCandles] = await Promise.all([
        fetchCandles(symbol, '1D',  200),
        fetchCandles(symbol, '15m', 500),
      ]);
      process.stdout.write(`${dailyCandles.length} daily, ${ltfCandles.length} 15m bars\n`);

      const results = await backtestSymbol(symbol, dailyCandles, ltfCandles);
      if (!results.length) {
        console.log(`  (no signals detected)`);
      }
      allResults.push(...results);
    } catch (err) {
      console.log(`\n  ✗ ${err.message}`);
    }

    // Small delay between symbols to stay well within rate limits
    await new Promise(r => setTimeout(r, 350));
  }

  writeCSV(allResults);
  printSummary(allResults);
}

run().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
