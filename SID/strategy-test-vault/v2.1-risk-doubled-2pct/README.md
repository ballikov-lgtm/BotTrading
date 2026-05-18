# V2.1 Variant — Risk Doubled (2% per trade)

Same as V2.1 default with risk-per-trade doubled from \$200 to \$400 fixed (≈ 4% on a \$10K starting account, or 2% on \$20K). Useful as a **scaling reference** when projecting what live P&L might look like at different account sizes.

## How to reproduce

```bash
cd SID
SID_RISK_PER_TRADE=400 python backtest-sid-v2.1.py
```

Writes to `backtest-v2.1-validation-report-risk400.{json,csv}`.

## Configuration

Identical to V2.1 default with one change:

| Setting | V2.1 Default | This Variant |
|---|---|---|
| Risk per trade | \$200 fixed | **\$400 fixed** |
| (All other settings unchanged) | — | — |

## Results

| Metric | Value | Delta vs V2.1 default |
|---|---|---|
| Total trades | 302 | unchanged (risk size doesn't affect entries) |
| Wins (TP1 hit) | 210 | unchanged |
| Win rate | 69.5% | unchanged |
| Profit factor | 2.56 | +0.01 |
| Avg winner | +\$444.29 | ≈ 2× |
| Avg loser | -\$396.25 | ≈ 2× |
| **Total 5y P&L** | **+\$56,845.95** | **≈ 2× (+\$28,800)** |
| Long subset | 210 / 74.3% WR / +\$48,499 | ≈ 2× |
| Short subset | 92 / 58.7% WR / +\$8,347 | ≈ 2× |
| TP2 uplift on winners | +\$49,742.74 (+114.2%) | ≈ 2× |

### TP2 outcome breakdown (winners only)

| TP2 reason | Count | Avg TP2 leg P&L |
|---|---|---|
| 50d SMA touched | 123 | +\$316.32 |
| Break-even stop | 55 | +\$0 |
| 200d SMA touched | 29 | +\$270.08 |
| 30d timeout | 3 | +\$1,000.99 |

## Interpretation

This run **isn't a strategy change** — it just shows how the validated strategy scales linearly with risk. Every per-trade $ figure approximately doubles. Trade counts, win rates, and PF stay essentially the same because the share-sizing math is `shares = floor(risk_$ / stop_distance)`, which only affects position size and not whether the trade is taken.

**Important context:** \$400 per trade on a \$10,000 account = **4% risk per trade**. That's well above the 1-2% comfort zone for retail discretionary trading. A 4-trade losing streak (statistically expected ≈ once a year at 70% WR) drops the account 15% in a single month. Use this run only as a **scaling sanity check**, not as a recommendation to increase live risk.

## When this might matter for real

- **Account growth scenarios**: if/when the live account grows to ~\$20K, the existing 1% sizing math would put real risk at ~\$200 per trade — which is what this run uses. Expected 5y P&L in that scenario approximately matches what this backtest shows (≈ +\$57K), assuming similar market regimes.
- **Reverse interpretation**: starting \$10K, the V2.1 default at 1% risk should produce roughly half of these numbers over 5y — i.e. **+\$28K** (which matches `v2.1-default-30d-timeout/`). The two runs corroborate each other.

## Strengths

- **Confirms linear scaling** of the strategy — useful when sizing the live account
- **No regime sensitivity** — the same strategy that produces +\$28K at 1% should produce +\$56K at 2% on average

## Weaknesses

- **Not a real edge** — just larger sizing on the same edge
- **Higher max drawdown** in absolute dollars (doubled). The strategy's max DD as a % of account is unchanged
- 4% per-trade risk is too aggressive for the live bot's current paper-trading remit

## Verdict

🟢 **Scaling reference, not a live config candidate.** Kept here so we can answer "what would this strategy do if account size doubled" without re-running.

## Files in this folder

- `README.md` — this file
- `backtest-v2.1-validation-report-risk400.json`
- `backtest-v2.1-validation-report-risk400.csv`
