import 'dotenv/config';
import fetch from 'node-fetch';
import fs from 'fs';
import crypto from 'crypto';

// ── Config ────────────────────────────────────────────────────────────────────
const CONFIG = {
  apiKey:     process.env.BITGET_API_KEY    || '',
  secretKey:  process.env.BITGET_SECRET_KEY || '',
  passphrase: process.env.BITGET_PASSPHRASE || '',
};

// Position size set via Railway env var — bypasses position-read API permission issues
const HYPE_QTY   = parseFloat(process.env.HYPE_QTY   || '0');
const HYPE_ENTRY = parseFloat(process.env.HYPE_ENTRY  || '40.901');

const SYMBOL        = 'HYPEUSDT';
const PRODUCT_TYPE  = 'USDT-FUTURES';
const MARGIN_COIN   = 'USDT';
const BITGET_BASE   = 'https://api.bitget.com';

// ── Your TP plan ──────────────────────────────────────────────────────────────
//   TP1 : Close 40% at $45.60 → move SL to break-even
//   TP2 : Close 35% at $49.30 → set 3% trailing stop on remainder
//   TP3 : Close remaining 25% at $59.40 (limit, coexists with trail)
const TP1_PRICE   = 45.6;
const TP2_PRICE   = 49.3;
const TP3_PRICE   = 59.4;
const TRAIL_PCT   = 0.03;    // 3% callback ratio after TP2
const TP1_RATIO   = 0.40;
const TP2_RATIO   = 0.35;
const TP3_RATIO   = 0.25;

const STATE_PATH  = './hype-state.json';

// ── State helpers ─────────────────────────────────────────────────────────────

