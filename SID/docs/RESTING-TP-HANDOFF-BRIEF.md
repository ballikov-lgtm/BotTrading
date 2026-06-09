# SID v2.2 — Coding-Session Hand-off Brief
**Resting RSI-50 intraday TP + broker-enforced stop + $30k compounding sizing**
Prepared by Atlas (Hub) · 2026-06-08 · for a coding session with working git on `origin/main`

---

## Plain-language summary (for Alan)
Three changes, all on the live `main` branch:
1. **Size trades off a compounding $30k balance** instead of a fixed $100k. Positions grow/shrink as the account does.
2. **Put the stop-loss as a real resting order on Alpaca** the moment we enter — broker-enforced, not simulated.
3. **Put the TP1 (RSI 50) as a real resting limit order** that fills the instant price touches it *intraday* — no more waiting for the daily close, no more round-tripping to nothing.

The maths for #3 is already proven and the helper is written (`SID/rsi-target-price.js`). The rest is wiring.

---

## Why this is needed
- Current deployed bot is **v2.1** (`SID/bot-sid.js`, ~1667 lines, runs via `.github/workflows/sid.yml`, once/weekday 14:35 UTC, Alpaca paper).
- v2.1 uses a **PDT-immune design**: it does NOT rest stop/TP orders on Alpaca. It checks the daily candle once per run and sends a market close at the next day's open. TP1 (RSI 50) is only evaluated on the **daily close**.
- Problem: RSI can touch 50 intraday and revert by the close, so TP1 is missed and the trade can round-trip into a stop for ~nothing. Alan wants TP1 captured on the **intraday touch**.
- PDT is no longer a constraint: the account is treated as ≥ $25k ($30k), so same-day resting stop/TP fills are fine.

## Key files & APIs (already present on `origin/main`)
- `SID/rsi-target-price.js` — **NEW, written & verified.** `rsiTargetPrice(closes, period=14, target=50)` returns the price the next bar must print for Wilder RSI to equal the target. Verified against `bot-sid.js` `calcRSI` (append price → RSI 50.0, both directions).
- `SID/bot-sid.js` — `CONFIG` (~L10), `calcRSI` (~L524), `calcPositionSize` (~L794), `checkPositions` (~L852, the exit manager), entry placement (~L1522).
- `SID/alpaca-client.js` — `submitOrder({symbol, qty, side, type:'market'|'limit'|'stop'|'stop_limit', limit_price, stop_price, time_in_force, order_class:'simple'|'bracket'|'oco'|'oto', take_profit, stop_loss, client_order_id})`, `listOrders`, `cancelOrder`, `getOrder`, `getAccount`, and `submitEntryWithStop({symbol, side, qty, stopPrice, clientOrderIdPrefix})` (entry market + GTC stop helper — currently unused).
- `SID/alpaca-executor.js` — `openEntry` (market only, no stop), `closePartial(localPos, qty, reason)`, `closePosition(localPos, reason)`, `syncPositions`.
- Position schema fields already in use: `tp1_hit, orig_stop, shares_total, shares_remaining, tp1_date, tp1_price, tp1_shares, tp1_pnl, tp1_reason, tp1_rsi`.

---

## Change set

### 1. Compounding sizing off the internal $30k ledger
- At run start, set the sizing account to the **current internal balance**: `CONFIG.accountUsd = loadAccount().accountUsd || 30000`. Sizing then compounds with the equity curve.
- Keep `riskPct = 0.01` (1%) and `maxPositionPct = 0.10` (10% notional cap). Note: for these wide-stop swing trades the **10% cap is the binding constraint**, so risk lands ~0.6–0.7% of account.
- The `SID_ACCOUNT_USD` GitHub secret (set to 30000) becomes a fallback only — fine to leave.
- **Reset `SID/sid-account.json`** to a fresh $30k slate: `{ startingUsd: 30000, accountUsd: 30000, realizedPnl: 0, tradeCount: 0, method: "v2.2", mode: "paper", resetReason: "Rebased to $30k compounding 2026-06-08" }`.
- **Leave the Alpaca paper account ($100k) alone** — it just executes; the internal ledger is the equity of record.
- Legacy open **GOOG** runner was sized for $100k (13 sh ≈ $5k notional ≈ 17% of $30k). Let it close on its existing breakeven stop; do **not** resize mid-flight. New entries size off $30k.

