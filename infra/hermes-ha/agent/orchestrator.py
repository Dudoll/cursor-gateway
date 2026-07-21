#!/usr/bin/env python3
"""Takeover / failback orchestrator for Hermes HA."""

from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from common import load_config, node_id, runtime_dir, atomic_write_json, read_json
from leader import (
    acquire,
    is_leader,
    read_leader,
    release_to,
    set_failback_ready,
    set_mode,
)
from migrate import wait_sync
from secrets import apply_runtime


def run(cmd: list[str], check: bool = True) -> subprocess.CompletedProcess[str]:
    print("+", " ".join(cmd), flush=True)
    return subprocess.run(cmd, check=check, text=True, capture_output=True)


def stack_units(config: dict[str, Any]) -> list[str]:
    return list((config.get("stack_units") or {}).get("user") or [])


def stop_stack(config: dict[str, Any]) -> None:
    for unit in stack_units(config):
        run(["systemctl", "--user", "stop", unit], check=False)


def require_leader(config: dict[str, Any]) -> dict[str, Any]:
    current = read_leader(config)
    if not is_leader(config, current):
        raise RuntimeError(
            f"refusing writer action on non-leader {node_id(config)} "
            f"(holder={current.get('role_holder')})"
        )
    return current


def start_stack(config: dict[str, Any]) -> None:
    require_leader(config)
    apply_runtime(config)
    try:
        for unit in stack_units(config):
            run(["systemctl", "--user", "start", unit], check=True)
    except Exception:
        stop_stack(config)
        raise


def stack_status(config: dict[str, Any]) -> dict[str, str]:
    out: dict[str, str] = {}
    for unit in stack_units(config):
        proc = run(["systemctl", "--user", "is-active", unit], check=False)
        out[unit] = (proc.stdout or "").strip() or "unknown"
    return out


