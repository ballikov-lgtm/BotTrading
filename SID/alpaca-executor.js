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
    const alpacaBySymbol = new Map(
      alpacaPositions.map(p => [p.symbol.toUpperCase(), p])
    );

    const stillOpen = [];
    const closedExternally = [];
    const partialClosed = [];

    for (const pos of localOpen) {
      const alpacaPos = alpacaBySymbol.get(pos.symbol.toUpperCase());

      if (alpacaPos) {
        // Position still on Alpaca — but compare share counts to catch
        // partial fills (FIX task #25, 2026-06-05). The old code blindly
        // kept local qty in sync only when the bot itself fired the close,
        // missing externally-fired partial fills like the MCD May 26 case
        // where 4 of 8 shares closed but the bot ran for 10 days thinking
        // it still held 8.
        const alpacaQty = Math.abs(parseInt(alpacaPos.qty, 10));
        const localQty  = pos.shares_remaining ?? pos.shares;
        if (Number.isFinite(alpacaQty) && Number.isFinite(localQty) && alpacaQty < localQty) {
          const deltaShares = localQty - alpacaQty;
          // Snapshot pos BEFORE we mutate it so the caller has the prev state
          partialClosed.push({
            pos: { ...pos },
            prevQty: localQty,
            newQty: alpacaQty,
            deltaShares,
          });
          // Update local pos.shares_remaining to match Alpaca truth
          pos.shares_remaining = alpacaQty;
        }
        stillOpen.push(pos);
      } else {
        // Local says open, Alpaca says no. Externally closed (stop fill,
        // OCO fill, manual close, anything else).
        closedExternally.push(pos);
      }
    }

    return { stillOpen, closedExternally, partialClosed, alpacaPositions };
  }

  /**
   * Submits a market-entry order PLUS a GTC stop-loss in opposite direction.
   *
   * V2.2 (2026-06-08): broker-enforced stop replaces the v2.0 PDT-immune
   * design. Account is now treated as ≥ $25K so PDT doesn't apply. The
   * resting stop fires intraday on touch (seconds), not next-morning open
   * (~24h lag with 0-2% slippage). Same-day round-trips are fine.
   *
   * The TP1 resting limit is placed separately by checkPositions() — it's
   * recomputed each run because the RSI-50 target price drifts daily.
   *
   * Returns BOTH order ids so the position can be reconciled later when
   * the stop fills or the TP1 limit fills.
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
    const exitSide = side === 'buy' ? 'sell' : 'buy';
    const prefix = clientOrderIdPrefix({
      symbol,
      side: signal.signal,
      signalDate: signal.signalDate,
    });

    this.log.log(`    [Alpaca:${this.mode}] Submitting ${side.toUpperCase()} ${sizing.shares} ${symbol} @ market + GTC stop @ $${signal.stopLoss}`);

    // 1. Market entry
    const entryOrder = await this.client.submitOrder({
      symbol,
      qty: sizing.shares,
      side,
      type: 'market',
      time_in_force: 'day',
      client_order_id: `${prefix}-entry`,
    });
    this.log.log(`    [Alpaca:${this.mode}] Entry order ${entryOrder.id} submitted (status: ${entryOrder.status})`);

    // 2. V2.2: GTC stop, opposite side, full qty, at signal.stopLoss
    let stopOrderId = null;
    try {
      const stopOrder = await this.client.submitOrder({
        symbol,
        qty:             sizing.shares,
        side:            exitSide,
        type:            'stop',
        stop_price:      signal.stopLoss,
        time_in_force:   'gtc',
        client_order_id: `${prefix}-stop`,
      });
      stopOrderId = stopOrder.id;
      this.log.log(`    [Alpaca:${this.mode}] Stop order ${stopOrderId} placed at $${signal.stopLoss} (status: ${stopOrder.status})`);
    } catch (err) {
      // Don't bail the entry if the stop fails — log loudly so the bot's
      // next-run safety net picks it up. The position exists either way.
      this.log.error(`    [Alpaca:${this.mode}] ⚠ STOP ORDER FAILED for ${symbol}: ${err.message}. Position is UNPROTECTED on broker side — bot fallback will manage.`);
    }

    return {
      entryOrderId: entryOrder.id,
      stopOrderId,
      clientOrderIdPrefix: prefix,
    };
  }

  /**
   * V2.4.0 PDT-SAFE — submits ONLY the market entry, NO broker stop.
   *
   * This is the PDT-immune entry used when SID_PDT_SAFE=true. The whole point of
   * PDT-safe mode is that NO broker order can fire intraday on the same day as
   * the entry (a same-day round trip = a day trade = Pattern Day Trader exposure
   * for a sub-$25K margin account). Since a resting GTC stop CAN fill same-day,
   * we simply don't place one here. Downside protection is deferred to the
   * daily-poll in checkPositions, which market-closes the position at the NEXT
   * run's open if the tracked stop level was breached — always a later calendar
   * day than entry. See CONFIG.pdtSafe + SID/CLAUDE.md § PDT-safe.
   *
   * Returns { entryOrderId, stopOrderId: null, clientOrderIdPrefix: null } — the
   * null stopOrderId/prefix keep isV2_2Position(pos) === false so the position is
   * routed through the daily-poll (never the broker-order path).
   */
  async openEntryNoStop({ signal, sizing, symbol }) {
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

    this.log.log(`    [Alpaca:${this.mode}] PDT-SAFE: Submitting ${side.toUpperCase()} ${sizing.shares} ${symbol} @ market — NO broker stop (daily-poll manages exits on a later day)`);

    // Market entry ONLY — no GTC stop, no resting TP1 limit.
    const entryOrder = await this.client.submitOrder({
      symbol,
      qty: sizing.shares,
      side,
      type: 'market',
      time_in_force: 'day',
      client_order_id: `${prefix}-entry`,
    });
    this.log.log(`    [Alpaca:${this.mode}] PDT-SAFE entry order ${entryOrder.id} submitted (status: ${entryOrder.status})`);

    return {
      entryOrderId: entryOrder.id,
      stopOrderId: null,           // PDT-safe: no broker stop by design
      clientOrderIdPrefix: null,   // PDT-safe: no resting orders to find/refresh
    };
  }

  /**
   * V2.1 — Closes a PARTIAL portion of a position via Alpaca's positions
   * endpoint with explicit qty. Used for the 50% TP1 partial close at RSI 50.
   *
   * Implementation note: Alpaca's DELETE /v2/positions/{symbol}?qty=N submits
   * a market order to close exactly N shares at next valid trading session.
   * This preserves the PDT-immune property — partial fill executes on the
   * next day, not same-day as the entry/scan.
   *
   * ⚠ HELD-SHARES TRAP (fixed v2.2.5, 2026-07-01): Alpaca "holds" shares
   * against any resting exit order. If a GTC stop for the FULL position is
   * still live, the DELETE-by-qty here gets `insufficient qty available for
   * order (requested: N, available: 0)` and fails EVERY run. The v2.2 broker
   * design leaves a full-size GTC stop resting from entry, so the TP1 caller
   * MUST cancel that stop first (see cancelOrderById + waitForNoOpenOrders)
   * before calling closePartial. This method does NOT cancel it for you.
   *
   * @param {Object} localPos      — entry from open-positions-sid.json
   * @param {number} qty           — shares to close (must be < total held)
   * @param {string} reason        — log-only
   */
  async closePartial(localPos, qty, reason) {
    if (!this.clock?.is_open) {
      throw new Error(`Market closed — refusing to submit partial close for ${localPos.symbol}`);
    }
    if (!(qty > 0)) throw new Error(`Invalid partial qty: ${qty}`);

    const sharesTotal = localPos.shares_total ?? localPos.shares;
    if (qty >= sharesTotal) {
      throw new Error(`Partial qty ${qty} >= total ${sharesTotal} — use closePosition() for full closes`);
    }

    this.log.log(`    [Alpaca:${this.mode}] Closing PARTIAL ${qty}/${sharesTotal} ${localPos.symbol} (${reason})`);
    const closeOrder = await this.client.closePosition(localPos.symbol, qty);
    this.log.log(`    [Alpaca:${this.mode}] Partial close order ${closeOrder.id} submitted (status: ${closeOrder.status})`);

    return { closeOrderId: closeOrder.id, qty };
  }

  /**
   * Cancel a single broker order by its id. Best-effort — returns
   * { cancelled: true } on success, { cancelled: false, reason } if the order
   * is already gone/filled/not-found (404 or 422 both count as "already gone",
   * which is fine — the shares are released either way). Never throws for the
   * common already-gone cases so the caller can proceed to the partial close.
   *
   * Used by the TP1 cancel-first fix: release the resting GTC stop so the
   * shares become available before the DELETE-by-qty partial close.
   */
  async cancelOrderById(orderId) {
    if (!orderId) return { cancelled: false, reason: 'no order id' };
    try {
      await this.client.cancelOrder(orderId);
      this.log.log(`    [Alpaca:${this.mode}] Cancelled order ${orderId}`);
      return { cancelled: true };
    } catch (err) {
      // 404 (gone), 422 (already filled / not cancelable) → shares already free
      if (err.status === 404 || err.status === 422) {
        this.log.log(`    [Alpaca:${this.mode}] Order ${orderId} already gone (${err.status}) — shares released`);
        return { cancelled: false, reason: `already gone (${err.status})` };
      }
      throw err;
    }
  }

  /**
   * Poll until the symbol has NO open orders (or timeout). After cancelling the
   * resting stop we must wait for Alpaca to actually release the held shares
   * before submitting the partial close, otherwise the DELETE-by-qty can still
   * race the cancel and hit `insufficient qty available`.
   *
   * Returns true if the symbol reached zero open orders, false on timeout.
   */
  async waitForNoOpenOrders(symbol, { attempts = 6, delayMs = 700 } = {}) {
    for (let i = 0; i < attempts; i++) {
      let open;
      try {
        open = await this.client.listOrders({ status: 'open', symbols: symbol, limit: 50 });
      } catch (err) {
        this.log.log(`    [Alpaca:${this.mode}] waitForNoOpenOrders listOrders failed (${err.message}) — retrying`);
        open = null;
      }
      if (Array.isArray(open) && open.length === 0) return true;
      await new Promise(r => setTimeout(r, delayMs));
    }
    return false;
  }

  /**
   * Poll an order until it reaches a terminal state (filled/canceled/rejected)
   * or timeout. Returns the last order snapshot seen. Used to CONFIRM the TP1
   * partial-close market order actually filled before we re-place the BE stop
   * on the runner — if it didn't fill we must NOT leave the position
   * unprotected.
   *
   * @returns {{ order: Object|null, filled: boolean, filledQty: number, filledAvgPrice: number|null }}
   */
  async pollOrderFill(orderId, { attempts = 8, delayMs = 750 } = {}) {
    let last = null;
    for (let i = 0; i < attempts; i++) {
      try {
        last = await this.client.getOrder(orderId);
      } catch (err) {
        this.log.log(`    [Alpaca:${this.mode}] pollOrderFill getOrder failed (${err.message}) — retrying`);
      }
      const status = String(last?.status || '').toLowerCase();
      const filledQty = parseFloat(last?.filled_qty || 0);
      if (status === 'filled' || (filledQty > 0 && status !== 'partially_filled')) {
        return {
          order: last,
          filled: filledQty > 0,
          filledQty,
          filledAvgPrice: last?.filled_avg_price != null ? parseFloat(last.filled_avg_price) : null,
        };
      }
      if (status === 'canceled' || status === 'rejected' || status === 'expired') {
        return { order: last, filled: filledQty > 0, filledQty, filledAvgPrice: last?.filled_avg_price != null ? parseFloat(last.filled_avg_price) : null };
      }
      await new Promise(r => setTimeout(r, delayMs));
    }
    const filledQty = parseFloat(last?.filled_qty || 0);
    return {
      order: last,
      filled: filledQty > 0,
      filledQty,
      filledAvgPrice: last?.filled_avg_price != null ? parseFloat(last.filled_avg_price) : null,
    };
  }

  /**
   * Place a GTC stop on N shares in the exit direction. Used to (a) re-place the
   * break-even stop on the runner after the TP1 partial confirms, and (b) as a
   * SAFETY re-protect on the FULL remaining qty if the TP1 partial DIDN'T
   * confirm — so a cancelled-stop position is never left naked.
   *
   * @param {Object} localPos  — position (for symbol/side/clientOrderIdPrefix)
   * @param {number} qty       — shares to protect
   * @param {number} stopPrice — stop trigger price
   * @param {string} tag       — client_order_id suffix discriminator (e.g. 'stop' | 'restop')
   * @returns {{ stopOrderId: string }}
   */
  async placeStop(localPos, qty, stopPrice, tag = 'stop') {
    if (!(qty > 0)) throw new Error(`Invalid stop qty: ${qty}`);
    const exitSide = localPos.side === 'long' ? 'sell' : 'buy';
    const prefix = localPos.clientOrderIdPrefix || `SID-${localPos.symbol}-${Date.now()}`;
    const stopOrder = await this.client.submitOrder({
      symbol:          localPos.symbol,
      qty,
      side:            exitSide,
      type:            'stop',
      stop_price:      parseFloat(Number(stopPrice).toFixed(2)),
      time_in_force:   'gtc',
      client_order_id: `${prefix}-${tag}-${Date.now()}`,
    });
    this.log.log(`    [Alpaca:${this.mode}] Placed ${tag} for ${localPos.symbol}: ${qty}sh @ $${Number(stopPrice).toFixed(2)} (id ${stopOrder.id})`);
    return { stopOrderId: stopOrder.id };
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

    // V2.0+ PDT-immune design: we don't submit stop orders to Alpaca anymore,
    // so there's nothing to cancel ahead of the close. Legacy stops (from
    // positions opened pre-v2.0) are still scrubbed defensively in case any
    // remain in flight.
    try {
      const openOrders = await this.client.listOrders({ status: 'open', symbols: localPos.symbol });
      for (const order of openOrders) {
        if (order.client_order_id?.endsWith('-stop')) {
          await this.client.cancelOrder(order.id);
          this.log.log(`    [Alpaca:${this.mode}] Cancelled legacy stop ${order.id} ahead of close`);
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
