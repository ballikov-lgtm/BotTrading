# SID Strategy — Project Context

This folder contains everything for the **SID Swing Strategy** bot.
It is kept entirely separate from the Ironclad strategy (which lives in the parent `Trading Setup/` folder).

---

## ⚠️ CRITICAL: Where the live code actually lives

There are TWO `SID/` folders on disk and they are NOT the same:

| Path | What it is | git branch | Use? |
|---|---|---|---|
| `Trading Setup/SID/` (parent) | **Stale snapshot** — older v1.0 code | `claude/silly-robinson-abcf6c` | ❌ **DO NOT EDIT.** Anything here is out of date. |
| `Trading Setup/SID/.claude/worktrees/silly-robinson-abcf6c/SID/` (worktree) | **LIVE main branch** — origin/main is **v2.6.0** (commit `cd7b99b6d`, 2026-10-24); the working tree carries the UNCOMMITTED **v2.6.1** on top | `main` | ✅ **All bot work goes here.** This is what GitHub Actions and the Railway service deploy. |

**Verification:** `git worktree list` from the repo root shows the worktree at the path above is on `main`. **CORRECTED 2026-10-24 (v2.6.1 session):** this file previously said origin/main was v2.5.0 with v2.6.0 uncommitted — v2.6.0 HAS SINCE SHIPPED (**origin/main = v2.6.0, commit `cd7b99b6d`**, and the Railway service is live and pushing `SID railway run ...` commits). The working tree now carries the UNCOMMITTED **v2.6.1** on top. *When this file and the live code disagree, the live code wins — fix the file.* (Historical note: historical note: **v2.2.5** — TP1 cancel-first / held-shares fix + dashboard exit-target readout; entry is the v2.2.3 bar-by-bar arm replay, exits the v2.2.1 HYBRID model with the v2.2.5 broker-order fix) is in the worktree's `bot-sid.js`. The v2.2.3 ENTRY is validated at **73.9% WR / PF 3.19 / +$31,426** (tier1, 5y, $200 fixed risk) per `backtest-sid-bot-parity.py` (see `strategy-test-vault/bot-parity-experiment/`). *Historical provenance (do not treat as current-version markers):* entry rules were originally validated at **70.4% WR on the AUTO tier** per the Excel report at `~/Downloads/SID V2 Method Back Testing (tiered + filter subtotals)(1).xlsx`; the V2.1 exits were validated at **77.6% WR / PF 3.62** in `backtest-sid-v2.1.py`.

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

**TWO schedulers run SID, deliberately (Phase 1, since v2.6.0).**

**1. GitHub Actions** — `.github/workflows/sid.yml` runs `bot-sid.js` on THREE staggered
weekday crons: **14:35 / 16:35 / 18:35 UTC** (since the 2026-09-01 cron-redundancy change —
GHA crons are best-effort and were landing hours late, sometimes past the US close). The
workflow uses `working-directory: SID` so all `./` file paths resolve correctly.

**2. Railway CRON service** (v2.6.0, timing reworked in v2.6.1) — `SID/railway-sid-runner.js`, schedule
`*/15 13-23 * * 1-5` (UTC). This is a **one-shot cron job, NOT an always-on loop**: each run
pulls state from `main` via the GitHub Contents API, runs `bot-sid.js` once, pushes changed
state back, and exits, so it is billed per execution rather than resident 24/7. Added because
GHA crons were landing ~3h late (14:35 → ~18:15, 18:35 → ~21:10 UTC) while Railway
documents its cron as varying only "by a few minutes". Whether a cycle does the full scan or
the cheap exits-only path is decided by **Alpaca's `/v2/clock`**, never a hardcoded calendar.

**v2.6.1 — ENTRIES HAPPEN ONCE A DAY, AT THE CLOSE.** A Railway cycle that starts inside the
**close window** (default the final 20 minutes, derived from `/v2/clock`'s `next_close`) WAITS to
**T-3 minutes**, re-reads the clock, and only then runs the entry scan — because the strategy is
defined as `entry = close`, so a mid-session scan judges an unfinished bar. EVERY OTHER CYCLE IS
EXITS-ONLY. Knobs: `SID_CLOSE_WINDOW_MIN` (20) / `SID_ENTRY_SUBMIT_OFFSET_MIN` (3) /
`SID_MAX_ENTRY_WAIT_MIN` (30). The cron expression needs no change. **Note the Phase-1 asymmetry:**
this discipline lives in the RUNNER, so a GitHub Actions run still scans whenever it lands.
Deploy + verification + rollback: **`SID/RAILWAY-DEPLOY.md`**.

**This is SID's OWN Railway service**, separate from Ironclad's. SID owns
`SID/railway-sid-runner.js` + `SID/railway-sid.json`; the repo-root `railway-runner.js` and
`railway.json` are **Ironclad's — never touch them**.

**Phase 2 (NOT done yet):** once the Railway service has proven itself over a few clean
sessions, comment out `sid.yml`'s `schedule:` block and keep `workflow_dispatch` as the manual
backup. Procedure + go/no-go evidence in `SID/RAILWAY-DEPLOY.md` § Phase 2.

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
| `railway-runner.js` + root `railway.json` | **Ironclad’s** Railway service — do not touch. SID’s own Railway files are `SID/railway-sid-runner.js` + `SID/railway-sid.json` (v2.6.0) and are SID-owned. |
| `.github/workflows/ironclad.yml` | Ironclad workflow — do not touch |
| `closed-positions-ironclad.json` | Ironclad trade history — do not touch |

---

## Stumbling Blocks & Lessons Learned

These are the gotchas paid for in past sessions. Read them before starting work on SID — they save you hours.

### detectEntrySignal rewritten to a bar-by-bar arm replay (2026-06-29) — MERGED TO MAIN (commit 48579f7e)
The live bot's `detectEntrySignal` was a one-shot "episode scan" (find most-recent
RSI-cross-into-extreme, then check today for RSI+MACD alignment). It had **NO arm
timeout, NO RSI(3) confirmation, NO weekly-SMA arm gate** — far looser than the
validated strategy. Concretely it would still fire ADBE's 2026-06-17 oversold
signal as a 2026-06-26 entry (9 calendar days later) because the episode never
expired. That stale ADBE long is the live position the rewrite fixes.

**What changed (SHIPPED — merged to main commit 48579f7e, merge cf972f64):**
- Replaced `detectEntrySignal(candles)` with a **bounded bar-by-bar replay** of
  the backtest's arm/trigger/cooldown state machine. It replays the trailing
  `CONFIG.armReplayBars` (default 40) bars from clean state and returns a signal
  ONLY if a trigger fires on the final (today's) bar.
- New CONFIG knobs: `armTimeoutDays=3`, `rearmCooldownLong=0`,
  `rearmCooldownShort=5`, `armReplayBars=40` (all env-overridable via
  `SID_ARM_TIMEOUT_DAYS` / `SID_REARM_COOLDOWN_LONG` / `SID_REARM_COOLDOWN_SHORT`
  / `SID_ARM_REPLAY_BARS`). Added an `intEnv()` helper so a legitimate `0`
  (rearmCooldownLong) survives — `parseInt(x)||def` would have clobbered it.
- Named RSI constants `RSI_PERIOD=14 / RSI3_PERIOD=3 / RSI_OVERSOLD=30 /
  RSI_OVERBOUGHT=70` (were inline literals) so the replay reads 1:1 vs the .py.
- New `buildWeeklyDailyAligned(candles)` — replicates the backtest's TWO distinct
  W-FRI reindex conventions (see next note). Used for the weekly arm + trigger gates.
- Added a `import.meta.url` main-guard + named `export {…}` block at the bottom so
  the module's pure functions can be unit-tested without triggering `run()`. The
  GHA workflow runs `node bot-sid.js` directly, so the guard is true there and
  the bot runs exactly as before.

**Source of truth:** `SID/backtest-sid-bot-parity.py` with
`SID_BOT_PARITY=false SID_REARM_COOLDOWN_LONG=0 SID_REARM_COOLDOWN_SHORT=5`
→ 280 trades / 73.9% WR / PF 3.19 / +$31,426 (tier1, 5y, $200 fixed risk). Arm
block ~L509-548, trigger block ~L550-600. Reference entries CSV:
`strategy-test-vault/bot-parity-experiment/backtest-bot-parity-report-rearmcdL0S5.csv`.

**Verified:** ported function reproduces the backtest entry set EXACTLY (date+side+
entry+stop) for UNH/ADBE/GOOG/AAPL/META once the (intentionally relocated) earnings
gate is folded back into the replica — 18/18 matched, 0 missed, 0 false-extra. The
only production-path residual is held-position days the real bot never scans (it
calls detectEntrySignal only when flat). Confirmed ADBE no longer fires on 2026-06-26.

**Two parity gotchas earned here (read before touching this again):**

1. **The backtest uses TWO different weekly reindex conventions — don't conflate.**
   - Weekly **SMA50/200 ARM gate** (`sma_long_ok`/`sma_short_ok`): W-FRI resample,
     `(wfast>wslow).reindex(daily, ffill)` with **NO index shift**. A daily bar uses
     the most recent COMPLETED week (Mon-Thu → prior Friday; Friday → its own week).
     No intra-week lookahead.
   - Weekly **RSI/MACD TRIGGER direction** (`wk_rsi_rising`/`wk_macd_rising`):
     `compute_weekly_direction` shifts the weekly index back 4 days (Fri→Mon) BEFORE
     ffill, so a daily bar Mon-Fri uses THIS week's Friday value (a deliberate
     1-day intra-week lookahead the validated strategy accepts). `buildWeeklyDailyAligned`
     replicates both: it tracks each bucket's `friMs` (no-shift anchor) and `monMs`
     (shifted anchor) and ffills each gate on its own anchor.

2. **Earnings is the reason the bot's flat-replay can't 1:1 the backtest's entries.**
   Per spec, earnings/PPI/VIX stay in the CALLER (`run()`), NOT in `detectEntrySignal`.
   But the backtest folds the 14-day earnings blackout INTO the arm machine — it
   expires an active arm early AND blocks arming during the window. That shifts the
   re-arm-cooldown phase by a bar, which cascades. Example: ADBE earnings 2023-06-15
   → blackout from 06-01 expires the 05-26 short arm a bar early, and the cooldown
   chain then lands a clean re-arm on 06-16 → trigger on 06-20 (a validated entry my
   earnings-less port misses by one bar). This is NOT a port bug — folding earnings
   into a verification replica reproduces the entry exactly. If you ever need
   bit-exact backtest parity inside detectEntrySignal you'd have to pass earnings in,
   but DON'T — the caller's hard-skip on the trigger bar is the agreed design and the
   net entry-set delta is negligible (an earnings-blocked trigger is skipped anyway).

**SHIPPED (2026-06-28):** version bumped to **v2.2.3** (entry-rule change per the
versioning rule). SID-README "Current version" line + Version History row updated,
dashboard (`docs/sid/index.html` + `sid-dashboard.js` STRATEGY_VERSION='2.2.3',
headline 73.9 / 280 / +$31,426) updated, and the TradingView Pine visualiser pushed
+ saved as "SID Strategy v2.2.3" (`SID/pine/sid-strategy-v2.2.3.pine`). Rejected
cooldown variants (rearmcd5, L0S3, L0S7) live in `strategy-test-vault/bot-parity-experiment/`.

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

### ⚠️ The dashboard is GENERATED — edit `sid-dashboard.js`, NOT `docs/sid/index.html`
Confirmed the hard way 2026-06-13. `docs/sid/index.html` is **build output** from
`SID/sid-dashboard.js`, regenerated by `sid-dashboard.yml` 3×/day. Any hand-edit
to `index.html` (version markers, headline stats, Updates count, history rows,
live tiles) is **silently reverted on the next rebuild.** This cost real
confusion: the version markers read v2.1 for days after v2.2.1 shipped because
`STRATEGY_VERSION` and the `HEADLINE_BACKTEST_*` consts were hardcoded to v2.1
at the top of `sid-dashboard.js` (lines ~32-50). The hand-edits to `index.html`
kept getting stomped.

**Source-of-truth map for the dashboard:**
| Dashboard element | Edit this, NOT index.html |
|---|---|
| Version markers (title/brand/banner/footer/perf-note) | `STRATEGY_VERSION` + the hardcoded `V2.x` template strings in `sid-dashboard.js` |
| Headline backtest WR / PnL / trades / wins / donut | `HEADLINE_BACKTEST_*` consts in `sid-dashboard.js` |
| Updates tab + count badge | `SID/strategy-updates.json` (count is auto-computed from array length) |
| Open-position cards (+ MANUAL-WATCH badge) | `SID/open-positions-sid.json` (written by the bot) |
| Closed-trade history + live WR/PnL tiles | `SID/closed-positions-sid.json` |

**To verify a dashboard change:** run `node SID/sid-dashboard.js` locally and grep
the regenerated `index.html` — never trust a hand-edit to survive.

### MANUAL-WATCH flag for bullish-asset short runners (v2.2.2, 2026-06-13)
The bot flags any open SHORT on a long-term-bullish asset for manual S/R review.
- **Why:** on long-term-bullish names the mechanical TP2 has a blind spot — RSI
  rarely reaches daily oversold before the bounce (GOOG 2026-06: runner RSI
  bottomed 38.4, never near 30), and the SMA exit can round-trip to BE (30% of
  all runners do). The TP2-RSI experiment proved that *replacing* the SMA exit
  with RSI-extreme DOUBLES round-trips (65→123) and `rsi_oversold` fired only 6×
  across 89 shorts — REJECTED (`SID/strategy-test-vault/tp2-rsi-experiment/`).
  So the fix is a human eyeballing support; the flag says WHICH runners need it.
- **Classification:** `longTermBullish(candles)` in `bot-sid.js` — daily proxy
  `price > SMA200 AND SMA50 > SMA200` (the backtest's weekly EMA/MACD/SMA200
  classifier needs ~5y of weekly data; the position monitor only fetches 2y, and
  the daily proxy is stable through the pullback you short into). SHORTS only —
  longs ride the drift, shorts fight it.
- **Surfaces 3 ways:** `⚠ MANUAL-WATCH` line in the bot log; pulsing
  `👁 WATCH · S/R` badge on the dashboard position card (`pos-tag-watch` CSS,
  reads `pos.manual_watch` from open-positions JSON); `tg.alertManualWatch()`
  Telegram reminder once per run.
- **Non-trading:** does NOT change entries/exits. Trade logic + backtest numbers
  identical to v2.2.1. It's a reminder, not a rule.
- **Validation:** flags GOOG ✓ and UNH ✓ (both bullish-asset shorts — UNH was
  the −$691 loss), correctly skips PYPL (a long, downtrend name).

### SHORT APPROVAL GATE — bullish-asset shorts need manual approval (v2.2.4, 2026-07-01)
v2.2.2's MANUAL-WATCH flag only FLAGGED bullish-asset shorts for post-TP1 runner
review — it did NOT block entry. Consequence: UNH auto-shorted at $416.52 (opened
2026-06-30 16:37 UTC, stamped SID v2.2.3, `manual_watch=true`), far below the
439-440 supply zone Alan wanted. Alan decided bullish-asset shorts should no
longer auto-fire.

**What changed (WORKING TREE, not yet committed as of this write-up):**
- `bot-sid.js`:
  - New `CONFIG.shortApprovalGate` (env `SID_SHORT_APPROVAL_GATE`, default ON /
    `!== 'false'`).
  - New gate in `run()`, placed AFTER the AUTO/HUMAN tier routing and BEFORE
    sizing/earnings/PPI/VIX. When the signal is a SHORT and
    `longTermBullish(candles).bullish` is true, the bot does NOT size/execute —
    it logs a `short_approval_required` entry to `sid-log.json` and fires
    `tg.alertShortApprovalNeeded(...)`, then `continue`s. `candles` is the 5y
    scan fetch already in scope; `longTermBullish` reuses the existing daily
    proxy (`price>SMA200 AND SMA50>SMA200`).
  - `BOT_VERSION` → `v2.2.4` + version-history comment block.
- `telegram-alerts.js`: new `alertShortApprovalNeeded({symbol, signalDate,
  currentPrice, proposedEntry, proposedStop, shares, reason, mode})`.
- Dashboard (`sid-dashboard.js`): `STRATEGY_VERSION='2.2.4'`; banner / brand-sub /
  perf-note markers bumped; beta-banner now states the live-vs-backtest
  divergence. HEADLINE_* consts UNCHANGED (see divergence note). New Updates-tab
  entry at the top of `SID/strategy-updates.json` (category `fix`). Regenerated
  `docs/sid/index.html` locally to verify (18 updates, v2.2.4 markers present).
- `SID-README.md`: Current-version line + a new v2.2.4 Version History row.

**Alan approves + fires manually** via the EXISTING manual one-shot flow —
`SID/manual-trade.js` + `sid-manual-trade.yml` already accept an arbitrary
`ticker/side/shares/tp1_price/sl_price/note`, so a discretionary UNH short into
the 439-440 zone is fully supported with NO code change (side=short, tp1_price=
the RSI-50 target or a discretionary limit, sl_price=stop). No auto-fire, no
reply-to-approve infra for v1.

**⚠ BACKTEST DIVERGENCE (say this to anyone comparing live to backtest):** the
v2.2.3 backtest (280 trades / 73.9% WR / PF 3.19 / +$31,426, tier1 5y $200 fixed)
INCLUDES these bullish-asset shorts firing MECHANICALLY. Gating them is a LIVE
execution-discipline overlay, NOT a signal-logic change — no canon rule is
touched (RSI 30/70, MACD alignment, RSI-50 exit all untouched). So the headline
backtest numbers are deliberately UNCHANGED, and LIVE performance will diverge
from the pure backtest on the bullish-asset-short subset. Documented in
README + dashboard + this file so followers don't misread the difference. Revert
with `SID_SHORT_APPROVAL_GATE=false` (restores fully-mechanical bullish-asset
shorts = pure-backtest behaviour).

