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
| **Ironclad** | SWING | Daily + 15m | Crypto + stocks + commodities | Trending | BitGet (3× futures) | **PAUSED** (being replaced by C.A.T.S.) | `bot-ironclad.js` | [`IRONCLAD-MEMORY.md`](IRONCLAD-MEMORY.md) |
| **VWAP Scalper** | SCALP | 4h | Crypto | Ranging / choppy | BitGet | **LIVE PAPER** | `bot.js` | [`VWAP-MEMORY.md`](VWAP-MEMORY.md) |
| **C.A.T.S.** | SCALP / short swing | 1H | Crypto | TBD (S&D levels-based design in progress) | BitGet | **ALPHA** (Pine visualiser built; bot TBD) | `bot-cats.js` (TBD) | [`CATS-MEMORY.md`](CATS-MEMORY.md) |

**Status legend:**
- **ALPHA** — in-development, not deployed
- **LIVE PAPER** — deployed and running with paper-money / simulated execution
- **LIVE** — running with real money
- **ARCHIVED** — retired, kept for reference only

**Outside this repo (mentioned by user, not modifiable from this session):**
- A separate crypto strategy that lives outside this codebase. If the user mentions it, **ask where it lives** — don't guess.

---

## Specialist agents (delegate to these)

The repo ships with four Claude Code subagents at [`.claude/agents/`](.claude/agents/). The main session (the orchestrator) should **delegate domain work to these** rather than handling everything itself — each agent runs in isolated context and won't pollute the main conversation.

| Agent | Use for | Mode |
|---|---|---|
| `sid-specialist` | All SID work — RSI mean-reversion on US stocks/ETFs via Alpaca | Read + write |
| `ironclad-specialist` | All Ironclad work — multi-timeframe trend bot on BitGet futures (PAUSED) | Read + write |
| `vwap-specialist` | All VWAP work — 4h crypto scalp on BitGet, ranging-market only | Read + write |
| `strategy-validator` | Cross-strategy audits, segregation checks, correctness drift | **Read-only** |

**Delegation rule:** When user asks about a strategy by name, route to that strategy's specialist. When they ask for an audit / "is this still correct" / cross-strategy check → `strategy-validator`. Each specialist reads its own domain memory file before acting and refuses to touch other strategies' files.

The roster + how-they-work is documented in [`.claude/agents/README.md`](.claude/agents/README.md). Run `/agents` in any Claude Code session to see them registered.

**Deferred to later phases:** `research-agent`, `design-agent`, `sipps-specialist`, `life-admin` — see `~/.claude/plans/hi-there-so-i-m-linked-pancake.md`.

---

## Find by attribute

When the user references a *type* of strategy rather than naming one, use this lookup to find the right memory file(s) to consult.

| User says... | Matching strategies | Why |
|---|---|---|
| "a swing strategy" / "swing rules" | SID, Ironclad | Both hold positions days-weeks |
| "a scalp" / "intraday" / "scalping logic" | VWAP Scalper, C.A.T.S. | VWAP=4h holds, C.A.T.S.=1H entries |
| "how we handle pullbacks" | SID, Ironclad | SID = daily RSI<30 pullback; Ironclad = 15m pullback within daily trend |
| "a crypto strategy" | VWAP, Ironclad, C.A.T.S. | All trade BitGet |
| "a stocks strategy" / "US equities" | SID, Ironclad (stocks mode) | |
| "a ranging-market strategy" | VWAP | Explicitly skips trending |
| "a trending-market strategy" | Ironclad | Explicitly requires daily trend |
| "daily timeframe rules" | SID, Ironclad | |
| "intraday rules" | VWAP, Ironclad (15m entry side), C.A.T.S. (1H) | |
| "1H rules" / "hourly entries" | C.A.T.S. | Only one on 1H primary |
| "live status" / "running now" | SID + VWAP (LIVE PAPER), Ironclad PAUSED, C.A.T.S. ALPHA | |
| "backtest vault" / "tested variants" | SID — see `SID/strategy-test-vault/` | Others use ad-hoc records |
| "oversold entry" / "RSI extreme" | SID (RSI<30 daily) | Mean-reversion play |
| "trend break entry" | Ironclad (15m break of swing low/high) | Trend-following |
| "VWAP" / "RSI(3)" / "EMA(8)" | VWAP Scalper | Indicator stack lives there |
| "TP1 / TP2 / dynamic exits" | SID v2.1, C.A.T.S. (dynamic short TP planned) | See SID/CLAUDE.md § V2.1 method, CATS-MEMORY.md |
| "Railway" / "Cloudflare" / "futures account" | Ironclad | Only one on Railway |
| "Alpaca" / "PDT-immune" | SID | Only one on Alpaca |
| "supply / demand zones" / "S&D" / "rejection zones" / "order blocks" / "ICT" / "SMC" / "Wyckoff" | C.A.T.S. | Levels-based methodology research lives in CATS-MEMORY.md |
| "Ironclad replacement" / "new crypto bot" | C.A.T.S. | Explicitly the successor |

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
- **Pine Script bugs and fixes → BOTH the strategy's memory file (detailed write-up) AND this root file's "Pine Script pitfall catalog" section (one-line summary + back-ref).** This is non-negotiable: Pine bugs almost always recur across strategies, and a future session creating a new Pine script must be able to scan a single catalog to avoid them. The detailed pitfall in the strategy memory captures root cause + code samples + symptom; the catalog row is the rapid-recall pointer.

