# Ironclad Strategy — Agent Memory

This file is the **deep context** for the Ironclad multi-timeframe swing bot. Loaded by the root [`CLAUDE.md`](CLAUDE.md) routing guide whenever the user mentions Ironclad, Railway, BitGet, futures, or any of the Ironclad-prefixed files.

**Human-facing companion:** [`IRONCLAD-README.md`](IRONCLAD-README.md) — full strategy explanation, BitGet setup walkthrough, parameter rationale. Read that if the user needs strategy theory; this file is what to know before touching the code.

---

## What Ironclad is

A multi-timeframe trend-following swing bot. Uses **daily chart** to identify trend direction, then **15-minute chart** to find pullback-and-break entries. Trades crypto + stocks + commodities on BitGet futures with 3× leverage.

- **Source:** https://youtu.be/s9HV_jyeUDk?t=535
- **Backtest:** 72.17% WR, 957% return, 1175 trades, ~50% max DD (spot, no leverage)
- **Live status:** Running on Railway (continuous 15-min loop)
- **Account:** BitGet futures, 3× leverage

---

## Files Ironclad owns (segregation rules)

When working on Ironclad, **only touch these**:

### Code
- `bot-ironclad.js` — main bot
- `bot-hype-manager.js` — hype-mode position-size adjustments
- `audit.js` — pre-flight strategy audit
- `monitor.js` — runtime monitoring
- `railway-runner.js` — Railway continuous-loop driver
- `fix-estimated-positions.js`, `fix-missing-closed.js`, `fix-tp-orders.js` — ad-hoc fixers (use with extreme caution)
- `reconcile-closed-positions.py` — Python reconciler against Bitget export

### Config
- `rules-ironclad.json` — strategy parameters (RSI thresholds, ATR multipliers, etc.)

### State (auto-managed by bot — never hand-edit unless reconciling)
- `open-positions-ironclad.json` — currently open positions
- `closed-positions-ironclad.json` — historical closed positions
- `cooldown-ironclad.json` — per-symbol cooldown timers
- `hype-state.json` — hype-mode state
- `ironclad-log.json` — safety log
- `trades-ironclad.csv` — trade log

### Workflows
- `.github/workflows/ironclad.yml` — manual-only GitHub Actions backup (Cloudflare blocks GH IPs from BitGet)
- `.github/workflows/research.yml` — twice-daily research + Ironclad dashboard build

### Outputs Ironclad publishes to (additive-only — never modify SID's parts)
- `docs/index.html` — Ironclad research dashboard (built by `research.yml`)
- `research-signals.json` — research output
- `closed-positions-vwap.json` — closed positions from the VWAP scalper (research.js aggregates both)

---

## Where Ironclad runs

**Primary: Railway** (continuous 15-minute loop). `railway-runner.js` is the driver:
1. Pulls state files from the `logs` git branch
2. Pulls config files (`rules-ironclad.json`, `research-signals.json`) from `main`
3. Runs `bot-ironclad.js`
4. Pushes updated state back to the `logs` branch

Railway watches `main` for code redeploys. State pushes go to `logs` only, so they never trigger a redeploy loop.

**Backup: GitHub Actions** (`ironclad.yml`) — `workflow_dispatch` only. This is intentional — Cloudflare blocks GitHub Actions IP ranges from reaching BitGet's API. **Do not "fix" the manual-only trigger.**

**Reminder:** the `ironclad.yml` workflow uses Node.js 20 (`actions/setup-node@v4`) and reads `BITGET_API_KEY`, `BITGET_SECRET_KEY`, `BITGET_PASSPHRASE` from GitHub Secrets.

---

## State file ownership

Ironclad state files live at the **repo root**, NOT in any subfolder. The flat layout pre-dates the SID restructure.

| File | Owner | Auto-committed by |
|---|---|---|
| `open-positions-ironclad.json` | bot-ironclad.js | railway-runner.js → `logs` branch |
| `closed-positions-ironclad.json` | bot-ironclad.js | railway-runner.js → `logs` branch |
| `trades-ironclad.csv` | bot-ironclad.js | railway-runner.js → `logs` branch |
| `cooldown-ironclad.json` | bot-ironclad.js | railway-runner.js → `logs` branch |
| `hype-state.json` | bot-hype-manager.js | railway-runner.js → `logs` branch |
| `ironclad-log.json` | bot-ironclad.js | railway-runner.js → `logs` branch |

The **GitHub Actions `ironclad.yml`** workflow (manual backup) commits to `main` directly when run.

---

## Common gotchas

### Cloudflare blocks GitHub Actions ranges from BitGet
That's why Railway hosts Ironclad. If you ever switch this back to GitHub Actions, expect 403/Cloudflare-challenge errors on every API call. The README notes "BitGet IP allowlist" as the workaround — fully whitelist Railway's IP and the GitHub-Actions IP ranges if both are needed.