**Pine:** the v2.2.1 visualiser already distinguishes green=mechanical /
amber=manual-watch (since v2.2.1). No urgent Pine change — the amber flag now
corresponds to "approval-required, not auto-fired." (Update the Pine legend text
next time it's pushed.)

### One-shot UNH close tool (built 2026-07-01, NOT run)
Built to flatten the open UNH short (id d9bca959-…, 2 sh, entry 416.52, broker
stop cf53c7ad-…, paper) on Alan's approval:
- `SID/manual-close.js` — env-driven (`CLOSE_POS_ID` / `CLOSE_SYMBOL` /
  `CLOSE_STOP_ORDER_ID` / `CLOSE_REASON`), same `resolveTradingMode()` gating +
  market-hours guard + dry_run default as `manual-trade.js`. When run
  (paper/live): cancels the broker stop, sweeps any lingering open orders on the
  symbol, submits a market cover (`buy` for a short), polls for fill, then
  reconciles state — removes from `open-positions-sid.json`, appends to
  `closed-positions-sid.json` (+ v2.0-compat dashboard fields), appends to
  `trades-sid.csv`, updates `sid-account.json`, writes a `manual_close`
  `sid-log.json` entry, and Telegram-confirms. Aborts safely (no Alpaca call, no
  state change) if the position isn't found locally — will NOT blind-flatten the
  symbol.
- `.github/workflows/sid-oneshot-close-unh-2026-07-01.yml` — `workflow_dispatch`
  ONLY (no cron → can't self-fire), year-guarded, `contents: write` so it commits
  the reconciled state back to main. Hardcodes the UNH id/symbol/stop.
- IMPORTANT: the UNH short is NOT in the worktree's local
  `open-positions-sid.json` (worktree HEAD predates the 2026-06-30 open) — it
  lives on `origin/main` (cloud state is ahead). So `manual-close.js` MUST run
  against the current cloud checkout (which the workflow does via
  `actions/checkout`), where UNH will be present. Verified the resolver against
  `origin/main`'s state in an isolated copy: correctly targeted UNH by id,
  computed `BUY 2 UNH @ market`, and dry-ran without touching anything.
- How Alan fires it: `gh workflow run sid-oneshot-close-unh-2026-07-01.yml`
  (during US RTH). Delete the workflow file after it fires.

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

## How to push a Pine Script to TradingView

This has been mistaken multiple times — write it down once and follow it.

### Step 0: Decide which MCP to use

| MCP | When | Tools | TV access |
|---|---|---|---|
| **`mcp__tradingview__*`** (TV Desktop) | TV Desktop is running with `--remote-debugging-port=9222` | `pine_*`, `chart_*`, `tv_health_check`, etc. | ✅ FULL access |
| **`mcp__Claude_in_Chrome__*`** | TV Desktop NOT available | `navigate`, `computer`, etc. | ❌ **HARDCODED BLOCKED** on `tradingview.com` |

**Always try the TV Desktop MCP first.** Even if the user says "TV Desktop doesn't work," run `mcp__tradingview__tv_health_check` once — it may already be connected (it was on 2026-05-19 when the user said it didn't work). Don't waste a turn on the Chrome MCP only to discover tradingview.com is blocked.

### Step 1: Health check

```
mcp__tradingview__tv_health_check
```

A `success: true` with `cdp_connected: true` and a `target_url: https://www.tradingview.com/chart/...` means TV Desktop is reachable. Note the `chart_symbol` and `chart_resolution` so you know what ticker/timeframe the strategy will land on.

### Step 2: List existing scripts (so you don't overwrite anything)

```
mcp__tradingview__pine_list_scripts
```

Look for existing SID strategies. New scripts get a new id; existing ones can be opened by name.

### Step 3: Open the Pine Editor

**Critical:** `pine_new` fails with `"Could not open Pine Editor"` if the editor panel isn't already open in TV. Force it open by calling `pine_open` on ANY existing script first:

```
mcp__tradingview__pine_open  { name: "SID Strategy v1.4" }   # or any other script
```

Then immediately create a new strategy slot:

```
mcp__tradingview__pine_new  { type: "strategy" }
```

If you're updating an existing script in place (rather than creating new), skip `pine_new` and just leave the existing script open from step 3.

### Step 4: Inject the source

```
mcp__tradingview__pine_set_source  { source: "<full Pine code as a single string>" }
```

- 416-line / 24KB files fit fine as a single parameter
- Pine v6 Unicode (• → ↑ ✓) compiles fine but I sanitize to ASCII (— → ---, → → ->) to dodge any encoding hiccups in the MCP transport. Comments only — never sanitize Pine syntax.
- The MCP responds with `lines_set: <count>` — verify it matches your expected line count

### Step 5: Compile + save (one tool does both)

```
mcp__tradingview__pine_smart_compile
```

Returns `has_errors: false` on success. **This action also clicks the Pine Save button**, so the script is persisted to the user's TV account in one call. If `has_errors: true`, fetch the error list:

```
mcp__tradingview__pine_get_errors
```

Fix the source, run `pine_set_source` again, then `pine_smart_compile` again.

### Step 6: Verify

```
mcp__tradingview__pine_list_scripts          # new script appears with fresh id + modified timestamp
mcp__tradingview__chart_get_state            # confirms strategy added to chart (in `studies` array)
mcp__tradingview__capture_screenshot { region: "chart" }   # visual confirm
```

### Step 7: If the Pine Editor closes between calls

After save/compile, the Pine Editor panel sometimes closes. Subsequent `pine_set_source` or `pine_new` calls then fail with `"Could not open Pine Editor"`. Re-open with `pine_open` on the same script name (which now exists since you just saved it), then continue.

### Pitfall: TV auto-renders trade markers that look like spaghetti

TradingView's `strategy()` declarations auto-draw orange "TP" / "Long" / "Short" labels at every historical trade-fill bar. On a 5-year backtest with 50+ trades these stack into chart chaos. **The Pine script cannot suppress these** — they're a chart property, not a script setting.

To clean it up, instruct the user to:
1. Right-click the strategy name in the chart's indicator list (top-left of chart)
2. Settings → **Style** tab (NOT Properties)
3. Uncheck **"Signal Labels"**

(There is NO "Display Marks On Bars" checkbox — that was an earlier incorrect note. Unchecking "Signal Labels" alone suppresses the auto trade-marker stacking.)

### Pitfall: `pine_new` DURING ERROR RECOVERY creates duplicate scripts

When `pine_set_source` or `pine_smart_compile` fails with `"Could not open Pine Editor"`, the recovery instinct is to call `pine_new`. **This creates a NEW script slot** — it does NOT re-open the existing editor on the current script. After 4 retry-rounds you end up with `SID Strategy v2.1`, `SID Strategy v2.1 1`, `SID Strategy v2.1 2`, … `v2.1 4` cluttering the user's account, with TV potentially loading multiple of them onto the chart and producing duplicate-rendering chaos.

**Correct error-recovery sequence:**
1. Call `pine_open` on ANY existing script (e.g. "SID Strategy v1.4") to force the editor panel open
2. Then call `pine_open` on the CURRENT script ("SID Strategy v2.1") to switch to it
3. Then retry `pine_set_source`

Never call `pine_new` to "recover" — it's only for genuinely creating a brand-new script.

If duplicates are already in the account, the TV MCP has no `pine_delete` tool — the user must manually right-click each duplicate in their saved-scripts list and Delete. Apologise and explain rather than leaving them.

### Pitfall: saving a BRAND-NEW (untitled) script needs the "Save script" name dialog confirmed

Earned 2026-06-29 pushing SID v2.2.3 into an untitled tab the user left open for me.
The runbook's Step 5 says `pine_smart_compile` "persists the script in one call" —
that's true for an ALREADY-NAMED script (it Ctrl+S in place). For an **untitled**
script it is NOT: the Save click opens a modal **"Save script"** dialog with a name
field (pre-filled from the `strategy()` / `indicator()` title) and Cancel / Save
buttons. The compile returns `has_errors:false` but the script is **not actually
saved** until you confirm the dialog. Press Enter (`ui_keyboard {key:"Enter"}`) or
click the dialog's Save — the pre-filled name (e.g. "SID Strategy v2.2.3") is what
you want, so Enter is safest.

**Verification gotcha:** `pine_list_scripts` reads an `internal_api` cache that can
LAG — right after the save it still showed the old 14-script list with no v2.2.3.
The reliable confirmations are: (a) the **editor tab title** flips from "Untitled
script" to the saved name (screenshot), (b) `chart_get_state` shows the study in
`studies` after the Add-to-chart step, and (c) `data_get_pine_tables
{study_filter:"<name>"}` returns the info table. Don't trust `pine_list_scripts`
alone immediately post-save.

**Add-to-chart is a SEPARATE action:** `pine_smart_compile` returns
`study_added:false` for a fresh script — saving ≠ adding to chart. Click the editor's
**Add to chart** button (locate via `ui_find_element {query:"Add", strategy:"text"}`
→ take the button rect → `ui_mouse_click` at its centre) to render it on the chart.

### Pitfall: `barstate.islast` doesn't always fire on 1D charts — broaden the gate

Confirmed 2026-05-22 on UNH 1D chart. The SID v2.1 info table was rendering on 4h but NOT on 1D, despite:
- `i_showInfoTable=true` (user confirmed input was ticked in dialog)
- Pine script running fine (data_get_pine_labels showed 9 labels, data_get_pine_lines showed 9 lines)
- No compile errors (pine_get_errors returned has_errors=false)
- Identical Pine bytecode running on both timeframes (same compiled study)

The ONLY block in the entire script gated on `barstate.islast` was the info table at the bottom. That's the one block that failed on 1D. Likely interaction with `calc_on_every_tick=false` + the realtime forming bar on 1D not yet being processed by the script (the previous fully-closed bar gets processed instead, where `barstate.islast` evaluates false because the dataset already contains the incomplete realtime bar at a higher index).

**Diagnostic that nailed it down:**
- `data_get_pine_tables` with `study_filter="SID Strategy"` on 1D → 0 tables
- Same call on 4h → 1 table with all 10 IDLE-state rows populated correctly

**Fix:** widen the gate from `barstate.islast` alone to a 3-way OR:
```pine
showTableNow = barstate.islast or barstate.islastconfirmedhistory or bar_index >= last_bar_index - 1
if i_showInfoTable and showTableNow
    var table info = table.new(position.top_right, 2, 14, ...)
    ...
```

- `barstate.islast` covers the realtime/forming bar
- `barstate.islastconfirmedhistory` covers the last closed historical bar (the one the script actually processes when calc_on_every_tick=false and the realtime bar isn't yet ticked over)
- `bar_index >= last_bar_index - 1` is the belt-and-braces fallback

Trade-off: table block runs on up-to-2 bars instead of 1. Negligible perf cost. Tables overwrite cells each call so the visual result is identical.

**Workflow gotcha during the fix:** pushing the source via `pine_set_source` got blocked because the user's Pine Editor had an "Untitled script" tab open (created accidentally when the agent called `pine_new` during error recovery — see existing pitfall about that). The MCP couldn't switch to v2.1.5 while the editor was on Untitled. Resolution requires the user to close the Untitled tab (don't save) before any further automation can target v2.1.5.

### Pitfall: arm logic on a strategy that uses `RSI in extreme zone` re-fires every bar

If your Pine arm condition is `isOverbought = dailyRSI > 70` and `shouldArmShort = na(armDir) and isOverbought and ...`, then once an arm expires (timeout), the very next bar re-arms if RSI is still above 70. On sustained trends this produces a vertical line every 5 bars — chart chaos.

**Fix:** require CROSSING into the zone:
```pine
crossingOverbought = isOverbought and (na(dailyRSI[1]) or dailyRSI[1] <= i_rsiOverbought)
shouldArmShort     = na(armDir) and crossingOverbought and ...
```

Plus add a re-arm cooldown variable to prevent tight re-arming after expired arms:
```pine
shortCooldownOk = na(lastShortArmBar) or bar_index - lastShortArmBar >= i_reArmCooldown
shouldArmShort  = ... and shortCooldownOk
```

This matches the instructor's lesson convention of "one signal day per episode." See `sid-strategy-v2.1.pine` § ARM STATE MACHINE.

### Pitfall: Excel report MUST include AutoFilter + filter-aware SUBTOTAL row

The user's V2 Excel report had a TOTAL row at the bottom of "All Trades" that updated when filters were applied (e.g. filter by Tier=AUTO → see AUTO-only totals). The V2.1 Excel builder lost this feature in an early version and the user re-discovered the gap on 2026-05-21.

**Required features on every Excel rebuild** (already in `SID/scripts/build-v2.1-excel-report.py`):

1. **AutoFilter on the data range** of "All Trades" and "Per-Ticker Summary":
   ```python
   ws.auto_filter.ref = f'A4:Z{data_end}'
   ```
2. **TOTAL row using `SUBTOTAL()` formulas** (function code 9 = SUM, respects filter hides):
   ```python
   ws.cell(row=total_row, column=8).value = f'=SUBTOTAL(9,H{data_start}:H{data_end})'
   ```
3. **FILTER STATS row** with filter-aware Win Rate using `SUMPRODUCT(SUBTOTAL(3, OFFSET(...)) * (Y="WIN"))`:
   - `SUBTOTAL(3, OFFSET(...))` returns 1 per visible row, 0 per hidden
   - Multiplied by `(Outcome="WIN")` → counts visible wins only
   - Divide by `SUBTOTAL(2, trade_num_col)` for the rate

When user filters by Tier (AUTO/HUMAN), Ticker, Outcome, etc., **both** the TOTAL row and FILTER STATS row recompute against the visible rows only. This is the V2 Excel methodology — never regress it again.

### Pitfall: scan path needs 2y daily lookback (not 6mo) for weekly check

The V2 weekly-direction filter at `bot-sid.js:491` requires `weekly.length >= 30` (30 weekly bars). The default fetch range for `fetchDailyCandles()` is `'6mo'`, which gives ~125-130 daily bars → ~26-28 weekly bars after resampling — JUST BELOW the threshold.

**Symptom:** big-cap tickers with decades of history (NVDA, COST, GOOG, INTC, MCD, UNH, LMT, RTX, LCID) silently rejected with "V2 weekly direction: insufficient weekly history (need 30+ weeks)". On 2026-05-21 the user noticed the bot hadn't fired a single trade in 5 days despite the heatmap showing many ripe overbought tickers. 9 of 80 AUTO-tier tickers were being rejected at this check before signals could be evaluated.

**Fix:** scan path explicitly passes `'2y'` to `fetchDailyCandles(symbol, '2y')` so weekly resampling has ~50 bars (well above the 30 minimum). `checkPositions()` was already using `'2y'` for SMA200 needs — the scan path just never inherited that fix.

**Rule:** any path that calls `weeklyDirection()` must ensure the daily input series resamples to ≥30 weekly bars. Default `'6mo'` is unsafe. Use `'1y'` minimum, `'2y'` for safety + symmetry with checkPositions.

### Pitfall: Pine safety force-close must use TWO checks for legacy stuck positions

Closely related to the next pitfall. When you add a new safety force-close to a Pine strategy that depends on a NEW variable (e.g. `entryBarIdx`), positions that were ALREADY OPEN when the new code loaded have that variable as `na`. So the safety check `barsSinceEntry > N` evaluates false (because `barsSinceEntry = na`). The pre-existing stuck position stays stuck forever even though the safety net was added.

Confirmed on UNH 4H 2026-05-21: a position from ~2007 stayed "IN LONG runner Days since TP1: 12797/30" even after we deployed a 90-bar safety. Reason: `entryBarIdx` was `na` for that legacy position.

**Solution: TRIPLE-LAYER safety net** so no position can persist past the threshold:

```pine
// (a) Initialize entryBarIdx if it's na while we're in a position
if (inLong or inShort) and na(entryBarIdx)
    entryBarIdx := bar_index

// (b) Safety A — original check, now reliable because (a) initialized the var
if (inLong or inShort) and not na(barsSinceEntry) and barsSinceEntry > i_safetyMaxBars
    strategy.cancel("Stop L"); strategy.cancel("Stop S")
    strategy.cancel("BE L"); strategy.cancel("BE S")
    strategy.close_all(comment="Safety A: held N bars")
    tp2Hit := true

// (c) Safety C — independent check on barsSinceTp1 (tp1BarIdx exists for
//     legacy positions because it was in the code earlier than entryBarIdx).
if (inLong or inShort) and tp1Hit and not na(barsSinceTp1) and barsSinceTp1 > i_safetyMaxBars
    strategy.cancel("Stop L"); strategy.cancel("Stop S")
    strategy.cancel("BE L"); strategy.cancel("BE S")
    strategy.close_all(comment="Safety C: N bars since TP1")
    tp2Hit := true
```

After deploying this, the UNH 4H stuck position cleared and the info table went from "IN LONG (runner) Entry $13.34" to clean "IDLE".

### Pitfall: LIVE TP1 partial close fails every run — full-size GTC stop HOLDS the shares (v2.2.5, 2026-07-01)

**The live analogue of the OCO/held-shares trap below — but on the recurring
daily-poll TP1 close, not the one-shot entry.** Confirmed on PYPL (paper):
`sid-log.json` showed the same `tp1_close_fail` every run from 2026-06-26 to
2026-07-01:

```
{"kind":"tp1_close_fail","symbol":"PYPL",
 "error":"Alpaca DELETE /v2/positions/PYPL?qty=11 failed: insufficient qty
          available for order (requested: 11, available: 0)"}
```

PYPL was long 23sh @ $41.395 with `tp1_hit:false`, RSI(14) ≥ 50 the whole time
(so TP1 SHOULD have banked), and a resting GTC broker stop
(`brokerStopOrderId 9a155efb-…`) at $40 covering **all 23 shares**.

**Root cause.** The v2.2 broker design (`openEntry`) places a full-size GTC stop
at entry and leaves it resting. Alpaca "holds" every share against that stop, so
when `checkPositions` Branch A fired TP1 and called
`executor.closePartial(pos, 11, …)` → `DELETE /v2/positions/PYPL?qty=11`, Alpaca
reported `available: 0` and rejected it. The old catch just logged
`tp1_close_fail`, pushed the position back to `stillOpen`, and moved on — so the
failure repeated silently for **5 days**. TP1 profit never banked.

**Fix — cancel-first ordering (checkPositions Branch A long TP1):**
1. **CANCEL** the resting broker stop first (`executor.cancelOrderById(pos.brokerStopOrderId)`
   + a belt-and-braces `findOpenOrder(…, '-stop')` cancel) to RELEASE the shares,
   then `executor.waitForNoOpenOrders(symbol)` so Alpaca actually frees them
   before the close races the cancel.
2. Submit the partial close, then **`executor.pollOrderFill(closeOrderId)`** —
   CONFIRM it filled. Do not trust submit-success alone.
3. Only THEN re-place the break-even stop on the **runner only**
   (`executor.placeStop(pos, runnerShares, bePrice, 'stop')`), long BE = entry+1¢.
4. **Never leave the position naked:** if the partial is rejected OR the fill
   isn't confirmed, re-place a protective stop on the FULL remaining qty
   (`placeStop(pos, shares_remaining, pos.stopLoss, 'restop')`) and raise a LOUD
   `tg.alertTp1CloseFailed()` alarm. The 5-day silent failure is exactly what the
   alarm prevents recurring.

**PYPL traced numbers:** 23sh → TP1 `Math.floor(23×0.50)=11` sh, runner 12 sh, BE
= `round(41.395×100)=4140` → $41.40 → +1¢ long bias → **$41.41** on the 12-share
runner. Cancel target = stop `9a155efb-…` @ $40.

**Short-side twin (maintainV2_2BrokerOrders).** Shorts don't hit Branch A (they
`continue` — their TP1 is a resting GTC limit). But the SAME hold bug lived on the
PLACEMENT side: the function placed a full-size `-stop` FIRST (holding all shares),
then tried to place the `-tp1` limit — which threw `insufficient qty` and was only
`console.warn`ed, so the short TP1 limit never actually rested. Fix: while
`tp1_hit === false` on a SHORT, the resting stop reserves only the RUNNER half
(`shares_total − tp1Qty`), leaving the TP1 half free for the limit; and the TP1
limit is now an **OCO** (limit TP1 + stop SL) so both legs are protected. Once
`tp1_hit`, the stop reverts to the runner at BE (unchanged). Longs carry no
resting TP1 limit, so they keep a full-size stop until the cancel-first close
cancels it.

**New executor helpers (alpaca-executor.js):** `cancelOrderById` (treats 404/422
as already-gone → shares freed, doesn't throw), `waitForNoOpenOrders` (poll shares
released), `pollOrderFill` (confirm the market close filled), `placeStop` (re-place
BE / re-protect a stop on N shares). New sid-log kinds: `tp1_close_fail` now
carries `reprotected`; `be_stop_place_fail` when the runner BE stop can't place.

**Lesson:** a broker-side resting stop that covers the FULL position is
incompatible with a partial close by qty — the stop must be cancelled (or reduced
to the runner) BEFORE the partial, and any close must be fill-confirmed and
alarm-loud on failure. Also: any "position stays open, will retry next run" catch
that isn't ALSO loud is a silent-failure timebomb — make it alert.

### Pitfall: LIVE TP2 runner-close fails every run — BE stop HOLDS the runner shares (v2.2.6, 2026-07-17)

**Exact twin of the v2.2.5 TP1 held-shares bug above, but on the OTHER branch
(TP2 runner-close, `checkPositions` Branch B).** Confirmed on PYPL + ADBE (paper).
`sid-log.json` showed the same failure every run 2026-07-13→16:

```
{"kind":"tp2_close_fail","symbol":"PYPL",
 "error":"Alpaca DELETE /v2/positions/PYPL failed: insufficient qty available
          for order (requested: 12, available: 0)"}
{"kind":"tp2_close_fail","symbol":"ADBE",
 "error":"...ADBE... (requested: 2, available: 0)"}
```

Both are LONG post-TP1 runners: PYPL 12 sh @ entry $41.395, BE stop $41.41
(id 1ce719cd…); ADBE 2 sh @ entry $200.78, BE stop $200.79 (id a3f92ad8…). TP1
had banked cleanly (the v2.2.5 fix worked): PYPL banked $31.85 on 2026-06-26, ADBE
$39.36 on 2026-07-02.

**Root cause.** After TP1 banks, `maintainV2_2BrokerOrders` leaves a full-RUNNER
GTC break-even stop resting (`pos.brokerStopOrderId`, `client_order_id`
`<prefix>-stop-<timestamp>`). Alpaca "holds" the runner shares against it, so when
Branch B fired a TP2 and called `executor.closePosition(pos)` → `DELETE
/v2/positions/SYM` (FULL close), Alpaca reported `available: 0` and rejected it.
The old catch just logged `tp2_close_fail`, pushed the position to `stillOpen`,
and moved on — so it repeated silently. (Note: `closePosition`'s own cleanup loop
DID try to cancel resting stops, but it only matches `client_order_id.endsWith('-stop')`,
and `placeStop`/`maintain` append a `-<timestamp>` — so the id ends in digits, never
literal `-stop`, and the BE stop was never cancelled ahead of the close.)

**WHY was TP2 triggering?** It was a LEGITIMATE exit, not a false positive or a
stuck-flag. Both runners had rallied FAVOURABLY up through their SMA50 — that's the
"price touches 50-day SMA → close the runner" TP2 condition firing correctly. From
`scanner-sid.json` (2026-07-16): PYPL last close $56.73 vs SMA50 $44.51 & SMA200
$52.90 (crossed BOTH); ADBE last close $235.31 vs SMA50 $230.94 (crossed SMA50;
SMA200 $282.56 still above). The `crossedSMA` gap-cross clause caught the up-cross.
The runners had genuinely earned a TP2 and were stuck retrying only because the
CLOSE failed — the cancel-first fix resolves it (no false-trigger fix needed).
Note the SMA50/200 timeout at 30 trading days was NOT the trigger — only ~11-14
business days had elapsed since TP1. It was the SMA50 touch.

**Fix — cancel-first ordering (checkPositions Branch B TP2 close):**
1. **CANCEL** the resting BE broker stop first (`executor.cancelOrderById(pos.brokerStopOrderId)`
   + belt-and-braces `findOpenOrder(…, '-stop')` cancel) to RELEASE the runner
   shares, then `executor.waitForNoOpenOrders(symbol)`.
2. Submit the runner close (`executor.closePosition`) and **`executor.pollOrderFill`** —
   CONFIRM it filled before booking the trade.
3. TP2 fully closes the runner → **no re-stop on success**.
4. **Never leave the runner naked:** on a REJECTED or unconfirmed close, re-place a
   protective stop on `pos.shares_remaining` (`placeStop(pos, shares_remaining, pos.stopLoss, 'restop')`),
   do NOT record the close / do NOT set the closed record (retry next run), and
   raise a LOUD `tg.alertTp2CloseFailed()` alarm. `sid-log` `tp2_close_fail` now
   carries `reason` (the TP2 trigger) + `reprotected`.

**New telegram alert:** `alertTp2CloseFailed({symbol, side, runnerShares, reason,
error, reprotected, mode})` in `telegram-alerts.js` — twin of `alertTp1CloseFailed`.

**Lesson (reinforces the v2.2.5 one):** EVERY broker-managed close (partial OR full)
that runs while a resting stop covers those shares must cancel-first + fill-confirm +
alarm-loud. The TP1 fix left the identical trap on the TP2 branch because TP2 uses
`closePosition` (not `closePartial`) and nobody re-checked `closePosition`'s stop
cleanup matched the timestamped `client_order_id`. When you fix one broker-close
path, audit ALL of them (TP1, TP2, pre-TP1 stop-out, V2.0 fallback) for the same
held-shares assumption. (Pre-TP1 stop-out + V2.0 fallback are legacy/non-v2.2 paths
with no resting stop to release → left unchanged.)

**✅ PROVEN FIXED — first live run to use v2.2.6 closed both runners cleanly (2026-07-17).**
Alan manually dispatched `sid.yml` at 14:08 UTC (US market open) — the first run
since v2.2.6 (commit 108bc65f) landed. Commit `eb93f10c` ("SID run 2026-07-17
14:10 UTC") is decisive: it **ADDED both closed records (+88 lines)** and **REMOVED
both from `open-positions-sid.json` (−61 lines)**, and updated `sid-account.json` — so
this was a real close, not a stale-ledger cleanup. Booked as complete round-trips at
the **SMA50 TP2 target (the historical touch bar), NOT today's market price**:
- **PYPL** long — opened 2026-06-12, exit **$44.8828** (SMA50 touch 2026-07-02),
  **+$73.70** total (TP1+runner), 23 sh.
- **ADBE** long — opened 2026-06-26, exit **$231.3122** (SMA50 touch 2026-07-15),
  **+$100.42** total, 4 sh.

Open positions after the run: **0**. No `tp2_close_fail` recurred — the cancel-first
close filled on the first attempt. The runners had been genuinely stuck (~4 days PYPL /
~2 days ADBE) purely by the close-failure; v2.2.6 resolved it. **This is a go-live
gate cleared** — TP2 now demonstrably exits a runner on a real (paper) fill.
*Gotcha for future debugging:* `sid-log.json` only journals the entry-scan pass, NOT
the position-close events — verify closes via the `closed-positions` diff of the run's
commit (`git show <sha> -- SID/closed-positions-sid.json`), not the log.

### TELEGRAM YES/NO TRADE-APPROVAL FLOW (v2.3.0, 2026-07-17) — WORKING TREE, NOT DEPLOYED

Built to close the "untracked manual trade" gap left by v2.2.4. Before this: the
short-approval gate (bullish-asset short → not auto-fired) only sent a one-way
advisory alert, and "approve" meant Alan manually running `sid-manual-trade.yml`
→ an UNTRACKED off-strategy position (`manual-trades-log.json`, no TP1/TP2 bot
management). Now: the gate alert carries **[✅ Approve] [❌ Skip]** buttons, and
Approve enters the trade as a fully TRACKED bot position.

**Status as of this write-up: WORKING TREE ONLY — nothing committed, pushed,
deployed, or executed.** The Cloudflare Worker is NOT deployed and the Telegram
webhook is NOT registered, so the buttons won't function until Alan does the
setup in `SID/approval-worker/README.md`. Until then the alert still renders with
buttons but tapping them does nothing (no webhook receiver).

**End-to-end flow:**
```
bot-sid.js detects a bullish-asset short (approval gate, ~run() short block)
  → addPendingApproval(): appends to pending-approvals-sid.json
        { id:`${symbol}-${signalDate}-${side}`, symbol, side, proposedEntry,
          proposedStop, proposedShares, signalDate, rsiAtEntry, createdAt,
          status:'pending' }   (de-duped on id, pruned after SID_PENDING_TTL_DAYS=5)
  → tg.alertShortApprovalNeeded({ id, ... }) → sendMessage with inline_keyboard
        [✅ Approve] callback_data=`approve:<id>` / [❌ Skip] `skip:<id>`  (≤64 bytes)
        │
        ├─ Skip    → Worker edits msg to "Skipped", no dispatch
        └─ Approve → Cloudflare Worker (SID/approval-worker/worker.js)
                       → POST /repos/{owner}/{repo}/actions/workflows/
                          sid-approve-trade.yml/dispatches { ref:main,
                          inputs:{ approval_id:<id> } }
                       → answerCallbackQuery + editMessageText "Approved — firing…"
  → .github/workflows/sid-approve-trade.yml (workflow_dispatch, approval_id input)
       → node approve-trade.js
            reads pending-approvals-sid.json, finds id, ABORTS SAFELY if
            unknown/actioned/expired/market-closed → enters at CURRENT market
            fill price, recomputed stop, 1% sizing → places broker GTC stop →
            writes FULL tracked open-positions record via the SHARED
            buildEntryPositionRecord() factory → appends trades.csv → marks the
            pending record 'approved' → logs approval_entry → Telegram-confirms
       → commits state back (open/pending/trades/account/log) + pull --rebase push
```

**Security model (baked into the Worker + workflow):**
- **Webhook secret header:** Worker rejects (401) unless
  `X-Telegram-Bot-Api-Secret-Token === env.WEBHOOK_SECRET`. Set via Telegram
  `setWebhook … secret_token=<WEBHOOK_SECRET>`. Fails closed if the secret is unset.
- **Chat-id allowlist:** Worker only acts if `callback_query.from.id ===
  env.ALLOWED_CHAT_ID` (Alan). Anyone else → "Not authorised", no dispatch.
- **Least-privilege GitHub token:** fine-grained PAT, **Actions read+write on the
  ONE BotTrading repo only**. Lives only as a Worker secret (`wrangler secret
  put GITHUB_TOKEN`). Never in code, never committed.
- **No secrets in code/repo:** all via `wrangler secret put` (Cloudflare,
  encrypted) + GitHub repo secrets. `wrangler.toml` deliberately has NO `[vars]`.
- **Paper only:** the workflow runs under `SID_TRADING_MODE` (paper); live still
  needs `SID_LIVE_CONFIRMED`. dry_run/missing creds → executor falls back to
  dry_run and NO trade (record stays pending).
- **Safe abort:** `approve-trade.js` aborts (no Alpaca call, no half-written
  state) on unknown/actioned/expired id, preflight fail, market closed,
  <1-share sizing, or insufficient buying power. Never a blind trade.

**How approved trades become TRACKED (the schema-reuse approach):** the new
exported `buildEntryPositionRecord()` in bot-sid.js is the SINGLE source of truth
for the open-positions schema — used by BOTH `run()` (normal entry) and
`approve-trade.js`. The approved position also gets a broker GTC stop at entry, so
`isV2_2Position()` returns true (it checks `brokerStopOrderId` OR
`strategy.includes('v2.2')` — but `brokerStopOrderId` is enough) → the position
is managed by the v2.2 broker-order path (`maintainV2_2BrokerOrders` +
`checkPositions` Branch A/B) for TP1/TP2 exactly like an auto-fired one. Approved
records carry provenance extras (`manual_watch:true`, `approved_via:'telegram'`,
`approval_id`, `proposed_entry`, `proposed_stop`, `entry_delta`) that don't touch
the core schema. `strategy` tag = `SID v2.3.0` (contains `v2.3`, not `v2.2` — so
the `brokerStopOrderId` is what flips `isV2_2Position`; both were verified).

**Approve-days-later / price-moved handling:** Alan approves when price reaches
his level (e.g. UNH into 439-440), which can be days after the mechanical signal.
`approve-trade.js` enters at the CURRENT market FILL price (submits market order,
polls the fill, uses `filled_avg_price` as `entry`), recomputes the stop via
`computeStop(side, refPrice, proposedStop)` — REUSES the original proposed stop
LEVEL if still valid for the direction (short → stop above ref), else a 2% buffer
beyond the reference — and sizes by 1% risk on the CURRENT entry→stop distance
(reuses `calcPositionSize`, after setting `CONFIG.accountUsd` from the ledger like
`run()` does). Logs the proposed-vs-actual `entry_delta`; if >5% off, still enters
(Alan chose to approve) but flags it in the Telegram confirm.

**Files touched (v2.3.0):**
- `bot-sid.js` — `BOT_VERSION` v2.3.0 + history; new `PENDING_PATH` +
  `PENDING_TTL_DAYS`; pending-queue helpers (`pendingApprovalId`,
  `loadPendingApprovals`, `savePendingApprovals`, `prunePendingApprovals`,
  `addPendingApproval`); shared `buildEntryPositionRecord()` factory (also used to
  refactor the `run()` entry record — behaviour identical); approval-gate block
  now queues + passes `id` to the alert; expanded `export {}` block.
- `telegram-alerts.js` — `alertShortApprovalNeeded()` sends the inline keyboard
  (suppressed if no `id`); `sendMessage(text, {replyMarkup})` passthrough.
- `approve-trade.js` — NEW. The tracked-entry executor (above).
- `approval-worker/worker.js` + `wrangler.toml` + `package.json` + `README.md` —
  NEW. The Cloudflare Worker + guided setup.
- `.github/workflows/sid-approve-trade.yml` — NEW. workflow_dispatch(approval_id).
- `pending-approvals-sid.json` — NEW (seeded `[]`).
- Ship-check: `sid-dashboard.js` `STRATEGY_VERSION=2.3.0` + 3 hardcoded markers
  (paper banner / brand-sub / perf-note) + regenerated `docs/sid/index.html`;
  `strategy-updates.json` new INFRA entry at top (count auto → 21); `SID-README.md`
  current-version line + v2.3.0 history row + "Telegram approval flow" section +
  Files-table rows.

**Tested (local, no network trades):**
- `node --check` on all 4 JS files → pass.
- Import resolution: `approve-trade.js` imports all named exports from bot-sid.js
  successfully; ledger loads ($9761.26 at test time).
- Unknown-id run → safe abort, exit 0, no Alpaca call.
- Seeded a `pending` record, ran `approve-trade.js` in dry_run → found the
  record, stopped at dry_run with NO state change (record stayed `pending`).
  Restored the queue to `[]` afterwards.
- Dashboard regenerated from the WORKTREE ROOT (`node SID/sid-dashboard.js` from
  `.claude/worktrees/silly-robinson-abcf6c/`, NOT the repo root — the repo-root
  `SID/sid-dashboard.js` is the stale parent snapshot and errors MODULE_NOT_FOUND;
  the worktree root has `node_modules`). v2.3.0 markers + count (21) confirmed in
  `docs/sid/index.html`.

**Queued / not done (needs Alan):**
- Deploy the Worker + register the Telegram webhook per
  `SID/approval-worker/README.md` (create free Cloudflare account, `wrangler
  deploy`, `wrangler secret put` each secret, `setWebhook` with `secret_token`).
- Create the fine-grained GitHub token himself (Actions RW on BotTrading only) —
  never share the value.
- Nothing committed/pushed/deployed/executed this session (per the brief).
- The Pine visualiser legend still says amber = "manual-watch"; next Pine push
  could note amber = "approval-required, approve via Telegram." Not urgent.

### ONE-CLICK FOLLOWER UPDATER — "Update SID to latest" Action + manifest (2026-07-17) — WORKING TREE, NOT COMMITTED

Built to make updating a fork FOOLPROOF for non-technical followers (no clone, no git,
no downloads, no Claude). Primary method is now a single button in the follower's own
Actions tab; the Claude-based `SID-UPDATE-PROMPT.md` is demoted to the advanced/manual
fallback. **Status: WORKING TREE ONLY — nothing committed or pushed this session (per
the brief).**

**What changed (all additive):**
- `SID/.sid-update-manifest.txt` — NEW. The **single source of truth** for which files
  an update pulls (CODE only). Plain list, one repo-relative path per line, `#`
  comments + blanks allowed. Folder paths (`SID/pine`, `SID/approval-worker`) pull the
  whole folder. **Self-updating** — it lists ITSELF and `sid-update.yml`, so followers
  always run the newest updater + newest file list. Populated 1:1 from the CODE list in
  `SID-UPDATE-PROMPT.md`. Contains NO state file by construction.
- `.github/workflows/sid-update.yml` — NEW. `workflow_dispatch`-only, titled "Update
  SID to latest", `permissions: contents: write`. Flow: checkout@v4 (fetch-depth 0,
  default persist-credentials so the built-in `GITHUB_TOKEN` pushes) → git identity →
  add `upstream` if missing + `git fetch upstream` → `git pull --rebase --autostash
  origin main` (tolerate no-op) → loop the manifest and `git checkout upstream/main --
  <path>` each (skip missing-upstream individually, never fail the whole run) → **SAFETY
  GUARD** → detect-changed → read version+summary from top of `strategy-updates.json`
  (embedded Node, best-effort with fallback) → if unchanged: friendly "already up to
  date" summary, exit 0 → else commit `chore: update SID to <version> (one-click
  updater)` + push (on non-ff: `pull --rebase --autostash` then keep OURS on any
  state-file conflict, retry push) → success summary in bold "positions/balance/
  trades/secrets NOT touched — only code + release notes" + "dashboard shows new
  version on next rebuild".
- **SAFETY GUARD mechanism (the guarantee):** after the manifest checkout, the workflow
  reads `git diff --cached --name-only` and greps it (`grep -Fxq`, exact whole-line
  match) against a hardcoded denylist: `open-positions-sid.json`,
  `closed-positions-sid.json`, `sid-account.json`, `sid-log.json`, `trades-sid.csv`,
  `pending-approvals-sid.json`, `scanner-sid.json`, `docs/sid/index.html`. If ANY
  appears, it writes an "ABORTED" step summary, `git reset --hard HEAD`, and `exit 1`
  BEFORE any commit/push. The manifest can't contain these, so the guard is
  belt-and-braces — it **fails closed** regardless of the manifest. Denylist covers
  every SID state file (the same STATE list in `SID-UPDATE-PROMPT.md` minus `.env`,
  which is git-ignored and never staged anyway).
- `SID/HOW-TO-UPDATE.md` — NEW. Jargon-free, five numbered clicks (Actions tab → "Update
  SID to latest" → Run workflow → green Run workflow → wait ~1 min, refresh, green
  tick). Reassures (bold) trades/account are never touched, explains how they know an
  update exists (dashboard Updates tab), then a short "Advanced / if you use Claude"
  section → `SID-UPDATE-PROMPT.md`, and a one-line "prefer a local double-click? ask"
  note (the local script was deliberately NOT built — the button covers everyone).
- Wiring: `SID-DEPLOY-PROMPT.md` Step 6 keep-enabled list now includes `sid-update.yml`
  + a closing "To update later, run the 'Update SID to latest' Action" line + Step 13
  update bullet leads with the button. `SID-UPDATE-PROMPT.md` got a top pointer to the
  one-click method + the manifest is now declared the source of truth (with a
  read-the-manifest loop example) + both file lists and the explicit `git checkout`
  command gained `.sid-update-manifest.txt`, `HOW-TO-UPDATE.md`, `sid-update.yml`.
  `SID-README.md` Files table gained rows for `HOW-TO-UPDATE.md` (primary),
  `.sid-update-manifest.txt`, `.github/workflows/sid-update.yml`, and re-labelled
  `SID-UPDATE-PROMPT.md` as advanced/manual.
- Ship-check (infra, NOT a strategy revision): `strategy-updates.json` got ONE new
  INFRA entry at the top (count auto 21 → 22); regenerated `docs/sid/index.html` from
  the WORKTREE ROOT (`node SID/sid-dashboard.js` — the worktree root has `node_modules`,
  the repo-root snapshot does not). **BOT_VERSION / STRATEGY_VERSION deliberately
  UNCHANGED at v2.3.0** — this is tooling, not a rule change.

**Tested (local, no network):** manifest parse loop resolves all 30 paths locally with
correct comment/whitespace stripping and lists ZERO denylisted state files; both
embedded Node extractors return sane output ("V2.3.0 TELEGRAM YES/NO TRADE-APPROVAL
FLOW" / first-sentence summary); `sid-update.yml` passes `yaml.safe_load` (UTF-8 — the
cp1252 Python-print trap bit the first validation attempt, use `io.open(...,
encoding='utf-8')`); `strategy-updates.json` valid (22 entries); dashboard rebuilt,
version markers still v2.3.0, Updates tab + panel-title count both read (22), one-click
entry present.

**Queued / not done:** nothing committed/pushed (per brief — return for review). If Alan
approves, push via the standard protocol (fetch → pull --rebase --autostash → push;
never without approval). The one-click workflow only becomes runnable on a fork once
that commit is on the fork's main. Optional future: the local double-click updater
script (intentionally deferred).

### maxOpenPositions raised 3 → 5 (v2.2.6, 2026-07-17)

`CONFIG.maxOpenPositions` default was **3** ("never hold more than 3"). Alan wanted
at least 5. Changed default **3 → 5** (still env-overridable via `SID_MAX_POSITIONS`).
Capital math: 5 × `maxPositionPct` 10% = **~50% of the account max deployed** if all
5 hit the per-position 10% cap. There is NO cap on total deployed beyond the
per-position 10%. In practice 1%-risk-driven sizing usually lands well under the 10%
cap, so real simultaneous deployment is typically lower than 50%. Fine at 5.

### BITF removed from the universe — delisted (v2.2.6, 2026-07-17)

BITF returned Alpaca `HTTP 404` every run (delisted/renamed) and was silently
skipped. Removed from BOTH `watchlist-sid.json` (master `tickers` array AND
`sections/v2_human_approval_33`) and `asset-classification.json` (its MONITOR-tier
record + the `summary` counts). Effect on counts: universe **113 → 112**, HUMAN
tier **33 → 32**. **AUTO-80 tier UNCHANGED** — BITF was HUMAN/log-only (never in
`AUTO_APPROVED_TICKERS`, never auto-fired), so the locked 80-ticker AUTO universe
is untouched. NOTE: the JSON key name `v2_human_approval_33` is LEFT AS-IS (now
holds 32) — renaming it would break the Python backtests that read it by that
literal key (`backtest-sid-*.py`, `build-v2.1-excel-report.py`). The `-33` in the
key name is now a cosmetic misnomer, documented here so nobody "fixes" it and
breaks the backtests. Did NOT add a replacement ticker (separate strategy decision).

### PDT-SAFE EXECUTION MODE (v2.4.0, 2026-07-17) — WORKING TREE, NOT COMMITTED

Added an OPT-IN, PDT-immune execution mode alongside the existing standard "PDT
version." **Status: WORKING TREE ONLY — nothing committed, pushed, or executed
this session (per the brief). Return for review.**

**Why.** The standard bot places broker GTC stops + a resting intraday short-TP1
limit from entry (`maintainV2_2BrokerOrders`, called from `checkPositions` when
`isV2_2Position(pos)` is true). Those broker orders CAN fill the SAME day as entry
→ a day trade → Pattern Day Trader (PDT) exposure. A margin account under $25,000
making 4+ day trades in 5 business days gets flagged + restricted by FINRA/Alpaca.
SID shorts require margin, so sub-$25K followers are PDT-subject (a cash account
can't run SID at all). v2.0's original design (no broker orders; daily-poll exits
always land on a LATER day) was PDT-immune — restored here as opt-in.

**The mode.** `CONFIG.pdtSafe = process.env.SID_PDT_SAFE === 'true'` — **DEFAULT
FALSE = the standard PDT version** (broker stops); the sub-$25K user opts IN.

**How pdtSafe skips the broker orders + how positions stay managed:**
- ENTRY (bot path, `run()`): when `pdtSafe`, calls the new
  `executor.openEntryNoStop({signal,sizing,symbol})` (market entry ONLY, no GTC
  stop) instead of `openEntry()`. Returns `stopOrderId:null` +
  `clientOrderIdPrefix:null`. The position record adds `pdt_safe:true` (extra).
- ENTRY (approval path, `approve-trade.js`): when `pdtSafe`, skips its `placeStop()`
  call, leaves `brokerStopOrderId=null`, sets `clientOrderIdPrefix:null`, adds
  `pdt_safe:true`.
- MANAGEMENT: `isV2_2Position(pos)` now returns **false unconditionally** when
  `pos.pdt_safe === true` (guard added at the TOP of the fn — a hard guarantee
  even if some future code stamped a brokerStopOrderId). With `posIsV2_2=false`:
  `maintainV2_2BrokerOrders` is SKIPPED (line ~1766 `if (posIsV2_2 && executor)`);
  a pdt_safe SHORT does NOT `continue` past Branch A (line ~1799
  `if (posIsV2_2 && pos.side==='short') continue;`) so it runs the close-based
  daily-poll TP1 (RSI≤50 for shorts) + the daily-poll stop-sim (`skipStopSim =
  posIsV2_2` = false); and the Branch B daily-poll BE-stop checks are active
  (`if (!posIsV2_2 && ...)`). The daily-poll cancel-first close guards
  `if (pos.brokerStopOrderId)` (null→skip) and `findOpenOrder(...,'-stop')`
  (nothing→no-op), so no cancel is needed — every exit is a plain market close at
  the next run.

**SAME-DAY-EXIT GUARANTEE (traced, confirmed).** In pdtSafe mode there is NO code
path that can close a position on the calendar day it opened:
1. In `run()`, `checkPositions(executor)` runs (line ~2490) BEFORE the entry loop
   (`for (const symbol of WATCHLIST)`, ~2537). So on the entry day the new
   position isn't in `open-positions-sid.json` yet → not scanned at all.
2. On the NEXT run, `checkPositions` scans it, but `newBars = candles.filter(c =>
   c.date > openDate)` and the exit loop `if (c.date <= scanFromDate) continue;`
   (scanFromDate=openDate pre-TP1) STRICTLY exclude the entry-day bar. Earliest
   triggerable bar is the day after entry, exited at that run's open.
3. `syncPositions` (runs before checkPositions) only reacts to closes Alpaca
   already made; with NO broker orders it can never detect a same-day fill and
   never initiates a close. → Earliest possible exit is always a later calendar
   day. PDT-immune.

**Honest trade-offs (surfaced in README + installer + dashboard, as required):**
no intraday stop → a hard mid-day move isn't cut until the next run's open
(gap/slippage; expect a modest few-% profit reduction vs the PDT version); a
missed scheduled run leaves a position unmanaged longer (no broker safety net).
Inherent to PDT-immunity.

**Standard mode is byte-for-byte unchanged.** The entry ternary resolves to
`openEntry()`, the `pdt_safe` extra is `{}` (spreads to nothing), and the
`isV2_2Position` guard only fires on `pdt_safe===true` (never set in standard).

**Installer (SID-DEPLOY-PROMPT.md Step 8a).** Now ASKS "How much do you plan to
fund your trading account with?" and branches: **$25,000+** (≈£19,000, FX
approximate) → recommend the **PDT version** (best fills; account MUST stay
$25,000+ at all times or risk a day-trade lockout), set `SID_PDT_SAFE=false` (or
leave unset). **Under $25,000** → recommend **PDT-safe mode**, set
`SID_PDT_SAFE=true`. Includes a plain PDT-rule explanation, the cash-account-can't-
run-SID fact, and a "not financial advice — you're responsible for your account
type + Alpaca's rules" caveat. `SID_PDT_SAFE` added to the installer's secrets
list.

**Env plumbing.** `SID_PDT_SAFE` added to BOTH `.github/workflows/sid.yml` and
`.github/workflows/sid-approve-trade.yml` (must match between them). Was missing
from both before.

**Files changed (all working tree):** `bot-sid.js` (CONFIG.pdtSafe + BOT_VERSION
v2.4.0 + history + isV2_2Position guard + entry-path ternary + pdt_safe extra),
`alpaca-executor.js` (new `openEntryNoStop`), `approve-trade.js` (pdtSafe skips
placeStop, v2.4.0 tags), `sid.yml` + `sid-approve-trade.yml` (SID_PDT_SAFE env),
`SID-DEPLOY-PROMPT.md` (Step 8a funding question + branching + secrets list + the
"How it works" stops caveat). Ship-check: `sid-dashboard.js` STRATEGY_VERSION 2.4.0
+ 3 hardcoded markers; `strategy-updates.json` new RELEASE entry at top (count auto
22→23); regenerated `docs/sid/index.html` from the WORKTREE ROOT (`node
SID/sid-dashboard.js` — worktree root has node_modules; the repo-root snapshot
errors MODULE_NOT_FOUND) — v2.4.0 markers + count (23) confirmed; `SID-README.md`
current-version line + v2.4.0 history row + a new "PDT version vs PDT-safe mode"
section (comparison table + which-to-choose + not-financial-advice). No new file
added → `.sid-update-manifest.txt` needs no change (all touched files already
listed).

**Tested (local, no network trades):** `node --check` on bot-sid/alpaca-executor/
approve-trade → pass. `CONFIG.pdtSafe` = true under `SID_PDT_SAFE=true`, false when
unset. `buildEntryPositionRecord(..., {pdt_safe:true})` stamps `pdt_safe:true` +
`brokerStopOrderId:null`. `executor.openEntryNoStop` present on the prototype.
`approve-trade.js` imports resolve + aborts safely without APPROVAL_ID. Both
workflow YAMLs `yaml.safe_load` clean with SID_PDT_SAFE present. Dashboard rebuilt,
markers v2.4.0, Updates tab + panel-title count both (23), PDT-safe RELEASE entry
present. Routing traced against the live checkPositions lines (1766/1799/1800/
2117/2126) — pdt_safe position skips maintainV2_2BrokerOrders and runs the
daily-poll close path.

**Queued / not done:** nothing committed/pushed/executed (per brief — return for
review). If Alan approves, push via the standard protocol (fetch → pull --rebase
--autostash → push; never without approval). No Pine change needed (visualiser is
signal-level, not execution-level). A pre-existing stray
`strategy-updates.json.tmp.37284.*` (Jun 14, not mine) is still untracked — left
alone.

### OFFLINE / LOCAL TAX-REPORT TOOL (2026-07-17) — WORKING TREE, NOT COMMITTED

Built a follower-facing tool that turns `closed-positions-sid.json` into an
interactive tax Excel **on the follower's OWN machine** — the sensitive tax
document is generated locally and NEVER committed to the public repo (no private
repo, no cloud artifact). **Status: WORKING TREE ONLY — nothing committed,
pushed, or executed this session (per the brief). Return for review.** This is an
OFFLINE tool, **NOT a strategy change** — `BOT_VERSION`/`STRATEGY_VERSION` stay
`v2.4.0`.

**What was built (all additive):**
- `SID/tax-report.py` — reads `closed-positions-sid.json` (defensive about the
  varied schema — long/short, `exit_price`/`exitPrice`, `total_pnl`/`realizedPnl`,
  `shares_total`/`exit_shares`/`shares`, `openDate`/`signalDate` etc.; skips
  malformed records with a `[SKIP]` warning rather than crashing) and writes ONE
  row per closed trade to `SID/tax-reports/sid-tax-report-YYYY-MM-DD.xlsx` (dir
  auto-created; date from the system clock — fine, runs on the user's machine).
  Columns: `Symbol | Side | Opened | Closed | Quantity | Proceeds (USD) |
  Cost (USD) | Realised P&L (USD) | Month | UK Tax Year`. **Realised P&L uses the
  stored `total_pnl`/`realizedPnl` as authoritative**; Proceeds/Cost are reference
  (long: cost=entry*qty, proceeds=exit*qty; short: proceeds=entry*qty,
  cost=exit*qty). **UK Tax Year** from the CLOSE date, 6 Apr–5 Apr:
  `(month,day) >= (4,6) → start=year else year-1`, label `f"{start}/{(start+1)%100:02d}"`
  (verified against all four spec boundary cases + year-2000 rollover → `1999/00`).
  **AutoFilter** on the header row; a bold **filter-aware TOTAL row** using
  **`SUBTOTAL(109,...)`** (109 = SUM ignoring BOTH filtered-out AND manually-hidden
  rows) on Proceeds/Cost/Realised-P&L, labelled "REALISED P&L (visible rows)".
  Frozen+bold header, currency/date number formats, notice banner row.
  Zero-trades → headers + a `0` total, no crash. Windows-safe prints (`[OK]`/
  `[DONE]`/`[SKIP]`, no unicode — cp1252 trap).
- `SID/GENERATE-TAX-REPORT.bat` (Windows) + `SID/generate-tax-report.command`
  (Mac) — double-click launchers: cd to repo root (`%~dp0\..` / `$(dirname
  "$0")/..`), detect Python (`python`→`py -3`→`python3`), `git pull origin main`
  (tolerate failure with a friendly "generating from what's on disk"),
  `pip install openpyxl`, run the script, open the newest xlsx (`start`/`open`),
  pause. The `.command` is staged mode `100755` (executable) and pinned to LF via a
  new `SID/.gitattributes` (`generate-tax-report.command text eol=lf`) — the repo
  has `core.autocrlf=true`, which would otherwise CRLF-corrupt the bash script for
  Mac users. `HOW-TO-TAX-REPORT.md` notes Mac's first-run right-click→Open.
- `SID/HOW-TO-TAX-REPORT.md` — non-technical guide (double-click, filter the UK
  Tax Year/Month column, read the total row; UK Apr–Apr year explained; record not
  advice; USD→GBP by the accountant; stays private on the machine).
- Wiring: `.sid-update-manifest.txt` gained the 4 TOOL files (`tax-report.py`,
  `.bat`, `.command`, `HOW-TO-TAX-REPORT.md`) but NOT the `tax-reports/` output;
  `SID-README.md` Files table gained rows; `strategy-updates.json` got ONE new
  INFRA entry at the top (count 23→24) and `docs/sid/index.html` was regenerated
  from the WORKTREE ROOT (`node SID/sid-dashboard.js` — worktree root has
  node_modules; the repo-root snapshot errors MODULE_NOT_FOUND); `requirements.txt`
  gained `openpyxl>=3,<4`.

**Privacy guarantee — `SID/tax-reports/` is git-ignored.** Added `/SID/tax-reports/`
to the ROOT `.gitignore`, scoped so it does NOT touch the tracked backtest `.xlsx`
under `SID/` and `SID/strategy-test-vault/`. Verified with `git check-ignore`:
generated reports ARE ignored; the 3 backtest `.xlsx` are NOT ignored and stay in
the index. The one-click follower updater's denylist doesn't need the output file
(the manifest can't list it), but note the tool files ARE pulled by an update.

**Tested (local, no network, no commit):** ran against the live 5-trade
`closed-positions-sid.json` → correct columns, correct short/long Proceeds/Cost,
correct Month + UK Tax Year per row; `SUBTOTAL(109,F4:F8/G/H)` formulas verified
in the saved xlsx (caught + fixed an early bug where the range end anchor omitted
the column letter → `F4:8`; now `F4:F8`). Zero-trades and malformed-record paths
exercised (skip-with-warning, empty total, no crash). Dashboard rebuilt: markers
still v2.4.0, Updates count 24, tax entry present. All test-generated
`tax-reports/` artifacts deleted afterward.

**Queued / not done:** nothing committed/pushed/executed (per brief — return for
review). If Alan approves, push via the standard protocol (fetch → pull --rebase
--autostash → push; never without approval).

### Pitfall: Alpaca rejects SL stop for full position when TP1 limit already holds partial

Confirmed 2026-05-22 on the MCD oneshot trade (entry filled 8 shares @ $281.67). Original `manual-trade.js` pattern was:
1. Submit market entry for 8 shares → filled
2. Submit limit SELL for 4 shares @ $310.75 (TP1) → accepted
3. Submit stop SELL for 8 shares @ $272 (SL) → **REJECTED** with `AlpacaError: insufficient qty available for order (requested: 8, available: 4)`

**Root cause:** Alpaca "holds" shares against open orders. The TP1 limit holds 4 of the 8 shares, so only 4 are "available" when the SL is submitted. Alpaca refuses to let the SL claim shares that another open order already claims.

**The deadly consequence:** the script crashed AFTER entry filled but BEFORE the log was written. Position was on Alpaca with TP1 but no SL — completely unprotected on the downside. If MCD had gapped down, full loss with no recourse.

**Fix — OCO pattern + standalone runner stop:**

For a position of N shares split 50/50 (TP1 half + runner half):
1. Submit market entry for N shares → poll for fill
2. Submit an OCO order for N/2 shares — the TP1 limit AND the SL stop are bundled together:
   ```js
   client.submitOrder({
     symbol, qty: N/2, side: exitSide,
     type: 'limit', limit_price: tp1Price,
     time_in_force: 'gtc',
     order_class: 'oco',
     take_profit: { limit_price: tp1Price },
     stop_loss:   { stop_price:  slPrice  },
   });
   ```
3. Submit a standalone stop for the other N/2 shares at the SL price:
   ```js
   client.submitOrder({
     symbol, qty: N/2, side: exitSide,
     type: 'stop', stop_price: slPrice,
     time_in_force: 'gtc',
   });
   ```

**Why it works:**
- OCO bundles TP1+SL for the SAME N/2 shares. Only one fires (the other auto-cancels). No double-holding.
- Standalone runner stop covers the other N/2 shares for the SL case. No conflict because no other order claims those shares.

**Behaviour matrix:**
| Event | OCO leg fires | OCO sibling | Runner stop | Result |
|---|---|---|---|---|
| Price rises to TP1 | TP1 limit (closes N/2) | Auto-cancels its SL | Still pending | N/2 closed at profit; runner protected |
| Price falls to SL first | OCO SL stop (closes N/2) | Auto-cancels its limit | Fires too (closes N/2) | Full N shares closed at loss |
| TP1 hits then price drops to SL | TP1 limit closed N/2 | Cancelled | Fires for the N/2 runner | Mixed: half profit, half loss |

**Safety fallback for any future failure:** if OCO submit fails for any reason (e.g. Alpaca outage, invalid params, even a transient 5xx), `manual-trade.js` now attempts a `trySafetyStop()` — a single full-position stop at SL — so the position is never left totally unprotected. Logs alarm to Telegram if even that fails.

Detailed runbook + working code in `SID/manual-trade.js` (the FIXED version, 2026-05-22 commit). Recovery script for the broken trade is `SID/manual-trade-recovery-mcd.js` (one-off, can be deleted after MCD position closes).

### Pitfall: Pine `tp2*Be` branches must EXPLICITLY close — don't trust the BE stop order

Sister-bug to the next one. Confirmed 2026-05-22 on MCD daily — the original v2.1 code wrote the BE observation branches as:

```pine
if tp2LongBe
    // BE L stop closes the position automatically; just mark tp2Hit
    tp2Hit := true
```

Theory was: `strategy.exit("BE L", from_entry="Long", stop=entryPrice)` (set at TP1) automatically closes when price touches BE. So the tp2*Be branch just marks the flag and trusts the BE stop to fire.

**Reality:** the BE stop doesn't reliably fire after a partial close. Pine v6 quirk — when the entry's been split (TP1 closed 50%), the remaining `strategy.exit` order tied to it can ghost. Position stays IN-RUNNER even though price has clearly crossed BE.

**The deadlock that makes it irrecoverable:** `tp2Hit := true` blocks ALL other TP2 conditions (SMA50/SMA200/Timeout are gated by `not tp2Hit`). So:
1. BE stop doesn't fire (the bug)
2. `tp2Hit = true` (just got set)
3. SMA50/200/Timeout exits all blocked by `not tp2Hit`
4. Position stays "IN SHORT (runner)" / "IN LONG (runner)" forever, Days since TP1 climbing past the 30-bar timeout
5. Strategy slot occupied → no new entries can fire ever again

Symptom on MCD 1D 2026-05-22: position entered at $326.46 (short), TP1 hit 8 bars ago, BE stop set at $326.46. Price subsequently rose to ~$341 (clearly through $326.46), but position still showed "IN SHORT (runner)" with no close.

**Fix:** mirror the SMA50/200/Timeout pattern — explicit cancel + close, never trust the BE stop alone:

```pine
if tp2LongBe
    strategy.cancel("BE L")
    strategy.close("Long", comment="TP2 BE")
    tp2Hit := true

if tp2ShortBe
    strategy.cancel("BE S")
    strategy.close("Short", comment="TP2 BE")
    tp2Hit := true
```

**Rule for new Pine strategies:** if you set a `strategy.exit()` stop AND have other TP conditions that should also close the same entry, EVERY closure branch must explicitly cancel that exit and call `strategy.close()` itself. Never rely on the exit stop to fire silently — it can ghost after partial closes.

### Pitfall: Pine `strategy.close()` blocked by pending `strategy.exit()` on same entry

Confirmed 2026-05-21 on UNH and GOOG charts. Symptom: strategy entered LONG decades ago, hit TP1, position should have closed via TP2 (timeout / SMA50 / SMA200) but DID NOT. Position stays "IN runner" indefinitely. Info table shows e.g. "Entry $0.55, Days since TP1: 2619/30" — meaning 2619 bars past the 30-bar timeout threshold. This locks the strategy slot, preventing all new entries (`strategy.position_size == 0` check fails forever after), so no signal lines fire on subsequent bars.

**Root cause:** After TP1 fires, we set up a break-even stop:
```pine
strategy.exit("BE L", from_entry="Long", stop=entryPrice)
```
The "BE L" exit hangs as a pending order on the "Long" entry. When TP2 timeout/SMA fires and we call:
```pine
strategy.close("Long", comment="TP2 Timeout")
```
Pine v6 doesn't actually close the position — the pending "BE L" exit blocks it. `tp2Hit` flips to `true` but `strategy.position_size` stays > 0. Stuck forever.

**Fix:** every TP2 branch that calls `strategy.close()` must first `strategy.cancel()` the BE exit:
```pine
else if tp2LongTimeout
    strategy.cancel("BE L")             // ← essential
    strategy.close("Long", comment="TP2 Timeout")
    tp2Hit := true
```

Plus a **safety force-close** for any other stuck-state edge case:
```pine
if (inLong or inShort) and barsSinceEntry > i_safetyMaxBars  // default 90
    strategy.cancel("Stop L"); strategy.cancel("Stop S")
    strategy.cancel("BE L");   strategy.cancel("BE S")
    strategy.close_all(comment="Safety: held N bars")
    tp2Hit := true
```

Confirmed working in commit Pine v2.1.5 — GOOG now correctly shows a fresh "SHORT ENTRY $397.17 STOP $400" line on the most recent bar instead of being locked by a 2014 stuck runner.

### Pitfall: TP2 conditions re-fire every bar after threshold is met

Same class of bug as the arm one. If `tp2LongTimeout = inLong and tp1Hit and barsSinceTp1 >= i_tp2TimeoutBars`, then after the threshold is met the condition stays true on subsequent bars (unless the position actually closed). Each bar draws another label, stacking "TP2 Timeout 30 / 31 / 32 / …" across the chart.

**Fix:** gate every TP2 condition by `not tp2Hit` so each fires exactly once per trade:
```pine
tp2LongTimeout = inLong and tp1Hit and not tp2Hit and ... and barsSinceTp1 >= i_tp2TimeoutBars
```

Also explicitly reset `tp1BarIdx := na`, `tp1Price := na`, `tp2Hit := false` inside the new-entry block so stale state from previous trades cannot carry over.

### Pitfall: `bgcolor()` paints every matching bar across all history

If the strategy fired 50 trades over 5 years, `bgcolor(triggerLong ? ... : na)` will paint 50 entry bands across the chart. Looks like a Christmas tree on long histories.

**Solution:** add an `inVisualWindow = bar_index > last_bar_index - i_visualLookback` gate (default 60 bars ≈ 3 months). Apply to all `bgcolor()` and conditional `label.new()` calls. Strategy logic still runs over all history (backtest stays accurate) — only the visuals are limited to recent bars. Used in `sid-strategy-v2.1.pine` lines 64-65.

### Pitfall: stop-order replacement after partial close

When you do `strategy.close("Long", qty_percent=50)` for TP1 then want to move stop to break-even, **cancel the original stop first** before placing the new one with a different id:

```pine
strategy.close("Long", qty_percent=50, comment="TP1")
strategy.cancel("Stop L")                                    // cancel original 100% stop
strategy.exit("BE L", from_entry="Long", stop=entryPrice)    // new BE stop on remaining 50%
```

Without `strategy.cancel`, the original stop persists and may double-fire. See `sid-strategy-v2.1.pine` `tp1FireLong` / `tp1FireShort` blocks.

### ACCOUNTING RECONCILE — Alpaca is the source of truth (v2.4.1, 2026-07-18) — WORKING TREE, NOT COMMITTED

Full epic that made the SID paper books tie to the real Alpaca paper account, then
made the bot book real fills so drift can't recur. **Status: WORKING TREE ONLY —
Part 1 (the read-only tool + cloud --write) was pushed by the coordinator; the
bot/dashboard change (Part B/A below) is uncommitted, return for review.**

**The three numbers that didn't reconcile (all on `origin/main`):**
- Alpaca paper equity (SOURCE OF TRUTH): **+$182.18** ($100,182.18 on a $100K base).
- Our closed records summed: **−$57.69** (7 records).
- Our ledger `sid-account.json` `realizedPnl`: **−$135.83** / tradeCount 11.

**Root cause — TWO layers, both confirmed with git evidence:**
1. **Phantom loss in the ledger.** `updateAccount` was a running `realizedPnl += pnl`
   counter. The MCD paper stop-out (−$78.14) was added at commit `76a98edd` then the
   record was **deleted at `a40456fc`** (the 2026-06-24 GLD run rewrote the file from
   in-memory state that had lost MCD) — but the −$78.14 was never removed from the
   counter. Arithmetic ties exactly: records (−$57.69) + MCD phantom (−$78.14) =
   −$135.83. tradeCount 11 vs 7 records because it counted ledger EVENTS (TP1 partials,
   TP2 closes, the deleted MCD), not distinct positions.
2. **Simulated exit prices, not real fills.** TP1 booked `c.close` (RSI-50 bar), TP2
   booked `tp2ExitPrice` (the historical SMA-touch bar). Alpaca actually fills at the
   run-day market price. On late runner closes this diverges hugely — PYPL/ADBE runners
   were booked at the SMA50 touch weeks before they really sold (2026-07-17). This is
   the −$57.69-records-vs-+$182.18-Alpaca gap.

**Part 1 — `reconcile-account.js` (read-only tool, PUSHED by coordinator).**
- Pulls Alpaca FILL activities (`getActivities`, added to `alpaca-client.js` +
  `getPortfolioHistory`) + account equity. **FIFO-allocates fills across same-symbol
  positions in open-date order** (disambiguates the 3 UNH shorts) and searches exits
  **through now** (not the record's closeDate — that's why PYPL/ADBE runner exits on
  07-17 were initially missed; the closeDate window truncated them). Matches a position
  only when BOTH legs cover `shares_total`; else keeps the estimate + `pnl_source:"estimate"`.
- **Orphan reconstruction:** any symbol with a complete unallocated leftover round-trip
  is rebuilt from real fills (this recovered MCD −$78.14, `pnl_source:"alpaca_fill"`).
  Manual fallback re-adds the known MCD −$78.14 (`reconstructed_manual`) if its fills
  aren't in Alpaca's window — never fabricates.
- **PAPER/LIVE SEGREGATION guard:** only reconciles records matching the Alpaca account's
  mode; other-mode records are QUARANTINED (passed through byte-for-byte, never re-priced
  or summed). MCD fallback is paper-only.
- `--dry-run` default (writes nothing), `--write` persists corrected records + re-derived
  `sid-account.json` + writes `alpaca-account-sid.json` snapshot. `--write` REFUSES
  without a live Alpaca connection (exit 1). Runs via `.github/workflows/sid-reconcile.yml`
  (`workflow_dispatch`, `mode: dry-run|write`; write-mode commit is `if: inputs.mode=='write'`
  and stages ONLY the 3 state files, mirrors `sid.yml`).
- **RESULT (cloud --write, commit `661b2836`):** 8 records all `alpaca_fill` incl. MCD,
  corrected total **+$182.37**, Alpaca **+$182.18**, residual **−$0.19** (fees). Ledger
  → realizedPnl +$182.37 / tradeCount 8 / accountUsd $10,182.37. Snapshot netPnl +$182.18.

**Part B — bot per-close reconcile (`bot-sid.js`, v2.4.1, UNCOMMITTED).** So drift can't recur:
- **Book the real fill, not the bar.** TP1 (Branch A) and TP2 (Branch B) now overwrite
  `exitPrice`/`tp2ExitPrice` with `fill.filledAvgPrice` (from the `pollOrderFill` already
  in scope, AFTER the fill confirms) and recompute P&L via the new `realisedPnlFor(side,
  entry,exit,shares)`. `recordExternalClose` already read real fills; now stamps
  `pnl_source` (`alpaca_fill` when fills found, `estimate` on the stopLoss fallback).
  Every closed record gets `pnl_source` + `mode`. Falls back to the estimate only when
  the real fill is unavailable — never silently wrong. Combined TP1+TP2 record is
  `alpaca_fill` only if BOTH legs were real fills.
- **Ledger re-derived, never a counter.** `updateAccount(_deltaHintIgnored, sources={})`
  now IGNORES the delta and calls `deriveLedger(mode, sources)`: realizedPnl = Σ closed
  records of the account's mode + Σ in-flight TP1 partials of that mode (open runners
  whose TP1 banked but whose record doesn't exist yet); tradeCount = distinct closed
  records of that mode; accountUsd = startingUsd + realizedPnl. `sources` lets the caller
  pass the in-memory arrays because `checkPositions` books P&L in-loop but persists the
  files only at the end (each close-branch now pushes the record FIRST, then re-derives,
  then sets `accountAfter`). **Phantom-proof** — a deleted/edited record can never leave
  a residual. New exports: `deriveLedger`, `realisedPnlFor`, `recordMode`, `loadClosedPositions`.
- **DID NOT TOUCH** the RSI-50 TP1 trigger, TP2 SMA50/200/BE/timeout triggers, share math,
  the cancel-first stop logic (cancel → close → pollOrderFill → re-protect — byte-identical,
  verified by diff: zero close-mechanics lines removed), or entry/arm/scan. Only the exit
  PRICE source + ledger DERIVATION changed.
- **⚠ ORDERING GOTCHA (earned here):** in `checkPositions` the closed record must be pushed
  to `closedPositions` BEFORE `updateAccount`, and `updateAccount` must be passed the
  in-memory `{ closed, open }` (the on-disk files aren't saved until the end of the fn).
  For TP1 (position stays open) pass `open: [...stillOpen, pos]`; for TP2 (fully closes)
  pass `open: stillOpen.filter(p=>p!==pos)`; in `recordExternalClose` (saves closed file
  first) pass `open: loadOpenPositions().filter(p=>p.id!==pos.id)` since the caller trims
  open-positions only after it returns. Get this wrong and you double-count an in-flight
  TP1 leg.

**Part A — dashboard re-point (`sid-dashboard.js`, UNCOMMITTED).** The LIVE headline net-P&L
reads `alpaca-account-sid.json` `netPnl` (+$182.18) + equity, labelled **"Paper account
(simulated) · $100,182.18 on $100,000 base"** so it's never mistaken for real cash (room
left for a future "Live — real cash" panel). **Falls back to the records-sum** if the
snapshot is missing (verified: dashboard doesn't break, shows "realized (records)").

**Tested (local, no network):** `node --check` all files. 17/18 ledger+P&L unit tests pass
against the exported functions (the 1 "fail" was a wrong test expectation — `41.395→44.29
×11` = 31.844999… → 31.84 by float, correct). 20/20 fill-booking tests (long+short, TP1+TP2,
real-fill-booked vs estimate-fallback, combined source). End-to-end `updateAccount(999)`
ignores the delta and re-derives +$182.37/8 from records; paper/live segregation verified
(injected `mode:live` +$999.99 excluded from paper sum, isolated in the live sum). Dashboard
regenerated from the WORKTREE ROOT (`node SID/sid-dashboard.js` — worktree root has
node_modules; the repo-root snapshot errors MODULE_NOT_FOUND): v2.4.1 markers, updates count
25, LIVE net-P&L span `+$182.18` + "Paper account (simulated)" label, snapshot-missing
fallback confirmed.

**Ship-check done (v2.4.1, FIX category):** `BOT_VERSION` v2.4.1 + history; `sid-dashboard.js`
`STRATEGY_VERSION='2.4.1'` + banner/brand-sub/perf-note markers; `strategy-updates.json` new
FIX entry at top (count auto → 25); regenerated `docs/sid/index.html`; `SID-README.md`
current-version line + v2.4.1 history row; this append. **Queued:** nothing committed/pushed
for Part A/B (return for review). If Alan approves, push via the standard protocol
(fetch → pull --rebase --autostash → push; never without approval).

### CRON REDUNDANCY — GHA delay past market close was silently skipping exits (2026-09-01) — WORKING TREE, NOT COMMITTED

**Go-live-blocking reliability bug.** `sid.yml` had a SINGLE weekday cron (`'35 14 * * 1-5'`,
14:35 UTC / mid-session — the time itself is correct). But **GitHub Actions scheduled crons are
best-effort and can be delayed by hours** under load. Observed delays (from the GHA run history +
the `SID run` commit timestamps on origin/main): Aug 27 landed **23:51 UTC**, Aug 28 **23:37 UTC**,
Aug 31 **20:15 UTC** — all AFTER the 20:00 UTC US market close. Normal days land ~15:00–16:00 UTC
and work fine.

**Why it breaks exits (root cause, traced in code):** on a closed-market run the executor
(`alpaca-executor.js`) throws `Market closed — refusing to submit ...` from `openEntry`/
`openEntryNoStop` (L202/278), `closePartial` (L338) and `closePosition` (L482). `run()` only LOGS
"Market is closed — will read positions but place no orders" (bot-sid.js ~L2533) and proceeds —
so `checkPositions` still runs but every close is refused. Confirmed on the live PYPL short:
`sid-log.json` has `{"kind":"tp1_close_fail","symbol":"PYPL","error":"Market closed — refusing to
submit partial close for PYPL","reprotected":true}` at `2026-08-28T23:37Z`. PYPL (17 sh short,
entry $60.675, `tp1_hit:false`, `shares_remaining:17`) had RSI well under the short's RSI-50 TP1
trigger but never banked because no run landed in-hours.

**Fix (WORKING TREE):** `.github/workflows/sid.yml` now schedules THREE staggered weekday
market-hours crons — `'35 14 * * 1-5'` / `'35 16 * * 1-5'` / `'35 18 * * 1-5'` (14:35 / 16:35 /
18:35 UTC, all inside US RTH 14:30–21:00 UTC). A multi-hour delay on any one still leaves ≥1 run
in-hours. `workflow_dispatch` kept. This is redundancy, NOT higher cadence.

**Idempotency across same-day runs — VERIFIED from code (all safe):**
- **TP1 fires once** — Branch A is gated `if (!pos.tp1_hit)`; `tp1_hit` persists in
  `open-positions-sid.json` (committed each run). Live proof: IBM `tp1_hit:true`, runner 2 sh.
- **TP2 fires once** — Branch B requires `tp1_hit`; a successful TP2 removes the position from
  open-positions (not pushed to `stillOpen`); a failed close re-protects + retries, never
  double-books. `positionHandled`/`break` bounds it to one close per scan.
- **No double-open** — `openSymbols` set (from committed state) skips already-open symbols;
  `countTodayTrades()` reads committed `trades-sid.csv` filtered to today's date so
  `maxPerDay` (default 1) is a per-CALENDAR-day cap across ALL of the day's runs, not per-run;
  `addOpenPosition` also de-dups on id. (Theoretical overlap risk only if two runs ran
  concurrently — GHA crons are hours apart + sequential, so N/A.)
- **Approval queue** — de-duped by deterministic id `${symbol}-${signalDate}-${side}`;
  `approve-trade.js` aborts on already-actioned. QUEUE is idempotent.
- **The one gap I fixed:** the short-approval **Telegram alert** (`tg.alertShortApprovalNeeded`)
  was fired UNCONDITIONALLY every run the gate triggered — so with 3 runs/day a persisting
  bullish-asset short would send up to 3 identical [Approve]/[Skip] messages/day. Added a guard
  in `bot-sid.js` (~L2812): alert only when the id is NEWLY queued (checked against the same
  pruned view `addPendingApproval` uses). Persisting setup → announced once (re-announced only
  after the 5-day TTL prunes it). Notification-only — zero effect on trade firing.

**Version decision: NO bot-version bump (stays v2.4.1), INFRA category.** Justification: no
entry/exit/sizing/signal rule changed; the only bot-sid.js edit changes NOTIFICATION cadence, not
what trades fire or how P&L books. Matches the precedent for the one-click updater + tax tool
(both INFRA, version unchanged). Ship-check done: one INFRA entry at top of `strategy-updates.json`
(count auto 25 → 26); dashboard regenerated locally to VERIFY (26 badge + entry render) then
RESTORED to HEAD — the regen used the stale worktree state (0 positions); the real rebuild runs
from cloud state via `sid-dashboard.yml`. No README version-history row (not a version bump).

**Tested:** `node --check bot-sid.js` pass; `strategy-updates.json` valid (26 entries); dashboard
build succeeds and shows the (26) count badge + the new entry title.

**⚠ SEPARATE FINDING — NOT fixed this session (assessment only), a real bug queued for a fix:**
the resting intraday short-TP1 OCO cannot reliably COEXIST with the entry stop, so for a v2.2
SHORT the intraday auto-TP1 often never rests — see next section.

### QUEUED BUG — v2.2 short TP1 OCO vs entry stop "insufficient qty" (assessed 2026-09-01 — ✅ FIXED in v2.4.2, see the section below)

Assessment only (do not implement without Alan's go-ahead). Monday 2026-08-31's run logged for the
PYPL short: `[V2.2] Stop placement failed ... insufficient qty available (requested: 9, available:
0)` and `[V2.2] TP1 OCO placement failed ... (requested: 8, available: 0)` while the entry stop
(`brokerStopOrderId 6e93db0c`) held all 17 shares.

**Design intent (v2.2.5):** for a short with `tp1_hit:false`, `maintainV2_2BrokerOrders` reserves
only the RUNNER half for the stop (`shares_total − floor(shares_total*tp1Portion)` = 17−8 = 9) and
places the TP1 half (8) as an OCO — 9 + 8 = 17, so they're MEANT to coexist. The design is sound
in principle.

**Why it fails in practice (two code-visible causes):**
1. **The initial entry stop is placed FULL-size** (`openEntry` → `${prefix}-stop`, all 17 sh).
   `maintain` must CANCEL/reduce it to 9 before the OCO (8) can be placed. That reduction uses a
   fixed `await new Promise(r => setTimeout(800))` between cancel and re-submit — NOT
   `executor.waitForNoOpenOrders(symbol)` like the close paths use. When Alpaca hasn't freed the
   held shares in 800 ms (routine when the order goes `pending_cancel`, especially on a
   closed-market delayed run — the exact Part-1 scenario), the re-submit fails `insufficient qty`
   and is only `console.warn`'d.
2. **`findOpenOrder(symbol, '-stop')` uses `endsWith('-stop')`** (bot-sid.js L938-944). The entry
   stop `${prefix}-stop` matches, but every stop that `maintain`/`placeStop` re-places is
   `${prefix}-stop-${Date.now()}` (ends in DIGITS → does NOT match). Once the id rotates, maintain
   loses track of its own stop → falls into the `!existingStop` PLACEMENT branch (which has NO
   cancel) → tries to place a fresh stop while the timestamped one still holds the shares →
   `insufficient qty available: 0`. **This is the SAME `endsWith('-stop')` bug already documented
   for `closePosition` in the v2.2.6 TP2 pitfall — it was fixed there but the latent twin still
   lives in `maintainV2_2BrokerOrders` and in the Branch A/B belt-and-braces `findOpenOrder(...,
   '-stop')`.**

**Why this is go-live-serious for SHORTS:** for a v2.2 short, `checkPositions` Branch A does
`if (posIsV2_2 && pos.side === 'short') continue;` (L1863) — the daily-poll RSI-50 TP1 is SKIPPED;
the short's ONLY TP1 mechanism is the resting broker OCO. So if the OCO never rests (causes above),
the short has NO working TP1 at all (broker OCO failed to place AND daily-poll skipped). PYPL is
the live example. (A short with NO brokerStopOrderId — e.g. current ABT — is `isV2_2Position=false`
→ does NOT `continue` → DOES get daily-poll TP1; and pdt_safe shorts likewise.)

**Recommended fix (for a future session, with approval):**
- Preferred: for shorts, place a runner-only entry stop (9) + the TP1 OCO (8) AT ENTRY, so there's
  never a full-size stop to reduce (eliminates the fragile cancel-then-replace) — mirrors the
  documented `manual-trade.js` OCO pattern.
- And/or: make maintain's reduction robust — cancel by the tracked `pos.brokerStopOrderId`
  directly (not the suffix search) + use `waitForNoOpenOrders` instead of the 800 ms sleep; and
  fix `findOpenOrder` to match `/-stop(-\d+)?$/` (or `.includes('-stop-')` OR `endsWith('-stop')`).
- PDT-safe mode (`SID_PDT_SAFE=true`) sidesteps this ENTIRE broker-order class of bug (no broker
  orders; daily-poll manages everything, and a pdt_safe short DOES get daily-poll TP1) — at the
  cost of re-depending on the daily poll landing in-hours, which the cron redundancy above now
  addresses. The two fixes are complementary.

### SHORTS-TP1 OCO FIX (v2.4.2, 2026-09-01) — WORKING TREE, NOT COMMITTED

Alan approved **option B (fix the OCO directly)** and wants to validate by banking the live PYPL
short's TP1. This is the fix for the QUEUED BUG above. **Status: WORKING TREE ONLY — nothing
committed/pushed/executed. Built on top of the same-session cron-redundancy changes (they ship
together). Deploy + validate on PYPL via a manual market-hours `sid.yml` dispatch after review.**

**Root cause recap (for a v2.2 SHORT, tp1_hit=false):** its ONLY TP1 mechanism is the resting
broker OCO (Branch A `continue`s past the daily-poll TP1 at L1863). `maintainV2_2BrokerOrders`
must reduce the full-size entry stop (17 sh) to the runner half (9) so the TP1 OCO half (8) has
free shares — but (1) `findOpenOrder(sym,'-stop')` used `endsWith('-stop')`, which MISSES the
timestamped `${prefix}-stop-${ts}` that `placeStop`/maintain create (twin of the v2.2.6
`closePosition` bug), so maintain lost track of its own stop and fell into the placement branch;
and (2) the refresh used a fixed `setTimeout(800ms)` instead of waiting for share release. Net:
the 17-sh stop kept holding everything → runner stop + TP1 OCO both failed `insufficient qty
available: 0` (only `console.warn`'d) → the short had NO working TP1. Live PYPL: 17 sh short,
entry $60.675, RSI ~32.9 ≪ 50, `tp1_hit:false`, `shares_remaining:17`, `brokerStopOrderId
6e93db0c`, stuck 100% open.

**What changed (bot-sid.js + alpaca-executor.js — broker-order plumbing):**
1. **`findOpenOrder` regex.** `endsWith(suffix)` → `new RegExp(esc(suffix)+'(-\\d+)?$')`, so
   `-stop`/`-tp1` match BOTH the bare id AND the timestamped re-places. `-restop-<ts>` is
   deliberately NOT matched (no `-stop` substring after a hyphen) — it's cancelled directly via
   the tracked `brokerStopOrderId`. This also fixes two latent twins the miss caused: the short
   TP1 OCO re-price/dedup (`existingTp1` was never found → it re-placed every run) and long
   post-TP1 BE-stop maintenance (the timestamped BE stop was never matched).
2. **`maintainV2_2BrokerOrders` stop reset (replaces the place/refresh block).** Resets only when
   the stop is missing / wrong-size / wrong-price (`!stopPriceOk || !stopQtyOk`, same trigger
   conditions as before → no steady-state churn). On reset: `executor.cancelOrderById(pos.brokerStopOrderId)`
   (the TRACKED id, robust to any client_order_id) → `cancelOrderById(existingStop.id)` (if
   different) → for a pre-TP1 short, cancel any resting `-tp1` OCO too → `executor.waitForNoOpenOrders(symbol)`
   (real release, NOT a sleep) → place the runner-only stop (`shares_total − tp1`). The TP1 OCO
   section below is UNCHANGED (the existing `submitTp1Oco`) — it now succeeds because its 8 shares
   are free. Where price has already passed the RSI-50 target (short in profit), the OCO buy-limit
   at `rsiTargetPrice(closes,14,50)` is marketable → fills immediately → banks TP1.
3. **Test-only exports:** added `findOpenOrder`, `maintainV2_2BrokerOrders`, `rsiTargetPrice` to
   the `export {}` block (inert on the direct-run path).
4. **SYMBOL-SCOPED SWEEP (mid-session addition, same v2.4.2).** The tracked-id + suffix cancels
   above only see SID-tagged orders. The user placed a break-even buy-stop on PYPL's runner via
   the **Alpaca UI** → Alpaca-generated `client_order_id`, no SID tag → invisible to those cancels,
   so it would keep holding the shares and `waitForNoOpenOrders` would HANG → same `insufficient
   qty available: 0` wall on the runner's TP2 close/reset. Fix: new `executor.cancelAllOpenOrders(symbol)`
   (alpaca-executor.js) — `listOrders({status:'open',symbols:symbol})` → `cancelOrderById` each
   (per-order try/catch), **symbol-scoped** (re-checks each order's `symbol` before cancel, so it
   can NEVER touch another symbol). Called in the cancel-first step of maintain's reset AND BOTH
   close branches (TP1 Branch A, TP2 Branch B), immediately BEFORE `waitForNoOpenOrders`, keeping
   the existing tracked-id + suffix cancels as belt-and-braces. Only runs on a close/reset path
   (never steady-state — verified). After the sweep, `waitForNoOpenOrders` reaches zero and the
   shares are free; maintain then re-places the runner stop + OCO / the close proceeds as before.

**PYPL trace (verified in the test harness):** maintain → cancels 6e93db0c by id → waits → places
9-sh buy-stop @ $63 (`-stop-<ts>`) → places 8-sh OCO buy-limit @ $61.60 (rsiTargetPrice) / stop
$63 (`-tp1-<ts>`); $61.60 > last close $56.40 → marketable → fills → TP1 banks. `syncPositions`
marks `tp1_hit` + migrates the runner stop to BE on a subsequent run. Book reserves exactly
9 + 8 = 17.

**DELIBERATELY did NOT change `openEntry`.** The coordinator's brief said "prefer placing the OCO
AT ENTRY." I did the maintain-path fix instead because: (a) it fixes the LIVE PYPL (already open
with a full-size stop — only maintain can touch it), (b) it fully fixes NEW shorts too (their
first maintain run reliably reduces the stop + places the OCO), (c) an at-entry OCO needs a
`closes`/`rsiTargetPrice` plumbing refactor into `openEntry` + entry-fill polling and introduces
same-day-fill/PDT surface — more regression risk during the validation window. Flagged for the
coordinator to direct if they still want the at-entry version as a follow-up.

**⚠ ONE THING TO WATCH ON THE LIVE VALIDATION RUN:** whether Alpaca accepts an OCO whose
take-profit limit is already MARKETABLE (PYPL's case). The OCO submission is the EXISTING
`submitTp1Oco` (unchanged) — the coordinator's brief explicitly expects it to fill immediately —
but I could not test against live Alpaca. If Alpaca rejects a marketable OCO, the fallback would be
to submit the already-in-the-money short TP1 as a plain marketable limit (the SL leg is moot once
it fills). Watch the manual dispatch's run log for `[V2.2] Placed TP1 OCO` vs `TP1 OCO placement
failed`.

**Tested (local, no network — `scratchpad/test-oco-fix.mjs`, 26/26 pass):** uses a REAL
`AlpacaExecutor` wrapping a mock client (so the real `cancelAllOpenOrders`/`waitForNoOpenOrders`/
`cancelOrderById` run). findOpenOrder matches timestamped + bare `-stop`/`-tp1`, excludes
`-restop-<ts>`/`-entry`/a MANUAL non-SID id; PYPL 17-sh full-stop reset → cancel-by-id + sweep +
wait-reaches-zero + 9-sh runner stop + 8-sh OCO @ rsiTargetPrice, marketable (target > last close),
book = 9+8=17; **standalone `cancelAllOpenOrders('PYPL')` cancels a SID stop AND a manual UI stop
(count 2) while sparing an AAPL order** (symbol-scoped); **maintain reset with a MANUAL BE stop on a
post-TP1 runner** → sweep cancels the UI stop, `waitForNoOpenOrders` reaches zero (would've hung
without the sweep), SID runner BE stop placed; no-regression: steady-state short (NO sweep, no
churn), LONG pre-TP1 (timestamped stop matched → no reset/sweep/OCO). Float note: post-TP1 short BE
= `parseFloat((60.675).toFixed(2))` = `60.67` (60.675 stores as 60.6749…). `node --check`
bot-sid.js + alpaca-executor.js pass. `BOT_VERSION` imports as `v2.4.2`.

**Ship-check (v2.4.2, FIX):** `BOT_VERSION` v2.4.2 + one-liner + detailed history entry;
`sid-dashboard.js` `STRATEGY_VERSION='2.4.2'` + beta-banner / brand-sub / perf-note markers;
`strategy-updates.json` new FIX entry at top (count auto 26 → 27; the cron INFRA entry's version
line reconciled to note it ships with v2.4.2); `SID-README.md` current-version line + a v2.4.2
history row (inserted at the top of the recent descending block, before v2.4.1); regenerated
`docs/sid/index.html` to VERIFY (v2.4.2 markers + (27) badge) then RESTORED to HEAD (real rebuild
runs from cloud state via `sid-dashboard.yml`). No Pine change (visualiser is signal-level, not
execution-level). `.sid-update-manifest.txt` needs no change (bot-sid.js/sid-dashboard.js/README/
updates JSON already listed).

**Queued / not done:** nothing committed/pushed/executed (per brief — return for review). If Alan
approves: push via the standard protocol (fetch → pull --rebase --autostash → push; never without
approval), then manually dispatch `sid.yml` DURING US market hours and confirm PYPL banks TP1 via
the `closed-positions`/`open-positions` diff of that run's commit (NOT sid-log — it only journals
the entry scan). Optional follow-up: the at-entry short OCO (see the DELIBERATELY-did-NOT note).

### ACCOUNTING / DISPLAY FIXES (v2.4.3, 2026-09-05) - WORKING TREE, NOT COMMITTED

Three accounting/display bugs + one data correction. **Status: WORKING TREE ONLY - nothing
committed, pushed or executed against Alpaca (per brief). SID-owned files only.**
**NO canon rule change** - RSI 30/70, RSI(3), MACD alignment, weekly gates, earnings blackout,
AUTO-tier universe, RSI-50 TP1 trigger, TP2 SMA50/200/BE/timeout, share math and entry/arm/scan
are byte-for-byte unchanged. Verified by diff: the ONLY removed lines in `bot-sid.js` are
`if (qtyCounted >= sharesClosed) break;`, `const take = Math.min(q, ...)` and one relocated
`const closed = loadClosedPositions();`. Zero `cancelAllOpenOrders` / `waitForNoOpenOrders` /
`cancelOrderById` / `closePartial` / `closePosition` / `placeStop` / `pollOrderFill` /
`submitTp1Oco` / `findOpenOrder` lines touched -> the v2.2.5 / v2.2.6 / v2.4.2 cancel-first + sweep
mechanics and the `__dirname` anchoring are untouched.

**FIX 1 - `recordExternalClose` DOUBLE-COUNTED already-booked fills.** It queried Alpaca for every
FILLED exit order on the symbol since the position opened and consumed them most-recent-first up to
`sharesClosed`, with NO memory of what a PREVIOUS close had already booked. So a second external
close on the same symbol walked back into leg 1's fills.
- **PROVEN on the live paper PYPL short** (17 sh, entry $60.675, closed manually in two legs):
  leg 1 = 9 sh @ $52.40 -> **+$74.47 (correct)**. Leg 2's real fills were 6 @ $56.66 + 2 @ $56.71
  (avg $56.6725 -> **true +$32.02**) but the bot booked **+$57.58** at "exit $53.4775" - which
  decodes EXACTLY as `(2 x 56.71 + 6 x 52.40) / 8`: two shares at the correct new price, then SIX
  back-filled at $52.40, the price leg 1 had already consumed (order `b312909a`, a 9-share fill leg
  1 used in full). Over-stated by **$25.56**.
- **FIX:** new `consumedExitFillQty(symbol, {closedRecords, positions})` -> `Map<orderId, qtyBooked>`
  built from (a) every prior closed record's `exit_fills` stamp for that symbol and (b) the bot's own
  TP1 partial-close order (now stamped as `tp1_close_order_id` - Branch A hoists `closeOrderId` into
  `tp1CloseOrderId` and stamps it on the position; accounting bookkeeping ONLY, the close block is
  unchanged). The fill loop subtracts that from each order's `filled_qty` and can only draw the
  REMAINDER. **Deliberately mirrors `allocateFillsFIFO`'s per-lot `draw()`/`qtyLeft` model** rather
  than inventing a second scheme (per the brief).
- **HONESTY GUARD:** when the surviving unconsumed fills cover FEWER shares than the close, the
  record is stamped `pnl_source:'estimate'` + `exit_fill_qty` / `exit_fill_shortfall` (+
  `exit_fills_skipped`) rather than extrapolating a price across unseen shares as `alpaca_fill`.
  On the live PYPL data (where Alpaca never returned the 6-share leg) this books $31.72 flagged as
  an estimate instead of $57.58 presented as a real fill.
- `closed` is now loaded ONCE at the top of `recordExternalClose` (it feeds both the consumed-fill
  ledger and the append) - the duplicate `loadClosedPositions()` was removed.

**FIX 2 - the dashboard's LIVE net-P&L headline was a FROZEN snapshot for 7 WEEKS.**
`alpaca-account-sid.json` had exactly ONE writer: `reconcile-account.js` under an explicit
`--write`. `bot-sid.js` never wrote it; `sid-dashboard.js` only reads it. So the headline rendered
`asOf 2026-07-17`, equity $100,182.18 as "current" while the real paper account had moved to
~$100,554.04. **This was the user's actual complaint.**
- `run()` now calls `writeAlpacaSnapshot({equity: preflight.equity, mode: CONFIG.tradingMode})`
  right after `preflight.ok` - the preflight ALREADY fetched the account, so **zero extra API
  calls**. Writes `{equity, startingEquity, netPnl, source:'alpaca', mode, asOf, writer:'bot-sid',
  botVersion}`. Best-effort (try/catch, returns null) - a display write can never abort a run.
- **MODE-SEGREGATED PATHS** (`alpacaSnapshotPathForMode`): paper -> `alpaca-account-sid.json` (the
  existing dashboard file), any other mode -> `alpaca-account-<mode>-sid.json`. A paper run can
  therefore NEVER overwrite a live snapshot or vice-versa.
- `alpacaStartingEquityFor(mode, equity, existing)`: existing `startingEquity` ->
  `SID_ALPACA_STARTING_EQUITY` env -> paper 100000 / other = current equity (so the FIRST live run
  baselines netPnl at 0 rather than reporting a bogus six-figure gain).
- **`.github/workflows/sid.yml` now stages it** - `git add 'SID/alpaca-account*-sid.json'` (glob
  verified against `git ls-files`; also covers the live file). It previously did NOT, so even a
  written refresh would never have reached the dashboard. **This was the second half of the bug.**
- **`sid-dashboard.js` staleness guard:** `SNAPSHOT_STALE_DAYS = 2`. A snapshot older than that (or
  with an unparsable `asOf`) renders `[warn] STALE SNAPSHOT - <mode label> as of <date> (Nd old) -
  not current` in amber instead of the confident "$X on $Y base" caption. The number is still shown
  - hiding it would be its own kind of lie. Label is now mode-aware ("Live account (real cash)" vs
  "Paper account (simulated)"). Verified in the generated HTML: `STALE SNAPSHOT</span> - Paper
  account (simulated) as of 2026-07-17 (49d old) - not current`.

**FIX 3 - `reconcile-account.js` reconstructed OPEN positions as CLOSED (dangerous).** A dry-run on
2026-09-05 would have written PHANTOM closed records for **IBM (2 sh runner)** and **ABT (4 sh
runner)** - both still OPEN - because their banked TP1 partial fills look like a complete buy+sell
round trip in the leftover lots. **The tool was validated 2026-07-17 when there were ZERO open
positions - that is exactly why this was never caught.** Two independent layers, either of which
alone prevents the phantom:
- **(braces) `allocateFillsFIFO(positions, allFills, opts)`** now takes `opts.openPositions`. Open
  positions are allocated alongside the closed records in the same chronological FIFO order, so
  their fills are CONSUMED and never reach `leftovers`. An open position draws its FULL entry leg
  but only the exits it has ACTUALLY taken (`shares_total - shares_remaining`, minus any
  `exit_shares` already captured by a closed partial record sharing its id) - it must never draw an
  exit it hasn't taken. Open positions are always `matched:false, open:true` (never re-priced).
- **(belt) `reconstructOrphans(leftovers, mode, {openSymbols, skippedOut})`** hard-skips any symbol
  with an open position and reports the skip so `main()` logs it loudly.
- **ALSO FIXED (the duplicate-PYPL over-count the brief flagged):** when SEVERAL closed records
  share one position `id` (a partial external close then the final close), each record now draws
  only ITS OWN leg (`exit_shares`) instead of the whole `shares_total` round trip. Previously the
  09-02 record was re-priced to the FULL-trade $106.41 while the 09-04 record kept its $57.58
  estimate = **$163.99 booked for a trade whose true total is $106.49**. Now: 74.47 + 32.02.
  **SINGLE-record positions are untouched** - verified against the real file: 9 of 11 records keep
  `entryNeed = exitNeed = shares_total`; ONLY the two PYPL records switch to per-leg.
- `reconcile-account.js` gained an `import.meta.url` main-guard + `export {allocateFillsFIFO,
  reconstructOrphans, fillSideKind, fillQty, fillPrice, fillMs}` so it can be unit-tested without
  running `main()`. Direct-run behaviour (`node reconcile-account.js`, sid-reconcile.yml) unchanged.

**FIX 4 - the stored PYPL record corrected (one-off, documented).**
`SID/scripts/fix-pypl-leg2-2026-09-05.js` - dry-run by default, `--write` to persist, IDEMPOTENT
(a re-run detects the `correction.tag`). It ASSERTS the full pre-correction state (leg 1 = +$74.47
on 9 sh, leg 2 = +$57.58 at $53.4775 on 8 sh, short side, and that leg 2 actually re-used a leg-1
fill) and ABORTS without changes if anything doesn't match. Applied: `exit_price 53.4775 ->
56.6725`, `exit_pnl / total_pnl / realizedPnl 57.58 -> 32.02`, `exit_fills` -> the real 6 @ $56.66 +
2 @ $56.71, plus a `correction` block recording the old values and the reason.
**The 2026-09-02 leg-1 record is untouched - nothing double-counts.** PYPL trade total = **$106.49**
(74.47 + 32.02). The matching `trades-sid.csv` row was patched (57.58 -> 32.02, risk% recomputed).
The 6 @ $56.66 leg's broker order id was never captured by the buggy run, so it is stamped
`orderId:null, source:'manual_correction'` - an id is never invented.
`SID/scripts/rederive-ledger.js` (new, dry-run default) then re-derived the ledger using the BOT's
OWN `deriveLedger()` (never a hand-rolled copy): `realizedPnl 517.53 -> 491.97`,
`accountUsd 10517.53 -> 10491.97`, `tradeCount 11` (unchanged). Records sum 460.61 -> 435.05.

**! SNAPSHOT NOT HAND-EDITED, ON PURPOSE.** `alpaca-account-sid.json` still reads the stale
2026-07-17 $100,182.18. There are no Alpaca keys locally, so writing the brief's $100,554.04 by hand
would put an unverified number into the file the dashboard presents as "real Alpaca equity" -
strictly worse than a number that is now VISIBLY FLAGGED STALE. The first post-deploy `sid.yml` run
overwrites it with the live value. Do not hand-edit it.

**Tested (local, no network - 70/70 pass).** The harness ran in a throwaway `SID/_v243_sandbox/`
COPY of the module tree (inside the worktree so the root `node_modules` resolves) so no real state
file was ever touched; the sandbox was deleted afterwards.
- `node --check` on all 5 touched/new JS files: PASS. **Real ESM runtime `import()`** of both
  `bot-sid.js` and `reconcile-account.js` (a bare syntax check previously masked a crash-on-run
  bug): PASS, `BOT_VERSION = v2.4.3`, all new + all v2.4.2 exports resolve, `reconcile-account.js`
  imports WITHOUT executing `main()`. `sid.yml` YAML valid; all touched JSON parses.
- **Part 1:** exact two-leg PYPL replay through the REAL `recordExternalClose` with a TIME-AWARE
  mock client (a naive mock that returns future fills makes leg 1 look wrong for reasons Alpaca
  could never produce - harness bug, cost one iteration). Leg 1 = $52.40 / +$74.47 consuming only
  `b312909a`; leg 2 uses ONLY `REAL-6` + `e903f7c2` -> $56.6725 / **+$32.02**; total $106.49 = the
  real-fill sum. **Regression witness:** the pre-v2.4.3 algorithm re-run on the same data reproduces
  the live bad $53.4775 -> $57.58 exactly.
- **Part 1b/1c/1d:** the shortfall path flags `estimate` + `exit_fill_shortfall:6` and books $31.72
  (vs $57.58 before); a normal SINGLE external close (GLD -$61.16 @ $366.39) is unchanged; the bot's
  own TP1 order is excluded so an IBM-style runner prices at the runner fill, not the banked TP1;
  `consumedExitFillQty` is symbol-scoped.
- **Part 2:** snapshot written with fresh `asOf` (<60 s) and current equity; paper/live paths
  distinct and a live write leaves the paper file byte-identical; `startingEquity` carried forward;
  a fresh live snapshot baselines off current equity; NaN equity is a no-op. Dashboard: the live
  July snapshot flags STALE (49d), now/1d do not, 3d/unparsable do. The `sid.yml` stage line is
  asserted by regex.
- **Part 3:** with IBM+ABT open, `reconstructOrphans` returns ONLY MCD (genuine orphan, -$78.14,
  long 8 sh rebuilt from real fills); open positions leave no leftovers; open runners' UNSOLD shares
  are not drawn as exits (IBM exitQty 2, ABT exitQty 4). **Regression witness:** without the fix
  IBM+ABT ARE reconstructed. The belt was tested independently on unfixed leftovers -> still blocked
  + skip reported. Gotcha: `reconstructOrphans` CONSUMES the leftover lots, so a second call needs a
  fresh `allocateFillsFIFO` (cost one iteration).
- **Part 3b/3c:** the two PYPL records reconcile to 74.47 + 32.02 = $106.49 (not $163.99); GOOG
  allocates IDENTICALLY with and without the new `opts` argument; over the REAL closed file 9/11
  records keep `shares_total` legs and only the 2 duplicate-id PYPL records change.
- Dashboard regenerated locally to VERIFY (v2.4.3 markers, `(28)` count badge, the STALE caption,
  the new Updates entry) then **RESTORED to HEAD** - `docs/sid/index.html` is build output and
  `sid-dashboard.yml` rebuilds it from cloud state.

**Ship-check (v2.4.3, FIX):** `BOT_VERSION` v2.4.3 + one-liner + detailed history block;
`sid-dashboard.js` `STRATEGY_VERSION='2.4.3'` + beta-banner / brand-sub / perf-note markers;
`strategy-updates.json` new FIX entry at top (count auto 27 -> 28); `SID-README.md` current-version
line + a v2.4.3 history row above v2.4.2. No Pine change (the visualiser is signal-level).
`.sid-update-manifest.txt` needs no change (bot-sid.js / sid-dashboard.js / README / updates JSON
are already listed).

**! QUEUED - SEPARATE LATENT DOUBLE-COUNT, ASSESSED BUT NOT FIXED (outside this brief's scope).**
`deriveLedger` sums closed records of the mode PLUS `tp1_pnl` of still-open `tp1_hit` positions.
When a v2.2 TP1 fills via the resting broker OCO, `syncPositions` reports a PARTIAL close ->
`recordExternalClose` writes a CLOSED record for that leg, and then the v2.2 TP1-detection block in
`run()` ALSO sets `livePos.tp1_hit/tp1_pnl` for the SAME shares -> the leg is counted twice on every
subsequent run. It has not bitten yet purely by luck: on PYPL the detection block's `-tp1` fill
lookup fell back to `livePos.entry`, so `tp1_pnl` was **0**. IBM/ABT banked TP1 via Branch A (no
closed record) so they are clean today, and the numbers above are correct. **Suggested one-line
guard for v2.4.4 (needs approval + its own tests):** in `deriveLedger`, skip a still-open position's
`tp1_pnl` when a closed record already exists with the same `id` and `is_full_close === false`.
Zero effect on today's figures; prevents the next occurrence.

**Also noticed (not changed):** `sid.yml` does not stage `SID/pending-approvals-sid.json`, so the
Telegram approval queue's de-dupe state does not persist across cloud runs. Flagged only.

**Queued / not done:** nothing committed or pushed (per brief - return for review). If Alan
approves: push via the standard protocol (fetch -> pull --rebase --autostash -> push; never without
approval). The first `sid.yml` run after deploy should log `[Alpaca] Account snapshot refreshed:
equity $... netPnl ...` AND the resulting commit should include `SID/alpaca-account-sid.json` - that
pair is the proof FIX 2 landed. Optional follow-up: wire the dashboard to read a LIVE snapshot file
when SID goes live (today it only reads the paper one; the caption is already mode-aware).

---

### P&L BOOKING FIXES (v2.5.0, 2026-10-18) - WORKING TREE, NOT COMMITTED

The dashboard was reporting the WRONG realised profit. Three independent booking bugs had
corrupted the stored records; this release fixes the CODE so it can't recur and repairs the
records already on disk. **Status: WORKING TREE ONLY - nothing committed or pushed (per brief).
No Alpaca order was ever submitted, cancelled or modified - every broker call was a read-only GET.**
**NO canon rule change** - RSI 30/70, RSI(3), MACD alignment, weekly gates, the RSI-50 TP1
trigger, TP2 SMA50/200/BE/timeout, the 14-day earnings blackout and the AUTO/HUMAN tiers are
byte-for-byte unchanged. Accounting + execution plumbing ONLY.

**THE STARTING DISCREPANCY (all verified 2026-10-18):** Alpaca paper equity **$100,543.43**
(net **+$543.43**), 0 positions, 0 open orders. Ledger `sid-account.json` realizedPnl
**+$512.02** / 16 records. Dashboard headline **+$182.18** (the frozen 2026-07-17 snapshot).

**BUG 1 - external full close DROPPED a bot-booked TP1 leg.** `recordExternalClose` set
`total_pnl` to the closed leg ALONE, while `deriveLedger` adds an open position's `tp1_pnl`
ONLY WHILE IT IS OPEN. So the instant a runner closed externally, a TP1 half banked by
Branch A silently left the books:
- IBM: TP1 2sh @ 237.51 = +$40.56 LOST -> booked +$42.52, truth **+$82.88**
- HON: TP1 2sh @ 214.73 = +$20.58 LOST -> booked **-$0.09** (a "loss"), truth **+$19.83** (a WIN)
The bot's OWN TP2 path never had this bug - it already did `tp1_pnl + tp2Pnl`.
**FIX:** a full close now carries the TP1 leg into `total_pnl` (`exit_pnl` still holds only
that leg), gated by the new shared `tp1LegAlreadyInClosedRecords()`.

**BUG 1b - the MIRROR double-count, queued in v2.4.3, closed by the SAME predicate.**
`deriveLedger` was adding a still-open position's `tp1_pnl` ON TOP of the closed PARTIAL
record the broker-OCO path writes for that same leg. Both directions now share ONE predicate,
each with its own regression witness. The v2.4.1 behaviour (an in-flight Branch-A TP1 DOES
compound into sizing) is preserved - test B4 guards it.

**`tp1LegAlreadyInClosedRecords(pos, closedRecords)` - the design, because the naive version
is wrong.** "Position has `tp1_pnl`" does NOT imply "the leg is unbooked". A TP1 half reaches
the books by two different routes: (a) THE BOT banked it (Branch A - no closed record; the leg
lives on the position and Branch A stamps `tp1_close_order_id`), or (b) THE BROKER banked it
(resting OCO -> `recordExternalClose` writes a closed `is_full_close:false` record AND the v2.2
detection block in `run()` stamps `tp1_pnl` on the live position for the SAME shares). Only
`is_full_close === false` records count as a separate leg (a full-close record IS the trade
total). If the bot holds the TP1 order id and the partial record was priced from OTHER orders,
the leg is NOT in that record, so keep looking. **Ambiguity defaults to TRUE (already booked)**
- for an accounting fix, never inflate.

**BUG 2 - stop exits booked the stop LEVEL, not the real fill.** The daily-poll stop path
submits a MARKET close, which fills at whatever the market gives - but it never overwrote
`exitPrice` with `filledAvgPrice` and left `pnl_source:'estimate'`. HD booked 3sh @ $304.00 =
-$24.96; the real fill was **$303.346667** = **-$27.01**. v2.4.1 had fixed exactly this for
TP1/TP2 and the stop path was simply missed. **FIX:** the stop path AND the v2.0 RSI-50
fallback path now capture `closePosition()`'s `closeOrderId`, `pollOrderFill` it, overwrite the
price and recompute via `realisedPnlFor` - the identical shape as Branch A/B. **Invariant now
true: no close path leaves `pnl_source:'estimate'` when a real fill exists** (test C10 asserts
it on comment-stripped source).

**BUG 3 - the ENTRY price was the signal close, not the entry fill.** `run()` stored
`signal.entry` (the bar the rules fired on) for a MARKET order. Because entry feeds BOTH exit
legs, every cent multiplied across the whole trade. **`approve-trade.js` had been doing it
correctly all along** (`pollOrderFill` -> `fill.filledAvgPrice`, L216) - the main path just
never caught up. **FIX:** mirror it, storing `filledAvgPrice` plus `entry_source` /
`signal_entry` / `entry_fill_qty` provenance.
**DELIBERATELY NOT recomputed: share count, `stopLoss`, `riskUsd`.** The order is already
submitted and the broker GTC stop already rests at `signal.stopLoss` - rewriting either would
desync the record from the live broker order, and sizing/stop are strategy outputs. A filled
qty that differs from the ordered qty is LOGGED (`entry_partial_fill`), never silently
rewritten - `syncPositions` reconciles real qty next run.

**! THE BRIEF'S NUMBERS WERE SLIGHTLY OFF, AND THE REASON MATTERS.** The brief listed IBM's
entry as 217.13 and predicted a corrected total of $545.09 with a ~-$1.66 fee residual. The
real IBM entry FILL is **217.23** - 217.13 is the signal price, i.e. bug 3 had hit IBM too.
**Auditing ALL 16 records against real fills (not just the 5 flagged) found two more drifted
records nobody had spotted: ABT -$0.08 and RIOT -$0.59**, both pure bug-3 entry error.
Reconciliation (the brief's 545.09 minus the four unflagged entry errors 0.40 IBM + 0.08 PYPL
+ 0.08 ABT + 0.59 RIOT = 1.15) -> **543.94**. So the true residual is **-$0.51 of real fees,
not -$1.66**; the brief had attributed all of it to fees.
**LESSON: audit the WHOLE record set against the broker, never just the rows someone flagged.**

**RECONCILES EXACTLY, AND NOT BY SUBTRACTION FROM EQUITY (which would be circular):**
- Cash-flow P&L from `/v2/account/activities/FILL`, summed per symbol as (sell proceeds - buy
  cost) over all 12 symbols (every symbol is FLAT, so this is exact): **+$543.94**
- Fee activities from `/v2/account/activities/FEE`: **47 rows = -$0.51** (TAF -0.14, CAT -0.27,
  REG -0.10). A `JNLC` +100,000 row confirms the $100K base.
- **543.94 - 0.51 = 543.43 = Alpaca equity, to the cent. Residual $0.00.**
- **INDEPENDENT SECOND OPINION:** `reconcile-account.js --dry-run` with a live read-only
  connection (`SID_TRADING_MODE=paper`) allocates the broker's fills through COMPLETELY
  SEPARATE code (its own FIFO allocator) and agreed on **all 16 records at +$0.00 delta**, with
  entry prices matching mine exactly (RIOT ~19.67, IBM 217.23, HD 312.35, HON 204.44, ABT
  115.35, PYPL 60.67). It reported "gap -$0.51 [OK] reconciled to the dollar".

**RECORD CORRECTION - `scripts/fix-pnl-booking-2026-10-18.js`** (dry-run default, `--write` to
apply). Corrects 8 records: RIOT 146.19->145.60, ABT 53.24->53.16, IBM 42.52->**82.88**,
HD -24.96->**-27.01**, IYR provenance only (P&L was already right), HON -0.09->**+19.83**,
PYPL leg1 74.47->74.43, PYPL leg2 57.58->**31.98**.
- ASSERTS the exact pre-state of every field it touches and ABORTS (exit 1, writes nothing) on
  any mismatch, including a record that already carries the corrected value. A second `--write`
  refuses on the `correction.tag`. Stores `correction.previous` in-record so it is reversible.
- PAPER-ONLY guard: a non-paper record is refused outright. Makes NO network calls.
- Every leg is recomputed by the BOT'S OWN `realisedPnlFor()` from real fills, then
  cross-checked against the independently computed per-symbol cash-flow target; a mismatch
  aborts. **This guard EARNED ITS KEEP** - see the rounding pitfall below.
- **SUPERSEDES `scripts/fix-pypl-leg2-2026-09-05.js`, which was never applied to cloud state.**
  Its target was +32.02 because it used the STORED entry 60.675; the real entry fill is 60.67,
  making the correct figure **+31.98** (and the PYPL short total **+$106.41**, not 106.49 -
  which is exactly the figure the v2.4.3 notes recorded the reconcile tool computing). Don't
  run both.
- The 6 @ $56.66 PYPL fill DOES have a broker order id (`452d8277-82a8-4010-9daf-dfbb5c73a2d7`)
  in `/v2/account/activities/FILL`, so it is stamped properly - v2.4.3 had recorded
  `orderId:null` believing it was unrecoverable. An id is still never invented.

**PITFALL (new, cost one iteration): Alpaca's order-level `filled_avg_price` is ROUNDED TO 6dp,
and for a multi-price order that rounding alone can move a leg by a cent.** RIOT's entry shows
as `19.665526` but is really 747.29/38 = 19.66552631578...; using the displayed value made the
legs sum to **145.61** against the broker's **145.60** and the cross-check correctly refused to
write. HD's exit shows `303.346667` but is really 910.04/3. **FIX: for any order whose
individual fills are NOT all the same price, compute the weighted average from the per-fill
rows (`/v2/account/activities/FILL`), not the order's `filled_avg_price`.** Single-price orders
are already exact. Had the cross-check not been there, this would have silently shipped a
1-cent-per-trade error.

**PITFALL: the stop path does not append to `trades-sid.csv` at all.** HD and IYR both closed
via the Branch A stop and have NO journal row (the closed-positions JSON has them; the CSV
doesn't). Pre-existing, NOT introduced here, and the dashboard reads the JSON (`realizedPnl ??
pnl`) not the CSV, so no displayed number is affected. **Flagged, not fixed - out of this
brief's scope.** Worth a v2.5.1.

**TESTS - `tests/v2.5.0-pnl-booking.test.mjs`, 100 checks, 100 PASS.** Sandboxed, NO network,
NO broker calls.
- **This suite is CHECKED IN, deliberately.** The v2.4.1/v2.4.3 harnesses ran in throwaway
  sandboxes that were DELETED afterwards, so the brief's "keep the existing 70/70 suite green"
  was impossible to honour - **the suite no longer existed**. Don't do that again: a test you
  delete is a test you have to re-earn. This one persists.
- Mechanism: copies the module tree into `SID/_v250_sandbox/` (inside the worktree so the root
  `node_modules` resolves), writes fresh isolated state, imports `bot-sid.js` FROM the sandbox
  so the `__dirname`-anchored state paths point at throwaway files, and removes the sandbox on
  exit (test H1 asserts it). No real state file is ever touched. `TELEGRAM_ALERTS_ENABLED=false`
  keeps it silent.
- **REGRESSION WITNESSES (the point of the suite):** the pre-fix algorithm is re-implemented and
  re-run on the real live data, and must reproduce the EXACT bad number that was on disk -
  IBM **+42.52** (A1), HON **-0.09** (A2), HD **-24.96** (C1), the ledger double-count
  **148.86** (B1), HON TP1 **21.02** off the signal entry (D1) - BEFORE the fixed code is
  asserted to produce 82.88 / 19.83 / -27.01 / 74.43 / 20.58. A test that only asserts the new
  number can't tell you the bug was ever real.
- Groups: A external-close TP1 carry (incl. the PYPL no-double-count guard, partial-close
  must-not-carry, and provenance downgrade when the TP1 leg was an estimate), B the ledger
  mirror + the predicate's 6 edge cases + paper/live segregation, C the stop path (arithmetic
  witness + wiring assertions on live source), D the entry fill (incl. that stopLoss/shares/
  riskUsd are NOT recomputed), E the 16 real corrected records tie to the broker, F the v2.4.3
  carried work has not regressed, G the instructor canon constants are untouched.
- **HONEST LIMITATION:** groups C and D prove the NUMBER arithmetically and the WIRING by
  regex on the live source, not by executing `checkPositions`/`run()` end-to-end - both need
  network candle data and a live executor. The `recordExternalClose` tests (group A) DO drive
  the real exported function with a time-aware mock client.
- **Mock gotcha (inherited from v2.4.3, re-confirmed):** the mock Alpaca client MUST be
  time-aware (serve only fills that existed before the close time). A naive mock returning
  future fills makes leg 1 look wrong for reasons the real broker could never produce.

**Ship-check (v2.5.0, FIX):** `BOT_VERSION` v2.5.0 + detailed history one-liner; new export
`tp1LegAlreadyInClosedRecords`; `sid-dashboard.js` `STRATEGY_VERSION='2.5.0'` + beta-banner /
brand-sub / perf-note markers; `strategy-updates.json` new FIX entry at top (count auto 28 ->
**29** - the badge is derived from `strategyUpdates.length` in BOTH the tab button and the
panel title, so adding the entry increments both automatically; no manual count to edit);
`SID-README.md` current-version line + a v2.5.0 history row above v2.4.3; root `CLAUDE.md`
index row -> v2.5.0; this append. `docs/sid/index.html` is BUILD OUTPUT - regenerated to verify
then RESTORED to HEAD, because `sid-dashboard.yml` rebuilds it from cloud state. No Pine change
(the visualiser is signal-level and no signal rule moved).

**Runtime proof:** `node --check` is not enough - a real ESM `import()` of `bot-sid.js` was run
and reports `BOT_VERSION = v2.5.0` with every new + pre-existing export resolving.

**Queued / not done:**
- NOTHING COMMITTED OR PUSHED - returned for Alan's review (per brief). If approved, push via
  the standard protocol (fetch -> pull --rebase --autostash -> push; never without approval).
- `alpaca-account-sid.json` is STILL the stale 2026-07-17 $100,182.18 snapshot and was
  deliberately NOT hand-edited (same call as v2.4.3): writing a number by hand into the file the
  dashboard presents as "real Alpaca equity" is worse than one that is VISIBLY FLAGGED STALE.
  **The first `sid.yml` run after deploy overwrites it** with live equity (that's the v2.4.3
  FIX-2 snapshot writer) and the resulting commit should include the file - that pair is the
  proof it landed. Until then the dashboard headline stays flagged STALE.
- `sid-account.json` `reconciledAt` still says 2026-07-17 - left alone, as it belongs to
  `reconcile-account.js --write`, which was NOT run in write mode.
- **Methodology note (always cite it):** `sid-account.json` is the **1%-compounding-from-$10K**
  ledger (`accountUsd` $10,543.94 on `startingUsd` 10000) while the broker account is
  **$100,543.43 on a $100,000 base**. The DOLLAR realised P&L ties (543.94 vs 543.43 less fees);
  the BASE differs by 10x. `accountUsd` is a sizing construct, NOT broker equity - don't quote
  it as account value.
- The stop path's missing `trades-sid.csv` row (above) is a candidate v2.5.1.
- Untracked cruft noticed in the worktree: `SID/strategy-updates.json.tmp.37284.348d7f4b10c6`
  (leftover from an interrupted write), `SID/__pycache__/`, and a dozen untracked
  `backtest-v2.1-validation-report-*.{json,csv}`. Not touched; worth a housekeeping sweep.

---

### QUEUE-FOR-OPEN EXITS + RAILWAY CRON RUNNER (v2.6.0, 2026-10-24) - ✅ SHIPPED, commit `cd7b99b6d`

**Status: SHIPPED 2026-10-24 as commit `cd7b99b6d`; the Railway cron service is DEPLOYED and
pushing `SID railway run ...` state commits. (It was working-tree-only when first written up.)
Nothing was executed against Alpaca during its build — Every broker interaction in this session was a read-only doc fetch; NO order was
submitted, cancelled or modified.** SID-owned files only (plus root `CLAUDE.md`, which is the
shared index). **NO canon rule change** - RSI 30/70, RSI(3), MACD alignment, the weekly gates,
the 45/55 no-go zones, the RSI-50 TP1 trigger, TP2 SMA50/200/BE/timeout, the 14-day earnings
blackout, the AUTO/HUMAN tiers and the 50% TP1 portion are byte-for-byte unchanged. Asserted by
test group V (14 checks on the live source + CONFIG).

#### THE LIVE FAILURE

2026-09-09, IBM runner. TP2 (SMA50 touch) triggered in the last ~35 minutes of the session. The
next bot run landed **21:06 UTC**, an hour after the close. It correctly swept the resting stop,
then hit `Market closed - refusing to submit close for IBM` (`alpaca-executor.js:520`),
re-protected the runner and gave up until the next run. Alan then did it by hand: cancelled the
stop, queued a market sell, filled at the next open (2 @ $238.39).

**TWO independent faults, and this is the bit to remember:**
1. GHA crons land ~3h late (14:35 -> ~18:15, 18:35 -> ~21:10 UTC), so a ripe exit can slip for days.
2. **On-time crons would ALSO have missed this one**, because the touch came after the last
   in-hours run. Punctuality alone cannot fix it - the bot needed a way to act while the market
   is shut. Hence both halves of this release.

#### PART 1 - QUEUE-FOR-OPEN EXITS

When an exit triggers and the market is CLOSED (`shouldQueueExitForOpen(executor)` = executor
exists AND `CONFIG.queueExitsForOpen` AND `!executor.clock.is_open`):
1. **Sweep every resting order on the symbol first** - `cancelOrderById(brokerStopOrderId)` ->
   `findOpenOrder(sym,'-stop')` -> `cancelAllOpenOrders(sym)` -> `waitForNoOpenOrders(sym)`.
   Alan's standing requirement, and the shares cannot be freed otherwise (the
   v2.2.5/v2.2.6/v2.4.2 held-shares family).
2. Submit a **market order the broker executes at the next open** (`executor.queueExitAtOpen`).
3. Stamp `pos.pending_exit` = `{order_id, client_order_id, time_in_force, status:'queued',
   reason, kind:'partial'|'full', shares, queued_at, attempt, booking:{trigger_date, trigger_rsi,
   estimate_price, be_price, runner_shares, tp2_reason, exit_level, exit_strategy}}`.

**`pending_exit` is the single-fire guard.** `checkPositions` SKIPS any position carrying one -
before the candle fetch, so it is free - which is what makes "never queue a second order while
one is pending" true, and also stops a queued TP1 re-firing (`tp1_hit` flips only when the fill
is BOOKED, never when it is queued; no P&L is booked at queue time).

**Reconcile (`reconcilePendingExits`) runs at the TOP of `run()`:**
- **filled** -> booked through the real-fill path, `pending_exit` cleared, and for a TP1 partial
  the BE stop restored on the remainder.
- **still open / accepted / new / held / partially_filled** -> left strictly alone.
- **canceled / rejected / expired / 404** -> cleared, **immediately re-protected with a stop**,
  loud `alertPendingExitDropped`. A dropped queued exit with no stop is the one genuinely
  dangerous state here.
- **a NON-404 lookup error (5xx)** -> left alone. A transient read failure is NOT evidence the
  order is dead; re-protecting would double-hold the shares and block the live order from
  filling. (Test I5.)
- **submission itself rejected** -> fall back to exactly the pre-v2.6.0 behaviour: re-protect,
  alert (`alertExitQueueFailed`), retry next run, with the attempt counter advanced.

All four exit paths are wired: pre-TP1 stop, TP1 partial, TP2 runner, v2.0 RSI-50 fallback.
**ENTRIES ARE NEVER QUEUED** - `alpaca-executor.js:202/:278` are untouched, because a stale entry
signal must be re-evaluated against a fresh bar. `queueExitAtOpen` is the ONLY order-submitting
method without a market-hours guard (test J4 asserts that).

#### WHAT ALPACA ACTUALLY DOES WITH AN OVERNIGHT / FRIDAY QUEUED EXIT (verified, don't re-derive)

Fetched from `https://docs.alpaca.markets/docs/orders-at-alpaca` on 2026-10-24:

> **opg** - "Use this TIF with a market/limit order type to submit 'market on open' (MOO) and
> 'limit on open' (LOO) orders. This order is eligible to execute only in the market opening
> auction. Any unfilled orders after the open will be cancelled. **OPG orders submitted after
> 9:28am but before 7:00pm ET will be rejected. OPG orders submitted after 7:00pm will be queued
> and routed to the following day's opening auction.** On open/on close orders are routed to the
> primary exchange."

> **day** - "...If submitted after the close, it is queued and submitted the following trading
> day." And from "Orders Submitted Outside of Eligible Trading Hours": **"Orders not eligible for
> extended hours submitted after 4:00pm ET will be queued up for release the next trading day."**

**THE CRITICAL CONSEQUENCE: OPG has a DEAD ZONE of 09:28-19:00 ET, and the exact IBM failure
(21:06 UTC) is 17:06 ET - squarely inside it.** A naive "just use OPG" implementation would have
been REJECTED on precisely the run it was built to fix. So `executor.queuedExitTif(attempt)`:
- ET >= 19:00 -> `opg` (queued to the following day's opening auction)
- ET < 09:28   -> `opg` (today's opening auction)
- otherwise    -> `day` (documented as queued for release the next trading day) - which is also
                  literally what Alan submitted by hand
- ET unreadable -> `day` (broader accept window = the safe default)
- retries ALTERNATE the tif (attempt 2/4 take the other one) so a wrong guess self-corrects on
  the next cycle rather than looping.

**ET comes from the BROKER's own clock, never a hardcoded timezone.** `etMinutesOfDay()` parses
`HH:MM` out of `/v2/clock`'s `timestamp` and **asserts the offset is `-04:00` or `-05:00`** - the
digits are then already Eastern wall-clock and DST is the broker's problem. If Alpaca ever
switches that field to `Z`, the assertion fails, the function returns `null`, and we take the
safe `day` branch instead of silently reading UTC digits as ET. (Tests B7-B13.)

**Friday evening -> Monday's open.** Both mechanisms route to the next *trading* day. This is why
the weekend guard had to change (below): Friday 19:30 ET is **Saturday 00:30 UTC**.

#### THE TRADE-OFF, STATED PLAINLY (documented, not solved)

Between the sweep and the open the position has **NO resting stop**, because a stop HOLDS the
shares and would block the queued exit. Accepted because: (a) the exposure is the overnight gap
on a position we are exiting anyway, (b) a market-on-open fill is equivalent-or-better than a
stop triggering at that same open, and (c) the window only ever exists while the market is
CLOSED, so there is no intraday price action to be unprotected against. The reconcile's
dead-order branch exists precisely so this window can never become permanent.

#### WEEKEND GUARD CHANGED (and why it is not a rule change)

It used to `return` BEFORE `checkPositions`, so a position was not even looked at Sat/Sun. With
queue-for-open that is a real hole (Friday evening ET = Saturday UTC). Now: the guard still blocks
the **ENTRY SCAN** - which is all it ever protected against, a signal computed off Friday's stale
close - but position management runs. Revert with `SID_WEEKEND_EXIT_QUEUE=false` (restores the
hard early return, byte-for-byte).

#### PART 2 - RAILWAY **CRON** RUNNER (design changed mid-session)

`SID/railway-sid-runner.js`. **One-shot, NOT an always-on `setInterval` loop.** The coordinator
changed this mid-task on cost grounds: Alan is on the ~GBP5/mo Hobby plan with ~$0.35 of usage,
and a resident 24/7 Node worker would add ~$2-3/mo - a multiple of his entire bill - to run a
daily-bar strategy that needs seconds per cycle. Railway's cron bills execution time.

Cycle: **assert env -> pull state+config from `main` via the GitHub Contents API -> read Alpaca
`/v2/clock` -> run `bot-sid.js` once -> push changed state back (sha-aware) -> exit 0.**

- **Market gating is the broker's clock, never a hardcoded calendar.** Open -> FULL cycle.
  Closed (or clock unreadable) -> CHEAP cycle via the new `SID_EXITS_ONLY=true`: reconcile +
  queue exits, but skip the 112-ticker Yahoo scan (an entry would be refused out of hours
  anyway). "Clock unreadable -> cheap" means we never enter blind.
- **State branch is `main`**, not Ironclad's `logs` branch, because `sid-dashboard.yml` builds
  the dashboard from main. File list mirrors `sid.yml`'s `git add` lines (test L16 asserts that
  programmatically, so the two can't drift).
- **Push is conservative:** a file whose bytes are unchanged from what we pulled is NOT pushed at
  all (no clobber risk, and no redeploy churn). A changed file re-reads the remote head first; if
  the sha moved under us, `closed-positions` / `pending-approvals` merge **by id**,
  `trades-sid.csv` merges as a **row union**, and `open-positions` / `sid-account` / `sid-log` /
  the snapshot resolve to **LOCAL** (we just acted at the broker, so our view is the one
  reflecting reality) with the conflict logged loudly. 409 -> re-read + retry once.
- **Crash-safe:** a bot exception is caught and the cycle still pushes whatever the bot DID
  write, so a booked exit always reaches the cloud.
- `RUNNER_VERSION` + an `import.meta.url` main-guard + a `--version` flag, so the module can be
  imported for tests with no side effects and its version proven at runtime.
- Commit message `SID railway run ...` - deliberately distinct from Actions' `SID run ...`
  (added to the root CLAUDE.md glossary). Note it is a **Contents-API write, not a git push**, so
  it never shows up as an Actions run.

**RAILWAY CRON FACTS (from Railway's own docs, 2026-10-24 - the design depends on these):**
- Cron Schedule lives in **service Settings**; schedules are **UTC**.
- Runs must be **>= 5 minutes apart**; `*/15 * * * *` is given as valid.
- **Overlap: "if a previous execution is still running when the next scheduled execution is due,
  Railway will skip the new cron job."** So the runner cannot race ITSELF - but a hung cycle costs
  every subsequent one, which is why it must exit cleanly.
- **Precision: "Railway does not guarantee execution times to the minute as they can vary by a
  few minutes."** Minutes, versus GHA's observed HOURS. That is the whole win.
- Docs do **NOT** promise a retry on a non-zero exit -> the runner exits **0** whenever a cycle
  ran (the next tick retries transient failures) and reserves **exit 1** for a CONFIGURATION
  error so it shows as a failed run. `railway-sid.json` sets `restartPolicyType: NEVER` so a
  failing run can't restart-loop.
- **UNVERIFIED (flagged, not designed around):** that a cron service bills **no idle time**
  between runs. The docs present cron as the way to "save resources between executions, as
  opposed to having an in-code scheduler run 24/7", which implies it - but it is intent, not a
  stated billing rule. **Check the first month's actual bill.**

**Recommended schedule `*/15 13-23 * * 1-5` (UTC).** `13-23` spans the US session in BOTH DST
regimes (14:30-21:00 UTC in EST, 13:30-20:00 in EDT) plus the post-19:00-ET window when Alpaca
accepts an at-the-open order for the next session. The schedule NEVER decides whether the market
is open - `/v2/clock` does.

#### CONCURRENCY - MADE SAFE AT THE BROKER, NOT JUST IN LOCAL STATE

Phase 1 runs the Railway cron AND the GHA crons. Local state can be stale, so correctness cannot
rest on it. The hard guard:

**`exitClientOrderId(symbol, tag, YYYYMMDD, attempt)` -> `SID-<SYM>-<tag>-<YYYYMMDD>[-a<n>]`.**
Deterministic in (symbol, exit kind, calendar date, attempt) and NOTHING else - no timestamp, no
PID, no randomness - so two processes that both decide to queue the same exit compute the SAME id
and **Alpaca rejects the second as a duplicate** (`client_order_id must be unique`). Test D3-D8
drives two executors against one mock broker and asserts exactly ONE market sell exists, with the
loser re-protecting instead of stamping a `pending_exit` it doesn't own.
- The **date** in the id permits ONE legitimate re-queue per calendar day while blocking a
  same-day duplicate.
- The **attempt** suffix exists because a REJECTED order still consumes its client_order_id at
  Alpaca; the counter lives in COMMITTED state (`pos.exit_queue_attempts`) so both processes still
  agree. It is deliberately **monotonic, never reset** - a fresh id is always safer than a reused one.

**Per-path audit of everything that can submit an order:**
| Path | client_order_id | Concurrency verdict |
|---|---|---|
| Entry (`openEntry`/`openEntryNoStop`) | `<prefix>-entry`, prefix = symbol+signalDate+side | **Broker-idempotent.** A concurrent duplicate is rejected. |
| Entry-time stop (`openEntry`) | `<prefix>-stop` | Broker-idempotent. |
| Queued exit (v2.6.0) | `SID-<SYM>-<tag>-<date>[-a<n>]` | **Broker-idempotent** (the new guard). |
| Re-placed stop (`placeStop`) | `<prefix>-<tag>-<Date.now()>` | **NOT deterministic** - see below. |
| TP1/TP2 close (`DELETE /v2/positions`) | n/a (no client id) | **NOT idempotent** - see below. |

**Two residual risks, DOCUMENTED not fixed (they need their own brief):**
1. **`placeStop` ids carry `Date.now()`**, so two concurrent runs could place two protective
   stops. Left alone deliberately: a daily-deterministic stop id would break the legitimate
   same-day re-place flows (maintain reset, BE migration). It is also self-limiting - the first
   stop HOLDS the shares, so the second is rejected `insufficient qty available`, and every
   close/reset path begins with `cancelAllOpenOrders(symbol)` which sweeps strays. A duplicate
   protective stop over-reserves; it cannot sell twice.
2. **An IN-HOURS close is not broker-idempotent** (`DELETE /v2/positions/SYM` takes no
   client_order_id). Two in-hours runs landing within the same seconds could each submit a close;
   the second would be rejected `insufficient qty` once the first fills, but a true simultaneous
   race is theoretically possible. Mitigation today: Railway skips its own overlaps, the GHA crons
   are hours apart, and Phase 2 removes the overlap entirely. **If this ever needs closing, submit
   the in-hours close as an explicit `submitOrder` with a deterministic client_order_id rather
   than the positions endpoint.**
3. `maxPerDay`/`openSymbols` rest on COMMITTED state, so two concurrent runs could each open a
   DIFFERENT symbol and exceed `maxPerDay`. Same-symbol is blocked by the `-entry` id. Low impact
   (both would be valid signals, sized correctly), and Phase 2 removes it.

#### PHASE PLAN (Phase 2 NOT done in this release)

- **Phase 1 (this release):** Railway cron runs ALONGSIDE the three `sid.yml` crons. Belt and
  braces. A banner comment in `sid.yml` says so and points at `RAILWAY-DEPLOY.md`.
- **Phase 2 (later, only after the Railway service has covered a few clean sessions):** comment
  out `sid.yml`'s `schedule:` block keeping `workflow_dispatch`, in the exact banner style of
  `.github/workflows/trade.yml`. The ready-to-paste block and the specific go/no-go evidence to
  collect first are in `SID/RAILWAY-DEPLOY.md` § "Phase 2".

#### A BUG I INTRODUCED AND CAUGHT (write this down - it is the subtle one)

The first draft of `reconcilePendingExits` handed `deriveLedger` an open set of
`openPositions.filter(p => p !== pos)`. With **two** positions whose queued exits both fill in the
same reconcile, the SECOND booking's "open" set still contained the FIRST (already-closed)
position, so its `tp1_pnl` was added **on top of** its own full-close record - which already
carries that leg, because `tp1LegAlreadyInClosedRecords` returns FALSE for a full-close record
**by design** (a full record IS the trade total). Fix: pass the EXACT set - processed-and-still-open
(`survivors`) + not-yet-processed (`openPositions.slice(idx+1)`) - plus a final
`updateAccount(null)` re-derive from the saved files as belt-and-braces. Test group N has the
regression witness (the buggy set inflates the ledger by IBM's +$40.56).
**Generalised lesson:** `checkPositions` gets this right only because it builds `stillOpen`
incrementally. Any NEW loop that books multiple closes must construct the open set explicitly -
`filter(p => p !== current)` is wrong the moment a second close lands in the same pass.

#### OTHER SMALL FIXES IN THIS RELEASE

- **`sid.yml` now stages `SID/pending-approvals-sid.json`** - flagged as missing back in v2.4.3.
  Without it the approval de-dupe state never persists across cloud runs, so a bullish-asset short
  that stays pending re-announces itself EVERY run. Tolerable at 3 runs/day; spam at the Railway
  cadence. The Railway runner pushes it too, so both runners keep the same queue.
- **The v2.5.0 suite's version assertions were made version-AGNOSTIC** (`>= 2.5.0` instead of an
  exact pin on A0/F12). That suite tests v2.5.0 BEHAVIOUR, which must survive every later release.
  **Convention from now on: the exact version pin lives in the NEWEST suite only** - otherwise
  every release has to edit every old suite, and an edited assertion is a weakened assertion.

#### TESTED - `tests/v2.6.0-queue-for-open.test.mjs`, 217 checks, 217 PASS

Plus `tests/v2.5.0-pnl-booking.test.mjs` re-run: **101/101 still green.** Sandboxed
(`SID/_v260_sandbox/`, removed on exit, asserted by Z1), NO network, NO broker calls.
Most of it drives the REAL exported functions against a REAL `AlpacaExecutor` wrapping a mock
client, so the actual sweep/cancel/wait/submit/poll code executes. The mock enforces the two
broker behaviours the design depends on: **client_order_id uniqueness** and **an open order HOLDS
the shares** (so a submit with orders still resting is rejected `insufficient qty available`).

Groups: V version+canon (14) | W the regression witness | A deterministic ids (10) | B the clock
gate + DST + the OPG dead zone (17) | C one-order-only queueing incl. the TP1 books-nothing-yet
guarantee (25) | D single-fire, local AND broker (8) | E rejected-submission fallback incl. the
PDT-safe no-stop case (10) | F weighted fill price (7) | G reconcile FILLED, full + partial (35) |
H still-pending x5 states | I dead x3 states + 404 + the 5xx-leave-alone case + the under-filled-full-exit guard + no-ops | J entries
still refuse (6) | K checkPositions wiring (11) | L runner shape/safety/merges/doc (36) |
M Ironclad segregation | N the multi-position ledger bug above (7).

**Runtime proof (`node --check` is not enough):** real ESM `import()` of `bot-sid.js` ->
`BOT_VERSION = v2.6.0` with every new + pre-existing export resolving; `node
railway-sid-runner.js --version` -> `SID Railway cron runner v2.6.0` and exit 0; importing the
runner is side-effect free. Env hard-fails exercised for real (missing vars -> exit 1 naming them;
`live` without `SID_LIVE_CONFIRMED` -> exit 1; invalid mode -> exit 1).

**WHAT I COULD NOT PROVE - be honest about this:**
- **There are ZERO open positions right now**, so the full queue -> overnight -> fill -> book
  cycle has NOT been exercised against the live broker. Everything about Alpaca's acceptance of an
  overnight OPG/day order is from the DOCS (quoted above), not from a submitted order.
- Groups C/D/E/G drive the real functions but against a MOCK broker. The mock's `insufficient qty`
  and uniqueness rules are modelled on observed live errors, not guaranteed identical.
- `checkPositions` and `run()` are not executed end-to-end (they need network candle data); their
  wiring is asserted by regex on the live source (group K).
- Railway cron behaviour is from Railway's docs; nothing has been deployed.
- **THE FIRST REAL CANARY:** deploy, then wait for the first position that ripens an exit out of
  hours. Success looks like: an `exit_queued_for_open` entry in `sid-log.json` + the Telegram
  "EXIT QUEUED FOR THE OPEN" message, then on the next morning's run a `pending_exit_filled` entry
  and a closed record carrying `exit_queued_for_open:true` with `pnl_source:'alpaca_fill'`. If
  nothing ripens naturally, the cheapest deliberate canary is a manual `sid.yml` dispatch AFTER
  the close while a position holds a ripe TP1 - watch for `QUEUE-FOR-OPEN` in the log instead of
  `Market closed - refusing to submit`.

#### SHIP-CHECK DONE (v2.6.0, RELEASE)

`BOT_VERSION` v2.6.0 + detailed history one-liner; new exports (`exitClientOrderId`, `exitTagFor`,
`marketIsOpen`, `shouldQueueExitForOpen`, `queueExitForOpen`, `reconcilePendingExits`,
`bookQueuedExitFill`, `PENDING_EXIT_DEAD_STATES`); `sid-dashboard.js` `STRATEGY_VERSION='2.6.0'` +
beta-banner / brand-sub / perf-note markers; `strategy-updates.json` new **RELEASE** entry at top
(count auto 29 -> **30**, derived from array length in both the tab badge and the panel title);
`SID-README.md` current-version line + a v2.6.0 history row above v2.5.0 + 4 Files-table rows;
root `CLAUDE.md` index row -> v2.6.0, Actions inventory, Live runtimes, commit-message glossary
(`SID railway run ...`) and the segregation table (Railway file ownership made explicit);
`.sid-update-manifest.txt` + `SID/railway-sid-runner.js`, `SID/railway-sid.json`,
`SID/RAILWAY-DEPLOY.md`, `SID/tests`; this append. `docs/sid/index.html` is BUILD OUTPUT -
regenerated to VERIFY (v2.6.0 markers + the `(30)` badge + the new entry) then **RESTORED to
HEAD**, because `sid-dashboard.yml` rebuilds it from cloud state. No Pine change (the visualiser is
signal-level and no signal rule moved).

#### QUEUED / NOT DONE

- **NOTHING COMMITTED OR PUSHED** - returned for Alan's review (per brief). If approved, push via
  the standard protocol (fetch -> pull --rebase --autostash -> push; never without approval).
- **Alan's actions:** deploy the Railway service per `SID/RAILWAY-DEPLOY.md` (new service, rename
  to `sid-bot`, **override the start command FIRST** or it runs Ironclad's loop, set the watch
  paths or every state push triggers a rebuild, set the variables, THEN set the Cron Schedule).
  Then verify from the logs and leave Phase 2 alone until it has proven itself.
- **Branch B carries the same latent double-count the v2.6.0 booking guards against.**
  `checkPositions` Branch B computes `totalPnl = pos.tp1_pnl + tp2Pnl` with NO
  `tp1LegAlreadyInClosedRecords` guard. If a TP1 was banked by the broker-OCO path (which writes a
  closed PARTIAL record AND stamps `tp1_pnl` on the live position) and the bot then fires TP2, the
  leg lands in both records. My new `bookQueuedExitFill` applies the guard (a no-op on the normal
  bot-banked path, so zero behaviour change there). **Branch B wants the same one-liner** - needs
  approval + its own regression witness. Candidate v2.6.1.
- The stop path still does not append to `trades-sid.csv` (carried from v2.5.0; the dashboard
  reads the JSON, so no displayed number is affected). Still a candidate v2.6.1.
- `sid-account.json` `reconciledAt` still says 2026-07-17 (belongs to `reconcile-account.js
  --write`, not run).
- Untracked cruft still in the worktree: `SID/strategy-updates.json.tmp.37284.*`,
  `SID/__pycache__/`, a dozen untracked `backtest-v2.1-validation-report-*.{json,csv}`, and
  `SID/scripts/*.py` one-offs. Not touched; worth a housekeeping sweep.

---

### CLOSE-WINDOW ENTRY EXECUTION + TWO ENTRY-SUPPRESSION FIXES (v2.6.1, 2026-10-24) - WORKING TREE, NOT COMMITTED

**Status: WORKING TREE ONLY - nothing committed or pushed (per brief). NO order was submitted,
cancelled or modified; every broker call was a read-only GET (`/v2/clock`, `/v2/calendar`).**
SID-owned files only, plus the root `CLAUDE.md` index. **NO canon rule change** - RSI 30/70,
RSI(3), MACD alignment (`macdRising` = MACD today > MACD yesterday), the weekly gates, the 45/55
no-go zones, the RSI-50 TP1 trigger, TP2 SMA50/200/BE/timeout, the 14-day earnings blackout, the
AUTO/HUMAN tiers, the 50% TP1 portion and `entry = close` are byte-for-byte unchanged. Asserted by
test group V (17 checks on the live source + CONFIG).

#### THE MEASURED MISS (three separate defects, all of which COST ENTRIES)

**1. The run never landed in-hours.** Over the 25 trading days to 2026-10-23, **SEVEN (28%) had
ZERO sid.yml runs inside market hours** - every run arrived after the 20:00 UTC close, where
`alpaca-executor` refuses every order. Verified independently from `gh run list --workflow=sid.yml`:
the zero-in-hours days are 09-28, 10-05, 10-07, 10-08, 10-12, 10-13, 10-19. **MCD is the named
case:** replaying the bot's OWN `detectEntrySignal` over MCD's real 5y bars returns
**LONG on the 2026-10-05 bar** (entry 233.04, stop 229, signalDate 2026-09-30) **and again on the
2026-10-08 bar** (entry 236.90, stop 230, signalDate 2026-10-07) - and on BOTH days every run landed
after the bell (05 Oct 21:34 / 22:53 / 00:17; 08 Oct 20:01 / 21:27 / 23:31 UTC).

**2. Even an in-hours run was judging an UNFINISHED bar.** `detectEntrySignal`'s trigger sets
`const ep = closes[i]` -> `entry: ep`, i.e. **the strategy is defined as entering at the signal
bar's CLOSE**. A mid-session scan therefore reads the entry price AND the RSI AND the MACD direction
off a day that has not finished. **Measured, from the live books:** three real entries taken 12-28
minutes before the bell booked a 'close' that was **0.48% (HD), 0.49% (HON), 0.03% (IYR)** away from
that day's OFFICIAL close (HD 312.35 vs 310.87; HON 204.44 vs 203.44; IYR 98.93 vs 98.90). On HD,
whose stop sat ~2.7% below entry, 0.48% is **~18% of the risk unit**.

**3. An EXIT consumed the day's ENTRY budget** - see FIX A below. This is the one that actually
blocked MCD on 8 Oct, and it had nothing to do with timing.

#### PART 1 - THE CLOSE WINDOW (in the RUNNER's timing, never in the strategy)

`SID/railway-sid-runner.js` only. Three named, env-overridable constants:

| Constant | Env | Default | What it is |
|---|---|---|---|
| `CLOSE_WINDOW_MIN` | `SID_CLOSE_WINDOW_MIN` | **20** | How close to the bell a cycle must START to be THE entry cycle. **0 = never scan entries** (documented switch). |
| `ENTRY_SUBMIT_OFFSET_MIN` | `SID_ENTRY_SUBMIT_OFFSET_MIN` | **3** | Minutes before the close at which the scan actually runs. |
| `MAX_ENTRY_WAIT_MIN` | `SID_MAX_ENTRY_WAIT_MIN` | **30** | Absolute ceiling on one wait. Belt-and-braces. |

`intEnv` preserves a legitimate **0** in both knobs (`parseInt(x) || def` would clobber it) - same
helper shape as `rearmCooldownLong`.

**Two new pure exported functions, both suite-driven:**
- **`etFields(ts)`** -> `{minutes, isoDate, offset}` or `null`. **Same discipline as
  `alpaca-executor.js#etMinutesOfDay`: the offset MUST be `-04:00` or `-05:00`.** Confirmed against
  the live clock - Alpaca stamps `timestamp` with nanoseconds AND an ET offset
  (`2026-10-24T16:02:45.164880518-04:00`) and `next_close` with neither fractional seconds nor UTC
  (`2026-10-26T16:00:00-04:00`). If Alpaca ever switches to `Z`, this returns null, the window
  becomes `clock_unreadable`, and we DON'T scan - rather than silently reading UTC digits as ET.
  NOT shared with the executor's method (that one is bound to a live `this.clock` and only reads
  `timestamp`); test Q7 pins the two together on the same input in both offsets so they can't drift.
- **`planEntryWindow(clock, opts)`** -> `{marketOpen, entryScan, waitMs, phase, ...}`. Phases:
  `closed` | `clock_unreadable` | `window_disabled` | `past_close` | `pre_window` | `wait_then_scan`
  | `scan_now`. **Derived entirely from `/v2/clock`'s `next_close` for the CURRENT session** - and it
  REFUSES if `next_close`'s ET date != `timestamp`'s ET date (defensive: `is_open` true with
  tomorrow's close is impossible for US equities, so don't compute a window from the wrong day).

**`resolveEntryWindow({readClock, sleep, log, opts})`** is the cycle's timing phase, with its
dependencies INJECTED so the suite executes the shipped control flow (group R) instead of a
re-implementation. Safety properties, all structural rather than hoped-for:
- the wait is clamped THREE ways: the window, `MAX_ENTRY_WAIT_MIN`, and **`minutesToClose - 1`** - so
  it **always wakes at least a minute before the bell even if the offset is 0**;
- the clock is **RE-READ on waking**; market closed / halted / early close moved / clock unreadable /
  clock unavailable -> `Entry scan ABANDONED`, never fired into a shut market (tests R6-R10);
- it sleeps **AT MOST ONCE**; a backwards-moving broker clock scans immediately (R11).

**CYCLE ORDER CHANGED, deliberately: clock+wait FIRST, state pull SECOND.** v2.6.0 pulled state
then read the clock. A cycle that pulls and then sleeps 17 minutes runs the bot against state up to
17 minutes stale, which a concurrent GHA run could have moved. Asserted by R16.

**The sleep is `import { setTimeout as sleepMs } from 'node:timers/promises'`** - not the global
timer, and one awaited call, so the v2.6.0 L1 one-shot assertion still holds BY PREDICATE. I
**clarified L1's LABEL** (predicate byte-identical) rather than leave it claiming something the
bounded wait makes untrue; the wait's bounds are asserted positively in the v2.6.1 suite.

#### WHAT HAPPENS TO THE CRON TICK DURING THE WAIT (the question to have an answer for)

**Railway SKIPS it** - "if a previous execution is still running when the next scheduled execution
is due, Railway will skip the new cron job." On `*/15` with a 20m window the wait spans at most ONE
tick. That is harmless, and is the overlap guard working:
- the skipped tick would have been an EXIT cycle, and the waiting cycle does exit management itself
  when it wakes - still in-hours, just later;
- SID's exits are DAILY-BAR triggers (RSI 50, SMA50/200 touch), so reading them at T-3 is **more**
  faithful than at T-18;
- intraday protection never depended on the bot running: the stop is a resting GTC order at the
  broker throughout the wait;
- anything still ripe after the bell is queued for the next open by the first post-close tick (v2.6.0).
It also means the window can never produce TWO entry scans in one session.

#### CRON EXPRESSION: **NO CHANGE NEEDED** (proven, not asserted)

`*/15 13-23 * * 1-5` lands exactly one in-window tick in every regime. Test group S enumerates all
44 ticks and runs `planEntryWindow` on each:

| Session | Close ET | Close UTC | Window UTC | Tick |
|---|---|---|---|---|
| EDT normal | 16:00 | 20:00 | 19:40-20:00 | **19:45** |
| EST normal | 16:00 | 21:00 | 20:40-21:00 | **20:45** |
| EDT early close | 13:00 | 17:00 | 16:40-17:00 | 16:45 |
| EST early close (**2026-11-27**, confirmed `close: 13:00` in `/v2/calendar`) | 13:00 | 18:00 | 17:40-18:00 | **17:45** |

**The structural reason:** a half-open window of >= 15 minutes always contains a quarter-hour mark,
whatever the close time. **THE RULE TO RESPECT: `SID_CLOSE_WINDOW_MIN` must be >= the cron
interval.** At exactly 15 there is zero margin and Railway's "vary by a few minutes" could push the
tick past the submit point; 20 gives 5 minutes of slack. **Documented upgrade: 35** makes the window
span TWO ticks - the first claims the slot and Railway skips the second, so you still get exactly one
scan at T-3 but a skipped/dead first tick is covered.

**Cost:** ~12 min of wait per trading day ~= 250 container-minutes/month at 60-80 MB ~= **under 1p
a month** on Railway's published $10/GB-month memory rate, and a sleeping process uses ~no vCPU.
(The v2.6.0 caveat stands: "cron bills no idle time" is inferred from doc intent - check the bill.)

#### PART 2 - FIX A: AN EXIT WAS EATING THE DAY'S ENTRY BUDGET (a real live bug)

`countTodayTrades()` filtered `trades-sid.csv` on `l.startsWith(today)` - **every row dated today,
EXITS INCLUDED** - and fed the `maxPerDay` gate, whose default was **1**. So one close consumed the
whole day's entry allowance and `run()` returned before the scan.

**PROVEN LIVE on 2026-10-08, GHA run `37836390871`:** the run booked HON's stop-out at **20:02:09**
and at **20:02:10** printed `Daily entry limit reached (1) - no new entries today` and returned -
blocked by the row it had itself just written one second earlier. **All three** of that day's runs
printed it (20:02, 21:27, 23:31), so MCD's LONG was never evaluated. **17 trading days in the
committed CSV carry an exit row with NO entry row** (06-01, 06-11, 06-24, 06-25, 07-01, 07-02,
07-15, 07-22, 07-23, 08-10, 09-01, 09-02, 09-04, 09-08, 09-10, 10-01, 10-08) - every subsequent run
on each was blocked identically.

**FIX: `countTodayEntries()` counts ENTRY rows only, via a POSITIVE test on the `Side` column**
(exactly `long` or `short`), deliberately NOT a blacklist of exit suffixes - so a future exit kind
cannot silently re-break the gate. **Verified by enumerating EVERY `appendTrade` call site in the
repo** (do this again if you ever touch the CSV schema):

| Call site | Side written | Kind |
|---|---|---|
| `bot-sid.js` scan entry | `signal.signal` -> `long`/`short` | **ENTRY** |
| `approve-trade.js` | `side` -> `long`/`short` | **ENTRY** |
| `recordExternalClose` | `${side}-extclose` | exit |
| `bookQueuedExitFill` (TP1) | `${side}-tp1` | exit |
| `bookQueuedExitFill` (full) | `${side}-tp2` / `${side}-exit` | exit |
| `checkPositions` Branch A | `${side}-tp1` | exit |
| `checkPositions` Branch B | `${side}-tp2` | exit |
| `manual-close.js` | `${side}-manualclose` | exit |

and against the committed CSV's distinct values (`long`, `short`, `long-tp1`, `short-tp1`,
`long-tp2`, `short-tp2`, `long-extclose`, `short-extclose`). The old name is gone from the file, so
no caller is left on the broken counter (test T11).

#### PART 3 - FIX B: THE ONLY POSITION LIMIT IS 5 CONCURRENT. THERE IS DELIBERATELY NO DAILY CAP.

**WRITE THIS DOWN SO A FUTURE SESSION DOESN'T "FIX" IT BACK.** Alan's rule, verbatim:
**"max 5 concurrent trades at any one time. This rule does not affect how many trades can be opened
the same day."**

- `CONFIG.maxPerDay` now defaults to **0 = UNLIMITED** (unset / 0 / negative). It is an OPTIONAL
  manual throttle; `SID_MAX_PER_DAY` still overrides, because `sid.yml:62` and `RAILWAY-DEPLOY.md`
  pass it through. An unset value can never block an entry.
- `CONFIG.maxOpenPositions` stays **5**, untouched, and is now the SINGLE gate. New pure exported
  `entryBudgetFor({openCount, maxOpenPositions, maxPerDay, entriesToday})` returns the budget =
  `min(dayAllowance, freeSlots)`, and the entry loop breaks on THAT, never on the raw `maxPerDay`.
- **WHY THE CLAMP IS NOT OPTIONAL:** the pre-v2.6.1 loop broke on `CONFIG.maxPerDay` directly. That
  was only safe because the default was **1** (Step 1 guarantees room for one). Any larger value -
  including the 5 an intermediate brief asked for - would have let a single run with 3 positions open
  reach **8 concurrent** and blow straight through the cap. Invariant U11 brute-forces
  `budget + openCount <= maxOpenPositions` over every combination.
- Because free slots are recomputed every run, **a day on which positions CLOSE allows further
  entries that same day** (test U5).

**LIVE DELIBERATELY DIVERGES FROM THE BACKTEST, AND THIS IS THE DOCUMENTATION OF WHY.** The
validated **280 trades / 73.9% WR / PF 3.19 / +$31,426** run (`backtest-sid-bot-parity.py`, tier1,
5y, $200 fixed risk) has **NO per-day cap and NO concurrent cap** - it takes every signal. Both live
limits are **RISK OVERLAYS**:
- **5 concurrent is Alan's deliberate choice**, and the reason is exposure, not expectancy: it bounds
  the account to **five simultaneous stop-losses if a global event moves everything at once**. KEEP IT.
- **The old 1/day default was an undocumented EXTRA divergence** on top of that, never part of the
  tested strategy. Removing it moves live CLOSER to the validated behaviour, not further away.

#### OTHER FIX IN THIS RELEASE

- **A dry-push cycle used to log `pushed=N` for files it never sent.** `pushState` now counts them as
  `skipped` with a separate `dry` tally, and the cycle summary reads
  `pushed=0 skipped=N (dry push: M would have been written)`. Cosmetic, but a runner that reports
  work it didn't do is exactly how a bad deploy looks healthy.

#### TESTED - `tests/v2.6.1-close-window.test.mjs`, 167 checks, 167 PASS

Plus **`tests/v2.5.0-pnl-booking.test.mjs` 101/101** and **`tests/v2.6.0-queue-for-open.test.mjs`
217/217** still green. **485 checks total.** Sandboxed (`SID/_v261_sandbox/`, removed on exit,
asserted by Z1), **NO network, NO broker calls, NO real waiting.**

Groups: **V** version + canon (17) | **W** the MCD regression witness (16) | **Q** `etFields` + DST +
the executor-agreement pin (8) | **P** `planEntryWindow` across both regimes, edges, caps, overrides,
the real early close (23) | **R** the SHIPPED `resolveEntryWindow` driven with an injected clock and
a fake sleep, incl. all five abort paths (17) | **S** the cron-expression proof (6) | **T** FIX A incl.
the witness (11) | **U** FIX B incl. the runtime env probe (17) | **X** exits provably untouched (11) |
**L** runner shape/safety/docs (20) | **D** the ship-check asserted (14) | **M** segregation (4).

**THE FIXTURE IS CHECKED IN** - `tests/fixtures/mcd-daily-to-2026-10-08.csv` (1244 real MCD daily
bars, 2021-10-25 -> 2026-10-08, `date,high,low,close`) + a provenance README. **5 years is
deliberate:** the live scan fetches `'5y'` because the v2.3 weekly SMA50/200 arm gate needs >= 200
weekly buckets; a 2y fixture would silently DISABLE that gate and make the replay looser than the
live bot.

**REGRESSION WITNESSES (the point of the suite):**
- **W7-W10:** the three REAL 8-Oct run times are fed in as the clock; `planEntryWindow` returns
  `closed / entryScan:false / waitMs:0` for all three, and the PRE-v2.6.1 gate (`clock.open === true`)
  is false on all three too - so the old runner performed **no in-session entry scan that day**. Then
  W11-W13 show the in-window tick waiting 12m to 15:57 ET and the SAME bars still yielding the LONG.
- **T1/T2:** the pre-fix counter is re-implemented verbatim and run on the real 8-Oct CSV state -
  it returns **1**, i.e. exactly the number that blocked the run - before T3 proves the new counter
  returns **0**. T6 shows the old counter saying **10** on a 10-row day the new one scores **2**.

**Runtime proof (`node --check` is not enough):** real ESM `import()` of `bot-sid.js` ->
`BOT_VERSION = v2.6.1` with every new + pre-existing export resolving; `node
railway-sid-runner.js --version` -> `SID Railway cron runner v2.6.1`, exit 0; importing the runner is
side-effect free. `SID_MAX_PER_DAY` plumbing probed in CHILD PROCESSES (unset -> 0, `3` -> 3, `0` ->
0) because ESM caches the module and an in-process re-import cannot re-read env.

**WHAT I COULD NOT PROVE - be honest about this:**
- **Nothing is deployed and no cycle has actually waited.** The whole timing path is proven against
  mocked clocks and a fake sleep; `resolveEntryWindow` has never run on Railway.
- **`run()` and `checkPositions` are still not executed end-to-end** (they need network candle data
  and a live executor). FIX A/B wiring inside `run()` is asserted by regex on the live source (U12-U14),
  exactly as v2.6.0's group K did. `entryBudgetFor` and `countTodayEntries` ARE driven for real.
- **MCD WOULD STILL NOT HAVE BEEN ENTERED on 5 or 8 Oct, and v2.6.1 does not change that.** Both days
  sat inside the **14-day PPI blackout** (next PPI 2026-10-15, i.e. 10 and 7 days away). `isWithinPPIWindow`
  reads `new Date()` so it cannot be driven historically - tests W14-W16 re-implement its arithmetic
  against the committed `event-dates.json` and are LABELLED as a re-implementation. Worth knowing:
  **46.2% of 2026 weekdays to date are PPI-blocked** (98 of 212), because PPI is monthly and the
  window is pre-only 14 days. So the MCD miss had THREE independent causes and this release fixes
  two of them. **The `entry = close` argument and the 28%-of-days-unreachable finding stand on their
  own and are what justify the change.**
- Whether Yahoo's `interval=1d` bar updates intraday was NOT re-verified this session (it was a
  weekend). It is inferred - strongly - from the live books: three entries recorded 12-28 minutes
  before the bell carry prices that differ from the official close, which can only happen if the
  last bar is live. If that ever changed, the close window would be judging the PREVIOUS day's bar,
  which would be a silent and serious regression. **First-canary check: compare the entry price a
  close-window cycle records against that day's official close.**
- The Phase-1 asymmetry is real: **the close-window discipline lives in the RUNNER, so a GitHub
  Actions run still scans mid-session on an unfinished bar.** Deliberate (Actions is the fallback),
  documented in `RAILWAY-DEPLOY.md`, and one more reason to get to Phase 2.

#### SHIP-CHECK DONE (v2.6.1, RELEASE)

`BOT_VERSION` v2.6.1 + detailed history one-liner; new exports (`countTodayEntries`,
`entryBudgetFor`) and new runner exports (`etFields`, `planEntryWindow`, `resolveEntryWindow`,
`CLOSE_WINDOW_MIN`, `ENTRY_SUBMIT_OFFSET_MIN`, `MAX_ENTRY_WAIT_MIN`); `sid-dashboard.js`
`STRATEGY_VERSION='2.6.1'` + beta-banner / brand-sub / perf-note markers; `strategy-updates.json`
new **RELEASE** entry at top (count auto 30 -> **31**, derived from array length in both the tab
badge and the panel title); `SID-README.md` current-version line (with v2.6.0 folded into a
`<details>` block so the header stays readable) + a v2.6.1 history row above v2.6.0 + the
"Max open trades" row + 3 Files-table rows; `RAILWAY-DEPLOY.md` -> v2.6.1 with a new
**§ 5a The close window** section, the three new variables, the cron-expression verdict, the
skipped-tick explanation, the cost note, 4 new rollback rows and 2 new Phase-2 go/no-go criteria;
root `CLAUDE.md` index row -> v2.6.1; this append (plus the two STALE-STATUS corrections above).
`docs/sid/index.html` is BUILD OUTPUT - regenerated to VERIFY (v2.6.1 markers x8 + the `(31)` badge
+ the new entry) then **RESTORED to HEAD**, because `sid-dashboard.yml` rebuilds it from cloud state.
No Pine change (the visualiser is signal-level and no signal rule moved).

#### QUEUED / NOT DONE

- **NOTHING COMMITTED OR PUSHED** - returned for Alan's review (per brief). If approved, push via the
  standard protocol (fetch -> pull --rebase --autostash -> push; never without approval).
- **⚠ ALAN'S ACTION, REQUIRED FOR FIX B TO TAKE EFFECT IN THE CLOUD: if the `SID_MAX_PER_DAY`
  GitHub secret (or Railway variable) is SET - e.g. to `1` - DELETE it.** An explicitly set value
  still wins over the new unlimited default, so the old throttle would survive the release. I cannot
  read secret values to check.
- **Alan's other action:** set `SID_CLOSE_WINDOW_MIN` / `SID_ENTRY_SUBMIT_OFFSET_MIN` only if he wants
  something other than 20 / 3. The cron expression needs NO change.
- **Branch B's latent double-count is STILL not fixed** (carried from v2.6.0): `checkPositions`
  Branch B computes `totalPnl = pos.tp1_pnl + tp2Pnl` with no `tp1LegAlreadyInClosedRecords` guard.
  Needs approval + its own witness. Candidate v2.6.2.
- **The stop path still does not append to `trades-sid.csv`** (carried from v2.5.0). Note this now
  interacts with FIX A: a missing exit row can only make the entry counter LOWER, so it cannot block
  an entry - but it does mean the CSV is not a complete journal. Candidate v2.6.2.
- `sid-account.json` `reconciledAt` still says 2026-07-17 (belongs to `reconcile-account.js --write`).
- Untracked cruft still in the worktree: `SID/strategy-updates.json.tmp.37284.*`, `SID/__pycache__/`,
  a dozen untracked `backtest-v2.1-validation-report-*.{json,csv}`, `SID/scripts/*.py` one-offs,
  `docs/sid-scanner-preview.html`. Not touched; worth a housekeeping sweep.
---

## See also

- Root project hub → [`../CLAUDE.md`](../CLAUDE.md)
- Ironclad context → [`../IRONCLAD-MEMORY.md`](../IRONCLAD-MEMORY.md)
- VWAP context → [`../VWAP-MEMORY.md`](../VWAP-MEMORY.md)
- Strategy vault → [`strategy-test-vault/README.md`](strategy-test-vault/README.md)
- Excel report → [`strategy-test-vault/v2.1-default-30d-timeout/SID V2.1 Method Back Testing.xlsx`](strategy-test-vault/v2.1-default-30d-timeout/)
