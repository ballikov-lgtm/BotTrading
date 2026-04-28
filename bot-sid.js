import 'dotenv/config';
import fetch from 'node-fetch';
import fs from 'fs';

// ── Config ────────────────────────────────────────────────────────────────────

const CONFIG = {
  accountUsd:       parseFloat(process.env.SID_ACCOUNT_USD)     || 5000,   // Portfolio size for sizing
  riskPct:          parseFloat(process.env.SID_RISK_PCT)         || 0.005,  // 0.5% risk per trade (paper start)
  maxPositionPct:   parseFloat(process.env.SID_MAX_POS_PCT)      || 0.10,   // 10% of account max per trade
  maxOpenPositions: parseInt(process.env.SID_MAX_POSITIONS)      || 3,      // Never hold more than 3 at once
  maxPerDay:        parseInt(process.env.SID_MAX_PER_DAY)        || 1,      // Max new entries per run
  earningsWindow:   parseInt(process.env.SID_EARNINGS_WINDOW)    || 14,     // Skip if earnings within N days
  paperTrading:     process.env.SID_PAPER !== 'false',
};

// ── Bot identity ──────────────────────────────────────────────────────────────
const BOT_NAME    = 'SID';
const BOT_VERSION = 'v1.0'; // v1.0 initial — RSI(14) + MACD(12,26,9), daily chart, US stocks/ETFs only

const TRADES_PATH     = './trades-sid.csv';
const POSITIONS_PATH  = './open-positions-sid.json';
const CLOSED_PATH     = './closed-positions-sid.json';
const ACCOUNT_PATH    = './sid-account.json';
const SAFETY_LOG_PATH = './sid-log.json';

