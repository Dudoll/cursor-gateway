#!/usr/bin/env python3
"""Gateway Postgres checkpoint ( Hermès state lives on iCloud; PG does not )."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

from common import atomic_write_json, icloud_root, load_config, read_json


def checkpoint_dir(config: dict[str, Any]) -> Path:
    return icloud_root(config) / "checkpoints" / "gateway"


def gateway_settings(config: dict[str, Any]) -> dict[str, Any]:
    return dict(config.get("gateway_checkpoint") or {})


def checkpoint_transport(config: dict[str, Any]) -> str:
    return str(gateway_settings(config).get("transport") or "filesystem")


def checkpoint_remote(config: dict[str, Any]) -> str:
    return str(
        gateway_settings(config).get("remote")
        or "icloud:hermes-ha/checkpoints/gateway"
    ).rstrip("/")


def checkpoint_work_dir(config: dict[str, Any]) -> Path:
    if checkpoint_transport(config) == "rclone":
        from common import runtime_dir

        return runtime_dir(config) / "checkpoint-staging" / "gateway"
    return checkpoint_dir(config)


def rclone_bin() -> str:
    discovered = shutil.which("rclone")
    if discovered:
        return discovered
    user_install = Path.home() / ".local" / "bin" / "rclone"
    if user_install.is_file() and os.access(user_install, os.X_OK):
        return str(user_install)
    raise RuntimeError("rclone is required for gateway checkpoint transport")


def checkpoint_restore_dir(config: dict[str, Any]) -> Path:
    if checkpoint_transport(config) != "rclone":
        return checkpoint_dir(config)
    from common import runtime_dir

    root = runtime_dir(config) / "checkpoint-cache" / "gateway"
    root.mkdir(parents=True, exist_ok=True)
    rclone = rclone_bin()
    subprocess.run([rclone, "sync", checkpoint_remote(config), str(root)], check=True)
    return root


def publish_status_path(config: dict[str, Any]) -> Path:
    """Return the leader-local marker for the last completed remote publish."""
    return checkpoint_work_dir(config) / ".last-published.json"


def publish_remote(config: dict[str, Any], dump_path: Path, manifest_path: Path) -> None:
    rclone = rclone_bin()
    remote = checkpoint_remote(config)
    subprocess.run([rclone, "copyto", str(dump_path), f"{remote}/{dump_path.name}"], check=True)
    subprocess.run([rclone, "copyto", str(manifest_path), f"{remote}/manifest.json"], check=True)
    retain = max(1, int(gateway_settings(config).get("retain") or 12))
    listing = subprocess.run(
        [rclone, "lsf", remote, "--files-only"],
        text=True,
        capture_output=True,
        check=True,
    )
    dumps = sorted(
        (name.strip() for name in listing.stdout.splitlines() if name.startswith("pg-") and name.endswith(".dump")),
        reverse=True,
    )
    for name in dumps[retain:]:
        subprocess.run([rclone, "deletefile", f"{remote}/{name}"], check=True)


def compose_file(config: dict[str, Any]) -> Path:
    value = gateway_settings(config).get("compose_file") or "~/cursor-gateway/infra/docker-compose.yml"
    return Path(os.path.expanduser(str(value)))


def pg_user(config: dict[str, Any]) -> str:
    return str(gateway_settings(config).get("pg_user") or "cursor")


def pg_database(config: dict[str, Any]) -> str:
    return str(gateway_settings(config).get("pg_database") or "cursor_gateway")


def pg_service(config: dict[str, Any]) -> str:
    return str(gateway_settings(config).get("pg_service") or "postgres")


def docker_bin() -> list[str]:
    """Prefer direct docker; fall back to passwordless sudo (user session may lack docker group)."""
    if shutil.which("docker"):
        try:
            probe = subprocess.run(
                ["docker", "info"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=15,
            )
            if probe.returncode == 0:
                return ["docker"]
        except (OSError, subprocess.TimeoutExpired):
            pass
    if shutil.which("sudo"):
        try:
            probe = subprocess.run(
                ["sudo", "-n", "docker", "info"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=15,
            )
            if probe.returncode == 0:
                return ["sudo", "-n", "docker"]
        except (OSError, subprocess.TimeoutExpired):
            pass
    return ["docker"]


def docker_pg(config: dict[str, Any], args: list[str]) -> list[str]:
    return [
        *docker_bin(),
        "compose",
        "-f",
        str(compose_file(config)),
        "exec",
        "-T",
        pg_service(config),
        *args,
    ]


def create_checkpoint(config: dict[str, Any]) -> Path:
    from leader import is_leader, read_leader

    current = read_leader(config)
    if not is_leader(config, current):
        raise RuntimeError(
            f"refusing gateway checkpoint on non-leader "
            f"(holder={current.get('role_holder')})"
        )

    out_dir = checkpoint_work_dir(config)
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    dump_path = out_dir / f"pg-{stamp}.dump"
    tmp = dump_path.with_suffix(".dump.tmp")
    stderr = subprocess.PIPE
    if compose_file(config).is_file() and shutil.which("docker"):
        cmd = docker_pg(
            config,
            [
                "pg_dump",
                "-U",
                pg_user(config),
                "-d",
                pg_database(config),
                "--no-owner",
                "--format=custom",
            ]
        )
    elif shutil.which("pg_dump"):
        cmd = [
            "pg_dump",
            "-U",
            pg_user(config),
            "-d",
            pg_database(config),
            "--no-owner",
            "--format=custom",
        ]
    else:
        raise RuntimeError("neither docker compose postgres nor pg_dump available")
    print("+", " ".join(cmd), ">", tmp)
    with tmp.open("wb") as fh:
        proc = subprocess.run(cmd, stdout=fh, stderr=stderr)
    if proc.returncode != 0:
        tmp.unlink(missing_ok=True)
        err = (proc.stderr or b"").decode("utf-8", errors="replace")
        raise RuntimeError(err or "pg_dump failed")
    if not tmp.is_file() or tmp.stat().st_size == 0:
        tmp.unlink(missing_ok=True)
        raise RuntimeError("pg_dump produced an empty checkpoint")
    tmp.replace(dump_path)
    manifest = {
        "created_at": stamp,
        "file": dump_path.name,
        "size": dump_path.stat().st_size,
        "node": current.get("role_holder"),
        "epoch": current.get("epoch"),
    }
    manifest_path = out_dir / "manifest.json"
    atomic_write_json(manifest_path, manifest)
    if checkpoint_transport(config) == "rclone":
        publish_remote(config, dump_path, manifest_path)
        atomic_write_json(
            publish_status_path(config),
            {
                "created_at": stamp,
                "file": dump_path.name,
                "size": dump_path.stat().st_size,
            },
        )
    # retention
    retain = max(1, int(gateway_settings(config).get("retain") or 12))
    dumps = sorted(out_dir.glob("pg-*.dump"), key=lambda p: p.name, reverse=True)
    for old in dumps[retain:]:
        old.unlink(missing_ok=True)
    print(json_dumps(manifest))
    return dump_path


def json_dumps(payload: dict[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False, indent=2)


def latest_dump(config: dict[str, Any]) -> Path | None:
    root = checkpoint_restore_dir(config)
    manifest = read_json(root / "manifest.json")
    if manifest and manifest.get("file"):
        path = root / str(manifest["file"])
        if path.is_file():
            return path
    dumps = sorted(root.glob("pg-*.dump"), key=lambda p: p.name, reverse=True)
    return dumps[0] if dumps else None


def restore_checkpoint(config: dict[str, Any], dump: Path | None = None) -> None:
    dump = dump or latest_dump(config)
    if not dump or not dump.is_file():
        raise RuntimeError("no gateway checkpoint dump found")
    if compose_file(config).is_file() and shutil.which("docker"):
        cmd = docker_pg(
            config,
            [
                "pg_restore",
                "-U",
                pg_user(config),
                "-d",
                pg_database(config),
                "--clean",
                "--if-exists",
            ]
        )
        print("+", " ".join(cmd), "<", dump)
        with dump.open("rb") as fh:
            subprocess.run(cmd, stdin=fh, check=True)
    elif shutil.which("pg_restore"):
        cmd = [
            "pg_restore",
            "-U",
            pg_user(config),
            "--clean",
            "--if-exists",
            "-d",
            pg_database(config),
            str(dump),
        ]
        print("+", " ".join(cmd))
        subprocess.run(cmd, check=True)
    else:
        raise RuntimeError("neither docker compose postgres nor pg_restore available")
    print(f"restored {dump}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Gateway PG checkpoints")
    parser.add_argument("--config", type=Path)
    sub = parser.add_subparsers(dest="cmd", required=True)
    p_create = sub.add_parser("create")
    p_create.add_argument("--if-leader", action="store_true")
    sub.add_parser("latest")
    p_rest = sub.add_parser("restore")
    p_rest.add_argument("--file", type=Path)
    args = parser.parse_args(argv)
    config = load_config(args.config)
    if args.cmd == "create":
        if args.if_leader:
            from leader import is_leader

            if not is_leader(config):
                print("not leader; skip scheduled gateway checkpoint")
                return 0
        create_checkpoint(config)
        return 0
    if args.cmd == "latest":
        path = latest_dump(config)
        print(str(path) if path else "")
        return 0 if path else 1
    if args.cmd == "restore":
        restore_checkpoint(config, dump=args.file)
        return 0
    return 1


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    raise SystemExit(main())
