import 'dotenv/config';
import fetch from 'node-fetch';
import fs from 'fs';

// ── Constants ─────────────────────────────────────────────────────────────────

const BITGET_BASE = 'https://api.bitget.com';
const LEVERAGE    = 3;

// 1000 candles × 15 min = ~250 hours (~10.4 days). Covers all historical trades.
const CANDLE_LIMIT = 1000;

// ── Candle fetching ───────────────────────────────────────────────────────────

async function fetchCandles(symbol, granularity = '15m', limit = CANDLE_LIMIT) {
  const url = `${BITGET_BASE}/api/v2/mix/market/candles?symbol=${symbol}&productType=USDT-FUTURES&granularity=${granularity}&limit=${limit}`;
  const res  = await fetch(url);
  const json = await res.json();
  if (!json.data?.length) return [];
  return json.data
    .map(c => ({
      time:  parseInt(c[0]),
      open:  parseFloat(c[1]),
      high:  parseFloat(c[2]),
      low:   parseFloat(c[3]),
      close: parseFloat(c[4]),
    }))
    .sort((a, b) => a.time - b.time); // Oldest first
}

// ── CSV parsing ───────────────────────────────────────────────────────────────

function parseCSV(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h =>
    h.trim().toLowerCase().replace(/[→\s]+/g, '_').replace(/[^a-z0-9_]/g, '')
  );
  return lines.slice(1).map(line => {
    const vals = line.split(',');
    const obj  = {};
    headers.forEach((h, i) => { obj[h] = vals[i]?.trim() ?? ''; });
    return obj;
  });
}

// ── Closed positions storage ──────────────────────────────────────────────────

function loadClosed(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch { return []; }
}

function saveClosed(filePath, positions) {
  fs.writeFileSync(filePath, JSON.stringify(positions, null, 2));
}

// ── Ironclad: 3-TP trailing stop simulation ───────────────────────────────────
//
// v1.0 trades (no TP2/TP3): single exit — SL or TP1 closes 100% of position.
// v1.1+ trades (full 3-TP): split plan — 40% at TP1, 35% at TP2, 25% at TP3.
//   After TP1: SL moves to break-even (entry price)
//   After TP2: SL moves to TP1
//   SL hit at any point → close remaining position, trade fully closed
//   On same candle where both SL and TP can be reached → SL wins (pessimistic)

