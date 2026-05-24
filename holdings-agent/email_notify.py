"""
holdings-agent/email_notify.py  —  HTML email sender for holdings reports.

Sends the weekly HTML report via SendGrid REST API to a list of recipients.

Reads from Trading Setup/.env:
  SENDGRID_API_KEY           — required, the SendGrid API key (starts SG.)
  HOLDINGS_EMAIL_FROM        — required, the verified sender address (e.g. alan.ball@jarvale.co.uk)
  HOLDINGS_EMAIL_RECIPIENTS  — required, comma-separated recipient addresses
  HOLDINGS_EMAIL_ENABLED     — optional, set to "false" to mute sends

Soft-fails on any send error so a missed email never breaks the rest of the run.

Usage as a module:
    from email_notify import send_html
    send_html(subject="Weekly review", html_body=html_str)

Usage as a script (test):
    py email_notify.py "Test subject" "<p>Test body</p>"
"""

import json
import os
import sys
import urllib.request
import urllib.error
from pathlib import Path

from dotenv import load_dotenv

ENV_FILE = Path(__file__).parent.parent / ".env"
load_dotenv(ENV_FILE, override=True)


def _split_recipients(raw: str) -> list:
    if not raw:
        return []
    return [a.strip() for a in raw.split(",") if a.strip()]


def send_html(subject: str, html_body: str,
              recipients: list = None,
              from_address: str = None,
              from_name: str = "Holdings Agent") -> dict:
    """Send an HTML email. Returns dict with status info; doesn't raise."""

    if os.environ.get("HOLDINGS_EMAIL_ENABLED", "").strip().lower() == "false":
        print("[Email disabled via HOLDINGS_EMAIL_ENABLED=false; skipping send]")
        return {"skipped": True, "reason": "disabled"}

    api_key = os.environ.get("SENDGRID_API_KEY")
    if not api_key:
        print(f"[Email skipped: SENDGRID_API_KEY not in env. Looked at {ENV_FILE}]")
        return {"skipped": True, "reason": "no_api_key"}

    if recipients is None:
        recipients = _split_recipients(os.environ.get("HOLDINGS_EMAIL_RECIPIENTS", ""))
    if not recipients:
        print("[Email skipped: no recipients configured]")
        return {"skipped": True, "reason": "no_recipients"}

    if from_address is None:
        from_address = os.environ.get("HOLDINGS_EMAIL_FROM")
    if not from_address:
        print("[Email skipped: HOLDINGS_EMAIL_FROM not configured]")
        return {"skipped": True, "reason": "no_from_address"}

    body = {
        "personalizations": [
            {"to": [{"email": r} for r in recipients]}
        ],
        "from":    {"email": from_address, "name": from_name},
        "subject": subject,
        "content": [{"type": "text/html", "value": html_body}],
    }
    data = json.dumps(body).encode("utf-8")

    req = urllib.request.Request(
        "https://api.sendgrid.com/v3/mail/send",
        data=data,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type":  "application/json",
        },
    )

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            # SendGrid returns 202 on accepted-for-delivery, no body
            status = resp.getcode()
            return {
                "ok":         status == 202,
                "status":     status,
                "recipients": recipients,
            }
    except urllib.error.HTTPError as exc:
        body_text = exc.read().decode("utf-8", errors="replace")[:400]
        print(f"[Email send FAILED: HTTP {exc.code} — {body_text}]")
        return {"ok": False, "status": exc.code, "error": body_text}
    except Exception as exc:
        print(f"[Email send FAILED: {exc}]")
        return {"ok": False, "error": str(exc)}


if __name__ == "__main__":
    subj = sys.argv[1] if len(sys.argv) > 1 else "Holdings Agent test email"
    body = sys.argv[2] if len(sys.argv) > 2 else (
        "<h2>Test email</h2>"
        "<p>This is a one-off sanity test from <code>email_notify.py</code>.</p>"
        "<p>If you see this in both inboxes (jarvale.co.uk + gmail), the SendGrid "
        "pipeline is wired correctly.</p>"
    )
    result = send_html(subj, body)
    print("Send result:", json.dumps(result, indent=2))