### Logs branch separation
Railway state pushes go to `logs`, never `main`. If you see Railway pushing to `main`, that's a bug — fix it before it triggers a redeploy loop. Conversely, manual GitHub Actions runs of `ironclad.yml` push state to `main` (legacy behaviour) — this can confuse the next Railway run if its `logs` state is stale.

### Position-mode trap on BitGet
The bot expects **one-way position mode** on BitGet (not hedge mode). If the BitGet account is in hedge mode, the bot will get `Trade not allowed` or `Position direction mismatch` errors. See `IRONCLAD-README.md` § "Set BitGet to one-way position mode".

### 3× leverage assumption
Default config is `LEVERAGE=3`. Changing leverage requires updating both:
- `rules-ironclad.json` (strategy expects 3× position sizing math)
- BitGet account settings (per-symbol leverage)

Backtest at 1× spot showed ~50% max DD; at 3× futures the DD ceiling roughly triples — see the human README's risk warning.

### Pending Bitget reconcile (non-urgent)
The user has 10 trades from 8-9 May missing from `closed-positions-ironclad.json` due to an earlier sync gap. When the user is ready, they'll do a fresh Bitget XLS export from 7 May and run `reconcile-closed-positions.py`. See `~/.claude/projects/.../memory/project_pending_bitget_reconcile.md` for details.

### Bot logs branch must exist before first deploy
If `logs` branch doesn't exist, `railway-runner.js` will fail on the initial pull. Create it from `main` and push it: `git checkout -b logs && git push origin logs`.

---

## Research workflow (cross-cutting)

`research.yml` runs twice daily (08:00 / 17:00 UTC) and:
1. Pulls Ironclad's `closed-positions-ironclad.json` from `logs` branch (the bot's authoritative trade history)
2. Runs `research.js` which scans assets and writes `research-signals.json`
3. Rebuilds `docs/index.html` (the Ironclad research dashboard)
4. Commits with message `Dashboard update YYYY-MM-DD HH:MM UTC`

**This is the "mystery dashboard update" commit** that confused us on 2026-05-18 while we were debugging the SID dashboard — `research.yml`'s commits looked like SID dashboard commits at a glance because the SID one says "SID dashboard update …" while the Ironclad one just says "Dashboard update …".

---

## Configuration

### Environment variables (Railway / `.env`)
- `BITGET_API_KEY`, `BITGET_SECRET_KEY`, `BITGET_PASSPHRASE` — credentials
- `MODE` (default `futures`) — `spot` or `futures`
- `LEVERAGE` (default `3`)
- `PORTFOLIO_USD` (default `1000`) — total portfolio sizing
- `GITHUB_TOKEN` — for railway-runner.js to push state to `logs` branch

### Strategy config (`rules-ironclad.json`)
Hand-tunable parameters. Changes here trigger a Railway redeploy on next `main` push.

---

## Live data flow

```
Railway (every 15 min)
  ├── pull state from logs branch
  ├── pull rules-ironclad.json from main
  ├── pull research-signals.json from main
  ├── run bot-ironclad.js
  │     ├── fetch BitGet candles + positions
  │     ├── detect entry/exit signals
  │     ├── submit orders to BitGet
  │     └── update state files
  └── push state to logs branch
                ↑
                │
   research.yml writes here twice daily
   (research-signals.json + docs/index.html)
```

---

## When something goes wrong on Ironclad

1. **Check Railway dashboard** — most current run state, logs
2. **Check the `logs` branch on GitHub** — what state file the bot last wrote
3. **Check `ironclad-log.json` in `logs` branch** — recent errors
4. **Check `closed-positions-ironclad.json` in `logs` branch** — most recent fills
5. **Cross-reference against BitGet directly** — the bot may be stale or out of sync
6. **Never `git push origin main` Ironclad-touching changes** without explicit user sign-off — Railway redeploys instantly and a broken bot can fire wrong-direction orders

---

## Things explicitly NOT to do from a SID session

- ❌ Edit any file in this memory's "Files Ironclad owns" list
- ❌ Modify `.github/workflows/ironclad.yml` or `research.yml`
- ❌ Touch `docs/index.html` (Ironclad's research dashboard)
- ❌ Push to `logs` branch
- ❌ Change BitGet credentials or `rules-ironclad.json`
- ❌ "Fix" Ironclad's `workflow_dispatch`-only trigger (it's intentional — Cloudflare)

---

## Pending tasks (not session-blocking)

- Reconcile 10 missing trades from 8-9 May (waiting on user XLS export from 7 May)
- (Future) Migrate Ironclad off Railway if Cloudflare IP block is lifted

---

## Cross-references

- Human walkthrough → `IRONCLAD-README.md`
- Root project hub → [`CLAUDE.md`](CLAUDE.md)
- Pending Bitget reconcile detail → `~/.claude/projects/.../memory/project_pending_bitget_reconcile.md`
