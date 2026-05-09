/**
 * fix-tp-orders.js — Emergency: place missing TP limit close orders on Bitget
 *
 * Run once from your Trading Setup folder:
 *   node fix-tp-orders.js
 *
 * What it does:
 *   1. Reads open-positions-ironclad.json
 *   2. For any live position with no tp1OrderId, places the 3 TP limit closes
 *   3. Fixes invalid TP levels (below entry for longs / above entry for shorts)
 *      using R:R fallback levels before placing
 *   4. Saves updated positions.json and pushes to logs branch
 */

import 'dotenv/config';
import fetch from 'node-fetch';
import fs from 'fs';
import crypto from 'crypto';
import { execSync } from 'child_process';

const BITGET_BASE = 'https://api.bitget.com';
const API_KEY    = process.env.BITGET_API_KEY    || '';
const SECRET_KEY = process.env.BITGET_SECRET_KEY || '';
const PASSPHRASE = process.env.BITGET_PASSPHRASE || '';

if (!API_KEY) { console.error('❌  No BITGET_API_KEY in .env'); process.exit(1); }

const GREEN  = s => `\x1b[32m${s}\x1b[0m`;
const RED    = s => `\x1b[31m${s}\x1b[0m`;
const YELLOW = s => `\x1b[33m${s}\x1b[0m`;
const BOLD   = s => `\x1b[1m${s}\x1b[0m`;

// ── Bitget auth ───────────────────────────────────────────────────────────────
function sign(ts, method, path, body) {
  return crypto.createHmac('sha256', SECRET_KEY)
    .update(ts + method + path + (body || ''))
    .digest('base64');
}

async function bitgetReq(method, path, body = null) {
  const ts      = Date.now().toString();
  const bodyStr = body ? JSON.stringify(body) : '';
  const sig     = sign(ts, method, path, bodyStr);
  const res = await fetch(BITGET_BASE + path, {
    method,
    headers: {
      'ACCESS-KEY': API_KEY, 'ACCESS-SIGN': sig,
      'ACCESS-TIMESTAMP': ts, 'ACCESS-PASSPHRASE': PASSPHRASE,
      'Content-Type': 'application/json',
    },
    body: body ? bodyStr : undefined,
  });
  return res.json();
}

// ── Price tick sizes per symbol (Bitget enforces these) ──────────────────────
const TICK = {
  BTCUSDT:    0.1,
  ETHUSDT:    0.01,
  SOLUSDT:    0.001,
  AVAXUSDT:   0.001,
  TAOUSDT:    0.01,
  SUIUSDT:    0.0001,
  XRPUSDT:    0.0001,
  RENDERUSDT: 0.0001,
};

function roundToTick(price, symbol) {
  const tick = TICK[symbol] || 0.0001;
  return Math.round(price / tick) * tick;
}

// ── Contract size steps per symbol (Bitget futures minimum trade unit) ────────
// Sending a non-step-multiple size causes [22002] "No position to close".
// XRP=1 because total position shows as integer (134).
// RENDER=0.1 because total shows as decimal (93.7).
// For unknown symbols fall back to 0.01 (safe for most mid-caps).
const SIZE_STEP = {
  BTCUSDT:    0.001,
  ETHUSDT:    0.01,
  SOLUSDT:    0.1,
  AVAXUSDT:   0.1,
  TAOUSDT:    0.01,
  SUIUSDT:    1,
  XRPUSDT:    1,
  RENDERUSDT: 0.1,
  LINKUSDT:   0.1,
  HYPEUSDT:   0.1,
  TONUSDT:    1,
  NEARUSDT:   1,
  INJUSDT:    0.1,
  KASUSDT:    1,
  ZECUSDT:    0.1,
};

// Floor to nearest step to avoid over-closing (never round up for close orders)
function roundToStep(qty, symbol) {
  const step = SIZE_STEP[symbol] || 0.01;
  const decimals = step < 0.01 ? 3 : step < 0.1 ? 2 : step < 1 ? 1 : 0;
  const rounded = Math.floor(qty / step) * step;
  return parseFloat(rounded.toFixed(decimals));
}

function sizeStr(qty, symbol) {
  const step = SIZE_STEP[symbol] || 0.01;
  const decimals = step < 0.01 ? 3 : step < 0.1 ? 2 : step < 1 ? 1 : 0;
  return qty.toFixed(decimals);
}

// ── Fetch live positions from Bitget ─────────────────────────────────────────
async function getLivePositions() {
  const path = '/api/v2/mix/position/all-position?productType=USDT-FUTURES&marginCoin=USDT';
  const r = await bitgetReq('GET', path);
  if (r.code !== '00000') throw new Error(`Positions fetch failed: ${r.msg}`);
  return r.data.filter(p => parseFloat(p.total) > 0);
}

