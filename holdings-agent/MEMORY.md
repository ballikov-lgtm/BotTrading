# Holdings Agent — Memory

## Status

**Phases 4a-d + 5a-c + 6 + 7 done (2026-05-24).** Holdings pipeline now produces a full evidence-backed weekly report with concrete allocation recommendation in every run.

## Phase plan

- **4a** ✅ done — `telegram_notify.py` (sender helper) + `daily_watch.py` (diffs latest report vs most recent prior archive; pings Telegram on signal upgrades, new AMBER/RED holdings, new MEDIUM+ opportunities). Verified end-to-end.
- **4b** ✅ done — `lens-holdings/lens.py` v0.4.0 captures per-holding 1/3/5/10-yr annualised returns, sector benchmark, and `vs_target` verdict (UNDERPERFORMING / ON_TRACK / OUTPERFORMING / INSUFFICIENT_DATA). Confirmed on 3 real funds: Fundsmith correctly flagged UNDERPERFORMING (5yr 5.6%), Polar Tech INSUFFICIENT_DATA (newer fund), Scottish Mortgage OUTPERFORMING (10yr 18.3%).
- **4c** ✅ done — `weekly_review.py` aggregates past 7 days of archives, computes portfolio weighted 10-yr return, classifies each holding (SELL/REVIEW/HOLD), surfaces BUY candidates from opportunities appearing in 50%+ of week's reports (watchlist matches starred). Writes Markdown to `reports/weekly/YYYY-Www.md`, pushes Telegram summary, commits + pushes to GitHub. Pure Python — no API spend.
- **4d** ✅ done — Windows Task Scheduler tasks installed via `scripts/install_scheduled_tasks.cmd`. "Holdings Daily Lens+Watch" daily 06:30, "Holdings Weekly Review" Sundays 09:00. Wrappers in `scripts/run_daily.bat` + `scripts/run_weekly.bat`. Logs land in `Private Investments/logs/`.
- **5a** ✅ done — `generate_pension_template.py` creates `Pension.docx` template in private folder. `pension_importer.py` reads it (two tables: Pension Details + Retirement Planning) → returns dict with provider, current value, return rate, monthly contributions, DOB, target age, target pot. Importer flags `_looks_unfilled` when template values still present so projection gracefully skips.
- **5b** ✅ done — `weekly_review.project_retirement()` compounds current holdings + pension forward to target retirement age using portfolio's weighted 10-yr return (holdings) + pension's expected return (typically ~4%) + ongoing monthly pension contributions. Returns projected total, surplus/shortfall vs target pot, and required-extra-monthly-contribution if behind. None returned if pension data missing or unfilled.
- **5c** ✅ done — `render_html.py` produces a rich styled HTML report alongside the Markdown. Per-holding evidence cards show full lens summary, bullets, 1/3/5/10-yr performance table, benchmark comparison, source URLs. Recommendations show WHY (the reason behind each SELL/REVIEW/HOLD). Retirement section shows current → projected → target with surplus/shortfall. HTML is email-safe (inline CSS) so future SendGrid send is straightforward.
- **6** ✅ done — `email_notify.py` sends the weekly HTML via SendGrid REST API. Recipients configured in `.env` (`HOLDINGS_EMAIL_RECIPIENTS` — currently alan.ball@jarvale.co.uk + ballikov@gmail.com). Markdown report beefed up with same evidence density as HTML (lens summary + bullets + performance table + sources per holding) so GitHub mobile / web also gives the full picture.
- **7** ✅ done — Concrete allocation recommendation in every weekly review. `generate_financial_plan_template.py` + `financial_plan_importer.py` capture cash available + risk preferences from `FinancialPlan.docx`. `allocator.py` uses Claude (sonnet-4-6, no web search, ~$0.05/call) to produce: exec summary, allocation table (Fund/Risk/Amount/%/Action), per-position rationale, portfolio shape summary, expected base/stress outlook, comprehensive caveats (ISA wrapper, dealing fees, T+4 settlement, dilution levies, past-performance disclaimer, concentration check, currency risk, regulatory disclaimer). Validates totals balance to available capital. Renders into both Markdown and HTML report sections.

## Key user requirements (from spec 2026-05-24)

- **Target return:** 10-14% annualised. Benchmark against 10-year averages.
- **Known underperformer to sell:** Baillie Gifford American (user has said they plan to sell). Agent should surface this as a primary recommendation when 4c lands.
- **Real-time-ish news flashes:** Daily cadence (after lens.py run) is acceptable for long-term portfolio. Faster cadence rejected as cost-disproportionate for non-trading positions.
- **Telegram alerts:** Required. Prefix tag `[HOLDINGS ⚠️]` per architecture memo. Reuses existing TELEGRAM_BOT_TOKEN — no second bot.

## Architecture notes

- Code lives here at `Trading Setup/holdings-agent/` (public BotTrading repo). Code has no PII.
- Data lives in `Private Investments/` (private OneDrive folder, also git working tree of `holdings-reports` private repo).
- Telegram delivered directly via bot token + chat ID from `.env`. If a hub router is later built, this becomes one of several callers; no refactor needed in the agent itself.
- Language: Python (matches `lens-holdings`).

## Pending decisions

- ~~Should `weekly_review.py` emit Markdown, HTML, or both?~~ Decided: BOTH (5c) — Markdown for quick phone scan, HTML for rich evidence-backed read.
- Should the agent maintain its own state file (e.g. `state/decisions.json` logging recommendations made + user actions taken)? Useful for "did I tell you to sell this last week?" tracking. Defer until there's a real need.
- Should `weekly_review.py` use Claude to write a narrative exec summary at the top of each report? Currently pure rule-based. Adds ~$0.10/week + 30-60s. Defer unless the rule-based output feels too dry.
- Fuzzy fund-name matching for watchlist stars — currently uses substring match either direction. Handles "X Fund" vs "X" but might over-match. Reconsider if false positives appear.
- Email delivery of the HTML report via SendGrid (account is configured for the existing fund_monitor skill). Defer — Telegram + GitHub repo cover the primary access patterns; email can be added later if user wants inbox copies.
