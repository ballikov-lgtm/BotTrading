/**
 * strategy-audit.js
 * ─────────────────
 * Pre-flight audit for any Ironclad-compatible strategy.
 * Run this BEFORE enabling a strategy with real capital.
 *
 * Usage:
 *   node strategy-audit.js                      ← audits rules-ironclad.json (default)
 *   node strategy-audit.js rules-sid.json        ← audits a different strategy
 *   node strategy-audit.js --symbol BTCUSDT      ← run live checks on one symbol
 *
 * Checks performed:
 *   [A] API connectivity          — can we reach Bitget and get data?
 *   [B] Candle ordering           — oldest first (ascending)? .reverse() applied wrong?
 *   [C] Candle completeness       — no large time gaps, correct count returned
 *   [D] Swing detection direction — swingHighs[last] is more recent than swingHighs[0]
 *   [E] Swing detection logic     — 6 synthetic patterns that must pass/block correctly
 *   [F] Trend detection           — known bull/bear sequences produce correct output
 *   [G] Entry logic               — lower-high / higher-low structure correctly enforced
 *   [H] Risk config               — leverage, position size, max trades within safe limits
 *   [I] Symbol reachability       — all symbols in the watchlist return valid candles
 *   [J] Live sanity               — run the full detection stack on 3 live symbols
 *
 * Exit code 0 = all checks passed. Non-zero = at least one FAIL.
 */

import fetch     from 'node-fetch';
import crypto    from 'crypto';
import fs        from 'fs';
import path      from 'path';

// ── Config ────────────────────────────────────────────────────────────────────

// Auto-detect rules file:
//   1. CLI arg  →  node strategy-audit.js rules-sid.json
//   2. Single rules-*.json in cwd  →  picked up automatically
//   3. Multiple found  →  picks first, warns user
//   4. None found  →  falls back to rules-ironclad.json
const RULES_FILE = (() => {
  if (process.argv[2]?.endsWith('.json')) return process.argv[2];
  try {
    const found = fs.readdirSync('.').filter(f => /^rules-.+\.json$/.test(f));
    if (found.length === 1) return found[0];
    if (found.length > 1) {
      console.warn(`⚠  Multiple rules files found: ${found.join(', ')} — using ${found[0]}. Pass a filename to override.`);
      return found[0];
    }
  } catch (_) {}
  return 'rules-ironclad.json';
})();

const SYMBOL_OVERRIDE = (() => {
  const i = process.argv.indexOf('--symbol');
  return i !== -1 ? process.argv[i + 1] : null;
})();

const rules = JSON.parse(fs.readFileSync(RULES_FILE, 'utf8'));

const API_KEY = process.env.BITGET_API_KEY    || 'bg_46c0aaf2c28b996a642a39f437a6f9dc';
const SECRET  = process.env.BITGET_SECRET_KEY || '8008e0da0054e9878df767be2f67ddd5d3b9be20f228eaca229cbf7ec126dc8c';
const PASS    = process.env.BITGET_PASSPHRASE || 'P4VlOvN4T4BeLkO';
const BASE    = 'https://api.bitget.com';

// ── Audit state ───────────────────────────────────────────────────────────────

let totalChecks = 0;
let totalFails  = 0;
const failLog   = [];

function pass(label) {
  totalChecks++;
  console.log(`  ✅  ${label}`);
}

function fail(label, detail = '') {
  totalChecks++;
  totalFails++;
  const msg = `  ❌  ${label}${detail ? ' — ' + detail : ''}`;
  console.log(msg);
  failLog.push(label + (detail ? ': ' + detail : ''));
}

function warn(label, detail = '') {
  console.log(`  ⚠️   ${label}${detail ? ' — ' + detail : ''}`);
}

function section(title) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('─'.repeat(60));
}

// ── Bitget helpers ────────────────────────────────────────────────────────────