**Don't summarise from session-to-session. Write it down.** The whole point of this architecture is that institutional memory persists.

---

## Hard segregation rules (compact)

Each strategy owns specific files. Full lists live in each strategy's memory file — this is the cross-strategy summary so any session knows the boundaries.

| Strategy | Owned area |
|----------|------------|
| SID | `SID/` folder, `docs/sid/`, `.github/workflows/sid*.yml`, `SID/requirements.txt` |
| Ironclad | `bot-ironclad.js`, `bot-hype-manager.js`, `audit.js`, `monitor.js`, `railway-runner.js`, `rules-ironclad.json`, `*-ironclad.json/csv`, `hype-state.json`, `docs/index.html` (research dashboard), `.github/workflows/ironclad.yml`, `.github/workflows/research.yml` |
| VWAP Scalper | `bot.js`, `rules.json`, `trades.csv`, `safety-check-log.json`, `.github/workflows/trade.yml` |
| **C.A.T.S.** | `bot-cats.js` (TBD), `rules-cats.json` (TBD), `*-cats.json/csv` (TBD), `cats/` folder if needed, `docs/cats/` (TBD), `pine/cats-visualiser.pine` (TBD), `.github/workflows/cats.yml` (TBD), `CATS-MEMORY.md` |
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

### TradingView automation — always try TV Desktop MCP first

There are TWO MCPs that can touch TradingView, and they are not interchangeable:

| MCP | Tools prefix | Mechanism | TV access |
|---|---|---|---|
| TV Desktop | `mcp__tradingview__*` | Chrome DevTools Protocol port (9222) into TV Desktop | ✅ Full Pine editor + chart control |
| Chrome-in-Chrome | `mcp__Claude_in_Chrome__*` | Anthropic Chrome extension into the user's Chrome | ❌ **HARDCODED BLOCKS `tradingview.com`** at safety-policy level |

Even if the user says "TV Desktop doesn't work," **always run `mcp__tradingview__tv_health_check` first** — it may already be connected. The Chrome MCP will refuse `tradingview.com` no matter what permission the user clicks. We wasted two turns on this on 2026-05-19 before checking.

