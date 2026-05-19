# SID Strategy — Project Context

This folder contains everything for the **SID Swing Strategy** bot.
It is kept entirely separate from the Ironclad strategy (which lives in the parent `Trading Setup/` folder).

---

## ⚠️ CRITICAL: Where the live code actually lives

There are TWO `SID/` folders on disk and they are NOT the same:

| Path | What it is | git branch | Use? |
|---|---|---|---|
| `Trading Setup/SID/` (parent) | **Stale snapshot** — older v1.0 code | `claude/silly-robinson-abcf6c` | ❌ **DO NOT EDIT.** Anything here is out of date. |
| `Trading Setup/SID/.claude/worktrees/silly-robinson-abcf6c/SID/` (worktree) | **LIVE main branch** — current v2.1 deployment | `main` | ✅ **All bot work goes here.** This is what GitHub Actions deploys. |

**Verification:** `git worktree list` from the repo root shows the worktree at the path above is on `main`. The deployed bot version (currently **v2.1** — dynamic TP1+TP2) is in the worktree's `bot-sid.js`. Entry rules are validated at **70.4% WR on the AUTO tier** per the Excel report at `~/Downloads/SID V2 Method Back Testing (tiered + filter subtotals)(1).xlsx`; V2.1 exits validated at **77.6% WR / PF 3.62** in `backtest-sid-v2.1.py`.

**Rule of thumb before editing anything:**
1. Run `git status` to confirm which branch you're on.
2. If the file you're about to edit exists in the worktree, edit there — never at the parent path.
3. If you find duplicate files at both paths, the worktree version is authoritative.
4. Never write new strategy/backtest files at the parent path. They will not be deployed.

---

## V2 / V2.1 method — the actual deployed rules

The bot ships **v2.1** (dynamic TP1+TP2 partial exits, launched 2026-05-18). Entry rules are unchanged from v2.0 — V2.1 only changes how positions exit.

### V2 entry stack (unchanged)

A backtest that doesn't apply these will produce ~45% WR instead of the validated 70%:

| Filter | Where defined | Notes |
|---|---|---|
| RSI(14) extreme: <30 (long) / >70 (short) | `bot-sid.js` `detectEntrySignal` | Base SID rule |
| RSI(3) rebound zone confirmation | `bot-sid.js` | V2 addition — RSI(3) must also be in same zone |
| Daily RSI + MACD direction alignment | `bot-sid.js` | Base SID rule |
| **RSI no-go zone at entry**: <45 (long) / >55 (short) | `bot-sid.js` (V2 logic) | Rejects late entries |
| **Weekly RSI direction** matches trade direction | `bot-sid.js` (V2 logic) | Trend filter |
| **Weekly MACD direction** matches trade direction | `bot-sid.js` (V2 logic) | Trend filter |
| **14-day earnings blackout** | `bot-sid.js` `isWithinEarningsWindow` | Hard skip |
| **80-ticker tier1 universe** (AUTO tier) | `watchlist-sid.json` + `asset-classification.json` | Proven set with 70% WR |

### V2.1 exit model (NEW — replaces v2.0's single RSI-50 full exit)

Per instructor S3_P1 (long) / S3_P2 (short) transcripts. Two-stage exit:

| Stage | Trigger | Action | Where |
|---|---|---|---|
| **TP1** | RSI(14) hits 50 (long ≥50, short ≤50) | Close **50%** of position. Move stop on remaining 50% to break-even (entry price). | `bot-sid.js` `checkPositions` Branch A |
| **TP2 (a)** | Break-even stop hit on runner | Close remaining 50% at entry price | `checkPositions` Branch B |
| **TP2 (b)** | Price touches **50-day SMA** | Close remaining 50% at the SMA | `checkPositions` Branch B |
| **TP2 (c)** | Price touches **200-day SMA** | Close remaining 50% at the SMA | `checkPositions` Branch B |
| **TP2 (d)** | **30-trading-day timeout** since TP1 | Close remaining 50% at close | `checkPositions` Branch B |
| Pre-TP1 stop | Original stop hit before RSI 50 | Full close (loss) — both halves go | `checkPositions` Branch A |

**Win-rate definition under V2.1:** a trade counts as a WIN whenever TP1 fires, regardless of whether the runner round-trips back to break-even. The TP1 partial alone is the win — the runner is upside optionality.

**Schema impact** — positions in `open-positions-sid.json` now carry: `tp1_hit`, `tp1_date`, `tp1_price`, `tp1_shares`, `tp1_pnl`, `tp1_rsi`, `shares_total`, `shares_remaining`, `orig_stop`. Closed records add `tp2_*` plus `total_pnl` and `exit_strategy`. Legacy v2.0 positions are auto-upgraded on first read.

