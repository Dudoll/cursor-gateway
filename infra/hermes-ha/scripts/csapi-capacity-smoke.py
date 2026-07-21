#!/usr/bin/env python3
"""Run a low-cost six-request CSAPI smoke without printing credentials or text."""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import re
import subprocess
import threading
import time
import urllib.request
import uuid
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


def lifecycle_counts(
    container: str, user: str, database: str, model: str
) -> tuple[int, int]:
    if not re.fullmatch(r"[A-Za-z0-9._:-]+", model):
        raise ValueError("model contains unsupported characters")
    query = (
        "select "
        "count(*) filter (where status='running'),"
        "count(*) filter (where status='queued') "
        f"from runs where model='{model}'"
    )
    result = subprocess.run(
        [
            "docker",
            "exec",
            container,
            "psql",
            "-U",
            user,
            "-d",
            database,
            "-Atc",
            query,
        ],
        text=True,
        capture_output=True,
        check=True,
    )
    running, queued = result.stdout.strip().split("|", 1)
    return int(running), int(queued)


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify CSAPI worker concurrency")
    parser.add_argument("--slots", type=int, default=6)
    parser.add_argument("--base-url", default="http://127.0.0.1:18080")
    parser.add_argument("--model", default="gpt-5.6-sol")
    parser.add_argument("--timeout", type=int, default=600)
    parser.add_argument("--env-file", type=Path, default=Path("~/.hermes/.env"))
    parser.add_argument(
        "--seventh-env-file",
        type=Path,
        default=Path("~/.hermes/profiles/telegram2/.env"),
    )
    parser.add_argument("--postgres-container", default="infra-postgres-1")
    parser.add_argument("--postgres-user", default="cursor_gateway")
    parser.add_argument("--postgres-database", default="cursor_gateway")
    args = parser.parse_args()
    if args.slots != 6:
        raise RuntimeError("production capacity smoke requires exactly six slots")

    env = load_env(args.env_file.expanduser())
    api_key = env.get("CURSOR_GATEWAY_CSAPI_KEY", "")
    if not api_key:
        raise RuntimeError("CURSOR_GATEWAY_CSAPI_KEY is unavailable")
    seventh_env = load_env(args.seventh_env_file.expanduser())
    seventh_api_key = seventh_env.get("CURSOR_GATEWAY_CSAPI_KEY", "")
    if not seventh_api_key or seventh_api_key == api_key:
        raise RuntimeError("seventh probe requires a distinct scoped API key")
    baseline_running, baseline_queued = lifecycle_counts(
        args.postgres_container,
        args.postgres_user,
        args.postgres_database,
        args.model,
    )
    if baseline_running or baseline_queued:
        raise RuntimeError(
            "refusing ambiguous smoke with existing target-model work"
        )

    request_count = args.slots + 1
    barrier = threading.Barrier(request_count)
    monitor_stop = threading.Event()
    monitor_errors: list[BaseException] = []
    peak = 0
    queued_while_full = False

    def monitor() -> None:
        nonlocal peak, queued_while_full
        try:
            while not monitor_stop.wait(0.2):
                running, queued = lifecycle_counts(
                    args.postgres_container,
                    args.postgres_user,
                    args.postgres_database,
                    args.model,
                )
                peak = max(peak, running)
                queued_while_full = queued_while_full or (
                    running == args.slots and queued >= 1
                )
        except BaseException as error:
            monitor_errors.append(error)

    def invoke(slot: int) -> dict[str, object]:
        barrier.wait()
        started = time.monotonic()
        payload = json.dumps(
            {
                "model": args.model,
                "messages": [
                    {
                        "role": "user",
                        "content": f"Capacity probe {slot}. Reply with only OK-{slot}.",
                    }
                ],
            }
        ).encode()
        request = urllib.request.Request(
            f"{args.base_url.rstrip('/')}/v1/chat/completions",
            data=payload,
            method="POST",
            headers={
                "Authorization": (
                    f"Bearer {api_key}"
                    if slot <= args.slots
                    else f"Bearer {seventh_api_key}"
                ),
                "Content-Type": "application/json",
                "Idempotency-Key": f"capacity-{uuid.uuid4()}",
                "X-Session-Id": f"capacity-{uuid.uuid4()}",
            },
        )
        with urllib.request.urlopen(request, timeout=args.timeout) as response:
            response.read()
            status = response.status
        return {
            "slot": slot,
            "status": status,
            "duration_ms": int((time.monotonic() - started) * 1000),
        }

    watcher = threading.Thread(target=monitor, name="capacity-monitor", daemon=True)
    watcher.start()
    try:
        with concurrent.futures.ThreadPoolExecutor(
            max_workers=request_count
        ) as executor:
            results = list(executor.map(invoke, range(1, request_count + 1)))
    finally:
        monitor_stop.set()
        watcher.join(timeout=2)
    if monitor_errors:
        raise RuntimeError("capacity monitor failed") from monitor_errors[0]

    summary = {
        "slots": args.slots,
        "peak_running": peak,
        "queued_while_full": queued_while_full,
        "seventh_status": results[-1]["status"],
        "results": results,
    }
    print(json.dumps(summary, sort_keys=True))
    if (
        peak != args.slots
        or not queued_while_full
        or any(item["status"] != 200 for item in results)
    ):
        return 1
    return 0


if __name__ == "__main__":
    os.umask(0o077)
    raise SystemExit(main())