function sign(ts, m, p) {
  return crypto.createHmac('sha256', SECRET).update(ts + m + p).digest('base64');
}

async function bg(path_, params = {}) {
  const ts  = Date.now().toString();
  const qs  = Object.keys(params).length ? '?' + new URLSearchParams(params) : '';
  const fp  = path_ + qs;
  const sig = sign(ts, 'GET', fp);
  const r   = await fetch(BASE + fp, {
    headers: {
      'ACCESS-KEY': API_KEY, 'ACCESS-SIGN': sig,
      'ACCESS-TIMESTAMP': ts, 'ACCESS-PASSPHRASE': PASS, locale: 'en-US',
    },
  });
  return r.json();
}

async function fetchCandles(symbol, tf, limit = 100) {
  const gran = { '15m': '15m', '4h': '4H', '1h': '1H', '1d': '1D', '1D': '1D' }[tf] || tf;
  const d = await bg('/api/v2/mix/market/candles', {
    symbol, productType: 'USDT-FUTURES', granularity: gran, limit,
  });
  // Bitget returns ascending (oldest first) — NO .reverse()
  return (d.data || []).map(c => ({
    time: +c[0], open: +c[1], high: +c[2], low: +c[3], close: +c[4], volume: +c[5],
  }));
}

// ── Core detection (copied from bot to test independently) ────────────────────

function calcATR(c, p = 14) {
  const trs = c.slice(1).map((x, i) =>
    Math.max(x.high - x.low, Math.abs(x.high - c[i].close), Math.abs(x.low - c[i].close))
  );
  return trs.slice(-p).reduce((a, b) => a + b, 0) / p;
}

function detectSwings(candles, lookback = 2) {
  const H = [], L = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const isH = candles.slice(i - lookback, i).every(p => p.high <= candles[i].high)
             && candles.slice(i + 1, i + lookback + 1).every(p => p.high <= candles[i].high);
    const isL = candles.slice(i - lookback, i).every(p => p.low >= candles[i].low)
             && candles.slice(i + 1, i + lookback + 1).every(p => p.low >= candles[i].low);
    if (isH) H.push({ index: i, price: candles[i].high, time: candles[i].time });
    if (isL) L.push({ index: i, price: candles[i].low,  time: candles[i].time });
  }
  return { swingHighs: H, swingLows: L };
}

function detectTrend(candles, lookback = 2, sc = 2, atrT = 0.5) {
  const atr = calcATR(candles);
  const { swingHighs: H, swingLows: L } = detectSwings(candles, lookback);
  const fH = H.filter((s, i) => i === 0 || Math.abs(s.price - H[i - 1].price) >= atr * atrT);
  const fL = L.filter((s, i) => i === 0 || Math.abs(s.price - L[i - 1].price) >= atr * atrT);
  if (fH.length < sc || fL.length < sc) return { trend: 'neutral', swingHighs: fH, swingLows: fL };
  const rH = fH.slice(-sc), rL = fL.slice(-sc);
  const HH = rH.every((s, i) => i === 0 || s.price > rH[i - 1].price);
  const HL = rL.every((s, i) => i === 0 || s.price > rL[i - 1].price);
  const LH = rH.every((s, i) => i === 0 || s.price < rH[i - 1].price);
  const LL = rL.every((s, i) => i === 0 || s.price < rL[i - 1].price);
  let trend = 'neutral';
  if (HH && HL) trend = 'bull';
  if (LH && LL) trend = 'bear';
  return { trend, swingHighs: fH, swingLows: fL };
}

