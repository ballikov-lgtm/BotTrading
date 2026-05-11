/**
 * Alpaca executor — the bridge between SID's signal-detection brain and
 * Alpaca's order placement.
 *
 * Operating modes (set via SID_TRADING_MODE env var):
 *   - "dry_run"  (default) — log everything, never hit Alpaca. Same behaviour
 *                            as before this executor existed. Safe.
 *   - "paper"    — execute against Alpaca's paper-trading API.
 *                  https://paper-api.alpaca.markets
 *   - "live"     — execute against Alpaca's live API.
 *                  https://api.alpaca.markets
 *                  GATED by SID_LIVE_CONFIRMED=YES_I_REALLY_MEAN_IT to prevent
 *                  accidental live activation.
 *
 * What the executor guarantees:
 *   - Idempotency: every order carries a client_order_id derived from
 *     symbol + signal date + side, so repeat runs never double-fire.
 *   - Source-of-truth sync: Alpaca's position list overrides the local
 *     open-positions-sid.json on every run. If Alpaca filled your stop
 *     overnight, the local record gets reconciled automatically.
 *   - Account auto-detect: in paper/live mode the bot uses Alpaca's actual
 *     equity for position sizing — config's accountUsd becomes a fallback only.
 *   - Market-hours guard: refuses to submit orders when Alpaca clock says
 *     the market is closed.
 *
 * Public API:
 *   - createExecutor(config)
 *   - executor.preflight()             — call once at start of each run
 *   - executor.syncPositions(localOpen) → returns reconciled positions
 *   - executor.openEntry({ signal, sizing, symbol }) → submits buy/sell + stop
 *   - executor.closePosition(localPos, reason)        → submits exit market order
 */

import { AlpacaClient, AlpacaError } from './alpaca-client.js';

// ─────────────────────────────────────────────────────────────────────────────
// Mode helpers
// ─────────────────────────────────────────────────────────────────────────────

const VALID_MODES = ['dry_run', 'paper', 'live'];
const LIVE_CONFIRMATION_TOKEN = 'YES_I_REALLY_MEAN_IT';

export function resolveTradingMode() {
  const raw = (process.env.SID_TRADING_MODE || 'dry_run').toLowerCase().trim();
  if (!VALID_MODES.includes(raw)) {
    console.warn(`[SID-EXEC] Unknown SID_TRADING_MODE="${raw}". Falling back to dry_run.`);
    return 'dry_run';
  }
  // Defence-in-depth: refuse live unless explicit confirmation token is set
  if (raw === 'live' && process.env.SID_LIVE_CONFIRMED !== LIVE_CONFIRMATION_TOKEN) {
    console.error(`[SID-EXEC] SID_TRADING_MODE=live requires SID_LIVE_CONFIRMED="${LIVE_CONFIRMATION_TOKEN}". Falling back to PAPER.`);
    return 'paper';
  }
  return raw;
}

function baseUrlForMode(mode) {
  if (mode === 'live')  return 'https://api.alpaca.markets';
  if (mode === 'paper') return 'https://paper-api.alpaca.markets';
  return null; // dry_run — no URL needed
}

function clientOrderIdPrefix({ symbol, side, signalDate }) {
  // Alpaca limit: 48 chars, alphanumeric + dashes
  // Strategy + symbol + signalDate + side is plenty unique
  return `SID-${symbol}-${(signalDate || '').replace(/-/g, '')}-${side}`.slice(0, 40);
}

// ─────────────────────────────────────────────────────────────────────────────
// Executor implementation
// ─────────────────────────────────────────────────────────────────────────────

class AlpacaExecutor {
  constructor({ mode, client, log }) {
    this.mode    = mode;                                  // 'paper' | 'live'
    this.client  = client;                                // AlpacaClient
    this.log     = log || console;
    this.account = null;
    this.clock   = null;
  }

  /**
   * Fetches account + clock once. Returns:
   *   { ok: true,  equity, buyingPower, marketOpen }
   *   { ok: false, reason: 'blocked'|'closed'|'api_error', detail }
   *
   * The caller decides whether to abort the run based on this.
   */
  async preflight() {
    try {
      this.account = await this.client.getAccount();
    } catch (err) {
      return { ok: false, reason: 'api_error', detail: `getAccount: ${err.message}` };
    }

    if (this.account.account_blocked || this.account.trading_blocked) {
      return {
        ok: false,
        reason: 'blocked',
        detail: `Alpaca account flags: status=${this.account.status} account_blocked=${this.account.account_blocked} trading_blocked=${this.account.trading_blocked}`,
      };
    }

    try {
      this.clock = await this.client.getClock();
    } catch (err) {
      return { ok: false, reason: 'api_error', detail: `getClock: ${err.message}` };
    }

    return {
      ok: true,
      equity:      parseFloat(this.account.equity),
      buyingPower: parseFloat(this.account.buying_power),
      cash:        parseFloat(this.account.cash),
      marketOpen:  this.clock.is_open === true,
      nextOpen:    this.clock.next_open,
      nextClose:   this.clock.next_close,
    };
  }

