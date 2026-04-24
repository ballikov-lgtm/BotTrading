import 'dotenv/config';
import fetch from 'node-fetch';
import fs from 'fs';
import crypto from 'crypto';

// ── Config ────────────────────────────────────────────────────────────────────

const CONFIG = {
  apiKey:       process.env.BITGET_API_KEY      || '',
  secretKey:    process.env.BITGET_SECRET_KEY   || '',
  passphrase:   process.env.BITGET_PASSPHRASE   || '',
  mode:         process.env.MODE                || 'futures',
  leverage:     parseInt(process.env.LEVERAGE)           || 3,
  portfolioUsd: parseFloat(process.env.PORTFOLIO_USD)    || 500,
  maxTradeUsd:  parseFloat(process.env.MAX_TRADE_USD)    || 50,
  maxPerDay:    parseInt(process.env.MAX_TRADES_PER_DAY) || 3,
  paperTrading: process.env.IRONCLAD_PAPER !== 'false',  // Separate paper flag
};

const RULES_PATH      = './rules-ironclad.json';
const TRADES_PATH     = './trades-ironclad.csv';
const SAFETY_LOG_PATH = './ironclad-log.json';
const SIGNALS_PATH    = './research-signals.json';
const BITGET_BASE     = 'https://api.bitget.com';

// ── Research Signal Filter ────────────────────────────────────────────────────

function loadResearchSignals() {
  try {
    if (!fs.existsSync(SIGNALS_PATH)) return null;
    const data = JSON.parse(fs.readFileSync(SIGNALS_PATH, 'utf8'));
    if (data.date !== new Date().toISOString().slice(0, 10)) return null;
    return data;
  } catch { return null; }
}

function getResearchSignal(researchData, symbol) {
  if (!researchData) return null;
  const token = symbol.replace('USDT', '').replace('USD', '');
  return researchData.signals.find(s => s.token === token) || null;
}

function isResearchAligned(researchSignal, direction) {
  if (!researchSignal) return true;
  if (researchSignal.signal === 'neutral') return true;
  if (direction === 'long'  && researchSignal.signal === 'bull') return true;
  if (direction === 'short' && researchSignal.signal === 'bear') return true;
  return false;
}

