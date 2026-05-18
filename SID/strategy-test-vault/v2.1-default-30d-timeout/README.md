# V2.1 Default — TP1 RSI 50 + TP2 SMA, 30-Day Timeout

The **currently-deployed live configuration** (as of 2026-05-18). Closes 50% of the position at RSI 50 (TP1), moves the stop to break-even, and lets the remaining 50% run for the next major support/resistance touch (TP2) or a 30-trading-day timeout, whichever fires first.

## How to reproduce

```bash
cd SID
python backtest-sid-v2.1.py
```

No env vars needed — this is the default configuration.

## Configuration

| Setting | Value |
|---|---|
| Backtest file | `backtest-sid-v2.1.py` |
| Universe | `tier1` (80-ticker AUTO list) |
| Trade window | 5 years ending 2026-05-18 |
| Indicator warmup | 5 years prior to trade window |
| Risk per trade | \$200 fixed (≈ 2% on \$10K) |
| **Entry rules** | **Identical to V2 baseline** (no entry-side changes) |
| TP1 trigger | RSI(14) hits 50 (long ≥ 50, short ≤ 50) |
| TP1 action | Close 50% of position. Move stop on runner to entry price (break-even) |
| TP2 (a) | Break-even stop hit on runner |
| TP2 (b) | Price touches 50-day SMA |
| TP2 (c) | Price touches 200-day SMA |
| TP2 (d) | **30 trading days** after TP1 (timeout) |
| WR definition | A trade is a WIN whenever TP1 fires — runner round-tripping to BE doesn't downgrade the win |

## Results

| Metric | Value | Delta vs V2 |
|---|---|---|
| Total trades | **302** | +6 (+2%) |
| Wins (TP1 hit) | 210 | +2 |
| Win rate | 69.5% | -0.8pp |
| Profit factor | 2.55 | -0.02 |
| Avg winner | +\$219.95 | +\$9.39 |
| Avg loser | -\$197.20 | -\$3.50 |
| **Total 5y P&L** | **+\$28,046.39** | **+\$1,296 (+4.8%)** |
| Long trades | 210 / 74.3% WR | similar |
| Short trades | 92 / 58.7% WR | +8 trades, slightly lower WR |
| **TP2 uplift on winners** | **+\$24,732.84 (+115.3%)** | — |

### TP2 outcome breakdown (winners only)

| TP2 reason | Count | Avg TP2 leg P&L |
|---|---|---|
| 50d SMA touched | 123 | +\$157.81 |
| Break-even stop | 55 | +\$0 (flat) |
| 200d SMA touched | 29 | +\$133.06 |
| 30d timeout | 3 | +\$487.80 |

## Strengths

- **Beats V2 on absolute P&L** by +\$1,296 over 5 years on the same risk budget
- **Same trade count** as V2 — no compounding-speed sacrifice once the warmup bug was fixed
- **+115% TP2 uplift** means winners contribute roughly twice what V2 captures
- **Break-even stop on runners** caps downside on the held half — 55 of 210 winners (26%) round-trip to BE for $0 extra, but they don't turn into losses

## Weaknesses

- Slightly lower WR (69.5% vs V2's 70.3%) because the runner has more time exposed and a wider definition of "win" (TP1-only still counts) — net effect is essentially neutral
- 30-day timeout means a small fraction (3/210) of winners get force-closed at market rather than at a clean technical level — the 14d variant captures slightly more of these (see sibling folder)
- Requires Alpaca partial-close support (live bot uses `closePartial()` in `alpaca-executor.js`)

## Verdict

✅ **WINNER among tested V2.1 variants.** Currently deployed in `bot-sid.js` v2.1 (paper-trading). Ship this as default until/unless a future variant beats it cleanly on both trade count and P&L.

## Files in this folder

- `README.md` — this file
- **`SID V2.1 Method Back Testing.xlsx`** — full instructor-ready Excel report (8 sheets, 113-ticker universe, 1% compounding from \$10K to mirror the V2 Excel methodology). **Final account: \$46,109 = +361.1% / 35.76% CAGR.** Generate via `python scripts/build-v2.1-excel-report.py`
- `backtest-v2.1-validation-report.json` — raw 80-ticker AUTO backtest aggregate (302 trades, \$28k P&L at fixed \$200/trade risk)
- `backtest-v2.1-validation-report.csv` — every AUTO-tier trade (entry/exit, TP1/TP2 leg breakdown) at fixed \$200/trade risk

### Two backtest framings — same strategy, different sizing methodologies

| Framing | Universe | Sizing | Trades | Net P&L | Used for |
|---|---|---|---|---|---|
| Fixed-risk (raw backtest JSON/CSV) | tier1 80 | \$200/trade constant | 302 | +\$28,046 | Apples-to-apples vs other variants in this vault (everything uses same fixed risk) |
| Compounding (the Excel report) | tier1_113 | 1% of current account | 429 | +\$36,109 | Apples-to-apples vs the instructor's V2 Excel (which used compounding) |

Both are honest views of the same strategy. The Excel report is what to share externally.
