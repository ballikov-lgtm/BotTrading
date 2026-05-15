# SID Strategy Audit — Video Transcripts vs Our Implementation

Source material: `C:\Claude Standalone\resources\Video Transcripts\SID Strategy\transcripts\`
4 sections, multiple episodes each.

Purpose: Identify gaps between the instructor's stated rules (from video
transcripts) and what we've built (`bot-sid.js`, Pine, current ship versions).
Resolution: Either patch our implementation, or document why we deliberately
deviated.

---

## 🎯 USER-CONFIRMED AUDIT PRIORITIES (2026-05-15)

User stated the three areas where our model most likely diverges from the
instructor's actual rules:

1. **Confirmation method** (highest priority) — what EXACTLY triggers entry?
   We use `daily RSI > yesterday AND daily MACD > yesterday`. Possible
   alternatives: MACD cross of signal line, specific candle pattern, weekly
   confirmation, intraday confirmation, etc.

2. **RSI overbought level** — we use 75 (raised from 70 in v1.3 based on
   backtest). Need to verify what the instructor actually teaches. May be
   70 with a different confirmation rule that makes it work.

3. **Blackout rules** — verify what the instructor explicitly teaches:
   - **Earnings**: confirmed = 14-day pre-only. Verify exact window and
     "day after" rule.
   - **PPI / CPI / FOMC / FOMC minutes**: these are OUR inferences from
     "news events" guidance. Verify which specific event types the
     instructor calls out by name.
   - **VIX gate**: NOT directly taught by the instructor (per user
     clarification). VIX is OUR mechanical proxy for what manual traders
     can do via discretion ("don't trade today, there's a Fed event /
     war / crash news"). Audit task: verify the SPIRIT matches — i.e.
     instructor says "avoid trading on bad news days" and our VIX gate
     approximates "today's macro environment is fearful = bad news day."
     The mechanism is different (VIX vs reading the wire); the intent
     is the same.

### Architectural insight on this audit

The 19pp WR gap between community-claimed 77% and our 57.8% backtest may be
substantially explained by:

  - **Manual traders discretionarily skip** signals on bad-news days,
    pre-earnings/Fed days, geopolitically tense days, etc.
  - **Backtests can't replicate this** — they fire on every signal.
  - **VIX gate is the best mechanical substitute** but cruder than human
    judgment.

Our improvements (RSI 75, PPI blackout, VIX gate) are all attempts to
MECHANIZE discretionary filters the instructor's human students apply
naturally. The audit should confirm we're targeting the right intent,
even when our mechanism differs.

Other rules (stop = signal-day low/high rounded, TP = RSI 50 full exit, 2%
risk, position sizing formula) are believed correct but will still be checked.

---

## Transcript inventory

Will be updated as new transcripts land. Mark each `audited` once reviewed.

| File | Status | Topic | Key findings |
|---|---|---|---|
| `S1_EP1_Watchlist.txt` | ✅ scanned (no strategy content) | Watchlist intro | Setup only |
| `S1_P2_Market_Indices.txt` | ✅ scanned (no strategy content) | DIA/SPY/QQQ/IWM definitions | Setup only |
| `S1)Ep3_Stocks  ETFs.txt` | ✅ scanned (no strategy content) | Stocks + ETFs to include | **Watchlist gap**: FedEx (FDX) is in instructor's recommended stocks but in our `all_monitor_only` not active list |
| _(more arriving)_ | ⬜ pending | | |

---

## Section-by-section audit (populated as we go)

### Section 1 — Setup (watchlist, indices, sector ETFs)

What we expect this section covers: how to build a watchlist, why those
specific tickers, sector coverage, how to add ad-hoc trades.

**Gaps found:** (TBD as transcripts process)

**Our implementation:**
- Watchlist: 80 tickers (REFINED 47 + 32 tier1 expansion)
- Stored in `SID/watchlist-sid.json`
- Auto-loaded by bot at runtime

### Section 2 — (likely Strategy / Entry Rules)

What we expect: RSI thresholds, MACD setup, weekly confirmation, signal-to-entry rules.

**Gaps found:** TBD

**Our implementation (v1.7):**
- Stage 1 ARM: Daily RSI(14) < 30 (long) or > 75 (short) + RSI(3) confirmation + weekly 50w > 200w
- Stage 2 TRIGGER: Daily RSI direction + Daily MACD direction
- 3-day sticky arm window
- VIX ≥ 30 daily gate (v1.7 addition)
- Earnings 14-day pre-blackout, PPI 14-day pre-blackout

### Section 3 — (likely Risk Management / Position Sizing)

What we expect: Account sizing, % risk per trade, stops, position caps,
diversification rules.

**Gaps found:** TBD

**Our implementation:**
- Account: $10K assumed (user planning $20K after 3 months paper)
- Risk: 2% per trade ($200 fixed)
- Position cap: 10% of account (live bot only; backtest does not cap)
- Max 3 concurrent positions
- Stop: lowest low (long) / highest high (short) between signal & entry, rounded DOWN/UP to whole dollar
- Exit: daily RSI(14) reaches 50, full exit, no partials

### Section 4 — (likely Advanced / Trade Management / Psychology)

What we expect: When to skip trades, news avoidance, drawdown rules,
trade journaling, mindset.

**Gaps found:** TBD

**Our implementation:**
- No discretionary skip logic (bot fires mechanical)
- VIX gate at 30 (v1.7) covers high-fear regimes
- Earnings + PPI macro blackouts
- Open trade limit (3) caps exposure
- No trade journal / sentiment overlay

---

## Specific gaps to look for (hypotheses from current data analysis)

These are the spots where our 57.8% backtest WR most likely differs from the
community-claimed 77% WR. Listen for explicit instructor guidance on each.

### 🔴 HIGH-PROBABILITY GAPS

#### 1. Trigger candle/timing
- **Current**: We enter on daily close when `today_RSI > yesterday_RSI AND today_MACD > yesterday_MACD`.
- **Possibly different in video**: Enter on next-bar open? Wait for a green candle that closes ABOVE prior high? Wait for MACD line to cross signal line (not just be rising)?

#### 2. Weekly confirmation interpretation
- **Current**: `50w > 200w` (lagging position check). Almost never blocks trades.
- **Possibly different**: 50w SLOPE pointing in trade direction (much stricter — would block GM Oct 2022 + many similar). Or weekly RSI rising. Or weekly price > 50w SMA.

#### 3. RSI period
- **Current**: 14-bar Wilder smoothing (TradingView default).
- **Possibly different**: 9? 7? Different smoothing?

#### 4. MACD direction definition
- **Current**: Just `today's MACD > yesterday's MACD` (line going up).
- **Possibly different**: MACD line CROSSING above signal line (proper crossover)? MACD histogram turning positive (>0)?

#### 5. RSI(3) period
- **Current**: 3-bar RSI as rebound-zone confirmation.
- **Possibly different**: Some other short-period RSI (5? 7?) with different threshold

### 🟡 MEDIUM-PROBABILITY GAPS

#### 6. Signal-to-entry timing
- **Current**: 3-day sticky window from signal day.
- **Possibly different**: Tighter (1-2 days = freshness matters more)? Looser (5+ days)?

#### 7. Volume confirmation
- **Current**: None.
- **Possibly different**: Require volume spike on the trigger candle? Volume > X-day average?

#### 8. Sector/index alignment
- **Current**: None.
- **Possibly different**: Require corresponding sector ETF (e.g. XLK for tech stocks) to also be bullish?

#### 9. Pattern recognition on trigger candle
- **Current**: None — any rising RSI+MACD qualifies.
- **Possibly different**: Require a specific candle pattern (engulfing, hammer, marubozu)?

### 🟢 LOW-PROBABILITY GAPS (but worth checking)

#### 10. Discretionary skip rules
- E.g. "If the signal day has unusually wide range, skip"
- "If the stock is gapping at open, skip"
- These can lift live trading WR but cannot be modeled in a mechanical backtest

#### 11. Re-arming after expired signal
- **Current**: After 3-day timeout, arm cancels and waits for a NEW signal day.
- **Possibly different**: Continuous re-arming as long as RSI stays in extreme?

#### 12. Sizing differently per setup quality
- **Current**: Flat 2% per trade.
- **Possibly different**: Higher % risk on high-conviction setups?

---

## Resolution decisions

For each gap found, we'll record:

```
GAP: [description]
  Video says: "..." (quote from transcript, episode + timestamp)
  We built: [current behaviour]
  Recommendation: [match the video / keep our deviation with reasoning]
  Estimated impact on WR: [%]
```

This file gets updated commit-by-commit as gaps are found and resolved.

---

## Audit completion checklist

- [ ] All transcripts present (currently 2/?)
- [ ] All transcripts read and indexed
- [ ] Section 1 (setup) audited
- [ ] Section 2 (likely strategy) audited
- [ ] Section 3 (likely risk) audited
- [ ] Section 4 (likely advanced) audited
- [ ] Gap analysis written for each identified discrepancy
- [ ] User reviews findings and decides which to ship
- [ ] Implementation patches drafted for accepted gaps
- [ ] v1.8 (or v2.0) shipped with audit-derived changes
- [ ] Backtest re-run to validate gap-closing impact
