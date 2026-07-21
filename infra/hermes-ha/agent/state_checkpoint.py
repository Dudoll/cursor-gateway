#!/usr/bin/env python3
"""Chunked Hermes state.db checkpoint for iCloud (Apple rejects ~100MB+ uploads)."""

from __future__ import annotations

import argparse
import datetime as dt
import gzip
import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

from common import (
    atomic_write_json,
    hermes_link,
    hermes_shared,
    icloud_root,
    load_config,
    read_json,
    runtime_dir,
)


CHUNK_SIZE = 40 * 1024 * 1024  # 40 MiB chunks stay under Apple upload limits


def checkpoint_chunk_size(config: dict[str, Any]) -> int:
    size = int((config.get("state_checkpoint") or {}).get("chunk_size_bytes") or CHUNK_SIZE)
    if size <= 0 or size > 90 * 1024 * 1024:
        raise RuntimeError("state checkpoint chunk_size_bytes must be between 1 and 90 MiB")
    return size


def checkpoint_root(config: dict[str, Any]) -> Path:
    return icloud_root(config) / "checkpoints" / "hermes-state"


def checkpoint_transport(config: dict[str, Any]) -> str:
    return str((config.get("state_checkpoint") or {}).get("transport") or "filesystem")


def checkpoint_remote(config: dict[str, Any]) -> str:
    return str(
        (config.get("state_checkpoint") or {}).get("remote")
        or "icloud:hermes-ha/checkpoints/hermes-state"
    ).rstrip("/")


def checkpoint_work_root(config: dict[str, Any]) -> Path:
    if checkpoint_transport(config) == "rclone":
        return runtime_dir(config) / "checkpoint-staging" / "hermes-state"
    return checkpoint_root(config)


def checkpoint_restore_root(config: dict[str, Any]) -> Path:
    if checkpoint_transport(config) != "rclone":
        return checkpoint_root(config)
    root = runtime_dir(config) / "checkpoint-cache" / "hermes-state"
    root.mkdir(parents=True, exist_ok=True)
    rclone = shutil.which("rclone")
    if not rclone:
        raise RuntimeError("rclone is required for state checkpoint transport")
    subprocess.run(
        [rclone, "sync", checkpoint_remote(config), str(root)],
        check=True,
    )
    return root


def remote_manifest(config: dict[str, Any]) -> dict[str, Any] | None:
    rclone = shutil.which("rclone")
    if not rclone:
        raise RuntimeError("rclone is required for state checkpoint transport")
    proc = subprocess.run(
        [rclone, "cat", f"{checkpoint_remote(config)}/manifest.json"],
        text=True,
        capture_output=True,
        check=False,
    )
    if proc.returncode != 0:
        return None
    try:
        data = json.loads(proc.stdout)
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


def publish_remote(
    config: dict[str, Any],
    root: Path,
    manifest: dict[str, Any],
    previous: dict[str, Any] | None,
) -> None:
    rclone = shutil.which("rclone")
    if not rclone:
        raise RuntimeError("rclone is required for state checkpoint transport")
    remote = checkpoint_remote(config)
    for name in manifest["parts"]:
        subprocess.run([rclone, "copyto", str(root / name), f"{remote}/{name}"], check=True)
    local_manifest = root / "manifest.json"
    subprocess.run([rclone, "copyto", str(local_manifest), f"{remote}/manifest.json"], check=True)

    keep = set(manifest["parts"])
    keep.update(str(name) for name in (previous or {}).get("parts") or [])
    listing = subprocess.run(
        [rclone, "lsf", remote, "--files-only"],
        text=True,
        capture_output=True,
        check=True,
    )
    for name in listing.stdout.splitlines():
        name = name.strip()
        if name.startswith("state.db") and ".gz.part" in name and name not in keep:
            subprocess.run([rclone, "deletefile", f"{remote}/{name}"], check=True)


def local_state_path(config: dict[str, Any]) -> Path:
    trees = runtime_dir(config) / "local_trees"
    return trees / "state.db"


def active_state_candidates(config: dict[str, Any]) -> list[Path]:
    link = hermes_link(config)
    shared = hermes_shared(config)
    return [
        local_state_path(config),
        link / "state.db",
        shared / "state.db",
        Path(os.path.expanduser("~/.hermes/state.db")),
    ]


def find_source_state(config: dict[str, Any]) -> Path | None:
    for path in active_state_candidates(config):
        if path.is_file() and not path.is_symlink():
            return path
        if path.is_symlink():
            try:
                resolved = path.resolve()
            except OSError:
                continue
            if resolved.is_file():
                return resolved
    return None


def require_checkpoint_leader(config: dict[str, Any]) -> dict[str, Any]:
    from leader import is_leader, read_leader

    current = read_leader(config)
    if not is_leader(config, current):
        raise RuntimeError(
            f"refusing state checkpoint on non-leader "
            f"(holder={current.get('role_holder')})"
        )
    return current


