# Bot-Parity / Entry-Overhaul Experiment — ADOPTED as v2.2.3 (2026-06-28)

## Why this exists
Alan reviewed live entries and noticed a stale ADBE long (signal 2026-06-17,
entered 2026-06-26 — ~6 trading days late, after price had slid $233 → $202).
The `strategy-validator` confirmed the live bot's `detectEntrySignal` had
**drifted from the validated backtest**: it used a loose "episode" model with
**no arm timeout, no RSI(3) confirmation, and no weekly-SMA arm gate**, while the
backtest (and the instructor's documented rule) enforce all three. The bot was
trading a different, lower-quality universe than the 71% backtest ever measured.

## The investigation (all in `backtest-sid-bot-parity.py`, env-gated)

**1. Quantify the drift — `SID_BOT_PARITY=true` replicates the live bot's loose entry:**

| | Validated | Bot-parity (live bot) |
|---|---|---|
| Trades | 304 | **1,586** (5.2×) |
| Win rate | 71.0% | 66.1% (−4.9pp) |
| Profit factor | 2.69 | **1.91** |
| Total PnL | $29,335 | $96,312 |
| Shorts | 89 | **939** (10.5×) |

The loose model makes more *gross* dollars only by firing 5× as often at fixed
risk — at far lower efficiency (PF 1.91), and unrealizable live under position
caps. The 10× short explosion is the low-quality counter-trend repeats.

**2. Re-arm cooldown sweep (validated entry gates + a re-arm lockout after a
3-day arm expires unfired). `SID_REARM_COOLDOWN`:**

| Re-arm cooldown | Trades | WR | PF | PnL |
|---|---|---|---|---|
| 0 (free, validated) | 304 | 71.0% | 2.69 | $29,335 |
| 5 (both sides) | 203 | 74.9% | 3.10 | $21,037 |

The both-sides 5-day cooldown lifts WR + PF but cuts 33% of trades — including
good bullish longs.

**3. Side-specific cooldown — `SID_REARM_COOLDOWN_LONG` / `_SHORT`.** Alan's
hypothesis: bullish names recover in a V, so a fast LONG re-arm catches the
snapback; only SHORTS benefit from the cooldown. Confirmed, and the short
cooldown has a clean optimum at 5:

| Config (long / short cooldown) | Trades | WR | **PF** | **PnL** | Short WR |
|---|---|---|---|---|---|
| Validated (0 / 0) | 304 | 71.0% | 2.69 | $29,335 | 62.9% |
| Shorts-only 3d (0 / 3) | 287 | 71.8% | 2.87 | $29,816 | 63.9% |
| **Shorts-only 5d (0 / 5)** | **280** | **73.9%** | **3.19** | **$31,426** | **72.3%** |
| Shorts-only 7d (0 / 7) | 271 | 72.3% | 2.84 | $27,049 | 64.3% |

Short WR peaks sharply at a 5-day cooldown (62.9% → 72.3%) and falls off on both
sides — too short re-shorts the same recovery, too long locks out fresh setups.
Alan derived the ≈8-day cycle (3-day arm + 5-day cooldown) from average recovery
duration on the charts; the data matched.

## ADOPTED CONFIG (v2.2.3) — `SID_BOT_PARITY=false  REARM_COOLDOWN_LONG=0  REARM_COOLDOWN_SHORT=5`

**3-day arm timeout + RSI(3) confirmation + weekly SMA50/200 arm gate +
free-rearm longs / shorts-only 5-day re-arm cooldown.**

> **280 trades · 73.9% WR · PF 3.19 · +$31,426** (tier1, 5y, $200 fixed) —
> Pareto-dominates the validated baseline (+$2,091, +0.50 PF, +2.9pp WR), with
> the short side cleaned from 62.9% → 72.3% and the long side preserved (215 /
> 74.4%, identical to validated). Vs the live loose bot: WR 66% → 74%, PF
> 1.91 → 3.19.

## The live-bot fix (`bot-sid.js`)
`detectEntrySignal` was rewritten as a **bounded bar-by-bar replay** (trailing
40 bars from a clean state) of this exact arm/trigger/cooldown machine — ported
verbatim from this backtest. New CONFIG: `armTimeoutDays=3`,
`rearmCooldownLong=0`, `rearmCooldownShort=5`, `armReplayBars=40`. New
`buildWeeklyDailyAligned()` replicates the backtest's two W-FRI reindex
conventions (SMA gate = no-shift Friday anchor; RSI/MACD direction = −4-day
Monday anchor).

**Critical live fix:** the scan path fetched only `2y` (~104 weekly bars), below
the 200 weekly bars the SMA gate needs — so the gate silently defaulted to TRUE
(inert) live. Bumped the scan fetch to **`5y`** so the weekly-SMA gate actually
applies. Verified active: PYPL (downtrend) long gate = FALSE, GOOG (uptrend) = TRUE.

## Verification
- `detectEntrySignal` reproduces the backtest's entries exactly: GOOG 2026-03-31
  → LONG $286.86, AAPL 2025-04-09 → LONG $198.85 (date/side/price match).
- The stale **ADBE 2026-06-26 entry no longer fires** (the 3-day timeout expires
  the 6-17 arm long before the 6-26 MACD turn). This was the whole point.
- 113-ticker dry-run clean (exit 0).

## Files
- `backtest-bot-parity-report.json/.csv` — validated baseline (304)
- `backtest-bot-parity-report-botparity.json/.csv` — the live loose bot (1,586)
- `backtest-bot-parity-report-rearmcd5.json/.csv` — both-sides 5-day
- `backtest-bot-parity-report-rearmcdL0S3/5/7.json/.csv` — shorts-only sweep (L0S5 = ADOPTED)
