/**
 * SID/scan-sid.js — Daily Watchlist Scanner for SID Strategy v1.1
 *
 * Runs once daily after US close (via GitHub Actions).
 * For each ticker in watchlist-sid.json:
 *   1. Fetches daily and weekly bars from Yahoo Finance
 *   2. Computes RSI, MACD, weekly trend, ADX, Choppiness Index
 *   3. Classifies current state: SIGNAL_LONG / SHORT / APPROACHING / IN_TRADE / EARNINGS_BLACKOUT / IDLE
 *   4. Computes tradability score (0–100) — how well-suited the stock is to SID
 *   5. Detects transitions vs previous scan (used later for Telegram alerts)
 *
 * Output: SID/scanner-sid.json — consumed by dashboard tab and Telegram bridge.
 *
 * Usage:
 *   cd SID && node scan-sid.js                    # full scan
 *   cd SID && node scan-sid.js --symbol AAPL      # single symbol (debugging)
 *   cd SID && node scan-sid.js --limit 5          # first N tickers (debugging)
 */

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import pkg from 'technicalindicators';
const { RSI, MACD, SMA, ADX } = pkg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ────────────────────────────────────────────────────────────────
const STRATEGY_VERSION = '1.1';
const SCANNER_VERSION  = '1.0';

const WATCHLIST_PATH      = path.join(__dirname, 'watchlist-sid.json');
const OPEN_POSITIONS_PATH = path.join(__dirname, 'open-positions-sid.json');
const PREVIOUS_SCAN_PATH  = path.join(__dirname, 'scanner-sid.json');
const OUTPUT_PATH         = path.join(__dirname, 'scanner-sid.json');

// Strategy parameters (must match sid-strategy.pine v1.1)
const RSI_OVERSOLD          = 30;
const RSI_OVERBOUGHT        = 70;
const RSI_APPROACH_BUFFER   = 5;
const EARNINGS_BLACKOUT     = 14;
const TIMEOUT_DAYS          = 3;

// Tradability score weights (total = 100)
const SCORE_WEIGHTS = {
  weeklyTrendDirection : 20,  // weekly 50-SMA vs 200-SMA: clear up or clear down
  weeklyAdxHealthyBand : 20,  // weekly ADX in 15-35 (trending, not extreme)
  dailyChoppinessLow   : 15,  // daily CI < 55 (not pure noise)
  historicalExtremes   : 25,  // RSI hit <20 or >80 in last 12mo (proves real reversals)
  meanReversionActive  : 20,  // RSI hit <30 or >70 in last 12mo (strategy can trigger)
};

// CLI args
const args      = process.argv.slice(2);
const singleArg = args.indexOf('--symbol');
const limitArg  = args.indexOf('--limit');
const SINGLE    = singleArg !== -1 ? args[singleArg + 1] : null;
const LIMIT     = limitArg  !== -1 ? parseInt(args[limitArg + 1], 10) : null;

// Colors for log output
const c = {
  reset: '\x1b[0m', gray: '\x1b[90m', red: '\x1b[31m', green: '\x1b[32m',
  yellow: '\x1b[33m', cyan: '\x1b[36m', bold: '\x1b[1m',
};

// ── Data fetch ────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

const PYTHON_BIN     = process.env.PYTHON_BIN || 'python';
const FETCH_BARS_PY  = path.join(__dirname, 'fetch-bars.py');

