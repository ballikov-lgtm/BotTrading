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

## Tool: SID Sentinel + Telegram Control (Railway service)

**Goal:** continuous intraday safety net for SID — both autonomous
(VIX/SPY panic detection) AND interactive (you send `/close_all` from
your phone on holiday, the bot executes via Alpaca).

User specifically flagged this when discussing v1.7 VIX gate (which
only checks once per day at 9:35am ET). The daily check is a
PREVENTION mechanism. The Sentinel is the REACTION mechanism — covers
the gap when news hits intraday and stops would be slipped, OR when
you're away from a terminal and need a remote kill-switch.

### Architecture

Single Node.js service running on Railway (alongside Ironclad-runner —
shared infrastructure, no extra hosting cost). Two concurrent loops in
the same process:

```
┌─────────────────────────────────────────────┐
│           SID Sentinel (Railway)            │
├─────────────────────────────────────────────┤
│  Loop A — Market Monitor (every 60s)       │
│    Poll VIX + SPY                          │
│    Apply tier rules (LONGS ONLY for auto): │
│      VIX 30-35: log only                   │
│      VIX 35-40: Telegram warning           │
│      VIX > 40:  auto-close LONGS + alert   │
│      SPY -3% in 30min: auto-close LONGS    │
│      (SHORTS LEFT ALONE — they're winning) │
│                                             │
│  Loop B — Telegram Listener (long-polling) │
│    Accept commands from authorised user:   │
│      /status                               │
│      /positions                            │
│      /close <SYMBOL>                       │
│      /close_longs   (defensive close all   │
│                      longs, keep shorts)   │
│      /close_shorts  (rare — manual override) │
│      /close_all     (nuclear — both sides) │
│      /pause         (manual VIX gate)      │
│      /resume                               │
│      /vix           (current VIX value)    │
│      /help                                 │
│                                             │
│  Shared: Alpaca client + state file        │
└─────────────────────────────────────────────┘
```

### Why auto-close LONGS only (critical design choice)

Panic regimes are **bearish by definition** — VIX spikes because options
traders are pricing in big DOWNSIDE moves. Implications per position
side:

| Position | During panic | Action |
|---|---|---|
| **Long** | Price moving AGAINST us | Close — preserve capital |
| **Short** | Price moving WITH us | **HOLD — let it earn** |

Auto-closing a profitable short during a panic crash would cash out
exactly at the moment it's supposed to deliver. Two scenarios where
this matters:

1. **Trend short caught right.** SID shorts on overbought reversals.
   If we shorted at top of bounce and crash hits → we're up big →
   closing prematurely sacrifices the strategy's whole point.

2. **Tail-risk hedge.** SID's short trades naturally hedge the long
   book. During panic, the short book is the only thing earning
   while longs are stopping out. Closing both = double-damage.

The `/close_all` command stays available as a NUCLEAR option for the
trader's discretion (e.g. "I want flat exposure for the weekend
ahead of an election") but it's manual + requires confirmation.

### Why the v1.7 daily VIX gate is fine staying side-agnostic

The daily gate blocks NEW ARMING. SID short signals fire when:
  - Daily RSI > 75 (overbought)
  - Weekly 50-SMA < 200-SMA (weekly downtrend)
  - RSI(3) > 75 (rebound-zone confirm)

During VIX-spike panic, the universe is OVERSOLD not overbought, so
short signals are mechanically rare anyway. Blocking them costs
almost nothing in practice. Keeping the gate simple (side-agnostic)
keeps the code simple.

### Toggle config (env vars on Railway)

```env
# Master switch
SID_SENTINEL_ENABLED=true
SID_SENTINEL_TELEGRAM_CONTROL=true

# Market-monitor thresholds (auto-close = real money risk)
SID_SENTINEL_VIX_WARN=33
SID_SENTINEL_VIX_PANIC=40
SID_SENTINEL_SPY_DROP_PCT=3
SID_SENTINEL_SPY_DROP_WINDOW_MINS=30

# Behaviour
SID_SENTINEL_AUTO_CLOSE=false   # start in alert-only mode
SID_SENTINEL_POLL_SECONDS=60

# Telegram auth — only this chat_id can issue commands
TELEGRAM_AUTHORIZED_CHAT_IDS=123456789
```

### Safety patterns

- **Destructive commands require confirmation.** `/close_all` →
  "Reply YES within 60s to confirm" → no reply, no action.
- **Idempotency.** If Telegram delivers the same message twice (network
  hiccup), the second one is rejected by message ID.
- **Audit log.** Every command + response written to a log file on
  Railway, also forwarded to a "audit" Telegram channel if desired.
- **Auto-close OFF by default.** Initial deployment is alert-only.
  User flips `SID_SENTINEL_AUTO_CLOSE=true` after testing.
- **Heartbeat.** Every 15 min, post "still alive" to a private channel
  so you know Railway hasn't died silently.

### Build order when we get there

1. **Phase 1 (alert-only Sentinel):** Market monitor loop with
   thresholds. No Telegram commands yet. No auto-close.
   Just: "VIX hit 35, Joe — heads up."
2. **Phase 2 (Telegram listener):** Accept `/status`, `/positions`,
   `/vix`, `/help` — read-only commands first. Test auth flow.
3. **Phase 3 (closures via Telegram):** Add `/close`, `/close_all`,
   `/pause`, `/resume` with confirmation flow.
4. **Phase 4 (auto-close):** Flip `SID_SENTINEL_AUTO_CLOSE=true`.
   Sentinel acts unilaterally on panic-tier signals.

Build time estimate: 1 focused session for Phase 1+2, second session
for Phase 3+4 with proper testing.

### When to build

After SID v1.7 has 30+ days of live paper trading data. We want to see
how often v1.7's daily VIX gate actually triggers in practice before
investing in continuous monitoring. If the gate is firing often enough
to matter, Sentinel becomes valuable. If markets stay calm, the
existing broker-level stop orders may be sufficient.

---

## Resources & tools to evaluate

### StockCharts.com (user-flagged 2026-05-15)

URL: https://stockcharts.com

User noted as a potential resource. Worth evaluating for:

| Capability | Use case for SID |
|---|---|
| **Personal dashboard** ("Your Dashboard") | Reference design for our cyberpunk dashboard — layout ideas, chart pane sizing |
| **ChartLists** (managed watchlists) | Equivalent to our `watchlist-sid.json` but with manual curation tools |
| **Pre-built scans** (Predefined Scan library) | Could provide setup ideas to add to SID Scout's universe |
| **SharpCharts API** (Premium) | Possible alternative data source if yfinance becomes unreliable |
| **ChartSchool** (free education) | Reference material for indicator implementations (RSI, MACD details) |
| **ACP (Advanced Charting Platform)** | Alternative chart workspace if TradingView limits hit |

Action items if/when we revisit:
1. Sign up for free account to explore the dashboard UX
2. Check Premium tier API documentation — what data is exposed, rate limits, cost
3. See if ChartSchool's RSI/MACD definitions match ours exactly (Wilder smoothing,
   period defaults) — could be a free way to validate our indicator calculations
4. Test a side-by-side: same ticker, same date, our RSI calc vs StockCharts'
   value. If they match, we have external validation.

Not urgent — evaluation is exploration only. Current data via yfinance is
working fine; this is for "what if" planning.

---

## Other backlog items (low priority)

- `sid-scanner.pine` — multi-symbol TradingView indicator that scans the
  watchlist on a single chart pane. Visual replacement for the JSON
  scanner. Lower priority because the dashboard already shows scanner
  state.
- **Ironclad fixes** — user owns. Bitget reconcile work needs a fresh
  XLS export from 7 May.
