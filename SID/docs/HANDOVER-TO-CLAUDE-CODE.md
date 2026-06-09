# Paste this into Claude Code (run it on the BotTrading repo)

You are working on the BotTrading repo (the SID trading bot). Do the following, then push.

## Task 1 — Ship SID v2.2: intraday resting TP1 + broker stop + $30k compounding sizing
Implement the spec in `SID/docs/RESTING-TP-HANDOFF-BRIEF.md` exactly. In short:

1. Start from latest `main`: `git checkout main && git pull`, then branch `claude/sid-v2.2-resting-tp`.
2. **Sizing → compounding off the internal ledger.** In `SID/bot-sid.js`, at run start set the sizing account to the current internal balance: `CONFIG.accountUsd = loadAccount().accountUsd || 30000`. Keep `riskPct=0.01`, `maxPositionPct=0.10`. (The `SID_ACCOUNT_USD` secret becomes a fallback only.)
3. **Archive, then reset** the ledger. FIRST copy the current `SID/sid-account.json` and `SID/closed-positions-sid.json` into `SID/_v2.1_archive_2026-06-08/` (preserve the v2.1 paper record: 3 trades, realized −$648.84 — do NOT delete it). THEN reset `SID/sid-account.json` to a fresh $30k slate: `{ startingUsd:30000, accountUsd:30000, realizedPnl:0, tradeCount:0, method:"v2.2", mode:"paper", lastUpdated:"<today>", resetReason:"v2.1 paper-validation closed; rebased to $30k compounding for v2.2" }`. Leave the Alpaca paper account ($100k) untouched. Do NOT resize the open GOOG runner — let it close on its existing breakeven stop.
4. **Broker-enforced stop at entry.** In `SID/alpaca-executor.js` `openEntry`, after the market entry submit a GTC stop (opposite side, full qty) at `signal.stopLoss` (the `submitEntryWithStop` helper in `alpaca-client.js` already does this). Store the stop order id on the position.
5. **Resting RSI-50 TP1, recomputed each run.** Use the new module `SID/rsi-target-price.js` (already written & unit-verified): `rsiTargetPrice(closes, 14, 50)` returns the price that makes the next bar's RSI = 50. In `SID/bot-sid.js` `checkPositions`, for each open position with `tp1_hit===false`: compute `tp1Price`, set `tp1Qty = floor(shares_total * tp1Portion)` (50%), and place a GTC **limit** order to close that qty at `tp1Price` (short→buy, long→sell), `client_order_id` `${prefix}-tp1`. If a `-tp1` order already exists at a materially different price (the level drifts daily), cancel and resubmit at the new price.
6. **On TP1 fill** (detect via `listOrders`/`syncPositions`): book the partial at the **actual fill price**, set `tp1_hit=true` + tp1 fields, `shares_remaining -= tp1Qty`, then **move the stop to breakeven** on the runner (cancel `-stop`, resubmit GTC stop for `shares_remaining` at `pos.entry`).
7. **Retire** the old "scan prior-day candle → market-close next open" stop simulation; stops/TPs are now real Alpaca orders booked at real fill prices via `syncPositions`. (PDT no longer a concern — account treated as ≥ $25k.)
8. Keep TP2 (remaining 50%) on the existing RSI-continuation / `tp2TimeoutDays` timeout logic; with the stop at breakeven the runner can't lose.

**Verify before merge — THREE gates, all required:**
1. **Unit test:** run the `rsi-target-price` test (append returned price → RSI ≈ 50) and `node --check` all edited files.
2. **BACKTEST GATE (do NOT skip — this is the go/no-go for the whole change).** The v2.1 baseline (69.5% WR / +$28k / 5y) was measured on **close-based** RSI-50 TP1. Re-run the same 5y / full-universe backtest with the **intraday-touch** TP1 model and compare. Touch model: for each post-entry daily bar, compute the RSI-50 target price from closes up to the PRIOR bar (via `rsi-target-price.js`), then fill TP1 if THIS bar's high (long) / low (short) reaches that price — i.e. simulate the resting limit order. Report WR, profit factor, total PnL, and avg-bars-held side-by-side vs the close-based numbers. **Only proceed if it holds up or improves.** If it degrades (the risk: RSI-50 wicks in chop firing TP1 too early + breakeven scratches on the runner), do NOT ship — fall back to close-based TP1 or add a guard (e.g. require a minimum bars-since-entry before the intraday TP arms, or require the bar to also close beyond RSI 50). Save the comparison to `SID/strategy-test-vault/v2.2-intraday-tp1/`.
3. **Paper smoke-test:** trigger the SID workflow via `workflow_dispatch` (paper) and confirm a resting **stop** and a resting **TP1 limit** appear in Alpaca for the open position at sensible prices.

Only merge to `main` after ALL THREE pass. The plumbing can be built and paper-tested first, but the backtest is what authorises going live.

## Task 2 — Bump the PineScript to match
`SID/pine/sid-strategy-v2.1.pine` is the latest (Pine language `//@version=6`, which is current — leave the language as v6). Create `SID/pine/sid-strategy-v2.2.pine` updating the logic/labels to reflect v2.2 (intraday RSI-50 TP1 partial + breakeven stop on the runner), so the TradingView chart matches the live bot. Update the `shorttitle` and version table cell to "SID v2.2".

## Notes
- This brief was prepared by the Atlas hub session; the intraday-TP design and the `rsi-target-price.js` maths are already proven. Behaviour change vs the v2.1 backtest: TP1 now fills on the intraday *touch* of RSI 50, not the daily close — expect more TP1 captures, occasional wick-fills.
- After pushing + paper-test, reply with a one-line summary so Alan knows it's live.