**Toggle** — `SID_DYNAMIC_TP=false` reverts to v2.0 single-exit behaviour for A/B testing or emergency revert.

### Strategy Test Vault

Each strategy variant we backtest gets a folder under `SID/strategy-test-vault/` with its own README + JSON/CSV reports. Index lives in `strategy-test-vault/README.md`. **Check this first** before re-running any backtest — the variant you want may already be catalogued.

Currently in the vault:
- `v2.0-baseline-rsi50-full/` — V2 reference benchmark
- `v2.1-default-30d-timeout/` — currently LIVE
- `v2.1-tp2-timeout-14d/` — marginal +1.4% lift, not adopted
- `v2.1-hybrid-algorithmic-bullish/` — tested, underperforms by -10%
- `v2.1-risk-doubled-2pct/` — scaling reference (\$400/trade)

When a new variant is tested and beats the current LIVE config cleanly, add it as a new vault folder and update both this section and the vault index README.

### Backtests

| File | What it tests | Result (5y AUTO tier, 1% risk) |
|---|---|---|
| `SID/backtest-sid-v2.py` | V2 entry rules + RSI-50 full exit (v2.0 baseline) | 296 trades, 70.3% WR, PF 2.57, **+$26,750** |
| `SID/backtest-sid-v2.1.py` | V2 entry rules + TP1/TP2 partial exits (default 30d timeout) | **302 trades**, 69.5% WR, PF 2.55, **+$28,046** |
| `SID/backtest-sid-v2.1.py` (`SID_TP2_TIMEOUT=14`) | V2.1 with 14d TP2 timeout instead of 30d | 304 trades, 69.7% WR, PF 2.57, +$28,449 |
| `SID/backtest-sid-v2.1.py` (`SID_HYBRID=true`) | Hybrid: V2.1 runner only on long-term-bullish tickers | 302 trades, 69.5% WR, PF 2.39, +$25,154 |

The Excel report `SID V2 Method Back Testing (tiered + filter subtotals).xlsx` is the user's green-flag v2.0 artifact (70.4% AUTO / 64.7% blended).

**Verdict:** V2.1 default beats V2 baseline by **+$1,296 over 5 years** with essentially the same trade count and a slightly lower WR (69.5% vs 70.3%). The TP2 uplift on winners is **+$24,733 (+115%)** vs what V2 captures. Hybrid restriction underperforms because it skips TP2 on 66% of long trades.

### ⚠️ Backtest bug fixed 2026-05-18 — IF YOU READ OLD RUNS

The V2.1 backtest previously produced 67 trades / +$7,759 because its `main()` downloaded only 5y of price data. The strategy engine itself was correct, but Wilder RSI and the weekly resample series weren't fully seasoned by the time the trade window started, silently rejecting ~75% of ARM/TRIGGER signals in the early years. The fix downloads 5y of additional warmup history (matching `backtest-sid-v2.py`'s window) then filters trades to the 5y trade window. Any old `backtest-v2.1-validation-report.{md,json,csv}` results from before this commit are invalid.

---

---

## Folder Structure

```
SID/
├── bot-sid.js                  — main trading bot (GitHub Actions runs this daily)
├── rules-sid.json              — strategy config (create this before first audit)
├── strategy-audit.js           — pre-flight audit (auto-detects rules-sid.json)
├── trades-sid.csv              — trade log
├── sid-log.json                — safety / run log
├── sid-account.json            — account state (starting balance, equity curve)
├── open-positions-sid.json     — currently open positions
├── closed-positions-sid.json   — historical closed positions
├── SID-README.md               — human-readable strategy overview
├── docs/                       — any additional docs
└── research/
    ├── SID Trading Strategy.pdf  — original source PDF
    └── images/                   — extracted page images (01–27)
```

---

## How the Bot Runs

**GitHub Actions** — `.github/workflows/sid.yml` in the repo root runs `bot-sid.js`
once per weekday at 14:35 UTC (9:35am ET), 5 minutes after US market open.
The workflow uses `working-directory: SID` so all `./` file paths resolve correctly.

**Not on Railway** — SID runs via GitHub Actions (daily cadence), not the Railway
15-minute loop that Ironclad uses.

---

## Strategy Overview (SID)

- **Timeframe**: Daily chart
- **Asset class**: US stocks (and potentially crypto)
- **Style**: Swing trades held days to weeks
- **Source**: `research/SID Trading Strategy.pdf` — 27 pages of rules

Key details to be extracted into `rules-sid.json` before running the audit.

---

## First Steps in This Session