// Ironclad monitors ALL asset classes — crypto, stocks, commodities
// This is the trend-following strategy, best in markets with a clear daily direction
// Strategy 1 (VWAP scalping) handles crypto-only ranging markets
const SYMBOLS = [
  // Crypto — trending pairs
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT',
  'LINKUSDT', 'HYPEUSDT', 'VIRTUALUSDT',
  'APTUSDT', 'ONDOUSDT', 'JUPUSDT',
  // Stocks
  'AAPLUSDT', 'NVDAUSDT', 'GOOGLUSDT',
  // Commodities
  'XAUUSDT', 'UKOUSD',
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadRules() {
  return JSON.parse(fs.readFileSync(RULES_PATH, 'utf8'));
}

function todayString() {
  return new Date().toISOString().slice(0, 10);
}

function countTodayTrades(symbol) {
  if (!fs.existsSync(TRADES_PATH)) return 0;
  const lines = fs.readFileSync(TRADES_PATH, 'utf8').trim().split('\n');
  const today = todayString();
  return lines.slice(1).filter(l => l.startsWith(today) && l.includes(symbol)).length;
}

function appendTrade(row) {
  const header = 'Date,Time,Exchange,Symbol,Side,Quantity,Entry Price,Stop Loss,TP1,TP2,TP3,RR1,RR2,RR3,SL→BE after,Total USD,Order ID,Mode,Strategy';
  if (!fs.existsSync(TRADES_PATH)) fs.writeFileSync(TRADES_PATH, header + '\n');
  fs.appendFileSync(TRADES_PATH, row + '\n');
}

function writeLog(entry) {
  let log = [];
  if (fs.existsSync(SAFETY_LOG_PATH)) {
    try { log = JSON.parse(fs.readFileSync(SAFETY_LOG_PATH, 'utf8')); } catch {}
  }
  log.unshift(entry);
  fs.writeFileSync(SAFETY_LOG_PATH, JSON.stringify(log.slice(0, 200), null, 2));
}

// ── Market Data ───────────────────────────────────────────────────────────────

const GRANULARITY_MAP = {
  '1m':'1m', '5m':'5m', '15m':'15m', '30m':'30m',
  '1h':'1H', '4h':'4H', '1D':'1D', '1d':'1D',
};

async function fetchCandles(symbol, timeframe, limit = 100) {
  const gran = GRANULARITY_MAP[timeframe] || timeframe;
  const url  = `${BITGET_BASE}/api/v2/mix/market/candles?symbol=${symbol}&productType=USDT-FUTURES&granularity=${gran}&limit=${limit}`;
  const res  = await fetch(url);
  const json = await res.json();
  if (!Array.isArray(json.data)) throw new Error(`No candle data for ${symbol} ${timeframe}: ${JSON.stringify(json)}`);
  // BitGet returns newest first — reverse to chronological
  return json.data.reverse().map(c => ({
    time:   parseInt(c[0]),
    open:   parseFloat(c[1]),
    high:   parseFloat(c[2]),
    low:    parseFloat(c[3]),
    close:  parseFloat(c[4]),
    volume: parseFloat(c[5]),
  }));
}

// ── ATR Calculation ───────────────────────────────────────────────────────────

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return 0;
  const trs = candles.slice(1).map((c, i) => {
    const prev = candles[i];
    return Math.max(
      c.high - c.low,
      Math.abs(c.high - prev.close),
      Math.abs(c.low  - prev.close)
    );
  });
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// ── EMA Calculation ───────────────────────────────────────────────────────────

function calcEMA(candles, period) {
  if (candles.length < period) return null;
  const closes = candles.map(c => c.close);
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

// Calculate key EMA levels on HTF candles
function calcEMALevels(candles) {
  return {
    ema21:  calcEMA(candles, 21),
    ema50:  calcEMA(candles, 50),
    ema100: calcEMA(candles, 100),
    ema200: calcEMA(candles, 200),
  };
}

// Build 3 take-profit levels from EMA levels + HTF swing highs/lows.
// For longs  : pick the 3 nearest levels ABOVE entry price
// For shorts : pick the 3 nearest levels BELOW entry price
// Falls back to fixed R:R multiples (1.5R, 2.5R, 4R) if not enough levels found.
function calcTakeProfitLevels(direction, entry, stopLoss, emaLevels, htfSwingHighs, htfSwingLows) {
  const risk = Math.abs(entry - stopLoss);

  // Collect all candidate S/R levels
  const candidates = [
    emaLevels.ema21,
    emaLevels.ema50,
    emaLevels.ema100,
    emaLevels.ema200,
    ...htfSwingHighs.map(s => s.price),
    ...htfSwingLows.map(s => s.price),
  ].filter(p => p !== null && p !== undefined);

  let levels;
  if (direction === 'long') {
    // Only levels above entry, sorted nearest first
    levels = candidates
      .filter(p => p > entry * 1.002) // Must be at least 0.2% above entry
      .sort((a, b) => a - b);
  } else {
    // Only levels below entry, sorted nearest first (highest to lowest)
    levels = candidates
      .filter(p => p < entry * 0.998)
      .sort((a, b) => b - a);
  }

  // De-duplicate levels that are within 0.3% of each other
  const deduped = [];
  for (const lvl of levels) {
    if (!deduped.length || Math.abs(lvl - deduped[deduped.length - 1]) / entry > 0.003) {
      deduped.push(lvl);
    }
  }

  // Take the 3 nearest; fill gaps with R:R multiples if fewer than 3 found
  const fallbacks = direction === 'long'
    ? [entry + risk * 1.5, entry + risk * 2.5, entry + risk * 4.0]
    : [entry - risk * 1.5, entry - risk * 2.5, entry - risk * 4.0];

  const tp1 = parseFloat((deduped[0] ?? fallbacks[0]).toFixed(4));
  const tp2 = parseFloat((deduped[1] ?? fallbacks[1]).toFixed(4));
  const tp3 = parseFloat((deduped[2] ?? fallbacks[2]).toFixed(4));

  // R:R ratios for logging
  const rr = (tp) => parseFloat((Math.abs(tp - entry) / risk).toFixed(2));

  return {
    tp1, tp2, tp3,
    rr1: rr(tp1), rr2: rr(tp2), rr3: rr(tp3),
    // Position split: close 40% at TP1, 35% at TP2, 25% at TP3
    split: [0.40, 0.35, 0.25],
    // SL management plan
    slPlan: {
      afterTp1: entry,           // Move SL to break-even after TP1
      afterTp2: tp1,             // Trail SL to TP1 price after TP2
    },
  };
}

// ── Swing Detection ───────────────────────────────────────────────────────────

function detectSwings(candles, lookback = 2) {
  const swingHighs = [];
  const swingLows  = [];

  // Only check confirmed swings (need lookback bars on each side)
  for (let i = lookback; i < candles.length - lookback; i++) {
    const c = candles[i];

    // Swing high: highest point within lookback bars either side
    const isSwingHigh = candles.slice(i - lookback, i).every(p => p.high <= c.high) &&
                        candles.slice(i + 1, i + lookback + 1).every(p => p.high <= c.high);

    // Swing low: lowest point within lookback bars either side
    const isSwingLow  = candles.slice(i - lookback, i).every(p => p.low >= c.low) &&
                        candles.slice(i + 1, i + lookback + 1).every(p => p.low >= c.low);

    if (isSwingHigh) swingHighs.push({ index: i, price: c.high, time: c.time });
    if (isSwingLow)  swingLows.push({ index: i, price: c.low,  time: c.time });
  }

  return { swingHighs, swingLows };
}

// ── Trend Detection (HTF Daily) ───────────────────────────────────────────────

function detectTrend(candles, lookback = 2, swingCount = 2, atrThreshold = 0.5) {
  const atr = calcATR(candles);
  const minSwingSize = atr * atrThreshold;

  const { swingHighs, swingLows } = detectSwings(candles, lookback);

  // Filter swings by ATR size to remove noise
  const filteredHighs = swingHighs.filter((s, i) => {
    if (i === 0) return true;
    return Math.abs(s.price - swingHighs[i - 1].price) >= minSwingSize;
  });
  const filteredLows = swingLows.filter((s, i) => {
    if (i === 0) return true;
    return Math.abs(s.price - swingLows[i - 1].price) >= minSwingSize;
  });

  if (filteredHighs.length < swingCount || filteredLows.length < swingCount) {
    return { trend: 'neutral', swingHighs: filteredHighs, swingLows: filteredLows };
  }

  // Check last N swing highs and lows for trend direction
  const recentHighs = filteredHighs.slice(-swingCount);
  const recentLows  = filteredLows.slice(-swingCount);

  const higherHighs = recentHighs.every((s, i) => i === 0 || s.price > recentHighs[i - 1].price);
  const higherLows  = recentLows.every( (s, i) => i === 0 || s.price > recentLows[i - 1].price);
  const lowerHighs  = recentHighs.every((s, i) => i === 0 || s.price < recentHighs[i - 1].price);
  const lowerLows   = recentLows.every( (s, i) => i === 0 || s.price < recentLows[i - 1].price);

  let trend = 'neutral';
  if (higherHighs && higherLows) trend = 'bull';
  if (lowerHighs  && lowerLows)  trend = 'bear';

  return { trend, swingHighs: filteredHighs, swingLows: filteredLows, atr };
}

// ── Entry Signal Detection (LTF 15m) ─────────────────────────────────────────

function detectEntry(ltfCandles, htfTrend, lookback = 2) {
  const { swingHighs, swingLows } = detectSwings(ltfCandles, lookback);
  const currentPrice = ltfCandles[ltfCandles.length - 1].close;
  const atr = calcATR(ltfCandles);

  // Long entry: HTF bullish + price breaks above recent 15m swing low
  if (htfTrend === 'bull' && swingLows.length >= 1) {
    const recentSwingLow = swingLows[swingLows.length - 1];
    const swingLowHigh   = ltfCandles[recentSwingLow.index].high;

    if (currentPrice > swingLowHigh) {
      const stopLoss = parseFloat((recentSwingLow.price - atr * 0.5).toFixed(4));
      return {
        signal:   'long',
        entry:    currentPrice,
        stopLoss,
        swingRef: recentSwingLow.price,
        reason:   `HTF bullish + 15m swing low breakout above $${swingLowHigh.toFixed(2)}`,
      };
    }
  }

  // Short entry: HTF bearish + price breaks below recent 15m swing high
  if (htfTrend === 'bear' && swingHighs.length >= 1) {
    const recentSwingHigh = swingHighs[swingHighs.length - 1];
    const swingHighLow    = ltfCandles[recentSwingHigh.index].low;

    if (currentPrice < swingHighLow) {
      const stopLoss = parseFloat((recentSwingHigh.price + atr * 0.5).toFixed(4));
      return {
        signal:   'short',
        entry:    currentPrice,
        stopLoss,
        swingRef: recentSwingHigh.price,
        reason:   `HTF bearish + 15m swing high breakdown below $${swingHighLow.toFixed(2)}`,
      };
    }
  }

  return null;
}

// ── BitGet API ────────────────────────────────────────────────────────────────

function bitgetSign(timestamp, method, path, body = '') {
  const msg = timestamp + method.toUpperCase() + path + body;
  return crypto.createHmac('sha256', CONFIG.secretKey).update(msg).digest('base64');
}

async function bitgetRequest(method, path, body = null) {
  const ts      = Date.now().toString();
  const bodyStr = body ? JSON.stringify(body) : '';
  const sig     = bitgetSign(ts, method, path, bodyStr);
  const res     = await fetch(BITGET_BASE + path, {
    method,
    headers: {
      'ACCESS-KEY':        CONFIG.apiKey,
      'ACCESS-SIGN':       sig,
      'ACCESS-TIMESTAMP':  ts,
      'ACCESS-PASSPHRASE': CONFIG.passphrase,
      'Content-Type':      'application/json',
    },
    body: body ? bodyStr : undefined,
  });
  return res.json();
}

async function setLeverage(symbol, leverage) {
  for (const holdSide of ['long', 'short']) {
    await bitgetRequest('POST', '/api/v2/mix/account/set-leverage', {
      symbol, productType: 'USDT-FUTURES', marginCoin: 'USDT',
      leverage: leverage.toString(), holdSide,
    });
  }
}

async function placeOrder(symbol, side, quantity, entry) {
  if (CONFIG.paperTrading) {
    console.log(`  [IRONCLAD PAPER ${CONFIG.leverage}x] ${side.toUpperCase()} ${quantity} ${symbol} @ $${entry}`);
    return { orderId: 'IRONCLAD-PAPER-' + Date.now() };
  }
  await setLeverage(symbol, CONFIG.leverage);
  const futuresSide = side === 'long' ? 'open_long' : 'open_short';
  return bitgetRequest('POST', '/api/v2/mix/order/placeOrder', {
    symbol, productType: 'USDT-FUTURES', marginCoin: 'USDT',
    marginMode: 'crossed', side: futuresSide,
    orderType: 'market', size: quantity.toString(),
  });
}

// ── Position Sizing ───────────────────────────────────────────────────────────

function calcQuantity(entry, stopLoss) {
  const riskUsd    = CONFIG.portfolioUsd * 0.01; // 1% risk
  const stopDist   = Math.abs(entry - stopLoss);
  const stopDistPct = stopDist / entry;
  // With leverage, effective stop distance is multiplied
  const effectiveRisk = stopDistPct * CONFIG.leverage;
  const sizeUsd    = Math.min(riskUsd / effectiveRisk, CONFIG.maxTradeUsd);
  return parseFloat((sizeUsd / entry).toFixed(6));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  const rules        = loadRules();
  const researchData = loadResearchSignals();

  console.log(`\n══ IRONCLAD Bot run ${new Date().toISOString()} ══`);
  console.log(`Strategy  : ${rules.strategy}`);
  console.log(`HTF       : ${rules.timeframes.htf}  LTF: ${rules.timeframes.ltf}`);
  console.log(`Leverage  : ${CONFIG.leverage}x  Paper: ${CONFIG.paperTrading}`);
  console.log(`Symbols   : ${SYMBOLS.length} pairs`);
  console.log(`Research  : ${researchData ? `${researchData.signals.length} signals loaded` : 'No signal file — technicals only'}`);
  console.log(`─`.repeat(60));

  for (const symbol of SYMBOLS) {
    console.log(`\n▶ ${symbol}`);

    // Daily trade limit per symbol
    if (countTodayTrades(symbol) >= CONFIG.maxPerDay) {
      console.log(`  Daily limit reached — skipping`);
      continue;
    }

    let htfCandles, ltfCandles;
    try {
      [htfCandles, ltfCandles] = await Promise.all([
        fetchCandles(symbol, rules.timeframes.htf, 50),
        fetchCandles(symbol, rules.timeframes.ltf, 100),
      ]);
    } catch (err) {
      console.log(`  ✗ Data fetch failed: ${err.message}`);
      continue;
    }

    // Step 1: Detect HTF trend + EMA levels
    const htf = detectTrend(
      htfCandles,
      rules.swing_detection.swing_lookback,
      rules.swing_detection.trend_swing_count,
      rules.swing_detection.atr_threshold
    );
    const emaLevels = calcEMALevels(htfCandles);

    console.log(`  HTF Trend : ${htf.trend.toUpperCase()}  (${htf.swingHighs.length} highs, ${htf.swingLows.length} lows)`);
    console.log(`  EMA levels: 21=$${emaLevels.ema21?.toFixed(2) ?? '—'}  50=$${emaLevels.ema50?.toFixed(2) ?? '—'}  100=$${emaLevels.ema100?.toFixed(2) ?? '—'}  200=$${emaLevels.ema200?.toFixed(2) ?? '—'}`);

    if (htf.trend === 'neutral') {
      console.log(`  ✗ No clear HTF trend — skipping`);
      writeLog({ timestamp: new Date().toISOString(), symbol, htfTrend: 'neutral', signal: null, reason: 'No clear daily trend' });
      continue;
    }

    // Step 2: Detect LTF entry
    const entry = detectEntry(
      ltfCandles,
      htf.trend,
      rules.swing_detection.ltf_swing_lookback
    );

    if (!entry) {
      console.log(`  ✗ No ${htf.trend === 'bull' ? 'long' : 'short'} entry signal on 15m yet`);
      writeLog({ timestamp: new Date().toISOString(), symbol, htfTrend: htf.trend, signal: null, reason: 'No LTF breakout confirmed' });
      continue;
    }

    // Step 3: Calculate 3 TP levels from EMA + HTF swing levels
    const tps = calcTakeProfitLevels(
      entry.signal,
      entry.entry,
      entry.stopLoss,
      emaLevels,
      htf.swingHighs,
      htf.swingLows
    );

    console.log(`  ✓ Entry signal: ${entry.signal.toUpperCase()}`);
    console.log(`    Entry    : $${entry.entry.toFixed(2)}`);
    console.log(`    Stop     : $${entry.stopLoss.toFixed(2)}  (below swing ref $${entry.swingRef.toFixed(2)})`);
    console.log(`    TP1      : $${tps.tp1.toFixed(2)}  (1:${tps.rr1} R:R)  → SL moves to break-even`);
    console.log(`    TP2      : $${tps.tp2.toFixed(2)}  (1:${tps.rr2} R:R)  → SL trails to TP1`);
    console.log(`    TP3      : $${tps.tp3.toFixed(2)}  (1:${tps.rr3} R:R)  → final exit`);
    console.log(`    Split    : 40% / 35% / 25% of position`);
    console.log(`    Reason   : ${entry.reason}`);

    // Research sentiment filter
    const researchSignal = getResearchSignal(researchData, symbol);
    if (researchSignal) {
      const extra = researchSignal.chart_pattern ? ` | Pattern: ${researchSignal.chart_pattern}` : '';
      const level = researchSignal.price_level   ? ` | Level: ${researchSignal.price_level}` : '';
      console.log(`    Research : ${researchSignal.signal.toUpperCase()} — ${researchSignal.reason}${extra}${level}`);
    }
    if (!isResearchAligned(researchSignal, entry.signal)) {
      console.log(`  ✗ Research conflicts (${researchSignal.signal}) with ${entry.signal} — skipping`);
      writeLog({ timestamp: new Date().toISOString(), symbol, htfTrend: htf.trend, signal: null, reason: `Research conflict: ${researchSignal.signal} vs ${entry.signal}` });
      continue;
    }

    const qty   = calcQuantity(entry.entry, entry.stopLoss);
    const order = await placeOrder(symbol, entry.signal, qty, entry.entry);

    writeLog({
      timestamp: new Date().toISOString(),
      symbol,
      htfTrend:  htf.trend,
      signal:    entry.signal,
      entry:     entry.entry,
      stopLoss:  entry.stopLoss,
      tp1: tps.tp1, tp2: tps.tp2, tp3: tps.tp3,
      rr1: tps.rr1, rr2: tps.rr2, rr3: tps.rr3,
      slAfterTp1: tps.slPlan.afterTp1,
      slAfterTp2: tps.slPlan.afterTp2,
      split:     tps.split,
      emaLevels,
      reason:    entry.reason,
      orderId:   order.orderId || order.data?.orderId,
    });

    const now = new Date();
    const row = [
      now.toISOString().slice(0, 10),
      now.toISOString().slice(11, 19),
      'BitGet',
      symbol,
      entry.signal,
      qty,
      entry.entry.toFixed(2),
      entry.stopLoss.toFixed(2),
      tps.tp1.toFixed(2),
      tps.tp2.toFixed(2),
      tps.tp3.toFixed(2),
      tps.rr1,
      tps.rr2,
      tps.rr3,
      tps.slPlan.afterTp1.toFixed(2),
      (qty * entry.entry).toFixed(2),
      order.orderId || order.data?.orderId || 'unknown',
      CONFIG.paperTrading ? 'paper' : 'live',
      'Ironclad',
    ].join(',');
    appendTrade(row);

    console.log(`  Trade logged.`);
  }

  console.log(`\n══ IRONCLAD run complete ══`);
}

run().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
