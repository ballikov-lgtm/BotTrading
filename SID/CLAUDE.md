# SID Strategy — Project Context

This folder contains everything for the **SID Swing Strategy** bot.
It is kept entirely separate from the Ironclad strategy (which lives in the parent `Trading Setup/` folder).

---

## ⚠️ CRITICAL: Where the live code actually lives

There are TWO `SID/` folders on disk and they are NOT the same:

| Path | What it is | git branch | Use? |
|---|---|---|---|
| `Trading Setup/SID/` (parent) | **Stale snapshot** — older v1.0 code | `claude/silly-robinson-abcf6c` | ❌ **DO NOT EDIT.** Anything here is out of date. |
| `Trading Setup/SID/.claude/worktrees/silly-robinson-abcf6c/SID/` (worktree) | **LIVE main branch** — current v2.2.5 deployment | `main` | ✅ **All bot work goes here.** This is what GitHub Actions deploys. |

**Verification:** `git worktree list` from the repo root shows the worktree at the path above is on `main`. The deployed bot version (currently **v2.2.5** — TP1 cancel-first / held-shares fix + dashboard exit-target readout; entry is the v2.2.3 bar-by-bar arm replay, exits the v2.2.1 HYBRID model with the v2.2.5 broker-order fix) is in the worktree's `bot-sid.js`. The v2.2.3 ENTRY is validated at **73.9% WR / PF 3.19 / +$31,426** (tier1, 5y, $200 fixed risk) per `backtest-sid-bot-parity.py` (see `strategy-test-vault/bot-parity-experiment/`). *Historical provenance (do not treat as current-version markers):* entry rules were originally validated at **70.4% WR on the AUTO tier** per the Excel report at `~/Downloads/SID V2 Method Back Testing (tiered + filter subtotals)(1).xlsx`; the V2.1 exits were validated at **77.6% WR / PF 3.62** in `backtest-sid-v2.1.py`.

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

---

## See also

- Root project hub → [`../CLAUDE.md`](../CLAUDE.md)
- Ironclad context → [`../IRONCLAD-MEMORY.md`](../IRONCLAD-MEMORY.md)
- VWAP context → [`../VWAP-MEMORY.md`](../VWAP-MEMORY.md)
- Strategy vault → [`strategy-test-vault/README.md`](strategy-test-vault/README.md)
- Excel report → [`strategy-test-vault/v2.1-default-30d-timeout/SID V2.1 Method Back Testing.xlsx`](strategy-test-vault/v2.1-default-30d-timeout/)
