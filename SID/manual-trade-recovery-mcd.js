/**
 * MCD Position Recovery — fixes the missing SL on the 2026-05-22 hybrid trade
 *
 * Current state on Alpaca paper:
 *   - 8 shares MCD long, entry $281.67
 *   - Open: limit SELL 4 @ $310.75 (order 40121ee8-9d83-4f14-a4b3-85f6dafd0dd0)
 *   - SL: NOT PLACED (Alpaca rejected for "insufficient qty available")
 *
 * Recovery plan (correct cloud-native pattern):
 *   1. Cancel the existing TP1 limit (frees all 8 shares)
 *   2. Submit OCO for 4 shares: TP1 limit $310.75 + SL stop $272
 *      → If TP1 hits, OCO cancels its own stop. Standalone stop (step 3) still protects runner.
 *      → If SL hits first, OCO stop fires + standalone stop fires = 8 shares closed.
 *   3. Submit standalone stop for 4 shares @ $272 (the runner)
 *
 * After this runs, MCD has full SL protection AND keeps the TP1 partial-close target.
 * TP2 (RSI 70 close on runner) remains the user's manual job.
 */

import { AlpacaClient } from './alpaca-client.js';
import { resolveTradingMode } from './alpaca-executor.js';

const TICKER         = 'MCD';
const SHARES_TOTAL   = 8;
const TP1_QTY        = 4;
const RUNNER_QTY     = SHARES_TOTAL - TP1_QTY;
const TP1_PRICE      = 310.75;
const SL_PRICE       = 272;
const OLD_TP1_ORDER  = '40121ee8-9d83-4f14-a4b3-85f6dafd0dd0';

function bail(msg) { console.error(`[SID-RECOVERY] ERROR: ${msg}`); process.exit(1); }

const mode = resolveTradingMode();
console.log(`[SID-RECOVERY] mode=${mode}`);
if (mode === 'dry_run') { console.log('[SID-RECOVERY] dry_run — exiting'); process.exit(0); }

const baseUrl = mode === 'live'
  ? 'https://api.alpaca.markets'
  : 'https://paper-api.alpaca.markets';
const client = new AlpacaClient({
  keyId:     process.env.ALPACA_KEY_ID,
  secretKey: process.env.ALPACA_SECRET_KEY,
  baseUrl,
});

// ── 0) Sanity: confirm the position exists ────────────────────────────────
let pos;
try {
  pos = await client.getPosition(TICKER);
} catch (e) {
  bail(`Could not fetch MCD position: ${e.message}`);
}
const qty = parseInt(pos.qty, 10);
console.log(`[SID-RECOVERY] Confirmed position: ${qty} ${TICKER} long @ avg $${pos.avg_entry_price}`);
if (qty !== SHARES_TOTAL) {
  bail(`Expected ${SHARES_TOTAL} shares but found ${qty}. Aborting — position state is unexpected.`);
}

// ── 1) Cancel the existing TP1 limit ──────────────────────────────────────
try {
  await client.cancelOrder(OLD_TP1_ORDER);
  console.log(`[SID-RECOVERY] ✓ Cancelled old TP1 limit ${OLD_TP1_ORDER}`);
} catch (e) {
  // It may have already been cancelled or filled — non-fatal, just log
  console.warn(`[SID-RECOVERY] Could not cancel ${OLD_TP1_ORDER} (may already be gone): ${e.message}`);
}

// Brief wait for cancellation to settle on Alpaca side
await new Promise(r => setTimeout(r, 1500));

// ── 2) Submit OCO for 4 shares (TP1 limit + SL stop) ──────────────────────
// OCO order: one leg is limit (take_profit), other leg is stop (stop_loss).
// If one fires, the other is auto-cancelled by Alpaca.
const ts = Date.now();
const ocoOrder = await client.submitOrder({
  symbol:          TICKER,
  qty:             TP1_QTY,
  side:            'sell',
  type:            'limit',
  limit_price:     TP1_PRICE,
  time_in_force:   'gtc',
  order_class:     'oco',
  take_profit:     { limit_price: TP1_PRICE },
  stop_loss:       { stop_price:  SL_PRICE  },
  client_order_id: `HYBRID-MCD-RECOV-${ts}-oco`,
});
console.log(`[SID-RECOVERY] ✓ OCO submitted: ${ocoOrder.id} (${TP1_QTY}sh)`);
console.log(`              TP1 leg: limit $${TP1_PRICE} | SL leg: stop $${SL_PRICE}`);

// Brief wait so the OCO holds get registered before we submit the runner stop
await new Promise(r => setTimeout(r, 1500));

// ── 3) Submit standalone stop for the runner half ─────────────────────────
const runnerStop = await client.submitOrder({
  symbol:          TICKER,
  qty:             RUNNER_QTY,
  side:            'sell',
  type:            'stop',
  stop_price:      SL_PRICE,
  time_in_force:   'gtc',
  client_order_id: `HYBRID-MCD-RECOV-${ts}-runnerstop`,
});
console.log(`[SID-RECOVERY] ✓ Standalone runner stop submitted: ${runnerStop.id} (${RUNNER_QTY}sh @ $${SL_PRICE})`);

// ── Done ──────────────────────────────────────────────────────────────────
console.log('\n[SID-RECOVERY] ✅ DONE — MCD position now fully protected');
console.log(`   Position: ${SHARES_TOTAL} shares MCD long`);
console.log(`   OCO leg 1 (TP1 ${TP1_QTY}sh @ $${TP1_PRICE}) | OCO leg 2 (SL ${TP1_QTY}sh @ $${SL_PRICE})`);
console.log(`   Standalone runner stop (${RUNNER_QTY}sh @ $${SL_PRICE})`);
console.log(`   If TP1 hits: OCO closes ${TP1_QTY} at profit, cancels its own stop, runner still protected.`);
console.log(`   If SL hits first: both 4-share stops fire = full ${SHARES_TOTAL}sh close.`);
console.log(`   TP2 (RSI 70 close on runner) is YOUR manual job.`);