function detectEntry(ltfCandles, htfTrend, lookback = 2, MAX_ENTRY_BARS = 12) {
  const { swingHighs, swingLows } = detectSwings(ltfCandles, lookback);
  const price = ltfCandles[ltfCandles.length - 1].close;
  const atr   = calcATR(ltfCandles);
  const MIN_STOP_PCT = 0.003;

  if (htfTrend === 'bull' && swingLows.length >= 2) {
    const prev = swingLows[swingLows.length - 2];
    const curr = swingLows[swingLows.length - 1];
    const isHL      = curr.price > prev.price;
    const bars      = ltfCandles.length - 1 - curr.index;
    const shBetween = swingHighs.find(sh => sh.index > prev.index && sh.index < curr.index);
    const slHigh    = ltfCandles[curr.index].high;
    const breakout  = price > slHigh;
    if (isHL && bars <= MAX_ENTRY_BARS && shBetween && breakout) {
      return { signal: 'long', entry: price, stopLoss: Math.min(curr.price - atr * 0.5, price * (1 - MIN_STOP_PCT)) };
    }
    return null;
  }

  if (htfTrend === 'bear' && swingHighs.length >= 2) {
    const prev = swingHighs[swingHighs.length - 2];
    const curr = swingHighs[swingHighs.length - 1];
    const isLH      = curr.price < prev.price;
    const bars      = ltfCandles.length - 1 - curr.index;
    const slBetween = swingLows.find(sl => sl.index > prev.index && sl.index < curr.index);
    const shLow     = ltfCandles[curr.index].low;
    const breakdown = price < shLow;
    if (isLH && bars <= MAX_ENTRY_BARS && slBetween && breakdown) {
      return { signal: 'short', entry: price, stopLoss: Math.max(curr.price + atr * 0.5, price * (1 + MIN_STOP_PCT)) };
    }
    return null;
  }
  return null;
}

// ── Synthetic candle builder ──────────────────────────────────────────────────

// Build a minimal OHLC candle sequence from an array of [high, low, close] triples.
// Time steps 1 minute apart (exact values don't matter for swing logic).
function buildCandles(triples) {
  return triples.map(([h, l, c], i) => ({
    time: i * 60000, open: c, high: h, low: l, close: c, volume: 1,
  }));
}

// ── CHECK A: API connectivity ─────────────────────────────────────────────────

async function checkApiConnectivity() {
  section('[A] API Connectivity');
  try {
    const d = await bg('/api/v2/mix/market/candles', {
      symbol: 'BTCUSDT', productType: 'USDT-FUTURES', granularity: '15m', limit: '5',
    });
    if (Array.isArray(d.data) && d.data.length > 0) {
      pass('Bitget candle endpoint reachable');
    } else {
      fail('Bitget candle endpoint returned empty data', JSON.stringify(d).slice(0, 120));
    }
  } catch (e) {
    fail('Bitget API unreachable', e.message);
  }

  try {
    const d = await bg('/api/v2/mix/position/all-position', {
      productType: 'USDT-FUTURES', marginCoin: 'USDT',
    });
    if (d.code === '00000') {
      pass('Bitget account endpoint reachable (auth OK)');
    } else {
      fail('Bitget auth failed', `code=${d.code} msg=${d.msg}`);
    }
  } catch (e) {
    fail('Bitget account endpoint unreachable', e.message);
  }
}

// ── CHECK B: Candle ordering ──────────────────────────────────────────────────

async function checkCandleOrdering() {
  section('[B] Candle Ordering — must be ascending (oldest first, newest last)');

  for (const tf of ['15m', rules.timeframes.htf]) {
    try {
      const candles = await fetchCandles('BTCUSDT', tf, 10);
      if (candles.length < 2) { fail(`${tf}: fewer than 2 candles returned`); continue; }

      const ascending = candles[0].time < candles[candles.length - 1].time;
      const step = candles[1].time - candles[0].time;
      const consistent = candles.every((c, i) => i === 0 || c.time > candles[i - 1].time);

      if (ascending && consistent) {
        pass(`${tf}: oldest first ✓  (candles[0]=${new Date(candles[0].time).toISOString().slice(0,16)} → candles[last]=${new Date(candles[candles.length-1].time).toISOString().slice(0,16)})`);
      } else if (!ascending) {
        fail(`${tf}: candles are DESCENDING — newest first. Check for erroneous .reverse() call`,
          `candles[0]=${new Date(candles[0].time).toISOString().slice(0,16)} candles[last]=${new Date(candles[candles.length-1].time).toISOString().slice(0,16)}`);
      } else {
        fail(`${tf}: candle timestamps are not strictly ascending (possible duplicates or gaps)`);
      }
    } catch (e) {
      fail(`${tf}: fetch failed`, e.message);
    }
    await new Promise(r => setTimeout(r, 200));
  }
}

