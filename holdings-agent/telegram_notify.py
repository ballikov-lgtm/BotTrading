"""
holdings-agent/telegram_notify.py — Telegram sender for holdings alerts.

Reads TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID from Trading Setup/.env.
Honours TELEGRAM_ALERTS_ENABLED=false to mute.

Usage as a module:
    from telegram_notify import send
    send("Test message")

Usage as a script (for sanity-checking the Telegram pipeline):
    py telegram_notify.py "Test from holdings-agent"
"""

import json
import os
import sys
import urllib.parse
import urllib.request
from pathlib import Path

from dotenv import load_dotenv

ENV_FILE = Path(__file__).parent.parent / ".env"
load_dotenv(ENV_FILE, override=True)

PREFIX = "[HOLDINGS ⚠️]"  # [HOLDINGS warning-sign] — kept as unicode for Telegram display


def send(message: str, prefix: bool = True) -> dict:
    """Send a Telegram message via the configured bot. Returns the API response dict.

    HTML parse mode — message may include <b>, <i>, <code>, <a href="">.
    """
    if os.environ.get("TELEGRAM_ALERTS_ENABLED", "").strip().lower() == "false":
        print("[Telegram disabled via TELEGRAM_ALERTS_ENABLED=false; skipping send]")
        return {"skipped": True}

    token   = os.environ.get("TELEGRAM_BOT_TOKEN")
    chat_id = os.environ.get("TELEGRAM_CHAT_ID")
    if not token or not chat_id:
        raise RuntimeError(
            f"TELEGRAM_BOT_TOKEN and/or TELEGRAM_CHAT_ID not in env. "
            f"Looked for .env at {ENV_FILE}"
        )

    text = f"{PREFIX} {message}" if prefix else message
    url  = f"https://api.telegram.org/bot{token}/sendMessage"

    data = urllib.parse.urlencode({
        "chat_id": chat_id,
        "text":    text,
        "parse_mode": "HTML",
        "disable_web_page_preview": "true",
    }).encode("utf-8")

    req = urllib.request.Request(url, data=data, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Telegram API HTTP {exc.code}: {body}") from exc


if __name__ == "__main__":
    msg = " ".join(sys.argv[1:]) if len(sys.argv) > 1 else "Test from holdings-agent"
    result = send(msg)
    print("Send result:", json.dumps(
        {k: v for k, v in result.items() if k != "result"},  # trim noisy result.result
        indent=2,
    ))
