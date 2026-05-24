"""
holdings-agent/daily_watch.py — daily change detector + Telegram alerter.

Reads the latest holdings-alerts.json and the most recent dated archive that's
strictly before today. Detects:
  - Per-holding signal changes (GREEN to AMBER, AMBER to RED, etc.)
  - Holdings that are AMBER/RED today but weren't present yesterday
  - New opportunities at MEDIUM+ risk level that weren't present yesterday

Pushes ONE concise Telegram message summarising changes. Silent if nothing
material changed (no notification noise).

Intended to run daily, AFTER lens.py:
    cd research-agent/lens-holdings && py lens.py
    cd ../../holdings-agent && py daily_watch.py
"""

import json
import os
import sys
from datetime import date
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
REPORTS_DIR  = PRIVATE_DIR / "reports"
LATEST_FILE  = REPORTS_DIR / "holdings-alerts.json"
ARCHIVE_DIR  = REPORTS_DIR / "archive"

REPO_URL = "https://github.com/ballikov-lgtm/holdings-reports"

SIGNAL_RANK = {"GREEN": 0, "AMBER": 1, "RED": 2}
RISK_RANK   = {"LOW": 0, "MEDIUM": 1, "HIGH": 2}


# ─── HELPERS ─────────────────────────────────────────────────────────────────

def load_json(path: Path):
    if not path.exists():
        return None
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def find_previous_archive(today_date: date):
    """Return (path, date) of the most recent archive strictly before today_date.
    Returns (None, None) if none found."""
    if not ARCHIVE_DIR.exists():
        return None, None
    candidates = sorted(ARCHIVE_DIR.glob("holdings-alerts-*.json"), reverse=True)
    for path in candidates:
        stem = path.stem  # holdings-alerts-2026-05-24
        try:
            d = date.fromisoformat(stem.replace("holdings-alerts-", ""))
        except ValueError:
            continue
        if d < today_date:
            return path, d
    return None, None


# ─── DIFF LOGIC ──────────────────────────────────────────────────────────────

def diff_holdings(today_list, prior_list):
    """Find signal upgrades + newly-alerting holdings."""
    prior_by_id = {h["id"]: h for h in prior_list}
    upgrades   = []
    new_alerts = []

    for h in today_list:
        sig_today = (h.get("signal") or "AMBER").upper()
        prior_h = prior_by_id.get(h["id"])

        if not prior_h:
            if sig_today in ("AMBER", "RED"):
                new_alerts.append({
                    "name":    h["name"],
                    "signal":  sig_today,
                    "summary": h.get("summary", ""),
                })
            continue

        sig_prior = (prior_h.get("signal") or "AMBER").upper()
        if SIGNAL_RANK.get(sig_today, 0) > SIGNAL_RANK.get(sig_prior, 0):
            upgrades.append({
                "name":        h["name"],
                "from_signal": sig_prior,
                "to_signal":   sig_today,
                "summary":     h.get("summary", ""),
            })

    return upgrades, new_alerts


def diff_opportunities(today_list, prior_list, min_risk: str = "MEDIUM"):
    """Opportunities present today but not yesterday, at or above min_risk."""
    prior_names = {o["name"].strip().lower() for o in prior_list}
    threshold = RISK_RANK.get(min_risk, 1)
    new = []
    for o in today_list:
        if o["name"].strip().lower() in prior_names:
            continue
        risk = (o.get("risk_level") or "MEDIUM").upper()
        if RISK_RANK.get(risk, 1) >= threshold:
            new.append({
                "name":      o["name"],
                "risk_level": risk,
                "rationale": o.get("rationale", ""),
            })
    return new


# ─── MESSAGE BUILDER ─────────────────────────────────────────────────────────

def _html_escape(s: str) -> str:
    return (s.replace("&", "&amp;")
             .replace("<", "&lt;")
             .replace(">", "&gt;"))


def _trim(s: str, n: int) -> str:
    s = (s or "").strip()
    return (s[:n - 1] + "…") if len(s) > n else s


def build_message(today_d: date, prior_d: date, upgrades, new_alerts, new_opps):
    """Return Telegram-ready HTML message, or None if nothing to report."""
    if not (upgrades or new_alerts or new_opps):
        return None

    lines = [
        f"<b>Holdings update</b> · {today_d.isoformat()} "
        f"(vs {prior_d.isoformat()})"
    ]

    if upgrades:
        lines.append("")
        lines.append("\U0001F534 <b>Signal changes:</b>")
        for u in upgrades:
            lines.append(
                f"• {_html_escape(u['name'])}: "
                f"{u['from_signal']} → {u['to_signal']}"
            )
            if u.get("summary"):
                lines.append(f"  <i>{_html_escape(_trim(u['summary'], 160))}</i>")

    if new_alerts:
        lines.append("")
        lines.append("⚠️ <b>New holdings worth checking:</b>")
        for a in new_alerts:
            lines.append(
                f"• {_html_escape(a['name'])}: {a['signal']}"
            )
            if a.get("summary"):
                lines.append(f"  <i>{_html_escape(_trim(a['summary'], 160))}</i>")

    if new_opps:
        lines.append("")
        lines.append("✨ <b>New opportunities:</b>")
        for o in new_opps:
            lines.append(
                f"• {_html_escape(o['name'])} ({o['risk_level']})"
            )
            if o.get("rationale"):
                lines.append(f"  <i>{_html_escape(_trim(o['rationale'], 160))}</i>")

    lines.append("")
    lines.append(f'<a href="{REPO_URL}">Full report on GitHub</a>')

    return "\n".join(lines)


# ─── MAIN ────────────────────────────────────────────────────────────────────

def main() -> int:
    today_data = load_json(LATEST_FILE)
    if today_data is None:
        print(f"ERROR: No latest report at {LATEST_FILE}")
        return 1

    # Parse today's date from generated_at
    gen_at = today_data.get("generated_at", "")[:10]
    try:
        today_d = date.fromisoformat(gen_at)
    except ValueError:
        today_d = date.today()

    prior_path, prior_d = find_previous_archive(today_d)
    if not prior_path:
        print(f"No prior archive found before {today_d}. First run; nothing to diff.")
        return 0

    prior_data = load_json(prior_path)
    print(f"Comparing {today_d} vs {prior_d} ({prior_path.name})")

    upgrades, new_alerts = diff_holdings(
        today_data.get("holdings", []),
        prior_data.get("holdings", []),
    )
    new_opps = diff_opportunities(
        today_data.get("opportunities", []),
        prior_data.get("opportunities", []),
        min_risk="MEDIUM",
    )

    print(f"  Signal upgrades: {len(upgrades)}")
    print(f"  Newly-alerting holdings: {len(new_alerts)}")
    print(f"  New opportunities: {len(new_opps)}")

    msg = build_message(today_d, prior_d, upgrades, new_alerts, new_opps)
    if msg is None:
        print("No material changes -- Telegram alert skipped (silent run).")
        return 0

    # Import here so the rest of the script still loads if telegram_notify breaks
    sys.path.insert(0, str(HOLDINGS_AGENT_DIR))
    from telegram_notify import send

    result = send(msg, prefix=True)
    ok = result.get("ok", False) or result.get("skipped", False)
    print(f"Telegram send: ok={ok}")
    return 0 if ok else 2


if __name__ == "__main__":
    sys.exit(main())