// ── CHECK C: Candle completeness ──────────────────────────────────────────────

async function checkCandleCompleteness() {
  section('[C] Candle Completeness — correct count, no large gaps');

  const tfMs = { '15m': 15 * 60000, '1h': 60 * 60000, '4h': 4 * 60 * 60000, '1H': 60 * 60000, '4H': 4 * 60 * 60000, '1D': 24 * 60 * 60000, '1d': 24 * 60 * 60000 };

  for (const [tf, limit] of [[rules.timeframes.ltf, 100], [rules.timeframes.htf, 50]]) {
    try {
      const candles = await fetchCandles('BTCUSDT', tf, limit);
      const expected = tfMs[tf];

      if (candles.length < limit * 0.9) {
        fail(`${tf}: requested ${limit} candles, only got ${candles.length}`);
      } else {
        pass(`${tf}: got ${candles.length} candles`);
      }

      if (expected) {
        const gaps = [];
        for (let i = 1; i < candles.length; i++) {
          const diff = candles[i].time - candles[i - 1].time;
          if (diff > expected * 2) gaps.push(`gap of ${Math.round(diff / expected)}× at bar ${i}`);
        }
        if (gaps.length === 0) {
          pass(`${tf}: no large time gaps`);
        } else {
          warn(`${tf}: ${gaps.length} large gap(s) detected — ${gaps.slice(0, 3).join(', ')}`);
        }
      }
    } catch (e) {
      fail(`${tf} completeness check failed`, e.message);
    }
    await new Promise(r => setTimeout(r, 200));
  }
}

// ── CHECK D: Swing detection direction ────────────────────────────────────────

async function checkSwingDirection() {
  section('[D] Swing Detection Direction — swingHighs[last] must be most recent');

  try {
    const candles = await fetchCandles('BTCUSDT', rules.timeframes.ltf, 100);
    const { swingHighs, swingLows } = detectSwings(candles, rules.swing_detection.ltf_swing_lookback || 2);

    if (swingHighs.length < 2) {
      warn('Too few swing highs to test direction — market may be trending without pullbacks');
    } else {
      const first = swingHighs[0];
      const last  = swingHighs[swingHighs.length - 1];
      if (last.time > first.time) {
        pass(`Swing highs ordered correctly: swingHighs[0]=${new Date(first.time).toISOString().slice(0,16)} → swingHighs[last]=${new Date(last.time).toISOString().slice(0,16)}`);
      } else {
        fail('Swing highs are REVERSED — swingHighs[last] is older than swingHighs[0]',
          `swingHighs[0]=${new Date(first.time).toISOString().slice(0,16)} swingHighs[last]=${new Date(last.time).toISOString().slice(0,16)} — check .reverse() on fetchCandles`);
      }
    }

    if (swingLows.length < 2) {
      warn('Too few swing lows to test direction');
    } else {
      const first = swingLows[0];
      const last  = swingLows[swingLows.length - 1];
      if (last.time > first.time) {
        pass(`Swing lows ordered correctly: swingLows[0]=${new Date(first.time).toISOString().slice(0,16)} → swingLows[last]=${new Date(last.time).toISOString().slice(0,16)}`);
      } else {
        fail('Swing lows are REVERSED — swingLows[last] is older than swingLows[0]',
          'check .reverse() on fetchCandles');
      }
    }
  } catch (e) {
    fail('Swing direction check failed', e.message);
  }
}

