# Lens: Holdings — Memory

## Status

**Phase 2 complete (2026-05-24)** — lens runs clean end-to-end against real holdings via Holdings.docx importer. All data + reports live in a private OneDrive folder outside the git repo.

## What's wired

- `lens.py` (v0.2.0) — Python orchestrator with built-in `Holdings.docx` importer
- `generate_template_docx.py` — one-shot helper to seed the sample Holdings.docx
- `sources.json` — curated research domains (public, no PII)
- `requirements.txt` — `anthropic`, `python-dotenv`, `python-docx`
- Reads `ANTHROPIC_API_KEY` from `Trading Setup/.env` with `override=True`

## Privacy boundaries

- **Private data folder** (default): `C:\Users\balli\OneDrive\Documents\Private Investments\`
- Override via `HOLDINGS_PRIVATE_DIR` env var
- Holdings.docx + holdings.json + reports all live there — physically outside any git working tree
- `.gitignore` also blocks `**/holdings*.json` + `**/Holdings.docx` as belt-and-braces
- `sources.json` is in the public repo — it's just a list of research domains, no holdings exposure
- **Phase 3 will add a private GitHub repo** for browsable report history (per user decision)

## What lens.py does

Three Claude API calls, each with the `web_search_20250305` tool:

1. **Shared context** — macro briefing (Fed/BoE/ECB recent moves, inflation, equity regime) + geopolitical briefing (wars, sanctions, political risks) + 7-day calendar of major events. ~3 web searches per call.
2. **Per-holding research** — for each entry in `holdings.json`, GREEN/AMBER/RED signal + 2-3 sentence summary + bullets + sources. ~2 web searches per holding.
3. **Opportunity scan** — 3-5 named investment ideas with rationale, predicted outlook, risk level, bullets, source URLs. ~3 web searches.

Writes `../outputs/holdings-alerts.json`.

## Verified output (2026-05-24 test run)

- File size ~16KB
- All sections populated
- Calendar had 13 dated events (importance-rated HIGH/MEDIUM/LOW)
- Opportunities surfaced were SPECIFIC named funds with HL/Morningstar/Citywire/Fidelity citations
- Per-holding correctly flagged the placeholder as "not found" with GREEN signal

## Operational notes

- **Rate limit constraint:** API account is on the entry tier (30,000 input tokens per minute). Web search results count as input tokens, so the three calls can easily blow the per-minute window. `PAUSE_SEC = 60` between calls keeps it safe. Total runtime ~4 minutes per run with the placeholder holding. Real runs (5-10 holdings) will take ~8-15 minutes.
- **Upgrading the tier** would let us drop `PAUSE_SEC` toward zero — would make this a 30-60s run.
- **max_tokens** tuning: opportunities was originally 2500, got truncated mid-string for 5 detailed entries. Now 5000. Per-holding is 1200 (sufficient). Shared context is 2000 (sufficient).
- **Cost per run:** ~$0.20-0.40 in API spend on the placeholder. Real holdings list will scale linearly.

## What user needs to do

1. **Open `Holdings.docx`** in `C:\Users\balli\OneDrive\Documents\Private Investments\`. Replace the example rows with your real holdings + watchlist. Save.
2. **Optionally trim `sources.json`** if any default research domains aren't useful for your style.
3. **Run `py lens.py`** from inside `lens-holdings/` whenever you want a fresh briefing. Report lands in `Private Investments\reports\holdings-alerts.json`.

## Verified outputs

- 2026-05-24 first real run: 3 holdings (Fundsmith, Polar Capital Tech, Scottish Mortgage), 5 opportunities surfaced (Vanguard Small-Cap, Fidelity Special Sits, Barings Korea, Jupiter Gold & Silver, Artemis Global Income). 23KB JSON. All AMBER on holdings — Fundsmith correctly flagged for 5-year underperformance vs MSCI World.

## Pending / deferred

- **Watchlist not yet fed into the lens prompts.** Currently parsed from .docx → stored in holdings.json → ignored by research functions. The opportunity scan coincidentally picked Artemis Global Income (which IS on the watchlist) but only by luck. To do: pass watchlist rationale into either `research_holding` or `research_opportunities` so the lens actively researches those names.
- **Email/HTML report:** Phase 4. The existing scheduled-task skill at `~/.claude/scheduled-tasks/retirement-fund-daily-monitor/SKILL.md` keeps sending the daily email — UNTOUCHED. Don't disable it.
- **Private GitHub repo for reports:** Phase 3. User wants reports browsable from phone via GitHub mobile app. Need to create a new private repo + auto-push reports/ folder to it.
- **Report history / archive:** currently `holdings-alerts.json` is overwritten each run. Consider timestamped archive (`holdings-alerts-YYYY-MM-DD.json`) so trends can be compared.
- **Ingest split:** macro/geopolitical/calendar fetch is hardcoded inside `lens.py`. When `lens-stocks` or `lens-crypto` arrives and needs the same shared context, factor into `../ingest/macro.py`. Premature today (only one consumer).
- **Retry-with-backoff on 429s:** the SDK retries automatically (2 retries by default). If user upgrades API tier this matters less.
- **Output schema versioning:** `generator: "lens-holdings v0.2.0"` is in the JSON. Bump on breaking changes so downstream consumers can detect schema shifts.

## Phase 3 cutover plan

When holdings-agent is built and given its own private repo:

- `holdings.json` already lives in OneDrive private folder — no move needed
- Create new **private** GitHub repo (e.g. `holdings-private`) — set visibility to private at creation
- Sync `Private Investments\reports\` to that repo (e.g. via a small git wrapper that commits + pushes after every lens run, or via a one-way mirror)
- The lens itself can stay in `research-agent/lens-holdings/` — it's research infrastructure, not private data
- `holdings-agent/` becomes the downstream consumer that reads `holdings-alerts.json` and produces risk reports, portfolio-weight checks, etc.
