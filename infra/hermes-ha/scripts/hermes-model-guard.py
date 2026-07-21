#!/usr/bin/env python3
"""Alert when Hermes answers with a model other than its configured primary."""

from __future__ import annotations

import json
import os
import sqlite3
import sys
import urllib.parse
import urllib.request
from pathlib import Path
from time import time
from urllib.parse import urlparse

import yaml


HERMES_HOME = Path(os.environ.get("HERMES_HOME", "~/.hermes")).expanduser()
CONFIG_PATH = HERMES_HOME / "config.yaml"
ENV_PATH = HERMES_HOME / ".env"
DB_PATH = HERMES_HOME / "state.db"
STATE_PATH = HERMES_HOME / "model-guard-state.json"
INITIAL_LOOKBACK_SECONDS = 600


def load_env() -> dict[str, str]:
    result: dict[str, str] = {}
    for raw in ENV_PATH.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        result[key.strip()] = value.strip().strip("\"'")
    return result


def load_state() -> dict:
    try:
        value = json.loads(STATE_PATH.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_state(state: dict) -> None:
    temporary = STATE_PATH.with_suffix(".tmp")
    temporary.write_text(json.dumps(state, sort_keys=True) + "\n", encoding="utf-8")
    os.chmod(temporary, 0o600)
    temporary.replace(STATE_PATH)


def telegram_target(env: dict[str, str]) -> tuple[str, str]:
    token = env.get("TELEGRAM_BOT_TOKEN", "")
    chat_id = env.get("TELEGRAM_HOME_CHANNEL", "")
    if ":" in chat_id:
        chat_id = chat_id.rsplit(":", 1)[-1]
    if not token or not chat_id:
        raise RuntimeError("TELEGRAM_BOT_TOKEN or TELEGRAM_HOME_CHANNEL is missing")
    return token, chat_id


def send_telegram(token: str, chat_id: str, text: str) -> None:
    body = urllib.parse.urlencode(
        {"chat_id": chat_id, "text": text, "disable_web_page_preview": "true"}
    ).encode()
    request = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/sendMessage", data=body
    )
    with urllib.request.urlopen(request, timeout=15) as response:
        result = json.load(response)
    if not result.get("ok"):
        raise RuntimeError("Telegram rejected the alert")


def provider_label(provider: str, base_url: str) -> str:
    if provider and provider != "auto":
        return provider
    return urlparse(base_url).hostname or provider or "unknown"


def main() -> int:
    config = yaml.safe_load(CONFIG_PATH.read_text(encoding="utf-8")) or {}
    model_config = config.get("model") or {}
    expected_model = str(model_config.get("default") or "")
    expected_provider = str(model_config.get("provider") or "")
    provider_config = (config.get("providers") or {}).get(expected_provider) or {}
    expected_url = str(provider_config.get("api") or "").rstrip("/")
    if not expected_model or not expected_provider or not expected_url:
        raise RuntimeError("primary Hermes provider/model is not fully configured")

    env = load_env()
    token, chat_id = telegram_target(env)
    state = load_state()
    seen: dict[str, float] = state.setdefault("seen", {})
    active: dict[str, str] = state.setdefault("active", {})
    initial_cutoff = time() - INITIAL_LOOKBACK_SECONDS

    connection = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    rows = connection.execute(
        """
        WITH latest AS (
          SELECT u.*, ROW_NUMBER() OVER (
            PARTITION BY u.session_id ORDER BY u.last_seen DESC
          ) AS position
          FROM session_model_usage AS u
          WHERE u.last_seen IS NOT NULL
        )
        SELECT latest.session_id, latest.model, latest.billing_provider,
               latest.billing_base_url, latest.last_seen,
               sessions.source, sessions.chat_id, sessions.model_config
        FROM latest
        JOIN sessions ON sessions.id = latest.session_id
        WHERE latest.position = 1
        ORDER BY latest.last_seen
        """
    ).fetchall()
    connection.close()

    changed = False
    for row in rows:
        session_id = str(row["session_id"])
        last_seen = float(row["last_seen"])
        previous_seen = float(seen.get(session_id, 0))
        if last_seen <= previous_seen or (not previous_seen and last_seen < initial_cutoff):
            continue

        actual_model = str(row["model"] or "unknown")
        actual_provider = provider_label(
            str(row["billing_provider"] or ""),
            str(row["billing_base_url"] or ""),
        )
        actual_url = str(row["billing_base_url"] or "").rstrip("/")
        is_expected = actual_model == expected_model and actual_url == expected_url
        signature = f"{actual_provider}:{actual_model}:{actual_url}"
        session_short = session_id[:20]
        source = str(row["source"] or "unknown")

        if not is_expected and active.get(session_id) != signature:
            send_telegram(
                token,
                chat_id,
                "⚠️ Hermes 模型偏离预期\n"
                f"会话: {source}/{session_short}\n"
                f"预期: {expected_provider} / {expected_model}\n"
                f"实际: {actual_provider} / {actual_model}\n"
                "说明: 主模型调用失败或发生 fallback；本次回复可能不是由 Cursor Gateway 生成。",
            )
            active[session_id] = signature
            changed = True
        elif is_expected and session_id in active:
            send_telegram(
                token,
                chat_id,
                "✅ Hermes 已恢复预期模型\n"
                f"会话: {source}/{session_short}\n"
                f"当前: {expected_provider} / {expected_model}",
            )
            del active[session_id]
            changed = True

        seen[session_id] = last_seen
        changed = True

    if changed:
        save_state(state)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"hermes-model-guard: {exc}", file=sys.stderr)
        raise SystemExit(1)
