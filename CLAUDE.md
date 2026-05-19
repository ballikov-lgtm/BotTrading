# Trading Setup — Project Hub (Strategy Index)

This file is a **searchable index of every strategy in this codebase**. Its job is to point Claude at the right deep-context memory file — NOT to contain strategy details itself.

**How a new session uses this file:**
1. User asks about a strategy by name, type, condition, or status
2. Look up matches in the [Strategy Index](#strategy-index) and the [Find by attribute](#find-by-attribute) lookup
3. Open the matching memory file from the "Deep context" column
4. **Read the deep context before answering** — don't infer from filenames or memory

---

## Strategy Index

| Strategy | Style | Timeframe | Assets | Best in market | Exchange | Status | Bot file | Deep context |
|----------|-------|-----------|--------|----------------|----------|--------|----------|---------------|
| **SID** | SWING | Daily | US stocks & ETFs | Mean-reversion (RSI extremes) | Alpaca | **LIVE PAPER** (v2.1) | `SID/bot-sid.js` | [`SID/CLAUDE.md`](SID/CLAUDE.md) |
| **Ironclad** | SWING | Daily + 15m | Crypto + stocks + commodities | Trending | BitGet (3× futures) | **LIVE** | `bot-ironclad.js` | [`IRONCLAD-MEMORY.md`](IRONCLAD-MEMORY.md) |
| **VWAP Scalper** | SCALP | 4h | Crypto | Ranging / choppy | BitGet | **LIVE PAPER** | `bot.js` | [`VWAP-MEMORY.md`](VWAP-MEMORY.md) |

**Status legend:**
- **ALPHA** — in-development, not deployed
- **LIVE PAPER** — deployed and running with paper-money / simulated execution
- **LIVE** — running with real money
- **ARCHIVED** — retired, kept for reference only

**Outside this repo (mentioned by user, not modifiable from this session):**
- A separate crypto strategy that lives outside this codebase. If the user mentions it, **ask where it lives** — don't guess.

---

## Find by attribute

When the user references a *type* of strategy rather than naming one, use this lookup to find the right memory file(s) to consult.

| User says... | Matching strategies | Why |
|---|---|---|
| "a swing strategy" / "swing rules" | SID, Ironclad | Both hold positions days-weeks |
| "a scalp" / "intraday" / "scalping logic" | VWAP Scalper | 4h holds |
| "how we handle pullbacks" | SID, Ironclad | SID = daily RSI<30 pullback; Ironclad = 15m pullback within daily trend |
| "a crypto strategy" | VWAP, Ironclad | Both trade BitGet |
| "a stocks strategy" / "US equities" | SID, Ironclad (stocks mode) | |
| "a ranging-market strategy" | VWAP | Explicitly skips trending |
| "a trending-market strategy" | Ironclad | Explicitly requires daily trend |
| "daily timeframe rules" | SID, Ironclad | |
| "intraday rules" | VWAP, Ironclad (15m entry side) | |
| "live status" / "running now" | Ironclad (LIVE), SID + VWAP (LIVE PAPER) | |
| "backtest vault" / "tested variants" | SID — see `SID/strategy-test-vault/` | Others use ad-hoc records |
| "oversold entry" / "RSI extreme" | SID (RSI<30 daily) | Mean-reversion play |
| "trend break entry" | Ironclad (15m break of swing low/high) | Trend-following |
| "VWAP" / "RSI(3)" / "EMA(8)" | VWAP Scalper | Indicator stack lives there |
| "TP1 / TP2 / dynamic exits" | SID v2.1 | See SID/CLAUDE.md § V2.1 method |
| "Railway" / "Cloudflare" / "futures account" | Ironclad | Only one on Railway |
| "Alpaca" / "PDT-immune" | SID | Only one on Alpaca |

When two strategies match, **read both memory files** and report what each does separately.

---

## Memory-update convention

**When you finish meaningful work on a strategy, append session lessons to that strategy's memory file BEFORE closing out.**

Memory files are append-mostly journals. They should capture:
- **What changed** — bot version bump, schema migration, config update, rule change
- **What broke** — and how it was fixed (so a future session doesn't re-hit it)
- **What was tested** — and the result, including negative results (so they aren't re-tried)
- **What is non-negotiable** — rules the user has explicitly locked
- **What is queued** — next steps, pending tasks, blocked items

**Where to write:**
- Strategy-specific lessons → that strategy's memory file
- Cross-cutting lessons (push protocol, GitHub Actions, dashboard infra, shared state files) → this root file
- Personal/cross-session facts (user preferences, environmental quirks) → `~/.claude/projects/.../memory/MEMORY.md`

**Don't summarise from session-to-session. Write it down.** The whole point of this architecture is that institutional memory persists.

---

## Hard segregation rules (compact)

Each strategy owns specific files. Full lists live in each strategy's memory file — this is the cross-strategy summary so any session knows the boundaries.

| Strategy | Owned area |
|----------|------------|
| SID | `SID/` folder, `docs/sid/`, `.github/workflows/sid*.yml`, `SID/requirements.txt` |
| Ironclad | `bot-ironclad.js`, `bot-hype-manager.js`, `audit.js`, `monitor.js`, `railway-runner.js`, `rules-ironclad.json`, `*-ironclad.json/csv`, `hype-state.json`, `docs/index.html` (research dashboard), `.github/workflows/ironclad.yml`, `.github/workflows/research.yml` |
| VWAP Scalper | `bot.js`, `rules.json`, `trades.csv`, `safety-check-log.json`, `.github/workflows/trade.yml` |
| Shared infra | `package.json`, `node_modules/`, `.env.example`, `README.md` (human-facing readmes are not memory files) |

**When in doubt, check the owning strategy's memory file before touching a file.**

---

## Cross-cutting stumbling blocks (universal — apply to any strategy)

These are the lessons that aren't strategy-specific. Read them once per session start.

### Push protocol
Bot/dashboard workflows auto-commit constantly. Local commits get rejected as non-fast-forward unless you rebase first.

Always: `git fetch origin main` → `git pull --rebase --autostash origin main` → `git push origin main`

**Never push to `main` without explicit user approval.** The auto-mode classifier blocks silent pushes.

### Worktree vs parent folder (SID-specific but symptomatic of the pattern)
The SID worktree lives at `.claude/worktrees/silly-robinson-abcf6c/SID/`. The parent `Trading Setup/SID/` folder is a stale snapshot. **Run `git worktree list` from the repo root to verify which paths are live.**

### GitHub Actions Python cache trap
`actions/setup-python@v5` with `cache: pip` requires:
1. `requirements.txt` or `pyproject.toml` to exist in the repo
2. `cache-dependency-path: <path>` pointing to it

Without both, the action fails with `No file in /home/runner/work/... matched to [**/requirements.txt or **/pyproject.toml]`. Cost the SID dashboard 6 days of downtime on 2026-05-18.

### Dashboard commit-message glossary
Different workflows write different commit messages — don't confuse them when grepping git log:

| Commit message prefix | Workflow | Updates |
|---|---|---|
| `Dashboard update YYYY-MM-DD ...` | `research.yml` | `docs/index.html` (Ironclad dashboard) |
| `SID dashboard update YYYY-MM-DD ...` | `sid-dashboard.yml` | `docs/sid/index.html` |
| `SID run YYYY-MM-DD ...` | `sid.yml` | SID state files |
| `Bot run YYYY-MM-DD ...` | `trade.yml` | VWAP state files |
| `Ironclad run YYYY-MM-DD ...` | `ironclad.yml` | Ironclad state (manual runs only) |

### Dashboard is shared between strategies (additive-only rule)
The dashboard HTML files serve both SID and Ironclad on different subpaths. **New features for one strategy must be additive-only — never modify another strategy's sections.**

### Sizing methodology — always note which
Three methodologies coexist:
- **Fixed dollar risk** ($200/trade) — raw backtest JSON/CSV
- **1% compounding** — instructor reports, V2 Excel
- **2% compounding** — older deprecated style

Same trade set, wildly different totals. Always cite the methodology when quoting P&L.

---

## GitHub Actions inventory (which workflow does what)

| Workflow | Cadence | Trigger | Strategy | What it does |
|----------|---------|---------|----------|--------------|
| `sid.yml` | Daily 14:35 UTC weekdays | schedule + manual | SID | Runs SID bot at market open |
| `sid-dashboard.yml` | 3× daily | schedule + manual | SID | Scans + rebuilds `docs/sid/index.html` |
| `research.yml` | 2× daily | schedule + manual | Ironclad | Runs research, rebuilds `docs/index.html` |
| `ironclad.yml` | Manual only | workflow_dispatch | Ironclad | Backup bot run (Railway is primary; Cloudflare blocks GH IPs from BitGet) |
| `trade.yml` | Multi-cadence | schedule + manual | VWAP | Runs VWAP scalper |

---

## Live runtimes

- **SID** → GitHub Actions runner. Daily, fully automated. Alpaca paper.
- **Ironclad** → **Railway** (continuous 15-min loop). `railway-runner.js` is the driver. State pushed to `logs` branch.
- **VWAP Scalper** → GitHub Actions runner. Schedule per `trade.yml`.

---

## Adding a new strategy

1. **Pick a layout:**
   - Subfolder (recommended) → `<NAME>/CLAUDE.md` inside it (Claude auto-loads)
   - Root-level → `<NAME>-MEMORY.md` alongside this hub (referenced from index)
2. **Add a row to the [Strategy Index](#strategy-index)** with all attributes filled in:
   - Style (SWING / SCALP / POSITION / etc.)
   - Timeframe
   - Assets
   - Best in market
   - Exchange
   - Status (ALPHA / LIVE PAPER / LIVE / ARCHIVED)
   - Bot file
   - Deep context link
3. **Add entries to the [Find by attribute](#find-by-attribute) lookup** for any unique tags (new style, new asset, new market type)
4. **Add a row to the segregation rules table** with the owned files
5. **Add a row to the GitHub Actions inventory** if it ships a workflow
6. **Seed the memory file** with: strategy summary, owned files, deployment, common gotchas, cross-references to root CLAUDE.md and any sibling memory files

The root CLAUDE.md is **the single source of truth** for "what strategies exist and where their context lives." Keep it accurate; the deep details go in the per-strategy files.

---

## User-level memory (cross-session personal facts)

```
~/.claude/projects/C--Users-balli-OneDrive-Documents-Claude-Base-Trading-Setup/memory/MEMORY.md
```

User preferences, environmental quirks (Hamachi/NordVPN conflict, SendGrid trial expiry), and high-level rules (SID instructor's strategy is non-negotiable, dashboard is shared between strategies). Check it for any "why does the user always say X?" question. **Don't duplicate its content here** — point to it.

---

## See also

- SID deep context → [`SID/CLAUDE.md`](SID/CLAUDE.md)
- Ironclad deep context → [`IRONCLAD-MEMORY.md`](IRONCLAD-MEMORY.md)
- VWAP Scalper deep context → [`VWAP-MEMORY.md`](VWAP-MEMORY.md)
- Human-facing READMEs → `README.md`, `IRONCLAD-README.md`, `SID/SID-README.md`
