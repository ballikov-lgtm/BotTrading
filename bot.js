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
  symbol:       process.env.SYMBOL              || 'BTCUSDT',
  timeframe:    process.env.TIMEFRAME           || '4h',
  paperTrading: process.env.PAPER_TRADING !== 'false',
};

const RULES_PATH      = './rules.json';
const TRADES_PATH     = './trades.csv';
const SAFETY_LOG_PATH = './safety-check-log.json';
const BITGET_BASE     = 'https://api.bitget.com';
const BINANCE_BASE    = 'https://api.binance.com';

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

function countTodayTrades() {
  if (!fs.existsSync(TRADES_PATH)) return 0;
  const lines = fs.readFileSync(TRADES_PATH, 'utf8').trim().split('\n');
  const today = todayString();
  return lines.slice(1).filter(l => l.startsWith(today)).length;
}

function appendTrade(row) {
  const header = 'Date,Time,Exchange,Symbol,Side,Quantity,Price,Total USD,Fee,Net Amount,Order ID,Mode,Notes';
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

  const indicators = { price, ema8, rsi3, vwap, vwapDist };

  // Avoidance rules
  const tooFarFromVwap = vwapDist > 1.5;

  // Direction
  let direction = 'neutral';
  if (price > vwap && price > ema8 && rsi3 < 30) direction = 'long';
  if (price < vwap && price < ema8 && rsi3 > 70) direction = 'short';

  const passed  = !tooFarFromVwap && direction !== 'neutral';
  const reasons = [];
  if (tooFarFromVwap) reasons.push(`Price ${vwapDist.toFixed(2)}% from VWAP (max 1.5%) — overextended`);
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
  await bitgetRequest('POST', '/api/v2/mix/account/set-leverage', {
    symbol,
    productType: 'USDT-FUTURES',
    marginCoin:  'USDT',
    leverage:    leverage.toString(),
    holdSide:    'long',
  });
  await bitgetRequest('POST', '/api/v2/mix/account/set-leverage', {
    symbol,
    productType: 'USDT-FUTURES',
    marginCoin:  'USDT',
    leverage:    leverage.toString(),
    holdSide:    'short',
  });
}

async function placeOrder(side, price, quantity) {
  if (CONFIG.paperTrading) {
    const label = CONFIG.mode === 'futures'
      ? `[PAPER FUTURES ${CONFIG.leverage}x] ${side.toUpperCase()}`
      : `[PAPER SPOT] ${side.toUpperCase()}`;
    console.log(`${label} ${quantity} ${CONFIG.symbol} @ ${price}`);
    return { orderId: 'PAPER-' + Date.now(), paper: true };
  }

  if (CONFIG.mode === 'futures') {
    await setLeverage(CONFIG.symbol, CONFIG.leverage);
    const futuresSide = side === 'long' ? 'open_long' : 'open_short';
    return bitgetRequest('POST', '/api/v2/mix/order/placeOrder', {
      symbol:      CONFIG.symbol,
      productType: 'USDT-FUTURES',
      marginCoin:  'USDT',
      marginMode:  'crossed',
      side:        futuresSide,
      orderType:   'market',
      size:        quantity.toString(),
    });
  }

  return bitgetRequest('POST', '/api/v2/spot/trade/placeOrder', {
    symbol:    CONFIG.symbol,
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

  const rules = loadRules();
  console.log(`\n── Bot run ${new Date().toISOString()} ──`);
  console.log(`Strategy : ${rules.strategy}`);
  console.log(`Symbol   : ${CONFIG.symbol}  Timeframe: ${CONFIG.timeframe}`);
  console.log(`Mode     : ${CONFIG.mode}${CONFIG.mode === 'futures' ? `  Leverage: ${CONFIG.leverage}x` : ''}`);
  console.log(`Paper    : ${CONFIG.paperTrading}`);

  // Daily trade limit
  const todayCount = countTodayTrades();
  if (todayCount >= CONFIG.maxPerDay) {
    console.log(`Daily limit reached (${todayCount}/${CONFIG.maxPerDay}) — skipping.`);
    return;
  }

  // Fetch market data
  const candles = await fetchCandles(CONFIG.symbol, CONFIG.timeframe, 100);
  const { passed, direction, indicators, reasons } = safetyCheck(candles, rules);

  console.log(`\nIndicators:`);
  console.log(`  Price : $${indicators.price.toFixed(2)}`);
  console.log(`  EMA8  : $${indicators.ema8.toFixed(2)}`);
  console.log(`  RSI3  : ${indicators.rsi3.toFixed(1)}`);
  console.log(`  VWAP  : $${indicators.vwap.toFixed(2)}`);
  console.log(`  VWAP% : ${indicators.vwapDist.toFixed(2)}%`);
  console.log(`Direction: ${direction}`);

  const logEntry = {
    timestamp:  new Date().toISOString(),
    symbol:     CONFIG.symbol,
    indicators,
    direction,
    passed,
    reasons,
    action:     null,
    order:      null,
  };

  if (!passed) {
    console.log(`\nSafety check FAILED:`);
    reasons.forEach(r => console.log(`  ✗ ${r}`));
    writeSafetyLog(logEntry);
    return;
  }

  console.log(`\nSafety check PASSED — placing ${direction} order`);

  const qty   = calcQuantity(indicators.price);
  const order = await placeOrder(direction, indicators.price, qty);

  logEntry.action = direction;
  logEntry.order  = order;
  writeSafetyLog(logEntry);

  // Log to CSV
  const now     = new Date();
  const totalUsd = (qty * indicators.price).toFixed(2);
  const fee      = CONFIG.paperTrading ? '0' : 'check-exchange';
  const row = [
    now.toISOString().slice(0, 10),
    now.toISOString().slice(11, 19),
    'BitGet',
    CONFIG.symbol,
    direction,
    qty,
    indicators.price.toFixed(2),
    totalUsd,
    fee,
    totalUsd,
    order.orderId || order.data?.orderId || 'unknown',
    CONFIG.paperTrading ? 'paper' : 'live',
    rules.strategy,
  ].join(',');
  appendTrade(row);

  console.log(`Trade logged. Order ID: ${order.orderId || order.data?.orderId || 'unknown'}`);
}

run().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