// ── Place one plan (trigger) TP order ────────────────────────────────────────
// Uses place-plan-order with planType=normal_plan (the ONLY endpoint that works
// for placing pending partial close orders on Bitget hedge-mode isolated positions).
//
// Why NOT place-order?  Returns [22002] for ALL parameter combinations tested.
// Why NOT close-positions? Immediately market-closes the position — not a limit order.
//
// Multiple plan orders CAN coexist on the same position (unlike regular limit orders).
// When triggerPrice is hit, Bitget places a limit order at `price` to close `size` lots.
async function placeLimitClose(symbol, side, qty, price) {
  const roundedQty = roundToStep(qty, symbol);
  if (roundedQty <= 0) {
    console.log(RED(`    ❌ Size rounds to 0 for ${symbol}: ${qty} (step=${SIZE_STEP[symbol] || 0.01})`));
    return null;
  }
  const step = SIZE_STEP[symbol] || 0.01;
  const sDecimals = step < 0.001 ? 4 : step < 0.01 ? 3 : step < 0.1 ? 2 : step < 1 ? 1 : 0;
  const qtyStr = roundedQty.toFixed(sDecimals);

  // Price precision: at least 4 dp (most symbols) or more if tick requires
  const tick = TICK[symbol] || 0.0001;
  const pDecimals = Math.max(4, tick < 0.001 ? 4 : tick < 0.01 ? 3 : tick < 0.1 ? 2 : 1);
  const priceStr = roundToTick(price, symbol).toFixed(pDecimals);

  const body = {
    symbol, productType: 'USDT-FUTURES', marginCoin: 'USDT',
    marginMode: 'isolated',
    side:         side === 'long' ? 'sell' : 'buy',  // opposite of existing position
    posSide:      side,                               // direction of the EXISTING position
    tradeSide:    'close',
    planType:     'normal_plan',
    triggerType:  'fill_price',
    triggerPrice: priceStr,
    price:        priceStr,
    orderType:    'limit',
    size:         qtyStr,
  };
  console.log(YELLOW(`    Sending: ${JSON.stringify(body)}`));
  const r = await bitgetReq('POST', '/api/v2/mix/order/place-plan-order', body);
  if (r.code !== '00000') {
    console.log(RED(`    ❌ Plan TP FAILED @ $${priceStr}: [${r.code}] ${r.msg}`));
    return null;
  }
  console.log(GREEN(`    ✅ Plan TP placed @ $${priceStr}: orderId=${r.data?.orderId}`));
  return r.data?.orderId || null;
}

