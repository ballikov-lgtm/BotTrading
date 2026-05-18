# SID Strategy Test Vault

Catalogue of validated SID-method backtest variants. Each subfolder holds the variant's findings (this README is the index), the JSON validation report, and the trades CSV.

**Use this vault to:**
- Compare strategy variants against the live baseline
- Resurrect a previously-validated configuration without re-running it
- Track which variants beat the baseline and by how much

**House rules:**
- Only add a variant to the vault after it's been backtested cleanly on the tier1 80-ticker AUTO universe over 5 years
- Always note the **as-of date** of the backtest — yfinance prices and earnings dates drift over time
- Always note which **risk-per-trade** the run used (\$200 fixed = 2% of \$10K starting account)
- If the V2.1 backtest changes structurally (e.g. share-floor tweak, new TP rule), re-run all vault variants and update the readmes
- **Shareable Excel reports** (matching the user's V2 Excel methodology) live alongside the raw JSON/CSV in each folder. Build with `python scripts/build-v2.1-excel-report.py` (currently only the default variant has one)

---

## Variants in the vault

| Variant | Folder | Trades | WR | PF | Total 5y P&L | Status |
|---|---|---|---|---|---|---|
| **V2.0 baseline** (RSI 50 full exit) | [`v2.0-baseline-rsi50-full/`](v2.0-baseline-rsi50-full/) | 296 | 70.3% | 2.57 | +\$26,750 | Reference benchmark |
| **V2.1 default** (TP1 RSI50 + TP2 SMA, 30d timeout) | [`v2.1-default-30d-timeout/`](v2.1-default-30d-timeout/) | **302** | 69.5% | 2.55 | **+\$28,046** | ✅ LIVE in bot (current) |
| V2.1 + 14d TP2 timeout | [`v2.1-tp2-timeout-14d/`](v2.1-tp2-timeout-14d/) | 304 | 69.7% | 2.57 | +\$28,449 | Best-by-margin, not adopted |
| V2.1 + algorithmic bullish hybrid | [`v2.1-hybrid-algorithmic-bullish/`](v2.1-hybrid-algorithmic-bullish/) | 302 | 69.5% | 2.39 | +\$25,154 | Tested, underperforms |
| V2.1 + 2× risk per trade | [`v2.1-risk-doubled-2pct/`](v2.1-risk-doubled-2pct/) | 302 | 69.5% | 2.56 | +\$56,846 | Tested, scaling reference |

All numbers are on the tier1 80-ticker AUTO universe, 5-year window ending 2026-05-18, \$200 risk/trade (or noted).

---

## How to re-run any variant

All variants share `backtest-sid-v2.1.py` and are toggled via env vars:

```bash
cd SID

# V2.1 default (no env vars needed)
python backtest-sid-v2.1.py

# 14d TP2 timeout instead of 30d
SID_TP2_TIMEOUT=14 python backtest-sid-v2.1.py

# Algorithmic-bullish hybrid (V2.1 only on long-term-bullish tickers)
SID_HYBRID=true python backtest-sid-v2.1.py

# 2x risk per trade
SID_RISK_PER_TRADE=400 python backtest-sid-v2.1.py

# Force every trade through V2 single-exit (debug — disables TP1/TP2)
SID_FORCE_V2=true python backtest-sid-v2.1.py
```

The backtest writes reports to suffixed filenames so they don't clobber each other:
- `backtest-v2.1-validation-report.{json,csv}` — default
- `backtest-v2.1-validation-report-tp2t14.{json,csv}` — 14d timeout
- `backtest-v2.1-validation-report-hybrid.{json,csv}` — hybrid
- `backtest-v2.1-validation-report-risk400.{json,csv}` — 2x risk

V2.0 baseline lives in `backtest-sid-v2.py` (separate file, no env-var toggle needed — it runs all 5 V2 variants and writes `backtest-v2-validation-report.{json,md}`).

---

## Historical correction note (2026-05-18)

The V2.1 backtest had a data-window bug from 2026-05-16 to 2026-05-18 that produced incorrect (low) trade counts and P&L. Any vault entries created before 2026-05-18 should be considered invalid — the fix is described in `CLAUDE.md` and `bot-sid.js` v2.1 header. All current vault entries use the post-fix backtest.
