"""
holdings-agent/weekly_review.py — weekly portfolio review.

Reads the past 7 days of holdings-alerts archives, the latest holdings.json
(for value weights), and produces:

  1. A Markdown report at Private/reports/weekly/YYYY-Www.md
  2. A Telegram summary (~5 lines) with link back to the full report
  3. A git commit + push to the private holdings-reports repo

Per-holding aggregation:
  - latest verdict (UNDERPERFORMING / ON_TRACK / OUTPERFORMING / INSUFFICIENT_DATA)
  - signal trend over the week (counts of GREEN/AMBER/RED days)
  - latest 1/3/5/10-yr annualised return

Portfolio-level:
  - weighted 10-yr return = SUM(value_gbp * holding_10yr) / SUM(value_gbp)
  - on-track / underperforming vs user's target range

Recommendations:
  - SELL: UNDERPERFORMING holdings, or majority-RED over the week
  - HOLD: ON_TRACK, or majority-GREEN
  - REVIEW: OUTPERFORMING with declining recent (5yr < 10yr meaningfully)
  - BUY candidates: opportunities appearing in 50%+ of week's reports, MEDIUM+ risk
  - WATCHLIST hits: any watchlist name surfacing in opportunities

No Claude API spend — pure aggregation. Fast, free, deterministic.

Run:
    cd holdings-agent
    py weekly_review.py
"""

import json
import os
import sys
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path

from dotenv import load_dotenv

HOLDINGS_AGENT_DIR = Path(__file__).parent
TRADING_SETUP_DIR  = HOLDINGS_AGENT_DIR.parent
ENV_FILE           = TRADING_SETUP_DIR / ".env"
load_dotenv(ENV_FILE, override=True)

PRIVATE_DIR = Path(os.environ.get(
    "HOLDINGS_PRIVATE_DIR",
    str(Path.home() / "OneDrive" / "Documents" / "Private Investments"),
))
HOLDINGS_FILE = PRIVATE_DIR / "holdings.json"
PENSION_DOCX  = PRIVATE_DIR / "Pension.docx"
PLAN_DOCX     = PRIVATE_DIR / "FinancialPlan.docx"
REPORTS_DIR   = PRIVATE_DIR / "reports"
ARCHIVE_DIR   = REPORTS_DIR / "archive"
WEEKLY_DIR    = REPORTS_DIR / "weekly"

REPO_URL = "https://github.com/ballikov-lgtm/holdings-reports"

TARGET_MIN = 10.0
TARGET_MAX = 14.0
WINDOW_DAYS = 7

SIGNAL_EMOJI = {"GREEN": "🟢", "AMBER": "🟠", "RED": "🔴"}


# ─── DATA LOADING ────────────────────────────────────────────────────────────

def load_json(path: Path):
    if not path.exists():
        return None
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def load_week_archives(today_d: date, window: int = WINDOW_DAYS):
    """Return list of (date, data) for the past `window` days that have archives."""
    out = []
    if not ARCHIVE_DIR.exists():
        return out
    for delta in range(window):
        d = today_d - timedelta(days=delta)
        path = ARCHIVE_DIR / f"holdings-alerts-{d.isoformat()}.json"
        data = load_json(path)
        if data is not None:
            out.append((d, data))
    out.sort(key=lambda x: x[0])  # oldest first
    return out


# ─── AGGREGATION ─────────────────────────────────────────────────────────────

def aggregate_per_holding(week):
    """Build per-holding aggregate across the week."""
    by_id = defaultdict(lambda: {
        "name": "",
        "signal_days": Counter(),
        "latest_signal": None,
        "latest_verdict": None,
        "latest_returns": None,
        "latest_benchmark": None,
        "latest_summary": "",
        "appearances": 0,
    })

    for d, data in week:
        for h in data.get("holdings", []):
            agg = by_id[h["id"]]
            agg["name"] = h["name"]
            sig = (h.get("signal") or "AMBER").upper()
            agg["signal_days"][sig] += 1
            agg["appearances"] += 1
            # Latest values from most recent archive
            agg["latest_signal"]    = sig
            agg["latest_summary"]   = h.get("summary", "")
            perf = h.get("performance", {}) or {}
            if perf:
                agg["latest_verdict"]   = perf.get("vs_target")
                agg["latest_returns"]   = perf.get("annualised_returns_pct")
                agg["latest_benchmark"] = perf.get("benchmark")
    return by_id


