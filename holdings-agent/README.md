# Holdings Agent

The agent that **manages** your holdings — consuming research from `lens-holdings` and turning it into alerts, performance verdicts, and sell/hold/buy recommendations.

## What it does (current scope)

| Capability | Phase | Status |
|---|---|---|
| Daily Telegram alert when a holding signal changes or a new opportunity surfaces | 4a | ✅ |
| Capture per-holding 1/3/5/10-yr returns vs your 10-14% target | 4b | ✅ |
| Weekly comprehensive review — performance verdict + sell/hold/buy recommendations | 4c | ✅ |
| Schedule everything (Windows Task Scheduler) | 4d | ✅ |
| Pension capture + retirement projection (combined holdings + pension at target age) | 5a/b | ✅ |
| HTML weekly report with full evidence (lens summaries, performance tables, source links) | 5c | ✅ |
| Email weekly report to both addresses (jarvale + gmail) via SendGrid | 6 | ✅ |
| Beefed-up Markdown with same evidence density as HTML | 6 | ✅ |
| Concrete allocation recommendation every week: £-amounts, per-position rationale, expected outlook, caveats | 7 | ✅ |

## How to run

**Automatic** (already scheduled):
- `Holdings Daily Lens+Watch` — runs daily at 06:30 via Windows Task Scheduler. Calls `scripts/run_daily.bat`.
- `Holdings Weekly Review` — runs Sundays at 09:00. Calls `scripts/run_weekly.bat`.

**Manual** (for ad-hoc runs):
```
# Daily research + alert
cd research-agent/lens-holdings && py lens.py
cd ../../holdings-agent && py daily_watch.py

# Weekly review
cd holdings-agent && py weekly_review.py
```

**Logs** for the scheduled runs:
```
%USERPROFILE%\OneDrive\Documents\Private Investments\logs\
  ├── daily-last-run.log      ← overwritten each day
  └── weekly-last-run.log     ← overwritten each Sunday
```

## Managing the scheduled tasks

- **View / pause / edit:** open Task Scheduler GUI (Windows search → "Task Scheduler") → expand Task Scheduler Library → find "Holdings Daily Lens+Watch" and "Holdings Weekly Review"
- **Reset to defaults:** re-run `scripts/install_scheduled_tasks.cmd`
- **Uninstall:** `schtasks /Delete /TN "Holdings Daily Lens+Watch" /F` (and same for weekly)
- **Change times:** edit `install_scheduled_tasks.cmd`, re-run it

## Privacy

This folder contains **code only — no PII**. The data the agent reads/writes lives in the user's private OneDrive folder:

```
C:\Users\balli\OneDrive\Documents\Private Investments\
  ├── Holdings.docx                       ← actively-managed funds (you edit in Word)
  ├── Pension.docx                        ← pension + retirement target (you edit in Word)
  ├── FinancialPlan.docx                  ← cash available + risk preferences + allocation rules (you edit in Word)
  ├── holdings.json                       ← derived from Holdings.docx
  ├── pension.json                        ← derived from Pension.docx (in-memory; not persisted)
  ├── financial_plan.json                 ← derived from FinancialPlan.docx (in-memory; not persisted)
  └── reports\
      ├── holdings-alerts.json            ← latest lens output (the agent's input)
      ├── archive\holdings-alerts-*.json  ← dated snapshots
      └── weekly\
          ├── YYYY-Www.md                 ← markdown weekly report (quick read)
          └── YYYY-Www.html               ← rich HTML report (full evidence + allocation)
```

The reports folder is also a git working tree of the private repo [ballikov-lgtm/holdings-reports](https://github.com/ballikov-lgtm/holdings-reports), so reports are browsable from your phone.

## How it fits the architecture

```
   Holdings.docx
       ↓
   lens-holdings/lens.py    ← researches each holding + opportunities
       ↓
   holdings-alerts.json     ← structured research output
       ↓
   holdings-agent/          ← THIS — turns research into alerts + advice
   ├── daily_watch.py       ← runs after lens.py; diffs vs yesterday; pings Telegram
   ├── weekly_review.py     ← runs Sundays; full performance review (4c)
   └── telegram_notify.py   ← shared sender
       ↓
   Telegram + GitHub repo   ← you on your phone
```

The lens does research; the agent does management. Clean separation.

## Current state

**Phase 4a in progress** (2026-05-24): daily Telegram alerter being wired. See `MEMORY.md` for current pending items.
