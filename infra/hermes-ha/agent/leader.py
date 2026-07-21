#!/usr/bin/env python3
"""iCloud leadership lock (single-writer for Hermes stack)."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

from common import (
    atomic_write_json,
    icloud_root,
    load_config,
    node_id,
    read_json,
)


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()


def leader_path(config: dict[str, Any]) -> Path:
    return icloud_root(config) / "leader.json"


def default_leader(holder: str) -> dict[str, Any]:
    return {
        "role_holder": holder,
        "epoch": 0,
        "mode": "PRIMARY" if holder else "STANDBY_COLD",
        "since": utc_now(),
        "reason": "init",
        "failback_ready": False,
        "dns_target": holder,
        "updated_at": utc_now(),
        "updated_by": holder,
    }


def read_leader(config: dict[str, Any]) -> dict[str, Any]:
    path = leader_path(config)
    data = read_json(path)
    if data:
        return data
    return default_leader("")


def write_leader(config: dict[str, Any], payload: dict[str, Any]) -> None:
    payload = dict(payload)
    payload["updated_at"] = utc_now()
    payload["updated_by"] = node_id(config)
    atomic_write_json(leader_path(config), payload)


def is_leader(config: dict[str, Any], data: dict[str, Any] | None = None) -> bool:
    data = data or read_leader(config)
    return str(data.get("role_holder") or "") == node_id(config)


def acquire(
    config: dict[str, Any],
    *,
    mode: str,
    reason: str,
    force: bool = False,
) -> dict[str, Any]:
    """Claim leadership. Increments epoch. Refuses if peer holds fresher epoch unless force."""
    me = node_id(config)
    path = leader_path(config)
    path.parent.mkdir(parents=True, exist_ok=True)

    current = read_leader(config)
    holder = str(current.get("role_holder") or "")
    if holder and holder != me and not force:
        raise RuntimeError(f"leadership held by {holder} (epoch={current.get('epoch')})")

    epoch = int(current.get("epoch") or 0) + 1
    payload = {
        "role_holder": me,
        "epoch": epoch,
        "mode": mode,
        "since": utc_now(),
        "reason": reason,
        "failback_ready": False,
        "dns_target": me,
        "previous_holder": holder or None,
        "previous_epoch": current.get("epoch"),
    }
    write_leader(config, payload)
    # Re-read to detect lost race (best-effort on eventually-consistent FS)
    time.sleep(0.5)
    verify = read_leader(config)
    if str(verify.get("role_holder")) != me or int(verify.get("epoch") or 0) != epoch:
        raise RuntimeError(
            f"lost leadership race: wanted epoch={epoch} holder={me}, "
            f"got epoch={verify.get('epoch')} holder={verify.get('role_holder')}"
        )
    return verify


def release_to(
    config: dict[str, Any],
    peer: str,
    *,
    mode: str = "PRIMARY",
    reason: str = "failback",
) -> dict[str, Any]:
    me = node_id(config)
    current = read_leader(config)
    if str(current.get("role_holder")) != me:
        raise RuntimeError(f"cannot release: not leader (holder={current.get('role_holder')})")
    epoch = int(current.get("epoch") or 0) + 1
    payload = {
        "role_holder": peer,
        "epoch": epoch,
        "mode": mode,
        "since": utc_now(),
        "reason": reason,
        "failback_ready": False,
        "dns_target": peer,
        "previous_holder": me,
        "previous_epoch": current.get("epoch"),
    }
    write_leader(config, payload)
    return read_leader(config)


def set_failback_ready(config: dict[str, Any], ready: bool = True) -> dict[str, Any]:
    current = read_leader(config)
    if str(current.get("role_holder")) != node_id(config):
        raise RuntimeError("only leader can change failback readiness")
    current["failback_ready"] = bool(ready)
    write_leader(config, current)
    return read_leader(config)


def set_mode(config: dict[str, Any], mode: str, reason: str | None = None) -> dict[str, Any]:
    current = read_leader(config)
    if str(current.get("role_holder")) != node_id(config):
        raise RuntimeError("only leader can change mode")
    current["mode"] = mode
    if reason:
        current["reason"] = reason
    write_leader(config, current)
    return read_leader(config)


def cmd_status(config: dict[str, Any]) -> int:
    data = read_leader(config)
    me = node_id(config)
    data["_local_node"] = me
    data["_is_leader"] = me == str(data.get("role_holder") or "")
    data["_leader_path"] = str(leader_path(config))
    print(json.dumps(data, ensure_ascii=False, indent=2))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Hermes HA leadership lock")
    parser.add_argument("--config", type=Path)
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("status")
    p_acq = sub.add_parser("acquire")
    p_acq.add_argument("--mode", default="TAKEOVER")
    p_acq.add_argument("--reason", default="manual")
    p_acq.add_argument("--force", action="store_true")

    p_rel = sub.add_parser("release-to")
    p_rel.add_argument("peer")
    p_rel.add_argument("--mode", default="PRIMARY")
    p_rel.add_argument("--reason", default="failback")

    p_fb = sub.add_parser("failback-ready")
    p_fb.add_argument("--clear", action="store_true")

    p_mode = sub.add_parser("set-mode")
    p_mode.add_argument("mode")
    p_mode.add_argument("--reason")

    args = parser.parse_args(argv)
    config = load_config(args.config)

    if args.cmd == "status":
        return cmd_status(config)
    if args.cmd == "acquire":
        data = acquire(config, mode=args.mode, reason=args.reason, force=args.force)
        print(json.dumps(data, ensure_ascii=False, indent=2))
        return 0
    if args.cmd == "release-to":
        data = release_to(config, args.peer, mode=args.mode, reason=args.reason)
        print(json.dumps(data, ensure_ascii=False, indent=2))
        return 0
    if args.cmd == "failback-ready":
        data = set_failback_ready(config, ready=not args.clear)
        print(json.dumps(data, ensure_ascii=False, indent=2))
        return 0
    if args.cmd == "set-mode":
        data = set_mode(config, args.mode, reason=args.reason)
        print(json.dumps(data, ensure_ascii=False, indent=2))
        return 0
    return 1


if __name__ == "__main__":
    # Allow running as script from agent/ without package install
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    raise SystemExit(main())