// Bars come from yfinance via Python subprocess.
// yfinance is far more tolerant of Yahoo's rate limiting than JS wrappers.
async function fetchBars(symbol, interval /* '1d' | '1wk' */, monthsBack) {
  const period = interval === '1wk'
    ? `${Math.ceil(monthsBack / 12)}y`        // weekly: years
    : `${Math.max(1, monthsBack)}mo`;         // daily: months
  const r = spawnSync(PYTHON_BIN, [FETCH_BARS_PY, symbol, interval, period], {
    encoding: 'utf-8',
    timeout : 30000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.status !== 0) {
    return { error: (r.stderr || r.error?.message || 'unknown python error').trim().slice(0, 200) };
  }
  try {
    const parsed = JSON.parse(r.stdout);
    if (parsed.error) return { error: parsed.error };
    return parsed.map(b => ({ ...b, date: new Date(b.date) }))
                 .filter(b => Number.isFinite(b.close));
  } catch (e) {
    return { error: `JSON parse: ${e.message}` };
  }
}

async function fetchEarningsDate(symbol) {
  // Yahoo's earnings endpoint is rate-limited; defer to v2 of the scanner.
  // For now return null so earningsBlackout never blocks signals — earnings
  // filter happens at the PineScript layer on TradingView via its built-in data.
  return null;
}

// ── Indicators ────────────────────────────────────────────────────────────
function computeIndicators(dailyBars, weeklyBars) {
  const closes = dailyBars.map(b => b.close);
  const highs  = dailyBars.map(b => b.high);
  const lows   = dailyBars.map(b => b.low);

  const rsi  = RSI.calculate({ values: closes, period: 14 });
  const macd = MACD.calculate({
    values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9,
    SimpleMAOscillator: false, SimpleMASignal: false,
  });
  const adxDaily = ADX.calculate({ close: closes, high: highs, low: lows, period: 14 });

  const weeklyCloses = weeklyBars.map(b => b.close);
  const weeklyHighs  = weeklyBars.map(b => b.high);
  const weeklyLows   = weeklyBars.map(b => b.low);
  const sma50w   = SMA.calculate({ period: 50,  values: weeklyCloses });
  const sma200w  = SMA.calculate({ period: 200, values: weeklyCloses });
  const adxWeek  = ADX.calculate({ close: weeklyCloses, high: weeklyHighs, low: weeklyLows, period: 14 });

  return { rsi, macd, adxDaily, sma50w, sma200w, adxWeek, closes, highs, lows };
}

// Choppiness Index (daily, last 14 bars): high = chop, low = trend
function choppinessIndex(highs, lows, closes, period = 14) {
  if (highs.length < period + 1) return null;
  const n = highs.length;
  let trSum = 0;
  let maxH = -Infinity, minL = Infinity;
  for (let i = n - period; i < n; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i]  - closes[i - 1])
    );
    trSum += tr;
    if (highs[i] > maxH) maxH = highs[i];
    if (lows[i]  < minL) minL = lows[i];
  }
  const range = maxH - minL;
  if (range === 0) return 100;
  return 100 * Math.log10(trSum / range) / Math.log10(period);
}

// ── Tradability score (0–100) ─────────────────────────────────────────────
function tradabilityScore({ rsi, sma50w, sma200w, adxWeek, ci }) {
  const parts = {};

  // Factor 1: Weekly trend direction clarity
  const sma50  = sma50w.at(-1);
  const sma200 = sma200w.at(-1);
  const sep = sma200 ? Math.abs(sma50 - sma200) / sma200 : 0;
  parts.weeklyTrendDirection = Math.min(1, sep * 10) * SCORE_WEIGHTS.weeklyTrendDirection; // 10% separation = full marks

  // Factor 2: Weekly ADX in 15-35 healthy band
  const wAdx = adxWeek.at(-1)?.adx ?? 0;
  let adxScore = 0;
  if (wAdx >= 15 && wAdx <= 35) adxScore = 1;
  else if (wAdx > 35 && wAdx < 50) adxScore = (50 - wAdx) / 15;
  else if (wAdx >= 10 && wAdx < 15) adxScore = (wAdx - 10) / 5;
  parts.weeklyAdxHealthyBand = Math.max(0, Math.min(1, adxScore)) * SCORE_WEIGHTS.weeklyAdxHealthyBand;

  // Factor 3: Daily Choppiness Index < 55 (not pure noise)
  let ciScore = 0;
  if (ci != null) {
    if (ci < 45) ciScore = 1;
    else if (ci < 55) ciScore = (55 - ci) / 10;
  }
  parts.dailyChoppinessLow = Math.max(0, Math.min(1, ciScore)) * SCORE_WEIGHTS.dailyChoppinessLow;

  // Factor 4: Historical RSI extremes — last 252 daily bars (~12mo)
  const recentRsi = rsi.slice(-252);
  const extremeHits = recentRsi.filter(v => v < 20 || v > 80).length;
  // 0 hits = 0, 3+ hits = full marks
  parts.historicalExtremes = Math.min(1, extremeHits / 3) * SCORE_WEIGHTS.historicalExtremes;

  // Factor 5: Mean-reversion behavior (RSI hit <30 or >70 in last 12mo)
  const mrHits = recentRsi.filter(v => v < 30 || v > 70).length;
  parts.meanReversionActive = Math.min(1, mrHits / 5) * SCORE_WEIGHTS.meanReversionActive;

  const total = Object.values(parts).reduce((a, b) => a + b, 0);
  return { total: Math.round(total), parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, Math.round(v * 10) / 10])) };
}

