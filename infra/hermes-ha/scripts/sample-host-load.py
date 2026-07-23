#!/usr/bin/env python3
"""Lightweight host load / high-resource sampler for vps-dmit (fail-open).

Writes rolling JSON under ~/.local/state/hermes-ha/host-load/.
Designed for a 1–5 minute systemd timer on a 2 GiB VPS: low CPU/RSS,
no secrets in output, never blocks production on failure.
"""

from __future__ import annotations

import json
import os
import re
import socket
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


DEFAULT_STATE = Path.home() / ".local" / "state" / "hermes-ha" / "host-load"
KEEP_DEFAULT = 288  # ~24h at 5 min, ~9.6h at 2 min
TOP_N = 8
DOCKER_NAMES = ("infra-app-1", "infra-postgres-1")
HERMES_UNITS = (
    "hermes-gateway.service",
    "hermes-gateway-telegram2.service",
)

SECRET_RE = re.compile(
    r"(?i)("
    r"(?:api[_-]?key|token|secret|password|passwd|authorization|bearer|"
    r"cookie|credential|private[_-]?key|access[_-]?key)"
    r"\s*[:=]\s*)([^\s\"']+)"
    r"|(?:(?<=\bbearer\s)|(?<=\bauthorization:\s))([^\s\"']+)"
    r"|(sk-[A-Za-z0-9_-]{8,})"
    r"|([0-9]{8,10}:[A-Za-z0-9_-]{20,})"  # telegram bot tokens
)
HEX_LONG_RE = re.compile(r"\b[0-9a-fA-F]{32,}\b")


def utc_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def redact(text: str, limit: int = 160) -> str:
    def _sub(match: re.Match[str]) -> str:
        prefix = match.group(1) or ""
        return f"{prefix}***"

    value = SECRET_RE.sub(_sub, text)
    value = HEX_LONG_RE.sub("***", value)
    value = re.sub(r"\s+", " ", value).strip()
    if len(value) > limit:
        value = value[: limit - 1] + "…"
    return value


def read_text(path: Path) -> str | None:
    try:
        return path.read_text(encoding="utf-8")
    except OSError:
        return None


def run(
    cmd: list[str],
    *,
    timeout: float = 4.0,
    env: dict[str, str] | None = None,
) -> str | None:
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
            env=env,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    return result.stdout


def meminfo() -> dict[str, Any]:
    raw = read_text(Path("/proc/meminfo")) or ""
    values: dict[str, int] = {}
    for line in raw.splitlines():
        if ":" not in line:
            continue
        key, rest = line.split(":", 1)
        parts = rest.strip().split()
        if not parts:
            continue
        try:
            values[key] = int(parts[0]) * 1024
        except ValueError:
            continue
    total = values.get("MemTotal", 0)
    available = values.get("MemAvailable", 0)
    swap_total = values.get("SwapTotal", 0)
    swap_free = values.get("SwapFree", 0)
    return {
        "ramTotalBytes": total,
        "ramAvailableBytes": available,
        "ramUsedBytes": max(total - available, 0),
        "swapTotalBytes": swap_total,
        "swapUsedBytes": max(swap_total - swap_free, 0),
    }


def loadavg() -> dict[str, Any]:
    try:
        one, five, fifteen = os.getloadavg()
    except OSError:
        return {"ok": False}
    raw = read_text(Path("/proc/loadavg")) or ""
    running = ""
    parts = raw.split()
    if len(parts) >= 4:
        running = parts[3]
    return {
        "ok": True,
        "1": round(one, 2),
        "5": round(five, 2),
        "15": round(fifteen, 2),
        "procs": running,
    }


def cpu_snapshot() -> dict[str, int] | None:
    raw = read_text(Path("/proc/stat"))
    if not raw:
        return None
    for line in raw.splitlines():
        if not line.startswith("cpu "):
            continue
        parts = line.split()
        try:
            nums = [int(x) for x in parts[1:8]]
        except ValueError:
            return None
        idle = nums[3] + (nums[4] if len(nums) > 4 else 0)
        total = sum(nums)
        return {"idle": idle, "total": total}
    return None


