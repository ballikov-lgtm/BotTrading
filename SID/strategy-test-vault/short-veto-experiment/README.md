# Short-Veto Experiment — REJECTED (negative result, catalogued 2026-06-13)

**Question:** Should the bot veto SHORT entries that are "counter-trend against a
bullish recovery" — the UNH-class trade (short into a weekly recovery from deep
oversold + a daily double bottom)? Two veto shapes were tested:
1. **Blunt:** skip any short on a long-term-bullish asset (`is_lt_bullish`).
2. **Surgical:** skip a short if weekly RSI dipped below `depth` within the last
   `lookback` weeks AND current weekly RSI > `recovery` (the recovery fingerprint).

**Origin:** Alan reviewed live entries (2026-06-13). The UNH short (−$691, live
May-2026 trade) was a counter-trend short into an obvious weekly recovery (weekly
RSI 24→67) + daily double bottom ($266/$256 → +40%). He asked whether a
mechanical reversal-context veto would help. Tested exhaustively; rejected.

**Harness:** `SID/backtest-sid-short-veto.py` (clone of v2.2.1 hybrid). Two paths:
- `SID_SHORT_VETO=bullish` — real backtest run of the blunt veto.
- instrumented baseline records each short's weekly washout fingerprint
  (`wk_rsi_min8/13/26_at_entry`, `wk_rsi_now_at_entry`) so a post-processor
  evaluates EVERY (depth, lookback, recovery) combination from one run.

## Result 1 — Blunt veto (no shorts on long-term-bullish assets)

| | Baseline | Bullish veto | Delta |
|---|---|---|---|
| Total PnL | $29,335 | $28,280 | **−$1,055** |
| Shorts | 89 | 67 (−22) | |
| Short WR | 62.9% | 64.2% | +1.3pp |
| Short PnL | $3,183 | $2,128 | −$1,055 |

The 22 vetoed bullish-name shorts were collectively **net +$1,055 profitable.**
The blunt rule throws out winners to dodge the rare loser. REJECTED.

## Result 2 — Surgical recovery veto (full 27-combo sweep)

Veto if `min weekly RSI over <lookback> < <depth>` AND `weekly RSI now > <recovery>`.

- **Best cell in the entire grid: +$396 over 5 years** (depth30 / lookback26w /
  recovery50) — ~$80/yr, pure noise on an 89-short sample.
- **Most combinations LOSE money** — up to −$2,700 (e.g. depth40/26w/off vetoes
  54 shorts worth +$2,699 of PnL).
- Decisive reason: shorts with a weekly-washout fingerprint are **mostly winners.**
  Every "recovery-filter-off" row removes positive PnL. Only a narrow shallow-depth
  + recovery-on band nets marginally positive, and even then it vetoes near-breakeven
  trades (best cell: 11 shorts averaging −$36 each).

## Verdict: REJECT all mechanical reversal vetoes

Shorting after a weekly recovery is **not systematically bad** in this strategy —
most such shorts win. UNH was an outlier (a real reversal that hurt), not evidence
of a systematic edge leak. A mechanical veto would cost money in the large majority
of tunings. This also implies widening the weekly-trend lookback (the "fix the
1-week-slope myopia" idea) would likely hurt too — it blocks the same winning shorts.

**Caveat:** UNH itself is NOT in the backtest (live trade, outside the 5y window),
so the sweep tests the principle against 89 *other* recovery-context shorts. Those
say the pattern is usually fine.

## What we kept instead

The **MANUAL-WATCH flag** (v2.2.2) — surfaces the rare bullish-name short runner
for human judgment without a mechanical rule. Human eyes on the outlier; zero PnL
cost on the winners. That's the adopted response to this whole investigation.

## Separate finding worth noting

The short side is the strategy's **thin side** — $3,183 / 5y at 62.9% WR vs the
long side's $26,152. If edge improvement is wanted, the leverage is in short
sizing/selection generally, not a reversal-pattern filter.

## Files
- `backtest-short-veto-report.json/.csv` — instrumented baseline (89 shorts w/ fingerprints)
- `backtest-short-veto-report-shortveto-bullish.json/.csv` — blunt-veto run