  /**
   * Reconciles local open-positions-sid.json against Alpaca's authoritative
   * position list. Returns the cleaned-up local positions array (positions
   * Alpaca no longer has are stripped out and reported as closed).
   *
   * NOTE: this does NOT call updateAccount / saveClosedPositions — the caller
   * decides what to do with closed positions reported here. Keeping the
   * executor stateless makes it easier to test.
   *
   * @param {Array} localOpen — current local open-positions-sid.json array
   * @returns {{ stillOpen: Array, closedExternally: Array }}
   *   stillOpen        — positions that exist on Alpaca too
   *   closedExternally — local positions Alpaca says are gone (stop hit, etc.)
   */
  async syncPositions(localOpen) {
    const alpacaPositions = await this.client.listPositions();
    const alpacaSymbols = new Set(alpacaPositions.map(p => p.symbol.toUpperCase()));

    const stillOpen = [];
    const closedExternally = [];

    for (const pos of localOpen) {
      if (alpacaSymbols.has(pos.symbol.toUpperCase())) {
        // Still held on Alpaca — keep tracking. We do NOT pull qty from Alpaca
        // and overwrite local because partial fills / averaging is a future feature.
        stillOpen.push(pos);
      } else {
        // Local says open, Alpaca says no. Either the stop filled, or we just
        // submitted the close. Either way: treat as externally closed.
        closedExternally.push(pos);
      }
    }

    return { stillOpen, closedExternally, alpacaPositions };
  }

  /**
   * Submits a market-entry order + stop-loss for a new signal.
   *
   * @param {Object} args
   * @param {Object} args.signal    output of detectEntrySignal in bot-sid.js
   * @param {Object} args.sizing    output of calcPositionSize in bot-sid.js
   * @param {string} args.symbol
   * @returns {{ entryOrderId: string, stopOrderId: string }}
   */
  async openEntry({ signal, sizing, symbol }) {
    if (!this.clock?.is_open) {
      throw new Error(`Market closed — refusing to submit entry for ${symbol} (next open: ${this.clock?.next_open})`);
    }

    // Sanity: don't overspend the buying power
    const cost = sizing.shares * signal.entry;
    const bp   = parseFloat(this.account.buying_power);
    if (cost > bp) {
      throw new Error(`Insufficient buying power: need $${cost.toFixed(2)}, have $${bp.toFixed(2)}`);
    }

    const side = signal.signal === 'long' ? 'buy' : 'sell';
    const prefix = clientOrderIdPrefix({
      symbol,
      side: signal.signal,
      signalDate: signal.signalDate,
    });

    this.log.log(`    [Alpaca:${this.mode}] Submitting ${side.toUpperCase()} ${sizing.shares} ${symbol} @ market, stop $${signal.stopLoss}`);

    const { entryOrder, stopOrder } = await this.client.submitEntryWithStop({
      symbol,
      side,
      qty: sizing.shares,
      stopPrice: signal.stopLoss,
      clientOrderIdPrefix: prefix,
    });

    this.log.log(`    [Alpaca:${this.mode}] Entry order ${entryOrder.id} submitted (status: ${entryOrder.status})`);
    this.log.log(`    [Alpaca:${this.mode}] Stop order  ${stopOrder.id} submitted at $${signal.stopLoss}`);

    return {
      entryOrderId: entryOrder.id,
      stopOrderId:  stopOrder.id,
      clientOrderIdPrefix: prefix,
    };
  }

  /**
   * Closes an existing position via market order. Used when SID's RSI 50 exit
   * fires. Also cancels any outstanding stop order tied to this position.
   *
   * @param {Object} localPos  — entry from open-positions-sid.json
   * @param {string} reason    — for logging only
   */
  async closePosition(localPos, reason) {
    if (!this.clock?.is_open) {
      throw new Error(`Market closed — refusing to submit close for ${localPos.symbol}`);
    }

    // Cancel any outstanding stop order on this symbol before closing.
    // Otherwise the stop and the close race each other.
    try {
      const openOrders = await this.client.listOrders({ status: 'open', symbols: localPos.symbol });
      for (const order of openOrders) {
        if (order.client_order_id?.endsWith('-stop')) {
          await this.client.cancelOrder(order.id);
          this.log.log(`    [Alpaca:${this.mode}] Cancelled stop ${order.id} ahead of close`);
        }
      }
    } catch (err) {
      this.log.log(`    [Alpaca:${this.mode}] Warning — could not cancel pending stop: ${err.message}`);
    }

    this.log.log(`    [Alpaca:${this.mode}] Closing ${localPos.symbol} (${reason})`);
    const closeOrder = await this.client.closePosition(localPos.symbol);
    this.log.log(`    [Alpaca:${this.mode}] Close order ${closeOrder.id} submitted (status: ${closeOrder.status})`);

    return { closeOrderId: closeOrder.id };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns an executor instance, or null in dry_run mode.
 *
 *   const executor = createExecutor();
 *   if (executor) { ... use Alpaca ... }
 *   else          { ... log-only behaviour ... }
 *
 * The factory enforces the mode + env var rules. It will NEVER return a live
 * executor unless both SID_TRADING_MODE=live AND SID_LIVE_CONFIRMED=YES_I_REALLY_MEAN_IT.
 */
export function createExecutor(opts = {}) {
  const mode = resolveTradingMode();

  if (mode === 'dry_run') {
    console.log('[SID-EXEC] Mode: DRY_RUN — no Alpaca calls will be made.');
    return null;
  }

  const baseUrl = baseUrlForMode(mode);
  let client;
  try {
    client = new AlpacaClient({ baseUrl, ...opts });
  } catch (err) {
    console.error(`[SID-EXEC] Failed to construct Alpaca client: ${err.message}`);
    console.error('[SID-EXEC] Falling back to DRY_RUN. Set ALPACA_KEY_ID + ALPACA_SECRET_KEY to enable live execution.');
    return null;
  }

  const banner = mode === 'live'
    ? '\n  ┌──────────────────────────────────────────┐\n  │  ⚠  ALPACA LIVE MODE  ⚠                  │\n  │  Real money will be used to place trades │\n  └──────────────────────────────────────────┘\n'
    : `[SID-EXEC] Mode: PAPER — Alpaca paper-trading account in use (${baseUrl})`;
  console.log(banner);

  return new AlpacaExecutor({ mode, client, log: console });
}

export { AlpacaExecutor };
export default createExecutor;