1. Read `SID-README.md` for the current bot status
2. Read `research/SID Trading Strategy.pdf` (or the images in `research/images/`) for the full strategy rules
3. Create `rules-sid.json` from the strategy rules
4. Run `node strategy-audit.js` — it will auto-detect `rules-sid.json`
5. Fix any audit failures before enabling live trading

---

## Risk Note

SID uses **larger position sizes** than Ironclad. The audit script's leverage and
risk-per-trade checks are especially important here. Do not skip them.

---

## Shared Infrastructure (do not modify from this session)

The following live in the parent `Trading Setup/` folder and are shared with Ironclad:

| File | Purpose |
|------|---------|
| `package.json` / `node_modules/` | Shared npm deps — `npm install` from repo root |
| `railway-runner.js` | Ironclad bot runner on Railway — do not touch |
| `.github/workflows/ironclad.yml` | Ironclad workflow — do not touch |
| `closed-positions-ironclad.json` | Ironclad trade history — do not touch |

---

## Stumbling Blocks & Lessons Learned

These are the gotchas paid for in past sessions. Read them before starting work on SID — they save you hours.

### V2.1 backtest warmup bug (2026-05-18)
The V2.1 backtest's `main()` initially downloaded only 5y of price data. Wilder RSI and weekly resamples weren't fully converged at the start of the trade window, silently rejecting **~75% of ARM/TRIGGER signals** in years 1-3.

**Symptom:** 67 trades instead of the V2 baseline's 296. Caused a false panic that V2.1 was destroying trade flow.

**Fix:** download `HISTORY_WARMUP_DAYS + BACKTEST_YEARS` of price data, run the full backtest, then filter trades to `entry_date >= trade_window_start` before aggregating. Matches `backtest-sid-v2.py`'s main() pattern.

**Smoke test before trusting any new V2.x backtest:** compare per-ticker trade counts against the V2 baseline report. If V2.1 has < 90% of V2's trade count on tickers V2 trades, the warmup is probably wrong again.

### Worktree vs parent SID folder (recurring)
- `Trading Setup/SID/` = stale v1.0 snapshot
- `Trading Setup/SID/.claude/worktrees/silly-robinson-abcf6c/SID/` = LIVE main branch

If you create files at the parent path expecting them to deploy, they won't. The live bot reads from the worktree (which is on `main`). Use `git worktree list` from the repo root to verify.

### Two sizing methodologies coexist — always note which
- **Fixed dollar risk** (e.g. $200/trade) — what the raw backtest JSON/CSV reports use. Easier to compare across variants.
- **1% compounding from $10K** — what the instructor V2 Excel uses, and what the live bot does. Compounding produces wildly different totals (e.g. V2.1 = $28k fixed-risk vs $36k compounding over 5y).

Always cite the methodology when quoting a P&L number. Mismatched comparisons caused a panic on 2026-05-18 when V2.1 (fixed) looked behind V2 (compounding) until we ran the apples-to-apples Excel.

