# SID Asset Classification

**Strategy version:** v1.2
**Generated:** 2026-05-11T21:02:41.926769
**Source:** `backtest-report_rsi75_lo_rsi3_weekly.json`

## Summary

| Tier | Count | Behaviour |
|---|---:|---|
| 🟢 **AUTO_TRADE** | 2 | Bot executes signals automatically. Proven consistent edge. |
| 🟡 **MONITOR** | 2 | Bot flags signals + alerts user. **Manual review required** (sentiment, news, weekly trend). Never auto-trade. |
| 🔴 **EXCLUDED** | 1 | Dropped from active watchlist — strategy has no edge on these. |
| ⚪ **INSUFFICIENT_DATA** | 45 | < 2 trades in 12 months. Re-evaluate quarterly. |

## 🟢 AUTO_TRADE — bot executes

*Criteria: ≥ 3 trades, ≥ $50 net P&L, ≥ 1.5 profit factor, ≥ 40% win rate*

| # | Ticker | Direction | WR | PF | Net P&L | Trades | Reason |
|---:|---|---|---:|---:|---:|---:|---|
| 1 | **BA** | both | 67% | 4.69 | $+727 | 3 | WR=67% PF=4.69 P&L=$+727 over 3 trades — consistent |
| 2 | **MSFT** | long-only | 67% | 1.51 | $+101 | 3 | WR=67% PF=1.51 P&L=$+101 over 3 trades — consistent |

## 🟡 MONITOR — flag only, manual review with sentiment

*Criteria: ≥ 2 trades, ≥ 0.8 profit factor, ≥ 25% win rate, ≤ $75 max net loss*

| # | Ticker | Direction | WR | PF | Net P&L | Trades | Reason |
|---:|---|---|---:|---:|---:|---:|---|
| 1 | **COST** | both | 100% | ∞ | $+497 | 2 | WR=100% PF=999.00 P&L=$+497 over 2 trades — borderline, needs sentiment check |
| 2 | **DIS** | both | 50% | 1.52 | $+104 | 2 | WR=50% PF=1.52 P&L=$+104 over 2 trades — borderline, needs sentiment check |

## 🔴 EXCLUDED — drop from active watchlist

*Criteria: fails MONITOR criteria — net losing without sufficient edge*

| # | Ticker | Direction | WR | PF | Net P&L | Trades | Reason |
|---:|---|---|---:|---:|---:|---:|---|
| 1 | **XLY** | short-only | 0% | 0.00 | $-397 | 2 | WR=0% PF=0.00 P&L=$-397 over 2 trades — net negative without edge |

## ⚪ INSUFFICIENT_DATA — re-evaluate quarterly

*Criteria: < 2 trades in 12 months*

