# SID V2 Method — Specification

**Status: SPEC ONLY — no code written yet (2026-05-16)**

This document specifies the V2 method, which builds on V1 with the
enhancements from the V2 course transcripts. Tagged baseline of V1 is
`sid-v1-method-baseline` for instant revert if V2 underperforms.

---

## Why two methods?

User took V1 of the SID course previously, which strictly said
*"don't divert from the rules"*. V1 used RSI + MACD direction-align
with simpler weekly confirmation and no pattern recognition.

V2 of the course (what we just audited) adds three layers:
1. Weekly RSI + MACD direction confirmation (replacing simpler weekly check)
2. Daily price pattern recognition (W-bottom, M-top, H&S)
3. Explicit no-go zones (RSI 45-50 for longs, 50-55 for shorts)
4. Advanced TP system (TP1 = RSI 50 or fixed $; TP2 = 50/200 MA)

V1 method (our v1.7 bot) shows 57.8% WR over 5y backtest.
V2 method targets 65-75% WR — the community-claimed band.

**Both methods stay in the codebase** (toggleable via `SID_METHOD` env
var) so we can compare them in live paper trading.

---

## V2 Method — full rule set

### Stage 1: ARM (signal day)

Same as V1:
- Daily RSI(14) < 30 (long signal) OR > 70 (short signal — *NOTE: V2 uses 70 not 75*)
- RSI(3) also in extreme zone (rebound-zone confirmation, V1.3+ addition kept)

### Stage 2: TRIGGER (entry day)

**V2 enhanced trigger requires ALL of:**
- Daily RSI pointing in trade direction (rising for long, falling for short)
- Daily MACD line pointing in trade direction OR crossing signal line
- **NEW: RSI at entry below 45 for longs / above 55 for shorts** (no-go zone filter)
- **NEW: Weekly RSI pointing in trade direction on entry date**
- **NEW: Weekly MACD pointing in trade direction on entry date**
- *Optional bonus: Daily price pattern (W-bottom, inverted H&S for longs; M-top, H&S for shorts)*

If weekly indicators NOT aligned → **RED FLAG**, skip trade.

### Stage 3: Daily PRICE PATTERN check (BONUS, NOT MANDATORY)

For LONG trades, check if there's a recent:
- **Double bottom (W pattern)**: two lows at similar price with peak between
- **Inverted head and shoulders**: three lows, middle being lowest

For SHORT trades, check if there's a recent:
- **Double top (M pattern)**: two highs at similar price with valley between
- **Head and shoulders**: three highs, middle being highest

Pattern adds confidence but is NOT required. Trades without patterns still
fire if all other conditions met.

### Stage 4: ENTRY price + STOP loss

Same as V1:
- Entry = daily close on the trigger day
- Stop (long) = lowest low between signal day and entry day, rounded DOWN to whole $
- Stop (short) = highest high between signal day and entry day, rounded UP to whole $

### Stage 5: TAKE PROFIT (NEW DUAL-TARGET SYSTEM)

**V2 has TWO take-profit levels:**

**TP1 (primary)** — whichever fires first:
- Daily RSI reaches 50, OR
- Long: entry + $4 (stocks ≤$200) / + $8 (stocks ≥$200)
- Short: entry − $4 (stocks ≤$200) / − $8 (stocks ≥$200)

**TP2 (runner)** — for continued momentum:
- Price hits 50-day moving average, OR
- Price hits 200-day moving average

**Two implementation options for the bot:**

Option A — **Simple**: keep V1 single exit at RSI 50. Accept missing some runner gains.

Option B — **Partial scaling**:
- Sell 50% at TP1 (RSI 50)
- Sell remaining 50% at TP2 (50/200 MA) OR at stop
- More complex code; better captures momentum runners

**Decision pending.** Lean toward Option A for v2.0 (simplicity);
consider B for v2.1.

---

## 🎯 Critical pattern detection nuance — bullish divergence in W-bottoms

User insight (2026-05-16) on actual W-bottom mechanics:

> *"On the initial oversold signal for double bottoms, the RSI moves
> back up. When forming a double bottom, most assets never reach the
> oversold RSI again. If they do it's for a very quick touch."*