// ── CHECK E: Synthetic pattern tests ─────────────────────────────────────────

function checkSyntheticPatterns() {
  section('[E] Synthetic Entry Patterns — known inputs must produce correct outputs');

  // Each test: { label, htf, expect, c }
  // Candle triples: [high, low, close]
  // Key design rule: use DISTINCT prices at swing points so equal-price ties
  // don't create ambiguous duplicate swing detections.
  const tests = [
    {
      // Valid short: clear SH1 → swing low → SH2 (lower) → breakdown.
      // Filler bars ensure swing points don't bleed into each other.
      label: 'Short: valid 2nd lower high with pullback → ENTER',
      htf: 'bear', expect: 'short',
      c: [
        [9,7,8],[9,7,8],           // filler
        [10,8,9],[9,7,8],[9,7,8],  // SH1=10 at index 2
        [8,4,5],[7,3,4],[7,3,4],   // sharp drop — swing low=3 at index 7
        [7,4,5],[7,4,5],           // rally up
        [8,6,7],[7,5,6],[7,5,6],   // SH2=8 at index 10 (lower than SH1=10) ✓
        [6,4,5],                   // current: close=5 < SH2 low=6 → breakdown ✓
      ],
    },
    {
      // Invalid: price makes SH1 then slides monotonically lower (strictly
      // decreasing lows) before forming a 2nd lower peak (SH2). Because the
      // lows never reverse into a confirmed swing low between the two highs,
      // the pullback condition is NOT met and no entry should fire.
      //
      // Pattern: filler → SH1=14 → slide (each low strictly lower than previous)
      //          → SH2=10.7 → current close=8.3 (< SH2 low 8.8, so breakdown
      //          check passes, but slBetween=undefined → blocked).
      label: 'Short: grinding lower (no confirmed swing low between highs) → BLOCK',
      htf: 'bear', expect: null,
      c: [
        [11,9,10],[11,9,10],           // 0,1: filler
        [14,11,12],                    // 2: SH1=14
        [13,10.5,11],[12,9.8,10.5],   // 3,4: slide — strictly decreasing lows (10.5, 9.8)
        [10.4,9.2,9.8],[10.2,8.9,9.4],// 5,6: slide continues (9.2, 8.9) — no swing low can form
        [10.7,8.8,9.5],               // 7: SH2=10.7 (lower than SH1=14 ✓), low=8.8
        [10.0,8.5,9.0],[9.5,8.2,8.3], // 8,9: current; close=8.3 < SH2 low 8.8 but no slBetween → BLOCK
      ],
    },
    {
      // Invalid: SH2 is HIGHER than SH1 — bullish structure, not a lower high.
      label: 'Short: SH2 higher than SH1 (potential reversal up) → BLOCK',
      htf: 'bear', expect: null,
      c: [
        [9,7,8],[9,7,8],
        [8,6,7],[7,5,6],[7,5,6],   // SH1=8 at index 2
        [6,4,5],[5,3,4],[5,3,4],   // swing low between
        [7,5,6],[7,5,6],           // rally
        [11,9,10],[9,7,8],[9,7,8], // SH2=11 > SH1=8 → NOT a lower high ✗
        [8,6,7],
      ],
    },
    {
      // Valid long: SL1 → swing high between → SL2 (higher low) → price breaks above SL2 candle high.
      // SL2 candle: high=6, low=4.5, close=5.  Current price 7 > high 6 → breakout ✓
      label: 'Long: valid 2nd higher low with pullback → ENTER',
      htf: 'bull', expect: 'long',
      c: [
        [9,7,8],[9,7,8],           // filler
        [6,3,4],[7,4,5],[7,4,5],   // SL1=3 at index 2
        [9,7,8],[10,8,9],[9,7,8],  // swing high=10 between at index 5
        [8,5,6],[8,5,6],           // drop
        [6,4.5,5],[7,5,5.5],[7,5,5.5], // SL2=4.5 at index 10 (high of candle=6)
        [8,6.5,7],[8,6.5,7],       // rally
        [9,7,8],                   // current: close=8 > SL2 candle high=6 → breakout ✓
      ],
    },
    {
      // Invalid: SL2 is LOWER than SL1 — lower low, trend accelerating down.
      label: 'Long: SL2 lower than SL1 (lower low, not higher low) → BLOCK',
      htf: 'bull', expect: null,
      c: [
        [9,7,8],[9,7,8],
        [8,5,6],[9,6,7],[9,6,7],   // SL1=5 at index 2
        [12,9,10],[12,9,10],        // swing high between
        [10,7,8],[10,7,8],
        [8,2,3],[8,2,3],[8,2,3],   // SL2=2 < SL1=5 → NOT a higher low ✗
        [5,3,4],[5,3,4],
        [6,4,5.5],
      ],
    },
    {
      // Invalid: valid structure but SH2 is 15 bars old — entry window closed.
      label: 'Short: stale lower high (>12 bars old) → BLOCK',
      htf: 'bear', expect: null,
      c: [
        [9,7,8],[9,7,8],
        [10,8,9],[9,7,8],[9,7,8],  // SH1=10 at index 2
        [8,4,5],[7,3,4],[7,3,4],   // swing low
        [7,4,5],[7,4,5],
        [8,6,7],[7,5,6],[7,5,6],   // SH2=8 at index 10
        ...Array(15).fill([7,5.5,6]), // 15 filler bars → SH2 now 17+ bars old ✗
        [6,4,5],                   // current below SH2 low — but too late
      ],
    },
  ];

  for (const t of tests) {
    const candles = buildCandles(t.c);
    const result  = detectEntry(candles, t.htf, 2, 12);
    const got     = result?.signal ?? null;
    if (got === t.expect) {
      pass(`${t.label}`);
    } else {
      fail(`${t.label}`, `expected signal=${t.expect} got signal=${got}`);
    }
  }
}