def cpu_percent(interval: float = 0.15) -> float | None:
    first = cpu_snapshot()
    if not first:
        return None
    time.sleep(interval)
    second = cpu_snapshot()
    if not second:
        return None
    d_total = second["total"] - first["total"]
    d_idle = second["idle"] - first["idle"]
    if d_total <= 0:
        return None
    return round(max(0.0, min(100.0, (1.0 - d_idle / d_total) * 100.0)), 1)


def read_cgroup_bytes(path: Path) -> int | None:
    text = read_text(path)
    if text is None:
        return None
    value = text.strip()
    if not value or value == "max":
        return None
    try:
        return int(value)
    except ValueError:
        return None


def docker_container_sample(name: str) -> dict[str, Any]:
    sample: dict[str, Any] = {"name": name, "ok": False}
    inspect = run(
        [
            "docker",
            "inspect",
            "--format",
            "{{.State.Running}} {{.Id}} {{.HostConfig.Memory}} {{.HostConfig.NanoCpus}}",
            name,
        ],
        timeout=3,
    )
    if not inspect:
        sample["error"] = "inspect_failed"
        return sample
    parts = inspect.strip().split()
    if len(parts) < 2:
        sample["error"] = "inspect_parse"
        return sample
    running = parts[0].lower() == "true"
    container_id = parts[1]
    sample["running"] = running
    sample["idPrefix"] = container_id[:12]
    try:
        sample["memoryLimitBytes"] = int(parts[2]) if len(parts) > 2 else 0
    except ValueError:
        sample["memoryLimitBytes"] = 0

    stats = run(
        [
            "docker",
            "stats",
            "--no-stream",
            "--format",
            "{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.PIDs}}",
            name,
        ],
        timeout=5,
    )
    if stats:
        fields = stats.strip().split("\t")
        if len(fields) >= 4:
            sample["cpuPerc"] = fields[0].strip().rstrip("%")
            sample["memUsage"] = fields[1].strip()
            sample["memPerc"] = fields[2].strip().rstrip("%")
            sample["pids"] = fields[3].strip()

    # cgroup v2 paths commonly used by Docker
    current_paths = [
        Path(f"/sys/fs/cgroup/system.slice/docker-{container_id}.scope/memory.current"),
        Path(f"/sys/fs/cgroup/docker/{container_id}/memory.current"),
    ]
    peak_paths = [
        Path(f"/sys/fs/cgroup/system.slice/docker-{container_id}.scope/memory.peak"),
        Path(f"/sys/fs/cgroup/docker/{container_id}/memory.peak"),
    ]
    current = next((read_cgroup_bytes(p) for p in current_paths if p.is_file()), None)
    peak = next((read_cgroup_bytes(p) for p in peak_paths if p.is_file()), None)
    if current is None:
        # fallback: scan for matching scope once (bounded)
        root = Path("/sys/fs/cgroup/system.slice")
        if root.is_dir():
            try:
                for child in root.iterdir():
                    if not child.name.startswith(f"docker-{container_id}"):
                        continue
                    current = read_cgroup_bytes(child / "memory.current")
                    peak = read_cgroup_bytes(child / "memory.peak")
                    break
            except OSError:
                pass
    if current is not None:
        sample["cgroupMemoryCurrentBytes"] = current
    if peak is not None:
        sample["cgroupMemoryPeakBytes"] = peak
    sample["ok"] = True
    return sample


def hermes_unit_sample(unit: str) -> dict[str, Any]:
    out = run(
        [
            "systemctl",
            "--user",
            "show",
            unit,
            "-p",
            "ActiveState",
            "-p",
            "SubState",
            "-p",
            "MainPID",
            "-p",
            "MemoryCurrent",
            "-p",
            "MemoryPeak",
            "-p",
            "MemoryHigh",
            "-p",
            "MemoryMax",
            "-p",
            "CPUUsageNSec",
            "-p",
            "TasksCurrent",
            "--no-pager",
        ],
        timeout=3,
    )
    sample: dict[str, Any] = {"unit": unit, "ok": False}
    if not out:
        sample["error"] = "systemctl_failed"
        return sample
    for line in out.splitlines():
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        if key in {"MemoryCurrent", "MemoryPeak", "MemoryHigh", "MemoryMax", "CPUUsageNSec", "TasksCurrent", "MainPID"}:
            if value in {"", "[not set]", "[no data]"}:
                sample[key] = None
            else:
                try:
                    sample[key] = int(value)
                except ValueError:
                    sample[key] = value
        else:
            sample[key] = value
    sample["ok"] = True
    return sample