For the full Pine-push workflow (open editor, inject source, compile, save, verify, suppress TV's auto trade markers, recent-bars visual gate) see `SID/CLAUDE.md` § "How to push a Pine Script to TradingView".

### Pine Script pitfall catalog (cross-strategy quick-reference)

When writing or auditing ANY Pine strategy, scan this list. Each entry is a bug pattern we've already hit + the canonical fix. Detailed write-ups (root cause, code samples, symptom) live in the linked strategy memory file — but the catalog is the rapid-recall layer so we don't pay the debugging tax twice.

**Convention:** when a major Pine bug is fixed in any strategy, add a one-line summary here AND a detailed pitfall section in the strategy's memory file. The owning agent is responsible — see "Memory-update convention" below.

| # | Pattern | Symptom | Fix |
|---|---|---|---|
| 1 | **ARM re-fires every bar in extreme zone** | Vertical line every 5-15 bars on trends, chart chaos | Use `crossingOversold`/`crossingOverbought` predicate (RSI just crossed INTO zone) + re-arm cooldown counter. See [SID/CLAUDE.md § ARM logic pitfall](SID/CLAUDE.md) |
| 2 | **TP conditions re-fire every bar after threshold met** | Stacked "TP2 Timeout 30/31/32…" labels across chart | Gate each TP condition with `not tp2Hit` so it fires once per trade. See [SID/CLAUDE.md § TP2 re-fire pitfall](SID/CLAUDE.md) |
| 3 | **`bgcolor()` paints every match across all history** | "Christmas tree" of entry bands on 5y backtest | Add `inVisualWindow = bar_index > last_bar_index - i_visualLookback` gate on all `bgcolor()` and conditional `label.new`. See [SID/CLAUDE.md § bgcolor pitfall](SID/CLAUDE.md) |
| 4 | **Stop-order persists after partial close** | Stop double-fires or replaces unexpectedly | `strategy.cancel("Stop X")` BEFORE submitting the replacement `strategy.exit("BE X", ...)`. See [SID/CLAUDE.md § stop-order replacement pitfall](SID/CLAUDE.md) |
| 5 | **`strategy.close()` blocked by pending `strategy.exit()`** | Position stuck "IN runner" for years past TP2 timeout, locks strategy slot forever | EVERY TP2 close branch must `strategy.cancel("BE X")` then `strategy.close()`. See [SID/CLAUDE.md § strategy.close blocked pitfall](SID/CLAUDE.md) |
| 6 | **`tp2*Be` branches relying on BE stop to fire** | After TP1 hits, price crosses BE, BE stop doesn't trigger, position stays runner, `tp2Hit=true` blocks all other exits — irrecoverable deadlock | tp2*Be branches must ALSO `cancel("BE X")` + `strategy.close()` — never trust the BE stop alone. See [SID/CLAUDE.md § tp2*Be pitfall](SID/CLAUDE.md) |
| 7 | **Safety force-close needs MULTI-LAYER check** | Adding a new safety guard variable doesn't catch positions opened before that variable existed (`entryBarIdx` is `na`) | Triple-layer net: (a) initialize var if `na`, (b) safety on `barsSinceEntry`, (c) safety on `barsSinceTp1`. See [SID/CLAUDE.md § three-layer safety pitfall](SID/CLAUDE.md) |
| 8 | **`barstate.islast` doesn't always fire on 1D** | Table renders fine on 4h, never on 1D — labels and lines draw OK so script IS running | Broaden gate to `barstate.islast or barstate.islastconfirmedhistory or bar_index >= last_bar_index - 1`. Confirm via `data_get_pine_tables` (4h returns table, 1D returns 0). See [SID/CLAUDE.md § barstate.islast pitfall](SID/CLAUDE.md) |
| 9 | **TV auto-renders "TP/Long/Short" labels at every fill** | Stacked orange labels on every historical trade bar, chart chaos | NOT fixable in Pine — instruct user: chart's indicator settings → Style tab → uncheck "Signal Labels" |
| 10 | **`pine_new` during error recovery creates duplicate scripts** | Orphaned "SID Strategy v2.1 4", "SID Strategy v2.1 5"… cluttering account | Recover by `pine_open` on any existing script (forces editor panel), then `pine_open` the target. NEVER call `pine_new` during error recovery |

**Debugging methodology** for any "visible draw is missing" report: see next section (the 5-step diagnostic ladder).

### Pine Script debugging methodology — when "something visual is missing"

When a user reports "the X isn't showing on my chart" for a Pine script (table, label, line, bgcolor, etc.), follow this ordered diagnostic ladder rather than jumping straight to source edits. Earned the hard way on the 2026-05-22 UNH 1D info table bug (8+ hours of debugging compressed into ~20 minutes of method).

**Step 1 — Confirm the script is loaded and running.**
- `chart_get_state` → is the study in the studies array?
- `data_get_study_values` → are its `plot()` outputs returning real numbers? (If yes, the script runs.)
- `pine_get_errors` → any compile errors? (If yes, fix those first — nothing else will work.)

**Step 2 — Query the Pine output API directly.** This is the killer diagnostic. Tradingview MCP exposes:
- `data_get_pine_tables { study_filter: "X" }` — returns the actual table rows the script is drawing
- `data_get_pine_labels { study_filter: "X" }` — returns all label.new texts
- `data_get_pine_lines { study_filter: "X" }` — returns line.new horizontals

If `data_get_pine_tables` returns `study_count: 0` but `data_get_pine_labels` returns N labels, **the script is running but the table block isn't executing**. That narrows the bug to the table's gate condition — not the table rendering, not overlap, not chart layout.

**Step 3 — Compare across timeframes.** Switch the chart timeframe (`chart_set_timeframe`) and re-query the same Pine output API. If 4h returns tables but 1D doesn't, the bug is a runtime condition that's timeframe-sensitive. Same compiled bytecode, different result → look at `barstate.*`, `request.security` warmup, `last_bar_index`, or any time-derived inputs.

**Step 4 — Don't assume overlap.** Pine tables anchored at the same `position.*` DO stack and last-rendered wins, but `data_get_pine_tables` returns whatever the script COMPUTED, regardless of z-ordering. If the API says no table, the overlap theory is wrong — move on.

**Step 5 — Don't assume stale cache without proof.** `pine_smart_compile` recompiles even when source is unchanged. If a force-recompile doesn't change behaviour, the issue is in the source itself, not a cached bytecode.

**Common Pine pitfalls that produce "invisible draw":**
- `barstate.islast` not firing on the last realtime forming bar with `calc_on_every_tick=false`. Workaround: broaden to `barstate.islast or barstate.islastconfirmedhistory or bar_index >= last_bar_index - 1`. (See `SID/CLAUDE.md` § pitfall.)
- `var table info = table.new(...)` inside an if-block — table is initialized only on the first bar the if condition is true. If that bar never arrives, the table never exists.
- `position.top_right` overlap from another script's table — but disprovable with `data_get_pine_tables` (Step 2).
- `inVisualWindow` gates that compute `bar_index > last_bar_index - N` — if `last_bar_index` is unstable on a given chart, the gate can silently flip.

**Workflow gotchas during the fix (lessons earned):**
- Don't paste Pine line-number-based instructions to the user — line numbers drift between local file and TV's saved version. Use **Find & Replace text** for manual edits.
- If the user's Pine Editor has an "Untitled script" tab open, `pine_open` on another script will fail. The user must close Untitled (don't save) first.
- `pine_new` should NEVER be called during error recovery — it creates a duplicate script slot. Always recover by calling `pine_open` on an existing script (any script will force the editor panel open, then re-open the target script). See `SID/CLAUDE.md` § pitfall.

