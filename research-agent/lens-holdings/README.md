# Lens: Holdings

Live research on your long-term holdings (ETFs, OEICs, Investment Trusts, fund managers) + opportunity scanning for where to deploy idle cash.

## Privacy

**Real holdings + generated reports live OUTSIDE this git repo** at:
```
C:\Users\balli\OneDrive\Documents\Private Investments\
  ├── Holdings.docx              ← your source of truth (edit this in Word)
  ├── holdings.json              ← derived working copy (auto-generated from .docx)
  └── reports\
      └── holdings-alerts.json   ← lens output, latest report
```

This folder is in OneDrive (private to your Microsoft account) and is NOT inside any git working tree, so it physically cannot be `git add`-ed by accident. The repo's `.gitignore` also blocks `holdings*` filenames as belt-and-braces.

Override the private folder location via `HOLDINGS_PRIVATE_DIR` in `.env` if you ever move it.

## How it works

1. **`generate_template_docx.py`** (run once) — drops a sample `Holdings.docx` into the private folder with example holdings + watchlist tables.
2. **You edit `Holdings.docx`** in Word — replace example rows with your real holdings.
3. **`lens.py`** runs the full flow:
   - Imports `Holdings.docx` → `holdings.json` (private folder)
   - Calls Claude with `web_search` to build shared context (macro + geopolitical + 7-day calendar)
   - Researches each holding individually (GREEN/AMBER/RED signal + bullets + sources)
   - Scans for new investment opportunities (named funds, predicted outlook, risk level)
   - Writes `holdings-alerts.json` to the private reports folder

The shared sources list (`sources.json`) lives in this folder and is public — it's just a list of research domains, no holdings data.

## Run

```
cd research-agent/lens-holdings
pip install -r requirements.txt          # first time only
py generate_template_docx.py             # first time only — creates Holdings.docx
# edit Holdings.docx in Word, replace examples with real holdings
py lens.py                               # run anytime for a fresh briefing
```

## Output schema (holdings-alerts.json)

```
{
  "generated_at":   "ISO timestamp",
  "generator":      "lens-holdings v0.2.0",
  "shared_context": { macro_summary, geopolitical_summary, calendar_next_7d[] },
  "holdings":       [{ id, name, signal, summary, bullets, sources_used }, ...],
  "opportunities":  [{ name, type, rationale, predicted_outlook, risk_level, bullets, sources_used }, ...],
  "alert_summary":  { red_count, amber_count, green_count, new_opportunities_count }
}
```

## Operating notes

- **Runtime:** ~4-15 minutes depending on number of holdings. Driven by the entry-tier API rate limit (30K input tokens/min); 60-second pauses between calls keep it safe. Lift the API tier at console.anthropic.com to reduce this.
- **Cost:** ~$0.20-0.50 per run depending on holdings count.
- **Email / HTML:** NOT included here. Phase 4 will build a reports/Telegram layer that consumes `holdings-alerts.json` and pushes to email + your phone. Your existing daily email skill (`~/.claude/scheduled-tasks/retirement-fund-daily-monitor/`) keeps running untouched until then.

## Current state

**Phase 2 done (2026-05-24).** Lens runs clean end-to-end. Verified with 3 real holdings (Fundsmith, Polar Capital Tech, Scottish Mortgage) + 2 watchlist items — produced AMBER signals on all 3 with sourced rationales (e.g. Fundsmith flagged for 5-year underperformance vs MSCI World), plus 5 named opportunities.