// ── CHECK F: Trend detection accuracy ────────────────────────────────────────

function checkTrendDetection() {
  section('[F] Trend Detection — known swing sequences must produce correct trend');

  // Build a deterministic zigzag with clear higher highs/lows (bull) or lower highs/lows (bear).
  // Each "wave" is 5 candles: 2 build up to the peak, 1 peak, 2 retrace.
  // Bull: each wave peaks higher and retraces to a higher low.
  // Bear: each wave peaks lower and retraces to a lower low.
  function zigzagCandles(type, waves = 6) {
    const candles = [];
    let t = 0;
    const dir = type === 'bull' ? 1 : -1;
    let peakBase = 100, troughBase = type === 'bull' ? 95 : 105;

    for (let w = 0; w < waves; w++) {
      const peak   = peakBase   + dir * w * 3;   // each peak 3 units further in trend direction
      const trough = troughBase + dir * w * 3;   // each trough 3 units further in trend direction
      // 2 rising candles toward peak
      candles.push({ time: t++ * 3600000, open: trough, high: trough + 1, low: trough - 0.5, close: trough + 1, volume: 1 });
      candles.push({ time: t++ * 3600000, open: trough + 1, high: peak - 0.5, low: trough + 0.5, close: peak - 0.5, volume: 1 });
      // 1 peak candle
      candles.push({ time: t++ * 3600000, open: peak - 0.5, high: peak, low: peak - 1, close: peak - 0.5, volume: 1 });
      // 2 retracing candles toward trough
      const nextTrough = trough + dir * 3;
      candles.push({ time: t++ * 3600000, open: peak - 0.5, high: peak - 0.5, low: nextTrough + 1, close: nextTrough + 1.5, volume: 1 });
      candles.push({ time: t++ * 3600000, open: nextTrough + 1.5, high: nextTrough + 2, low: nextTrough, close: nextTrough + 0.5, volume: 1 });
    }
    return candles;
  }

  const bullCandles = zigzagCandles('bull');
  const bearCandles = zigzagCandles('bear');

  const { trend: bullResult } = detectTrend(bullCandles, 2, 2, 0.5);
  const { trend: bearResult } = detectTrend(bearCandles, 2, 2, 0.5);

  if (bullResult === 'bull') pass('Bull trend: higher highs + higher lows correctly detected');
  else fail('Bull trend not detected on deterministic HH+HL zigzag', `got: ${bullResult}`);

  if (bearResult === 'bear') pass('Bear trend: lower highs + lower lows correctly detected');
  else fail('Bear trend not detected on deterministic LH+LL zigzag', `got: ${bearResult}`);
}

