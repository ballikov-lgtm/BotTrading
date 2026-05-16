import 'dotenv/config';
import fetch from 'node-fetch';
import fs from 'fs';
import crypto from 'crypto';
import { execSync } from 'child_process';

// ── Config ────────────────────────────────────────────────────────────────────

const CONFIG = {
  apiKey:          process.env.BITGET_API_KEY        || '',
  secretKey:       process.env.BITGET_SECRET_KEY     || '',
  passphrase:      process.env.BITGET_PASSPHRASE     || '',
  mode:            process.env.MODE                  || 'futures',
  leverage:        parseInt(process.env.LEVERAGE)             || 3,
  portfolioUsd:    parseFloat(process.env.PORTFOLIO_USD)      || 1000,
  maxTradePct:     parseFloat(process.env.MAX_TRADE_PCT)      || 0.19, // 19% of portfolio = ~£50 margin at 3x on £1000 account. Scales automatically when compounding.
  maxPerDay:       parseInt(process.env.MAX_TRADES_PER_DAY)   || 3,
  paperTrading:    process.env.IRONCLAD_PAPER !== 'false',     // Separate paper flag
  maxDailyLossUsd: parseFloat(process.env.MAX_DAILY_LOSS_USD) || 50, // Daily drawdown circuit-breaker (5% of $1000)
};

// ── Bot identity (bumped with every meaningful strategy change) ───────────────
const BOT_NAME    = 'Ironclad';
const BOT_VERSION = 'v2.0'; // v1.0 initial swing · v1.1 EMA 21/50/100/200 3-TP system · v1.2 Fibonacci TP levels · v1.3 min stop 0.3% + TP sort fix · v1.4 crypto-only + economic event blackout · v1.5 3h post-loss cooldown per symbol · v1.6 daily drawdown circuit-breaker + live mode + $1000 portfolio · v1.7 real 3-TP split (3 limit closes) + TP fill monitoring + auto-trail SL · v1.8 percentage-based position sizing (compounds with account) + smart re-entry (only cap at 3/day when coin is losing) · v1.9 contract step-size rounding (fixes [22002] on fractional qty) + sequential TP placement (TP2 placed after TP1 fills, TP3 after TP2) + TP1 auto-retry in monitoring loop · v2.0 correct entry rule: requires 2nd lower high (not lower low) for shorts — validates lower high structure, pullback confirmation (swing low between two highs), and recency (max 12 bars)

const RULES_PATH      = './rules-ironclad.json';
const TRADES_PATH     = './trades-ironclad.csv';
const POSITIONS_PATH  = './open-positions-ironclad.json';
const CLOSED_PATH     = './closed-positions-ironclad.json';
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

// ── Economic Event Blackout ───────────────────────────────────────────────────
// Blocks ALL new entries for 60 minutes either side of a high-impact US event.
// Events are written to research-signals.json by research.js twice daily.
// Rationale: FOMC / NFP / CPI cause sharp, manipulated price moves that
// invalidate swing structure and frequently stop out valid setups.

const BLACKOUT_MINUTES = 60;
const COOLDOWN_HOURS   = 3;    // Block re-entry on same symbol for N hours after a stop-out
const COOLDOWN_PATH    = './cooldown-ironclad.json';

function checkEconomicBlackout(researchData) {
  const events = researchData?.events;
  if (!events?.length) return null;

  const now         = Date.now();
  const windowMs    = BLACKOUT_MINUTES * 60 * 1000;

  for (const ev of events) {
    const evTime = new Date(ev.datetime).getTime();
    const diff   = evTime - now;                  // Positive = future, negative = past
    const absDiff = Math.abs(diff);

    if (absDiff <= windowMs) {
      const minsAway = Math.round(diff / 60000);
      const label    = minsAway > 0 ? `in ${minsAway} min` : `${Math.abs(minsAway)} min ago`;
      return { event: ev.name, datetime: ev.datetime, label };
    }
  }
  return null;
}

// ── Symbol Cooldown (post-loss re-entry block) ────────────────────────────────
// After a position is stopped out before hitting any TP (clean loss), new entries
// on that symbol are blocked for COOLDOWN_HOURS. Prevents the bot from repeatedly
// re-entering the same failed setup in choppy conditions — the primary cause of
// consecutive losses on the same asset seen in backtesting.
// Cooldown does NOT trigger on BE outcomes (TP1 hit then stopped at entry) because
// those are profitable and the setup had valid structure.

function loadCooldowns() {
  try {
    if (fs.existsSync(COOLDOWN_PATH)) return JSON.parse(fs.readFileSync(COOLDOWN_PATH, 'utf8'));
  } catch {}
  return {};
}

function saveCooldowns(cooldowns) {
  fs.writeFileSync(COOLDOWN_PATH, JSON.stringify(cooldowns, null, 2));
}

function isOnCooldown(symbol) {
  const cooldowns = loadCooldowns();
  const until     = cooldowns[symbol];
  if (!until) return { active: false };
  const remaining = new Date(until).getTime() - Date.now();
  if (remaining <= 0) return { active: false };
  const minsLeft = Math.ceil(remaining / 60000);
  return { active: true, until, minsLeft };
}

function setCooldown(symbol) {
  const cooldowns  = loadCooldowns();
  const until      = new Date(Date.now() + COOLDOWN_HOURS * 3_600_000).toISOString();
  cooldowns[symbol] = until;
  saveCooldowns(cooldowns);
  console.log(`  ⏳ Cooldown set — no new ${symbol} entries until ${until.slice(11, 16)} UTC (+${COOLDOWN_HOURS}h)`);
}

// ── Daily Drawdown Circuit-Breaker ────────────────────────────────────────────
// If today's realized losses exceed MAX_DAILY_LOSS_USD, halt all new entries.
// Only counts fully closed positions (partialCloses summed). Open positions and
// partial TP hits are not counted — we only know the full picture on close.
// Rationale: in a reversing market the strategy can stack consecutive losses
// quickly. This hard stop prevents a bad day compounding into a wipeout.

function checkDailyDrawdown() {
  const today = todayString();
  let closed  = [];
  try {
    if (fs.existsSync(CLOSED_PATH)) closed = JSON.parse(fs.readFileSync(CLOSED_PATH, 'utf8'));
  } catch {}

  const todayPnl = closed
    .filter(p => p.closeDate === today)
    .reduce((sum, p) => sum + (p.realizedPnl ?? 0), 0);

  const breached = todayPnl <= -Math.abs(CONFIG.maxDailyLossUsd);
  return { todayPnl: parseFloat(todayPnl.toFixed(2)), breached };
}

