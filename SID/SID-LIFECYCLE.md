# SID Trading Lifecycle — Paper → Live → Compounding

Captured here so the transition from dry-run → paper → live → compounding
doesn't lose any data and the dashboard can show the full history.

---

## Trading modes

The bot operates in one of three modes (controlled by `SID_TRADING_MODE`):

| Mode | Alpaca | Money | Files written |
|---|---|---|---|
| `dry_run` (default) | No calls | None | All local trade logs only |
| `paper` | Yes (paper account) | Simulated | Local logs **+** Alpaca paper positions |
| `live` | Yes (live account) | **Real cash** | Local logs **+** Alpaca live positions |

In all three modes, the same local files track the SID strategy state:

| File | Purpose |
|---|---|
| `closed-positions-sid.json` | Every closed trade with realised P&L |
| `open-positions-sid.json` | Currently held positions |
| `sid-account.json` | Compounding ledger (starting balance, current equity, growth) |
| `trades-sid.csv` | Human-readable CSV of all trades |
| `sid-log.json` | Per-run safety log + filter rejections |

Each trade record also carries a `mode` tag (`dry_run` / `paper` / `live`)
so the dashboard can filter / colour-code by mode.

---

## The lifecycle

### Phase 1 — Dry run (current, May 2026)

- Bot logs signals + simulated trades locally.
- No Alpaca calls. No real money.
- All trades tagged `mode: "dry_run"`.
- Purpose: validate the bot is running end-to-end on GitHub Actions,
  CI is stable, logs commit successfully back to the repo.

### Phase 2 — Paper trading (user transitions when Alpaca account is funded)

- Set `SID_TRADING_MODE=paper` + Alpaca paper API keys as repo secrets.
- Bot still trades the SID rules, but orders go through Alpaca's paper
  account (simulated fills, simulated cash, no real money moves).
- All trades tagged `mode: "paper"`.
- **Target duration:** 30+ days, ≥10 closed trades, ≥60% paper WR
  before considering Phase 3. (Per `SID-ALPACA-SETUP.md` checklist.)

### Phase 3 — Live trading (after paper validation)

The transition steps, in order:

1. **Archive the paper data** so it isn't lost when we reset for live:
   ```bash
   cd SID
   node scripts/archive-and-reset.js \
     --confirm \
     --starting-balance=10000 \
     --label="paper-trading"
   ```
   This copies everything under `SID/archive/{date}_paper-trading/` and
   resets the live tracking files to a clean $10K starting balance.

2. **Update GitHub secrets** for live mode:
   - `ALPACA_KEY_ID`, `ALPACA_SECRET_KEY` → swap to live-account keys
   - `ALPACA_BASE_URL` → `https://api.alpaca.markets` (not paper-api)
   - `SID_TRADING_MODE` → `live`
   - `SID_LIVE_CONFIRMED` → `YES_I_REALLY_MEAN_IT` (the safety token)

3. **Fund the live Alpaca account** with the chosen starting capital
   (£10K → $13K equivalent or whatever amount).

4. **Watch the first live run carefully.** Open Alpaca live dashboard
   and GitHub Actions log side by side. Verify the first order lands
   correctly. Stop the workflow at the first hint of anything weird.

### Phase 4 — Scaling (after 3 months of stable live trading)

User has indicated they'll increase from $10K → $20K starting balance
after 3 months of successful live trading.

When that time comes:

1. (Optional) Archive again so the "first $10K stage" stays preserved:
   ```bash
   node scripts/archive-and-reset.js \
     --confirm \
     --starting-balance=20000 \
     --label="live-10k-stage"
   ```
   This creates a clean break in the equity curve so the dashboard can
   show *"Phase 1: $10K → $X, then Phase 2: $20K → ..."*.

2. OR — keep compounding without an archive. The `sid-account.json`
   ledger handles compounding automatically (each trade's P&L updates
   `accountUsd`). You'd just add the extra $10K to the Alpaca account
   directly; the bot would size against the larger equity from the next
   run onward.

User preference TBD — both options preserve history.

### Phase 5 — Six figures (~7 years at 25% annualised, or ~7 at 40%)

No special tooling needed. Bot scales automatically.

---

## Dashboard support for historical archive

**Not yet implemented.** When the dashboard generator (`sid-dashboard.js`)
is updated to support archives, it would:

1. Scan `SID/archive/` for any `{date}_{label}/` subfolders
2. Read each `metadata.json` to know what era it represents
3. Render an "Archive" tab showing:
   - Each archived phase as a card (paper-trading, live-10k-stage, etc)
   - Total trades, total P&L, win rate per phase
   - Phase equity curve mini-chart
   - "Open archive" link to expand and see individual trades
4. **Live phase stays in its current section** — archive is read-only

This is on the future-work list. Build when first archive happens
(after Phase 2 → Phase 3 transition).

---

## Why we archive instead of just labelling by mode

Two reasons:

1. **Clean slate for compounding maths.** `sid-account.json` tracks the
   compounding ledger from `startingUsd`. If paper trades are mixed
   with live, the starting balance and growth percentage become
   meaningless. Archiving keeps each phase's compounding numbers
   intact.

2. **Clear narrative.** Easy to point at the archive and say *"this is
   what paper trading looked like before we went live."* Mixed history
   buries that story.

The mode-tag on individual trade records is still useful for quick
in-phase filtering — it just doesn't replace the need for full
phase-by-phase archives.

---

## Safety checks built into the script

`archive-and-reset.js` won't run unless you provide ALL of:

- `--confirm` (acknowledge the reset)
- `--starting-balance=<usd>` (must be positive)
- `--label=<text>` (alphanumeric only, used in folder name)

`--dry-run` shows what would happen without modifying anything. Always
worth using before the real run.

The script COPIES files to archive (doesn't move) and only resets the
originals after the copies succeed. If something fails mid-archive,
nothing is lost.
