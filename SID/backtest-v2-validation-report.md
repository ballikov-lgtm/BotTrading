# SID V2 Method — Validation Backtest

**Generated:** 2026-05-16T10:04:20.742323
**Universe:** tier1_83 (83 tickers)
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
| **v1.7-shipped** | 423 | 357/66 | **59.6%** | 1.61 | $+19062.22 | 37.8 / 66.6 |
| **v2-nogo-only** | 478 | 328/150 | **56.3%** | 1.46 | $+18564.85 | 37.0 / 65.1 |
| **v2-weekly-or** | 311 | 221/90 | **69.5%** | 2.50 | $+27381.08 | 37.8 / 63.8 |
| **v2-method** | 27 | 16/11 | **100.0%** | ∞ | $+6089.33 | 39.6 / 61.2 |