// Ironclad v1.6: Live mode. Portfolio $1000. Daily drawdown circuit-breaker added.
// HYPEUSDT re-added — personal trades moved to separate exchange. This account is Ironclad strategy only.
// v1.5: 3-hour cooldown after clean stop-out prevents re-entering the same failed setup.
// Backtested vs 5 days of data: cooldown alone added +$38.81 (+37%) vs baseline.
// SL 2% cap and TP1≥ATR filter were tested and found counterproductive — not applied.
const SYMBOLS = [
  // ── Core L1s ──────────────────────────────────────────────────────────────
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT',
  // ── Original watchlist ────────────────────────────────────────────────────
  'LINKUSDT', 'HYPEUSDT',
  'VIRTUALUSDT', 'APTUSDT', 'ONDOUSDT', 'JUPUSDT',
  // ── Added 2026-05-06: lagging / independent-narrative tokens ──────────────
  // 'PENDLEUSDT', // Removed — CoinGecko rank #138, below top 100 liquidity threshold
  'RENDERUSDT',   // DePIN/AI — GPU compute demand driven
  'TAOUSDT',      // Bittensor AI — subnet narrative, genuinely independent
  'AVAXUSDT',     // L1 breaking out of consolidation
  'ZECUSDT',      // Privacy coin — independent +190% trend
  'KASUSDT',      // BlockDAG — good fundamentals, pullback recovery
  // 'AMDUSDT',   // Tokenised stock — better as manual spot buy, removed 2026-05-06
  // ── Activated 2026-05-06: pause these if 3+ consecutive losses (BTC sub-84K chop risk)
  'TONUSDT',   // #5 CoinGecko — explosive independent breakout, Telegram ecosystem
  'NEARUSDT',  // AI blockchain — breakout today, strong narrative
  'INJUSDT',   // DeFi/perps — +36% trend, clean structure, top 40
  'SUIUSDT',   // L1 recovering from lows — waking up, good fundamentals
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

function isCoinLosingToday(symbol) {
  // Returns true if today's net realizedPnl on this symbol is negative.
  // Used to decide whether to enforce the maxPerDay cap:
  //   losing coin → cap at 3 entries (avoid chasing a bad trend)
  //   winning coin → allow unlimited re-entries (bull run, don't cut it short)
  if (!fs.existsSync(CLOSED_PATH)) return false;
  try {
    const closed = JSON.parse(fs.readFileSync(CLOSED_PATH, 'utf8'));
    const today  = todayString();
    const todayTrades = closed.filter(p =>
      p.symbol === symbol && (p.closeDate === today || p.openDate === today)
    );
    if (todayTrades.length === 0) return false;
    const netPnl = todayTrades.reduce((sum, p) => sum + (p.realizedPnl || 0), 0);
    return netPnl < 0;
  } catch {
    return false;
  }
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

// ── Contract size steps (minimum trade unit per symbol on Bitget USDT futures) ─
// Sending a non-step-multiple qty to place-order returns [22002] "No position
// to close" — Bitget's generic error for invalid close parameters.
// Rule: always FLOOR the split qty to the nearest step (never round up — that
// would try to close more than is held).
// How to determine the step: look at the open position's `total` field.
//   Integer → step = 1 (e.g. XRPUSDT shows 134)
//   One decimal → step = 0.1 (e.g. RENDERUSDT shows 93.7)
//   Two decimals → step = 0.01, etc.
const SIZE_STEP = {
  BTCUSDT:     0.001,
  ETHUSDT:     0.01,
  SOLUSDT:     0.1,
  AVAXUSDT:    0.1,
  TAOUSDT:     0.01,
  SUIUSDT:     1,
  XRPUSDT:     1,
  RENDERUSDT:  0.1,
  LINKUSDT:    0.1,
  HYPEUSDT:    0.1,
  VIRTUALUSDT: 1,
  APTUSDT:     0.1,
  ONDOUSDT:    1,
  JUPUSDT:     1,
  TONUSDT:     1,
  NEARUSDT:    1,
  INJUSDT:     0.1,
  KASUSDT:     1,
  ZECUSDT:     0.1,
};

// Floor qty to symbol's contract step — use for ALL close order sizes.
function floorToStep(qty, symbol) {
  const step = SIZE_STEP[symbol] || 0.01;
  const decimals = step < 0.001 ? 4 : step < 0.01 ? 3 : step < 0.1 ? 2 : step < 1 ? 1 : 0;
  return parseFloat((Math.floor(qty / step) * step).toFixed(decimals));
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
  // BitGet returns candles ASCENDING (oldest first) — no reverse needed.
  // Previous .reverse() was wrong and caused swing detection to look at the
  // oldest swings in history instead of the most recent ones.
  return json.data.map(c => ({
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

// ── Fibonacci Levels ──────────────────────────────────────────────────────────
// Draw Fib from the most recent confirmed swing high → swing low (for longs)
// or swing low → swing high (for shorts). Standard retracement ratios used
// as TP targets. 0.382 and 0.618 are the most respected bounce/resistance zones.
// Extensions (1.272, 1.618) are included for TP3 when price is in price discovery.

const FIB_RATIOS = [0.236, 0.382, 0.5, 0.618, 0.786, 1.0, 1.272, 1.618];

function calcFibLevels(direction, entry, htfSwingHighs, htfSwingLows) {
  if (!htfSwingHighs.length || !htfSwingLows.length) return [];

  // Use the most recent confirmed swing high and swing low from HTF data
  const recentHigh = htfSwingHighs[htfSwingHighs.length - 1].price;
  const recentLow  = htfSwingLows[htfSwingLows.length - 1].price;
  const range      = recentHigh - recentLow;

  if (range <= 0) return [];

  let levels;
  if (direction === 'long') {
    // Fib drawn high → low. Retracement levels above current price are TP targets.
    // e.g. 0.382 = low + (range × 0.382) — first significant resistance on the way up
    levels = FIB_RATIOS.map(r => parseFloat((recentLow + range * r).toFixed(4)));
  } else {
    // Fib drawn low → high. Retracement levels below current price are TP targets.
    levels = FIB_RATIOS.map(r => parseFloat((recentHigh - range * r).toFixed(4)));
  }

  return levels;
}

// Build 3 take-profit levels from EMA levels + HTF swing highs/lows + Fibonacci.
// For longs  : pick the 3 nearest levels ABOVE entry price
// For shorts : pick the 3 nearest levels BELOW entry price
// Fibonacci and EMA levels that coincide = double confirmation → prioritised.
// Falls back to fixed R:R multiples (1.5R, 2.5R, 4R) if not enough levels found.
function calcTakeProfitLevels(direction, entry, stopLoss, emaLevels, htfSwingHighs, htfSwingLows) {
  const risk    = Math.abs(entry - stopLoss);
  const fibLvls = calcFibLevels(direction, entry, htfSwingHighs, htfSwingLows);

  // Collect all candidate S/R levels — EMA + swing structure + Fibonacci
  const candidates = [
    emaLevels.ema21,
    emaLevels.ema50,
    emaLevels.ema100,
    emaLevels.ema200,
    ...htfSwingHighs.map(s => s.price),
    ...htfSwingLows.map(s => s.price),
    ...fibLvls,
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

  // Pick the 3 nearest candidates (or fallbacks), then sort them to guarantee
  // correct ordering: nearest → furthest from entry.
  // Without this, a single real S/R level far from entry (e.g. a Fib extension)
  // could land at TP1 while the closer fallback values end up at TP2/TP3,
  // producing absurd R:R ratios like 20x at TP1.
  const rawTp1 = deduped[0] ?? fallbacks[0];
  const rawTp2 = deduped[1] ?? fallbacks[1];
  const rawTp3 = deduped[2] ?? fallbacks[2];
  const sortedTps = [rawTp1, rawTp2, rawTp3]
    .sort(direction === 'long' ? (a, b) => a - b : (a, b) => b - a);
  const tp1 = parseFloat(sortedTps[0].toFixed(4));
  const tp2 = parseFloat(sortedTps[1].toFixed(4));
  const tp3 = parseFloat(sortedTps[2].toFixed(4));

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
//
// IRONCLAD ENTRY RULES
// ====================
// The strategy enters on the 2nd LOWER HIGH (shorts) or 2nd HIGHER LOW (longs),
// NOT on a lower low / higher high. Three conditions must all pass beyond the
// basic price-break check:
//
//  1. STRUCTURE  — the triggering swing point must confirm trend continuation:
//                  shorts → current swing high < previous swing high (lower high)
//                  longs  → current swing low  > previous swing low  (higher low)
//
//  2. PULLBACK   — there must be a swing point of the opposite type between the
//                  two consecutive same-direction swing points. This proves price
//                  actually made the move (swing low between two highs for shorts,
//                  swing high between two lows for longs) before pulling back to
//                  form the entry point. Without this, a tiny mid-fall rebound
//                  spike registers as a swing high and the bot enters on a lower
//                  low — chasing price already in free-fall.
//
//  3. RECENCY    — the swing point must be within MAX_ENTRY_BARS candles of the
//                  current bar. An older swing means the entry window has passed
//                  and entering now would be well into the next lower low / higher
//                  high — not at the break of the structure level.

function detectEntry(ltfCandles, htfTrend, lookback = 2) {
  const { swingHighs, swingLows } = detectSwings(ltfCandles, lookback);
  const currentPrice = ltfCandles[ltfCandles.length - 1].close;
  const atr = calcATR(ltfCandles);

  // Minimum stop distance: 0.3% of price.
  const MIN_STOP_PCT   = 0.003;
  // Maximum age of the triggering swing point (bars).
  // On 15m candles: 12 bars = 3 hours. Beyond this the entry window has passed.
  const MAX_ENTRY_BARS = 12;

  // ── Long entry: HTF bullish + 15m 2nd higher low breakout ──────────────────
  if (htfTrend === 'bull' && swingLows.length >= 2) {
    const prevSwingLow    = swingLows[swingLows.length - 2];
    const currentSwingLow = swingLows[swingLows.length - 1];

    const isHigherLow      = currentSwingLow.price > prevSwingLow.price;
    const barsSinceLow     = ltfCandles.length - 1 - currentSwingLow.index;
    const isRecent         = barsSinceLow <= MAX_ENTRY_BARS;
    const swingHighBetween = swingHighs.find(
      sh => sh.index > prevSwingLow.index && sh.index < currentSwingLow.index
    );
    const swingLowHigh      = ltfCandles[currentSwingLow.index].high;
    const breakoutConfirmed = currentPrice > swingLowHigh;

    if (isHigherLow && isRecent && swingHighBetween && breakoutConfirmed) {
      const rawStop  = currentSwingLow.price - atr * 0.5;
      const minStop  = currentPrice * (1 - MIN_STOP_PCT);
      const stopLoss = parseFloat(Math.min(rawStop, minStop).toFixed(4));
      return {
        signal:   'long',
        entry:    currentPrice,
        stopLoss,
        swingRef: currentSwingLow.price,
        reason:   `HTF bullish + 15m higher low breakout (HL ${prevSwingLow.price.toFixed(4)} → ${currentSwingLow.price.toFixed(4)}) above $${swingLowHigh.toFixed(4)}`,
      };
    }

    // Log rejection reason for diagnostics
    const reasons = [];
    if (!isHigherLow)       reasons.push(`not a higher low (${currentSwingLow.price.toFixed(4)} ≤ ${prevSwingLow.price.toFixed(4)})`);
    if (!isRecent)          reasons.push(`swing low stale (${barsSinceLow} bars ago, max ${MAX_ENTRY_BARS})`);
    if (!swingHighBetween)  reasons.push(`no swing high between the two lows — pullback not confirmed`);
    if (!breakoutConfirmed) reasons.push(`price ${currentPrice.toFixed(4)} has not broken above ${swingLowHigh.toFixed(4)}`);
    if (reasons.length)     console.log(`  ✗ Long entry blocked: ${reasons.join(' | ')}`);
  }

  // ── Short entry: HTF bearish + 15m 2nd lower high breakdown ────────────────
  if (htfTrend === 'bear' && swingHighs.length >= 2) {
    const prevSwingHigh    = swingHighs[swingHighs.length - 2];
    const currentSwingHigh = swingHighs[swingHighs.length - 1];

    const isLowerHigh       = currentSwingHigh.price < prevSwingHigh.price;
    const barsSinceHigh     = ltfCandles.length - 1 - currentSwingHigh.index;
    const isRecent          = barsSinceHigh <= MAX_ENTRY_BARS;
    const swingLowBetween   = swingLows.find(
      sl => sl.index > prevSwingHigh.index && sl.index < currentSwingHigh.index
    );
    const swingHighLow       = ltfCandles[currentSwingHigh.index].low;
    const breakdownConfirmed = currentPrice < swingHighLow;

    if (isLowerHigh && isRecent && swingLowBetween && breakdownConfirmed) {
      const rawStop  = currentSwingHigh.price + atr * 0.5;
      const maxStop  = currentPrice * (1 + MIN_STOP_PCT);
      const stopLoss = parseFloat(Math.max(rawStop, maxStop).toFixed(4));
      return {
        signal:   'short',
        entry:    currentPrice,
        stopLoss,
        swingRef: currentSwingHigh.price,
        reason:   `HTF bearish + 15m lower high breakdown (LH ${prevSwingHigh.price.toFixed(4)} → ${currentSwingHigh.price.toFixed(4)}) below $${swingHighLow.toFixed(4)}`,
      };
    }

    // Log rejection reason for diagnostics
    const reasons = [];
    if (!isLowerHigh)        reasons.push(`not a lower high (${currentSwingHigh.price.toFixed(4)} ≥ ${prevSwingHigh.price.toFixed(4)})`);
    if (!isRecent)           reasons.push(`swing high stale (${barsSinceHigh} bars ago, max ${MAX_ENTRY_BARS})`);
    if (!swingLowBetween)    reasons.push(`no swing low between the two highs — pullback not confirmed`);
    if (!breakdownConfirmed) reasons.push(`price ${currentPrice.toFixed(4)} has not broken below ${swingHighLow.toFixed(4)}`);
    if (reasons.length)      console.log(`  ✗ Short entry blocked: ${reasons.join(' | ')}`);
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
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    console.error(`  ⚠️  Non-JSON response from Bitget`);
    console.error(`     Endpoint : ${method} ${path}`);
    console.error(`     Status   : ${res.status} ${res.statusText}`);
    console.error(`     Response : ${text.slice(0, 300)}`);
    throw new Error(`Non-JSON response (${res.status}) from ${path}`);
  }
}

async function setLeverage(symbol, leverage) {
  // Bitget set-leverage returns errors as JSON (code != '00000'), not thrown exceptions.
  // Try/catch alone is not enough — must inspect result.code after each call.
  for (const holdSide of ['long', 'short']) {
    try {
      const result = await bitgetRequest('POST', '/api/v2/mix/account/set-leverage', {
        symbol, productType: 'USDT-FUTURES', marginCoin: 'USDT',
        leverage: leverage.toString(), holdSide,
      });
      if (result.code === '00000') {
        console.log(`  ✓ Leverage set to ${leverage}x (${holdSide})`);
      } else {
        console.log(`  ⚠️  set-leverage failed (${holdSide}): code=${result.code} msg="${result.msg}"`);
        console.log(`     → Check API key has "Futures > Read/Write" permission, or set leverage manually in Bitget app`);
      }
    } catch (e) {
      console.log(`  ⚠️  set-leverage network error (${holdSide}): ${e.message}`);
    }
  }
}

// ── Live Order Management ─────────────────────────────────────────────────────
// Place 3 explicit limit close orders after opening a live position. This
// implements the real 3-TP split (40/35/25%) on Bitget rather than relying on
// a single presetStopSurplusPrice which closes 100% at TP1 — making paper
// simulation and live trading actually comparable.

async function placeLimitClose(symbol, side, qty, price) {
  // Uses place-plan-order (trigger/plan order) — the only Bitget v2 endpoint that
  // successfully places pending partial close orders on hedge-mode isolated positions.
  //
  // Why not place-order?
  //   place-order returns [22002] for all parameter combinations tested. Root cause unknown
  //   but may be an API quirk for hedge+isolated positions. Plan orders bypass this.
  //
  // Why not close-positions?
  //   close-positions immediately market-closes the entire position — it is NOT a limit order.
  //
  // Plan order behaviour:
  //   When triggerPrice is reached, Bitget places a limit order at `price` to close `size`
  //   contracts. Multiple plan orders can coexist on the same position (no 1-at-a-time limit).
  //
  // CRITICAL: qty must be floored to the symbol's contract step size.
  const roundedQty = floorToStep(qty, symbol);
  if (roundedQty <= 0) {
    console.log(`  ⚠️  ${symbol} close size rounds to 0 (raw ${qty}, step ${SIZE_STEP[symbol] || 0.01}) — skipping`);
    return null;
  }
  const step = SIZE_STEP[symbol] || 0.01;
  const sDecimals = step < 0.001 ? 4 : step < 0.01 ? 3 : step < 0.1 ? 2 : step < 1 ? 1 : 0;
  const priceStr = price.toFixed(sDecimals < 4 ? 4 : sDecimals);  // at least 4dp for price

  const body = {
    symbol, productType: 'USDT-FUTURES', marginCoin: 'USDT',
    marginMode: 'isolated',
    side:         side === 'long' ? 'sell' : 'buy',  // opposite of position direction
    posSide:      side,                               // direction of the EXISTING position
    tradeSide:    'close',
    planType:     'normal_plan',
    triggerType:  'fill_price',
    triggerPrice: priceStr,
    price:        priceStr,
    orderType:    'limit',
    size:         roundedQty.toFixed(sDecimals),
  };
  const r = await bitgetRequest('POST', '/api/v2/mix/order/place-plan-order', body);
  if (r.code !== '00000') {
    console.log(`  ⚠️  Plan TP FAILED @ $${priceStr}: code=${r.code} msg="${r.msg}"`);
    console.log(`     Body: ${JSON.stringify(body)}`);
    return null;
  }
  return r.data?.orderId || null;
}

// Check if a plan (trigger) order has filled by looking in plan history.
// Query format confirmed: symbol + planType=normal_plan (no marginCoin in URL).
// Returns 'filled' | 'pending' | 'cancelled' | 'unknown'
async function getPlanOrderStatus(symbol, orderId) {
  try {
    // Check pending plan orders first (faster path)
    const pending = await bitgetRequest('GET',
      `/api/v2/mix/order/orders-plan-pending?productType=USDT-FUTURES&symbol=${symbol}&planType=normal_plan`, null);
    if (pending.code === '00000') {
      const list = pending.data?.entrustedList || [];
      if (list.some(o => o.orderId === orderId)) return 'pending';
    }
    // Not in pending — check history (filled or cancelled)
    const hist = await bitgetRequest('GET',
      `/api/v2/mix/order/orders-plan-history?productType=USDT-FUTURES&symbol=${symbol}&planType=normal_plan&limit=50`, null);
    if (hist.code === '00000') {
      const list = hist.data?.entrustedList || [];
      const found = list.find(o => o.orderId === orderId);
      if (found) return found.status === 'executed' ? 'filled' : (found.status || 'cancelled');
    }
    return 'unknown';
  } catch { return 'unknown'; }
}

// Cancel all pending plan (trigger) TP orders for a symbol.
// Called whenever a position is detected as closed — prevents stale TP orders
// from sitting on the exchange and interfering with the next entry on the same symbol.
async function cancelAllPlanOrders(symbol) {
  try {
    const r = await bitgetRequest('GET',
      `/api/v2/mix/order/orders-plan-pending?productType=USDT-FUTURES&symbol=${symbol}&planType=normal_plan`, null);
    if (r.code !== '00000') return;
    const orders = r.data?.entrustedList || [];
    if (!orders.length) return;
    console.log(`  🧹 ${symbol} — cancelling ${orders.length} stale plan order(s)…`);
    for (const o of orders) {
      const cr = await bitgetRequest('POST', '/api/v2/mix/order/cancel-plan-order', {
        symbol, productType: 'USDT-FUTURES', marginCoin: 'USDT', orderId: o.orderId,
      });
      if (cr.code === '00000') {
        console.log(`     Cancelled plan order @ trigger $${o.triggerPrice} (${o.size} contracts)`);
      } else {
        console.log(`     Cancel failed for ${o.orderId}: ${cr.code} ${cr.msg}`);
      }
      await new Promise(res => setTimeout(res, 200));
    }
  } catch (e) {
    console.log(`  ⚠️  cancelAllPlanOrders(${symbol}): ${e.message}`);
  }
}

async function getOrderDetail(symbol, orderId) {
  try {
    const r = await bitgetRequest('GET',
      `/api/v2/mix/order/detail?symbol=${symbol}&productType=USDT-FUTURES&orderId=${orderId}`, null);
    if (r.code !== '00000') return null;
    return r.data;
  } catch { return null; }
}

// Set (or replace) the position-level stop loss via the TPSL endpoint.
// Called automatically when TP1 or TP2 fills to trail the stop.
async function setPositionSL(symbol, holdSide, triggerPrice) {
  const body = {
    symbol, productType: 'USDT-FUTURES', marginCoin: 'USDT',
    holdSide,
    triggerPrice: triggerPrice.toString(),
    tpslType: 'sl',
  };
  const r = await bitgetRequest('POST', '/api/v2/mix/order/place-tpsl', body);
  if (r.code !== '00000') {
    console.log(`  ⚠️  SL move FAILED to $${triggerPrice}: code=${r.code} msg="${r.msg}"`);
    return null;
  }
  console.log(`  ✅ SL moved to $${triggerPrice}`);
  return r.data?.orderId || null;
}

// ── Live Position Monitoring via Bitget API ───────────────────────────────────
// Candle simulation is only valid for paper trades (no real exchange to check).
// For live trades, Bitget manages the actual SL/TP orders. We query:
//   a) all-position  → is the position still open?
//   b) TP order detail → has TP1/TP2 filled so we can trail the SL?
//   c) position/history → actual exit price and P&L when fully closed?

async function fetchAllBitgetPositions() {
  try {
    const result = await bitgetRequest('GET',
      '/api/v2/mix/position/all-position?productType=USDT-FUTURES&marginCoin=USDT', null);
    if (result.code === '00000') return result.data || [];
    if (result.code === '40014') {
      // Read permission not enabled on this API key. Trade permission (for orders) is a
      // separate toggle from Read (for positions/balances) in Bitget API Management.
      // Without Read, the bot cannot detect when Bitget's SL/TP closes a live position.
      console.log('  ⚠️  all-position returned code 40014 — API key missing "Read" permission');
      console.log('      → Bitget app → Profile → API Management → Edit key → tick "Read" → Save');
      console.log('      → Until fixed, SL/TP auto-detection is limited (positions stay open in tracker)');
      return 'NO_READ_PERMISSION'; // Sentinel — triggers TPSL fallback in checkPositions
    }
    console.log(`  ⚠️  all-position: code=${result.code} msg="${result.msg}"`);
    return null; // null = unexpected error — don't touch live positions this run
  } catch (e) {
    console.log(`  ⚠️  fetchAllBitgetPositions: ${e.message}`);
    return null;
  }
}

// Partial fallback when Read permission is unavailable: check for any pending
// limit-close orders (TP1/TP2/TP3) on the symbol via orders-pending endpoint
// (Trade permission only). Returns true if any such orders exist, null if the
// call fails, false if the call succeeded but no pending orders found.
// NOTE: a position can be open with no pending orders (if TP orders were never
// placed or if only a position-level SL is set), so false is inconclusive.
async function fetchPendingOrders(symbol) {
  try {
    const r = await bitgetRequest('GET',
      `/api/v2/mix/order/orders-pending?productType=USDT-FUTURES&symbol=${symbol}&marginCoin=USDT`, null);
    if (r.code !== '00000') return null;
    const list = r.data?.entrustedList;
    return Array.isArray(list) && list.length > 0;
  } catch { return null; }
}

async function fetchBitgetPositionHistory(symbol) {
  try {
    const result = await bitgetRequest('GET',
      `/api/v2/mix/position/history?productType=USDT-FUTURES&symbol=${symbol}&limit=20`, null);
    if (result.code !== '00000') return [];
    return result.data?.list || (Array.isArray(result.data) ? result.data : []);
  } catch { return []; }
}

// Try to match a close price to a known SL or TP level (within 0.5% tolerance).
function inferExitLevel(pos, closePrice) {
  const near = (a, b) => b > 0 && Math.abs(a - b) / b < 0.005;
  if (near(closePrice, pos.stopLoss)) return 'sl';
  if (pos.tp3 && near(closePrice, pos.tp3)) return 'tp3';
  if (pos.tp2 && near(closePrice, pos.tp2)) return 'tp2';
  if (pos.tp1 && near(closePrice, pos.tp1)) return 'tp1';
  return null; // unknown — caller falls back to P&L sign
}

async function placeOrder(symbol, side, quantity, entry, stopLoss, tp1, tp2, tp3) {
  if (CONFIG.paperTrading) {
    console.log(`  [IRONCLAD PAPER ${CONFIG.leverage}x] ${side.toUpperCase()} ${quantity} ${symbol} @ $${entry}`);
    console.log(`  SL: $${stopLoss}  TP1: $${tp1}  TP2: $${tp2}  TP3: $${tp3}  (40/35/25% split simulated)`);
    return { orderId: 'IRONCLAD-PAPER-' + Date.now() };
  }

  await setLeverage(symbol, CONFIG.leverage);

  // Step 1: Open with market order + SL only.
  // presetStopSurplusPrice is intentionally OMITTED — it closes 100% at TP1.
  // Instead we place 3 explicit limit close orders below so the real 3-TP split
  // (40/35/25%) matches the paper simulation and is comparable.
  const body = {
    symbol, productType: 'USDT-FUTURES', marginCoin: 'USDT',
    marginMode: 'isolated',
    leverage:   CONFIG.leverage.toString(),
    side:      side === 'long' ? 'buy' : 'sell',
    tradeSide: 'open',
    orderType: 'market', size: quantity.toString(),
    presetStopLossPrice: stopLoss.toString(),
  };
  const result = await bitgetRequest('POST', '/api/v2/mix/order/place-order', body);
  if (result.code !== '00000') {
    console.log(`  ⚠️  Order FAILED for ${symbol}: code=${result.code} msg="${result.msg}"`);
    console.log(`     Body sent: ${JSON.stringify(body)}`);
    return result;
  }

  const orderId = result.data?.orderId;
  console.log(`  ✅ Order placed: ${symbol} ${side.toUpperCase()} — orderId: ${orderId}`);

  // Step 2: Fetch actual fill price before placing TP orders.
  // Market fills can differ from the signal entry price; using the wrong price
  // causes TPs to land on the wrong side of entry (e.g. TP1 below entry for a long).
  await new Promise(r => setTimeout(r, 3000)); // wait for fill to settle
  let fillPrice = entry; // fallback to signal price
  let fillQty   = quantity;
  const fillDetail = await getOrderDetail(symbol, orderId);
  if (fillDetail?.priceAvg && parseFloat(fillDetail.priceAvg) > 0) {
    fillPrice = parseFloat(fillDetail.priceAvg);
    if (fillDetail.size && parseFloat(fillDetail.size) > 0) fillQty = parseFloat(fillDetail.size);
    console.log(`  📊 Fill price: $${fillPrice}${fillPrice !== entry ? ` (signal was $${entry})` : ''}`);
  }

  // Validate TPs against the actual fill price — replace any that sit on the wrong
  // side of entry (stale S/R level calculated before the fill was known).
  const risk      = Math.abs(fillPrice - stopLoss);
  const isLong    = side === 'long';
  const validFor  = p => isLong ? p > fillPrice * 1.001 : p < fillPrice * 0.999;
  const fallback  = (mult) => isLong ? fillPrice + risk * mult : fillPrice - risk * mult;
  const fixedTp1  = validFor(tp1) ? tp1 : parseFloat(fallback(1.5).toFixed(4));
  const fixedTp2  = validFor(tp2) ? tp2 : parseFloat(fallback(2.5).toFixed(4));
  const fixedTp3  = validFor(tp3) ? tp3 : parseFloat(fallback(4.0).toFixed(4));
  if (fixedTp1 !== tp1) console.log(`  ⚠️  TP1 corrected: ${tp1} → ${fixedTp1} (was wrong side of fill price)`);
  if (fixedTp2 !== tp2) console.log(`  ⚠️  TP2 corrected: ${tp2} → ${fixedTp2}`);
  if (fixedTp3 !== tp3) console.log(`  ⚠️  TP3 corrected: ${tp3} → ${fixedTp3}`);

  // Step 3: Place 3 limit close orders (40% / 35% / 25% split).
  // Floor to contract step size — fractional sizes (e.g. 53.6 for XRP step=1)
  // cause [22002] "No position to close" on Bitget even when the position is open.
  const qty40 = floorToStep(fillQty * 0.40, symbol);
  const qty35 = floorToStep(fillQty * 0.35, symbol);
  const qty25 = floorToStep(Math.max(0, fillQty - qty40 - qty35), symbol);

  console.log(`  Placing 3-TP limit closes: ${qty40}@$${fixedTp1} / ${qty35}@$${fixedTp2} / ${qty25}@$${fixedTp3}`);

  // Place sequentially — Bitget only allows one pending close order per position
  // at a time; parallel placement causes [22002] errors on the 2nd and 3rd orders.
  const tp1OrderId = await placeLimitClose(symbol, side, qty40, fixedTp1);
  await new Promise(r => setTimeout(r, 2000));
  const tp2OrderId = await placeLimitClose(symbol, side, qty35, fixedTp2);
  await new Promise(r => setTimeout(r, 2000));
  const tp3OrderId = await placeLimitClose(symbol, side, qty25, fixedTp3);

  if (tp1OrderId) console.log(`  ✅ TP1 limit close: ${tp1OrderId}`);
  if (tp2OrderId) console.log(`  ✅ TP2 limit close: ${tp2OrderId}`);
  if (tp3OrderId) console.log(`  ✅ TP3 limit close: ${tp3OrderId}`);
  if (!tp1OrderId || !tp2OrderId || !tp3OrderId) {
    console.log(`  ⚠️  Some TP limit closes failed — check manually on Bitget`);
  }

  return { orderId, tp1OrderId, tp2OrderId, tp3OrderId,
           fillPrice, fillQty, fixedTp1, fixedTp2, fixedTp3 };
}

// ── Position Sizing ───────────────────────────────────────────────────────────

function calcQuantity(entry, stopLoss) {
  const riskUsd     = CONFIG.portfolioUsd * 0.01;                      // 1% of account at risk per trade
  const maxTradeUsd = CONFIG.portfolioUsd * CONFIG.maxTradePct;         // notional cap scales with account (compounding-ready)
  const stopDist    = Math.abs(entry - stopLoss);
  const stopDistPct = stopDist / entry;
  const effectiveRisk = stopDistPct * CONFIG.leverage;                  // leverage multiplies the stop's impact on equity
  const sizeUsd     = Math.min(riskUsd / effectiveRisk, maxTradeUsd);
  return parseFloat((sizeUsd / entry).toFixed(6));
}

// ── Paper Position Monitor ────────────────────────────────────────────────────
// Tracks open paper positions between bot runs using candle OHLC data.
// On each run it walks 15m candles since the position was opened and detects
// the first SL or TP breach — simulating the 3-TP split management plan:
//   TP1 → close 40%, move SL to break-even
//   TP2 → close 35%, trail SL to TP1 price
//   TP3 → close final 25%, position fully closed
// Results are written to closed-positions-ironclad.json for the dashboard
// to use as locked-in realized P&L (no longer changes with the market).

function loadOpenPositions() {
  try {
    if (fs.existsSync(POSITIONS_PATH)) return JSON.parse(fs.readFileSync(POSITIONS_PATH, 'utf8'));
  } catch {}
  return [];
}

function saveOpenPositions(positions) {
  fs.writeFileSync(POSITIONS_PATH, JSON.stringify(positions, null, 2));
}

function loadClosedPositions() {
  try {
    if (fs.existsSync(CLOSED_PATH)) return JSON.parse(fs.readFileSync(CLOSED_PATH, 'utf8'));
  } catch {}
  return [];
}

function saveClosedPositions(positions) {
  // LOCK PROTECTION: any entry with locked:true was manually verified against
  // real Bitget export data and must never be overwritten by the bot.
  // Merge: start from the existing file's locked entries, overlay new data.
  let locked = {};
  try {
    const existing = JSON.parse(fs.readFileSync(CLOSED_PATH, 'utf8'));
    for (const p of existing) {
      if (p.locked) locked[p.id] = p;
    }
  } catch {}
  const merged = positions.map(p => locked[p.id] || p);   // prefer locked version
  // Also preserve any locked entries that aren't in the new list (shouldn't happen, but safety net)
  for (const id of Object.keys(locked)) {
    if (!merged.find(p => p.id === id)) merged.push(locked[id]);
  }
  fs.writeFileSync(CLOSED_PATH, JSON.stringify(merged, null, 2));
}

// First-run bootstrap: seeds open-positions-ironclad.json from the CSV so
// all historical trades are immediately tracked without manual entry.
function bootstrapFromCsv() {
  if (fs.existsSync(POSITIONS_PATH)) return;   // Already initialised

  console.log('  Bootstrapping open positions from trades CSV (first run)...');
  const closedIds = new Set(loadClosedPositions().map(p => p.id));

  try {
    const lines   = fs.readFileSync(TRADES_PATH, 'utf8').trim().split('\n');
    const headers = lines[0].split(',').map(h =>
      h.trim().toLowerCase().replace(/[→\s]+/g, '_').replace(/[^a-z0-9_]/g, '')
    );

    const positions = lines.slice(1)
      .map(line => {
        const vals = line.split(',');
        const r    = {};
        headers.forEach((h, i) => { r[h] = vals[i]?.trim() ?? ''; });
        return r;
      })
      .filter(r => {
        // Only rows with enough data to monitor — need entry, SL, and at least TP1
        const id    = r.order_id || '';
        const entry = parseFloat(r.entry_price) || 0;
        const sl    = parseFloat(r.stop_loss)   || 0;
        const tp1   = parseFloat(r.tp1)         || 0;
        return id && entry > 0 && sl > 0 && tp1 > 0 && !closedIds.has(id);
      })
      .map(r => {
        const entry = parseFloat(r.entry_price);
        const sl    = parseFloat(r.stop_loss);
        return {
          id:            r.order_id,
          symbol:        r.symbol,
          side:          r.side,
          entry,
          stopLoss:      sl,
          tp1:           parseFloat(r.tp1) || null,
          tp2:           parseFloat(r.tp2) || null,
          tp3:           parseFloat(r.tp3) || null,
          qty:           parseFloat(r.quantity),
          totalUsd:      parseFloat(r.total_usd),
          openDate:      r.date,
          openTime:      r.time,
          strategy:      r.strategy,
          // Mutable state — updated as TPs are partially hit
          tp1Hit:        false,
          tp2Hit:        false,
          currentSl:     sl,       // Starts at original SL; moves to BE after TP1, TP1 after TP2
          partialCloses: [],       // Locked-in partial exits so far
        };
      });

    saveOpenPositions(positions);
    console.log(`  Bootstrapped ${positions.length} open position(s) from CSV`);
  } catch (err) {
    console.log(`  Bootstrap error: ${err.message}`);
    saveOpenPositions([]);
  }
}

// Register a newly placed trade as an open position.
function addOpenPosition(pos) {
  const open = loadOpenPositions();
  if (open.some(p => p.id === pos.id)) return; // No duplicates
  open.push({
    ...pos,
    tp1Hit:        false,
    tp2Hit:        false,
    currentSl:     pos.stopLoss,
    partialCloses: [],
  });
  saveOpenPositions(open);
}

// Walk candles through a position's lifecycle, simulating the 3-TP split plan.
// Returns the updated mutable state and whether the position is now fully closed.
// Convention: on a candle where both SL and TP can be reached, SL is checked
// first (pessimistic / realistic for worst-case backtesting).
function simulatePosition(pos, candles) {
  let { currentSl, tp1Hit, tp2Hit, partialCloses } = pos;
  partialCloses = [...partialCloses]; // Clone — don't mutate original

  const SPLITS   = [0.40, 0.35, 0.25]; // Position fraction closed at TP1, TP2, TP3
  const LEVERAGE = CONFIG.leverage;
  let remaining  = 1.0;
  if (tp1Hit) remaining -= SPLITS[0];
  if (tp2Hit) remaining -= SPLITS[1];

  let fullyExited = false;

  for (const c of candles) {
    const cDate = new Date(c.time).toISOString().slice(0, 10);
    const cTime = new Date(c.time).toISOString().slice(11, 19);

    if (pos.side === 'long') {

      // 1. SL check (pessimistic — checked before TP on same candle)
      if (c.low <= currentSl) {
        const pnl = (currentSl - pos.entry) * pos.qty * remaining * LEVERAGE;
        partialCloses.push({ price: currentSl, level: 'sl', date: cDate, time: cTime, pnl });
        remaining   = 0;
        fullyExited = true;
        break;
      }

      // 2. TP1 — close 40%, move SL to break-even
      if (!tp1Hit && pos.tp1 && c.high >= pos.tp1) {
        const pnl = (pos.tp1 - pos.entry) * pos.qty * SPLITS[0] * LEVERAGE;
        partialCloses.push({ price: pos.tp1, level: 'tp1', date: cDate, time: cTime, pnl });
        tp1Hit     = true;
        remaining -= SPLITS[0];
        currentSl  = pos.entry; // SL → break-even
      }

      // 3. TP2 — close 35%, trail SL to TP1
      if (tp1Hit && !tp2Hit && pos.tp2 && c.high >= pos.tp2) {
        const pnl = (pos.tp2 - pos.entry) * pos.qty * SPLITS[1] * LEVERAGE;
        partialCloses.push({ price: pos.tp2, level: 'tp2', date: cDate, time: cTime, pnl });
        tp2Hit     = true;
        remaining -= SPLITS[1];
        currentSl  = pos.tp1; // SL → TP1 (lock in some profit)
      }

      // 4. TP3 — close final 25%, fully exited
      if (tp2Hit && pos.tp3 && c.high >= pos.tp3) {
        const pnl = (pos.tp3 - pos.entry) * pos.qty * SPLITS[2] * LEVERAGE;
        partialCloses.push({ price: pos.tp3, level: 'tp3', date: cDate, time: cTime, pnl });
        remaining   = 0;
        fullyExited = true;
        break;
      }

    } else { // short

      if (c.high >= currentSl) {
        const pnl = (pos.entry - currentSl) * pos.qty * remaining * LEVERAGE;
        partialCloses.push({ price: currentSl, level: 'sl', date: cDate, time: cTime, pnl });
        remaining   = 0;
        fullyExited = true;
        break;
      }

      if (!tp1Hit && pos.tp1 && c.low <= pos.tp1) {
        const pnl = (pos.entry - pos.tp1) * pos.qty * SPLITS[0] * LEVERAGE;
        partialCloses.push({ price: pos.tp1, level: 'tp1', date: cDate, time: cTime, pnl });
        tp1Hit     = true;
        remaining -= SPLITS[0];
        currentSl  = pos.entry;
      }

      if (tp1Hit && !tp2Hit && pos.tp2 && c.low <= pos.tp2) {
        const pnl = (pos.entry - pos.tp2) * pos.qty * SPLITS[1] * LEVERAGE;
        partialCloses.push({ price: pos.tp2, level: 'tp2', date: cDate, time: cTime, pnl });
        tp2Hit     = true;
        remaining -= SPLITS[1];
        currentSl  = pos.tp1;
      }

      if (tp2Hit && pos.tp3 && c.low <= pos.tp3) {
        const pnl = (pos.entry - pos.tp3) * pos.qty * SPLITS[2] * LEVERAGE;
        partialCloses.push({ price: pos.tp3, level: 'tp3', date: cDate, time: cTime, pnl });
        remaining   = 0;
        fullyExited = true;
        break;
      }
    }
  }

  const realizedPnl = parseFloat(
    partialCloses.reduce((sum, c) => sum + c.pnl, 0).toFixed(2)
  );
  const lastClose   = partialCloses[partialCloses.length - 1] || null;

  return { fullyExited, tp1Hit, tp2Hit, currentSl, partialCloses, realizedPnl, lastClose, remaining };
}

async function checkPositions() {
  bootstrapFromCsv();

  const openPositions   = loadOpenPositions();
  const closedPositions = loadClosedPositions();

  if (!openPositions.length) {
    console.log('\n── Position Monitor: No open positions ──');
    return;
  }

  // Distinguish live vs paper by ID prefix. Live IDs are Bitget numeric strings;
  // paper IDs always start with 'IRONCLAD-PAPER-'.
  const isPaper = p => !p.id || p.id.startsWith('IRONCLAD-PAPER') || p.mode === 'paper';
  const livePos  = openPositions.filter(p => !isPaper(p));
  const paperPos = openPositions.filter(p =>  isPaper(p));

  console.log(`\n── Position Monitor: ${livePos.length} live + ${paperPos.length} paper open ──`);

  const stillOpen = [];

  // ── LIVE: check actual Bitget position status ─────────────────────────────
  // Bitget manages real SL/TP orders. Candle simulation is NOT used — a candle
  // wick touching a level ≠ Bitget's order actually filling.
  if (livePos.length) {
    const bitgetAll = await fetchAllBitgetPositions();

    if (bitgetAll === null) {
      // API unreachable — don't touch live positions this run to avoid false closures
      console.log('  ⚠️  Bitget API unavailable — live positions unchanged this run');
      stillOpen.push(...livePos);
    } else if (bitgetAll === 'NO_READ_PERMISSION') {
      // "future pos read" permission not enabled on this API key (Bitget code 40014).
      // Without Read, position status cannot be determined reliably.
      // Fallback: orders-pending (Trade permission) can confirm a position is open
      // IF it has pending limit-close TP orders. If not, we stay defensive.
      const bySymbol = {};
      for (const pos of livePos) {
        (bySymbol[pos.symbol] = bySymbol[pos.symbol] || []).push(pos);
      }
      for (const [symbol, group] of Object.entries(bySymbol)) {
        const hasPending = await fetchPendingOrders(symbol);
        if (hasPending === true) {
          console.log(`  ⏳ ${symbol} LIVE — pending limit-close order(s) found → position active on Bitget`);
        } else {
          // No pending orders ≠ position closed — could just mean TP orders weren't placed.
          // Keep open defensively. Fix: enable "Read" on the API key.
          console.log(`  ⚠️  ${symbol} LIVE — cannot verify position status (no "Read" permission)`);
          console.log('         → Bitget → Profile → API Management → Edit key → enable Read → Save');
        }
        stillOpen.push(...group); // Always keep open without Read (never false-close a live trade)
      }
    } else {
      // Normalise Bitget symbol names (strip _UMCBL suffix if present)
      const bitgetBySymbol = {};
      for (const bp of bitgetAll) {
        const sym = bp.symbol?.replace(/_UMCBL$|_SPBL$/, '');
        if (sym) bitgetBySymbol[sym] = bp;
      }

      // Group our tracked positions by symbol — Bitget merges same-symbol orders
      const bySymbol = {};
      for (const pos of livePos) {
        (bySymbol[pos.symbol] = bySymbol[pos.symbol] || []).push(pos);
      }

      for (const [symbol, group] of Object.entries(bySymbol)) {
        const bp = bitgetBySymbol[symbol];

        if (bp) {
          // Still open on Bitget ✓ — check TP order fills and trail SL
          const unreal = parseFloat(bp.unrealizedPL || 0);
          const size   = parseFloat(bp.total || bp.available || 0);
          console.log(`  ⏳ ${symbol} LIVE — open on Bitget (size ${size.toFixed(4)}, unrealized ${unreal >= 0 ? '+' : ''}$${unreal.toFixed(2)})`);

          // For each position in this symbol group, check if any TP limit orders have filled
          // and automatically trail the stop loss (BE after TP1, TP1-price after TP2).
          const updatedGroup = [];
          for (const pos of group) {
            let updated = { ...pos };
            const holdSide = pos.side === 'long' ? 'long' : 'short';
            const now8601  = new Date().toISOString();
            const nowDate  = now8601.slice(0, 10);
            const nowTime  = now8601.slice(11, 19);

            // ── TP1 fill check ─────────────────────────────────────────────────
            if (!updated.tp1Hit && updated.tp1OrderId) {
              const status = await getPlanOrderStatus(symbol, updated.tp1OrderId);
              if (status === 'filled') {
                const fillPrice = pos.tp1; // plan order executes at trigger price
                const pnlPart   = (pos.side === 'long' ? 1 : -1) *
                  (fillPrice - pos.entry) * (pos.qty * 0.40);
                const partials  = [...(updated.partialCloses || []),
                  { price: fillPrice, level: 'tp1', date: nowDate, time: nowTime, pnl: parseFloat(pnlPart.toFixed(4)) }
                ];
                console.log(`  ✅ ${symbol} TP1 filled @ $${fillPrice} — SL → break-even ($${pos.entry})`);
                updated = { ...updated, tp1Hit: true, currentSl: pos.entry, partialCloses: partials };
                // Move the exchange SL to break-even
                await setPositionSL(symbol, holdSide, pos.entry);
                // Plan orders support multiple pending at once — TP2/TP3 are already placed.
                // (No need to place TP2 here; it was already placed alongside TP1.)
              }
            } else if (!updated.tp1Hit && !updated.tp1OrderId && updated.tp1) {
              // TP1 was never placed (initial placement failed) — try again now.
              console.log(`  🔄 ${symbol} TP1 missing — attempting placement…`);
              const qty40 = floorToStep(pos.qty * 0.40, symbol);
              if (qty40 > 0) {
                const tp1Id = await placeLimitClose(symbol, pos.side, qty40, pos.tp1);
                if (tp1Id) {
                  console.log(`  ✅ ${symbol} TP1 placed on retry: ${tp1Id}`);
                  updated.tp1OrderId = tp1Id;
                }
              }
            }

            // ── TP2 fill check ─────────────────────────────────────────────────
            // Plan orders can all be pending simultaneously, so check TP2 independently.
            if (!updated.tp2Hit && updated.tp2OrderId) {
              const status = await getPlanOrderStatus(symbol, updated.tp2OrderId);
              if (status === 'filled') {
                const fillPrice = pos.tp2;
                const pnlPart   = (pos.side === 'long' ? 1 : -1) *
                  (fillPrice - pos.entry) * (pos.qty * 0.35);
                const partials  = [...(updated.partialCloses || []),
                  { price: fillPrice, level: 'tp2', date: nowDate, time: nowTime, pnl: parseFloat(pnlPart.toFixed(4)) }
                ];
                console.log(`  ✅ ${symbol} TP2 filled @ $${fillPrice} — SL → TP1 ($${pos.tp1})`);
                updated = { ...updated, tp2Hit: true, currentSl: pos.tp1, partialCloses: partials };
                // Trail the exchange SL to TP1 price (locks in profit on remaining 25%)
                await setPositionSL(symbol, holdSide, pos.tp1);
              }
            } else if (!updated.tp2Hit && !updated.tp2OrderId && updated.tp2) {
              // TP2 missing — try to place
              console.log(`  🔄 ${symbol} TP2 missing — attempting placement…`);
              const qty35 = floorToStep(pos.qty * 0.35, symbol);
              if (qty35 > 0) {
                const tp2Id = await placeLimitClose(symbol, pos.side, qty35, pos.tp2);
                if (tp2Id) { updated.tp2OrderId = tp2Id; console.log(`  ✅ ${symbol} TP2 placed: ${tp2Id}`); }
              }
            }

            updatedGroup.push(updated);
          }
          stillOpen.push(...updatedGroup);

        } else {
          // Gone from Bitget — closed by SL, TP, or manual close.
          // Cancel any stale plan (TP) orders immediately so they don't persist
          // into the next entry on the same symbol with wrong price targets.
          await cancelAllPlanOrders(symbol);
          console.log(`  🔍 ${symbol} — no longer open on Bitget, fetching history…`);
          const history = await fetchBitgetPositionHistory(symbol);

          // Find the matching close (opened after our earliest tracked open time)
          const earliestOpenTs = Math.min(...group.map(p =>
            new Date(`${p.openDate}T${p.openTime}Z`).getTime()
          ));
          const match = history.find(h => parseInt(h.closeTime || 0) > earliestOpenTs)
                     || history[0]
                     || null;

          // Total qty across all entries for this symbol (needed to apportion P&L)
          const totalQty = group.reduce((s, p) => s + (p.qty || 0), 0);

          for (const pos of group) {
            let realizedPnl, exitPrice, exitLevel, closeDate, closeTime, outcome;

            if (match) {
              const rawPnl = parseFloat(match.pnl || match.netProfit || 0);
              // Apportion P&L proportionally when multiple entries exist for the symbol
              realizedPnl = parseFloat((rawPnl * (pos.qty / totalQty)).toFixed(4));
              exitPrice   = parseFloat(match.closeAvgPrice || 0);
              const closeTs = parseInt(match.closeTime || Date.now());
              closeDate   = new Date(closeTs).toISOString().slice(0, 10);
              closeTime   = new Date(closeTs).toISOString().slice(11, 19);
              exitLevel   = inferExitLevel(pos, exitPrice) || (realizedPnl >= 0 ? 'tp1' : 'sl');
              outcome     = realizedPnl >= 0 ? 'WIN' : 'LOSS';
            } else {
              // History not found — position closed too recently, Bitget history hasn't settled.
              // Record as LOSS and apply cooldown: it's far more likely a stop-out than all 3
              // TPs filling silently. Without cooldown, the bot immediately re-enters the same
              // losing setup — compounding the drawdown.
              realizedPnl = 0;
              exitPrice   = 0;
              exitLevel   = 'unknown';
              closeDate   = new Date().toISOString().slice(0, 10);
              closeTime   = new Date().toISOString().slice(11, 19);
              outcome     = 'LOSS'; // Assume loss until history confirms otherwise
            }

            closedPositions.push({
              ...pos,
              realizedPnl,
              exitLevel,
              exitPrice,
              closeDate,
              closeTime,
              outcome,
              source: match ? 'bitget' : 'bitget-nohistory',
            });

            const icon   = outcome === 'WIN' ? '✅' : outcome === 'LOSS' ? '❌' : '❓';
            const pnlStr = exitPrice
              ? ` · exit $${exitPrice} · P&L: ${realizedPnl >= 0 ? '+' : ''}$${Math.abs(realizedPnl).toFixed(2)} (Bitget)`
              : ' · P&L unknown (assuming stop-out — cooldown applied)';
            console.log(`  ${icon} ${pos.symbol} ${pos.side} ${outcome}${pnlStr}`);

            // ALWAYS apply cooldown when a position disappears from Bitget:
            // - LOSS: definitely a stop-out → cooldown prevents chasing
            // - History not found: almost certainly a stop-out (TPs fill gradually, SL fires instantly)
            // This was the root cause of the 3× JUP re-entry: UNKNOWN skipped cooldown.
            if (outcome === 'LOSS' || exitLevel === 'unknown') setCooldown(pos.symbol);
          }
        }
      }
    }
  }

  // ── PAPER: candle simulation ──────────────────────────────────────────────
  // No real exchange — walk OHLC candles to detect SL/TP hits. Tracks the
  // 3-TP split plan: 40% at TP1 (SL→BE), 35% at TP2 (SL→TP1), 25% at TP3.
  for (const pos of paperPos) {
    process.stdout.write(`  ▶ ${pos.symbol} ${pos.side.toUpperCase()} @ $${pos.entry} (${pos.openDate}) … `);

    let candles;
    try {
      candles = await fetchCandles(pos.symbol, '15m', 500);
    } catch (err) {
      console.log(`candles unavailable (${err.message}) — skipping`);
      stillOpen.push(pos);
      continue;
    }

    const openTs   = new Date(`${pos.openDate}T${pos.openTime}Z`).getTime();
    const relevant = candles.filter(c => c.time > openTs);

    if (!relevant.length) {
      console.log('no new candles yet');
      stillOpen.push(pos);
      continue;
    }

    const result = simulatePosition(pos, relevant);

    if (!result.fullyExited) {
      stillOpen.push({
        ...pos,
        tp1Hit:        result.tp1Hit,
        tp2Hit:        result.tp2Hit,
        currentSl:     result.currentSl,
        partialCloses: result.partialCloses,
      });

      const progress = result.tp2Hit ? '2/3 TPs hit'
                     : result.tp1Hit ? '1/3 TPs hit'
                     : 'awaiting TP1/SL';
      const slLabel  = result.tp2Hit ? `$${pos.tp1} (trailing)` :
                       result.tp1Hit ? `$${pos.entry} (B/E)` :
                       `$${pos.stopLoss}`;
      console.log(`still open [${progress}] SL→${slLabel}`);

    } else {
      const lastClose = result.lastClose;
      const outcome   = result.partialCloses.some(c => c.level !== 'sl') ? 'WIN'
                      : result.partialCloses.every(c => c.level === 'sl') ? 'LOSS'
                      : 'BE';

      closedPositions.push({
        ...pos,
        tp1Hit:        result.tp1Hit,
        tp2Hit:        result.tp2Hit,
        partialCloses: result.partialCloses,
        realizedPnl:   result.realizedPnl,
        exitLevel:     lastClose.level,
        exitPrice:     lastClose.price,
        closeDate:     lastClose.date,
        closeTime:     lastClose.time,
        outcome,
      });

      const icon = outcome === 'WIN' ? '✅' : outcome === 'BE' ? '🟡' : '❌';
      console.log(`${icon} ${outcome} — last exit ${lastClose.level.toUpperCase()} @ $${lastClose.price} · P&L: ${result.realizedPnl >= 0 ? '+' : ''}$${result.realizedPnl}`);

      if (outcome === 'LOSS') setCooldown(pos.symbol);
    }
  }

  const numClosed = openPositions.length - stillOpen.length;
  saveOpenPositions(stillOpen);
  saveClosedPositions(closedPositions);
  console.log(`  ── ${numClosed} closed this run, ${stillOpen.length} still open ──`);

  // ── Immediate dashboard rebuild when any position closes ──────────────────
  // Don't wait for the twice-daily GitHub Actions run — rebuild right now so
  // the dashboard shows actual exit prices and P&L within seconds of close.
  if (numClosed > 0) {
    console.log(`\n  📊 Rebuilding dashboard immediately (${numClosed} position(s) closed)...`);
    try {
      execSync('node research.js', { stdio: 'inherit', timeout: 60000 });
      console.log(`  ✅ Dashboard rebuilt — closed positions now showing correct exit prices`);
    } catch (e) {
      console.log(`  ⚠️  Dashboard rebuild failed: ${e.message}`);
      console.log(`     Dashboard will update on next scheduled research run (8am/5pm UTC)`);
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  const rules        = loadRules();
  const researchData = loadResearchSignals();

  console.log(`\n══ IRONCLAD Bot run ${new Date().toISOString()} ══`);

  // ── Pause check — set paused:true in rules-ironclad.json to hold all new entries ─
  if (rules.paused) {
    console.log(`⏸  PAUSED — bot is on hold. No new entries will be placed.`);
    console.log(`   Reason: ${rules.pause_reason || 'manually paused'}`);
    console.log(`   Existing positions will continue to be monitored.`);
    await checkPositions();
    return;
  }

  // ── Step 0: Check open paper positions before scanning for new entries ────────
  await checkPositions();
  console.log(`Strategy  : ${rules.strategy}`);
  console.log(`HTF       : ${rules.timeframes.htf}  LTF: ${rules.timeframes.ltf}`);
  console.log(`Leverage  : ${CONFIG.leverage}x  Paper: ${CONFIG.paperTrading}`);
  console.log(`Sizing    : ${(CONFIG.maxTradePct * 100).toFixed(0)}% notional cap = $${(CONFIG.portfolioUsd * CONFIG.maxTradePct).toFixed(0)} max / ~$${(CONFIG.portfolioUsd * CONFIG.maxTradePct / CONFIG.leverage).toFixed(0)} margin per trade`);
  console.log(`Symbols   : ${SYMBOLS.length} pairs`);
  console.log(`Research  : ${researchData ? `${researchData.signals.length} signals loaded` : 'No signal file — technicals only'}`);
  console.log(`─`.repeat(60));

  // ── Daily drawdown circuit-breaker ────────────────────────────────────────
  const drawdown = checkDailyDrawdown();
  console.log(`Daily P&L : ${drawdown.todayPnl >= 0 ? '+' : ''}$${drawdown.todayPnl}  (limit: -$${CONFIG.maxDailyLossUsd})`);
  if (drawdown.breached) {
    console.log(`\n🛑 DAILY DRAWDOWN LIMIT HIT — today's losses: $${drawdown.todayPnl}`);
    console.log(`   No new entries for the rest of today. Trading resumes tomorrow.`);
    return;
  }

  // ── Economic event blackout check ─────────────────────────────────────────
  const blackout = checkEconomicBlackout(researchData);
  if (blackout) {
    console.log(`\n⚠️  ECONOMIC BLACKOUT — ${blackout.event} (${blackout.label})`);
    console.log(`   No new entries placed. Bot will resume after the 60-minute window.`);
    console.log(`   Event time: ${blackout.datetime}`);
    return;
  }

  // ── Pre-scan: fetch live Bitget positions as a hard guard against duplicate entries ──
  // The tracker file can be stale if checkPositions couldn't determine P&L.
  // This real-time check prevents opening a position while one already exists on exchange.
  let liveSymbolsOnBitget = new Set();
  if (!CONFIG.paperTrading) {
    try {
      const liveAll = await fetchAllBitgetPositions();
      if (Array.isArray(liveAll)) {
        for (const bp of liveAll) {
          if (parseFloat(bp.total) > 0) {
            const sym = bp.symbol?.replace(/_UMCBL$|_SPBL$/, '');
            if (sym) liveSymbolsOnBitget.add(sym);
          }
        }
        console.log(`Live on Bitget: ${[...liveSymbolsOnBitget].join(', ') || 'none'}`);
      }
    } catch {}
  }

  for (const symbol of SYMBOLS) {
    console.log(`\n▶ ${symbol}`);

    // Daily trade limit per symbol — only enforced when the coin is losing today.
    // If today's trades on this symbol are net positive (bull run), allow unlimited re-entries.
    if (countTodayTrades(symbol) >= CONFIG.maxPerDay && isCoinLosingToday(symbol)) {
      console.log(`  Daily limit reached (coin losing today) — skipping`);
      continue;
    }

    // Cooldown — 3 hours after any clean stop-out on this symbol
    const cooldown = isOnCooldown(symbol);
    if (cooldown.active) {
      console.log(`  ⏳ Cooldown active — ${cooldown.minsLeft} min remaining (until ${cooldown.until.slice(11, 16)} UTC)`);
      continue;
    }

    // Open-position guard — never enter a symbol that already has an active position.
    // TWO layers: (1) our local tracker file, (2) live Bitget positions (hard truth).
    // The tracker can be stale if the bot crashed or history wasn't found. Checking Bitget
    // directly prevents re-entry while a position is open but not yet in our tracker.
    // This was the root cause of 3× JUP re-entry: SL fired, history not found → UNKNOWN
    // outcome → no cooldown → tracker cleared → Bitget still showed position open → re-entered.
    const openPositions = loadOpenPositions();
    const alreadyOpen = openPositions.some(p => p.symbol === symbol);
    if (alreadyOpen) {
      console.log(`  ⏭ Position already open (tracker) — skipping`);
      continue;
    }
    // Hard guard: also check live Bitget positions regardless of tracker state
    if (!CONFIG.paperTrading && liveSymbolsOnBitget.has(symbol)) {
      console.log(`  ⏭ Position already open on Bitget (live check) — skipping`);
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
    const order = await placeOrder(symbol, entry.signal, qty, entry.entry, entry.stopLoss, tps.tp1, tps.tp2, tps.tp3);

    // Only log and register if the order actually landed (has a real orderId)
    const realOrderId = order?.orderId || order?.data?.orderId;
    if (!realOrderId && !CONFIG.paperTrading) {
      console.log(`  ✗ Order failed — NOT logging to CSV or open positions (no orderId).`);
      continue;
    }

    // ── Use fill price already fetched inside placeOrder ────────────────────────
    // placeOrder now fetches the actual fill price before placing TP orders,
    // so it's available here. Fallback to signal price if not available (paper mode).
    const actualEntry = order?.fillPrice ?? entry.entry;
    const actualQty   = order?.fillQty   ?? qty;
    const actualTp1   = order?.fixedTp1  ?? tps.tp1;
    const actualTp2   = order?.fixedTp2  ?? tps.tp2;
    const actualTp3   = order?.fixedTp3  ?? tps.tp3;

    const fibLevels = calcFibLevels(entry.signal, entry.entry, htf.swingHighs, htf.swingLows);
    writeLog({
      timestamp:    new Date().toISOString(),
      symbol,
      htfTrend:     htf.trend,
      signal:       entry.signal,
      signalEntry:  entry.entry,
      actualEntry,
      stopLoss:     entry.stopLoss,
      tp1: actualTp1, tp2: actualTp2, tp3: actualTp3,
      rr1: tps.rr1, rr2: tps.rr2, rr3: tps.rr3,
      slAfterTp1:   tps.slPlan.afterTp1,
      slAfterTp2:   tps.slPlan.afterTp2,
      split:        tps.split,
      emaLevels,
      fibLevels:    { ratios: FIB_RATIOS, levels: fibLevels },
      swingHigh:    htf.swingHighs[htf.swingHighs.length - 1]?.price,
      swingLow:     htf.swingLows[htf.swingLows.length - 1]?.price,
      reason:       entry.reason,
      orderId:      realOrderId,
    });

    const now = new Date();
    const row = [
      now.toISOString().slice(0, 10),
      now.toISOString().slice(11, 19),
      'BitGet',
      symbol,
      entry.signal,
      actualQty,
      actualEntry.toFixed(4),          // ← actual Bitget fill, not signal price
      entry.stopLoss.toFixed(4),
      actualTp1.toFixed(4),            // ← corrected TPs based on actual fill
      actualTp2.toFixed(4),
      actualTp3.toFixed(4),
      tps.rr1,
      tps.rr2,
      tps.rr3,
      tps.slPlan.afterTp1.toFixed(4),
      (actualQty * actualEntry).toFixed(2),  // ← notional based on real fill
      realOrderId,
      CONFIG.paperTrading ? 'paper' : 'live',
      `${BOT_NAME} ${BOT_VERSION}`,
    ].join(',');
    appendTrade(row);

    // Register in open-positions tracker so the monitor can detect SL/TP hits
    addOpenPosition({
      id:          realOrderId,
      symbol,
      side:        entry.signal,
      mode:        CONFIG.paperTrading ? 'paper' : 'live',
      entry:       actualEntry,          // ← actual Bitget fill
      stopLoss:    entry.stopLoss,
      tp1:         actualTp1,   // ← corrected based on actual fill price
      tp2:         actualTp2,
      tp3:         actualTp3,
      tp1OrderId:  order.tp1OrderId  || null,
      tp2OrderId:  order.tp2OrderId  || null,
      tp3OrderId:  order.tp3OrderId  || null,
      qty:         actualQty,            // ← actual filled quantity
      totalUsd:    parseFloat((actualQty * actualEntry).toFixed(2)),
      openDate:    now.toISOString().slice(0, 10),
      openTime:    now.toISOString().slice(11, 19),
      strategy:    `${BOT_NAME} ${BOT_VERSION}`,
    });

    console.log(`  Trade logged.`);
  }

  console.log(`\n══ IRONCLAD run complete ══`);
}

run().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