// ── State classification ──────────────────────────────────────────────────
function classifyState({ rsi, macd, daysToEarnings, openPosition }) {
  if (openPosition) return { status: 'IN_TRADE', direction: openPosition.direction };
  if (daysToEarnings != null && daysToEarnings <= EARNINGS_BLACKOUT) {
    return { status: 'EARNINGS_BLACKOUT', daysToEarnings };
  }

  const currentRsi  = rsi.at(-1);
  const prevRsi     = rsi.at(-2);
  const currentMacd = macd.at(-1)?.MACD;
  const prevMacd    = macd.at(-2)?.MACD;
  const macdRising  = currentMacd != null && prevMacd != null && currentMacd > prevMacd;
  const macdFalling = currentMacd != null && prevMacd != null && currentMacd < prevMacd;

  if (currentRsi < RSI_OVERSOLD && macdRising) {
    return { status: 'SIGNAL_LONG', rsi: currentRsi, note: 'RSI oversold + MACD rising — ready to ARM on TV' };
  }
  if (currentRsi > RSI_OVERBOUGHT && macdFalling) {
    return { status: 'SIGNAL_SHORT', rsi: currentRsi, note: 'RSI overbought + MACD falling — ready to ARM on TV' };
  }
  // RSI is in extreme zone but MACD hasn't flipped yet — high-priority watch
  if (currentRsi < RSI_OVERSOLD && !macdRising) {
    return { status: 'OVERSOLD_WAIT_MACD', rsi: currentRsi, note: 'RSI oversold but MACD not yet rising' };
  }
  if (currentRsi > RSI_OVERBOUGHT && !macdFalling) {
    return { status: 'OVERBOUGHT_WAIT_MACD', rsi: currentRsi, note: 'RSI overbought but MACD not yet falling' };
  }
  // RSI in the approach buffer just outside the extreme zone
  if (currentRsi >= RSI_OVERSOLD && currentRsi <= RSI_OVERSOLD + RSI_APPROACH_BUFFER) {
    return { status: 'APPROACHING_LONG', rsi: currentRsi };
  }
  if (currentRsi <= RSI_OVERBOUGHT && currentRsi >= RSI_OVERBOUGHT - RSI_APPROACH_BUFFER) {
    return { status: 'APPROACHING_SHORT', rsi: currentRsi };
  }
  return { status: 'IDLE', rsi: currentRsi };
}

// ── Scan one ticker ───────────────────────────────────────────────────────
async function scanTicker(symbol, openPositions, previousStatusBySymbol) {
  const [daily, weekly] = await Promise.all([
    fetchBars(symbol, '1d', 14),    // ~14 months of daily bars
    fetchBars(symbol, '1wk', 48),   // ~4 years of weekly bars
  ]);

  if (daily?.error || weekly?.error) {
    return { symbol, error: daily?.error || weekly?.error };
  }
  if (daily.length < 50 || weekly.length < 50) {
    return { symbol, error: `Insufficient data (${daily.length} daily, ${weekly.length} weekly)` };
  }

  const earningsDate    = await fetchEarningsDate(symbol);
  const daysToEarnings  = earningsDate ? Math.floor((earningsDate - Date.now()) / (1000 * 60 * 60 * 24)) : null;

  const ind = computeIndicators(daily, weekly);
  const ci  = choppinessIndex(ind.highs, ind.lows, ind.closes);
  const score = tradabilityScore({ rsi: ind.rsi, sma50w: ind.sma50w, sma200w: ind.sma200w, adxWeek: ind.adxWeek, ci });

  const openPosition = openPositions[symbol] || null;
  const state = classifyState({ rsi: ind.rsi, macd: ind.macd, daysToEarnings, openPosition });

  // Weekly trend label for the dashboard
  const sma50  = ind.sma50w.at(-1);
  const sma200 = ind.sma200w.at(-1);
  const sep    = sma200 ? Math.abs(sma50 - sma200) / sma200 : 0;
  let weeklyTrend = 'choppy';
  if (sep > 0.05) weeklyTrend = sma50 > sma200 ? 'up' : 'down';

  // Transition detection
  const prevStatus = previousStatusBySymbol[symbol];
  const transitioned = prevStatus && prevStatus !== state.status;

  return {
    symbol,
    status         : state.status,
    direction      : state.direction || null,
    score          : score.total,
    scoreBreakdown : score.parts,
    weeklyTrend,
    rsi            : Math.round(ind.rsi.at(-1) * 10) / 10,
    macdDirection  : (() => {
      const cur = ind.macd.at(-1)?.MACD, prv = ind.macd.at(-2)?.MACD;
      if (cur > prv) return 'rising';
      if (cur < prv) return 'falling';
      return 'flat';
    })(),
    weeklyAdx      : Math.round((ind.adxWeek.at(-1)?.adx ?? 0) * 10) / 10,
    choppinessIdx  : ci != null ? Math.round(ci * 10) / 10 : null,
    daysToEarnings,
    earningsBlackout : daysToEarnings != null && daysToEarnings <= EARNINGS_BLACKOUT,
    lastClose      : ind.closes.at(-1),
    note           : state.note || null,
    transitionedFrom : transitioned ? prevStatus : null,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────
function loadJSON(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); }
  catch { return fallback; }
}

