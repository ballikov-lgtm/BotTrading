# V2.1 Variant — Algorithmic-Bullish Hybrid

Tests whether the TP1+TP2 runner model should only apply to **long-term-bullish tickers**, with everything else falling back to V2's single-exit-at-RSI-50 behaviour. The premise: bull-trend stocks extend through RSI 50, so they earn the runner. Choppy/bearish names round-trip fast, so the runner just sits there blocking capital.

## How to reproduce

```bash
cd SID
SID_HYBRID=true python backtest-sid-v2.1.py
```

Writes to `backtest-v2.1-validation-report-hybrid.{json,csv}`.

## "Long-term bullish" definition (algorithmic, per-bar)

A ticker counts as bullish AT THE TIME OF ENTRY when **all three** are true:

1. **Weekly EMA50 > Weekly EMA200** (golden-cross trend)
2. **Weekly MACD > 0** (positive momentum)
3. **Daily close > Weekly 200-day SMA** (price above structural support)

If all three are true at the entry bar AND the trade is LONG → V2.1 dynamic-TP path. Otherwise (non-bullish long, OR any short) → V2 single-exit at RSI 50.

## Configuration

Identical to V2.1 default with one change:

| Setting | V2.1 Default | This Variant |
|---|---|---|
| Exit routing | All trades use TP1+TP2 | **Per-trade routing by bullish gate** |
| (All other settings unchanged) | — | — |

## Results

| Metric | Value | Delta vs V2.1 default |
|---|---|---|
| Total trades | 302 | unchanged |
| Wins (TP1 hit) | 210 | unchanged |
| Win rate | 69.5% | unchanged |
| Profit factor | 2.39 | **-0.16** |
| Avg winner | +\$206.17 | -\$13.78 |
| Avg loser | -\$197.20 | unchanged |
| **Total 5y P&L** | **+\$25,153.81** | **-\$2,892 (-10.3%)** ❌ |
| TP2 uplift on winners | +\$5,302.24 (+14.0%) | **-\$19,431** vs V2.1 default's +\$24,733 |

### Hybrid routing breakdown

| Path | n | WR | 5y P&L |
|---|---|---|---|
| V2.1 (bullish longs) | 71 | 81.7% | +\$8,069 |
| V2 (non-bullish longs + all shorts) | 231 | 65.8% | +\$17,085 |
| **Total** | **302** | **69.5%** | **+\$25,154** |

Of 210 long entries, only **71 (34%)** passed the bullish-at-entry gate. The other 139 longs got V2 single-exit treatment and gave up their TP2 runner upside.

## Why it loses

The bullish filter is **too restrictive**. Most V2 long entries happen during pullbacks within uptrends — but a pullback to RSI < 30 often coincides with weekly MACD briefly going negative or price briefly dipping below the weekly 200-SMA. That kicks the trade into V2 mode just when the runner would have caught the recovery's biggest move.

In hindsight, the 71 bullish trades retained 81.7% WR (vs 74.3% all-longs), confirming they're a higher-quality subset. But the 139 non-bullish longs still had **70.5% WR** with **+\$12,940 P&L** — many of them would have produced TP2 SMA50/SMA200 touches if the runner had been allowed.

## Lesson learned

- The instructor's V2.1 method assumes the runner pays off on average across all V2 entries. The 5y data agrees with that assumption.
- A bullish-only gate works AGAINST you when entries are pullback-driven. The bullish check fires AFTER the pullback rather than before it.
- If we ever revisit a routing rule, it should be **pessimistic-side**: identify the specific conditions where the runner historically LOSES, and disable the runner for those (rather than enabling it only for narrow bull conditions).

## Verdict

❌ **Tested, rejected.** Not deployed. Keeping the report here so we don't repeat this experiment without remembering why it failed.

## Files in this folder

- `README.md` — this file
- `backtest-v2.1-validation-report-hybrid.json`
- `backtest-v2.1-validation-report-hybrid.csv` — includes `exit_mode` column showing which path each trade took
