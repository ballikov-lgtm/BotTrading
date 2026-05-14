# SID v1.5 — Variant Comparison Backtest

**Generated:** 2026-05-14T09:55:41.465029
**Window:** 2021-05-15 → 2026-05-14 (5 years)
**Tickers scanned:** 50 / 50
**Risk per trade:** $200

## Variants tested

| Variant | Description |
|---|---|
| **v1.4-baseline** | Weekly 50/200 SMA at ARM, no earnings filter (locked baseline) |
| **v1.5-shipped** | *** SHIPPED v1.5 — baseline + 14-day pre-only earnings blackout *** |
| **rejected-A-trigger-momentum** | REJECTED: Weekly RSI > 50 (long) / < 50 (short) at TRIGGER. Too restrictive — 3 trades only. |
| **rejected-B-trigger-trajectory** | REJECTED: Weekly RSI rising/falling at TRIGGER. 31 trades, 58.1% WR — lost to baseline 60.9%. |
| **rejected-C-trigger-combined** | REJECTED: Both momentum AND trajectory at TRIGGER. 0 trades fired — impossible setup. |

## Aggregate results (all tickers combined)

| Variant | Trades | WR | PF | Net P&L | TP exits | SL hits | Avg bars held |
|---|---:|---:|---:|---:|---:|---:|---:|
| **v1.4-baseline** | 202 | **60.9%** | 1.85 | $+12892.81 | 125 | 77 | 6.8 |
| **v1.5-shipped** | 167 | **62.3%** | 1.98 | $+11809.02 | 106 | 61 | 7.2 |
| **rejected-A-trigger-momentum** | 3 | **100.0%** | ∞ | $+368.46 | 3 | 0 | 4.7 |
| **rejected-B-trigger-trajectory** | 31 | **58.1%** | 1.80 | $+1923.38 | 19 | 12 | 6.8 |
| **rejected-C-trigger-combined** | 0 | **0.0%** | 0.00 | $+0.00 | 0 | 0 | 0 |

## Verdict

**rejected-A-trigger-momentum** edges out the v1.4 baseline:
- Win rate **+39.1pp** (60.9% → 100.0%)
- Net P&L **$-12524.35** vs baseline
- Profit factor **999.00** vs baseline 1.85

**Caveat:** delta must clear noise from a single backtest window. Re-run on a different window before shipping.

## Per-ticker breakdown (win rate by variant)

| Ticker | v1.4-baseline | v1.5-shipped | rejected-A-trigger-momentum | rejected-B-trigger-trajectory | rejected-C-trigger-combined |
|---|---|---|---|---|---|
| DIA | 67% (6) | 67% (6) | — | 100% (1) | — |
| IWM | 67% (3) | 67% (3) | — | — | — |
| QQQ | 75% (4) | 75% (4) | 100% (1) | 100% (1) | — |
| SPY | 75% (4) | 75% (4) | — | 100% (1) | — |
| AAPL | 33% (3) | 0% (2) | — | — | — |
| AMD | 50% (2) | 50% (2) | — | — | — |
| AMZN | 67% (3) | 0% (1) | — | — | — |
| BA | 44% (9) | 40% (5) | — | — | — |
| BAC | 43% (7) | 57% (7) | — | — | — |
| CAT | 50% (4) | 50% (4) | — | 0% (1) | — |
| COST | 100% (2) | 100% (2) | — | 100% (1) | — |
| DIS | 56% (9) | 57% (7) | — | — | — |
| DKS | 100% (2) | 100% (1) | — | — | — |
| ETSY | 67% (3) | 50% (2) | — | — | — |
| FCX | 43% (7) | 50% (2) | — | 0% (1) | — |
| FDX | 33% (9) | 40% (5) | — | 100% (1) | — |
| GM | 25% (4) | 0% (2) | — | — | — |
| GOLD | 67% (3) | 50% (2) | — | — | — |
| GOOG | 0% (2) | 0% (2) | — | — | — |
| GS | 100% (2) | 100% (2) | 100% (1) | — | — |
| HD | 33% (6) | 33% (6) | — | 0% (2) | — |
| IBM | 75% (4) | 67% (3) | — | — | — |
| INTC | 100% (1) | 100% (1) | — | 0% (1) | — |
| JPM | — | — | — | — | — |
| MA | 100% (1) | 100% (2) | — | 0% (1) | — |
| META | 50% (4) | 33% (3) | — | — | — |
| MCD | 83% (6) | 80% (5) | — | 33% (3) | — |
| MSFT | 50% (6) | 25% (4) | — | — | — |
| PYPL | 43% (7) | 60% (5) | — | — | — |
| QYLD | 100% (1) | 100% (1) | — | — | — |
| SLV | 75% (4) | 75% (4) | — | 100% (2) | — |
| SQQQ | — | — | — | 50% (2) | — |
| TGT | 0% (5) | 0% (3) | — | — | — |
| TNA | 67% (3) | 67% (3) | — | — | — |
| TQQQ | 40% (5) | 40% (5) | 100% (1) | — | — |
| TSLA | 67% (12) | 70% (10) | — | 0% (1) | — |
| TZA | — | — | — | 100% (1) | — |
| VZ | 100% (3) | 100% (1) | — | 100% (1) | — |
| WMT | 100% (1) | 100% (1) | — | 0% (1) | — |
| XLB | 67% (3) | 67% (3) | — | 0% (1) | — |
| XLC | 100% (2) | 100% (2) | — | 50% (2) | — |
| XLE | — | — | — | — | — |
| XLF | 100% (3) | 100% (3) | — | — | — |
| XLI | 100% (4) | 100% (4) | — | — | — |
| XLK | 67% (3) | 67% (3) | — | 100% (1) | — |
| XLP | 100% (3) | 100% (3) | — | 100% (2) | — |
| XLRE | 75% (4) | 75% (4) | — | — | — |
| XLU | 83% (6) | 83% (6) | — | 100% (1) | — |
| XLV | 100% (6) | 100% (6) | — | 100% (2) | — |
| XLY | 54% (11) | 54% (11) | — | — | — |

## How to read this report

- **Aggregate WR** = wins ÷ total across the entire watchlist for each variant. The fairest single number.
- **PF (Profit Factor)** = total winning P&L ÷ total losing P&L. PF > 1.5 is good.
- **TP exits** = exits where daily RSI(14) reached 50 (target hit).
- **SL hits** = exits where the stop loss was triggered (loss).
- Trades are counted only when their *entry* date falls inside the trade window. The 5-year data fetch is needed for the weekly 200-SMA warmup.