def tcp_ok(host: str, port: int, timeout: float = 3.0) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def http_ok(url: str, timeout: float = 5.0) -> bool:
    try:
        req = urllib.request.Request(url, method="GET", headers={"User-Agent": "hermes-ha/1.0"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return 200 <= resp.status < 500
    except (urllib.error.URLError, TimeoutError, OSError):
        return False


def ssh_ok(host: str, timeout: int = 8) -> bool:
    proc = subprocess.run(
        [
            "ssh",
            "-o",
            "BatchMode=yes",
            "-o",
            f"ConnectTimeout={timeout}",
            host,
            "true",
        ],
        capture_output=True,
    )
    return proc.returncode == 0


def peer_reachable(config: dict[str, Any], peer: str) -> dict[str, Any]:
    hosts = config.get("hosts") or {}
    entry = hosts.get(peer) or {}
    ssh_host = str(entry.get("ssh") or peer)
    ip = str(entry.get("public_ip") or "")
    url = str(entry.get("public_url") or "")
    result = {
        "peer": peer,
        "ssh": ssh_ok(ssh_host),
        "tcp22": tcp_ok(ip, 22) if ip else False,
        "tcp80": tcp_ok(ip, 80) if ip else False,
        "tcp443": tcp_ok(ip, 443) if ip else False,
        "http": http_ok(url) if url else False,
    }
    result["reachable"] = bool(result["ssh"] or result["tcp22"] or result["http"])
    return result


def state_path(config: dict[str, Any]) -> Path:
    return runtime_dir(config) / "orchestrator-state.json"


def load_state(config: dict[str, Any]) -> dict[str, Any]:
    return read_json(state_path(config)) or {
        "unreachable_streak": 0,
        "healthy_streak": 0,
        "last_takeover_at": 0,
        "cooldown_until": 0,
    }


def save_state(config: dict[str, Any], state: dict[str, Any]) -> None:
    atomic_write_json(state_path(config), state)


def maybe_dns(config: dict[str, Any], target: str, *, dry_run: bool = False) -> None:
    from dns_cloudflare import point_to

    try:
        changes = point_to(config, target, dry_run=dry_run)
        print(json.dumps({"dns": changes}, indent=2))
    except Exception as exc:  # noqa: BLE001
        print(f"DNS switch skipped/failed: {exc}", file=sys.stderr)
        raise


def alert(config: dict[str, Any], message: str) -> None:
    print(f"[alert] {message}", flush=True)
    cmd = str((config.get("alert") or {}).get("command") or "").strip()
    if not cmd:
        return
    subprocess.run(["bash", "-lc", cmd], input=message, text=True, check=False)


def takeover(config: dict[str, Any], *, force: bool = False, skip_dns: bool = False) -> int:
    me = node_id(config)
    if me != "vps-band":
        # Allow on any node but warn — design expects band to take over
        print(f"warning: takeover running on {me}", file=sys.stderr)
    peer = str(config.get("peer_id") or "vps-dmit")
    reach = peer_reachable(config, peer)
    if reach["reachable"] and not force:
        print(json.dumps(reach, indent=2))
        raise RuntimeError("peer still reachable; pass --force to override")

    leader = read_leader(config)
    if is_leader(config, leader) and str(leader.get("mode")) in {
        "ACTIVE_STANDBY",
        "TAKEOVER",
    }:
        print("already active standby / in takeover")
        return 0

    state = load_state(config)
    now = time.time()
    if now < float(state.get("cooldown_until") or 0) and not force:
        raise RuntimeError("takeover cooldown active")

    acquire(config, mode="TAKEOVER", reason="dmit_unreachable", force=True)
    stop_stack(config)  # ensure clean local start
    if bool((config.get("gateway_checkpoint") or {}).get("enabled", True)):
        from gateway_checkpoint import restore_checkpoint

        restore_checkpoint(config)

    apply_runtime(config)
    if bool((config.get("state_checkpoint") or {}).get("enabled", True)):
        from state_checkpoint import wire_state_symlink

        wire_state_symlink(config)
    start_stack(config)
    if not skip_dns:
        maybe_dns(config, me)
    set_mode(config, "ACTIVE_STANDBY", reason="takeover_complete")
    state["last_takeover_at"] = now
    state["cooldown_until"] = now + int((config.get("probe") or {}).get("cooldown_seconds") or 1800)
    state["unreachable_streak"] = 0
    save_state(config, state)
    alert(config, f"Hermes HA TAKEOVER complete on {me}; DNS -> {me}")
    print(json.dumps(read_leader(config), indent=2))
    return 0


def evaluate_auto(config: dict[str, Any]) -> int:
    """Called from vps-metrics hook on band."""
    me = node_id(config)
    if me != "vps-band":
        print("auto-evaluate only runs on vps-band")
        return 0
    peer = str(config.get("peer_id") or "vps-dmit")
    probe = config.get("probe") or {}
    need = int(probe.get("unreachable_streak_required") or 3)
    healthy_need = int(probe.get("failback_healthy_streak_required") or 3)
    state = load_state(config)
    reach = peer_reachable(config, peer)
    leader = read_leader(config)

    if not reach["reachable"]:
        state["unreachable_streak"] = int(state.get("unreachable_streak") or 0) + 1
        state["healthy_streak"] = 0
    else:
        state["healthy_streak"] = int(state.get("healthy_streak") or 0) + 1
        state["unreachable_streak"] = 0

    save_state(config, state)
    print(json.dumps({"reach": reach, "state": state, "leader": leader}, indent=2))

    if (
        not is_leader(config, leader)
        and int(state["unreachable_streak"]) >= need
        and time.time() >= float(state.get("cooldown_until") or 0)
    ):
        # Re-probe inside takeover and abort if the peer recovered.
        return takeover(config, force=False)

    # Mark failback ready when we are active standby and peer healthy
    if (
        is_leader(config, leader)
        and str(leader.get("mode")) == "ACTIVE_STANDBY"
        and reach["reachable"]
        and int(state["healthy_streak"]) >= healthy_need
        and not leader.get("failback_ready")
    ):
        set_failback_ready(config, True)
        alert(
            config,
            f"Hermes HA: {peer} healthy again. Run: hermes-ha failback --confirm",
        )
    return 0


def failback(config: dict[str, Any], *, confirm: bool = False, skip_dns: bool = False) -> int:
    if not confirm:
        raise RuntimeError("refusing failback without --confirm")
    me = node_id(config)
    peer = str(config.get("peer_id") or "vps-dmit")
    if me != "vps-band":
        print(f"warning: failback normally initiated on band (running on {me})", file=sys.stderr)
    current = require_leader(config)
    if str(current.get("mode")) != "ACTIVE_STANDBY":
        raise RuntimeError(f"failback requires ACTIVE_STANDBY mode (got {current.get('mode')})")
    if not bool(current.get("failback_ready")):
        raise RuntimeError("failback is not ready; wait for the configured healthy streak")

    reach = peer_reachable(config, peer)
    if not reach["reachable"]:
        raise RuntimeError(f"peer {peer} not reachable; abort failback")

    set_mode(config, "FAILBACK_SYNC", reason="manual_failback")
    # Stop writers on band first
    stop_stack(config)
    if wait_sync(config, timeout=180) != 0:
        raise RuntimeError("iCloud sync did not settle before failback")

    if bool((config.get("state_checkpoint") or {}).get("enabled", True)):
        from state_checkpoint import create_checkpoint as create_state_checkpoint

        create_state_checkpoint(config)
    if bool((config.get("gateway_checkpoint") or {}).get("enabled", True)):
        from gateway_checkpoint import create_checkpoint

        create_checkpoint(config)

    # Transfer ownership before the peer starts any writer.
    release_to(config, peer, mode="PRIMARY", reason="failback_handoff")
    ssh_host = str(((config.get("hosts") or {}).get(peer) or {}).get("ssh") or peer)
    remote = [
        "ssh",
        "-o",
        "BatchMode=yes",
        ssh_host,
        "hermes-ha peer-accept-failback",
    ]
    proc = subprocess.run(remote, text=True, capture_output=True)
    print(proc.stdout)
    if proc.returncode != 0:
        print(proc.stderr, file=sys.stderr)
        raise RuntimeError("peer-accept-failback failed")

    if not skip_dns:
        maybe_dns(config, peer)

    alert(config, f"Hermes HA FAILBACK complete; DNS -> {peer}; band stack stopped")
    print(json.dumps(read_leader(config), indent=2))
    return 0


def peer_accept_failback(config: dict[str, Any]) -> int:
    """Run on dmit when band hands back."""
    require_leader(config)
    stop_stack(config)
    if wait_sync(config, timeout=120) != 0:
        raise RuntimeError("iCloud sync did not settle on failback peer")
    if bool((config.get("gateway_checkpoint") or {}).get("enabled", True)):
        from gateway_checkpoint import restore_checkpoint

        restore_checkpoint(config)
    if bool((config.get("state_checkpoint") or {}).get("enabled", True)):
        from state_checkpoint import restore_checkpoint, wire_state_symlink

        restore_checkpoint(config)
        wire_state_symlink(config)
    apply_runtime(config)
    start_stack(config)
    print(json.dumps({"stack": stack_status(config)}, indent=2))
    return 0


def status(config: dict[str, Any]) -> int:
    peer = str(config.get("peer_id") or "vps-dmit")
    payload = {
        "node": node_id(config),
        "leader": read_leader(config),
        "stack": stack_status(config),
        "peer": peer_reachable(config, peer),
        "orch_state": load_state(config),
    }
    print(json.dumps(payload, indent=2, ensure_ascii=False))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Hermes HA orchestrator")
    parser.add_argument("--config", type=Path)
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status")
    p_to = sub.add_parser("takeover")
    p_to.add_argument("--force", action="store_true")
    p_to.add_argument("--skip-dns", action="store_true")
    sub.add_parser("evaluate")
    p_fb = sub.add_parser("failback")
    p_fb.add_argument("--confirm", action="store_true")
    p_fb.add_argument("--skip-dns", action="store_true")
    sub.add_parser("peer-accept-failback")
    sub.add_parser("stack-start")
    sub.add_parser("stack-stop")
    args = parser.parse_args(argv)
    config = load_config(args.config)

    if args.cmd == "status":
        return status(config)
    if args.cmd == "takeover":
        return takeover(config, force=args.force, skip_dns=args.skip_dns)
    if args.cmd == "evaluate":
        return evaluate_auto(config)
    if args.cmd == "failback":
        return failback(config, confirm=args.confirm, skip_dns=args.skip_dns)
    if args.cmd == "peer-accept-failback":
        return peer_accept_failback(config)
    if args.cmd == "stack-start":
        start_stack(config)
        return 0
    if args.cmd == "stack-stop":
        stop_stack(config)
        return 0
    return 1


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    raise SystemExit(main())
