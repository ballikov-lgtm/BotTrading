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
const BITGET_BASE     = 'https://api.bitget.com';

// Ironclad monitors ALL asset classes — crypto, stocks, commodities
// This is the trend-following strategy, best in markets with a clear daily direction
// Strategy 1 (VWAP scalping) handles crypto-only ranging markets
const SYMBOLS = [
  // Crypto — trending pairs
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT',
  'LINKUSDT', 'HYPEUSDT', 'VIRTUALUSDT',
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
  const header = 'Date,Time,Exchange,Symbol,Side,Quantity,Entry Price,Stop Loss,Take Profit,Total USD,Order ID,Mode,Strategy';
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
      const stopLoss   = recentSwingLow.price - (atr * 0.5);
      const riskPips   = currentPrice - stopLoss;
      const takeProfit = currentPrice + (riskPips * 1.5); // Minimum 1.5 R:R

      return {
        signal:     'long',
        entry:      currentPrice,
        stopLoss:   parseFloat(stopLoss.toFixed(4)),
        takeProfit: parseFloat(takeProfit.toFixed(4)),
        swingRef:   recentSwingLow.price,
        riskReward: 1.5,
        reason:     `HTF bullish trend + 15m swing low breakout above $${swingLowHigh.toFixed(2)}`,
      };
    }
  }

  // Short entry: HTF bearish + price breaks below recent 15m swing high
  if (htfTrend === 'bear' && swingHighs.length >= 1) {
    const recentSwingHigh = swingHighs[swingHighs.length - 1];
    const swingHighLow    = ltfCandles[recentSwingHigh.index].low;

    if (currentPrice < swingHighLow) {
      const stopLoss   = recentSwingHigh.price + (atr * 0.5);
      const riskPips   = stopLoss - currentPrice;
      const takeProfit = currentPrice - (riskPips * 1.5);

      return {
        signal:     'short',
        entry:      currentPrice,
        stopLoss:   parseFloat(stopLoss.toFixed(4)),
        takeProfit: parseFloat(takeProfit.toFixed(4)),
        swingRef:   recentSwingHigh.price,
        riskReward: 1.5,
        reason:     `HTF bearish trend + 15m swing high breakdown below $${swingHighLow.toFixed(2)}`,
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
  const rules = loadRules();

  console.log(`\n══ IRONCLAD Bot run ${new Date().toISOString()} ══`);
  console.log(`Strategy  : ${rules.strategy}`);
  console.log(`HTF       : ${rules.timeframes.htf}  LTF: ${rules.timeframes.ltf}`);
  console.log(`Leverage  : ${CONFIG.leverage}x  Paper: ${CONFIG.paperTrading}`);
  console.log(`Symbols   : ${SYMBOLS.length} pairs`);
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

    // Step 1: Detect HTF trend
    const htf = detectTrend(
      htfCandles,
      rules.swing_detection.swing_lookback,
      rules.swing_detection.trend_swing_count,
      rules.swing_detection.atr_threshold
    );

    console.log(`  HTF Trend : ${htf.trend.toUpperCase()}  (${htf.swingHighs.length} highs, ${htf.swingLows.length} lows confirmed)`);

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

    console.log(`  ✓ Entry signal: ${entry.signal.toUpperCase()}`);
    console.log(`    Entry    : $${entry.entry.toFixed(2)}`);
    console.log(`    Stop     : $${entry.stopLoss.toFixed(2)}`);
    console.log(`    Target   : $${entry.takeProfit.toFixed(2)}`);
    console.log(`    R:R      : 1:${entry.riskReward}`);
    console.log(`    Reason   : ${entry.reason}`);

    const qty   = calcQuantity(entry.entry, entry.stopLoss);
    const order = await placeOrder(symbol, entry.signal, qty, entry.entry);

    writeLog({
      timestamp:  new Date().toISOString(),
      symbol,
      htfTrend:   htf.trend,
      signal:     entry.signal,
      entry:      entry.entry,
      stopLoss:   entry.stopLoss,
      takeProfit: entry.takeProfit,
      reason:     entry.reason,
      orderId:    order.orderId || order.data?.orderId,
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
      entry.takeProfit.toFixed(2),
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
