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

## Strategy: Supply & Demand (instructor-claimed 70%+ WR)

**Goal:** complementary strategy to SID that closes the gap from ~25% to
the 40% target annual return. Where SID is mean-reversion (buy oversold
bounces), S&D is structural-zone trading.

### Concept (per user's description 2026-05-15)

1. **Identify exhaustion price levels** on day + week timeframes:
   - Tops with impulsive rejection candles
   - Bottoms with impulsive accumulation candles
2. **Mark these as supply (resistance) and demand (support) zones.**
3. **Wait for price to return to these zones** after consolidation
   elsewhere.
4. **Entry at key points within each zone** (specifics TBD with user).
5. **Stop loss tight** — beyond the zone extreme.
6. **Take profit dynamic** — minimum 2:1 RR, can ride up to 10:1 if the
   reversal is strong.

### Key advantage vs SID

SID is **capped at ~2:1 RR by design** (stop at signal-day low, TP at
RSI 50). S&D's variable TP — up to 10:1 — is what closes the return gap.
Even at 70% WR with average 5:1 RR (well below the 10:1 cap), the
expectancy is much higher than SID's.

### Implementation scope (multi-session work, weeks)

1. **Define exhaustion mechanically:**
   - 3-bar reversal pattern with volume spike?
   - ATR-relative impulsive move?
   - Wick-to-body ratio threshold?
2. **Define zone width** (high-low of exhaustion bar? Or extend further?)
3. **Define entry triggers within zone** (limit order? Candle confirm?)
4. **Define stop logic** (just beyond zone? ATR-multiple?)
5. **Define TP rules** (fixed 2:1? Trailing? Structure-based?)
6. **Backtest harness** (Python, like the SID v1.7 one)
7. **Pine + bot integration** once parameters are validated

### When to build

User said "**parked for a few weeks**" after v1.6 has been running live.
Don't start until SID is stable and producing real-money trades for at
least a month.

### Pre-work the user owes me

When ready, user will provide:
- Exact rules from instructor (criteria, entries, stops, TP)
- Sample charts marked up by instructor with annotated zones
- Win rate evidence over a meaningful sample (300+ trades ideally)

Until then, the only thing I should do is keep this spec updated.

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