### Three sizing-methodology recommendations
- Reports for the instructor → use 1% compounding (matches their V2 Excel)
- Variant comparisons in the strategy vault → use fixed $200 (consistency across the vault)
- Account-growth projections / mobile dashboard → use compounding (it's what the live bot actually does)

### V2 Excel methodology has NO position cap
The live bot has a 10% position cap (`maxPositionPct: 0.10`). The instructor's V2 Excel does NOT use it — it sizes purely by 1% risk. When building reports designed to be compared to the V2 Excel, **omit the position cap** so the comparison is apples-to-apples. Document elsewhere (in this CLAUDE.md) what the live bot actually does.

### Strategy Test Vault is the canonical home for variants
`SID/strategy-test-vault/` is the catalogue. Every variant lives in its own folder with a README + JSON/CSV. When you test something new (e.g. a 14d TP2 timeout), add a vault folder for it even if it loses — the vault is also a record of what's been tried and rejected.

Currently in the vault: `v2.0-baseline-rsi50-full/`, `v2.1-default-30d-timeout/` (LIVE), `v2.1-tp2-timeout-14d/`, `v2.1-hybrid-algorithmic-bullish/` (rejected), `v2.1-risk-doubled-2pct/` (scaling reference).

### V2.1 schema migrations
`open-positions-sid.json` entries gained `tp1_hit`, `tp1_date`, `tp1_price`, `tp1_shares`, `tp1_pnl`, `tp1_rsi`, `shares_total`, `shares_remaining`, `orig_stop` in v2.1. Legacy v2.0 positions auto-upgrade on first read (`tp1_hit = false`).

`closed-positions-sid.json` entries gain `tp1_*`, `tp2_*`, `total_pnl`, `exit_strategy`. v2.0-compat fields (`exitLevel`, `exitPrice`, etc.) are still written for dashboard back-compat.

### Rollback paths
- `SID_DYNAMIC_TP=false` in `sid.yml` env → bot reverts to v2.0 single-exit at RSI 50 without a code change
- Revert commit `4308a1b` → drops V2.1 entirely. Be aware that `4308a1b` includes the strategy vault and Excel builder — reverting it removes those too. Use `git revert --no-commit 4308a1b` and selectively `git restore --staged <files>` if you only want to roll back behaviour.

### Dashboard performance toggle (2026-05-19)
Donut + WIN RATE/TRADES/NET P&L tiles support BACKTEST ↔ LIVE toggle. Default = BACKTEST until `closed-positions-sid.json` reaches `LIVE_TRADE_THRESHOLD = 10` closed trades, then auto-flips to LIVE. User manual override persists in `localStorage` under `sid-perf-view`.

**To change the threshold,** edit `LIVE_TRADE_THRESHOLD` in `sid-dashboard.js` line ~58. The JS reads it from `<body data-live-threshold="...">` so the value flows through naturally.

### GitHub Actions Python cache bug — keep an eye out
`actions/setup-python@v5` with `cache: pip` requires `requirements.txt` OR `pyproject.toml` to exist AND `cache-dependency-path: <path>` to point at it. Both are present today (`SID/requirements.txt` + the workflow yaml). If the dashboard ever fails with "No file in /home/runner/work/... matched to [**/requirements.txt or **/pyproject.toml]", check those didn't get deleted.

### Push protocol (cross-cutting but bites SID often)
The SID bot and dashboard auto-commit every run. Any time you have a local commit to push, it'll be rejected as non-fast-forward.

Always: `git fetch origin main` → `git pull --rebase --autostash origin main` → `git push origin main`

Never push to main without explicit user approval. The auto-mode classifier will block silent pushes.

### Crypto-proxy stocks need BTC weekly trend (rule to encode in v2.2)
Stocks like MSTR are BTC proxies — their daily RSI can hit oversold while BTC itself is at structural support. In those cases the trade works because of BTC's weekly trend, not the stock's. Captured during Project 5.0 (B9 MSTR Feb 2026, +37% post-entry). Should be encoded into the rating engine as a per-ticker "crypto-proxy" tag with BTC weekly trend check.

### PLTR Nov 2025 — pre-cross alignment beats post-cross
On B7 PLTR (short setup), waiting for the full MACD cross meant entering at $175 with stop $208 (risk/share = $33). Entering on the alignment-only bar a day earlier was $190 with same stop (risk/share = $17). Same trade direction, half the risk per share.

**Rule to consider for v2.2 rating engine:** weight "MACD aligned in trade direction (no cross yet)" equal to or higher than "MACD has fully crossed". The Pine indicator port should visually flag both options so the trader can see both entries.

### Earnings 14-day blackout is PRE-ONLY
The bot only blocks trading in the 14 days BEFORE earnings. The day AFTER earnings is permitted and is often a high-confidence entry because the announcement risk has just been removed.

### AUTO vs HUMAN tier
80 tickers in `v2_auto_approved_80` auto-fire. 33 tickers in `v2_human_approval_33` (high-vol / crypto / new IPO) are LOG-ONLY in v2.1 — Telegram approval flow deferred to v2.2. If a HUMAN-tier signal fires, the bot logs it but does not enter.

### Mystery commits explained
- "Dashboard update YYYY-MM-DD HH:MM UTC" → from `research.yml` → Ironclad's dashboard at `docs/index.html`
- "SID dashboard update YYYY-MM-DD HH:MM UTC" → from `sid-dashboard.yml` → SID dashboard at `docs/sid/index.html`
- "SID run YYYY-MM-DD HH:MM UTC" → from `sid.yml` → SID bot state commit
- "Bot run YYYY-MM-DD HH:MM UTC" → from `trade.yml` → VWAP scalper state commit
- "Ironclad run YYYY-MM-DD HH:MM UTC" → from `ironclad.yml` → manual Ironclad backup runs

Don't confuse them when grepping git log.

---

## See also

- Root project hub → [`../CLAUDE.md`](../CLAUDE.md)
- Ironclad context → [`../IRONCLAD-MEMORY.md`](../IRONCLAD-MEMORY.md)
- VWAP context → [`../VWAP-MEMORY.md`](../VWAP-MEMORY.md)
- Strategy vault → [`strategy-test-vault/README.md`](strategy-test-vault/README.md)
- Excel report → [`strategy-test-vault/v2.1-default-30d-timeout/SID V2.1 Method Back Testing.xlsx`](strategy-test-vault/v2.1-default-30d-timeout/)
