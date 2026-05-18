# V2.1 Variant — TP2 Timeout 14 Days

Same as V2.1 default in every way except the runner timeout is **14 trading days** instead of 30. Tests the hypothesis that recycling capital faster from indecisive runners produces better total P&L.

## How to reproduce

```bash
cd SID
SID_TP2_TIMEOUT=14 python backtest-sid-v2.1.py
```

Writes to `backtest-v2.1-validation-report-tp2t14.{json,csv}`.

## Configuration

Identical to V2.1 default with one change:

| Setting | V2.1 Default | This Variant |
|---|---|---|
| TP2 timeout | 30 trading days | **14 trading days** |
| (All other settings unchanged) | — | — |

## Results

| Metric | Value | Delta vs V2.1 default |
|---|---|---|
| Total trades | 304 | +2 |
| Wins (TP1 hit) | 212 | +2 |
| Win rate | **69.7%** | +0.2pp |
| Profit factor | **2.57** | +0.02 |
| Avg winner | +\$219.77 | -\$0.18 |
| Avg loser | -\$197.20 | unchanged |
| **Total 5y P&L** | **+\$28,448.50** | **+\$403 (+1.4%)** |
| Long trades | 212 / 74.5% WR | +2 |
| Short trades | 92 / 58.7% WR | unchanged |
| TP2 uplift on winners | +\$24,916.89 (+115.0%) | +\$184 |

### TP2 outcome breakdown (winners only)

| TP2 reason | 30d default | **14d this variant** | Change |
|---|---|---|---|
| 50d SMA touched | 123 | 122 | -1 |
| Break-even stop | 55 | 55 | unchanged |
| 200d SMA touched | 29 | 29 | unchanged |
| Timeout | 3 | **6** | +3 |

## Why it wins (slightly)

- The 14d timeout converts **3 round-trip-to-BE outcomes into 3 timeout-close outcomes** at an average **+\$291 per timeout exit**
- Net P&L gain: ~+\$870 from those 3 trades, partially offset by 1 SMA50 winner that didn't have time to develop
- Same WR (TP1 fires identically — only the runner's terminal condition differs)

## Strengths

- **Marginally better** on every quality metric (P&L, PF, WR, avg winner)
- **Slightly faster capital recycling** — runners exit by 14 trading days max, freeing position slots sooner
- **Free upside** — no entry-rule changes, just a parameter tweak

## Weaknesses

- Improvement is **marginal** (+\$403 = +1.4% over 5y). Likely within noise of the data-fetch window
- 3 extra timeout exits per 5y is too few to consider statistically robust
- Forces market-close exits on runners that might have completed a clean SMA touch in the next 5-15 days

## Verdict

🟡 **Marginal winner, not currently deployed.** Worth considering if/when the live bot has been running long enough that we can A/B both timeouts on actual paper-trading data. To switch, set `SID_TP2_TIMEOUT_DAYS=14` in the GitHub Actions env (it's already plumbed through `bot-sid.js` `CONFIG.tp2TimeoutDays`).

For now, the 30-day timeout is preferred because:
1. The +1.4% lift is too small to commit to without live confirmation
2. Holding runners longer preserves the option for SMA200 touches on the strongest trends
3. Anything 14d-or-shorter starts feeling more like a "let me get out" rule than a "let the trend develop" rule, which is V2.1's reason for existing

## Files in this folder

- `README.md` — this file
- `backtest-v2.1-validation-report-tp2t14.json`
- `backtest-v2.1-validation-report-tp2t14.csv`