This is **textbook bullish divergence** and IS the canonical W-bottom:

```
Price:           ┌─peak─┐
                 │      │
        ┌────────┘      └────────┐
        │                        │
        L1                       L2  ← similar price level to L1
       (RSI < 30)               (RSI 35-45, NOT < 30)
                                 ↑
                            higher RSI = bullish divergence
                            = stronger signal than re-touching oversold
```

**The naive pattern detector** (find two equal-priced lows) would miss
this nuance. The smart detector needs:

1. **Mark L1** when daily RSI < 30 (the initial oversold signal day)
2. **Track the recovery**: bounce up, RSI rises out of oversold zone
3. **Mark L2** when a new low forms at similar price (within ~2% of L1's low)
4. **Divergence check** (KEY): RSI at L2 > RSI at L1 (bullish divergence)
5. **Breakout filter**: wait for price to break above the peak between L1 and L2
6. **Standard SID trigger** fires from there: MACD + RSI direction-align

For M-tops (shorts), mirror with bearish divergence: H1 with RSI > 70,
H2 with lower RSI (made higher low / lower high while price made
similar high).

### Why this matters more than equal-price detection

A perfect double bottom with both lows at RSI < 30 is rare in real
markets. The divergence form is **way more common** and is what the
instructor would actually be marking on his charts. If the V2 detector
only catches the "perfect" form, it will miss 80%+ of real patterns.

---

## Implementation track (separate from V1)

### Architecture

V1 method continues to run as our shipped bot (v1.7, locked at tag
`sid-v1-method-baseline`). V2 method gets developed alongside:

```
bot-sid.js
├── if (SID_METHOD === 'v2') {
│      // V2 logic: weekly RSI+MACD, no-go zones, optional patterns
│   } else {
│      // V1 logic: existing v1.7 behaviour (default)
│   }
```

Default `SID_METHOD = 'v1'` so existing bot keeps working unchanged.
Set `SID_METHOD=v2` to switch.

### Phased build (re-stated from STRATEGY-AUDIT.md)

**Phase A — Patches to V1 (low risk)**
1. v1.8b RSI cap (45/55 no-go) — instructor-validated
2. Add FDX to active watchlist
3. Pine intraday default OFF

**Phase B — V1 → V2 weekly confirmation (HIGH IMPACT)**
4. Implement weekly RSI direction check
5. Implement weekly MACD direction check
6. Add `use_weekly_rsi_confirm` and `use_weekly_macd_confirm` env flags
7. Add `SID_METHOD=v2` toggle to switch implementations
8. Backtest comparison: v1 vs v2 weekly check side-by-side

**Phase C — V2 price pattern detection (HARDEST, highest reward)**
9. Build double-bottom detector with bullish divergence check
10. Build inverted H&S detector
11. Mirror logic for shorts (M-top, H&S)
12. Pattern confirmation as BONUS layer (not gate)
13. Backtest comparison: v2 without patterns vs v2 with patterns

**Phase D — V2 advanced TP (optional polish)**
14. Add dollar-based TP1 alternative (mostly for human traders, less for bot)
15. Add TP2 partial-exit at 50/200 MA (Option B from above)

---

## Decision log

- **2026-05-16**: V1 frozen at tag `sid-v1-method-baseline` (commit `bdef9be`).
- **2026-05-16**: V2 spec drafted. Build starts when user gives green light.
- **TBD**: User decides V2 ship pace (Phase A then pause? Or A→B→C in one push?)

---

## Backtest plan for V2

When V2 is built, comparison backtest will test on the same 5-year
window + 80-ticker universe used for V1:

| Variant | Trades | WR target | Notes |
|---|---|---|---|
| **V1 baseline** | 524 | 57.8% (current) | Reference |
| V2 Phase A only | ~487 | 58-60% | RSI cap impact |
| V2 Phase A + B | ~350 | 65-70% | Weekly confirmation kicks in |
| V2 Phase A + B + C | ~250 | 70-75% | Pattern layer adds quality |

If V2 fails to clear 65%+, something's wrong with our implementation
of the V2 rules — pause and audit.

If V2 clears 65-75%, we're in the community band and ready for paper
trading on Alpaca with V2 method.