function indexOpenPositions(positionsObj) {
  // open-positions-sid.json shape may vary; normalize to { TSLA: { direction: "LONG", ... }, ... }
  const out = {};
  if (Array.isArray(positionsObj?.positions)) {
    for (const p of positionsObj.positions) {
      if (p.symbol) out[p.symbol.toUpperCase()] = p;
    }
  } else if (positionsObj && typeof positionsObj === 'object') {
    for (const [sym, val] of Object.entries(positionsObj)) {
      if (val && typeof val === 'object') out[sym.toUpperCase()] = val;
    }
  }
  return out;
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  const tStart = Date.now();
  console.log(`${c.bold}━━ SID Scanner v${SCANNER_VERSION} · Strategy v${STRATEGY_VERSION} ━━${c.reset}`);

  const watchlist = loadJSON(WATCHLIST_PATH, null);
  if (!watchlist?.tickers) { console.error('Cannot load watchlist-sid.json'); process.exit(1); }

  const openPositions = indexOpenPositions(loadJSON(OPEN_POSITIONS_PATH, {}));
  const previousScan  = loadJSON(PREVIOUS_SCAN_PATH, { tickers: [] });
  const prevStatus    = Object.fromEntries((previousScan.tickers || []).map(t => [t.symbol, t.status]));

  let tickers = watchlist.tickers;
  if (SINGLE) tickers = [SINGLE.toUpperCase()];
  if (LIMIT)  tickers = tickers.slice(0, LIMIT);

  console.log(`${c.gray}Scanning ${tickers.length} ticker${tickers.length !== 1 ? 's' : ''}…${c.reset}\n`);

  const results = [];
  for (let i = 0; i < tickers.length; i++) {
    const symbol = tickers[i];
    process.stdout.write(`${c.gray}[${i + 1}/${tickers.length}]${c.reset} ${symbol.padEnd(6)} … `);
    try {
      const r = await scanTicker(symbol, openPositions, prevStatus);
      results.push(r);
      if (r.error) {
        console.log(`${c.red}error: ${r.error}${c.reset}`);
      } else {
        const statusColor = {
          SIGNAL_LONG: c.green, SIGNAL_SHORT: c.red,
          OVERSOLD_WAIT_MACD: c.green, OVERBOUGHT_WAIT_MACD: c.red,
          APPROACHING_LONG: c.yellow, APPROACHING_SHORT: c.yellow,
          IN_TRADE: c.cyan, EARNINGS_BLACKOUT: c.gray, IDLE: c.gray,
        }[r.status] || c.gray;
        const trans = r.transitionedFrom ? `${c.cyan} ← ${r.transitionedFrom}${c.reset}` : '';
        console.log(`${statusColor}${r.status.padEnd(18)}${c.reset} score=${r.score.toString().padStart(3)}  RSI=${r.rsi}  ${r.weeklyTrend}${trans}`);
      }
    } catch (err) {
      console.log(`${c.red}exception: ${err.message}${c.reset}`);
      results.push({ symbol, error: err.message });
    }
    // gentle pacing to avoid Yahoo rate limiting
    if (i < tickers.length - 1) await sleep(1000);
  }

  // Sort: signals first, then by score desc
  const statusRank = {
    SIGNAL_LONG: 0, SIGNAL_SHORT: 0,
    OVERSOLD_WAIT_MACD: 1, OVERBOUGHT_WAIT_MACD: 1,
    IN_TRADE: 2,
    APPROACHING_LONG: 3, APPROACHING_SHORT: 3,
    EARNINGS_BLACKOUT: 4,
    IDLE: 5,
  };
  results.sort((a, b) => {
    const ra = statusRank[a.status] ?? 9;
    const rb = statusRank[b.status] ?? 9;
    if (ra !== rb) return ra - rb;
    return (b.score || 0) - (a.score || 0);
  });

  const output = {
    scanDate         : new Date().toISOString(),
    scannerVersion   : SCANNER_VERSION,
    strategyVersion  : STRATEGY_VERSION,
    watchlistVersion : watchlist.version,
    tickersScanned   : tickers.length,
    tickersWithError : results.filter(r => r.error).length,
    elapsedMs        : Date.now() - tStart,
    scoreWeights     : SCORE_WEIGHTS,
    tickers          : results,
  };

  // Don't overwrite scanner-sid.json when running with --symbol or --limit (partial scan)
  if (!SINGLE && !LIMIT) {
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
    console.log(`\n${c.green}✓ Wrote ${OUTPUT_PATH}${c.reset}`);
  } else {
    console.log(`\n${c.yellow}(partial scan — output not written to file)${c.reset}`);
    console.log(JSON.stringify(output, null, 2));
  }

  console.log(`${c.gray}Done in ${((Date.now() - tStart) / 1000).toFixed(1)}s${c.reset}`);
}

main().catch(err => { console.error(`${c.red}FATAL:${c.reset}`, err); process.exit(1); });
