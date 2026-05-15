/**
 * Alpaca REST API client — minimal, dependency-free wrapper.
 *
 * Covers exactly what the SID bot needs:
 *   - account info (equity, buying power, blocked flags)
 *   - market clock (is the market open right now?)
 *   - positions (list + close)
 *   - orders (place market entry, place stop-loss, cancel, list)
 *
 * No SDK dependency on purpose — keeps the install footprint tiny and means
 * we can run this from any node 20+ runtime including GitHub Actions.
 *
 * Env vars consumed:
 *   ALPACA_KEY_ID       — your API key id          (required)
 *   ALPACA_SECRET_KEY   — your API secret          (required)
 *   ALPACA_BASE_URL     — paper or live base URL   (optional, defaults to paper)
 *                         paper: https://paper-api.alpaca.markets
 *                         live:  https://api.alpaca.markets
 *
 * Docs: https://docs.alpaca.markets/reference
 */

const DEFAULT_PAPER_URL = 'https://paper-api.alpaca.markets';
const DEFAULT_LIVE_URL  = 'https://api.alpaca.markets';

export class AlpacaError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body   = body;
  }
}

export class AlpacaClient {
  constructor(opts = {}) {
    this.keyId     = opts.keyId     || process.env.ALPACA_KEY_ID;
    this.secretKey = opts.secretKey || process.env.ALPACA_SECRET_KEY;
    this.baseUrl   = (opts.baseUrl || process.env.ALPACA_BASE_URL || DEFAULT_PAPER_URL).replace(/\/+$/, '');

    if (!this.keyId || !this.secretKey) {
      throw new Error('AlpacaClient: ALPACA_KEY_ID and ALPACA_SECRET_KEY must be set');
    }

    // For logging/safety: tell caller which env we're hitting
    this.isPaper = this.baseUrl.includes('paper-api');
  }

  // ── Internal request helper ─────────────────────────────────────────────
  async _request(method, path, body) {
    const url = `${this.baseUrl}${path}`;
    const headers = {
      'APCA-API-KEY-ID':     this.keyId,
      'APCA-API-SECRET-KEY': this.secretKey,
      'Accept':              'application/json',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    // Alpaca returns JSON for both success and errors
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* leave as text */ }

    if (!res.ok) {
      const msg = json?.message || text || `HTTP ${res.status}`;
      throw new AlpacaError(`Alpaca ${method} ${path} failed: ${msg}`, res.status, json ?? text);
    }
    return json;
  }

  // ── Account ─────────────────────────────────────────────────────────────
  /**
   * Returns the account snapshot. Key fields for SID:
   *   status          — "ACTIVE" | "ACCOUNT_BLOCKED" | ...
   *   trading_blocked — boolean
   *   account_blocked — boolean
   *   equity          — total account value in USD
   *   buying_power    — what you can spend on new positions right now
   *   cash            — settled cash
   */
  async getAccount() {
    return this._request('GET', '/v2/account');
  }

  // ── Clock — is the US equities market open? ─────────────────────────────
  async getClock() {
    return this._request('GET', '/v2/clock');
  }

  // ── Positions ───────────────────────────────────────────────────────────
  async listPositions() {
    return this._request('GET', '/v2/positions');
  }

  async getPosition(symbol) {
    try {
      return await this._request('GET', `/v2/positions/${encodeURIComponent(symbol)}`);
    } catch (err) {
      if (err.status === 404) return null;
      throw err;
    }
  }

  /**
   * Closes a position with a market order. Returns the closing order details.
   * Pass qty to close partial; omit to close the entire position.
   */
  async closePosition(symbol, qty) {
    const qs = qty ? `?qty=${qty}` : '';
    return this._request('DELETE', `/v2/positions/${encodeURIComponent(symbol)}${qs}`);
  }

  // ── Orders ──────────────────────────────────────────────────────────────
  async listOrders(params = {}) {
    const qs = new URLSearchParams(params).toString();
    const path = qs ? `/v2/orders?${qs}` : '/v2/orders';
    return this._request('GET', path);
  }

  async getOrder(orderId) {
    return this._request('GET', `/v2/orders/${encodeURIComponent(orderId)}`);
  }

  /**
   * Submits an order.
   *
   * @param {Object} order
   * @param {string} order.symbol               e.g. "AAPL"
   * @param {number} order.qty                  shares (positive integer)
   * @param {'buy'|'sell'} order.side
   * @param {'market'|'limit'|'stop'|'stop_limit'} order.type
   * @param {'day'|'gtc'|'opg'|'cls'|'ioc'|'fok'} order.time_in_force
   * @param {number} [order.limit_price]
   * @param {number} [order.stop_price]
   * @param {string} [order.client_order_id]    idempotency key — REUSE TO PREVENT DUPLICATES
   * @param {Object} [order.order_class]        'simple'|'bracket'|'oco'|'oto'
   * @param {Object} [order.stop_loss]          { stop_price: number }
   * @param {Object} [order.take_profit]        { limit_price: number }
   */
  async submitOrder(order) {
    return this._request('POST', '/v2/orders', order);
  }

  async cancelOrder(orderId) {
    return this._request('DELETE', `/v2/orders/${encodeURIComponent(orderId)}`);
  }

  /**
   * Convenience: submit a market entry with a child stop-loss order.
   * Alpaca's `bracket` order_class requires BOTH stop AND take-profit.
   * SID has no fixed TP (we exit on RSI 50 dynamically), so we submit:
   *   1. Parent: market order (buy or sell)
   *   2. After fill: separate stop order in the opposite direction
   *
   * @returns { entryOrder, stopOrder } — both Alpaca order objects
   */
  async submitEntryWithStop({ symbol, side, qty, stopPrice, clientOrderIdPrefix }) {
    if (!['buy', 'sell'].includes(side)) throw new Error(`Invalid side: ${side}`);
    if (!(qty > 0)) throw new Error(`Invalid qty: ${qty}`);

    const oppositeSide = side === 'buy' ? 'sell' : 'buy';
    const prefix = clientOrderIdPrefix || `SID-${symbol}-${Date.now()}`;

    // Submit market entry
    const entryOrder = await this.submitOrder({
      symbol,
      qty,
      side,
      type:            'market',
      time_in_force:   'day',
      client_order_id: `${prefix}-entry`,
    });

    // Submit child stop-loss order
    // tif=gtc so the stop persists across days (SID can hold for weeks)
    const stopOrder = await this.submitOrder({
      symbol,
      qty,
      side:            oppositeSide,
      type:            'stop',
      stop_price:      stopPrice,
      time_in_force:   'gtc',
      client_order_id: `${prefix}-stop`,
    });

    return { entryOrder, stopOrder };
  }

  // ── Asset info ──────────────────────────────────────────────────────────
  async getAsset(symbol) {
    return this._request('GET', `/v2/assets/${encodeURIComponent(symbol)}`);
  }

  /**
   * Returns true if the symbol is tradable on Alpaca (not delisted, not halted,
   * fractional/short eligibility ignored — we work in whole shares).
   */
  async isTradable(symbol) {
    try {
      const asset = await this.getAsset(symbol);
      return asset?.tradable === true && asset?.status === 'active';
    } catch (err) {
      if (err.status === 404) return false;
      throw err;
    }
  }
}

// CommonJS-style default export so plain `const { AlpacaClient } = require(...)`
// callers also work if someone imports from a non-ESM context.
export default AlpacaClient;