def top_processes(limit: int = TOP_N) -> list[dict[str, Any]]:
    # Portable: pid, user, %cpu, %mem, rss(kb), etime, args
    out = run(
        ["ps", "-eo", "pid,user,%cpu,%mem,rss,etime,args", "--sort=-rss"],
        timeout=3,
    )
    if not out:
        return []
    rows: list[dict[str, Any]] = []
    for line in out.splitlines()[1:]:
        parts = line.split(None, 6)
        if len(parts) < 7:
            continue
        pid, user, cpu, mem, rss, etime, args = parts
        try:
            rss_kb = int(rss)
        except ValueError:
            continue
        rows.append(
            {
                "pid": int(pid) if pid.isdigit() else pid,
                "user": user,
                "cpu": cpu,
                "mem": mem,
                "rssBytes": rss_kb * 1024,
                "etime": etime,
                "cmd": redact(args),
            }
        )
        if len(rows) >= limit:
            break
    return rows


def collect_sample() -> dict[str, Any]:
    nproc = os.cpu_count() or 1
    return {
        "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "hostname": socket.gethostname(),
        "nodeHint": "vps-dmit" if "dmit" in socket.gethostname().lower() else socket.gethostname(),
        "nproc": nproc,
        "load": loadavg(),
        "cpuPercent": cpu_percent(),
        "memory": meminfo(),
        "docker": [docker_container_sample(name) for name in DOCKER_NAMES],
        "hermes": [hermes_unit_sample(unit) for unit in HERMES_UNITS],
        "top": top_processes(),
        "collector": "hermes-ha/sample-host-load",
        "version": 1,
    }


def atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    temporary.chmod(0o640)
    temporary.replace(path)


def roll_samples(samples_dir: Path, keep: int) -> int:
    files = sorted(samples_dir.glob("*.json"), key=lambda p: p.name)
    removed = 0
    excess = len(files) - keep
    for path in files[: max(0, excess)]:
        try:
            path.unlink()
            removed += 1
        except OSError:
            pass
    return removed


def main(argv: list[str] | None = None) -> int:
    # Fail-open: never non-zero for timer health; print errors to stderr only.
    try:
        args = argv if argv is not None else sys.argv[1:]
        state_dir = Path(
            os.environ.get("HERMES_HA_HOST_LOAD_DIR")
            or (args[0] if args else DEFAULT_STATE)
        ).expanduser()
        keep = int(os.environ.get("HERMES_HA_HOST_LOAD_KEEP", KEEP_DEFAULT))
        samples_dir = state_dir / "samples"
        samples_dir.mkdir(parents=True, exist_ok=True)

        sample = collect_sample()
        stamp = utc_stamp()
        atomic_write_json(state_dir / "latest.json", sample)
        atomic_write_json(samples_dir / f"{stamp}.json", sample)
        removed = roll_samples(samples_dir, max(1, keep))
        summary = {
            "ok": True,
            "path": str(state_dir / "latest.json"),
            "sample": str(samples_dir / f"{stamp}.json"),
            "removed": removed,
            "ramUsedBytes": (sample.get("memory") or {}).get("ramUsedBytes"),
            "load1": (sample.get("load") or {}).get("1"),
            "cpuPercent": sample.get("cpuPercent"),
        }
        print(json.dumps(summary, ensure_ascii=False, separators=(",", ":")))
        return 0
    except Exception as exc:  # noqa: BLE001 — fail-open for production timer
        print(
            json.dumps(
                {"ok": False, "error": type(exc).__name__, "message": str(exc)[:200]},
                ensure_ascii=False,
                separators=(",", ":"),
            ),
            file=sys.stderr,
        )
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
