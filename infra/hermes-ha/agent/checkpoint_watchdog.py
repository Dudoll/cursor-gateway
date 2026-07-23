#!/usr/bin/env python3
"""Alert when the leader's gateway checkpoint is older than its recovery SLO."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
import time
from pathlib import Path
from typing import Any

from common import atomic_write_json, load_config, read_json, runtime_dir
from gateway_checkpoint import checkpoint_restore_dir, checkpoint_work_dir, publish_status_path
from leader import is_leader
from orchestrator import alert


def state_path(config: dict[str, Any]) -> Path:
    return runtime_dir(config) / "gateway-checkpoint-watchdog-state.json"


def parse_created_at(value: object) -> float | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = dt.datetime.strptime(value, "%Y%m%dT%H%M%SZ").replace(
            tzinfo=dt.timezone.utc
        )
    except ValueError:
        return None
    return parsed.timestamp()


def checkpoint_status(
    config: dict[str, Any], *, now: float | None = None
) -> dict[str, Any]:
    current_time = time.time() if now is None else now
    if str((config.get("gateway_checkpoint") or {}).get("transport") or "filesystem") == "rclone":
        root = checkpoint_work_dir(config)
        manifest = read_json(publish_status_path(config))
    else:
        root = checkpoint_restore_dir(config)
        manifest = read_json(root / "manifest.json")
    threshold = max(
        60, int((config.get("gateway_checkpoint") or {}).get("max_age_seconds") or 600)
    )
    if not manifest:
        return {
            "ok": False,
            "reason": "manifest_missing",
            "age_seconds": None,
            "max_age_seconds": threshold,
        }

    created_at = parse_created_at(manifest.get("created_at"))
    if created_at is None:
        return {
            "ok": False,
            "reason": "manifest_timestamp_invalid",
            "age_seconds": None,
            "max_age_seconds": threshold,
        }

    dump = root / str(manifest.get("file") or "")
    expected_size = int(manifest.get("size") or 0)
    actual_size = dump.stat().st_size if dump.is_file() else 0
    if not dump.is_file() or expected_size <= 0 or actual_size != expected_size:
        return {
            "ok": False,
            "reason": "dump_missing_or_incomplete",
            "age_seconds": max(0, int(current_time - created_at)),
            "max_age_seconds": threshold,
        }

    age = max(0, int(current_time - created_at))
    return {
        "ok": age <= threshold,
        "reason": "fresh" if age <= threshold else "checkpoint_stale",
        "age_seconds": age,
        "max_age_seconds": threshold,
    }


def run_watchdog(config: dict[str, Any], *, now: float | None = None) -> int:
    if not is_leader(config):
        print(json.dumps({"ok": True, "skipped": "not_leader"}))
        return 0

    status = checkpoint_status(config, now=now)
    previous = read_json(state_path(config)) or {}
    was_alerting = bool(previous.get("alerting"))
    is_alerting = not bool(status["ok"])

    if is_alerting and not was_alerting:
        age = status.get("age_seconds")
        age_text = "unknown" if age is None else f"{age}s"
        alert(
            config,
            "Hermes HA gateway checkpoint is stale "
            f"(reason={status['reason']}, age={age_text}, "
            f"limit={status['max_age_seconds']}s)",
        )
    elif not is_alerting and was_alerting:
        alert(
            config,
            "Hermes HA gateway checkpoint recovered "
            f"(age={status['age_seconds']}s)",
        )

    atomic_write_json(
        state_path(config),
        {
            "alerting": is_alerting,
            "reason": status["reason"],
            "age_seconds": status.get("age_seconds"),
            "checked_at": int(time.time() if now is None else now),
        },
    )
    print(json.dumps(status, sort_keys=True))
    return 0 if status["ok"] else 2


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Check gateway checkpoint freshness")
    parser.add_argument("--config", type=Path)
    args = parser.parse_args(argv)
    return run_watchdog(load_config(args.config))


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    raise SystemExit(main())