def aggregate_opportunities(week):
    """Count how many days each opportunity appears + capture latest details."""
    by_name = defaultdict(lambda: {
        "name": "",
        "days_seen": 0,
        "risk_levels": Counter(),
        "latest_rationale": "",
        "latest_outlook": "",
        "type": "",
    })

    for d, data in week:
        for o in data.get("opportunities", []):
            key = o["name"].strip().lower()
            agg = by_name[key]
            agg["name"] = o["name"]
            agg["days_seen"] += 1
            risk = (o.get("risk_level") or "MEDIUM").upper()
            agg["risk_levels"][risk] += 1
            agg["latest_rationale"] = o.get("rationale", "")
            agg["latest_outlook"]   = o.get("predicted_outlook", "")
            agg["type"]             = o.get("type", "")
    return by_name


# ─── PORTFOLIO MATH ──────────────────────────────────────────────────────────

def compute_portfolio_metrics(holdings_data, holdings_agg):
    """Weighted 10-yr return for the portfolio, using value_gbp weights."""
    weighted_sum = 0.0
    weight_total = 0.0
    rows = []
    for h in holdings_data.get("holdings", []):
        agg = holdings_agg.get(h["id"])
        value = h.get("value_gbp")
        if not value:
            continue
        ret_10yr = None
        if agg and agg["latest_returns"]:
            ret_10yr = agg["latest_returns"].get("10yr")
        if ret_10yr is not None:
            weighted_sum += value * ret_10yr
            weight_total += value
            rows.append((h["name"], value, ret_10yr))

    weighted_10yr = (weighted_sum / weight_total) if weight_total else None
    return {
        "weighted_10yr_pct": round(weighted_10yr, 2) if weighted_10yr is not None else None,
        "weighted_value_gbp": round(weight_total, 2),
        "contributing_rows": rows,
    }


# ─── RECOMMENDATIONS ─────────────────────────────────────────────────────────

def _best_available_return(returns: dict):
    """Pick the longest available annualised return. Returns (label, value) or (None, None)."""
    for key in ("10yr", "5yr", "3yr", "1yr"):
        v = returns.get(key)
        if v is not None:
            return key, v
    return None, None


def derive_recommendations(holdings_agg, holdings_data):
    """Per-holding sell/hold/review verdict."""
    watchlist_names = {w["name"].strip().lower() for w in holdings_data.get("watchlist", [])}
    holding_values = {h["id"]: h.get("value_gbp") for h in holdings_data.get("holdings", [])}

    recs = []
    for hid, agg in holdings_agg.items():
        days = sum(agg["signal_days"].values())
        red_pct = (agg["signal_days"].get("RED", 0) / days) if days else 0
        verdict = agg.get("latest_verdict")
        returns = agg.get("latest_returns") or {}
        r10 = returns.get("10yr")
        r5  = returns.get("5yr")
        best_label, best_value = _best_available_return(returns)

        action = "HOLD"
        urgency = "low"
        reason = []

        if verdict == "UNDERPERFORMING":
            action = "SELL"
            urgency = "high"
            if best_value is not None:
                reason.append(f"{best_label} return {best_value:.1f}% is below the {TARGET_MIN:g}% target floor")
            else:
                reason.append(f"lens classified as UNDERPERFORMING (no return figures available)")
        elif red_pct >= 0.5:
            action = "SELL"
            urgency = "high"
            reason.append(f"signal was RED on {agg['signal_days']['RED']} of {days} days this week")
        elif verdict == "OUTPERFORMING" and r5 is not None and r10 is not None and r5 < (r10 - 5):
            action = "REVIEW"
            urgency = "medium"
            reason.append(f"10-yr return strong ({r10:.1f}%) but 5-yr ({r5:.1f}%) has dropped meaningfully — possible momentum loss")
        elif verdict == "ON_TRACK":
            action = "HOLD"
            urgency = "low"
            reason.append(f"10-yr return {r10:.1f}% is inside target range {TARGET_MIN:g}-{TARGET_MAX:g}%")
        elif verdict == "OUTPERFORMING":
            action = "HOLD"
            urgency = "low"
            if r10 is not None:
                reason.append(f"10-yr return {r10:.1f}% comfortably above target")
            else:
                reason.append(f"classified OUTPERFORMING (10-yr not available; using shorter periods)")
        elif verdict == "INSUFFICIENT_DATA":
            action = "HOLD"
            urgency = "low"
            if best_value is not None:
                reason.append(f"fund younger than 10yr — {best_label} return is {best_value:.1f}%; looks healthy")
            else:
                reason.append("fund younger than 10yr — performance figures unavailable")
        elif red_pct >= 0.25:
            action = "REVIEW"
            urgency = "medium"
            reason.append(f"RED on some days ({agg['signal_days']['RED']}/{days}) — investigate news")

        recs.append({
            "id":      hid,
            "name":    agg["name"],
            "action":  action,
            "urgency": urgency,
            "reason":  "; ".join(reason),
            "value_gbp": holding_values.get(hid),
            "latest_verdict": verdict,
            "10yr_pct": r10,
            "signal_trend": dict(agg["signal_days"]),
        })

    sell_value = sum(r["value_gbp"] or 0 for r in recs if r["action"] == "SELL")
    return recs, sell_value, watchlist_names