function simulateIronclad(pos, candles) {
  const SPLITS     = [0.40, 0.35, 0.25];
  const singleTp   = !pos.tp2 && !pos.tp3;  // v1.0 — only TP1, close 100% there
  let { currentSl, tp1Hit, tp2Hit, partialCloses } = pos;
  partialCloses    = [...partialCloses];

  let remaining    = 1.0;
  if (tp1Hit) remaining -= (singleTp ? 1.0 : SPLITS[0]);
  if (tp2Hit) remaining -= SPLITS[1];

  let fullyExited  = false;
  let realizedPnl  = partialCloses.reduce((s, c) => s + (c.pnl || 0), 0);
  let lastClose    = null;

  const closePartial = (candle, exitPrice, level, fraction) => {
    const cDate = new Date(candle.time).toISOString().slice(0, 10);
    const cTime = new Date(candle.time).toISOString().slice(11, 19);
    const pnlFrac = pos.side === 'long'
      ? (exitPrice - pos.entry) / pos.entry
      : (pos.entry - exitPrice) / pos.entry;
    const pnl = pnlFrac * fraction * pos.totalUsd * LEVERAGE;
    realizedPnl += pnl;
    remaining   -= fraction;
    partialCloses.push({ level, price: exitPrice, date: cDate, time: cTime, pnl });
    lastClose = { level, price: exitPrice, date: cDate, time: cTime };
  };

  for (const c of candles) {
    if (pos.side === 'long') {

      // 1. SL (pessimistic — checked before TP on same candle)
      if (c.low <= currentSl) {
        closePartial(c, currentSl, 'sl', remaining);
        fullyExited = true;
        break;
      }
      // 2. TP1
      if (!tp1Hit && pos.tp1 && c.high >= pos.tp1) {
        const fraction = singleTp ? remaining : SPLITS[0];
        closePartial(c, pos.tp1, 'tp1', fraction);
        tp1Hit = true;
        if (singleTp) { fullyExited = true; break; }
        currentSl = pos.entry; // SL moves to break-even
      }
      // 3. TP2
      if (tp1Hit && !tp2Hit && pos.tp2 && c.high >= pos.tp2) {
        closePartial(c, pos.tp2, 'tp2', SPLITS[1]);
        tp2Hit    = true;
        currentSl = pos.tp1;  // SL moves to TP1
      }
      // 4. TP3 — final exit
      if (tp2Hit && pos.tp3 && c.high >= pos.tp3) {
        closePartial(c, pos.tp3, 'tp3', remaining);
        fullyExited = true;
        break;
      }

    } else { // short

      if (c.high >= currentSl) {
        closePartial(c, currentSl, 'sl', remaining);
        fullyExited = true;
        break;
      }
      if (!tp1Hit && pos.tp1 && c.low <= pos.tp1) {
        const fraction = singleTp ? remaining : SPLITS[0];
        closePartial(c, pos.tp1, 'tp1', fraction);
        tp1Hit = true;
        if (singleTp) { fullyExited = true; break; }
        currentSl = pos.entry;
      }
      if (tp1Hit && !tp2Hit && pos.tp2 && c.low <= pos.tp2) {
        closePartial(c, pos.tp2, 'tp2', SPLITS[1]);
        tp2Hit    = true;
        currentSl = pos.tp1;
      }
      if (tp2Hit && pos.tp3 && c.low <= pos.tp3) {
        closePartial(c, pos.tp3, 'tp3', remaining);
        fullyExited = true;
        break;
      }
    }
  }

  return { fullyExited, tp1Hit, tp2Hit, currentSl, partialCloses, realizedPnl, lastClose, remaining };
}

// ── VWAP: simple single SL / TP simulation ────────────────────────────────────
//
// Rules: single exit — whichever of SL or TP is touched first closes the trade.
// SL checked first on the same candle (pessimistic, consistent with Ironclad).

function simulateVwap(pos, candles) {
  const calcPnl = (exitPrice) => {
    const pnlFrac = pos.side === 'long'
      ? (exitPrice - pos.entry) / pos.entry
      : (pos.entry - exitPrice) / pos.entry;
    return pnlFrac * pos.totalUsd * LEVERAGE;
  };

  for (const c of candles) {
    const cDate = new Date(c.time).toISOString().slice(0, 10);
    const cTime = new Date(c.time).toISOString().slice(11, 19);

    if (pos.side === 'long') {
      if (c.low  <= pos.stopLoss)   return { closed: true, exitPrice: pos.stopLoss,   exitLevel: 'sl',  pnl: calcPnl(pos.stopLoss),   date: cDate, time: cTime };
      if (c.high >= pos.takeProfit) return { closed: true, exitPrice: pos.takeProfit, exitLevel: 'tp1', pnl: calcPnl(pos.takeProfit), date: cDate, time: cTime };
    } else {
      if (c.high >= pos.stopLoss)   return { closed: true, exitPrice: pos.stopLoss,   exitLevel: 'sl',  pnl: calcPnl(pos.stopLoss),   date: cDate, time: cTime };
      if (c.low  <= pos.takeProfit) return { closed: true, exitPrice: pos.takeProfit, exitLevel: 'tp1', pnl: calcPnl(pos.takeProfit), date: cDate, time: cTime };
    }
  }
  return { closed: false };
}

// ── Shared: fetch candles by symbol, process a batch of trades ────────────────

