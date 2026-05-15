# SID Roadmap — Future Tools & Strategies

Captured here so we don't lose context between sessions. None of this is
built yet. Each section has enough detail for a future session to start
implementation immediately.

Last updated: 2026-05-15

---

## Tool: SID Scout (Perplexity-backed candidate research)

**Goal:** broaden the universe of tickers SID monitors *without* polluting
the curated REFINED 47 trade list. New tickers are surfaced as
**candidates** — the user manually decides whether to add them to the
active watchlist.

### How it works

A new script `SID/sid-scout.js` (or `.py`, TBD) runs on cron alongside
the daily scanner:

1. **Pull extreme-RSI tickers from a broader universe:**
   - S&P 500 (505 tickers)
   - NASDAQ 100 (100)
   - Top 50 ETFs by AUM
   - Top 50 stocks by daily volume
   - De-dupe to ~600 unique symbols
2. **Run RSI(14) + RSI(3) on daily bars** for each. Filter to:
   - Long candidates: RSI(14) < 30 AND RSI(3) < 30
   - Short candidates: RSI(14) > 75 AND RSI(3) > 75
3. **Apply weekly trend filter** (50/200 SMA) so only directionally-valid
   setups remain.
4. **Cross-reference each survivor with Perplexity:**
   - Recent news catalysts (earnings beat/miss, downgrades, etc)
   - Sector sentiment
   - Major upcoming events in the next 14 days
5. **Score each candidate** on a 0-10 conviction scale:
   - High RSI extremity (deeper oversold = higher score)
   - Clean news (no major bad catalyst)
   - In a sector trending the right way
   - Has enough liquidity (>1M avg daily volume)
6. **Output:**
   - JSON file `SID/candidates-{date}.json` — for dashboard consumption
   - New "Candidates" tab on the SID dashboard
   - Telegram alert with top 3 candidates of the day
   - **User decides whether to add to watchlist-sid.json manually**

### Why not auto-add to watchlist?

The REFINED 47 list took 5 years of backtest data to validate. Adding a
new ticker dilutes that statistical baseline. The Scout's job is
**discovery**, not **decision** — show high-probability setups, let the
trader inspect them on the chart, then add the winners (or not).

### Implementation estimate

- ~1 session of work
- Reuses existing yfinance + scanner infrastructure
- Perplexity API key needed (you already have one for the Ironclad research)
- New dashboard tab via additive change to `sid-dashboard.js`

### When to build

After v1.6 has 2-3 weeks of live paper-trading data. Avoid changing
multiple things at once.

---

## ⚠️ Important constant — SID's TP is sacred

**SID's take profit is locked at daily RSI(14) reaching 50.** This is
a non-negotiable instructor rule (project policy in memory). Every
future strategy below is **ADDITIVE** to SID — none of them modify
SID's rules. SID and any new strategy run in parallel on the same
account, never overlapping or replacing each other.

---

## Strategy: Supply & Demand (lightly described — needs full spec)

User briefly mentioned this — uses day/week trend detection to mark
supply and demand zones from impulsive moves at exhaustion price
levels. Trades fire when price returns to those zones.

**Status:** concept only — no entry rules, stop rules, or TP rules
have been provided yet. Cannot be built without more detail from the
user (and ideally instructor source material).

**When ready, user owes me:**
- Mechanical definition of "impulsive move" and "exhaustion"
- Zone construction rules (which bars, how wide)
- Entry triggers within zones
- Stop placement rules
- TP rules
- Sample charts marked up by instructor
- Win rate evidence over a meaningful sample

---

## Strategy: "Strategy X" (TBD — the 70%+ WR, 2:1-10:1 RR one)

This is a **separate** strategy the user mentioned — distinct from
Supply & Demand. Closes the gap from SID's ~25% annual return to the
40% target.

**What I know so far (per user 2026-05-15):**
- 70%+ historical win rate per the instructor
- Min 2:1 reward:risk, up to 10:1 depending on reversal strength
- More complicated than SID — will take time to perfect
- Parked for a few weeks until SID v1.6 has live data

**What I don't know:**
- Everything else. Rules, indicators, signal logic, stop placement, TP
  scaling — all TBD.

**When user is ready to describe it, I need:**
- The actual rules (entry, exit, stop, TP scaling)
- How it determines "reversal strength" that justifies the variable RR
- Backtest validation criteria from the instructor's evidence

Once spec'd, build process is identical to SID:
1. Python backtest harness with isolated variants
2. Validate on 5-year window across watchlist tickers
3. Implement in bot + Pine if backtest clears threshold
4. Tag previous version for revert before shipping

---

## How the strategies will coexist

When both SID v1.6 and "Strategy X" (and possibly Supply & Demand) are
running, they share:

- **Same Alpaca account** — but they tag their own orders via distinct
  `client_order_id` prefixes (e.g. `SID-AAPL-…` vs `SX-AAPL-…`) so we
  can reconcile per-strategy P&L afterwards.
- **Same dashboard** — separate sections per strategy (open positions,
  closed P&L, signals).
- **Same Telegram alerts** — but each message tagged with the strategy
  name in the header.
- **Independent position sizing** — each strategy risks its 2% of total
  equity, so concurrent positions could put up to 4-6% at risk if all
  three strategies fire simultaneously. We'll need a portfolio-level
  cap (e.g. max 5% total risk across all strategies combined).

The "max total risk" cap is the only architectural change that needs
to happen before adding a second strategy. Worth flagging now so we
build it correctly the first time.

---

## Other backlog items (low priority)

- `sid-scanner.pine` — multi-symbol TradingView indicator that scans the
  watchlist on a single chart pane. Visual replacement for the JSON
  scanner. Lower priority because the dashboard already shows scanner
  state.
- **Ironclad fixes** — user owns. Bitget reconcile work needs a fresh
  XLS export from 7 May.
- **Two-way Telegram bot** — `/close AAPL` style commands to manually
  close positions from the phone. Future feature only if the read-only
  alerts prove insufficient.
