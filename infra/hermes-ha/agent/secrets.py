#!/usr/bin/env python3
"""Encrypt / decrypt Hermes secrets with age (option B: ciphertext in iCloud)."""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
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


class SecretsError(RuntimeError):
    pass


def age_bin() -> str:
    path = shutil.which("age")
    if not path:
        raise SecretsError("age not found in PATH; install age (https://github.com/FiloSottile/age)")
    return path


def age_keygen_bin() -> str:
    path = shutil.which("age-keygen")
    if not path:
        raise SecretsError("age-keygen not found in PATH")
    return path


def identity_path(config: dict[str, Any]) -> Path:
    return expand(str(config.get("age_identity") or "~/.config/hermes-ha/age.key"))


def recipients_path(config: dict[str, Any]) -> Path:
    return expand(
        str(config.get("age_recipients_file") or "~/.config/hermes-ha/age.recipients")
    )


def runtime_secrets_dir(config: dict[str, Any]) -> Path:
    return runtime_dir(config) / "runtime"


def ensure_identity(config: dict[str, Any]) -> Path:
    path = identity_path(config)
    if path.is_file():
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run([age_keygen_bin(), "-o", str(path)], check=True)
    os.chmod(path, 0o600)
    # Extract recipient
    pub = subprocess.check_output([age_keygen_bin(), "-y", str(path)], text=True).strip()
    recipients = recipients_path(config)
    existing = recipients.read_text(encoding="utf-8") if recipients.is_file() else ""
    if pub not in existing:
        with recipients.open("a", encoding="utf-8") as fh:
            fh.write(f"# {node_id(config)}\n{pub}\n")
        os.chmod(recipients, 0o600)
    # Also publish recipient into iCloud so peer can encrypt for us later
    shared_recipients = icloud_root(config) / "secrets" / "age.recipients"
    shared_recipients.parent.mkdir(parents=True, exist_ok=True)
    shared_text = shared_recipients.read_text(encoding="utf-8") if shared_recipients.is_file() else ""
    if pub not in shared_text:
        with shared_recipients.open("a", encoding="utf-8") as fh:
            fh.write(f"# {node_id(config)}\n{pub}\n")
        os.chmod(shared_recipients, 0o600)
    return path


def recipient_args(config: dict[str, Any]) -> list[str]:
    """Prefer shared iCloud recipients (both hosts) then local."""
    paths = [
        icloud_root(config) / "secrets" / "age.recipients",
        recipients_path(config),
    ]
    args: list[str] = []
    seen: set[str] = set()
    for path in paths:
        if not path.is_file():
            continue
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if line in seen:
                continue
            seen.add(line)
            args.extend(["-r", line])
    if not args:
        # Bootstrap: ensure local identity and use its recipient
        ensure_identity(config)
        return recipient_args(config)
    return args


def encrypt_file(config: dict[str, Any], plaintext: Path, ciphertext: Path) -> None:
    if not plaintext.is_file():
        raise SecretsError(f"plaintext missing: {plaintext}")
    ciphertext.parent.mkdir(parents=True, exist_ok=True)
    tmp = ciphertext.with_suffix(ciphertext.suffix + ".tmp")
    cmd = [age_bin(), "-a", *recipient_args(config), "-o", str(tmp), str(plaintext)]
    try:
        subprocess.run(cmd, check=True)
        os.chmod(tmp, 0o600)
        tmp.replace(ciphertext)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise


def decrypt_file(config: dict[str, Any], ciphertext: Path, plaintext: Path) -> None:
    if not ciphertext.is_file():
        raise SecretsError(f"ciphertext missing: {ciphertext}")
    identity = ensure_identity(config)
    plaintext.parent.mkdir(parents=True, exist_ok=True)
    tmp = plaintext.with_suffix(plaintext.suffix + ".tmp")
    cmd = [age_bin(), "-d", "-i", str(identity), "-o", str(tmp), str(ciphertext)]
    try:
        subprocess.run(cmd, check=True)
        os.chmod(tmp, 0o600)
        tmp.replace(plaintext)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise


def secret_specs(config: dict[str, Any]) -> list[dict[str, str]]:
    specs = config.get("secrets") or []
    return [dict(item) for item in specs]


def seal_from_hermes(config: dict[str, Any], source_root: Path | None = None) -> None:
    """Encrypt .env / auth.json from a Hermes home into iCloud secrets/."""
    ensure_identity(config)
    root = source_root or hermes_link(config)
    if not root.exists():
        # Fall back to shared path or classic home
        for candidate in (hermes_shared(config), expand("~/.hermes")):
            if candidate.exists():
                root = candidate
                break
    for spec in secret_specs(config):
        src = root / spec["source"]
        dst = icloud_root(config) / spec["encrypted"]
        if not src.is_file():
            print(f"skip missing {src}", file=sys.stderr)
            continue
        encrypt_file(config, src, dst)
        print(f"sealed {src} -> {dst}")


def apply_runtime(config: dict[str, Any]) -> None:
    """Decrypt secrets to local runtime and point HERMES_HOME entries at them via symlinks."""
    ensure_identity(config)
    runtime = runtime_secrets_dir(config)
    runtime.mkdir(parents=True, exist_ok=True)
    os.chmod(runtime, 0o700)

    link = hermes_link(config)
    # Link into the active HERMES_HOME only. Putting symlinks *inside* the iCloud
    # tree is unreliable on rclone FUSE; each host keeps local runtime files and
    # points ~/.hermes/<secret> at them (or at runtime after cutover symlink).
    targets: list[Path] = []
    if link.exists() or link.is_symlink():
        targets.append(link)

    for spec in secret_specs(config):
        cipher = icloud_root(config) / spec["encrypted"]
        plain = runtime / Path(spec["source"]).name
        decrypt_file(config, cipher, plain)
        for target_root in targets:
            dest = target_root / spec["source"]
            dest.parent.mkdir(parents=True, exist_ok=True)
            if dest.is_symlink() or dest.is_file():
                dest.unlink()
            elif dest.exists():
                raise SecretsError(f"refusing to replace non-file secret target: {dest}")
            dest.symlink_to(plain)
            print(f"linked {dest} -> {plain}")
        print(f"applied {cipher} -> {plain}")


def init_keys(config: dict[str, Any]) -> None:
    path = ensure_identity(config)
    pub = subprocess.check_output([age_keygen_bin(), "-y", str(path)], text=True).strip()
    print(f"identity: {path}")
    print(f"recipient: {pub}")
    print(f"recipients file: {recipients_path(config)}")
    shared = icloud_root(config) / "secrets" / "age.recipients"
    print(f"shared recipients: {shared}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Hermes HA age secrets")
    parser.add_argument("--config", type=Path)
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("init-keys")
    p_seal = sub.add_parser("seal")
    p_seal.add_argument("--from", dest="source_root", type=Path)
    sub.add_parser("apply")
    args = parser.parse_args(argv)
    config = load_config(args.config)

    if args.cmd == "init-keys":
        init_keys(config)
        return 0
    if args.cmd == "seal":
        seal_from_hermes(config, source_root=args.source_root)
        return 0
    if args.cmd == "apply":
        apply_runtime(config)
        return 0
    return 1


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    raise SystemExit(main())
