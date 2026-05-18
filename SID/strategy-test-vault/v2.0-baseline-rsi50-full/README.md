# V2.0 Baseline — RSI 50 Full Exit

The original V2-method exit model. Every position closes 100% when RSI(14) reaches 50. Acts as the **reference benchmark** that all V2.1 variants are measured against.

## How to reproduce

```bash
cd SID
python backtest-sid-v2.py
```

Writes to `SID/backtest-v2-validation-report.{json,md}` in the SID root (this folder has a snapshot copy).

## Configuration

| Setting | Value |
|---|---|
| Backtest file | `backtest-sid-v2.py` |
| Universe | `tier1` (80-ticker AUTO list) |
| Trade window | 5 years ending 2026-05-18 |
| Indicator warmup | 5 years prior to trade window |
| Risk per trade | \$200 fixed (≈ 2% on \$10K) |
| Entry — daily | RSI(14) < 30 oversold / > 70 overbought, sticky |
| Entry — trigger | RSI rising AND MACD rising (both same direction) |
| Entry — no-go zone | reject long if RSI ≥ 45, reject short if RSI ≤ 55 |
| Entry — weekly | weekly RSI rising OR weekly MACD rising (OR mode) |
| Entry — RSI(3) | RSI(3) must be in extreme zone same as RSI(14) |
| Entry — earnings | 14-day pre-earnings blackout |
| Exit | **100% position closed at RSI 50** — only one exit event |
| Stop | floor/ceil of arm-window low/high |

## Results (v2-weekly-or variant)

| Metric | Value |
|---|---|
| Total trades | **296** |
| Wins (closed at RSI 50) | 208 |
| Win rate | **70.3%** |
| Profit factor | 2.57 |
| Avg winner | +\$210.56 |
| Avg loser | -\$193.70 |
| **Total 5y P&L** | **+\$26,750.62** |
| Long trades | 212 / 74.1% WR |
| Short trades | 84 / 60.7% WR |
| Stop-outs | 87 |
| RSI-50 exits | 209 |
| Avg bars held | 8.0 |

## Strengths

- **Simplest model** — one exit rule, easy to reason about
- **Highest WR** in the family (70.3% vs ~69.5% for V2.1 variants)
- **Fastest position cycling** — avg 8 bars held → frees capital quickly for the next entry

## Weaknesses

- **No TP2 upside capture** — winners close at RSI 50 regardless of how far the move could have extended. The eventual SMA50/SMA200 touch on extended winners is left on the table.
- **Per-winner economics are smaller** than V2.1 by ~50% on average — same WR, smaller pies per win.

## Verdict

A solid, conservative reference. Beaten by V2.1 default by **+\$1,296 (+4.8%)** over 5 years with essentially the same trade count, so V2.1 ships in the live bot. Keep this here as the "what would V2 have done" check whenever a V2.1 variant is evaluated.

## Files in this folder

- `README.md` — this file
- `backtest-v2-validation-report.json` — full V2 backtest report (snapshot, includes all 5 variants: v1.7-shipped, v2-nogo-only, v2-weekly-or, v2-slope, v2-method)
- `backtest-v2-validation-report.md` — human-readable summary (if present)
