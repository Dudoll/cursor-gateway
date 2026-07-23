#!/usr/bin/env python3
"""Read-only P0 acceptance checks for a deployed Hermes HA node."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import subprocess
import sys
from pathlib import Path
from typing import Any, BinaryIO

from common import hermes_link, hermes_shared, icloud_root, load_config, node_id, read_json, runtime_dir
from leader import read_leader
from state_checkpoint import checkpoint_root, local_state_path
from gateway_checkpoint import checkpoint_dir
from checkpoint_watchdog import checkpoint_status


class PartsReader:
    def __init__(self, paths: list[Path]) -> None:
        self.paths = iter(paths)
        self.current: BinaryIO | None = None

    def read(self, size: int = -1) -> bytes:
        chunks: list[bytes] = []
        remaining = size
        while size < 0 or remaining > 0:
            if self.current is None:
                try:
                    self.current = next(self.paths).open("rb")
                except StopIteration:
                    break
            chunk = self.current.read(-1 if size < 0 else remaining)
            if chunk:
                chunks.append(chunk)
                if size >= 0:
                    remaining -= len(chunk)
                continue
            self.current.close()
            self.current = None
        return b"".join(chunks)

    def close(self) -> None:
        if self.current is not None:
            self.current.close()
            self.current = None


def check(condition: bool, name: str, detail: str) -> dict[str, Any]:
    return {"name": name, "ok": bool(condition), "detail": detail}


def systemd_state(unit: str) -> str:
    proc = subprocess.run(
        ["systemctl", "--user", "is-active", unit],
        text=True,
        capture_output=True,
        check=False,
    )
    return (proc.stdout or "").strip() or "unknown"


def systemd_enabled(unit: str) -> bool:
    proc = subprocess.run(
        ["systemctl", "--user", "is-enabled", unit],
        text=True,
        capture_output=True,
        check=False,
    )
    return proc.returncode == 0 and (proc.stdout or "").strip() == "enabled"


def verify_state_checkpoint(config: dict[str, Any], *, full_hash: bool = True) -> list[dict[str, Any]]:
    root = checkpoint_root(config)
    manifest = read_json(root / "manifest.json")
    results = [check(bool(manifest), "state.manifest", str(root / "manifest.json"))]
    if not manifest:
        return results
    names = manifest.get("parts")
    valid_names = isinstance(names, list) and bool(names) and all(
        isinstance(name, str) and Path(name).name == name for name in names
    )
    results.append(check(valid_names, "state.parts-list", f"parts={len(names or [])}"))
    if not valid_names:
        return results
    paths = [root / name for name in names]
    missing = [str(path) for path in paths if not path.is_file()]
    results.append(check(not missing, "state.parts-present", ", ".join(missing) or "all present"))
    if missing or not full_hash:
        return results
    reader = PartsReader(paths)
    sha = hashlib.sha256()
    size = 0
    try:
        with gzip.GzipFile(fileobj=reader, mode="rb") as stream:
            while True:
                block = stream.read(1024 * 1024)
                if not block:
                    break
                sha.update(block)
                size += len(block)
    except (OSError, EOFError) as exc:
        results.append(check(False, "state.integrity", str(exc)))
        return results
    finally:
        reader.close()
    expected_sha = str(manifest.get("sha256") or "")
    expected_size = int(manifest.get("raw_size") or 0)
    results.append(
        check(
            sha.hexdigest() == expected_sha and size == expected_size,
            "state.integrity",
            f"size={size}/{expected_size} sha256={sha.hexdigest()}",
        )
    )
    return results


def verify_gateway_checkpoint(config: dict[str, Any]) -> list[dict[str, Any]]:
    root = checkpoint_dir(config)
    manifest = read_json(root / "manifest.json")
    results = [check(bool(manifest), "gateway.manifest", str(root / "manifest.json"))]
    if not manifest:
        return results
    dump = root / str(manifest.get("file") or "")
    expected_size = int(manifest.get("size") or 0)
    actual_size = dump.stat().st_size if dump.is_file() else 0
    results.append(
        check(
            dump.is_file() and expected_size > 0 and actual_size == expected_size,
            "gateway.dump",
            f"{dump} size={actual_size}/{expected_size}",
        )
    )
    freshness = checkpoint_status(config)
    results.append(
        check(
            bool(freshness["ok"]),
            "gateway.age",
            f"reason={freshness['reason']} age={freshness.get('age_seconds')}s "
            f"limit={freshness['max_age_seconds']}s",
        )
    )
    return results


def verify_layout(config: dict[str, Any]) -> list[dict[str, Any]]:
    home = hermes_link(config)
    shared = hermes_shared(config)
    results: list[dict[str, Any]] = [
        check(home.is_dir(), "layout.home", str(home)),
        check(shared.is_dir(), "layout.shared", str(shared)),
    ]
    for rel in config.get("shared_dirs") or []:
        path = home / str(rel)
        target = shared / str(rel)
        results.append(
            check(
                path.is_symlink() and path.resolve() == target.resolve(),
                f"layout.shared-dir.{rel}",
                f"{path} -> {path.resolve() if path.exists() else 'missing'}",
            )
        )
    local_root = runtime_dir(config) / "local_trees"
    for rel in config.get("local_trees") or []:
        path = home / str(rel)
        if not (path.exists() or path.is_symlink()):
            continue
        expected = local_root / str(rel).replace("/", "__")
        results.append(
            check(
                path.is_symlink() and path.resolve() == expected.resolve(),
                f"layout.local-tree.{rel}",
                f"{path} -> {path.resolve()}",
            )
        )
    runtime = runtime_dir(config) / "runtime"
    for spec in config.get("secrets") or []:
        plain = runtime / Path(str(spec["source"])).name
        mode = plain.stat().st_mode & 0o777 if plain.is_file() else 0
        results.append(
            check(plain.is_file() and mode == 0o600, f"secret.{spec['name']}", f"{plain} mode={mode:o}")
        )
    local_state = local_state_path(config)
    manifest = read_json(checkpoint_root(config) / "manifest.json") or {}
    expected = int(manifest.get("raw_size") or 0)
    actual = local_state.stat().st_size if local_state.is_file() else 0
    results.append(
        check(local_state.is_file() and expected > 0 and actual == expected, "state.local", f"size={actual}/{expected}")
    )
    return results


def run_acceptance(config: dict[str, Any], expected_node: str, *, full_hash: bool = True) -> dict[str, Any]:
    expected_id = {"dmit": "vps-dmit", "band": "vps-band"}[expected_node]
    leader = read_leader(config)
    results = [
        check(node_id(config) == expected_id, "node.id", f"{node_id(config)} expected={expected_id}"),
        check(
            str(leader.get("role_holder")) == "vps-dmit",
            "leader.primary",
            f"holder={leader.get('role_holder')} mode={leader.get('mode')}",
        ),
    ]
    expected_stack = "active" if expected_node == "dmit" else "inactive"
    for unit in (config.get("stack_units") or {}).get("user") or []:
        actual = systemd_state(str(unit))
        results.append(check(actual == expected_stack, f"stack.{unit}", f"{actual} expected={expected_stack}"))
    timers = [
        "hermes-ha-gateway-checkpoint.timer",
        "hermes-ha-checkpoint-watchdog.timer",
        "hermes-ha-state-checkpoint.timer",
    ]
    if expected_node == "band":
        timers.extend(
            [
                "hermes-ha-evaluate.timer",
                "hermes-ha-gateway-version-sync.timer",
            ]
        )
    for timer in timers:
        results.append(check(systemd_enabled(timer), f"timer.{timer}", "enabled required"))
    results.extend(verify_layout(config))
    results.extend(verify_state_checkpoint(config, full_hash=full_hash))
    results.extend(verify_gateway_checkpoint(config))
    return {
        "node": node_id(config),
        "expected_node": expected_node,
        "ok": all(item["ok"] for item in results),
        "checks": results,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Read-only Hermes HA P0 acceptance")
    parser.add_argument("--config", type=Path)
    parser.add_argument("--node", choices=["dmit", "band"], required=True)
    parser.add_argument("--skip-state-hash", action="store_true")
    args = parser.parse_args(argv)
    payload = run_acceptance(
        load_config(args.config),
        args.node,
        full_hash=not args.skip_state_hash,
    )
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0 if payload["ok"] else 1


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    raise SystemExit(main())