// ── Advisory Watchlist ────────────────────────────────────────────────────────
// This list is NOT fixed. Remove stocks that repeatedly underperform.
// Add new stocks when market research or sentiment signals a swing opportunity.
// See SID-README.md for the full watchlist management policy.
const WATCHLIST = [
  // ETFs — broad market and sector
  'DIA', 'IWM', 'QQQ', 'SPY',
  'XLB', 'XLC', 'XLE', 'XLF', 'XLI', 'XLK', 'XLP', 'XLRE', 'XLU', 'XLV', 'XLY',
  'SLV', 'GOLD', 'SQQQ', 'TNA', 'TQQQ', 'TZA', 'QYLD',
  // Individual stocks
  'AAPL', 'AMD', 'AMZN', 'BA', 'BAC', 'CAT',
  'COST', 'DIS', 'DKS', 'ETSY', 'FCX', 'FDX',
  'GM', 'GOOG', 'GS', 'HD', 'IBM', 'INTC',
  'JPM', 'MA', 'META', 'MCD', 'MSFT', 'PYPL',
  'TGT', 'TSLA', 'VZ', 'WMT',
];

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
  const today = new Date();
  for (const dateStr of earningsDates) {
    const earningsDate = new Date(dateStr);
    const daysAway = Math.abs((earningsDate - today) / (1000 * 60 * 60 * 24));
    if (daysAway <= windowDays) return { blocked: true, date: dateStr, daysAway: Math.round(daysAway) };
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

// ── Signal Detection ──────────────────────────────────────────────────────────
// Returns a signal object or null.
// Logic follows the SID Quick Win Method checklist exactly:
//   1. RSI went below 30 (oversold signal) — note the signal date
//   2. RSI & MACD both pointing in same direction today = entry
//   3. Stop = lowest low (signal date → entry date) rounded to whole dollar
//   4. Take profit: RSI reaches 50 (monitored separately)

function detectEntrySignal(candles) {
  const closes = candles.map(c => c.close);
  const rsiArr = calcRSI(closes);
  const { macdLine } = calcMACD(closes);

  const n = closes.length;
  const rsiNow  = rsiArr[n - 1];
  const rsiPrev = rsiArr[n - 2];
  const macdNow  = macdLine[n - 1];
  const macdPrev = macdLine[n - 2];

  if (!rsiNow || !rsiPrev || !macdNow || !macdPrev) return null;

  // ── Long setup: RSI was oversold (<30), now both RSI and MACD pointing UP ───
  // Find the most recent oversold episode start (RSI crossing below 30)
  let oversoldIdx = null;
  for (let i = n - 1; i >= 1; i--) {
    if (rsiArr[i] === null) continue;
    // If RSI is back above 50, the episode is over — stop looking
    if (rsiArr[i] >= 50 && i < n - 1) { oversoldIdx = null; break; }
    if (rsiArr[i] < 30 && (rsiArr[i - 1] === null || rsiArr[i - 1] >= 30)) {
      oversoldIdx = i; // First candle of the oversold episode
      break;
    }
  }

  if (oversoldIdx !== null && rsiNow > rsiPrev && macdNow > macdPrev) {
    // Both RSI and MACD pointing up — valid long entry
    const signalDate  = candles[oversoldIdx].date;
    const episodeCandles = candles.slice(oversoldIdx); // Signal date → today
    const lowestLow   = Math.min(...episodeCandles.map(c => c.low));
    const stopLoss    = Math.floor(lowestLow);         // Rounded DOWN to whole dollar

    return {
      signal:     'long',
      entry:      closes[n - 1],
      stopLoss,
      signalDate,
      entryDate:  candles[n - 1].date,
      rsiAtEntry: rsiNow,
      rsiAtSignal: rsiArr[oversoldIdx],
      reason:     `RSI oversold (${rsiArr[oversoldIdx]}) on ${signalDate} → RSI(${rsiNow.toFixed(1)}) & MACD both pointing up`,
    };
  }

  // ── Short setup: RSI was overbought (>70), now both RSI and MACD pointing DOWN
  let overboughtIdx = null;
  for (let i = n - 1; i >= 1; i--) {
    if (rsiArr[i] === null) continue;
    if (rsiArr[i] <= 50 && i < n - 1) { overboughtIdx = null; break; }
    if (rsiArr[i] > 70 && (rsiArr[i - 1] === null || rsiArr[i - 1] <= 70)) {
      overboughtIdx = i;
      break;
    }
  }

  if (overboughtIdx !== null && rsiNow < rsiPrev && macdNow < macdPrev) {
    const signalDate  = candles[overboughtIdx].date;
    const episodeCandles = candles.slice(overboughtIdx);
    const highestHigh = Math.max(...episodeCandles.map(c => c.high));
    const stopLoss    = Math.ceil(highestHigh);        // Rounded UP to whole dollar

    return {
      signal:     'short',
      entry:      closes[n - 1],
      stopLoss,
      signalDate,
      entryDate:  candles[n - 1].date,
      rsiAtEntry: rsiNow,
      rsiAtSignal: rsiArr[overboughtIdx],
      reason:     `RSI overbought (${rsiArr[overboughtIdx]}) on ${signalDate} → RSI(${rsiNow.toFixed(1)}) & MACD both pointing down`,
    };
  }

  return null;
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

// ── Position Monitor — RSI-50 Exit ────────────────────────────────────────────
// SID exits entirely when RSI(14) reaches 50 on the daily chart.
// Walks through daily candles since the position was opened to find the first
// day where RSI crossed 50. Uses that day's close as the exit price.

async function checkPositions() {
  const openPositions   = loadOpenPositions();
  const closedPositions = loadClosedPositions();

  if (!openPositions.length) {
    console.log('\n── SID Position Monitor: No open positions ──');
    return;
  }

  console.log(`\n── SID Position Monitor: ${openPositions.length} open position(s) ──`);

  const stillOpen = [];

  for (const pos of openPositions) {
    process.stdout.write(`  ▶ ${pos.symbol} ${pos.side.toUpperCase()} @ $${pos.entry} (${pos.openDate}) … `);

    let candles;
    try {
      candles = await fetchDailyCandles(pos.symbol, '6mo');
    } catch (err) {
      console.log(`candles unavailable — skipping (${err.message})`);
      stillOpen.push(pos);
      continue;
    }

    // Only use candles from the day AFTER entry (entry day is already locked in)
    const postEntry = candles.filter(c => c.date > pos.openDate);
    if (!postEntry.length) {
      console.log('no new daily bars yet');
      stillOpen.push(pos);
      continue;
    }

    // Calculate RSI on all candles (need history for accurate RSI on post-entry bars)
    const closes = candles.map(c => c.close);
    const rsiArr = calcRSI(closes);

    // Find the first post-entry bar where RSI crosses 50
    let exitCandle = null;
    for (let i = 0; i < candles.length; i++) {
      if (candles[i].date <= pos.openDate) continue;
      const rsi = rsiArr[i];
      if (rsi === null) continue;

      if (pos.side === 'long'  && rsi >= 50) { exitCandle = { ...candles[i], rsi }; break; }
      if (pos.side === 'short' && rsi <= 50) { exitCandle = { ...candles[i], rsi }; break; }

      // Also check if stop loss was hit first (price breached SL level)
      if (pos.side === 'long'  && candles[i].low  <= pos.stopLoss) {
        exitCandle = { ...candles[i], rsi, hitSl: true }; break;
      }
      if (pos.side === 'short' && candles[i].high >= pos.stopLoss) {
        exitCandle = { ...candles[i], rsi, hitSl: true }; break;
      }
    }

    if (!exitCandle) {
      const currentRsi = rsiArr[rsiArr.length - 1];
      console.log(`still open (RSI ${currentRsi?.toFixed(1) ?? '—'}, waiting for RSI 50)`);
      stillOpen.push(pos);
      continue;
    }

    // Position closed
    const exitPrice   = exitCandle.hitSl ? pos.stopLoss : exitCandle.close;
    const exitLevel   = exitCandle.hitSl ? 'sl' : 'rsi50';
    const realizedPnl = parseFloat((
      pos.side === 'long'
        ? (exitPrice - pos.entry) * pos.shares
        : (pos.entry - exitPrice) * pos.shares
    ).toFixed(2));
    const outcome = realizedPnl >= 0 ? 'WIN' : 'LOSS';
    const icon    = outcome === 'WIN' ? '✅' : '❌';

    // Update compounding account balance
    const updatedAccount = updateAccount(realizedPnl);
    const growthPct      = ((updatedAccount.accountUsd - updatedAccount.startingUsd) / updatedAccount.startingUsd * 100).toFixed(2);

    console.log(`${icon} ${outcome} — ${exitLevel === 'rsi50' ? 'RSI reached 50' : 'SL hit'} @ $${exitPrice.toFixed(2)} on ${exitCandle.date}`);
    console.log(`    Realized P&L : ${realizedPnl >= 0 ? '+' : ''}$${realizedPnl}`);
    console.log(`    Account now  : $${updatedAccount.accountUsd.toFixed(2)}  (${growthPct >= 0 ? '+' : ''}${growthPct}% vs starting $${updatedAccount.startingUsd})`);

    closedPositions.push({
      ...pos,
      exitLevel,
      exitPrice,
      exitRsi:         exitCandle.rsi,
      closeDate:       exitCandle.date,
      realizedPnl,
      outcome,
      accountAfter:    updatedAccount.accountUsd,
    });
  }

  const numClosed = openPositions.length - stillOpen.length;
  saveOpenPositions(stillOpen);
  saveClosedPositions(closedPositions);
  console.log(`  ── ${numClosed} closed this run, ${stillOpen.length} still open ──`);
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
  console.log(`Max open: ${CONFIG.maxOpenPositions}  Earnings window: ${CONFIG.earningsWindow} days  Paper: ${CONFIG.paperTrading}`);
  console.log(`Symbols : ${WATCHLIST.length} stocks/ETFs`);
  console.log(`─`.repeat(60));

  // Step 0: Check open positions for RSI-50 exits
  await checkPositions();

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
    let candles;
    try {
      candles = await fetchDailyCandles(symbol);
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

    // Earnings blackout check — critical rule, never bypass
    const earningsDates = await fetchEarningsDates(symbol);
    const earningsCheck = isWithinEarningsWindow(earningsDates, CONFIG.earningsWindow);
    if (earningsCheck.blocked) {
      console.log(`🚫 Earnings blackout — ${earningsCheck.date} is ${earningsCheck.daysAway} days away (${CONFIG.earningsWindow}-day rule)`);
      writeLog({ symbol, signal: signal.signal, reason: `Earnings blackout: ${earningsCheck.date}` });
      continue;
    }

    // Calculate position size
    const sizing = calcPositionSize(signal.entry, signal.stopLoss);
    if (!sizing) {
      console.log(`Position too small to open (entry $${signal.entry.toFixed(2)} stop $${signal.stopLoss})`);
      writeLog({ symbol, signal: signal.signal, reason: 'Position size < 1 share' });
      continue;
    }

    // All checks passed — log the paper trade
    const orderId = `SID-PAPER-${Date.now()}`;
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

    const row = [
      now.toISOString().slice(0, 10),
      now.toISOString().slice(11, 19),
      'Yahoo/Paper',
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
      'paper',
      `${BOT_NAME} ${BOT_VERSION}`,
    ].join(',');

    appendTrade(row);

    addOpenPosition({
      id:         orderId,
      symbol,
      side:       signal.signal,
      entry:      signal.entry,
      stopLoss:   signal.stopLoss,
      shares:     sizing.shares,
      totalUsd:   sizing.totalUsd,
      riskUsd:    sizing.riskUsd,
      signalDate: signal.signalDate,
      openDate:   now.toISOString().slice(0, 10),
      openTime:   now.toISOString().slice(11, 19),
      strategy:   `${BOT_NAME} ${BOT_VERSION}`,
    });

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
}

run().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