// ── CHECK G: Risk configuration ───────────────────────────────────────────────

function checkRiskConfig() {
  section('[G] Risk Configuration — limits within safe operating bounds');

  const risk = rules.risk || {};
  const lev  = parseFloat(risk.leverage ?? 1);
  const pct  = parseFloat(risk.max_risk_per_trade_pct ?? 1);

  if (lev <= 0)  fail('Leverage must be > 0');
  else if (lev > 10) fail('Leverage exceeds 10× — extreme risk', `leverage=${lev}`);
  else if (lev > 5)  warn(`Leverage is ${lev}× — high risk, ensure this is intentional`);
  else               pass(`Leverage: ${lev}×`);

  if (pct <= 0)  fail('max_risk_per_trade_pct must be > 0');
  else if (pct > 5) fail('max_risk_per_trade_pct exceeds 5% — excessive per-trade risk', `${pct}%`);
  else if (pct > 2) warn(`max_risk_per_trade_pct is ${pct}% — verify this is intentional`);
  else              pass(`Risk per trade: ${pct}%`);

  const maxTrades = rules.max_trades_per_day ?? rules.MAX_TRADES_PER_DAY ?? null;
  if (maxTrades !== null) {
    pass(`Max trades per day: ${maxTrades}`);
  } else {
    warn('No max_trades_per_day found in rules — consider adding one');
  }

  if (!rules.timeframes?.htf || !rules.timeframes?.ltf) {
    fail('Missing timeframes.htf or timeframes.ltf in rules');
  } else {
    pass(`Timeframes defined: HTF=${rules.timeframes.htf}  LTF=${rules.timeframes.ltf}`);
  }

  if (!rules.swing_detection) {
    fail('Missing swing_detection block in rules');
  } else {
    const lb = rules.swing_detection.swing_lookback;
    if (!lb || lb < 1) fail('swing_lookback must be >= 1');
    else if (lb < 2) warn('swing_lookback of 1 is very sensitive — consider 2');
    else pass(`swing_lookback: ${lb}`);
  }

  if (!rules.symbols || rules.symbols.length === 0) {
    fail('No symbols defined in rules');
  } else {
    pass(`Symbols defined: ${rules.symbols.length} (${rules.symbols.slice(0, 4).join(', ')}${rules.symbols.length > 4 ? '...' : ''})`);
  }
}

// ── CHECK H: Symbol reachability ──────────────────────────────────────────────

async function checkSymbolReachability() {
  section('[H] Symbol Reachability — all watchlist symbols return valid candles');

  const symbols = SYMBOL_OVERRIDE ? [SYMBOL_OVERRIDE] : rules.symbols;
  let ok = 0, bad = 0;

  for (const sym of symbols) {
    try {
      const c = await fetchCandles(sym, rules.timeframes.ltf, 10);
      if (c.length >= 5) {
        ok++;
      } else {
        fail(`${sym}: only ${c.length} candles returned`);
        bad++;
      }
    } catch (e) {
      fail(`${sym}: fetch error`, e.message);
      bad++;
    }
    await new Promise(r => setTimeout(r, 150));
  }

  if (bad === 0) pass(`All ${ok} symbols reachable`);
  else warn(`${ok} OK, ${bad} symbols had issues`);
}