def _watchlist_match(name: str, watchlist_names: set) -> bool:
    """Fuzzy-ish match — substring either direction handles 'X Fund' vs 'X'."""
    n = name.strip().lower()
    for w in watchlist_names:
        if not w:
            continue
        if n == w or w in n or n in w:
            return True
    return False


def derive_buy_candidates(opps_agg, watchlist_names, total_days):
    """Opportunities that appeared in 50%+ of week's reports, MEDIUM+ risk."""
    candidates = []
    threshold_days = max(1, total_days // 2)
    for key, agg in opps_agg.items():
        if agg["days_seen"] < threshold_days:
            continue
        # Most common risk level this week
        risks = agg["risk_levels"]
        most_common_risk = risks.most_common(1)[0][0] if risks else "MEDIUM"
        if most_common_risk == "LOW":
            continue  # only surface MEDIUM+ for action
        is_watchlist = _watchlist_match(agg["name"], watchlist_names)
        candidates.append({
            "name":            agg["name"],
            "type":            agg["type"],
            "days_seen":       agg["days_seen"],
            "total_days":      total_days,
            "risk_level":      most_common_risk,
            "rationale":       agg["latest_rationale"],
            "outlook":         agg["latest_outlook"],
            "is_watchlist":    is_watchlist,
        })
    # Sort: watchlist hits first, then by days_seen desc
    candidates.sort(key=lambda c: (not c["is_watchlist"], -c["days_seen"]))
    return candidates


# ─── MARKDOWN BUILDER ────────────────────────────────────────────────────────

def fmt_pct(v):
    return f"{v:.1f}%" if isinstance(v, (int, float)) else "—"


def fmt_value(v):
    return f"£{int(v):,}" if v else "—"


# ─── RETIREMENT PROJECTION ───────────────────────────────────────────────────

def _future_value(present_value: float, annual_rate: float, years: float,
                  annual_contribution: float = 0.0) -> float:
    """
    Future value of a present sum plus annual contributions, compounded annually.
    FV = PV*(1+r)^n + PMT*((1+r)^n - 1)/r
    """
    if years <= 0:
        return present_value
    growth = (1 + annual_rate) ** years
    fv = present_value * growth
    if annual_contribution and annual_rate > 0:
        fv += annual_contribution * ((growth - 1) / annual_rate)
    elif annual_contribution:
        fv += annual_contribution * years
    return fv


def project_retirement(pension: dict, holdings_total_gbp: float,
                       holdings_expected_return_pct: float):
    """Project total wealth at the target retirement age. Returns dict or None.

    Returns None if pension data is missing or unfilled — caller skips the section.
    """
    if pension is None or pension.get("_looks_unfilled"):
        return None

    dob_str = pension.get("date_of_birth")
    target_age = pension.get("target_retirement_age")
    if not dob_str or not target_age:
        return None

    try:
        dob = date.fromisoformat(dob_str)
    except ValueError:
        return None

    today_d = date.today()
    # Approximate target retirement date (same calendar day, target_age years later)
    try:
        target_date = date(dob.year + int(target_age), dob.month, dob.day)
    except ValueError:
        # Handles Feb 29 birthdays — fall back to Feb 28
        target_date = date(dob.year + int(target_age), dob.month, min(dob.day, 28))

    years_to = max(0.0, (target_date - today_d).days / 365.25)
    current_age = (today_d - dob).days / 365.25

    pension_value    = pension.get("current_value_gbp") or 0.0
    pension_return   = (pension.get("expected_annual_return_pct") or 0.0) / 100.0
    pension_monthly  = ((pension.get("monthly_contribution_gbp") or 0.0)
                       + (pension.get("employer_monthly_contribution_gbp") or 0.0))
    pension_annual_contrib = pension_monthly * 12

    holdings_return = (holdings_expected_return_pct or TARGET_MIN) / 100.0

    pension_fv  = _future_value(pension_value, pension_return, years_to, pension_annual_contrib)
    holdings_fv = _future_value(holdings_total_gbp, holdings_return, years_to, 0.0)

    projected_total = pension_fv + holdings_fv
    target_pot      = pension.get("target_retirement_pot_gbp") or 0.0
    surplus_gbp     = projected_total - target_pot     # positive = ahead, negative = behind

    # If behind, what extra MONTHLY contribution would close the gap by retirement?
    required_extra_monthly = 0.0
    if surplus_gbp < 0 and years_to > 0 and pension_return > 0:
        shortfall = -surplus_gbp
        annuity_factor = ((1 + pension_return) ** years_to - 1) / pension_return
        required_extra_annual = shortfall / annuity_factor
        required_extra_monthly = required_extra_annual / 12
    elif surplus_gbp < 0 and years_to > 0:
        # zero growth fallback
        required_extra_monthly = (-surplus_gbp) / (years_to * 12)

    return {
        "current_age_years":           round(current_age, 1),
        "target_retirement_age":       target_age,
        "years_to_retirement":         round(years_to, 1),
        "current_holdings_gbp":        round(holdings_total_gbp, 2),
        "current_pension_gbp":         round(pension_value, 2),
        "current_total_wealth_gbp":    round(holdings_total_gbp + pension_value, 2),
        "projected_holdings_gbp":      round(holdings_fv, 2),
        "projected_pension_gbp":       round(pension_fv, 2),
        "projected_total_gbp":         round(projected_total, 2),
        "target_pot_gbp":              round(target_pot, 2),
        "surplus_gbp":                 round(surplus_gbp, 2),
        "on_track":                    surplus_gbp >= 0,
        "required_extra_monthly_gbp":  round(required_extra_monthly, 2),
        "assumed_holdings_return_pct": round(holdings_return * 100, 1),
        "assumed_pension_return_pct":  round(pension_return * 100, 1),
        "pension_provider":            pension.get("provider"),
        "pension_plan":                pension.get("plan_name"),
        "monthly_pension_contribution_gbp": pension_monthly,
    }


def signal_emoji_seq(signal_days):
    parts = []
    for sig, count in signal_days.items():
        emoji = SIGNAL_EMOJI.get(sig, "")
        if count and emoji:
            parts.append(f"{emoji}×{count}")
    return " ".join(parts) if parts else "—"


def _md_render_allocation(allocation):
    """Render the Suggested Allocation section as Markdown. Empty if allocator skipped."""
    if not allocation or allocation.get("_skipped"):
        if not allocation:
            return []
        return [
            "## Suggested allocation",
            "",
            f"_{allocation.get('exec_summary', 'No allocation this week.')}_",
            "",
        ]

    capital = allocation.get("_available_capital_gbp", 0)
    lines = []
    lines.append("## Suggested allocation")
    lines.append("")
    lines.append(f"**Capital to deploy:** £{int(capital):,}")
    lines.append("")
    lines.append(f"_{allocation.get('exec_summary', '')}_")
    lines.append("")
    lines.append("| Fund | Risk | Amount | % | Action |")
    lines.append("|------|------|--------|---|--------|")
    for a in allocation.get("allocations", []):
        star = " ⭐" if a.get("is_watchlist") else ""
        lines.append(
            f"| **{a['fund_name']}**{star} | {a['risk_level']} | "
            f"£{int(a['amount_gbp']):,} | {a['percentage']:.1f}% | {a['action']} |"
        )
    lines.append("")
    lines.append(f"**Portfolio shape:** {allocation.get('portfolio_shape', '—')}")
    lines.append("")

    if allocation.get("allocations"):
        lines.append("### Per-position rationale")
        lines.append("")
        for a in allocation["allocations"]:
            star = " ⭐" if a.get("is_watchlist") else ""
            lines.append(f"**{a['fund_name']}**{star} — £{int(a['amount_gbp']):,} ({a['action']}, {a['risk_level']})")
            lines.append("")
            lines.append(a.get("rationale", "—"))
            lines.append("")

    outlook = allocation.get("expected_outlook")
    if outlook:
        lines.append("### Expected outlook")
        lines.append("")
        lines.append(outlook)
        lines.append("")

    caveats = allocation.get("caveats", [])
    if caveats:
        lines.append("### Important caveats")
        lines.append("")
        for c in caveats:
            lines.append(f"- {c}")
        lines.append("")

    if not allocation.get("_total_matches_available", True):
        lines.append(f"⚠️ _Note: allocated £{int(allocation.get('_total_allocated_gbp', 0)):,} "
                     f"vs available £{int(capital):,} — agent failed to balance to total._")
        lines.append("")

    return lines


def _md_render_recommendation(rec, full_holding_data=None):
    """Render a single recommendation as Markdown with full evidence."""
    lines = []
    name = rec["name"]
    urgency_tag = " · 🚨 HIGH URGENCY" if rec.get("urgency") == "high" else ""
    verdict     = rec.get("latest_verdict") or "—"
    value_str   = f" ({fmt_value(rec['value_gbp'])})" if rec.get('value_gbp') else ""

    lines.append(f"#### {name}{value_str}{urgency_tag}")
    lines.append("")
    lines.append(f"- **Verdict:** {verdict.replace('_', ' ')}")
    lines.append(f"- **Why:** {rec['reason']}")

    # Signal trend over the week
    if rec.get("signal_trend"):
        trend_parts = []
        for sig, count in rec["signal_trend"].items():
            emoji = {"GREEN": "🟢", "AMBER": "🟠", "RED": "🔴"}.get(sig, "")
            if count and emoji:
                trend_parts.append(f"{emoji}×{count}")
        if trend_parts:
            lines.append(f"- **Signal this week:** {' '.join(trend_parts)}")

    # Full lens evidence
    if full_holding_data:
        summary = (full_holding_data.get("summary") or "").strip()
        if summary:
            lines.append("")
            lines.append(f"**Lens summary:** {summary}")

        bullets = full_holding_data.get("bullets") or []
        if bullets:
            lines.append("")
            lines.append("**Evidence:**")
            for b in bullets:
                lines.append(f"- {b}")

        # Performance table
        perf = full_holding_data.get("performance") or {}
        ret  = perf.get("annualised_returns_pct") or {}
        bm   = perf.get("benchmark") or {}
        if any(ret.values()):
            lines.append("")
            lines.append("**Performance:**")
            lines.append("")
            lines.append("| Period | Fund | Benchmark (10-yr only) |")
            lines.append("|--------|------|------------------------|")
            for period in ("1yr", "3yr", "5yr", "10yr"):
                v = ret.get(period)
                v_str = fmt_pct(v) if v is not None else "—"
                bm_cell = fmt_pct(bm.get("annualised_10yr_pct")) if period == "10yr" else ""
                lines.append(f"| {period} | {v_str} | {bm_cell} |")
            if bm.get("name"):
                lines.append(f"")
                lines.append(f"_Benchmark: {bm['name']}_")

        sources = full_holding_data.get("sources_used") or []
        if sources:
            lines.append("")
            lines.append(f"**Sources:** {' · '.join(sources[:5])}")

    lines.append("")
    return lines


def build_markdown(week, holdings_agg, opps_agg, portfolio, recs, buys, watchlist_names,
                   retirement=None, latest_holdings_by_id=None, allocation=None):
    week_start = week[0][0]
    week_end   = week[-1][0]
    iso_year, iso_week, _ = week_end.isocalendar()
    title_date = f"{iso_year}-W{iso_week:02d}"

    sells   = [r for r in recs if r["action"] == "SELL"]
    holds   = [r for r in recs if r["action"] == "HOLD"]
    reviews = [r for r in recs if r["action"] == "REVIEW"]
    sell_value_total = sum(r["value_gbp"] or 0 for r in sells)

    lines = []
    lines.append(f"# Weekly Holdings Review — {title_date}")
    lines.append("")
    lines.append(f"_Period: {week_start.isoformat()} to {week_end.isoformat()} ({len(week)} report days)_")
    lines.append("")
    lines.append("> 📄 A richer HTML version of this report is in the same folder with the same name and `.html` extension. Open it for the full evidence behind each recommendation (lens summaries, performance tables, source links).")
    lines.append("")
    lines.append("---")
    lines.append("")

    # Portfolio summary
    lines.append("## Portfolio summary")
    lines.append("")
    w10 = portfolio["weighted_10yr_pct"]
    if w10 is not None:
        on_target = "ON TARGET" if TARGET_MIN <= w10 <= TARGET_MAX else (
            "BELOW TARGET" if w10 < TARGET_MIN else "ABOVE TARGET"
        )
        lines.append(f"- **Weighted 10-yr return:** {fmt_pct(w10)} ({on_target}; target {TARGET_MIN:g}-{TARGET_MAX:g}%)")
        lines.append(f"- **Tracked value:** {fmt_value(portfolio['weighted_value_gbp'])} (holdings with both value AND 10-yr data)")
    else:
        lines.append(f"- **Weighted 10-yr return:** insufficient data (no holdings have both `value_gbp` AND 10-yr return populated)")
    lines.append(f"- **Action breakdown:** {len(sells)} SELL · {len(reviews)} REVIEW · {len(holds)} HOLD")
    if sell_value_total:
        lines.append(f"- **Capital potentially freed by SELLs:** {fmt_value(sell_value_total)}")
    lines.append("")

    # Retirement projection summary
    if retirement:
        lines.append("## Retirement projection")
        lines.append("")
        status = "✅ ON TRACK" if retirement["on_track"] else "⚠️ BEHIND TARGET"
        lines.append(f"- **Status:** {status} for age {retirement['target_retirement_age']}")
        lines.append(f"- **Current total wealth:** {fmt_value(retirement['current_total_wealth_gbp'])} "
                     f"(holdings {fmt_value(retirement['current_holdings_gbp'])} + pension {fmt_value(retirement['current_pension_gbp'])})")
        lines.append(f"- **Projected at age {retirement['target_retirement_age']}:** {fmt_value(retirement['projected_total_gbp'])} "
                     f"(target {fmt_value(retirement['target_pot_gbp'])}, "
                     f"{'surplus' if retirement['surplus_gbp'] >= 0 else 'shortfall'} "
                     f"{fmt_value(abs(retirement['surplus_gbp']))})")
        lines.append(f"- **Years to retirement:** {retirement['years_to_retirement']:.1f}")
        if not retirement["on_track"] and retirement["required_extra_monthly_gbp"] > 0:
            lines.append(f"- **Required extra contribution:** {fmt_value(retirement['required_extra_monthly_gbp'])}/month "
                         f"on top of your current {fmt_value(retirement['monthly_pension_contribution_gbp'])}/month")
        lines.append("")

    # Suggested allocation — Phase 7 addition. Shows up high in the report since
    # it's the most actionable section when the user has capital to deploy.
    if allocation:
        lines.extend(_md_render_allocation(allocation))

    # Recommendations — with full evidence per holding
    latest = latest_holdings_by_id or {}
    lines.append("## Recommendations with evidence")
    lines.append("")
    if sells:
        lines.append("### 🔴 SELL")
        lines.append("")
        for r in sells:
            lines.extend(_md_render_recommendation(r, latest.get(r["id"])))
    if reviews:
        lines.append("### 🟠 REVIEW")
        lines.append("")
        for r in reviews:
            lines.extend(_md_render_recommendation(r, latest.get(r["id"])))
    if holds:
        lines.append("### 🟢 HOLD")
        lines.append("")
        for r in holds:
            lines.extend(_md_render_recommendation(r, latest.get(r["id"])))

    # Buy candidates
    lines.append("## Buy candidates (where to redeploy)")
    lines.append("")
    if not buys:
        lines.append("_No opportunities appeared in 50%+ of this week's reports at MEDIUM+ risk._")
    else:
        for b in buys:
            wl_flag = " ⭐ on your watchlist" if b["is_watchlist"] else ""
            lines.append(f"### {b['name']} ({b['risk_level']}){wl_flag}")
            lines.append(f"- Seen on {b['days_seen']} of {b['total_days']} report days · Type: {b['type']}")
            if b["outlook"]:
                lines.append(f"- Outlook: {b['outlook']}")
            if b["rationale"]:
                lines.append(f"- Rationale: {b['rationale']}")
            lines.append("")

    # Redeployment hint
    if sells and buys:
        lines.append("## Redeployment hint")
        lines.append("")
        lines.append(
            f"Proceeds from SELL candidates (~{fmt_value(sell_value_total)}) could flow into the buy candidates above. "
            f"Spread across {min(3, len(buys))} of them keeps single-fund concentration low."
        )
        lines.append("")

    # Footer
    lines.append("---")
    lines.append("")
    lines.append(f"_Generated by holdings-agent weekly_review.py. Source data: [holdings-reports repo]({REPO_URL})._")
    return "\n".join(lines)


# ─── TELEGRAM SUMMARY ────────────────────────────────────────────────────────

def build_telegram_summary(title_date, portfolio, recs, buys):
    sells   = [r for r in recs if r["action"] == "SELL"]
    reviews = [r for r in recs if r["action"] == "REVIEW"]

    lines = [f"<b>Weekly review · {title_date}</b>"]
    w10 = portfolio["weighted_10yr_pct"]
    if w10 is not None:
        marker = "✅" if TARGET_MIN <= w10 <= TARGET_MAX else ("⚠️" if w10 < TARGET_MIN else "📈")
        lines.append(f"{marker} Portfolio 10-yr: {w10:.1f}% (target {TARGET_MIN:g}-{TARGET_MAX:g}%)")
    if sells:
        lines.append(f"\n🔴 <b>SELL ({len(sells)}):</b>")
        for r in sells[:3]:
            lines.append(f"• {r['name']}")
    if reviews:
        lines.append(f"\n🟠 <b>REVIEW ({len(reviews)}):</b>")
        for r in reviews[:3]:
            lines.append(f"• {r['name']}")
    if buys:
        lines.append(f"\n✨ <b>Buy candidates ({len(buys)}):</b>")
        for b in buys[:3]:
            star = " ⭐" if b["is_watchlist"] else ""
            lines.append(f"• {b['name']} ({b['risk_level']}){star}")
    lines.append(f'\n<a href="{REPO_URL}">Full report on GitHub</a>')
    return "\n".join(lines)


# ─── MAIN ────────────────────────────────────────────────────────────────────

def main() -> int:
    today_d = date.today()
    week = load_week_archives(today_d, WINDOW_DAYS)
    if len(week) < 1:
        print(f"No archives in past {WINDOW_DAYS} days at {ARCHIVE_DIR}.")
        print("Nothing to review — run lens.py first.")
        return 1

    print(f"Loaded {len(week)} archive(s): {week[0][0]} to {week[-1][0]}")

    holdings_data = load_json(HOLDINGS_FILE)
    if not holdings_data:
        print(f"ERROR: holdings.json not found at {HOLDINGS_FILE}.")
        return 1

    # Optional pension data (None if file missing or unfilled)
    sys.path.insert(0, str(HOLDINGS_AGENT_DIR))
    from pension_importer import import_pension_from_docx
    try:
        pension = import_pension_from_docx(PENSION_DOCX)
        if pension is None:
            print("  No Pension.docx found — retirement projection skipped.")
        elif pension.get("_looks_unfilled"):
            print("  Pension.docx is still using placeholder values — retirement projection skipped.")
        else:
            print(f"  Loaded pension: {pension.get('provider')} — current value {pension.get('current_value_gbp')}")
    except Exception as exc:
        print(f"  ! Pension import failed: {exc}")
        pension = None

    holdings_agg = aggregate_per_holding(week)
    opps_agg     = aggregate_opportunities(week)
    portfolio    = compute_portfolio_metrics(holdings_data, holdings_agg)
    recs, sell_value, watchlist_names = derive_recommendations(holdings_agg, holdings_data)
    buys = derive_buy_candidates(opps_agg, watchlist_names, len(week))

    # Total current holdings value for retirement projection
    holdings_total_gbp = sum(
        (h.get("value_gbp") or 0) for h in holdings_data.get("holdings", [])
    )
    # Use portfolio weighted 10-yr return as forward projection; fallback to target floor
    expected_holdings_return = portfolio["weighted_10yr_pct"] if portfolio["weighted_10yr_pct"] is not None else TARGET_MIN
    retirement = project_retirement(pension, holdings_total_gbp, expected_holdings_return)

    # Latest archive's full per-holding data — needed for HTML evidence cards
    latest_holdings = week[-1][1].get("holdings", [])
    latest_holdings_by_id = {h["id"]: h for h in latest_holdings}

    # Allocation recommendation — combines SELL proceeds + uninvested cash from FinancialPlan
    allocation = None
    try:
        from financial_plan_importer import import_plan_from_docx
        plan = import_plan_from_docx(PLAN_DOCX)
    except Exception as exc:
        print(f"  ! FinancialPlan import failed: {exc}")
        plan = None

    if plan is None:
        print("  No FinancialPlan.docx found — allocation section skipped.")
    elif plan.get("_looks_unfilled"):
        print("  FinancialPlan.docx looks unedited — allocation section skipped.")
    else:
        sells = [r for r in recs if r["action"] == "SELL"]
        sell_value = sum(r["value_gbp"] or 0 for r in sells)
        cash       = plan.get("cash_available_gbp", 0)
        available  = sell_value + cash

        if available <= 0:
            allocation = {
                "exec_summary": "No capital available to allocate (no SELL recommendations and no uninvested cash).",
                "allocations": [], "_skipped": True, "_reason": "no_capital",
                "portfolio_shape": "—", "expected_outlook": "—", "caveats": [],
                "_total_allocated_gbp": 0, "_available_capital_gbp": 0,
                "_total_matches_available": True,
            }
        else:
            print(f"  Computing allocation: £{int(available):,} (£{int(sell_value):,} from SELLs + £{int(cash):,} cash)")
            try:
                from allocator import build_candidate_pool, compute_allocation
                holds_for_topup = [r for r in recs if r["action"] == "HOLD"]
                candidates = build_candidate_pool(
                    buy_candidates=buys,
                    hold_recs=holds_for_topup,
                    latest_holdings_by_id=latest_holdings_by_id,
                    plan=plan,
                    watchlist_names=watchlist_names,
                )
                allocation = compute_allocation(
                    available_capital_gbp=available,
                    capital_sources={"from_sells": sell_value, "from_cash": cash},
                    candidates=candidates,
                    plan=plan,
                    sell_recs=sells,
                    holdings_summary=None,
                )
                if allocation.get("_total_matches_available", False):
                    print(f"  Allocation computed: {len(allocation.get('allocations', []))} positions, total balances exactly")
                else:
                    print(f"  Allocation computed: total mismatch (£{allocation.get('_total_allocated_gbp', 0):,} vs available £{int(available):,})")
            except Exception as exc:
                print(f"  ! Allocation failed: {exc}")
                allocation = {
                    "exec_summary": f"Allocation skipped this week: {exc}",
                    "allocations": [], "_skipped": True, "_reason": "error",
                    "portfolio_shape": "—", "expected_outlook": "—", "caveats": [],
                    "_total_allocated_gbp": 0, "_available_capital_gbp": available,
                    "_total_matches_available": True,
                }

    # Build outputs
    week_end = week[-1][0]
    week_start = week[0][0]
    iso_year, iso_week, _ = week_end.isocalendar()
    title_date = f"{iso_year}-W{iso_week:02d}"

    # Markdown
    md = build_markdown(week, holdings_agg, opps_agg, portfolio, recs, buys, watchlist_names,
                        retirement=retirement, latest_holdings_by_id=latest_holdings_by_id,
                        allocation=allocation)
    WEEKLY_DIR.mkdir(parents=True, exist_ok=True)
    md_path = WEEKLY_DIR / f"{title_date}.md"
    md_path.write_text(md, encoding="utf-8")
    print(f"Wrote {md_path.relative_to(PRIVATE_DIR)}")

    # HTML — richer report with full evidence per recommendation
    from render_html import render_html
    html_str = render_html(
        title_date=title_date,
        week_start=week_start,
        week_end=week_end,
        days_count=len(week),
        portfolio=portfolio,
        recs=recs,
        buys=buys,
        retirement=retirement,
        latest_holdings_by_id=latest_holdings_by_id,
        target_min=TARGET_MIN,
        target_max=TARGET_MAX,
        repo_url=REPO_URL,
        allocation=allocation,
    )
    html_path = WEEKLY_DIR / f"{title_date}.html"
    html_path.write_text(html_str, encoding="utf-8")
    print(f"Wrote {html_path.relative_to(PRIVATE_DIR)}")

    # Email — send HTML to configured recipients (soft fails)
    from email_notify import send_html as send_email_html
    sells_count   = sum(1 for r in recs if r["action"] == "SELL")
    reviews_count = sum(1 for r in recs if r["action"] == "REVIEW")
    email_subject = (
        f"Weekly holdings review {title_date} — "
        f"{sells_count} SELL / {reviews_count} REVIEW / {len(buys)} buy candidates"
    )
    email_result = send_email_html(email_subject, html_str)
    if email_result.get("ok"):
        print(f"Email sent to {len(email_result.get('recipients', []))} recipient(s)")
    elif email_result.get("skipped"):
        print(f"Email skipped: {email_result.get('reason')}")
    else:
        print(f"Email FAILED: {email_result.get('error', 'unknown')[:120]}")

    # Telegram summary
    from telegram_notify import send
    tg_msg = build_telegram_summary(title_date, portfolio, recs, buys)
    if retirement:
        marker = "✅" if retirement["on_track"] else "⚠️"
        tg_msg = tg_msg.replace(
            "<b>Weekly review",
            f"{marker} Retirement: {'on track' if retirement['on_track'] else 'behind'} "
            f"(age {retirement['target_retirement_age']})\n\n<b>Weekly review",
        )
    result = send(tg_msg, prefix=True)
    print(f"Telegram send: ok={result.get('ok', False) or result.get('skipped', False)}")

    # Git push (re-use lens.py helper if reports/ is a git repo)
    sys.path.insert(0, str(TRADING_SETUP_DIR / "research-agent" / "lens-holdings"))
    try:
        from lens import push_report_to_github
        push_report_to_github(REPORTS_DIR)
    except Exception as exc:
        print(f"  ! git sync helper unavailable: {exc}")

    # Console summary
    print()
    print(f"=== Summary {title_date} ===")
    w10 = portfolio["weighted_10yr_pct"]
    if w10 is not None:
        print(f"  Portfolio weighted 10-yr: {w10:.2f}% (target {TARGET_MIN:g}-{TARGET_MAX:g}%)")
    sells   = [r for r in recs if r["action"] == "SELL"]
    reviews = [r for r in recs if r["action"] == "REVIEW"]
    print(f"  SELL: {len(sells)} | REVIEW: {len(reviews)} | HOLD: {sum(1 for r in recs if r['action']=='HOLD')}")
    print(f"  BUY candidates: {len(buys)}")
    if retirement:
        print(f"  Retirement: {'ON TRACK' if retirement['on_track'] else 'BEHIND'} for age {retirement['target_retirement_age']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