// ── Validate / fix TP levels ──────────────────────────────────────────────────
function fixTpLevels(pos) {
  const { entry, stopLoss, tp1, tp2, tp3, side } = pos;
  const risk   = Math.abs(entry - stopLoss);
  const isLong = side === 'long';

  // Check each TP — replace any that are on the wrong side of entry
  const validFor = price => isLong ? price > entry * 1.001 : price < entry * 0.999;

  const fb1 = isLong ? entry + risk * 1.5  : entry - risk * 1.5;
  const fb2 = isLong ? entry + risk * 2.5  : entry - risk * 2.5;
  const fb3 = isLong ? entry + risk * 4.0  : entry - risk * 4.0;

  const newTp1 = validFor(tp1) ? tp1 : parseFloat(fb1.toFixed(4));
  const newTp2 = validFor(tp2) ? tp2 : parseFloat(fb2.toFixed(4));
  const newTp3 = validFor(tp3) ? tp3 : parseFloat(fb3.toFixed(4));

  const changed = newTp1 !== tp1 || newTp2 !== tp2 || newTp3 !== tp3;
  if (changed) {
    console.log(YELLOW(`  ⚠️  Fixed invalid TP levels for ${pos.symbol}:`));
    if (newTp1 !== tp1) console.log(YELLOW(`     TP1: ${tp1} → ${newTp1}`));
    if (newTp2 !== tp2) console.log(YELLOW(`     TP2: ${tp2} → ${newTp2}`));
    if (newTp3 !== tp3) console.log(YELLOW(`     TP3: ${tp3} → ${newTp3}`));
  }
  return { tp1: newTp1, tp2: newTp2, tp3: newTp3, changed };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(BOLD('\n════════════════════════════════════════'));
  console.log(BOLD('  Fix Missing TP Orders'));
  console.log(BOLD('════════════════════════════════════════\n'));

  // Pull latest state from logs branch first
  console.log('Pulling latest positions from logs branch...');
  try {
    execSync('git fetch origin logs && git checkout origin/logs -- open-positions-ironclad.json', { stdio: 'inherit' });
  } catch (e) {
    console.log(YELLOW('  Could not pull from logs — using local file'));
  }

  const positions = JSON.parse(fs.readFileSync('./open-positions-ironclad.json', 'utf8'));
  const live = positions.filter(p => p.mode === 'live');

  console.log(`Found ${live.length} live positions\n`);

  // Fetch live qty from Bitget so we use the real position size
  console.log('Fetching live position sizes from Bitget...');
  const liveOnExchange = await getLivePositions();
  const exchMap = {};
  for (const p of liveOnExchange) exchMap[p.symbol] = parseFloat(p.total);
  console.log(`Exchange has ${liveOnExchange.length} open positions\n`);

  let anyChanged = false;

  for (const pos of positions) {
    if (pos.mode !== 'live') continue;

    const hasTps = pos.tp1OrderId || pos.tp2OrderId || pos.tp3OrderId;
    if (hasTps) {
      console.log(GREEN(`  ✅ ${pos.symbol} — TP orders already placed, skipping`));
      continue;
    }

    // Check if this position is actually still open on Bitget
    const liveQty = exchMap[pos.symbol];
    if (!liveQty || liveQty <= 0) {
      console.log(YELLOW(`  ⚠️  ${pos.symbol} — not found on Bitget (already closed?), skipping`));
      continue;
    }

    console.log(BOLD(`\n${pos.symbol} ${pos.side.toUpperCase()} @ $${pos.entry}`));
    console.log(`  TPs: ${pos.tp1} / ${pos.tp2} / ${pos.tp3}  |  Qty (exchange): ${liveQty}`);

    // Fix any invalid TP levels
    const fixed = fixTpLevels(pos);
    pos.tp1 = fixed.tp1;
    pos.tp2 = fixed.tp2;
    pos.tp3 = fixed.tp3;

    // Split actual exchange qty: 40% / 35% / 25%
    // Floor to symbol's contract step size — fractional sizes cause [22002] on Bitget.
    const qty40 = roundToStep(liveQty * 0.40, pos.symbol);
    const qty35 = roundToStep(liveQty * 0.35, pos.symbol);
    const qty25 = roundToStep(Math.max(0, liveQty - qty40 - qty35), pos.symbol);

    console.log(`  Placing: ${sizeStr(qty40, pos.symbol)}@$${pos.tp1} / ${sizeStr(qty35, pos.symbol)}@$${pos.tp2} / ${sizeStr(qty25, pos.symbol)}@$${pos.tp3}`);

    // Plan orders support multiple pending at once — place all 3 TPs together.
    const tp1Id = await placeLimitClose(pos.symbol, pos.side, qty40, pos.tp1);
    await new Promise(r => setTimeout(r, 600));
    const tp2Id = await placeLimitClose(pos.symbol, pos.side, qty35, pos.tp2);
    await new Promise(r => setTimeout(r, 600));
    const tp3Id = await placeLimitClose(pos.symbol, pos.side, qty25, pos.tp3);

    pos.tp1OrderId = tp1Id || null;
    pos.tp2OrderId = tp2Id || null;
    pos.tp3OrderId = tp3Id || null;

    if (tp1Id) console.log(GREEN(`  ✅ TP1 placed: ${tp1Id}`));
    if (tp2Id) console.log(GREEN(`  ✅ TP2 placed: ${tp2Id}`));
    if (tp3Id) console.log(GREEN(`  ✅ TP3 placed: ${tp3Id}`));

    anyChanged = true;
  }

  if (anyChanged) {
    fs.writeFileSync('./open-positions-ironclad.json', JSON.stringify(positions, null, 2));
    console.log(BOLD('\nSaving and pushing to logs branch...'));
    try {
      execSync('git add open-positions-ironclad.json && git commit -m "fix: add missing TP order IDs to open positions" && git push origin HEAD:logs', { stdio: 'inherit' });
      console.log(GREEN('\n✅ Done — positions updated and pushed to logs branch'));
    } catch (e) {
      console.log(YELLOW('\n⚠️  Could not push to logs — positions saved locally only'));
      console.log('    Push manually: git push origin HEAD:logs');
    }
  } else {
    console.log(GREEN('\n✅ All positions already have TP orders — nothing to fix'));
  }
}

main().catch(e => { console.error(RED(`\nError: ${e.message}`)); process.exit(1); });