// ── CHECK I: Live sanity on 3 symbols ─────────────────────────────────────────

async function checkLiveSanity() {
  section('[I] Live Detection Sanity — run full stack on live candles');

  const testSymbols = SYMBOL_OVERRIDE
    ? [SYMBOL_OVERRIDE]
    : rules.symbols.slice(0, 3);

  for (const symbol of testSymbols) {
    try {
      const [htfC, ltfC] = await Promise.all([
        fetchCandles(symbol, rules.timeframes.htf, 50),
        fetchCandles(symbol, rules.timeframes.ltf, 100),
      ]);

      // 1. Candle ordering
      const htfOk = htfC.length >= 2 && htfC[htfC.length - 1].time > htfC[0].time;
      const ltfOk = ltfC.length >= 2 && ltfC[ltfC.length - 1].time > ltfC[0].time;
      if (!htfOk) fail(`${symbol} HTF candles not ascending`);
      if (!ltfOk) fail(`${symbol} LTF candles not ascending`);

      // 2. Swing highs point to recent candles
      const { swingHighs, swingLows } = detectSwings(ltfC, rules.swing_detection.ltf_swing_lookback || 2);
      if (swingHighs.length >= 2) {
        const mostRecent = swingHighs[swingHighs.length - 1];
        const prev       = swingHighs[swingHighs.length - 2];
        const ageHours   = (ltfC[ltfC.length - 1].time - mostRecent.time) / 3600000;
        if (mostRecent.time > prev.time) {
          pass(`${symbol}: swingHighs[last] is most recent (${ageHours.toFixed(1)}h ago)`);
        } else {
          fail(`${symbol}: swingHighs[last] is OLDER than swingHighs[n-2] — ordering bug`);
        }
      } else {
        warn(`${symbol}: only ${swingHighs.length} swing high(s) — not enough for entry`);
      }

      // 3. Run trend + entry detection
      const htf    = detectTrend(htfC, rules.swing_detection.swing_lookback, rules.swing_detection.trend_swing_count, rules.swing_detection.atr_threshold);
      const entry  = htf.trend !== 'neutral' ? detectEntry(ltfC, htf.trend, rules.swing_detection.ltf_swing_lookback || 2, 12) : null;
      const ltfNow = new Date(ltfC[ltfC.length - 1].time).toISOString().slice(0, 16);
      console.log(`  ℹ️   ${symbol}: HTF=${htf.trend.toUpperCase()}  LTF current bar=${ltfNow}  entry=${entry ? entry.signal + ' @ ' + entry.entry.toFixed(4) : 'none'}`);

    } catch (e) {
      fail(`${symbol}: live sanity check threw`, e.message);
    }
    await new Promise(r => setTimeout(r, 300));
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n' + '═'.repeat(60));
  console.log(`  STRATEGY AUDIT: ${rules.strategy || RULES_FILE}`);
  console.log(`  Rules file: ${RULES_FILE}`);
  console.log(`  Run at:     ${new Date().toISOString().slice(0, 16)} UTC`);
  console.log('═'.repeat(60));

  await checkApiConnectivity();
  await checkCandleOrdering();
  await checkCandleCompleteness();
  await checkSwingDirection();
  checkSyntheticPatterns();
  checkTrendDetection();
  checkRiskConfig();
  await checkSymbolReachability();
  await checkLiveSanity();

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(60));
  if (totalFails === 0) {
    console.log(`  ✅  ALL ${totalChecks} CHECKS PASSED — strategy is clear for live trading`);
  } else {
    console.log(`  ❌  ${totalFails} of ${totalChecks} checks FAILED — DO NOT go live until resolved\n`);
    failLog.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  }
  console.log('═'.repeat(60) + '\n');

  process.exit(totalFails > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('\nAudit crashed:', e);
  process.exit(2);
});
