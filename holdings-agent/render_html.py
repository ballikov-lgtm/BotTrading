"""
holdings-agent/render_html.py  —  rich HTML renderer for the weekly review.

Takes the same aggregated data the Markdown renderer uses, plus the LATEST
archive's full holdings (lens summary + bullets + performance table + sources),
and emits a styled HTML report.

Email-safe inline CSS so the same file can be SendGrid-attached or emailed
later (Phase 4-something) without restyling.
"""

import html
from datetime import date


# ─── COLOUR PALETTE ──────────────────────────────────────────────────────────

SIGNAL_COLOURS = {
    "GREEN": ("#e6f4ea", "#1e6f37"),   # bg, fg
    "AMBER": ("#fff4d6", "#9a6700"),
    "RED":   ("#fde2e2", "#a40e0e"),
}

VERDICT_COLOURS = {
    "ON_TRACK":          ("#e6f4ea", "#1e6f37"),
    "OUTPERFORMING":     ("#e2eef9", "#0a4d8c"),
    "UNDERPERFORMING":   ("#fde2e2", "#a40e0e"),
    "INSUFFICIENT_DATA": ("#f0f0f0", "#555"),
}

ACTION_COLOURS = {
    "SELL":   ("#fde2e2", "#a40e0e"),
    "REVIEW": ("#fff4d6", "#9a6700"),
    "HOLD":   ("#e6f4ea", "#1e6f37"),
}


# ─── HELPERS ─────────────────────────────────────────────────────────────────

def esc(s):
    return html.escape(str(s)) if s is not None else "—"


def fmt_pct(v, digits=1):
    if isinstance(v, (int, float)):
        return f"{v:.{digits}f}%"
    return "—"


def fmt_gbp(v):
    if v in (None, 0):
        return "—" if v is None else "£0"
    return f"£{int(v):,}"


def fmt_gbp_signed(v):
    """For surplus/shortfall — show sign with colour cue elsewhere."""
    if v is None:
        return "—"
    if v >= 0:
        return f"+£{int(v):,}"
    return f"−£{int(abs(v)):,}"


def badge(text, bg, fg):
    return (f'<span style="background:{bg};color:{fg};padding:3px 10px;'
            f'border-radius:12px;font-size:12px;font-weight:600;'
            f'display:inline-block;letter-spacing:0.3px;">{esc(text)}</span>')


def signal_badge(signal):
    bg, fg = SIGNAL_COLOURS.get(signal, ("#f0f0f0", "#333"))
    return badge(signal, bg, fg)


def verdict_badge(verdict):
    if not verdict:
        return ""
    bg, fg = VERDICT_COLOURS.get(verdict, ("#f0f0f0", "#333"))
    return badge(verdict.replace("_", " "), bg, fg)


def action_badge(action):
    bg, fg = ACTION_COLOURS.get(action, ("#f0f0f0", "#333"))
    return badge(action, bg, fg)


# ─── SECTIONS ────────────────────────────────────────────────────────────────

