# TP2-RSI Experiment — REJECTED (negative result, catalogued 2026-06-13)

**Question:** Should the runner's TP2 exit fire on RSI reaching the opposite
extreme (overbought for a long runner / oversold for a short runner) instead
of — or in addition to — the instructor's 50/200-day SMA touch?

**Origin:** Alan observed (2026-06-13) that the 50MA TP2 "doesn't seem well
respected" looking through charts, and proposed RSI-oversold as the short
runner's TP2. Tested faithfully against the v2.2.1 baseline.

**Harness:** `SID/backtest-sid-tp2-rsi.py` (copy of v2.2.1 hybrid backtest with
env-gated `SID_TP2_MODE`). tier1, 5y, $200 fixed risk.
- `baseline`    — first of {BE, SMA50, SMA200, timeout}  (current v2.2.1)
- `rsi_replace` — first of {BE, RSI-extreme, timeout}  (drop SMAs — Alan's idea)
- `rsi_add`     — first of {BE, RSI-extreme, SMA50, SMA200, timeout}

## Results

| | baseline | rsi_replace | rsi_add |
|---|---|---|---|
| Trades | 303 | 302 | 303 |
| Win rate | 71.3% | 71.2% | 71.3% |
| Profit factor | 2.72 | 2.75 | 2.64 |
| Total PnL | $29,528 | $29,956 (+$428) | $28,119 (−$1,409) |
| **BE round-trips** | **65 (30%)** | **123 (57%)** | 65 (30%) |
| Long PnL | $26,345 | $27,527 | $24,936 |
| Short PnL | $3,183 | $2,428 (−$755) | $3,183 |

## Verdict: REJECT both RSI variants

1. **`rsi_replace` makes a marginal +$428 but DOUBLES round-trips to BE
   (65 → 123, i.e. 30% → 57%).** It's the opposite of the stated goal (reduce
   round-trips). The mechanism is feast-or-famine: dropping the SMA bank lets
   runners ride to either a big RSI-extreme win (48 longs @ avg +$371) OR all
   the way back to BE for $0. Far lumpier equity curve for trivial extra total.

2. **It specifically penalizes shorts (−$755).** Across 89 shorts, `rsi_oversold`
   fired only **6 times** — bullish-market shorts almost never reach daily
   oversold before they bounce (the GOOG 2026-06 lesson: RSI runner bottomed at
   38.4, never near 30). The rule fails on exactly the side that most needs
   protection.

3. **`rsi_add` is strictly worse (−$1,409).** Adding RSI-extreme on top of the
   SMAs just cuts clean runners short. No upside.

## What this points to instead

The round-trip-to-BE problem (30% of runners) is real, but RSI-extreme is the
wrong tool. The structural fix is a **trailing stop on the runner** — it banks
profit as the move extends and exits on the *reversal*, independent of whether
price reaches any particular RSI level (so it works on bullish-name shorts too).
That's the next experiment.

**Operational takeaway adopted (Alan, 2026-06-13):** on the runner half of a
short in a long-term-bullish name, the mechanical TP2 has a blind spot (RSI
won't arrive, SMA can round-trip). Cover it with manual S/R-level profit-taking
until a trailing stop automates it. Candidate enhancement: bot flags
`is_lt_bullish` short runners as MANUAL-WATCH.

## Files
- `backtest-tp2-rsi-report.json/.csv` — baseline run
- `backtest-tp2-rsi-report-tp2-rsi_replace.json/.csv` — Alan's proposal
- `backtest-tp2-rsi-report-tp2-rsi_add.json/.csv` — additive variant