async function processBatch(trades, simulateFn, closed) {
  // Group by symbol so we only fetch candles once per symbol
  const bySymbol = {};
  for (const t of trades) {
    const sym = t.symbol;
    if (!bySymbol[sym]) bySymbol[sym] = [];
    bySymbol[sym].push(t);
  }

  const nowClosed  = [];
  const stillOpen  = [];

  for (const [symbol, group] of Object.entries(bySymbol)) {
    let candles;
    try {
      process.stdout.write(`  Fetching ${symbol} candles… `);
      candles = await fetchCandles(symbol);
      console.log(`${candles.length} candles`);
    } catch (err) {
      console.log(`FAILED (${err.message})`);
      stillOpen.push(...group);
      continue;
    }

    for (const pos of group) {
      const openTs   = new Date(`${pos.openDate}T${pos.openTime}Z`).getTime();
      const relevant = candles.filter(c => c.time > openTs);

      if (!relevant.length) {
        console.log(`    ${pos.symbol} ${pos.side} @ $${pos.entry} (${pos.openDate}): no candles after open — still open`);
        stillOpen.push(pos);
        continue;
      }

      const result = simulateFn(pos, relevant);

      if (result.closed !== undefined) {
        // VWAP branch
        if (result.closed) {
          const outcome = result.exitLevel === 'sl' ? 'LOSS' : 'WIN';
          const icon    = outcome === 'WIN' ? '✅' : '❌';
          console.log(`    ${pos.symbol} ${pos.side} @ $${pos.entry}: ${icon} ${outcome} — ${result.exitLevel.toUpperCase()} @ $${result.exitPrice} · P&L: ${result.pnl >= 0 ? '+' : ''}$${result.pnl.toFixed(2)}`);
          nowClosed.push({
            ...pos,
            realizedPnl: parseFloat(result.pnl.toFixed(4)),
            exitLevel:   result.exitLevel,
            exitPrice:   result.exitPrice,
            closeDate:   result.date,
            closeTime:   result.time,
            outcome,
          });
        } else {
          console.log(`    ${pos.symbol} ${pos.side} @ $${pos.entry}: ⏳ still open`);
          stillOpen.push(pos);
        }
      } else {
        // Ironclad branch
        if (result.fullyExited) {
          const lc      = result.lastClose;
          const outcome = result.partialCloses.some(c => c.level !== 'sl') ? 'WIN'
                        : result.partialCloses.every(c => c.level === 'sl') ? 'LOSS'
                        : 'BE';
          const icon    = outcome === 'WIN' ? '✅' : outcome === 'BE' ? '🟡' : '❌';
          console.log(`    ${pos.symbol} ${pos.side} @ $${pos.entry}: ${icon} ${outcome} — last exit ${lc.level.toUpperCase()} @ $${lc.price} · P&L: ${result.realizedPnl >= 0 ? '+' : ''}$${result.realizedPnl.toFixed(2)}`);
          nowClosed.push({
            ...pos,
            tp1Hit:        result.tp1Hit,
            tp2Hit:        result.tp2Hit,
            partialCloses: result.partialCloses,
            realizedPnl:   parseFloat(result.realizedPnl.toFixed(4)),
            exitLevel:     lc.level,
            exitPrice:     lc.price,
            closeDate:     lc.date,
            closeTime:     lc.time,
            outcome,
          });
        } else {
          const progress = result.tp2Hit ? '2/3 TPs hit' : result.tp1Hit ? '1/3 TPs hit' : 'awaiting TP1/SL';
          console.log(`    ${pos.symbol} ${pos.side} @ $${pos.entry}: ⏳ still open [${progress}]`);
          stillOpen.push({
            ...pos,
            tp1Hit:        result.tp1Hit,
            tp2Hit:        result.tp2Hit,
            currentSl:     result.currentSl,
            partialCloses: result.partialCloses,
          });
        }
      }
    }
  }

  return { nowClosed, stillOpen };
}

// ── Ironclad monitor ──────────────────────────────────────────────────────────