def render_portfolio_summary(portfolio, recs, target_min, target_max):
    w10 = portfolio["weighted_10yr_pct"]
    sells   = [r for r in recs if r["action"] == "SELL"]
    reviews = [r for r in recs if r["action"] == "REVIEW"]
    holds   = [r for r in recs if r["action"] == "HOLD"]
    sell_value = sum(r["value_gbp"] or 0 for r in sells)

    if w10 is not None:
        if target_min <= w10 <= target_max:
            verdict = "ON TARGET"
            verdict_bg, verdict_fg = "#e6f4ea", "#1e6f37"
        elif w10 < target_min:
            verdict = "BELOW TARGET"
            verdict_bg, verdict_fg = "#fde2e2", "#a40e0e"
        else:
            verdict = "ABOVE TARGET"
            verdict_bg, verdict_fg = "#e2eef9", "#0a4d8c"
        w10_html = f'<span style="font-size:32px;font-weight:700;color:#222;">{w10:.1f}%</span>'
        verdict_html = badge(verdict, verdict_bg, verdict_fg)
    else:
        w10_html = '<span style="color:#888;">insufficient data</span>'
        verdict_html = ""

    rows_html = ""
    for nm, val, ret in portfolio["contributing_rows"]:
        rows_html += (f'<tr><td style="padding:6px 12px;">{esc(nm)}</td>'
                      f'<td style="padding:6px 12px;text-align:right;">{fmt_gbp(val)}</td>'
                      f'<td style="padding:6px 12px;text-align:right;">{fmt_pct(ret)}</td></tr>')

    return f"""
    <div style="border:1px solid #e0e0e0;border-radius:8px;padding:20px;margin-bottom:24px;background:#fafbfc;">
      <h2 style="margin:0 0 8px 0;font-size:18px;color:#222;">Portfolio summary</h2>
      <div style="display:flex;align-items:baseline;gap:16px;margin:12px 0;">
        <div>
          <div style="font-size:11px;color:#666;text-transform:uppercase;letter-spacing:1px;">Weighted 10-yr return</div>
          {w10_html}
        </div>
        <div>{verdict_html}</div>
      </div>
      <p style="margin:8px 0;color:#555;font-size:14px;">
        Target range: {target_min:g}–{target_max:g}% annualised. Calculated across holdings with BOTH a recorded value AND a 10-yr return figure (total {fmt_gbp(portfolio['weighted_value_gbp'])}).
      </p>
      {f'<table style="width:100%;border-collapse:collapse;margin-top:12px;font-size:13px;"><thead><tr style="background:#eee;"><th style="padding:6px 12px;text-align:left;">Contributing holding</th><th style="padding:6px 12px;text-align:right;">Value</th><th style="padding:6px 12px;text-align:right;">10-yr</th></tr></thead><tbody>{rows_html}</tbody></table>' if rows_html else ''}
      <div style="margin-top:16px;display:flex;gap:12px;flex-wrap:wrap;font-size:14px;">
        <div>🔴 SELL: <strong>{len(sells)}</strong></div>
        <div>🟠 REVIEW: <strong>{len(reviews)}</strong></div>
        <div>🟢 HOLD: <strong>{len(holds)}</strong></div>
        {f'<div>· Capital potentially freed: <strong>{fmt_gbp(sell_value)}</strong></div>' if sell_value else ''}
      </div>
    </div>
    """


