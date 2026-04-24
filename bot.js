import 'dotenv/config';
import fetch from 'node-fetch';
import fs from 'fs';
import crypto from 'crypto';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// ── Config ────────────────────────────────────────────────────────────────────

const CONFIG = {
  apiKey:       process.env.BITGET_API_KEY      || '',
  secretKey:    process.env.BITGET_SECRET_KEY   || '',
  passphrase:   process.env.BITGET_PASSPHRASE   || '',
  mode:         process.env.MODE                || 'spot',
  leverage:     parseInt(process.env.LEVERAGE)           || 1,
  portfolioUsd: parseFloat(process.env.PORTFOLIO_USD)    || 1000,
  maxTradeUsd:  parseFloat(process.env.MAX_TRADE_USD)    || 100,
  maxPerDay:    parseInt(process.env.MAX_TRADES_PER_DAY) || 3,
  timeframe:    process.env.TIMEFRAME           || '4h',
  paperTrading: process.env.PAPER_TRADING !== 'false',
};

// Strategy 1 — VWAP + RSI3 + EMA8 scalping
// CRYPTO ONLY — works best in ranging/choppy markets
// Stocks and commodities are handled by the Ironclad bot
// Base watchlist — always checked every run
const BASE_SYMBOLS = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT',
  'LINKUSDT', 'HYPEUSDT', 'VIRTUALUSDT',
  'APTUSDT', 'ONDOUSDT', 'JUPUSDT',
];

const RULES_PATH      = './rules.json';
const TRADES_PATH     = './trades.csv';
const SAFETY_LOG_PATH = './safety-check-log.json';
const SIGNALS_PATH    = './research-signals.json';
const BITGET_BASE     = 'https://api.bitget.com';
const BINANCE_BASE    = 'https://api.binance.com';

// ── Research Signal Filter ────────────────────────────────────────────────────

// Build the final symbol list for this run.
// Base symbols are always checked. On top of that, any crypto token found
// by today's research (Perplexity OR DegenDave) with a clear bull/bear
// signal that is confirmed live on BitGet futures gets added automatically.
// Neutral signals are ignored — no clear direction, no trade.
function buildSymbolList(researchData) {
  const symbols = [...BASE_SYMBOLS];
  if (!researchData?.signals) return symbols;

  const degenPicks   = [];
  const researchPicks = [];

  for (const s of researchData.signals) {
    if (!s.token || s.signal === 'neutral') continue;
    if (s.category !== 'crypto') continue;   // Stocks/commodities handled by Ironclad
    if (!s.bitget) continue;                  // Not available on BitGet futures — skip

    const sym = `${s.token.toUpperCase()}USDT`;
    if (symbols.includes(sym)) continue;      // Already in base list

    if (s.source?.toLowerCase().includes('degendave')) {
      degenPicks.push(sym);
    } else {
      researchPicks.push(sym);
    }
  }

  // DegenDave picks have priority, then general research, total cap of 8 extras
  const extras = [...new Set([...degenPicks, ...researchPicks])].slice(0, 8);

  if (degenPicks.length)    console.log(`  DegenDave picks   : ${degenPicks.join(', ')}`);
  if (researchPicks.length) console.log(`  Research picks    : ${researchPicks.join(', ')}`);
  if (extras.length)        symbols.push(...extras);

  return symbols;
}