async function monitorIronclad() {
  console.log('\n── Ironclad Position Monitor ──');

  const CLOSED_PATH = './closed-positions-ironclad.json';
  const closed      = loadClosed(CLOSED_PATH);
  const closedIds   = new Set(closed.map(p => p.id));

  // Load all trades from CSV that have enough data (entry + SL + TP1 minimum)
  const positions = parseCSV('./trades-ironclad.csv')
    .filter(r => {
      const entry = parseFloat(r.entry_price);
      const sl    = parseFloat(r.stop_loss);
      const tp1   = parseFloat(r.tp1);
      return r.order_id && entry > 0 && sl > 0 && tp1 > 0 && !closedIds.has(r.order_id);
    })
    .map(r => {
      const sl = parseFloat(r.stop_loss);
      return {
        id:            r.order_id,
        symbol:        r.symbol,
        side:          r.side,
        entry:         parseFloat(r.entry_price),
        stopLoss:      sl,
        tp1:           parseFloat(r.tp1)    || null,
        tp2:           parseFloat(r.tp2)    || null,
        tp3:           parseFloat(r.tp3)    || null,
        qty:           parseFloat(r.quantity),
        totalUsd:      parseFloat(r.total_usd) || 50,
        openDate:      r.date,
        openTime:      r.time,
        strategy:      r.strategy,
        // Mutable state
        currentSl:     sl,
        tp1Hit:        false,
        tp2Hit:        false,
        partialCloses: [],
      };
    });

  console.log(`  ${positions.length} unresolved position(s) to check`);
  if (!positions.length) {
    console.log(`  ${closed.length} already in closed-positions-ironclad.json`);
    return;
  }

  const { nowClosed, stillOpen } = await processBatch(positions, simulateIronclad, closed);

  const allClosed = [...closed, ...nowClosed];
  saveClosed(CLOSED_PATH, allClosed);

  console.log(`  ── ${nowClosed.length} newly closed · ${stillOpen.length} still open · ${allClosed.length} total recorded ──`);
}

// ── VWAP monitor ──────────────────────────────────────────────────────────────

async function monitorVwap() {
  console.log('\n── VWAP Position Monitor ──');

  const CLOSED_PATH = './closed-positions-vwap.json';
  const closed      = loadClosed(CLOSED_PATH);
  const closedIds   = new Set(closed.map(p => p.id));

  // Only trades with SL and TP — early v1.1/v1.2 rows had neither, skip those
  const positions = parseCSV('./trades.csv')
    .filter(r => {
      const entry = parseFloat(r.price);
      const sl    = parseFloat(r.stop_loss);
      const tp    = parseFloat(r.take_profit);
      return r.order_id && entry > 0 && sl > 0 && tp > 0 && !closedIds.has(r.order_id);
    })
    .map(r => ({
      id:          r.order_id,
      symbol:      r.symbol,
      side:        r.side,
      entry:       parseFloat(r.price),
      stopLoss:    parseFloat(r.stop_loss),
      takeProfit:  parseFloat(r.take_profit),
      qty:         parseFloat(r.quantity),
      totalUsd:    parseFloat(r.total_usd) || 5,
      openDate:    r.date,
      openTime:    r.time,
      strategy:    r.strategy,
    }));

  const skipped = parseCSV('./trades.csv').filter(r => {
    const sl = parseFloat(r.stop_loss);
    const tp = parseFloat(r.take_profit);
    return r.order_id && (!sl || !tp);
  }).length;

  console.log(`  ${positions.length} position(s) to check · ${skipped} skipped (no SL/TP data — pre-v1.3)`);
  if (!positions.length) {
    console.log(`  ${closed.length} already in closed-positions-vwap.json`);
    return;
  }

  const { nowClosed, stillOpen } = await processBatch(positions, simulateVwap, closed);

  const allClosed = [...closed, ...nowClosed];
  saveClosed(CLOSED_PATH, allClosed);

  console.log(`  ── ${nowClosed.length} newly closed · ${stillOpen.length} still open · ${allClosed.length} total recorded ──`);
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function run() {
  console.log(`\n══ Position Monitor ${new Date().toISOString()} ══`);
  try { await monitorIronclad(); } catch (err) { console.log(`Ironclad monitor error (non-fatal): ${err.message}`); }
  try { await monitorVwap();     } catch (err) { console.log(`VWAP monitor error (non-fatal): ${err.message}`);     }
  console.log('\n── Monitor complete ──\n');
}

run().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