| # | Ticker | Direction | WR | PF | Net P&L | Trades | Reason |
|---:|---|---|---:|---:|---:|---:|---|
| 1 | **BAC** | both | 100% | ∞ | $+310 | 1 | only 1 trade(s) in 12 months |
| 2 | **XLI** | both | 100% | ∞ | $+296 | 1 | only 1 trade(s) in 12 months |
| 3 | **TQQQ** | long-only | 100% | ∞ | $+265 | 1 | only 1 trade(s) in 12 months |
| 4 | **QQQ** | long-only | 100% | ∞ | $+260 | 1 | only 1 trade(s) in 12 months |
| 5 | **AAPL** | both | 100% | ∞ | $+248 | 1 | only 1 trade(s) in 12 months |
| 6 | **DIA** | both | 100% | ∞ | $+240 | 1 | only 1 trade(s) in 12 months |
| 7 | **VZ** | both | 100% | ∞ | $+238 | 1 | only 1 trade(s) in 12 months |
| 8 | **SPY** | long-only | 100% | ∞ | $+231 | 1 | only 1 trade(s) in 12 months |
| 9 | **XLV** | both | 100% | ∞ | $+168 | 1 | only 1 trade(s) in 12 months |
| 10 | **XLF** | both | 100% | ∞ | $+154 | 1 | only 1 trade(s) in 12 months |
| 11 | **XLC** | long-only | 100% | ∞ | $+150 | 1 | only 1 trade(s) in 12 months |
| 12 | **XLK** | long-only | 100% | ∞ | $+109 | 1 | only 1 trade(s) in 12 months |
| 13 | **MA** | both | 100% | ∞ | $+81 | 1 | only 1 trade(s) in 12 months |
| 14 | **AMD** | long-only | 0% | 0.00 | $+0 | 0 | only 0 trade(s) in 12 months |
| 15 | **AMZN** | both | 0% | 0.00 | $+0 | 0 | only 0 trade(s) in 12 months |
| 16 | **CAT** | long-only | 0% | 0.00 | $+0 | 0 | only 0 trade(s) in 12 months |
| 17 | **DKS** | both | 0% | 0.00 | $+0 | 0 | only 0 trade(s) in 12 months |
| 18 | **ETSY** | both | 0% | 0.00 | $+0 | 0 | only 0 trade(s) in 12 months |
| 19 | **FCX** | both | 0% | 0.00 | $+0 | 0 | only 0 trade(s) in 12 months |
| 20 | **FDX** | both | 0% | 0.00 | $+0 | 0 | only 0 trade(s) in 12 months |
| 21 | **GM** | both | 0% | 0.00 | $+0 | 0 | only 0 trade(s) in 12 months |
| 22 | **GOLD** | long-only | 0% | 0.00 | $+0 | 0 | only 0 trade(s) in 12 months |
| 23 | **GOOG** | both | 0% | 0.00 | $+0 | 0 | only 0 trade(s) in 12 months |
| 24 | **GS** | long-only | 0% | 0.00 | $+0 | 0 | only 0 trade(s) in 12 months |
| 25 | **IBM** | long-only | 0% | 0.00 | $+0 | 0 | only 0 trade(s) in 12 months |
| 26 | **INTC** | long-only | 0% | 0.00 | $+0 | 0 | only 0 trade(s) in 12 months |
| 27 | **IWM** | both | 0% | 0.00 | $+0 | 0 | only 0 trade(s) in 12 months |
| 28 | **JPM** | long-only | 0% | 0.00 | $+0 | 0 | only 0 trade(s) in 12 months |
| 29 | **MCD** | both | 0% | 0.00 | $+0 | 0 | only 0 trade(s) in 12 months |
| 30 | **META** | both | 0% | 0.00 | $+0 | 0 | only 0 trade(s) in 12 months |
| 31 | **PYPL** | both | 0% | 0.00 | $+0 | 0 | only 0 trade(s) in 12 months |
| 32 | **QYLD** | both | 0% | 0.00 | $+0 | 0 | only 0 trade(s) in 12 months |
| 33 | **SLV** | both | 0% | 0.00 | $+0 | 0 | only 0 trade(s) in 12 months |
| 34 | **SQQQ** | short-only | 0% | 0.00 | $+0 | 0 | only 0 trade(s) in 12 months |
| 35 | **TGT** | short-only | 0% | 0.00 | $+0 | 0 | only 0 trade(s) in 12 months |
| 36 | **TNA** | both | 0% | 0.00 | $+0 | 0 | only 0 trade(s) in 12 months |
| 37 | **TSLA** | both | 0% | 0.00 | $+0 | 0 | only 0 trade(s) in 12 months |
| 38 | **TZA** | short-only | 0% | 0.00 | $+0 | 0 | only 0 trade(s) in 12 months |
| 39 | **WMT** | both | 0% | 0.00 | $+0 | 0 | only 0 trade(s) in 12 months |
| 40 | **XLB** | long-only | 0% | 0.00 | $+0 | 0 | only 0 trade(s) in 12 months |
| 41 | **XLE** | long-only | 0% | 0.00 | $+0 | 0 | only 0 trade(s) in 12 months |
| 42 | **XLP** | both | 0% | 0.00 | $+0 | 0 | only 0 trade(s) in 12 months |
| 43 | **XLRE** | both | 0% | 0.00 | $+0 | 0 | only 0 trade(s) in 12 months |
| 44 | **XLU** | both | 0% | 0.00 | $+0 | 0 | only 0 trade(s) in 12 months |
| 45 | **HD** | short-only | 0% | 0.00 | $-200 | 1 | only 1 trade(s) in 12 months |

## How MONITOR works

When a MONITOR-tier ticker fires a SID signal (arm or entry-ready), the bot will:

1. **Add it to the dashboard** scanner panel with a 🟡 indicator
2. **Send a Telegram alert** with current sentiment + recent news context (from the planned Perplexity research tool)
3. **NOT execute the trade automatically** — wait for explicit user approval
4. **Expire the alert** after the standard 3-day timeout

AUTO_TRADE tickers fire signals into the order pipeline without manual review (subject to the standard pre-flight checks).

EXCLUDED tickers are removed from `watchlist-sid.json` entirely (or stay marked `tier: "excluded"` for transparency).

## How to apply

Either:
- **A)** Update `watchlist-sid.json` to include `direction` and `tier` per ticker (richer object format), then update the scanner + bot to honour them
- **B)** Keep `watchlist-sid.json` as a flat list and consume `asset-classification.json` as a side-car

Option A is cleaner long-term but requires touching the scanner. Option B is faster and reversible.