def render_retirement_section(ret):
    if not ret:
        return ""
    on_track   = ret["on_track"]
    bg, fg     = ("#e6f4ea", "#1e6f37") if on_track else ("#fff4d6", "#9a6700")
    status     = "ON TRACK" if on_track else "BEHIND TARGET"
    surplus    = ret["surplus_gbp"]
    surplus_label = "Surplus" if surplus >= 0 else "Shortfall"
    surplus_colour = "#1e6f37" if surplus >= 0 else "#a40e0e"

    extra_monthly_html = ""
    if not on_track and ret["required_extra_monthly_gbp"] > 0:
        extra_monthly_html = (
            f'<p style="margin:12px 0 0;font-size:14px;color:#a40e0e;">'
            f'<strong>Required extra contribution:</strong> {fmt_gbp(ret["required_extra_monthly_gbp"])}/month '
            f'on top of your current £{int(ret["monthly_pension_contribution_gbp"]):,}/month to close the gap by age {ret["target_retirement_age"]}.</p>'
        )

    return f"""
    <div style="border:1px solid #e0e0e0;border-radius:8px;padding:20px;margin-bottom:24px;background:#fafbfc;">
      <h2 style="margin:0 0 8px 0;font-size:18px;color:#222;">Retirement projection — age {ret['target_retirement_age']}</h2>
      <div style="margin:8px 0;">{badge(status, bg, fg)}</div>
      <table style="width:100%;border-collapse:collapse;margin-top:12px;font-size:14px;">
        <tr><td style="padding:6px 0;color:#666;">Your current age</td><td style="padding:6px 0;text-align:right;"><strong>{ret['current_age_years']:.1f}</strong></td></tr>
        <tr><td style="padding:6px 0;color:#666;">Years to retirement</td><td style="padding:6px 0;text-align:right;"><strong>{ret['years_to_retirement']:.1f}</strong></td></tr>
        <tr><td colspan="2" style="border-top:1px solid #ddd;"></td></tr>
        <tr><td style="padding:6px 0;color:#666;">Current holdings value</td><td style="padding:6px 0;text-align:right;">{fmt_gbp(ret['current_holdings_gbp'])}</td></tr>
        <tr><td style="padding:6px 0;color:#666;">Current pension value</td><td style="padding:6px 0;text-align:right;">{fmt_gbp(ret['current_pension_gbp'])}</td></tr>
        <tr><td style="padding:6px 0;color:#222;"><strong>Current total wealth</strong></td><td style="padding:6px 0;text-align:right;"><strong>{fmt_gbp(ret['current_total_wealth_gbp'])}</strong></td></tr>
        <tr><td colspan="2" style="border-top:1px solid #ddd;"></td></tr>
        <tr><td style="padding:6px 0;color:#666;">Projected holdings at retirement</td><td style="padding:6px 0;text-align:right;">{fmt_gbp(ret['projected_holdings_gbp'])} <span style="color:#888;font-size:12px;">(@ {ret['assumed_holdings_return_pct']:g}%)</span></td></tr>
        <tr><td style="padding:6px 0;color:#666;">Projected pension at retirement</td><td style="padding:6px 0;text-align:right;">{fmt_gbp(ret['projected_pension_gbp'])} <span style="color:#888;font-size:12px;">(@ {ret['assumed_pension_return_pct']:g}%)</span></td></tr>
        <tr><td style="padding:6px 0;color:#222;"><strong>Projected total at age {ret['target_retirement_age']}</strong></td><td style="padding:6px 0;text-align:right;"><strong style="font-size:18px;">{fmt_gbp(ret['projected_total_gbp'])}</strong></td></tr>
        <tr><td style="padding:6px 0;color:#666;">Target pot at age {ret['target_retirement_age']}</td><td style="padding:6px 0;text-align:right;">{fmt_gbp(ret['target_pot_gbp'])}</td></tr>
        <tr><td style="padding:6px 0;color:#222;"><strong>{surplus_label} vs target</strong></td><td style="padding:6px 0;text-align:right;"><strong style="color:{surplus_colour};font-size:16px;">{fmt_gbp_signed(surplus)}</strong></td></tr>
      </table>
      {extra_monthly_html}
      <p style="margin:14px 0 0;font-size:12px;color:#888;font-style:italic;">
        Projection assumes the displayed return rates hold steady. Holdings return uses your portfolio's weighted 10-yr figure when available, else the {ret['assumed_holdings_return_pct']:g}% target floor. Not a guarantee.
      </p>
    </div>
    """


