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
   * v2.4.2 — Cancel EVERY open order on ONE symbol, whatever placed it: SID-tagged
   * (`-stop`/`-tp1`/`-restop`), the entry `-stop`, OR a MANUAL/external order the
   * user placed via the Alpaca UI (Alpaca-generated client_order_id, no SID tag →
   * invisible to findOpenOrder + pos.brokerStopOrderId). Such a manual order would
   * otherwise keep "holding" the shares, so waitForNoOpenOrders never reaches zero
   * and the close/reset fails `insufficient qty available: 0`. Call this in the
   * cancel-first step of any close/reset, BEFORE waitForNoOpenOrders.
   *
   * SYMBOL-SCOPED — the listOrders query is filtered to `symbol` AND every order is
   * re-checked against `symbol` before cancel, so it can NEVER touch another symbol's
   * orders. Per-order try/catch so one failure can't abort the sweep.
   *
   * @returns {number} count of orders it cancelled (or attempted)
   */
  async cancelAllOpenOrders(symbol) {
    let orders = [];
    try {
      orders = await this.client.listOrders({ status: 'open', symbols: symbol, limit: 50 });
    } catch (err) {
      this.log.log(`    [Alpaca:${this.mode}] cancelAllOpenOrders listOrders failed for ${symbol}: ${err.message}`);
      return 0;
    }
    let n = 0;
    for (const o of (orders || [])) {
      if (!o || !o.id) continue;
      if (o.symbol && o.symbol !== symbol) continue;   // symbol-scoped guard — never touch another symbol
      try {
        await this.cancelOrderById(o.id);   // 404/422-tolerant (already-gone is fine)
        n++;
      } catch (err) {
        this.log.log(`    [Alpaca:${this.mode}] cancelAllOpenOrders could not cancel ${o.id} on ${symbol}: ${err.message}`);
      }
    }
    if (n) this.log.log(`    [Alpaca:${this.mode}] Swept ${n} open order(s) on ${symbol} before close/reset`);
    return n;
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

  // ───────────────────────────────────────────────────────────────────────────
  // v2.6.0 — QUEUE-FOR-OPEN EXITS
  //
  // WHY: on 2026-09-09 IBM's TP2 (SMA50 touch) ripened in the last ~35 minutes
  // of the session. The next bot run landed 21:06 UTC — an hour after the close.
  // It correctly swept the resting stop, then hit `Market closed — refusing to
  // submit close for IBM`, re-protected the runner and gave up until the next
  // run. Alan then did it by hand: cancel the stop, queue a market sell, filled
  // at the next open. These helpers let the bot do exactly that by itself.
  //
  // WHAT ALPACA ACTUALLY ACCEPTS (verified against
  // https://docs.alpaca.markets/docs/orders-at-alpaca on 2026-10-24):
  //   time_in_force 'opg'  "eligible to execute only in the market opening
  //                         auction ... OPG orders submitted AFTER 9:28am but
  //                         BEFORE 7:00pm ET will be REJECTED. OPG orders
  //                         submitted after 7:00pm will be queued and routed to
  //                         the following day's opening auction."
  //   time_in_force 'day'  "If submitted after the close, it is queued and
  //                         submitted the following trading day." And, from
  //                         "Orders Submitted Outside of Eligible Trading
  //                         Hours": "Orders not eligible for extended hours
  //                         submitted after 4:00pm ET will be queued up for
  //                         release the next trading day."
  //
  // So OPG has a DEAD ZONE of 09:28–19:00 ET — and 21:06 UTC (the exact IBM
  // failure) is 17:06 ET, i.e. squarely inside it. A plain `day` market order
  // has no such dead zone after the close, and is precisely what Alan submitted
  // by hand. queuedExitTif() therefore picks OPG when it is accepted
  // (pre-09:28 ET for today's open, or post-19:00 ET for the next one) and falls
  // back to `day` in between. Either way the exit executes at the next open.
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * ET wall-clock minutes-of-day, derived from the BROKER'S OWN clock timestamp.
   *
   * NEVER a hardcoded timezone or a local-machine clock: Alpaca stamps
   * `/v2/clock`'s `timestamp` with an ET offset (-04:00 in EDT, -05:00 in EST),
   * so the HH:MM digits are ALREADY Eastern wall-clock and the DST transition is
   * handled by the broker. The offset is asserted to be -04:00/-05:00 precisely
   * so a future API change to `Z` (UTC) can't silently make us read UTC digits as
   * ET — in that case this returns null and the caller takes the safe branch.
   *
   * @returns {number|null} minutes since ET midnight, or null if unparseable
   */
  etMinutesOfDay(clock = this.clock) {
    const ts  = typeof clock?.timestamp === 'string' ? clock.timestamp.trim() : '';
    const hm  = /T(\d{2}):(\d{2})/.exec(ts);
    const off = /(-0[45]):00$/.exec(ts);   // ET == UTC-4 (EDT) or UTC-5 (EST)
    if (!hm || !off) return null;
    return parseInt(hm[1], 10) * 60 + parseInt(hm[2], 10);
  }

  /**
   * Which time_in_force will Alpaca ACCEPT right now for a queue-for-open exit?
   * See the block comment above for the documented windows.
   *
   * `attempt` alternates the choice on retries so a rejection for a reason we
   * guessed wrong about self-corrects on the next cycle instead of looping.
   *
   * @param {number} attempt  1-based submission attempt for this exit
   * @returns {'opg'|'day'}
   */
  queuedExitTif(attempt = 1) {
    const OPG_CUTOFF_ET = 9 * 60 + 28;   // 09:28 ET — after this OPG is rejected
    const OPG_REOPEN_ET = 19 * 60;       // 19:00 ET — after this OPG queues to the NEXT open
    const et = this.etMinutesOfDay();
    // Unknown ET -> 'day': its accept window after the close is the broader of
    // the two, so it is the safe default.
    const preferred = (et === null)            ? 'day'
                    : (et >= OPG_REOPEN_ET)    ? 'opg'
                    : (et <  OPG_CUTOFF_ET)    ? 'opg'
                    :                            'day';
    const alternate = preferred === 'opg' ? 'day' : 'opg';
    const n = Number(attempt) || 1;
    return (n > 1 && n % 2 === 0) ? alternate : preferred;
  }

  /**
   * Submit an exit that the BROKER executes at the next market open.
   *
   * DELIBERATELY HAS NO MARKET-HOURS GUARD — that is the entire point of this
   * method, and it is the ONLY order-submitting method without one. Entries keep
   * their guard (openEntry/openEntryNoStop at :202/:278): a stale entry signal
   * must be re-evaluated against a fresh bar, never queued.
   *
   * CALLER CONTRACT: every resting order on the symbol must already have been
   * swept (cancelAllOpenOrders + waitForNoOpenOrders). A resting stop HOLDS the
   * shares and this order would be rejected `insufficient qty available: 0`.
   *
   * `clientOrderId` MUST be deterministic for (symbol, exit kind, date, attempt)
   * so a concurrent second submission — e.g. the Railway runner and a GitHub
   * Actions cron overlapping — is rejected BY ALPACA as a duplicate instead of
   * double-selling. See exitClientOrderId() in bot-sid.js.
   *
   * @returns {{ orderId, clientOrderId, timeInForce, status, submittedAt }}
   */
  async queueExitAtOpen({ localPos, qty, reason, clientOrderId, timeInForce }) {
    if (!(qty > 0)) throw new Error(`Invalid queued-exit qty: ${qty}`);
    if (!clientOrderId) throw new Error('queueExitAtOpen requires a deterministic clientOrderId');
    const tif      = timeInForce || this.queuedExitTif();
    const exitSide = localPos.side === 'long' ? 'sell' : 'buy';

    this.log.log(`    [Alpaca:${this.mode}] QUEUE-FOR-OPEN: ${exitSide.toUpperCase()} ${qty} ${localPos.symbol} @ market, tif=${tif} (${reason}) id=${clientOrderId}`);
    const order = await this.client.submitOrder({
      symbol:          localPos.symbol,
      qty,
      side:            exitSide,
      type:            'market',
      time_in_force:   tif,
      client_order_id: clientOrderId,
    });
    this.log.log(`    [Alpaca:${this.mode}] Queued exit order ${order.id} (status ${order.status}, tif ${tif}) — the broker executes it at the next open`);

    return {
      orderId:       order.id,
      clientOrderId,
      timeInForce:   tif,
      status:        order.status,
      submittedAt:   order.submitted_at || order.created_at || null,
    };
  }

  /**
   * The REAL average fill price for ONE order, weighted from the per-fill rows.
   *
   * v2.5.0 PITFALL (cost one iteration there, so don't regress it): an order's
   * `filled_avg_price` is ROUNDED TO 6dp by Alpaca, and for an order whose
   * individual fills were at DIFFERENT prices that rounding alone can move a leg
   * by a cent — RIOT's entry reads 19.665526 but is really 747.29/38, and HD's
   * exit reads 303.346667 but is really 910.04/3. So for any multi-price order we
   * compute the weighted average from `/v2/account/activities/FILL` rows, which
   * also give us the per-execution `exit_fills` stamp that consumedExitFillQty()
   * needs to stop a later close re-using these same fills.
   *
   * Single-price orders are already exact, and the order average is used as the
   * fallback whenever the activity rows are unavailable (never a silent failure —
   * `source` records which was used).
   *
   * @returns {{ price:number|null, source:string, qty:number, fills:Array }}
   */
  async weightedFillPrice(order) {
    const fallback = order?.filled_avg_price != null ? parseFloat(order.filled_avg_price) : null;
    const out = { price: Number.isFinite(fallback) ? fallback : null, source: 'order_avg', qty: 0, fills: [] };
    const orderId = order?.id;
    if (!orderId) return out;

    let rows = [];
    try {
      const anchor = order.submitted_at || order.created_at || null;
      rows = await this.client.getActivities({
        activity_types: 'FILL',
        // 60s of slack either side of the submit so a clock skew can't hide a row.
        ...(anchor ? { after: new Date(new Date(anchor).getTime() - 60_000).toISOString() } : {}),
      });
    } catch (err) {
      this.log.log(`    [Alpaca:${this.mode}] weightedFillPrice: FILL activities unavailable (${err.message}) — using the order's rounded filled_avg_price`);
      return out;
    }

    const mine = (rows || []).filter(r => r && r.order_id === orderId);
    if (!mine.length) return out;

    let q = 0, cost = 0;
    const fills = [];
    for (const r of mine) {
      const rq = parseFloat(r.qty), rp = parseFloat(r.price);
      if (!(rq > 0) || !(rp > 0)) continue;
      q += rq; cost += rq * rp;
      fills.push({ orderId, qty: rq, price: rp });
    }
    if (!(q > 0)) return out;

    const distinctPrices = new Set(fills.map(f => f.price)).size;
    return {
      price:  cost / q,
      source: distinctPrices === 1 ? 'fill_rows_single_price' : 'fill_rows_weighted',
      qty:    q,
      fills,
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
