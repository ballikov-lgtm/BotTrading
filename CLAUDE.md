# Trading Setup — Project Hub

This file is the **entry point for every Claude session in this repo**. It lists every strategy, where their deep context lives, and the hard rules that keep them from breaking each other.

When the user mentions any strategy, dashboard, bot, or live trade — **check the relevant strategy memory file before answering**. Don't infer from filenames.

---

## Strategies in this repo

| Strategy | Bot file | Style | Assets | Exchange | Runs on | Deep context |
|----------|----------|-------|--------|----------|---------|---------------|
| **SID** | `SID/bot-sid.js` | Daily swing | US stocks & ETFs | Alpaca (paper) | GitHub Actions (`sid.yml`) | [`SID/CLAUDE.md`](SID/CLAUDE.md) |
| **Ironclad** | `bot-ironclad.js` | Multi-timeframe swing | Crypto + stocks + commodities | BitGet (3× futures) | Railway via `railway-runner.js` | [`IRONCLAD-MEMORY.md`](IRONCLAD-MEMORY.md) |
| **VWAP Scalper** | `bot.js` | Intraday scalp | Crypto | BitGet | GitHub Actions (`trade.yml`) | [`VWAP-MEMORY.md`](VWAP-MEMORY.md) |

**Outside this repo (do not modify from this session):**
- The user has referenced a separate crypto strategy that lives outside this codebase. If they mention it, ask where it lives — don't guess.

---

## Hard segregation rules — what each strategy owns

This is the boundary. **Anything in column 1 may NOT be touched when working on strategies in column 2.** Workflows enforce these (each `git add` is by exact filename), and the per-strategy CLAUDE/MEMORY files reiterate them.

| Strategy | Files it owns | Folders it owns |
|----------|---------------|------------------|
| SID | `SID/*` (all files in the SID folder), `docs/sid/index.html`, `.github/workflows/sid.yml`, `.github/workflows/sid-dashboard.yml`, `SID/requirements.txt` | `SID/`, `docs/sid/` |
| Ironclad | `bot-ironclad.js`, `bot-hype-manager.js`, `rules-ironclad.json`, `trades-ironclad.csv`, `closed-positions-ironclad.json`, `open-positions-ironclad.json`, `cooldown-ironclad.json`, `hype-state.json`, `ironclad-log.json`, `railway-runner.js`, `audit.js`, `monitor.js`, `.github/workflows/ironclad.yml`, `.github/workflows/research.yml` | None — lives at repo root |
| VWAP Scalper | `bot.js`, `rules.json`, `trades.csv`, `safety-check-log.json`, `.github/workflows/trade.yml` | None — lives at repo root |
| Research (cross-cutting) | `research.js`, `research-signals.json`, `docs/index.html`, `closed-positions-vwap.json` | `docs/` (Ironclad dashboard) |

**Shared infrastructure** (touchable from any session but always with care):
- `package.json` / `node_modules/` — shared npm deps
- `.env.example` — env-var documentation
- `README.md`, `IRONCLAD-README.md`, `SID-README.md` — human-facing readmes (separate from agent memory files)
- `.gitignore`, `.github/dependabot.yml` (if present)

---

## "User mentioned X — go check Y" routing guide

When the user says... | Read first... | Then check...
|---|---|---|
"the bot" / "today's run" / "live trades" | Ask which one (SID/Ironclad/VWAP) | The relevant memory file
"the dashboard" | The user probably means **SID's** if they just installed it | `SID/CLAUDE.md` § Dashboard
"the toggle" / "performance pie" | `SID/CLAUDE.md` § Dashboard toggle | `SID/sid-dashboard.js`
"the backtest" | Almost always SID | `SID/CLAUDE.md` § Backtests + `SID/strategy-test-vault/`
"V2.1" / "TP1" / "TP2" | SID | `SID/CLAUDE.md` § V2.1 method
"the instructor" | SID — instructor refers to the SID strategy author | `SID/CLAUDE.md`
"the strategy test vault" | SID | `SID/strategy-test-vault/README.md`
"Railway" / "Bitget" / "futures" | Ironclad | `IRONCLAD-MEMORY.md`
"scalper" / "intraday crypto" | VWAP | `VWAP-MEMORY.md`
"Ironclad's positions" | Ironclad | `IRONCLAD-MEMORY.md`
"crypto positions" | Could be either VWAP or Ironclad — ask | Both memory files
"research dashboard" / `docs/index.html` | Ironclad's research pipeline | `IRONCLAD-MEMORY.md` § Research workflow

---

## Cross-cutting stumbling blocks (lessons paid for in past sessions)

### Worktree vs parent SID folder
There are TWO `SID/` folders on disk:

| Path | What it is | Use? |
|---|---|---|
| `Trading Setup/SID/` (parent) | Stale snapshot — older v1.0 code | ❌ Never edit |
| `Trading Setup/SID/.claude/worktrees/silly-robinson-abcf6c/SID/` (worktree) | LIVE main branch — current v2.1 deployment | ✅ All SID work goes here |