function loadResearchSignals() {
  try {
    if (!fs.existsSync(SIGNALS_PATH)) return null;
    const data = JSON.parse(fs.readFileSync(SIGNALS_PATH, 'utf8'));
    // Only use signals from today
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
  if (!researchSignal) return true; // No research data — allow trade
  if (researchSignal.signal === 'neutral') return true; // Neutral — allow
  if (direction === 'long'  && researchSignal.signal === 'bull') return true;
  if (direction === 'short' && researchSignal.signal === 'bear') return true;
  return false; // Research conflicts with trade direction — skip
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadRules() {
  if (!fs.existsSync(RULES_PATH)) {
    console.error('rules.json not found — copy rules.json.example and configure it.');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(RULES_PATH, 'utf8'));
}

function todayString() {
  return new Date().toISOString().slice(0, 10);
}

function countTodayTrades(symbol = null) {
  if (!fs.existsSync(TRADES_PATH)) return 0;
  const lines = fs.readFileSync(TRADES_PATH, 'utf8').trim().split('\n');
  const today = todayString();
  return lines.slice(1).filter(l => {
    if (!l.startsWith(today)) return false;
    if (symbol) return l.includes(symbol);
    return true;
  }).length;
}

function appendTrade(row) {
  const header = 'Date,Time,Exchange,Symbol,Side,Quantity,Price,Stop Loss,Take Profit,RR,Total USD,Fee,Order ID,Mode,Notes';
  if (!fs.existsSync(TRADES_PATH)) fs.writeFileSync(TRADES_PATH, header + '\n');
  fs.appendFileSync(TRADES_PATH, row + '\n');
}

function writeSafetyLog(entry) {
  let log = [];
  if (fs.existsSync(SAFETY_LOG_PATH)) {
    try { log = JSON.parse(fs.readFileSync(SAFETY_LOG_PATH, 'utf8')); } catch {}
  }
  log.unshift(entry);
  fs.writeFileSync(SAFETY_LOG_PATH, JSON.stringify(log.slice(0, 100), null, 2));
}

// ── Market Data (Binance public API — free, no key needed) ───────────────────

async function fetchCandles(symbol, interval, limit = 100) {
  // BitGet granularity map (BitGet uses minutes-based strings)
  const granularityMap = { '1m':'1m', '3m':'3m', '5m':'5m', '15m':'15m', '30m':'30m', '1h':'1H', '4h':'4H', '6h':'6H', '12h':'12H', '1d':'1D', '1w':'1W' };
  const granularity = granularityMap[interval] || interval;
  const url = `${BITGET_BASE}/api/v2/mix/market/candles?symbol=${symbol}&productType=USDT-FUTURES&granularity=${granularity}&limit=${limit}`;
  const res  = await fetch(url);
  const json = await res.json();
  const data = json.data;
  if (!Array.isArray(data)) throw new Error(`Could not fetch candle data: ${JSON.stringify(json)}`);
  return data.map(c => ({
    open:   parseFloat(c[1]),
    high:   parseFloat(c[2]),
    low:    parseFloat(c[3]),
    close:  parseFloat(c[4]),
    volume: parseFloat(c[5]),
    time:   parseInt(c[0]),
  }));
}

// ── Indicators ────────────────────────────────────────────────────────────────

function calcEMA(closes, period) {
  const k = 2 / (period + 1);
  let ema  = closes[0];
  for (let i = 1; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

function calcRSI(closes, period) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains  += diff;
    else            losses -= diff;
  }
  const avgGain = gains  / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return candles[candles.length - 1].close * 0.01;
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

// Scalping exits — appropriate for choppy/ranging VWAP reversion trades.
// TP = mean reversion back to VWAP (the natural target for this strategy).
// SL = 1× ATR against the trade (not too wide, not too tight).
// NOT the 3-TP / EMA swing system — that belongs to Ironclad only.
function calcScalpingExits(price, direction, vwap, atr) {
  let stopLoss, takeProfit;
  if (direction === 'long') {
    stopLoss   = parseFloat((price - atr * 1.0).toFixed(4));
    takeProfit = parseFloat((Math.max(vwap, price + atr * 1.5)).toFixed(4));
  } else {
    stopLoss   = parseFloat((price + atr * 1.0).toFixed(4));
    takeProfit = parseFloat((Math.min(vwap, price - atr * 1.5)).toFixed(4));
  }
  const risk   = Math.abs(price - stopLoss);
  const reward = Math.abs(takeProfit - price);
  const rr     = reward > 0 ? parseFloat((reward / risk).toFixed(2)) : 0;
  return { stopLoss, takeProfit, rr };
}

function calcVWAP(candles) {
  const midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);
  const sessionCandles = candles.filter(c => c.time >= midnight.getTime());
  if (!sessionCandles.length) return candles[candles.length - 1].close;
  let cumTPV = 0, cumVol = 0;
  for (const c of sessionCandles) {
    const tp = (c.high + c.low + c.close) / 3;
    cumTPV += tp * c.volume;
    cumVol += c.volume;
  }
  return cumVol === 0 ? candles[candles.length - 1].close : cumTPV / cumVol;
}

// ── Safety Check ──────────────────────────────────────────────────────────────

function safetyCheck(candles, rules) {
  const closes = candles.map(c => c.close);
  const price  = closes[closes.length - 1];
  const ema8   = calcEMA(closes, rules.indicators?.ema_period  || 8);
  const rsi3   = calcRSI(closes, rules.indicators?.rsi_period  || 3);
  const vwap   = calcVWAP(candles);

  const vwapDist = Math.abs((price - vwap) / vwap) * 100;

  // Detect if market is strongly trending (not suitable for this scalping strategy)
  // If the last 10 closes are ALL above or ALL below EMA8, market is trending
  const last10 = closes.slice(-10);
  const allAboveEMA = last10.every(c => c > ema8);
  const allBelowEMA = last10.every(c => c < ema8);
  const isTrending  = allAboveEMA || allBelowEMA;

  const indicators = { price, ema8, rsi3, vwap, vwapDist, isTrending };

  // Avoidance rules — widened VWAP threshold from 1.5% to 2.0%
  const tooFarFromVwap = vwapDist > 2.0;

  // Direction
  let direction = 'neutral';
  if (price > vwap && price > ema8 && rsi3 < 30) direction = 'long';
  if (price < vwap && price < ema8 && rsi3 > 70) direction = 'short';

  const passed  = !tooFarFromVwap && !isTrending && direction !== 'neutral';
  const reasons = [];
  if (tooFarFromVwap) reasons.push(`Price ${vwapDist.toFixed(2)}% from VWAP (max 2.0%) — overextended`);
  if (isTrending)     reasons.push(`Market is strongly trending — VWAP scalping not suitable, deferring to Ironclad`);
  if (direction === 'neutral') reasons.push('No clear directional signal from VWAP/EMA8/RSI3');

  return { passed, direction, indicators, reasons };
}

// ── BitGet Execution ──────────────────────────────────────────────────────────

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
  const marginCoin = symbol.endsWith('USD') ? 'USD' : 'USDT';
  for (const holdSide of ['long', 'short']) {
    await bitgetRequest('POST', '/api/v2/mix/account/set-leverage', {
      symbol,
      productType: 'USDT-FUTURES',
      marginCoin,
      leverage:    leverage.toString(),
      holdSide,
    });
  }
}

async function placeOrder(side, price, quantity, symbol, exits) {
  if (CONFIG.paperTrading) {
    const label = CONFIG.mode === 'futures'
      ? `[PAPER FUTURES ${CONFIG.leverage}x] ${side.toUpperCase()}`
      : `[PAPER SPOT] ${side.toUpperCase()}`;
    console.log(`  ${label} ${quantity} ${symbol} @ ${price}`);
    if (exits) {
      console.log(`  SL: $${exits.stopLoss}  TP: $${exits.takeProfit}  R:R 1:${exits.rr}`);
    }
    return { orderId: 'PAPER-' + Date.now(), paper: true };
  }

  if (CONFIG.mode === 'futures') {
    await setLeverage(symbol, CONFIG.leverage);
    const futuresSide = side === 'long' ? 'open_long' : 'open_short';
    const body = {
      symbol,
      productType: 'USDT-FUTURES',
      marginCoin:  'USDT',
      marginMode:  'crossed',
      side:        futuresSide,
      orderType:   'market',
      size:        quantity.toString(),
    };
    // Attach SL and TP to the order natively — BitGet manages these on the exchange
    if (exits?.stopLoss)   body.presetStopLossPrice    = exits.stopLoss.toString();
    if (exits?.takeProfit) body.presetStopSurplusPrice = exits.takeProfit.toString();
    return bitgetRequest('POST', '/api/v2/mix/order/placeOrder', body);
  }

  return bitgetRequest('POST', '/api/v2/spot/trade/placeOrder', {
    symbol,
    side:      side.toLowerCase(),
    orderType: 'market',
    size:      quantity.toString(),
  });
}

// ── Position Sizing ───────────────────────────────────────────────────────────

function calcQuantity(price) {
  const riskUsd = CONFIG.portfolioUsd * 0.01;
  const sizeUsd = Math.min(riskUsd, CONFIG.maxTradeUsd);
  return parseFloat((sizeUsd / price).toFixed(6));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  // Tax summary flag
  if (process.argv.includes('--tax-summary')) {
    if (!fs.existsSync(TRADES_PATH)) { console.log('No trades recorded yet.'); return; }
    const lines = fs.readFileSync(TRADES_PATH, 'utf8').trim().split('\n').slice(1);
    const total = lines.reduce((sum, l) => {
      const cols = l.split(',');
      return sum + (parseFloat(cols[8]) || 0);
    }, 0);
    console.log(`Total trades: ${lines.length}`);
    console.log(`Total fees:   $${total.toFixed(4)}`);
    return;
  }

  const rules        = loadRules();
  const researchData = loadResearchSignals();
  const SYMBOLS      = buildSymbolList(researchData);

  console.log(`\n── Bot run ${new Date().toISOString()} ──`);
  console.log(`Strategy  : ${rules.strategy}`);
  console.log(`Symbols   : ${SYMBOLS.join(', ')}`);
  console.log(`Timeframe : ${CONFIG.timeframe}`);
  console.log(`Mode      : ${CONFIG.mode}${CONFIG.mode === 'futures' ? `  Leverage: ${CONFIG.leverage}x` : ''}`);
  console.log(`Paper     : ${CONFIG.paperTrading}`);
  console.log(`Research  : ${researchData ? `${researchData.signals.length} signals loaded from ${researchData.generated}` : 'No signal file — running on technicals only'}`);
  console.log(`─`.repeat(60));

  for (const symbol of SYMBOLS) {
    console.log(`\n▶ Checking ${symbol}...`);

    // Per-symbol daily trade limit
    const symbolCount = countTodayTrades(symbol);
    if (symbolCount >= CONFIG.maxPerDay) {
      console.log(`  Daily limit reached for ${symbol} (${symbolCount}/${CONFIG.maxPerDay}) — skipping`);
      continue;
    }

    // Fetch candles and run safety check
    let candles;
    try {
      candles = await fetchCandles(symbol, CONFIG.timeframe, 100);
    } catch (err) {
      console.log(`  ✗ Could not fetch candles: ${err.message}`);
      continue;
    }

    const { passed, direction, indicators, reasons } = safetyCheck(candles, rules);

    console.log(`  Price: $${indicators.price.toFixed(2)}  EMA8: $${indicators.ema8.toFixed(2)}  RSI3: ${indicators.rsi3.toFixed(1)}  VWAP%: ${indicators.vwapDist.toFixed(2)}%  → ${direction}`);

    const logEntry = {
      timestamp: new Date().toISOString(),
      symbol,
      timeframe:  CONFIG.timeframe,
      indicators,
      direction,
      passed,
      reasons,
      action: null,
      order:  null,
    };

    if (!passed) {
      reasons.forEach(r => console.log(`  ✗ ${r}`));
      writeSafetyLog(logEntry);
      continue;
    }

    // Research sentiment filter
    const researchSignal = getResearchSignal(researchData, symbol);
    if (researchSignal) {
      console.log(`  Research: ${researchSignal.signal.toUpperCase()} (${researchSignal.source})`);
    }
    if (!isResearchAligned(researchSignal, direction)) {
      console.log(`  ✗ Research sentiment conflicts — ${researchSignal.signal} vs ${direction} — skipping`);
      writeSafetyLog({ ...logEntry, reasons: [`Research conflict: sentiment is ${researchSignal.signal} but signal is ${direction}`] });
      continue;
    }

    // Calculate ATR-based scalping exits — simple SL + VWAP reversion TP
    // (NOT the 3-TP swing system — that belongs to Ironclad only)
    const atr   = calcATR(candles);
    const exits = calcScalpingExits(indicators.price, direction, indicators.vwap, atr);

    console.log(`  ✓ Safety check PASSED + Research aligned — placing ${direction} order`);
    console.log(`    SL: $${exits.stopLoss}  TP: $${exits.takeProfit}  R:R 1:${exits.rr}  (ATR=$${atr.toFixed(4)})`);

    const qty   = calcQuantity(indicators.price);
    const order = await placeOrder(direction, indicators.price, qty, symbol, exits);

    logEntry.action    = direction;
    logEntry.order     = order;
    logEntry.stopLoss  = exits.stopLoss;
    logEntry.takeProfit = exits.takeProfit;
    logEntry.rr        = exits.rr;
    writeSafetyLog(logEntry);

    // Log to CSV
    const now      = new Date();
    const totalUsd = (qty * indicators.price).toFixed(2);
    const fee      = CONFIG.paperTrading ? '0' : 'check-exchange';
    const row = [
      now.toISOString().slice(0, 10),
      now.toISOString().slice(11, 19),
      'BitGet',
      symbol,
      direction,
      qty,
      indicators.price.toFixed(2),
      exits.stopLoss,
      exits.takeProfit,
      exits.rr,
      totalUsd,
      fee,
      order.orderId || order.data?.orderId || 'unknown',
      CONFIG.paperTrading ? 'paper' : 'live',
      rules.strategy,
    ].join(',');
    appendTrade(row);

    console.log(`  Trade logged. Order ID: ${order.orderId || order.data?.orderId || 'unknown'}`);
  }
}

run().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
