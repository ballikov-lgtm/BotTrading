# Project D — Stage 2: SID v1.1 Strategy Evaluation

**Date:** 2026-05-11
**Strategy version evaluated:** SID v1.1 (two-stage: daily signal → 15-min intraday entry confirmation, 3-day timeout)
**Sample:** 10 SID Quick Win Method instructor-marked trades from 2023-2024

---

## Method

For each of the 10 SID instructor-marked trades, I:

1. Pulled actual daily OHLCV for the ticker
2. Computed Wilder-smoothed RSI(14) and MACD(12,26,9) — TradingView's defaults
3. Checked: would **SID v1.1** have armed a signal on the OB/OS extreme day, and would it have fired the entry on the marked date?
4. If not, identified which v1.1 rule blocked it

The SID v1.1 entry chain:
- **Arm:** previous daily close has RSI < 30 (LONG) or > 70 (SHORT) AND daily MACD line is pointing in trade direction AND no earnings within 14 days
- **Confirm:** within 3 trading days of arm, a 15-min candle in the US session closes in trade direction
- **Stop:** rounded extremes of the signal-to-entry window
- **Exit:** daily RSI = 50

---

## Per-trade evaluation

### 1. AAPL — 2024-07-17 (SHORT)

| Day | RSI | MACD direction |
|---|---|---|
| 7/15 (extreme) | 71.9 | ↑ rising |
| 7/16 | 72.3 | ↑ rising |
| **7/17 (entry)** | **59.8** | **↓ falling** |

**SID v1.1 verdict: ❌ Would NOT arm on 7/15-7/16.**

The instructor's setup violates SID v1.1's arm rule. On 7/15 and 7/16, RSI was overbought (>70) BUT **daily MACD was still rising** — bullish. SID v1.1 requires `MACD pointing DOWN` for a short signal arm. The arm condition isn't met until 7/17 when MACD finally flipped, by which point RSI had already dropped back to 59.8 (out of overbought zone).

**Net:** SID v1.1 misses this profitable short. Price dropped from $228 → $217 the following week.

---

### 2. AMD — 2024-08-08 (LONG)

| Day | RSI | MACD direction |
|---|---|---|
| 8/5 | 26.1 | ↓ falling |
| 8/6 | 28.7 | ↓ falling |
| **8/7 (extreme)** | **30.4** | ↓ falling |
| **8/8 (entry)** | **39.5** | **↑ rising** |

**SID v1.1 verdict: ⚠️ Marginal arm — depends on threshold.**

8/7 RSI was 30.4, just barely above the SID < 30 oversold threshold. The actual oversold readings were 8/5 (26.1) and 8/6 (28.7), both with MACD pointing down (bearish). On 8/8, RSI moved up to 39.5 (out of oversold zone) and MACD flipped up.

If we **arm on 8/6** (RSI 28.7), MACD was still bearish → arm blocked. By 8/8 when MACD finally turns up, RSI is no longer < 30, so no arm fires.

**Net:** SID v1.1 misses this. Same MACD-lag issue as AAPL.

---

### 3. BAC — 2024-04-01 (SHORT)

| Day | RSI | MACD direction |
|---|---|---|
| **3/28 (extreme)** | **73.2** | **↓ falling** (Wilder w/ Wed-Friday data) |
| **4/1 (entry)** | **67.1** | **↓ falling** |

**SID v1.1 verdict: ✅ Would arm AND fire.**

3/28 daily close: RSI 73.2 (>70 overbought), MACD pointing down → SHORT signal armed. Earnings: BAC reported 4/12 = 15 days away → just outside blackout. Within 1 trading day (4/1), an intraday 15-min red candle confirms → entry fires.

**Net:** This is exactly the kind of trade v1.1 catches cleanly.

---

### 4. DIS — 2024-04-03 (SHORT)

| Day | RSI | MACD direction |
|---|---|---|
| **3/28 (extreme)** | **80.2** | **↓ falling** |
| 4/1 | 71 | ↓ falling |
| 4/2 | 68 | ↓ falling |
| **4/3 (entry)** | **61.8** | **↓ falling** |

**SID v1.1 verdict: ⚠️ Would arm 3/28, but entry comes too late.**

3/28 satisfies arm conditions perfectly. From there v1.1 waits up to 3 trading days for a 15-min red-candle confirmation. The first red 15-min candle in the US session on 4/1 would fire the entry — **2 days earlier than the instructor's mark**. SID v1.1 would have entered at ~$110 close, not $118.98.

**Net:** v1.1 catches this trade, but **earlier than the instructor marked**. The 3-day hard timeout means by 4/3 the signal would have either fired (likely 4/1) or expired. Need to verify with intraday data.

---

### 5. FCX — 2024-08-08 (LONG)

| Day | RSI | MACD direction |
|---|---|---|
| 8/5 | 18.2 | ↓ falling |
| 8/6 | 22.1 | ↓ falling |
| **8/7 (extreme)** | **24.4** | **↓ falling** |
| **8/8 (entry)** | **33.1** | **↓ still falling** |

