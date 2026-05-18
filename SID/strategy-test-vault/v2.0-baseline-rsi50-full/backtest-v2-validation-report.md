# SID V2 Method — Validation Backtest

**Generated:** 2026-05-18T02:13:24.278461
**Universe:** tier1 (80 tickers)
**Window:** 2021-05-19 -> 2026-05-18

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
| **v1.7-shipped** | 405 | 345/60 | **60.5%** | 1.66 | $+19302.31 | 37.8 / 66.2 |
| **v2-nogo-only** | 455 | 318/137 | **56.9%** | 1.49 | $+18540.34 | 36.9 / 64.9 |
| **v2-weekly-or** | 296 | 212/84 | **70.3%** | 2.57 | $+26750.62 | 37.8 / 64.0 |
| **v2-slope** | 98 | 63/35 | **71.4%** | 1.95 | $+5159.50 | 39.8 / 61.6 |
| **v2-method** | 25 | 16/9 | **100.0%** | ∞ | $+5864.17 | 39.6 / 61.4 |