#!/usr/bin/env python3
"""Shared path / config helpers for hermes-ha."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any


class ConfigError(RuntimeError):
    pass


def expand(path: str | Path) -> Path:
    return Path(os.path.expanduser(str(path))).resolve()


def validate_config(config: dict[str, Any], source: Path) -> None:
    required = ("node_id", "peer_id", "icloud_root", "runtime_dir")
    missing = [key for key in required if not str(config.get(key) or "").strip()]
    if missing:
        raise ConfigError(f"invalid Hermes HA config {source}: missing {', '.join(missing)}")
    if config["node_id"] == config["peer_id"]:
        raise ConfigError(f"invalid Hermes HA config {source}: node_id equals peer_id")
    hosts = config.get("hosts")
    if hosts is not None and not isinstance(hosts, dict):
        raise ConfigError(f"invalid Hermes HA config {source}: hosts must be an object")


def load_config(path: Path | None = None) -> dict[str, Any]:
    candidates: list[Path] = []
    if path:
        candidates.append(path)
    env = os.environ.get("HERMES_HA_CONFIG")
    if env:
        candidates.append(Path(env))
    candidates.extend(
        [
            expand("~/.config/hermes-ha/config.json"),
            Path(__file__).resolve().parents[1] / "config.json",
        ]
    )
    for candidate in candidates:
        if candidate.is_file():
            data = json.loads(candidate.read_text(encoding="utf-8"))
            if not isinstance(data, dict):
                raise ConfigError(f"invalid Hermes HA config {candidate}: root must be an object")
            validate_config(data, candidate)
            data["_config_path"] = str(candidate)
            return data
    checked = ", ".join(str(item) for item in candidates)
    raise FileNotFoundError(f"hermes-ha config not found (checked: {checked})")


def node_id(config: dict[str, Any]) -> str:
    env = os.environ.get("HERMES_HA_NODE_ID", "").strip()
    if env:
        return env
    return str(config.get("node_id") or "").strip() or "unknown"


def icloud_root(config: dict[str, Any]) -> Path:
    return expand(str(config.get("icloud_root") or "~/iCloudDrive/hermes-ha"))


def hermes_shared(config: dict[str, Any]) -> Path:
    return icloud_root(config) / "hermes"


def hermes_link(config: dict[str, Any]) -> Path:
    return expand(str(config.get("hermes_link") or "~/.hermes"))


def runtime_dir(config: dict[str, Any]) -> Path:
    return expand(str(config.get("runtime_dir") or "~/.config/hermes-ha"))


def atomic_write_text(path: Path, text: str, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp.{os.getpid()}")
    tmp.write_text(text, encoding="utf-8")
    os.chmod(tmp, mode)
    tmp.replace(path)


def atomic_write_json(path: Path, payload: dict[str, Any], mode: int = 0o600) -> None:
    atomic_write_text(path, json.dumps(payload, ensure_ascii=False, indent=2) + "\n", mode=mode)


def read_json(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None
