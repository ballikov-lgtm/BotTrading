# SID V2 Method — Validation Backtest

**Generated:** 2026-05-16T11:07:48.003621
**Universe:** tier1_113 (113 tickers)
**Window:** 2021-05-17 -> 2026-05-16

## V2 rule set
- ARM: daily RSI<30 (long) / >70 (short)  ← V2 uses 70 not 75
- Also requires RSI(3) in same zone
- TRIGGER: daily RSI direction + daily MACD direction
- + Weekly RSI direction matching trade direction
- + Weekly MACD direction matching trade direction
- + RSI no-go zone: long entry rejected if RSI ≥ 45, short rejected if ≤ 55
- EXIT: single exit at RSI 50 (Option A — V2.1 may add 50%/50% split)

## Variants
| Variant | Description |
|---|---|
| **v1.7-shipped** | V1 baseline: RSI 75, no weekly, no no-go cap, 1-bar daily alignment |
| **v2-nogo-only** | V2 minimal: RSI 70 + 45/55 no-go cap, 1-bar daily alignment |
| **v2-weekly-or** | V2 medium: + weekly RSI OR MACD rising (1-bar daily alignment) |
| **v2-slope** | *** V2 + 2-bar daily slope (RSI & MACD rising 2 days running) *** |
| **v2-method** | V2 strict: + weekly RSI AND MACD rising (1-bar daily alignment) |

## Aggregate results
| Variant | Trades | L/S | WR | PF | Net P&L | Avg RSI@entry (L/S) |
|---|---:|---:|---:|---:|---:|---|
| **v1.7-shipped** | 553 | 441/112 | **57.0%** | 1.38 | $+17598.11 | 37.2 / 65.4 |
| **v2-nogo-only** | 668 | 409/259 | **52.4%** | 1.25 | $+15917.39 | 36.4 / 64.4 |
| **v2-weekly-or** | 425 | 271/154 | **64.9%** | 2.04 | $+29755.04 | 37.3 / 63.3 |
| **v2-slope** | 153 | 89/64 | **68.0%** | 1.71 | $+6819.30 | 38.7 / 60.7 |
| **v2-method** | 39 | 25/14 | **94.9%** | 21.51 | $+8151.01 | 38.6 / 60.6 |