### Ad-hoc cloud-fired trades — use GHA cron, never local schedulers

**Rule:** any trade automation (scheduled bot runs, one-off pipeline tests, manual S&D entries) MUST run in the cloud and be PC-independent. The user's machine may be off when trades are due.

**Never use:** Claude Code's `scheduled-tasks` MCP for trade execution. Those tasks require the local Claude Code app to be open at fire time — if the PC is off, the task runs on next launch (after market close, the trade fails). Confirmed 2026-05-22 — wrong tool, retracted in favour of GHA cron.

**Cloud-fired pattern for one-off ad-hoc trades:**

1. Write the underlying logic as a Node script (e.g. `SID/manual-trade.js`) that reads trade params from env vars
2. Create a workflow that exposes BOTH triggers:
   - `workflow_dispatch` with inputs (for manual triggers via `gh workflow run` or GitHub UI from anywhere — phone, laptop, Railway)
   - `schedule: cron` with the desired fire time (for hands-off scheduled execution)
3. For one-shot crons, add a **year guard** in the workflow body (`if [ "$year" != "2026" ]; exit 1`) to prevent accidental yearly re-fires if the file isn't deleted after firing
4. After the one-shot fires successfully, delete the workflow file in the next housekeeping push

**Live example:** `.github/workflows/sid-oneshot-mcd-2026-05-22.yml` — fires MCD trade once via cron `'35 13 22 5 *'` (13:35 UTC = 14:35 BST May 22), year-guarded to 2026.

**Why this matters:** The user has Railway available and can also dispatch via webhook → GHA REST API if more complex scheduling logic is needed (e.g. multi-leg trades, conditional fires). But for simple "fire X at time T", GHA cron + year guard is the lowest-engineering path. Railway is reserved for stateful, long-running, or sub-minute-cadence work (like the Ironclad 15-min loop).

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