def render_recommendation_card(rec, full_holding_data=None):
    """A single rec card with full evidence (lens summary, bullets, performance table)."""
    action = rec["action"]
    name = rec["name"]
    urgency_hint = ""
    if rec.get("urgency") == "high":
        urgency_hint = ' <span style="color:#a40e0e;font-size:12px;font-weight:600;">[HIGH URGENCY]</span>'

    # Pull rich evidence from latest archive data
    perf_html = ""
    summary_html = ""
    bullets_html = ""
    sources_html = ""
    if full_holding_data:
        p = full_holding_data.get("performance") or {}
        ret = p.get("annualised_returns_pct") or {}
        bm = p.get("benchmark") or {}
        summary = full_holding_data.get("summary", "")
        bullets = full_holding_data.get("bullets", []) or []
        sources = full_holding_data.get("sources_used", []) or []

        if summary:
            summary_html = f'<p style="margin:10px 0;font-size:14px;color:#333;">{esc(summary)}</p>'
        if bullets:
            bullets_html = '<ul style="margin:8px 0 12px 20px;padding:0;font-size:13px;color:#444;">'
            for b in bullets:
                bullets_html += f'<li style="margin:4px 0;">{esc(b)}</li>'
            bullets_html += '</ul>'

        # Performance table
        if any(ret.values()):
            perf_html = (
                '<table style="width:100%;border-collapse:collapse;margin:12px 0;font-size:13px;">'
                '<thead><tr style="background:#eee;">'
                '<th style="padding:6px;text-align:left;">Period</th>'
                '<th style="padding:6px;text-align:right;">Fund</th>'
                '<th style="padding:6px;text-align:right;">Benchmark (10-yr only)</th>'
                '</tr></thead><tbody>'
            )
            for period in ("1yr", "3yr", "5yr", "10yr"):
                v = ret.get(period)
                bm_val = bm.get("annualised_10yr_pct") if period == "10yr" else None
                bm_cell = fmt_pct(bm_val) if period == "10yr" else ""
                perf_html += (f'<tr><td style="padding:6px;">{period}</td>'
                              f'<td style="padding:6px;text-align:right;font-weight:600;">{fmt_pct(v)}</td>'
                              f'<td style="padding:6px;text-align:right;color:#666;">{bm_cell}</td></tr>')
            perf_html += '</tbody></table>'
            if bm.get("name"):
                perf_html += f'<p style="margin:0 0 8px;font-size:12px;color:#888;">Benchmark: {esc(bm["name"])}</p>'

        if sources:
            sources_html = (
                '<p style="margin:6px 0 0;font-size:11px;color:#888;">Sources: '
                + " · ".join(esc(s) for s in sources[:5])
                + '</p>'
            )

    signal_trend_html = ""
    if rec.get("signal_trend"):
        trend_parts = []
        for sig, count in rec["signal_trend"].items():
            emoji = {"GREEN": "🟢", "AMBER": "🟠", "RED": "🔴"}.get(sig, "")
            if count and emoji:
                trend_parts.append(f"{emoji}×{count}")
        if trend_parts:
            signal_trend_html = (
                '<p style="margin:6px 0 12px;font-size:12px;color:#666;">'
                f'Signal this week: {" ".join(trend_parts)}</p>'
            )

    return f"""
    <div style="border:1px solid #e0e0e0;border-radius:8px;padding:16px 20px;margin-bottom:16px;background:#fff;">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
        {action_badge(action)}
        <strong style="font-size:15px;">{esc(name)}</strong>
        {urgency_hint}
      </div>
      <p style="margin:6px 0;font-size:13px;color:#444;">
        <strong>Why:</strong> {esc(rec['reason'])}
        {f' · Holding value: <strong>{fmt_gbp(rec["value_gbp"])}</strong>' if rec.get('value_gbp') else ''}
        {f' · Verdict: {verdict_badge(rec["latest_verdict"])}' if rec.get('latest_verdict') else ''}
      </p>
      {signal_trend_html}
      {summary_html}
      {bullets_html}
      {perf_html}
      {sources_html}
    </div>
    """


def render_buy_candidate(b):
    star = ' ⭐ <span style="color:#9a6700;font-size:12px;">on your watchlist</span>' if b["is_watchlist"] else ""
    risk_bg = {"LOW": "#e6f4ea", "MEDIUM": "#fff4d6", "HIGH": "#fde2e2"}.get(b["risk_level"], "#f0f0f0")
    risk_fg = {"LOW": "#1e6f37", "MEDIUM": "#9a6700", "HIGH": "#a40e0e"}.get(b["risk_level"], "#555")
    return f"""
    <div style="border:1px solid #e0e0e0;border-radius:8px;padding:16px 20px;margin-bottom:14px;background:#fff;">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
        {badge(b['risk_level'], risk_bg, risk_fg)}
        <strong style="font-size:15px;">{esc(b['name'])}</strong>
        {star}
      </div>
      <p style="margin:6px 0;color:#666;font-size:12px;">
        Seen on {b['days_seen']} of {b['total_days']} report days · Type: {esc(b['type'] or '—')}
      </p>
      {f'<p style="margin:8px 0;font-size:13px;color:#333;"><strong>Outlook:</strong> {esc(b["outlook"])}</p>' if b.get('outlook') else ''}
      {f'<p style="margin:8px 0;font-size:13px;color:#333;"><strong>Rationale:</strong> {esc(b["rationale"])}</p>' if b.get('rationale') else ''}
    </div>
    """


