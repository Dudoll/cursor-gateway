#!/usr/bin/env python3
"""Mirror shared report editions into an isolated release Gateway database."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import urllib.error
import urllib.parse
import urllib.request


REPORT_IDS = ("ai-infra-mianshi", "ai-agent-mianshi")


def env_value(path: Path, name: str) -> str:
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        if key.strip() == name:
            return value.strip().strip('"').strip("'")
    raise RuntimeError(f"{name} is missing from {path}")


def request_json(
    base_url: str,
    secret: str,
    method: str,
    path: str,
    payload: dict[str, object] | None = None,
) -> dict[str, object]:
    data = None
    headers = {
        "Accept": "application/json",
        "Authorization": f"Bearer {secret}",
    }
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(
        f"{base_url.rstrip('/')}{path}", data=data, headers=headers, method=method
    )
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            raw = response.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:500]
        raise RuntimeError(f"{method} {path} failed with HTTP {exc.code}: {detail}") from exc
    parsed = json.loads(raw.decode("utf-8"))
    if not isinstance(parsed, dict):
        raise RuntimeError(f"{method} {path} returned a non-object response")
    return parsed


def sync_report(
    report_id: str,
    *,
    internal_url: str,
    internal_secret: str,
    release_url: str,
    release_secret: str,
    limit: int,
) -> tuple[int, int]:
    query = urllib.parse.urlencode({"limit": limit})
    exported = request_json(
        internal_url,
        internal_secret,
        "GET",
        f"/api/automation/reports/{urllib.parse.quote(report_id, safe='')}/editions?{query}",
    )
    editions = exported.get("editions")
    if not isinstance(editions, list):
        raise RuntimeError(f"export response for {report_id} has no editions list")

    created = 0
    updated = 0
    for edition in reversed(editions):
        if not isinstance(edition, dict):
            continue
        result = request_json(
            release_url,
            release_secret,
            "POST",
            "/api/automation/reports/import",
            {
                "reportId": report_id,
                "date": edition.get("date"),
                "content": edition.get("content"),
                "sourceRunId": edition.get("sourceRunId"),
            },
        )
        if result.get("idempotent") is True:
            updated += 1
        else:
            created += 1
    return created, updated


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--internal-url", default="http://127.0.0.1:18080")
    parser.add_argument("--release-url", default="http://127.0.0.1:18081")
    parser.add_argument("--internal-env", type=Path, default=Path("/home/joel/cursor-gateway/.env"))
    parser.add_argument("--release-env", type=Path, default=Path("/home/joel/cursor-gateway-release/.env"))
    parser.add_argument("--limit", type=int, default=7)
    args = parser.parse_args()
    if not 1 <= args.limit <= 30:
        parser.error("--limit must be between 1 and 30")

    internal_secret = env_value(args.internal_env, "AUTOMATION_SHARED_SECRET")
    release_secret = env_value(args.release_env, "AUTOMATION_SHARED_SECRET")
    totals = []
    for report_id in REPORT_IDS:
        created, updated = sync_report(
            report_id,
            internal_url=args.internal_url,
            internal_secret=internal_secret,
            release_url=args.release_url,
            release_secret=release_secret,
            limit=args.limit,
        )
        totals.append((report_id, created, updated))
    for report_id, created, updated in totals:
        print(f"{report_id}: created={created} refreshed={updated}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
