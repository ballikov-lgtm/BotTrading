# Research Agent — Memory

Quick continuity notes so any new session (or you, working solo in this folder) can pick up without re-deriving context.

## Status

- **2026-05-24 / Phase 1** ✅ done — Folder skeleton (5 dirs + READMEs + per-lens MEMORYs).
- **2026-05-24 / Phase 2** ✅ done — `lens-holdings/` wired end-to-end. Python script imports `Holdings.docx`, calls Claude with `web_search`, writes structured `holdings-alerts.json` to the private OneDrive folder.
- **2026-05-24 / Phase 3** ✅ done — Private GitHub repo `ballikov-lgtm/holdings-reports` created. Local `reports/` folder in OneDrive is now a working tree of that private repo; `lens.py` auto-commits + pushes after each run. Browsable from phone via GitHub mobile app.
- **Currently on: waiting to start Phase 4** (Telegram/email layer — extend `Claude Base/hub/hub-telegram-listener.js` with new commands + push alerts derived from `holdings-alerts.json`. Replace the existing scheduled-task daily-email skill once the new layer is reliable.)

## Important reset (2026-05-24)

The original architecture memo said "Phase 2 reuses existing fund_monitor.py logic — lowest-risk migration." **That was wrong.**
- `fund_monitor.py` is dead reference code — never ran in production.
- The actual production daily email is driven by `~/.claude/scheduled-tasks/retirement-fund-daily-monitor/SKILL.md`, a Claude skill that uses WebSearch + PowerShell + SendGrid.
- **Investment Routines/ is reference only — deletable once Phase 4 reports layer takes over the daily email.**
- Phase 2 was rebuilt from scratch, not migrated. The lens uses Claude API + `web_search` tool to do live research.

## Build order

1. ~~Skeleton folders~~ ✅ done
2. ~~Wire `lens-holdings`~~ ✅ done (rebuilt, not migrated — see above)
3. ~~Private repo for reports + git auto-push~~ ✅ done (`holdings-agent/` folder skeleton DEFERRED — no clear consumer yet; lens output is already useful as-is)
4. **Next:** Extend `Claude Base/hub/hub-telegram-listener.js` with new commands: `HOLDINGS STATUS`, `HOLDINGS RISK`, `RESEARCH NOW STOCKS|CRYPTO|HOLDINGS|FOREX`. Add prefix tags: `[SID]`, `[CATS]`, `[HOLDINGS ⚠️]`, `[RESEARCH]`. Build the reports/email layer (consumes `holdings-alerts.json` and pushes to email + Telegram). Replaces the scheduled-task skill once reliable.
5. Build `lens-stocks` (SID consumer; future stock strategies also read it).
6. Build `lens-crypto` + promote CATS to first-class in root `CLAUDE.md` Strategy Index.
- (Unscheduled) Build `lens-forex` when a forex strategy lands.
- (Deferred) `holdings-agent/` skeleton if/when there's a real consumer for portfolio-level math (sector weights, concentration risk, rebalance recommendations). Not blocking anything today.

## Architectural rules (do not violate)

- **Lens belongs to asset class, not strategy.** Output filenames are asset-class-based (`stocks-signals.json`, `crypto-signals.json`, `forex-signals.json`, `holdings-alerts.json`). Strategies are consumers. (See `feedback_lens_vs_strategy` memory.)
- **Hard separation between asset classes at output.** A strategy never reads a lens for a different asset class.
- **Stocks ≠ Crypto ≠ Forex.** Different drivers; they each get their own lens even when the underlying ingest is shared.
- **One shared ingest, four segmented lens outputs.** Common inputs (economic calendar, FOMC, earnings, geopolitical, virus outbreaks) fetched once; each lens turns them into asset-class-specific structured signals.
- **Holdings repo is new and private.** `holdings.json` gitignored locally; only sanitised reports committed.
- **Telegram = one hub bot.** Extend existing, don't create second.

## Pending decisions (decide when you hit them)

- Gitignore policy for `outputs/*.json` — commit them so the dashboard can show history, or local-only?
- Whether `lens-holdings` reads `holdings.json` directly post-Phase-3, or `holdings-agent` pushes state to it.
- Whether to factor shared-context fetching out of `lens-holdings/lens.py` into `ingest/macro.py` now, or wait until `lens-stocks` needs it.

## Registry note

`Claude Base/hub/registry.json` lists this agent as `coming_soon`. With Phase 2 shipped, the lens has live output — bump status to `active` next time we touch the registry. The `sipps-specialist` entry is the placeholder for `holdings-agent` — replace it when Phase 3 ships.
