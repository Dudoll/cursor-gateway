#!/usr/bin/env python3
"""Send a Hermes HA alert through the existing Telegram home channel."""

from __future__ import annotations

import json
import os
import sys
import urllib.parse
import urllib.request
from pathlib import Path


def load_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip("\"'")
    return values


def main() -> int:
    home = Path(os.environ.get("HERMES_HOME", "~/.hermes")).expanduser()
    env = load_env(home / ".env")
    token = env.get("TELEGRAM_BOT_TOKEN", "")
    chat_id = env.get("TELEGRAM_HOME_CHANNEL", "")
    if ":" in chat_id:
        chat_id = chat_id.rsplit(":", 1)[-1]
    message = sys.stdin.read(8_000).strip()
    if not token or not chat_id or not message:
        raise RuntimeError("Telegram alert destination or message is unavailable")

    body = urllib.parse.urlencode(
        {
            "chat_id": chat_id,
            "text": f"⚠️ {message}",
            "disable_web_page_preview": "true",
        }
    ).encode()
    request = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/sendMessage",
        data=body,
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=15) as response:
        result = json.load(response)
    if not result.get("ok"):
        raise RuntimeError("Telegram rejected the Hermes HA alert")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"hermes-ha-alert: {type(exc).__name__}", file=sys.stderr)
        raise SystemExit(1)