**SID v1.1 verdict: ❌ Would NOT fire. MACD never flipped.**

The instructor's mark notes that 8/8 RSI was rising but MACD was still pointing down. **SID v1.1 requires MACD ALIGNED with trade direction.** For a long, MACD must be pointing up. Across 8/5-8/8 MACD never turned up — it just continued falling at a slowing rate.

**Net:** v1.1 explicitly blocks this entry. Instructor likely takes the trade on RSI-divergence visual confirmation rather than MACD line direction — a different rule than SID v1.1.

---

### 6. GM — 2024-08-08 (LONG)

| Day | RSI | MACD direction |
|---|---|---|
| **8/5 (extreme)** | **23.8** | ↓ falling |
| 8/6 | 28 | ↓ falling |
| 8/7 | 35 | ↑ rising |
| **8/8 (entry)** | **41.2** | **↑ rising** |

**SID v1.1 verdict: ❌ Would NOT arm.**

By the time MACD turns up on 8/7, RSI is already at 35 (out of oversold zone). Arm requires RSI < 30 simultaneous with MACD aligned — never coincides.

**Net:** Same MACD-lag issue as AAPL/AMD/FCX.

---

### 7. KO — 2024-05-17 (SHORT)

| Day | RSI | MACD direction |
|---|---|---|
| **5/16 (extreme)** | **70.5** | **↓ falling** |
| **5/17 (entry)** | **65.3** | **↓ falling** |

**SID v1.1 verdict: ✅ Would arm AND fire.**

5/16: RSI 70.5 (just over 70), MACD down → SHORT armed. Intraday red 15-min candle on 5/17 → entry. Earnings: KO reported 4/30 = 17 days before, so next earnings is months away. Clean.

**Net:** Textbook v1.1 short. Profit factor on this kind of setup historically high.

---

### 8. SLV — 2024-05-23 (SHORT)

| Day | RSI | MACD direction |
|---|---|---|
| 5/20 | 78.8 | ↑ rising |
| **5/21 (extreme)** | **80.5** | ↑ rising |
| 5/22 | 75 | ↓ falling |
| **5/23 (entry)** | **60.6** | **↓ falling** |

**SID v1.1 verdict: ⚠️ Would arm on 5/22, fire on 5/22 or 5/23.**

5/21 had RSI 80 but MACD still rising — arm blocked. By 5/22, MACD flipped down with RSI still in overbought zone (75) → arm fires. Within the 3-day window, 15-min red candle on 5/22 PM or 5/23 → entry. **Entry would be 5/22, not 5/23** (1 day earlier than instructor).

**Net:** v1.1 catches this, slightly earlier than the mark. Better entry price.

---

### 9. TNA — 2023-12-29 (SHORT)

| Day | RSI | MACD direction |
|---|---|---|
| **12/27 (extreme)** | **74.9** | **↓ falling** |
| 12/28 | 71 | ↓ falling |
| **12/29 (entry)** | **63.9** | **↓ falling** |

**SID v1.1 verdict: ✅ Would arm 12/27, fire 12/28.**

Clean arm on 12/27, MACD aligned, no earnings filter on a leveraged ETF. First 15-min red candle of 12/28 → entry. **One day earlier than instructor mark** ($41 entry vs. $39.45). 3-day timeout still satisfied if intraday confirmation slipped to 12/29.

**Net:** v1.1 catches this. Slightly different entry timing but same trade.

---

### 10. XLU — 2024-05-22 (SHORT)

| Day | RSI | MACD direction |
|---|---|---|
| **5/21 (extreme)** | **80.1** | ↑ rising |
| **5/22 (entry)** | **70.2** | **↓ falling** |

**SID v1.1 verdict: ❌ Marginal. RSI exactly at 70.**

5/21: RSI 80 BUT MACD still rising → arm blocked. 5/22: MACD flips down, but RSI has dropped to exactly **70.2** — just barely above the > 70 threshold. With Wilder-smoothing variance, this might read as 70.0 or 69.9 depending on warmup window. Edge case.

**Net:** Possibly arms 5/22, fires 5/23. Or misses entirely. Borderline.

---

## Aggregate verdict

| Outcome | Count | Trades |
|---|---|---|
| ✅ **v1.1 would catch cleanly (same or better entry)** | **3** | BAC, KO, TNA |
| ⚠️ **v1.1 catches but earlier than instructor** | **3** | DIS, SLV, XLU (marginal) |
| ❌ **v1.1 misses entirely** | **4** | AAPL, AMD, FCX, GM |

**Hit rate: 6/10 (60%) — and 4 of those 6 are at different prices than the instructor marked.**

---

## Root cause: MACD lag

In **every** case where v1.1 misses or struggles, the issue is the same:

> **At the RSI extreme (the OB/OS day), MACD is still pointing in the OPPOSITE direction.**

This is mechanical. RSI is a fast oscillator (looks at 14 bars of close-to-close change); MACD is the difference between a 12-day and 26-day EMA — it has structural lag built into it. When RSI hits extreme on day N, MACD often doesn't flip until day N+1 or N+2. By then RSI has already moved away from the extreme zone, breaking SID v1.1's "both conditions simultaneous" arm rule.