function loadState() {
  try {
    if (fs.existsSync(STATE_PATH)) return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {}
  return {
    active:      true,
    entryQty:    null,
    entryPrice:  null,
    tp1Hit:      false,
    tp2Hit:      false,
    tp3Hit:      false,
    tp1OrderId:  null,
    tp2OrderId:  null,
    tp3OrderId:  null,
    log:         [],
  };
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function log(state, msg) {
  const ts = new Date().toISOString().slice(0, 16) + 'Z';
  console.log(`[HYPE] ${msg}`);
  state.log.unshift(`${ts}  ${msg}`);
  if (state.log.length > 150) state.log = state.log.slice(0, 150);
}

// ── Bitget API ────────────────────────────────────────────────────────────────

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

// Get current HYPEUSDT long position
async function getPosition() {
  const r = await bitgetRequest('GET',
    `/api/v2/mix/position/all-position?productType=${PRODUCT_TYPE}&marginCoin=${MARGIN_COIN}`
  );
  if (r.code !== '00000') throw new Error(`Position fetch failed: ${JSON.stringify(r)}`);
  const list = Array.isArray(r.data) ? r.data : [];
  return list.find(p => p.symbol === SYMBOL && p.holdSide === 'long') || null;
}

// Place a reduce-only limit close order
async function placeCloseLimit(qty, price) {
  // marginMode must match the mode the position was opened in.
  // HYPE was opened manually in 'crossed' mode.
  // 'isolated' → 22002 "No position to close"
  // omitted    → 400172 "The margin mode cannot be empty"
  const r = await bitgetRequest('POST', '/api/v2/mix/order/place-order', {
    symbol:      SYMBOL,
    productType: PRODUCT_TYPE,
    marginCoin:  MARGIN_COIN,
    marginMode:  'crossed',
    side:        'sell',
    tradeSide:   'close',
    orderType:   'limit',
    price:       price.toString(),
    size:        qty.toString(),
  });
  if (r.code !== '00000') throw new Error(`Close order failed: ${JSON.stringify(r)}`);
  return r.data?.orderId;
}

// Check if a specific order is still open (not filled/cancelled)
async function isOrderOpen(orderId) {
  const r = await bitgetRequest('GET',
    `/api/v2/mix/order/detail?symbol=${SYMBOL}&productType=${PRODUCT_TYPE}&orderId=${orderId}`
  );
  const status = r.data?.status || '';
  // Bitget statuses: 'live' / 'new' = open, 'partially_filled', 'filled', 'cancelled'
  return status === 'live' || status === 'new' || status === 'partially_filled';
}

// Set / replace the stop-loss on the existing long position
async function setPositionSL(slPrice) {
  const r = await bitgetRequest('POST', '/api/v2/mix/order/place-tpsl-order', {
    symbol:       SYMBOL,
    productType:  PRODUCT_TYPE,
    marginCoin:   MARGIN_COIN,
    planType:     'loss_plan',
    holdSide:     'long',
    triggerPrice: slPrice.toFixed(4),
    triggerType:  'fill_price',
    size:         '0',           // 0 = full remaining position
    executePrice: '0',           // 0 = market execution at trigger
  });
  if (r.code !== '00000') {
    console.log(`  ⚠️  SL update warning: ${JSON.stringify(r)}`);
  }
  return r;
}

// Place a trailing stop order on remaining position (activated immediately)
async function setTrailingStop(activationPrice, callbackRatio) {
  // Bitget "moving_plan" = trailing stop
  // callbackRatio: 0.03 = trail 3% below the highest price since activation
  const r = await bitgetRequest('POST', '/api/v2/mix/order/place-plan-order', {
    symbol:        SYMBOL,
    productType:   PRODUCT_TYPE,
    marginCoin:    MARGIN_COIN,
    planType:      'moving_plan',
    side:          'close_long',
    triggerPrice:  activationPrice.toFixed(4),
    callbackRatio: callbackRatio.toString(),
    size:          '0',          // 0 = full remaining position
    triggerType:   'fill_price',
  });
  if (r.code !== '00000') {
    console.log(`  ⚠️  Trailing stop warning: ${JSON.stringify(r)}`);
  }
  return r;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  console.log('\n══════════════════════════════════════════════');
  console.log('  HYPE POSITION MANAGER');
  console.log('══════════════════════════════════════════════');

  const state = loadState();

  if (!state.active) {
    console.log('[HYPE] Position fully closed — manager inactive.');
    return;
  }

  // Check keys are present
  if (!CONFIG.apiKey) {
    console.log('[HYPE] No API keys — skipping (paper/local run).');
    return;
  }

  // ── Position size from env var (bypasses position-read permission issues) ──
  if (!HYPE_QTY) {
    console.log('[HYPE] HYPE_QTY env var not set — skipping.');
    return;
  }

  // First run — snapshot from env var
  if (!state.entryQty) {
    state.entryQty   = HYPE_QTY;
    state.entryPrice = HYPE_ENTRY;
    log(state, `📍 Position configured: ${state.entryQty} HYPE @ $${state.entryPrice}`);
    log(state, `   TP1=$${TP1_PRICE} (${(state.entryQty*TP1_RATIO).toFixed(2)} HYPE), TP2=$${TP2_PRICE} (${(state.entryQty*TP2_RATIO).toFixed(2)} HYPE), TP3=$${TP3_PRICE} (${(state.entryQty*TP3_RATIO).toFixed(2)} HYPE)`);
  }

  const tp1Qty = parseFloat((state.entryQty * TP1_RATIO).toFixed(4));
  const tp2Qty = parseFloat((state.entryQty * TP2_RATIO).toFixed(4));
  const tp3Qty = parseFloat((state.entryQty * TP3_RATIO).toFixed(4));

  // ── STAGE 1 : Place TP1 limit order ────────────────────────────────────────
  if (!state.tp1Hit && !state.tp1OrderId) {
    log(state, `📤 Placing TP1 limit close: ${tp1Qty} HYPE @ $${TP1_PRICE}`);
    try {
      const id = await placeCloseLimit(tp1Qty, TP1_PRICE);
      state.tp1OrderId = id;
      log(state, `   ✔ TP1 order placed (id: ${id})`);
    } catch (e) {
      log(state, `   ⚠️  TP1 order error: ${e.message}`);
    }
  }

  // ── Check if TP1 has filled ─────────────────────────────────────────────────
  if (!state.tp1Hit && state.tp1OrderId) {
    const open = await isOrderOpen(state.tp1OrderId);
    if (!open) {
      state.tp1Hit = true;
      log(state, `✅ TP1 FILLED @ $${TP1_PRICE} — closed 40% of position`);
      log(state, `🔒 Moving SL to break-even: $${state.entryPrice}`);
      await setPositionSL(state.entryPrice);
    } else {
      log(state, `   TP1 order still open — price needs to reach $${TP1_PRICE} (mark: $${markPrice})`);
    }
  }

  // ── STAGE 2 : Place TP2 limit order after TP1 fills ────────────────────────
  if (state.tp1Hit && !state.tp2Hit && !state.tp2OrderId) {
    log(state, `📤 Placing TP2 limit close: ${tp2Qty} HYPE @ $${TP2_PRICE}`);
    try {
      const id = await placeCloseLimit(tp2Qty, TP2_PRICE);
      state.tp2OrderId = id;
      log(state, `   ✔ TP2 order placed (id: ${id})`);
    } catch (e) {
      log(state, `   ⚠️  TP2 order error: ${e.message}`);
    }
  }

  // ── Check if TP2 has filled ─────────────────────────────────────────────────
  if (state.tp1Hit && !state.tp2Hit && state.tp2OrderId) {
    const open = await isOrderOpen(state.tp2OrderId);
    if (!open) {
      state.tp2Hit = true;
      log(state, `✅ TP2 FILLED @ $${TP2_PRICE} — closed 35% of position`);

      // Set 3% trailing stop activated at TP2 price
      log(state, `🔒 Setting 3% trailing stop (activated @ $${TP2_PRICE})`);
      await setTrailingStop(TP2_PRICE, TRAIL_PCT);

      // Also place TP3 limit close as ceiling target
      log(state, `📤 Placing TP3 limit close: ${tp3Qty} HYPE @ $${TP3_PRICE}`);
      try {
        const id = await placeCloseLimit(tp3Qty, TP3_PRICE);
        state.tp3OrderId = id;
        log(state, `   ✔ TP3 order placed (id: ${id})`);
      } catch (e) {
        log(state, `   ⚠️  TP3 order error: ${e.message}`);
      }
    } else {
      log(state, `   TP2 order still open — price needs to reach $${TP2_PRICE} (mark: $${markPrice})`);
    }
  }

  // ── Check if TP3 / trailing stop has closed the position ───────────────────
  if (state.tp2Hit && !state.tp3Hit && state.tp3OrderId) {
    const open = await isOrderOpen(state.tp3OrderId);
    if (!open) {
      state.tp3Hit = true;
      state.active = false;
      log(state, `✅ HYPE position fully closed (TP3 or trailing stop triggered). Manager deactivated.`);
    } else {
      log(state, `   Waiting for TP3=$${TP3_PRICE} or 3% trail to trigger.`);
    }
  }

  saveState(state);
  console.log(`[HYPE] Stage: TP1=${state.tp1Hit} TP2=${state.tp2Hit} TP3=${state.tp3Hit} | Active=${state.active}`);
  console.log('══════════════════════════════════════════════\n');
}

run().catch(e => {
  console.error('[HYPE Manager] Fatal error:', e.message);
  process.exit(0); // Exit 0 so it doesn't fail the whole Ironclad workflow run
});