def render_allocation_section(allocation):
    """Render the Suggested Allocation section as HTML. Empty if skipped."""
    if not allocation:
        return ""
    if allocation.get("_skipped"):
        return (
            '<div style="border:1px solid #e0e0e0;border-radius:8px;padding:16px 20px;'
            'margin-bottom:24px;background:#fafbfc;">'
            f'<h2 style="margin:0 0 8px 0;font-size:18px;color:#222;">Suggested allocation</h2>'
            f'<p style="margin:0;color:#666;font-style:italic;">'
            f'{esc(allocation.get("exec_summary", "No allocation this week."))}</p>'
            '</div>'
        )

    capital = allocation.get("_available_capital_gbp", 0)

    # Allocation table
    rows_html = ""
    for a in allocation.get("allocations", []):
        risk = a.get("risk_level", "MEDIUM")
        risk_bg = {"LOW": "#e6f4ea", "LOW-MED": "#e6f4ea", "MEDIUM": "#fff4d6",
                   "MED-HIGH": "#fff4d6", "HIGH": "#fde2e2"}.get(risk, "#f0f0f0")
        risk_fg = {"LOW": "#1e6f37", "LOW-MED": "#1e6f37", "MEDIUM": "#9a6700",
                   "MED-HIGH": "#9a6700", "HIGH": "#a40e0e"}.get(risk, "#555")
        star = " ⭐" if a.get("is_watchlist") else ""
        action_label = a.get("action", "NEW")
        rows_html += (
            f'<tr>'
            f'<td style="padding:10px 12px;border-bottom:1px solid #eee;">'
            f'<strong>{esc(a["fund_name"])}</strong>{star}</td>'
            f'<td style="padding:10px 12px;border-bottom:1px solid #eee;">'
            f'{badge(risk, risk_bg, risk_fg)}</td>'
            f'<td style="padding:10px 12px;border-bottom:1px solid #eee;text-align:right;">'
            f'<strong>£{int(a["amount_gbp"]):,}</strong></td>'
            f'<td style="padding:10px 12px;border-bottom:1px solid #eee;text-align:right;color:#666;">'
            f'{a["percentage"]:.1f}%</td>'
            f'<td style="padding:10px 12px;border-bottom:1px solid #eee;font-size:12px;color:#666;">'
            f'{esc(action_label)}</td>'
            f'</tr>'
        )

    # Per-position rationale cards
    rationale_html = ""
    for a in allocation.get("allocations", []):
        star = ' ⭐' if a.get("is_watchlist") else ''
        rationale_html += (
            f'<div style="border-left:3px solid #1e3a5f;background:#fafbfc;'
            f'padding:10px 14px;margin:8px 0;border-radius:0 4px 4px 0;">'
            f'<div style="font-size:14px;"><strong>{esc(a["fund_name"])}</strong>{star} — '
            f'<span style="color:#1e3a5f;">£{int(a["amount_gbp"]):,}</span> '
            f'<span style="color:#666;font-size:12px;">({esc(a["action"])} · {esc(a["risk_level"])})</span></div>'
            f'<p style="margin:6px 0 0;font-size:13px;color:#444;">{esc(a.get("rationale", "—"))}</p>'
            f'</div>'
        )

    caveats_html = ""
    if allocation.get("caveats"):
        caveats_html = '<ul style="margin:8px 0 0 18px;padding:0;font-size:13px;color:#444;">'
        for c in allocation["caveats"]:
            caveats_html += f'<li style="margin:4px 0;">{esc(c)}</li>'
        caveats_html += '</ul>'

    mismatch_html = ""
    if not allocation.get("_total_matches_available", True):
        total = allocation.get("_total_allocated_gbp", 0)
        mismatch_html = (
            f'<p style="margin:8px 0 0;padding:10px;background:#fff4d6;color:#9a6700;'
            f'border-radius:4px;font-size:13px;">⚠️ Allocated £{int(total):,} vs available '
            f'£{int(capital):,} — agent failed to balance to total.</p>'
        )

    return f"""
    <div style="border:2px solid #1e3a5f;border-radius:8px;padding:20px;margin-bottom:24px;background:#fff;">
      <h2 style="margin:0 0 8px 0;font-size:20px;color:#1e3a5f;">Suggested allocation</h2>
      <p style="margin:4px 0 12px;font-size:14px;color:#555;">
        <strong>Capital to deploy:</strong> £{int(capital):,} ·
        <strong>Shape:</strong> {esc(allocation.get('portfolio_shape', '—'))}
      </p>
      <p style="margin:8px 0;font-size:14px;color:#333;font-style:italic;">{esc(allocation.get('exec_summary', ''))}</p>

      <table style="width:100%;border-collapse:collapse;margin:16px 0 8px;font-size:13px;">
        <thead><tr style="background:#1e3a5f;color:#fff;">
          <th style="padding:8px 12px;text-align:left;">Fund</th>
          <th style="padding:8px 12px;text-align:left;">Risk</th>
          <th style="padding:8px 12px;text-align:right;">Amount</th>
          <th style="padding:8px 12px;text-align:right;">%</th>
          <th style="padding:8px 12px;text-align:left;">Action</th>
        </tr></thead>
        <tbody>{rows_html}</tbody>
      </table>

      <h3 style="margin:18px 0 8px;font-size:15px;color:#1e3a5f;">Per-position rationale</h3>
      {rationale_html}

      <h3 style="margin:18px 0 6px;font-size:15px;color:#1e3a5f;">Expected outlook</h3>
      <p style="margin:0 0 12px;font-size:13px;color:#444;">{esc(allocation.get('expected_outlook', '—'))}</p>

      <h3 style="margin:18px 0 6px;font-size:15px;color:#1e3a5f;">Important caveats</h3>
      {caveats_html}

      {mismatch_html}
    </div>
    """