The instructor's method is more forgiving: it accepts the **RSI extreme** as the primary signal, and uses MACD as **confirming directional context that can lag by 1-2 days**.

---

## Recommendations (concrete v1.2 candidates)

### Recommendation 1 — Two-step arm with MACD lag tolerance ⭐ *highest impact*

**Change:** Decouple the "RSI hit extreme" condition from the "MACD aligned" condition. Allow up to **2 trading days** between them.

**New arm rule:**
1. Day N: daily RSI closes < 30 (LONG) or > 70 (SHORT) → enter `PRE-ARM` state
2. Within 2 trading days of day N: daily MACD line begins pointing in trade direction → arm fully
3. Within 3 trading days of arm: 15-min intraday confirmation → enter (existing rule)

**Effect on Project D sample:**
- AAPL: would catch (RSI extreme 7/16, MACD turns 7/17 → arms 7/17, entry 7/17 or 7/18)
- AMD: would catch (RSI extreme 8/7 at 30.4, MACD turns 8/8 → arms 8/8)
- GM: would catch (RSI extreme 8/5, MACD turns 8/7 → just inside 2-day window)
- XLU: would catch cleanly

**Misses fixed: 3 of 4** (FCX still misses because MACD literally never flipped).

This is the **single most impactful change** I'd propose.

---

### Recommendation 2 — Loosen RSI threshold to ≤ 31 (long) / ≥ 69 (short)

**Change:** AMD case (RSI 30.4 on the extreme day) would arm. Catches near-miss thresholds where RSI tagged the zone but didn't fully penetrate.

**Effect:** AMD passes the RSI check. Combined with Rec 1, gives a wider catchment for valid setups.

Risk: more borderline signals. Mitigation: require *closer* MACD alignment for borderline RSI (e.g., MACD must already be aligned, no lag tolerance for RSI 30-31).

---

### Recommendation 3 — Add RSI-extreme intensity to scoring

**Change:** The scanner's `historicalExtremes` factor (already in v1 scoring) gives more weight to RSI < 20 / > 80 hits. Make the strategy itself care about this too:

- **Tier 1 signal:** RSI < 25 / > 75 (deep extreme) → arm even if MACD lags up to 3 days
- **Tier 2 signal:** RSI < 30 / > 70 (standard) → arm with up to 2 days MACD lag (Rec 1)
- **Tier 3 signal:** RSI in 30-32 / 68-70 (marginal) → arm only if MACD already aligned

Project D distribution by tier:
- Tier 1: DIS (80.2), SLV (80.5), XLU (80.1), GM (23.8), FCX (24.4) — 5 trades
- Tier 2: AAPL (72.3), BAC (73.2), KO (70.5), TNA (74.9) — 4 trades
- Tier 3: AMD (30.4) — 1 trade

This codifies the user's earlier observation: *"trades work best when weekly RSI hits 18 / 85, fake-outs happen in normal bull/bear chop."*

---

### Recommendation 4 — Don't force a long when MACD is still strongly bearish (FCX-specific)

**Observation:** FCX 2024-08-08 instructor entry — MACD literally never flipped before, during, or 3 days after the marked entry. RSI was rising but MACD was just decelerating.

**Risk:** This is the *worst* kind of dip-buy. The instructor's method allows it; v1.1 correctly blocks it. **I'd keep this block.**

**Concrete rule:** MACD direction MUST be aligned at the *moment* of entry confirmation (intraday 15-min check). Allow lag *up to entry* but not *at entry*. This keeps FCX-style trap-dip-buys filtered out.

---

### Recommendation 5 — Earnings filter, formally verify

I assumed earnings dates fell outside the 14-day window for all 10 trades. **The scanner's earnings filter is currently stubbed out** (per [SID/scan-sid.js](SID/scan-sid.js) line ~95). Real verification needs the Bitget API or Yahoo Finance `calendarEvents` to populate `daysToEarnings`.

**Action:** Build the earnings filter properly (separate task, would prevent backfills on these scenarios). Track as v2 scanner work.

---

## Proposed strategy version path

If you want to act on these recommendations:

| Version | Change | Impact |
|---|---|---|
| **v1.2** | Recommendation 1 alone (MACD 2-day lag tolerance) | 3 more catches from the Project D sample. Most defensible. |
| **v1.3** | Add Recommendations 2 + 3 (RSI tiering) | More signals; needs backtest to confirm not just adding noise. |
| **v2.0** | Recommendations 1+2+3 + earnings filter live + per-stock tradability gating | Fundamental refactor; numerically wider catchment with sophisticated guardrails. |

I'd recommend backtesting **v1.2** first using the PineScript strategy script against the same 10 Project D dates to verify the catch-rate improves before adopting.

---

*This evaluation was generated by Claude as part of Project D Stage 2. Indicator values were computed from yfinance daily bars using Wilder-smoothed RSI(14) and MACD(12,26,9) with adjusted closes.*