def create_checkpoint(config: dict[str, Any], source: Path | None = None) -> Path:
    current = require_checkpoint_leader(config)
    src = source if source is not None and source.is_file() else find_source_state(config)
    if not src or not src.is_file():
        raise RuntimeError("state.db not found for checkpoint")

    previous = (
        remote_manifest(config)
        if checkpoint_transport(config) == "rclone"
        else read_json(checkpoint_root(config) / "manifest.json")
    )
    out = checkpoint_work_root(config)
    out.mkdir(parents=True, exist_ok=True)

    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    generation = f"state.db.{stamp}.{os.getpid()}"
    gz_path = out / f".{generation}.gz.tmp"
    chunk_size = checkpoint_chunk_size(config)
    sha = hashlib.sha256()
    raw_size = 0
    parts: list[str] = []
    try:
        with src.open("rb") as fin, gzip.open(gz_path, "wb", compresslevel=6) as fout:
            while True:
                block = fin.read(1024 * 1024)
                if not block:
                    break
                raw_size += len(block)
                sha.update(block)
                fout.write(block)

        with gz_path.open("rb") as fin:
            idx = 0
            while True:
                chunk = fin.read(chunk_size)
                if not chunk:
                    break
                name = f"{generation}.gz.part{idx:03d}"
                part_tmp = out / f".{name}.tmp"
                part_tmp.write_bytes(chunk)
                part_tmp.replace(out / name)
                parts.append(name)
                idx += 1
        if not parts:
            raise RuntimeError("state checkpoint produced no parts")

        manifest = {
            "created_at": stamp,
            "source": str(src),
            "raw_size": raw_size,
            "sha256": sha.hexdigest(),
            "parts": parts,
            "chunk_size": chunk_size,
            "node": current.get("role_holder"),
            "epoch": current.get("epoch"),
        }
        atomic_write_json(out / "manifest.json", manifest)
        if checkpoint_transport(config) == "rclone":
            publish_remote(config, out, manifest, previous)
    except Exception:
        for name in parts:
            (out / name).unlink(missing_ok=True)
        raise
    finally:
        gz_path.unlink(missing_ok=True)
        for tmp in out.glob(f".{generation}*.tmp"):
            tmp.unlink(missing_ok=True)

    keep = set(parts)
    keep.update(str(name) for name in (previous or {}).get("parts") or [])
    for old in out.glob("state.db*.gz.part*"):
        if old.name not in keep:
            old.unlink(missing_ok=True)
    print(f"state checkpoint: {raw_size} bytes -> {len(parts)} parts @ {out}")
    return out / "manifest.json"


def restore_checkpoint(config: dict[str, Any], dest: Path | None = None) -> Path:
    out = checkpoint_restore_root(config)
    manifest = read_json(out / "manifest.json")
    if not manifest or not manifest.get("parts"):
        raise RuntimeError("no hermes-state checkpoint manifest")

    dest = dest or local_state_path(config)
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp_gz = dest.with_suffix(".db.gz.tmp")
    tmp_db = dest.with_suffix(".db.tmp")
    tmp_gz.unlink(missing_ok=True)
    tmp_db.unlink(missing_ok=True)
    try:
        with tmp_gz.open("wb") as fout:
            for name in manifest["parts"]:
                part_name = str(name)
                if Path(part_name).name != part_name:
                    raise RuntimeError(f"invalid checkpoint part name: {part_name}")
                part = out / part_name
                if not part.is_file():
                    raise RuntimeError(f"missing checkpoint part: {part}")
                with part.open("rb") as fin:
                    shutil.copyfileobj(fin, fout, length=1024 * 1024)

        sha = hashlib.sha256()
        with gzip.open(tmp_gz, "rb") as fin, tmp_db.open("wb") as fout:
            while True:
                block = fin.read(1024 * 1024)
                if not block:
                    break
                sha.update(block)
                fout.write(block)

        expected = str(manifest.get("sha256") or "")
        if expected and sha.hexdigest() != expected:
            raise RuntimeError("state.db checksum mismatch after restore")
        expected_size = int(manifest.get("raw_size") or 0)
        if expected_size and tmp_db.stat().st_size != expected_size:
            raise RuntimeError("state.db size mismatch after restore")

        os.chmod(tmp_db, 0o600)
        tmp_db.replace(dest)
    except Exception:
        tmp_db.unlink(missing_ok=True)
        raise
    finally:
        tmp_gz.unlink(missing_ok=True)
    print(f"restored state.db -> {dest}")
    return dest


def wire_state_symlink(config: dict[str, Any]) -> None:
    """Point HERMES_HOME/state.db at local_trees copy (never write into iCloud tree)."""
    local = local_state_path(config)
    if not local.is_file():
        restore_checkpoint(config, dest=local)
    # Only wire the local HERMES_HOME. Putting a symlink inside the iCloud shared
    # tree fails on rclone FUSE (EIO) and would confuse the peer host.
    roots = [hermes_link(config)]
    for root in roots:
        if not (root.exists() or root.is_symlink()):
            continue
        # If HERMES_HOME itself is the iCloud path, skip — keep state only in local_trees.
        try:
            if "iCloudDrive" in str(root.resolve()):
                print(f"skip wiring state.db into iCloud path {root}")
                continue
        except OSError:
            pass
        dest = root / "state.db"
        try:
            if dest.is_symlink() or dest.is_file():
                dest.unlink()
            elif dest.exists():
                continue
            dest.symlink_to(local)
            print(f"linked {dest} -> {local}")
        except OSError as exc:
            print(f"state link failed {dest}: {exc}", file=sys.stderr)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Hermes state.db chunked checkpoint")
    parser.add_argument("--config", type=Path)
    sub = parser.add_subparsers(dest="cmd", required=True)
    p_create = sub.add_parser("create")
    p_create.add_argument("--if-leader", action="store_true")
    sub.add_parser("restore")
    sub.add_parser("wire")
    args = parser.parse_args(argv)
    config = load_config(args.config)
    if args.cmd == "create":
        if args.if_leader:
            from leader import is_leader

            if not is_leader(config):
                print("not leader; skip scheduled state checkpoint")
                return 0
        create_checkpoint(config)
        return 0
    if args.cmd == "restore":
        restore_checkpoint(config)
        return 0
    if args.cmd == "wire":
        wire_state_symlink(config)
        return 0
    return 1


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    raise SystemExit(main())
