# SID V2 Method — Validation Backtest

**Generated:** 2026-05-16T09:45:21.400556
**Universe:** tier1_80 (80 tickers)
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
| **v1.7-shipped** | V1 baseline: RSI 75, no weekly direction, no no-go cap |
| **v2-nogo-only** | V2 minimal: RSI 70 threshold + RSI 45/55 no-go cap, NO weekly filter |
| **v2-weekly-or** | V2 medium: + weekly RSI OR weekly MACD rising (one of two) |
| **v2-method** | *** V2 full: + weekly RSI AND weekly MACD rising (both required) *** |

## Aggregate results
| Variant | Trades | L/S | WR | PF | Net P&L | Avg RSI@entry (L/S) |
|---|---:|---:|---:|---:|---:|---|
| **v1.7-shipped** | 405 | 345/60 | **60.5%** | 1.66 | $+19302.31 | 37.8 / 66.2 |
| **v2-nogo-only** | 456 | 318/138 | **57.0%** | 1.49 | $+18627.76 | 36.9 / 64.9 |
| **v2-weekly-or** | 297 | 212/85 | **70.4%** | 2.57 | $+26838.04 | 37.8 / 64.0 |
| **v2-method** | 26 | 16/10 | **100.0%** | ∞ | $+5951.59 | 39.6 / 61.6 |