### 2. Broker-enforced resting stop at entry
- In `executor.openEntry`, after the market entry, submit a **GTC stop** (opposite side, full qty) at `signal.stopLoss` (use the existing `submitEntryWithStop` helper, or replicate: `type:'stop', stop_price, time_in_force:'gtc', client_order_id: ` + `${prefix}-stop`).
- Persist the stop order id on the position. Remove the "no stop / PDT-immune" comment path.

### 3. Resting RSI-50 TP1 limit, maintained each run
In `checkPositions`, for each open position with `tp1_hit === false`:
- `import { rsiTargetPrice } from './rsi-target-price.js'`.
- `const tp1Price = rsiTargetPrice(closes, 14, 50);`
- `const tp1Qty = Math.floor(pos.shares_total * CONFIG.tp1Portion);` (50%).
- Close side: short → **buy** limit; long → **sell** limit.
- Use `listOrders({status:'open', symbols: pos.symbol})` to find an existing `${prefix}-tp1` order.
  - If none: submit `type:'limit', limit_price: tp1Price, qty: tp1Qty, time_in_force:'gtc', client_order_id: ${prefix}-tp1`.
  - If one exists at a materially different price (RSI-50 price drifts daily): `cancelOrder` then resubmit at the new `tp1Price`.
- **On TP1 fill** (detect via `listOrders`/`getOrder` status `filled`, or `syncPositions`):
  - Book the partial using the **actual Alpaca fill price** (not the theoretical level): update ledger, set `tp1_hit=true`, `tp1_date/price/shares/pnl/reason='rsi50'/rsi`, `shares_remaining -= tp1Qty`.
  - **Move stop to breakeven** on the runner: cancel the `${prefix}-stop` order and resubmit a GTC stop for `shares_remaining` at `pos.entry`.

### 4. Retire the daily-candle stop simulation
- Stops/TPs are now real Alpaca orders, so drop the "scan prior-day low/high → market-close next open" logic. Instead `syncPositions` detects Alpaca fills and books them at the real fill price (fixes the ~$43 over-booking seen on UNH, which used the stop *level* not the fill). PDT-immune scaffolding can be removed.

### 5. TP2 (remaining 50%)
- Keep existing TP2 behaviour (RSI continuation / `tp2TimeoutDays` timeout). With the stop already at breakeven after TP1, the runner cannot lose. Optionally also rest the TP2 exit, but not required for v1 of this change.

### 6. OCO note
- A clean Alpaca `oco` bracket assumes equal qty on both legs; here the stop is full-size and TP1 is 50%, so they don't map to a single OCO. **Manage two independent GTC orders** (full stop + 50% TP1 limit) and reconcile each run (cancel stale TP1, shrink stop qty + move to breakeven after TP1). Document this.

### 7. Account-size guard (pre-LIVE only — defer, but spec)
- When `tradingMode === 'live'`: before any entry, `getAccount()` and compare equity to `CONFIG.accountUsd`; if divergence > 10%, **halt + alert** (prevents the $100k-vs-real-account oversizing that caused the original UNH concern). Skip for paper.

---

## Verification plan (before merge to main)
1. **Unit test** `rsi-target-price.js` (append computed price → RSI ≈ 50, both directions). Already passing; commit the test.
2. **Paper smoke test** via `workflow_dispatch`: confirm that for the open position a resting **stop** and a resting **TP1 limit** appear in Alpaca's order list at sensible prices.
3. **Sizing check:** trigger an entry (or dry-run the sizer) and confirm a new position is ~10% of $30k (~$3k notional), not $10k.
4. **Full-cycle watch:** confirm that when the TP1 limit fills intraday, the bot books it at the real fill price and moves the stop to breakeven on the runner.

## Caveats to flag to Alan
- **Behaviour vs backtest:** v2.1 stats (64.9% WR etc.) were measured on **close-based** RSI-50 exits. Touch-based intraday fills will deviate — generally *more* TP1 captures (good, less round-tripping), occasionally a wick-fill that would have reversed. Re-baseline expectations.
- **Legacy GOOG** position is $100k-sized; let it close naturally.
- Watchlist and entry filters (RSI 70, 45/55 no-go, weekly-direction, earnings/PPI windows) are unchanged.

## Why this is a hand-off, not done in-session
The repo is mounted via OneDrive, which blocks git write ops (commit/worktree/prune fail "Operation not permitted"); a worktree attempt corrupted local `.git/config` (rebuilt). Do this in a session with normal git on `origin/main`. Suggested branch: `claude/sid-v2.2-resting-tp`.
