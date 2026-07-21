#!/usr/bin/env python3
"""Migrate Hermes hot state onto iCloud (hybrid local home).

rclone iCloud FUSE cannot create symlinks *inside* the mount (Errno 5).
Therefore HERMES_HOME stays a local directory; shared paths are symlinks
*from local into iCloud*. Bulky trees stay under ~/.config/hermes-ha/local_trees.
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from common import (
    expand,
    hermes_link,
    hermes_shared,
    icloud_root,
    load_config,
    node_id,
    runtime_dir,
)

# Shared dirs/files that live on iCloud and are linked into local ~/.hermes.
DEFAULT_SHARED_DIRS = (
    "cron",
    "sessions",
    "memories",
    "report_outbox",
    "scripts",
    "plugins",
    "plans",
    "platforms",
    "sandboxes",
    "pairing",
    "hooks",
    "gateway",
)
DEFAULT_SHARED_FILES = (
    "SOUL.md",
    "config.yaml",
    "channel_directory.json",
    "gateway_state.json",
    "report_delivery_state.json",
    "cursor_runner_pending_result.json",
    ".restart_last_processed.json",
    ".skills_prompt_snapshot.json",
    ".hermes_history",
    ".update_check",
    "kanban.db",
    "verification_evidence.db",
)


def run(cmd: list[str], check: bool = True) -> subprocess.CompletedProcess[str]:
    print("+", " ".join(cmd), flush=True)
    return subprocess.run(cmd, check=check, text=True)


def hermes_home_path(config: dict[str, Any]) -> Path:
    """Return ~/.hermes path without following a final symlink."""
    raw = Path(os.path.expanduser(str(config.get("hermes_link") or "~/.hermes")))
    return raw


def rclone_bin() -> str:
    return shutil.which("rclone") or str(Path.home() / ".local/bin/rclone")


def ensure_layout(config: dict[str, Any]) -> None:
    root = icloud_root(config)
    for sub in ("hermes", "secrets", "checkpoints/gateway", "checkpoints/hermes-state", "state"):
        (root / sub).mkdir(parents=True, exist_ok=True)
    print(f"layout ready under {root}")


def shared_dirs(config: dict[str, Any]) -> list[str]:
    return list(config.get("shared_dirs") or DEFAULT_SHARED_DIRS)


def shared_files(config: dict[str, Any]) -> list[str]:
    return list(config.get("shared_files") or DEFAULT_SHARED_FILES)


def stop_stack(config: dict[str, Any]) -> None:
    units = (config.get("stack_units") or {}).get("user") or []
    for unit in units:
        run(["systemctl", "--user", "stop", unit], check=False)
    time.sleep(2)


def start_stack(config: dict[str, Any]) -> None:
    units = (config.get("stack_units") or {}).get("user") or []
    for unit in units:
        run(["systemctl", "--user", "start", unit], check=False)


def local_trees_dir(config: dict[str, Any]) -> Path:
    path = runtime_dir(config) / "local_trees"
    path.mkdir(parents=True, exist_ok=True)
    return path


def rclone_sync_path(local: Path, remote: str, *, extra_excludes: list[str] | None = None) -> None:
    rclone = rclone_bin()
    if not Path(rclone).is_file():
        raise RuntimeError("rclone not found")
    cmd = [
        rclone,
        "sync",
        f"{local}/" if local.is_dir() else str(local),
        remote,
        "--retries",
        "5",
        "--low-level-retries",
        "10",
        "--transfers",
        "8",
        "--checkers",
        "16",
        "--fast-list",
        "--max-size",
        "100M",
        "-v",
        "--stats",
        "30s",
        "--stats-one-line",
        "--exclude",
        "*.lock",
        "--exclude",
        ".env",
        "--exclude",
        "auth.json",
        "--exclude",
        "cache/**",
        "--exclude",
        "logs/**",
        "--exclude",
        "audio_cache/**",
        "--exclude",
        "image_cache/**",
        "--exclude",
        "node_modules/**",
        "--exclude",
        ".git/**",
        "--exclude",
        "venv/**",
        "--exclude",
        ".venv/**",
        "--exclude",
        "* 2.*",
        "--exclude",
        "* (1).*",
    ]
    for ex in extra_excludes or []:
        cmd.extend(["--exclude", ex])
    if local.is_file():
        cmd = [
            rclone,
            "copyto",
            str(local),
            remote,
            "--retries",
            "5",
            "-v",
        ]
        run(cmd, check=False)
        return
    run(cmd, check=False)


def sync_shared_to_icloud(config: dict[str, Any], source: Path) -> None:
    """Push allowlisted hot state from local Hermes home into iCloud."""
    ensure_layout(config)
    remote_root = "icloud:hermes-ha/hermes"
    source = source.resolve() if source.exists() else source

    for rel in shared_dirs(config):
        local = source / rel
        if not local.is_dir():
            print(f"skip missing dir {local}")
            continue
        # If already a symlink into iCloud, skip (already shared)
        if local.is_symlink():
            target = local.resolve()
            if "iCloudDrive/hermes-ha/hermes" in str(target):
                print(f"already shared link {rel}")
                continue
        print(f"sync dir {rel}")
        rclone_sync_path(local, f"{remote_root}/{rel}")

    for rel in shared_files(config):
        local = source / rel
        if local.is_symlink():
            target = local.resolve()
            if "iCloudDrive/hermes-ha/hermes" in str(target):
                print(f"already shared link {rel}")
                continue
        if not local.is_file():
            # also pick config.yaml.bak.*
            if "*" in rel:
                continue
            print(f"skip missing file {local}")
            continue
        print(f"sync file {rel}")
        rclone_sync_path(local, f"{remote_root}/{rel}")

    # config.yaml.bak.* via copy with includes
    bak_glob = list(source.glob("config.yaml.bak.*"))
    for bak in bak_glob:
        if bak.is_file() and not bak.is_symlink():
            print(f"sync file {bak.name}")
            rclone_sync_path(bak, f"{remote_root}/{bak.name}")

    # profiles: only hot subtrees
    profiles = source / "profiles"
    if profiles.is_dir() and not profiles.is_symlink():
        for profile in profiles.iterdir():
            if not profile.is_dir():
                continue
            for sub in ("cron", "sessions", "memories"):
                p = profile / sub
                if p.is_dir() and not p.is_symlink():
                    rel = f"profiles/{profile.name}/{sub}"
                    print(f"sync dir {rel}")
                    rclone_sync_path(p, f"{remote_root}/{rel}")
            for fname in ("config.yaml", "SOUL.md", "gateway_state.json", "channel_directory.json"):
                f = profile / fname
                if f.is_file() and not f.is_symlink():
                    rel = f"profiles/{profile.name}/{fname}"
                    print(f"sync file {rel}")
                    rclone_sync_path(f, f"{remote_root}/{rel}")

    state_db = source / "state.db"
    maybe_state_checkpoint(config, source=state_db if state_db.is_file() else None)

    print("shared sync done")


def _replace_with_symlink(dest: Path, target: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.is_symlink():
        if dest.resolve() == target.resolve():
            print(f"ok {dest} -> {target}")
            return
        dest.unlink()
    elif dest.exists():
        stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
        stash = dest.with_name(f"{dest.name}.pre-share-{stamp}")
        print(f"stash {dest} -> {stash}")
        dest.rename(stash)
    dest.symlink_to(target)
    print(f"linked {dest} -> {target}")


def wire_shared_links(config: dict[str, Any], home: Path) -> None:
    """Point local shared paths at iCloud copies (symlinks on local FS only)."""
    shared = hermes_shared(config)
    for rel in shared_dirs(config):
        target = shared / rel
        if not target.exists():
            target.mkdir(parents=True, exist_ok=True)
        _replace_with_symlink(home / rel, target)
    for rel in shared_files(config):
        target = shared / rel
        if not target.exists():
            # leave missing; may appear after sync
            if not (home / rel).exists():
                print(f"shared file missing on both sides: {rel}")
                continue
        if target.exists() or target.is_symlink():
            _replace_with_symlink(home / rel, target)

    # profiles hot bits
    profiles_shared = shared / "profiles"
    profiles_home = home / "profiles"
    if profiles_shared.is_dir():
        profiles_home.mkdir(parents=True, exist_ok=True)
        for profile in profiles_shared.iterdir():
            if not profile.is_dir():
                continue
            dest_prof = profiles_home / profile.name
            dest_prof.mkdir(parents=True, exist_ok=True)
            for sub in ("cron", "sessions", "memories"):
                t = profile / sub
                if t.exists():
                    _replace_with_symlink(dest_prof / sub, t)
            for fname in ("config.yaml", "SOUL.md", "gateway_state.json", "channel_directory.json"):
                t = profile / fname
                if t.is_file():
                    _replace_with_symlink(dest_prof / fname, t)


def wire_local_trees(config: dict[str, Any], source_root: Path | None = None) -> None:
    """Keep bulky trees on local disk; symlink into local HERMES_HOME only."""
    trees = local_trees_dir(config)
    home = hermes_home_path(config)
    if home.is_symlink():
        # Prefer operating on the real directory behind the link
        home = Path(os.path.expanduser(str(config.get("hermes_link") or "~/.hermes")))
        if home.is_symlink():
            home = home.resolve()
    for rel in config.get("local_trees") or []:
        local = trees / rel.replace("/", "__")
        src_candidates: list[Path] = []
        if source_root is not None:
            src_candidates.append(source_root / rel)
        home_path = hermes_home_path(config)
        src_candidates.append(home_path / rel)
        bak_latest = Path(os.path.expanduser("~/.hermes.local-backup-latest"))
        if bak_latest.exists():
            src_candidates.append(bak_latest / rel)

        if not local.exists():
            moved = False
            for cand in src_candidates:
                if not cand.exists():
                    continue
                # Never treat cwd / empty path as a tree
                try:
                    if cand.resolve() in {Path("/"), Path.cwd().resolve(), home_path.resolve()}:
                        continue
                except OSError:
                    continue
                real = cand.resolve() if cand.is_symlink() else cand
                if not (real.is_dir() or real.is_file()):
                    continue
                if str(real) == str(local.resolve()) if local.exists() else False:
                    continue
                print(f"moving local tree {cand} -> {local}")
                local.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(real if cand.is_symlink() else cand), str(local))
                moved = True
                break
            if not moved:
                print(f"local tree missing (create on this host): {rel} -> {local}")
                continue
        dest = hermes_home_path(config)
        if dest.is_symlink():
            dest = dest.resolve()
        _replace_with_symlink(dest / rel, local)


def write_local_only_placeholders(config: dict[str, Any]) -> None:
    """Pid/lock files stay local under runtime; symlink into local HERMES_HOME.

    Never create symlinks *inside* an iCloud-mounted shared dir (rclone FUSE
    returns Errno 5). Paths under shared_dirs are skipped — single-writer locks
    may live directly on the shared tree.
    """
    runtime = runtime_dir(config) / "local_only"
    runtime.mkdir(parents=True, exist_ok=True)
    home = hermes_home_path(config)
    if home.is_symlink():
        home = home.resolve()
    shared_dir_set = set(shared_dirs(config))
    shared_prefixes = tuple(f"{d}/" for d in shared_dir_set)
    for rel in config.get("local_only") or []:
        if rel in {".env", "auth.json"}:
            continue
        if rel in shared_dir_set or rel.startswith(shared_prefixes):
            print(f"skip local-only under shared tree: {rel}")
            continue
        local = runtime / rel.replace("/", "__")
        if not local.exists():
            local.write_text("", encoding="utf-8")
            os.chmod(local, 0o600)
        dest = home / rel
        # If parent is already an iCloud symlink, skip
        parent = dest.parent
        try:
            if parent.exists() and "iCloudDrive/hermes-ha" in str(parent.resolve()):
                print(f"skip local-only parent on iCloud: {rel}")
                continue
        except OSError:
            pass
        _replace_with_symlink(dest, local)


def normalize_hermes_home(config: dict[str, Any]) -> Path:
    """If ~/.hermes is a symlink to a backup dir, materialize as real ~/.hermes."""
    link = hermes_home_path(config)
    if link.is_symlink():
        target = link.resolve()
        if "iCloudDrive/hermes-ha/hermes" in str(target):
            raise RuntimeError(
                f"{link} points at iCloud mount; hybrid mode needs a local directory. "
                "Restore from .hermes.local-backup-* first."
            )
        print(f"materialize {link} from {target}")
        link.unlink()
        target.rename(link)
    elif not link.exists():
        link.mkdir(parents=True)
    return link



def maybe_state_checkpoint(config: dict[str, Any], source=None) -> None:
    """Only the leader should publish state.db chunks into shared iCloud."""
    from leader import is_leader, read_leader

    current = read_leader(config)
    if not is_leader(config, current):
        print(f"not leader; skip state.db checkpoint (holder={current.get('role_holder')})")
        return
    try:
        from state_checkpoint import create_checkpoint
        create_checkpoint(config, source=source)
    except Exception as exc:  # noqa: BLE001
        print(f"state.db checkpoint skipped: {exc}", file=sys.stderr)


def migrate(config: dict[str, Any], *, stop_services: bool, cutover: bool) -> None:
    ensure_layout(config)
    home = normalize_hermes_home(config) if cutover else hermes_home_path(config)
    if home.is_symlink():
        source = home.resolve()
    else:
        source = home
    if not source.is_dir():
        raise RuntimeError(f"Hermes home missing: {source}")

    print(f"sync {source} -> iCloud shared")
    sync_shared_to_icloud(config, source)

    if not cutover:
        print("sync-only done (no cutover)")
        return

    if stop_services:
        stop_stack(config)
        sync_shared_to_icloud(config, source)

    from secrets import apply_runtime, ensure_identity, seal_from_hermes

    ensure_identity(config)
    seal_from_hermes(config, source_root=source)

    wire_local_trees(config, source_root=source)
    wire_shared_links(config, home if not home.is_symlink() else home.resolve())
    write_local_only_placeholders(config)
    try:
        from state_checkpoint import wire_state_symlink

        wire_state_symlink(config)
    except Exception as exc:  # noqa: BLE001
        print(f"state.db wire skipped: {exc}", file=sys.stderr)
    apply_runtime(config)

    leader_file = icloud_root(config) / "leader.json"
    if not leader_file.is_file():
        from leader import acquire

        acquire(config, mode="PRIMARY", reason="p0_migrate_cutover", force=True)

    marker = runtime_dir(config) / "migrate-cutover.json"
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text(
        f'{{"node":"{node_id(config)}","mode":"hybrid","shared":"{hermes_shared(config)}"}}\n',
        encoding="utf-8",
    )
    print("cutover complete (hybrid: local home + iCloud shared links)")
    if stop_services:
        print("services left STOPPED; run: hermes-ha stack start")


def link_home_standby(config: dict[str, Any]) -> None:
    """Band cold standby: create local ~/.hermes with shared + local-tree links."""
    ensure_layout(config)
    home = hermes_home_path(config)
    if home.is_symlink() and "iCloudDrive/hermes-ha/hermes" in str(home.resolve()):
        home.unlink()
    if home.exists() and not home.is_dir():
        raise RuntimeError(f"{home} exists and is not a directory")
    home.mkdir(parents=True, exist_ok=True)
    wire_shared_links(config, home)
    wire_local_trees(config)
    write_local_only_placeholders(config)
    try:
        from state_checkpoint import wire_state_symlink

        wire_state_symlink(config)
    except Exception as exc:  # noqa: BLE001
        print(f"state.db wire skipped: {exc}", file=sys.stderr)
    print(f"standby home ready at {home}")


def wait_sync(config: dict[str, Any], timeout: int = 300) -> int:
    shared = hermes_shared(config)
    deadline = time.time() + timeout
    while time.time() < deadline:
        bad = list(shared.rglob("*.icloud"))
        conflicts = [
            p
            for p in shared.rglob("*")
            if " (1)." in p.name or " 2." in p.name or p.name.endswith(" 2")
        ]
        if not bad and not conflicts:
            print("sync looks clean")
            return 0
        print(f"waiting sync; placeholders={len(bad)} conflicts={len(conflicts)}")
        time.sleep(5)
    print("timeout waiting for iCloud sync", file=sys.stderr)
    return 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Hermes HA migrate to iCloud (hybrid)")
    parser.add_argument("--config", type=Path)
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("ensure-layout")
    p_sync = sub.add_parser("sync")
    p_sync.add_argument("--stop", action="store_true")
    p_cut = sub.add_parser("cutover")
    p_cut.add_argument("--stop", action="store_true", default=True)
    p_cut.add_argument("--no-stop", action="store_true")
    sub.add_parser("link-home")
    p_wait = sub.add_parser("wait-sync")
    p_wait.add_argument("--timeout", type=int, default=300)
    args = parser.parse_args(argv)
    config = load_config(args.config)

    if args.cmd == "ensure-layout":
        ensure_layout(config)
        return 0
    if args.cmd == "sync":
        if args.stop:
            stop_stack(config)
        home = hermes_home_path(config)
        src = home.resolve() if home.exists() else home
        sync_shared_to_icloud(config, src)
        print("sync-only done (no cutover)")
        return 0
    if args.cmd == "cutover":
        migrate(config, stop_services=not args.no_stop, cutover=True)
        return 0
    if args.cmd == "link-home":
        link_home_standby(config)
        return 0
    if args.cmd == "wait-sync":
        return wait_sync(config, timeout=args.timeout)
    return 1


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    raise SystemExit(main())