# ─── TOP-LEVEL RENDER ────────────────────────────────────────────────────────

def render_html(title_date, week_start, week_end, days_count, portfolio,
                recs, buys, retirement, latest_holdings_by_id,
                target_min, target_max, repo_url, allocation=None):
    sells   = [r for r in recs if r["action"] == "SELL"]
    reviews = [r for r in recs if r["action"] == "REVIEW"]
    holds   = [r for r in recs if r["action"] == "HOLD"]

    sells_html   = "".join(render_recommendation_card(r, latest_holdings_by_id.get(r["id"])) for r in sells)
    reviews_html = "".join(render_recommendation_card(r, latest_holdings_by_id.get(r["id"])) for r in reviews)
    holds_html   = "".join(render_recommendation_card(r, latest_holdings_by_id.get(r["id"])) for r in holds)
    buys_html    = "".join(render_buy_candidate(b) for b in buys) if buys else (
        '<p style="color:#666;font-style:italic;">No opportunities appeared in 50%+ of this week\'s reports at MEDIUM+ risk.</p>'
    )

    portfolio_html  = render_portfolio_summary(portfolio, recs, target_min, target_max)
    retirement_html = render_retirement_section(retirement)
    allocation_html = render_allocation_section(allocation)

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Weekly Holdings Review — {title_date}</title>
</head>
<body style="margin:0;padding:0;background:#f0f2f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#222;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f2f4;padding:24px 0;">
    <tr><td align="center">
      <table width="720" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.06);">
        <tr style="background:#1e3a5f;"><td style="padding:24px 28px;">
          <h1 style="margin:0;color:#fff;font-size:22px;">Weekly Holdings Review</h1>
          <p style="margin:6px 0 0;color:#93c5fd;font-size:14px;">
            {title_date} &nbsp;·&nbsp; {week_start.isoformat()} to {week_end.isoformat()} &nbsp;·&nbsp; {days_count} report days
          </p>
        </td></tr>
        <tr><td style="padding:24px 28px;">
          {portfolio_html}
          {retirement_html}
          {allocation_html}

          <h2 style="margin:24px 0 12px;font-size:18px;color:#222;">Recommendations with evidence</h2>
          {('<h3 style="font-size:14px;color:#a40e0e;margin:18px 0 8px;">🔴 SELL</h3>' + sells_html) if sells else ''}
          {('<h3 style="font-size:14px;color:#9a6700;margin:18px 0 8px;">🟠 REVIEW</h3>' + reviews_html) if reviews else ''}
          {('<h3 style="font-size:14px;color:#1e6f37;margin:18px 0 8px;">🟢 HOLD</h3>' + holds_html) if holds else ''}

          <h2 style="margin:32px 0 12px;font-size:18px;color:#222;">Buy candidates — where to redeploy</h2>
          {buys_html}
        </td></tr>
        <tr style="background:#f9fafb;border-top:1px solid #e5e7eb;"><td style="padding:16px 28px;">
          <p style="margin:0;font-size:12px;color:#888;">
            Generated by <code>holdings-agent weekly_review.py</code> ·
            <a href="{repo_url}" style="color:#1e3a5f;">Full archive on GitHub</a> ·
            Reports are for monitoring purposes only and are not financial advice.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>
"""