Run `git worktree list` from the repo root to verify the worktree path. The deployed bot version is in the worktree's `bot-sid.js`.

### Push protocol — always pull-rebase first
Bot and dashboard workflows auto-commit constantly (`SID run …`, `Bot run …`, `Dashboard update …`). Any local commit will be rejected as non-fast-forward unless you rebase first.

**Correct sequence:**
1. `git fetch origin main`
2. `git pull --rebase --autostash origin main`
3. `git push origin main`

Never push to `main` without explicit user approval. The auto-mode classifier will block silent pushes, and rightly so. Open a PR or ask for sign-off.

### GitHub Actions `setup-python@v5` + `cache: pip` requires a manifest
If you use `cache: pip`, you must also have `requirements.txt` or `pyproject.toml` in the repo AND set `cache-dependency-path: <path>`. Without the manifest, the action fails with `No file in /home/runner/work/... matched to [**/requirements.txt or **/pyproject.toml]`. Cost the SID dashboard 6 days of downtime before being caught (2026-05-18).

### Dashboard commits come from TWO different workflows
- `research.yml` → "Dashboard update YYYY-MM-DD HH:MM UTC" commits → updates `docs/index.html` (Ironclad's research dashboard)
- `sid-dashboard.yml` → "SID dashboard update YYYY-MM-DD HH:MM UTC" commits → updates `docs/sid/index.html` (SID dashboard)

If you see "Dashboard update" commits on `main` while the SID dashboard looks stale, it's the Ironclad one — check `sid-dashboard.yml` runs for the SID side.

### Dashboard is shared between SID + Ironclad (additive-only rule)
The dashboard HTML (`docs/index.html` for Ironclad, `docs/sid/index.html` for SID) serves both strategies. **New SID features must be additive-only — never modify existing Ironclad sections.** Each strategy publishes to its own subpath.

### Three sizing methodologies coexist — always note which
- **Fixed dollar risk** (e.g. $200/trade) — raw backtest JSON/CSV reports
- **1% compounding** — instructor Excel reports, V2 baseline Excel
- **2% compounding** — older deprecated style

Same trade set produces dramatically different totals across these. When citing a P&L number, always say which sizing it's under.

---

## GitHub Actions inventory

| Workflow | Cadence | Triggers | What it does | Belongs to |
|----------|---------|----------|--------------|------------|
| `sid.yml` | Daily 14:35 UTC weekdays | schedule + manual | Runs SID bot once per market open | SID |
| `sid-dashboard.yml` | 3× daily (13:00 / 17:30 / 21:15 UTC weekdays) | schedule + manual | Scans + rebuilds SID dashboard | SID |
| `research.yml` | 2× daily (08:00 / 17:00 UTC) | schedule + manual | Runs research, rebuilds Ironclad dashboard | Ironclad |
| `ironclad.yml` | Manual only | workflow_dispatch | Backup Ironclad bot run (Railway is primary) | Ironclad |
| `trade.yml` | Schedule (see file) | schedule + manual | Runs VWAP Scalper bot | VWAP |

---

## Live runtimes — where does each bot run?

- **SID** → GitHub Actions runner (Ubuntu 24.04). Daily, fully automated.
- **Ironclad** → Railway (continuous). `railway-runner.js` polls every 15 minutes, runs `bot-ironclad.js`, pushes state to the `logs` git branch. Railway watches the `main` branch for code updates.
- **VWAP Scalper** → GitHub Actions runner. Schedule per `trade.yml`.

**Reminder:** Ironclad's GitHub Actions workflow (`ironclad.yml`) is set to `workflow_dispatch` only because Cloudflare blocked GitHub Actions IPs from reaching BitGet. Railway hosts the live bot. **Do not "fix" the manual-only flag.**

---

## User-level memory (cross-session personal facts)

The user keeps cross-session notes at:
```
~/.claude/projects/C--Users-balli-OneDrive-Documents-Claude-Base-Trading-Setup/memory/MEMORY.md
```

That file has the user's preferences, environmental quirks (Hamachi/NordVPN conflict, SendGrid trial expiry), and high-level rules (SID instructor's strategy is non-negotiable, dashboard is shared between strategies). Check it for any "why does the user always say X?" question. **Don't duplicate its content here** — point to it.

---

## Conventions for adding a new strategy

When a new strategy is added to this repo:
1. Decide if it lives in its own subfolder (recommended) or at the repo root (legacy).
2. If subfolder: create `<STRATEGY>/CLAUDE.md` — Claude Code auto-loads it.
3. If root-level: create `<STRATEGY>-MEMORY.md` and **add a row to the strategy roster table above** so it's discoverable.
4. Update the segregation rules table — what files does it own?
5. Update the routing guide — what user phrases should route here?
6. Add to the GitHub Actions inventory if it ships a workflow.

The root file (this one) is the **single source of truth** for "what strategies exist and where their context lives." Keep it accurate.
