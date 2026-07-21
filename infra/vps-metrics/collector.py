#!/usr/bin/env python3
"""Collect DMIT account telemetry and off-host reachability probes."""

from __future__ import annotations

import argparse
import concurrent.futures
import datetime as dt
import grp
import html
import json
import math
import os
import re
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


DEFAULT_CONFIG = Path("/etc/vps-metrics/config.json")
DEFAULT_STATE_DIR = Path("/var/lib/vps-metrics")
USER_AGENT = "VPSMetricsCollector/1.0"


class CollectorError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def number(value: Any, default: float = 0.0) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return default
    return result if math.isfinite(result) else default


def has_number(obj: dict[str, Any], key: str) -> bool:
    if key not in obj or obj[key] is None or str(obj[key]).strip() == "":
        return False
    try:
        return math.isfinite(float(obj[key]))
    except (TypeError, ValueError):
        return False


def bytes_to_gb(value: Any) -> float:
    return number(value) / 1_073_741_824


def parse_local_date(value: Any) -> dt.datetime | None:
    try:
        parsed = dt.datetime.strptime(str(value or "").strip()[:10], "%Y-%m-%d")
    except ValueError:
        return None
    if parsed.year < 1970 or parsed.year > 2200:
        return None
    return parsed.replace(hour=12, tzinfo=dt.timezone.utc)


def next_monthly_reset(registration_date: Any, now: dt.datetime) -> int:
    registered = parse_local_date(registration_date)
    if not registered:
        return 0

    def build(year: int, month: int, day: int) -> dt.datetime:
        if month == 13:
            year, month = year + 1, 1
        next_year, next_month = (year + 1, 1) if month == 12 else (year, month + 1)
        last_day = (
            dt.datetime(next_year, next_month, 1, tzinfo=dt.timezone.utc)
            - dt.timedelta(days=1)
        ).day
        return dt.datetime(year, month, min(day, last_day), tzinfo=dt.timezone.utc)

    reset = build(now.year, now.month, registered.day)
    if reset <= now:
        reset = build(now.year, now.month + 1, registered.day)
    return int(reset.timestamp())


def normalize_cookie(raw: str) -> str:
    value = raw.strip()
    if value.lower().startswith("cookie:"):
        value = value.split(":", 1)[1].strip()
    value = "; ".join(item.strip() for item in value.splitlines() if item.strip())
    if not value:
        raise CollectorError("not_configured", "DMIT Cookie is not configured")
    first_name = value.split("=", 1)[0].strip().lower() if "=" in value else ""
    known = {"phpsessid", "cf_clearance", "__cf_bm", "whmcslogin_auth_tk"}
    if first_name.startswith("whmcs") or first_name in known:
        return value
    if any("=" in item for item in value.split(";")[1:]):
        return value
    return f"WHMCSlogin_auth_tk={value}"


def dmit_url(service_id: str, page: str, subaction: str) -> str:
    query = urllib.parse.urlencode(
        {
            "action": "productdetails",
            "id": service_id,
            "json": "1",
            "pure": "1",
            "page": page,
            "subaction": subaction,
        }
    )
    return f"https://www.dmit.io/clientarea.php?{query}"


def extract_service_ids(page: str) -> list[str]:
    text = html.unescape(page)
    patterns = (
        r"action=productdetails&id=(\d+)",
        r"\bproducts_id=[\"'](\d+)[\"']",
        r"\bdata-service-id=[\"'](\d+)[\"']",
    )
    values: set[str] = set()
    for pattern in patterns:
        values.update(re.findall(pattern, text, flags=re.IGNORECASE))
    return sorted(values, key=int)


def discover_service_ids(cookie: str, timeout: float = 10) -> list[str]:
    request = urllib.request.Request(
        "https://www.dmit.io/clientarea.php?action=services",
        headers={
            "Cookie": normalize_cookie(cookie),
            "Accept": "text/html",
            "User-Agent": USER_AGENT,
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read(4 * 1024 * 1024)
    except urllib.error.HTTPError as exc:
        code = "auth_expired" if exc.code in (401, 403) else "provider_http_error"
        raise CollectorError(code, f"DMIT services page returned HTTP {exc.code}") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise CollectorError("provider_unreachable", "DMIT services page is unreachable") from exc
    text = raw.decode("utf-8", errors="replace")
    service_ids = extract_service_ids(text)
    lowered = text.lower()
    if not service_ids and ("login" in lowered or "sign in" in lowered):
        raise CollectorError("auth_expired", "DMIT Cookie appears to be expired")
    return service_ids


def fetch_dmit_page(
    service_id: str,
    cookie: str,
    page: str,
    subaction: str,
    timeout: float,
) -> dict[str, Any]:
    request = urllib.request.Request(
        dmit_url(service_id, page, subaction),
        headers={
            "Cookie": normalize_cookie(cookie),
            "Accept": "application/json",
            "User-Agent": USER_AGENT,
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            status = response.status
            raw = response.read(2 * 1024 * 1024)
    except urllib.error.HTTPError as exc:
        code = "auth_expired" if exc.code in (401, 403) else "provider_http_error"
        message = (
            "DMIT authentication was rejected"
            if code == "auth_expired"
            else f"DMIT returned HTTP {exc.code}"
        )
        raise CollectorError(code, message) from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise CollectorError("provider_unreachable", "DMIT clientarea is unreachable") from exc
    if status != 200:
        raise CollectorError("provider_http_error", f"DMIT returned HTTP {status}")
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        text = raw[:4096].decode("utf-8", errors="ignore").lower()
        auth_error = "login" in text or "<!doctype" in text
        raise CollectorError(
            "auth_expired" if auth_error else "invalid_response",
            "DMIT Cookie appears to be expired"
            if auth_error
            else "DMIT returned a non-JSON response",
        ) from exc
    if payload.get("result") != "success" or not payload.get("success"):
        message = str(payload.get("error") or payload.get("message") or "DMIT request failed")
        lowered = message.lower()
        code = "auth_expired" if "login" in lowered or "auth" in lowered else "provider_error"
        raise CollectorError(code, message[:160])
    result = payload["success"]
    if not isinstance(result, dict):
        raise CollectorError("invalid_response", "DMIT response shape is invalid")
    return result


def parse_dmit(
    info: dict[str, Any],
    vm: dict[str, Any] | None,
    alias: str,
    service_id: str,
    now: dt.datetime,
) -> dict[str, Any]:
    vm = vm or {}
    total_gb = number(info.get("bwlimit")) / 1024
    used_gb = number(info.get("bwusage")) / 1024
    remaining_gb = max(total_gb - used_gb, 0)
    traffic_ratio = min(max(used_gb / total_gb, 0), 1) if total_gb > 0 else 0

    ram_available = (
        has_number(vm, "maxmem")
        and number(vm.get("maxmem")) > 0
        and has_number(vm, "mem")
    )
    ram_total_gb = bytes_to_gb(vm.get("maxmem")) if ram_available else 0
    ram_used_gb = bytes_to_gb(vm.get("mem")) if ram_available else 0
    ram_ratio = (
        min(max(ram_used_gb / ram_total_gb, 0), 1)
        if ram_available and ram_total_gb > 0
        else 0
    )

    vm_disk = (
        has_number(vm, "maxdisk")
        and number(vm.get("maxdisk")) > 0
        and has_number(vm, "disk")
    )
    panel_disk = (
        has_number(info, "disklimit")
        and number(info.get("disklimit")) > 0
        and has_number(info, "diskusage")
    )
    disk_available = vm_disk or panel_disk
    disk_total_gb = (
        bytes_to_gb(vm.get("maxdisk"))
        if vm_disk
        else number(info.get("disklimit")) / 1024
        if panel_disk
        else 0
    )
    disk_used_gb = (
        bytes_to_gb(vm.get("disk"))
        if vm_disk
        else number(info.get("diskusage")) / 1024
        if panel_disk
        else 0
    )
    disk_ratio = (
        min(max(disk_used_gb / disk_total_gb, 0), 1)
        if disk_available and disk_total_gb > 0
        else 0
    )
    renewal = parse_local_date(info.get("nextinvoicedate"))
    provider_status = str(vm.get("status") or "unknown")
    return {
        "provider": "dmit",
        "providerName": "DMIT",
        "source": "bandwagon-collector",
        "telemetryAvailable": True,
        "trafficRemainGB": remaining_gb,
        "trafficUsedGB": used_gb,
        "trafficTotalGB": total_gb,
        "trafficRatio": traffic_ratio,
        "trafficInGB": number(info.get("bwusage_in")) / 1024,
        "trafficOutGB": number(info.get("bwusage_out")) / 1024,
        "ramUsedGB": ram_used_gb,
        "ramTotalGB": ram_total_gb,
        "ramRatio": ram_ratio,
        "ramAvailable": ram_available,
        "diskUsedGB": disk_used_gb,
        "diskTotalGB": disk_total_gb,
        "diskRatio": disk_ratio,
        "diskAvailable": disk_available,
        "swapUsedGB": 0,
        "swapTotalGB": 0,
        "swapRatio": 0,
        "swapAvailable": False,
        "status": provider_status,
        "providerStatus": provider_status,
        "billingStatus": str(info.get("status") or ""),
        "throttled": False,
        "load": "",
        "resetTs": next_monthly_reset(info.get("regdate"), now),
        "renewTs": int(renewal.timestamp()) if renewal else 0,
        "uptime": number(vm.get("uptime")),
        "hostname": str(info.get("hostname") or alias or f"DMIT #{service_id}"),
        "location": str(alias or info.get("productname") or info.get("name") or ""),
        "os": str(vm.get("name") or info.get("os") or ""),
        "ip": str(info.get("dedicatedip") or ""),
        "fetchedAt": int(now.timestamp() * 1000),
        "stale": False,
    }


def probe_tcp(host: str, port: int, timeout: float) -> dict[str, Any]:
    started = time.monotonic()
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return {"ok": True, "latencyMs": round((time.monotonic() - started) * 1000)}
    except OSError:
        return {"ok": False, "latencyMs": None}


def probe_http(url: str, timeout: float) -> dict[str, Any]:
    started = time.monotonic()
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            response.read(1024)
            status = response.status
    except urllib.error.HTTPError as exc:
        status = exc.code
    except (urllib.error.URLError, TimeoutError, OSError):
        return {"ok": False, "statusCode": None, "latencyMs": None}
    return {
        "ok": 200 <= status < 400,
        "statusCode": status,
        "latencyMs": round((time.monotonic() - started) * 1000),
    }


def collect_probes(config: dict[str, Any]) -> dict[str, Any]:
    values = config.get("probe") or {}
    host = str(values.get("host") or "vps-dmit")
    url = str(values.get("public_url") or "https://dmit.joelzt.org/")
    ports = [int(port) for port in values.get("ports", [22, 80, 443])]
    timeout = float(values.get("timeout_seconds", 3))
    try:
        addresses = sorted(
            {
                item[4][0]
                for item in socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
            }
        )
    except OSError:
        addresses = []
    result: dict[str, Any] = {"host": host, "addresses": addresses, "tcp": {}}
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(ports) + 1) as pool:
        tcp = {port: pool.submit(probe_tcp, host, port, timeout) for port in ports}
        web = pool.submit(probe_http, url, timeout + 2)
        for port, future in tcp.items():
            result["tcp"][str(port)] = future.result()
        result["https"] = {"url": url, **web.result()}
    return result


REMOTE_HOST_METRICS_SCRIPT = r"""
import json
import os
import shutil
import socket
import subprocess


def primary_interface():
    best = ""
    for name in sorted(os.listdir("/sys/class/net")):
        if name == "lo" or name.startswith(("docker", "veth", "br-", "virbr")):
            continue
        try:
            with open("/sys/class/net/%s/operstate" % name) as handle:
                state = handle.read().strip()
        except OSError:
            state = ""
        if name == "eth0":
            return name
        if not best or state == "up":
            best = name
    return best


def counters(name):
    try:
        rx = int(open("/sys/class/net/%s/statistics/rx_bytes" % name).read())
        tx = int(open("/sys/class/net/%s/statistics/tx_bytes" % name).read())
        return rx, tx
    except (OSError, ValueError):
        return 0, 0


def vnstat_month(name):
    try:
        raw = subprocess.run(
            ["vnstat", "--json", "m", "--iface", name],
            capture_output=True,
            text=True,
            timeout=6,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if raw.returncode != 0 or not raw.stdout:
        return None
    try:
        data = json.loads(raw.stdout)
    except json.JSONDecodeError:
        return None
    for iface in data.get("interfaces", []):
        if iface.get("name") != name:
            continue
        months = (iface.get("traffic") or {}).get("month") or []
        if not months:
            return None
        latest = months[-1]
        rx = int(latest.get("rx") or 0)
        tx = int(latest.get("tx") or 0)
        date = latest.get("date") or {}
        created = (iface.get("created") or {}).get("timestamp")
        return {
            "rxBytes": rx,
            "txBytes": tx,
            "year": int(date.get("year") or 0),
            "month": int(date.get("month") or 0),
            "monthStartTs": int(latest.get("timestamp") or 0),
            "createdTs": int(created or 0),
        }
    return None


mem = {}
with open("/proc/meminfo", encoding="utf-8") as handle:
    for line in handle:
        key, value = line.split(":", 1)
        mem[key] = int(value.strip().split()[0])
mem_total = mem.get("MemTotal", 0) * 1024
mem_available = mem.get("MemAvailable", 0) * 1024
disk = shutil.disk_usage("/")
iface = primary_interface()
rx, tx = counters(iface) if iface else (0, 0)
vnstat = vnstat_month(iface) if iface else None
pretty_name = ""
try:
    with open("/etc/os-release", encoding="utf-8") as handle:
        for line in handle:
            if line.startswith("PRETTY_NAME="):
                pretty_name = line.split("=", 1)[1].strip().strip('"')
                break
except OSError:
    pass
with open("/proc/uptime", encoding="utf-8") as handle:
    uptime = float(handle.read().split()[0])
print(json.dumps({
    "hostname": socket.gethostname(),
    "uptime": uptime,
    "load": " ".join(f"{value:.2f}" for value in os.getloadavg()),
    "os": pretty_name,
    "interface": iface,
    "ramTotalBytes": mem_total,
    "ramAvailableBytes": mem_available,
    "diskTotalBytes": disk.total,
    "diskUsedBytes": disk.used,
    "networkRxBytes": rx,
    "networkTxBytes": tx,
    "vnstatMonth": vnstat,
}, separators=(",", ":")))
"""


def collect_host_metrics(config: dict[str, Any]) -> dict[str, Any]:
    values = config.get("ssh") or {}
    if values.get("enabled", True) is False:
        return {"ok": False, "error": "disabled"}
    host = str(values.get("host") or "vps-dmit")
    timeout = float(values.get("timeout_seconds", 8))
    command = [
        "ssh",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        f"ConnectTimeout={max(1, int(timeout))}",
        host,
        "python3 -",
    ]
    try:
        result = subprocess.run(
            command,
            input=REMOTE_HOST_METRICS_SCRIPT,
            text=True,
            capture_output=True,
            timeout=timeout + 5,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return {"ok": False, "error": "ssh_unreachable"}
    if result.returncode != 0:
        return {"ok": False, "error": "ssh_failed"}
    try:
        metrics = json.loads(result.stdout)
    except json.JSONDecodeError:
        return {"ok": False, "error": "invalid_ssh_response"}
    if not isinstance(metrics, dict):
        return {"ok": False, "error": "invalid_ssh_response"}
    return {"ok": True, **metrics}


def next_reset_from_day(reset_day: int, now: dt.datetime) -> int:
    reset_day = max(1, min(31, int(reset_day)))

    def build(year: int, month: int) -> dt.datetime:
        if month > 12:
            year, month = year + 1, 1
        last = (
            dt.datetime(
                year + (month == 12),
                1 if month == 12 else month + 1,
                1,
                tzinfo=dt.timezone.utc,
            )
            - dt.timedelta(days=1)
        ).day
        return dt.datetime(year, month, min(reset_day, last), tzinfo=dt.timezone.utc)

    reset = build(now.year, now.month)
    if reset <= now:
        reset = build(now.year, now.month + 1)
    return int(reset.timestamp())


def traffic_from_vnstat(
    host_metrics: dict[str, Any],
    traffic_config: dict[str, Any],
    now: dt.datetime,
) -> dict[str, Any] | None:
    month = host_metrics.get("vnstatMonth")
    if not isinstance(month, dict):
        return None
    quota_gb = number(traffic_config.get("quota_gb"))
    if quota_gb <= 0:
        return None
    direction = str(traffic_config.get("direction") or "bi").lower()
    reset_day = int(traffic_config.get("reset_day") or 1)
    rx_gb = number(month.get("rxBytes")) / 1_073_741_824
    tx_gb = number(month.get("txBytes")) / 1_073_741_824
    used_gb = tx_gb if direction == "out" else rx_gb + tx_gb
    remaining_gb = max(quota_gb - used_gb, 0)
    ratio = min(max(used_gb / quota_gb, 0), 1) if quota_gb > 0 else 0
    # vnstat 从安装时开始计数，若其账单月起点晚于本应重置的时间，
    # 说明当前周期尚未完整覆盖，用量会偏低，需要标记为"统计中"。
    month_start = number(month.get("monthStartTs"))
    created = number(month.get("createdTs"))
    partial = created > 0 and month_start > 0 and created > month_start + 60
    return {
        "trafficTotalGB": quota_gb,
        "trafficUsedGB": used_gb,
        "trafficRemainGB": remaining_gb,
        "trafficRatio": ratio,
        "trafficInGB": rx_gb,
        "trafficOutGB": tx_gb,
        "trafficSource": "vnstat",
        "trafficDirection": direction,
        "trafficPartial": partial,
        "resetTs": next_reset_from_day(reset_day, now),
    }


def probes_online(probes: dict[str, Any]) -> bool:
    return bool(
        probes.get("https", {}).get("ok")
        or any(item.get("ok") for item in probes.get("tcp", {}).values())
    )


def normalize_status(provider_status: str, probes: dict[str, Any]) -> str:
    status = provider_status.strip().lower().replace("_", " ").replace("-", " ")
    negatives = (
        "not running",
        "inactive",
        "offline",
        "stopped",
        "stopping",
        "suspended",
        "disabled",
        "down",
    )
    if status.startswith(negatives):
        return status
    if status in {"running", "active", "online", "started", "up"}:
        return "running"
    return "running" if probes_online(probes) else "offline"


def read_json(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def atomic_write_json(path: Path, value: dict[str, Any], group: str | None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, separators=(",", ":"))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o640)
        if group:
            os.chown(temporary, -1, grp.getgrnam(group).gr_gid)
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def collect(config: dict[str, Any], state_dir: Path, now: dt.datetime) -> dict[str, Any]:
    probes = collect_probes(config)
    host_metrics = collect_host_metrics(config)
    dmit_config = config.get("dmit") or {}
    service_id = str(dmit_config.get("service_id") or "").strip()
    cookie = str(dmit_config.get("cookie") or "").strip()
    alias = str(dmit_config.get("alias") or "").strip()
    timeout = float(dmit_config.get("timeout_seconds", 10))
    max_age = int(config.get("cache_max_age_seconds", 86400))
    cache_path = state_dir / "provider-cache.json"
    provider_error: dict[str, str] | None = None

    try:
        if not service_id or not cookie:
            raise CollectorError("not_configured", "DMIT credentials are not configured")
        standard = fetch_dmit_page(service_id, cookie, "standard", "whmcsdetail", timeout)
        vm = None
        try:
            vm = fetch_dmit_page(service_id, cookie, "home", "detailsVM", timeout)
        except CollectorError as exc:
            provider_error = {"code": exc.code, "message": str(exc)}
        dmit = parse_dmit(standard, vm, alias, service_id, now)
        atomic_write_json(cache_path, dmit, None)
    except CollectorError as exc:
        provider_error = {"code": exc.code, "message": str(exc)}
        cached = read_json(cache_path)
        age = (
            now.timestamp() - number(cached.get("fetchedAt")) / 1000
            if cached
            else math.inf
        )
        if cached and 0 <= age <= max_age:
            dmit = cached
            dmit["stale"] = True
            dmit["error"] = str(exc)
        else:
            dmit = {
                "provider": "dmit",
                "providerName": "DMIT",
                "source": "bandwagon-collector",
                "telemetryAvailable": False,
                "status": "unknown",
                "providerStatus": "unknown",
                "billingStatus": "",
                "trafficRemainGB": 0,
                "trafficUsedGB": 0,
                "trafficTotalGB": 0,
                "trafficRatio": 0,
                "ramAvailable": False,
                "diskAvailable": False,
                "stale": False,
                "error": str(exc),
                "fetchedAt": 0,
            }

    provider_status = str(dmit.get("providerStatus") or dmit.get("status") or "unknown")
    if host_metrics.get("ok"):
        ram_total = number(host_metrics.get("ramTotalBytes"))
        ram_available = number(host_metrics.get("ramAvailableBytes"))
        disk_total = number(host_metrics.get("diskTotalBytes"))
        disk_used = number(host_metrics.get("diskUsedBytes"))
        dmit.update(
            {
                "status": "running",
                "healthOnly": not bool(dmit.get("telemetryAvailable")),
                "hostname": str(host_metrics.get("hostname") or dmit.get("hostname") or ""),
                "uptime": number(host_metrics.get("uptime")),
                "load": str(host_metrics.get("load") or ""),
                "os": str(host_metrics.get("os") or dmit.get("os") or ""),
                "ramTotalGB": bytes_to_gb(ram_total),
                "ramUsedGB": bytes_to_gb(max(ram_total - ram_available, 0)),
                "ramRatio": min(max((ram_total - ram_available) / ram_total, 0), 1)
                if ram_total > 0
                else 0,
                "ramAvailable": ram_total > 0,
                "diskTotalGB": bytes_to_gb(disk_total),
                "diskUsedGB": bytes_to_gb(disk_used),
                "diskRatio": min(max(disk_used / disk_total, 0), 1)
                if disk_total > 0
                else 0,
                "diskAvailable": disk_total > 0,
                "networkRxGB": bytes_to_gb(host_metrics.get("networkRxBytes")),
                "networkTxGB": bytes_to_gb(host_metrics.get("networkTxBytes")),
                "networkWindow": "since_boot",
                # 主机指标是本轮实时采集，刷新时间戳，避免下游按 fetchedAt=0
                # 误判缓存过期而丢弃整块 DMIT 数据。
                "fetchedAt": int(now.timestamp() * 1000),
            }
        )
    else:
        dmit["status"] = normalize_status(provider_status, probes)

    # Cookie-less / vnstat mode: whenever SSH succeeded, ALWAYS recompute traffic
    # from live vnstat and clear stale. Reloading a prior vnstat cache must not
    # skip this step — otherwise stale=true + telemetryAvailable=true loops
    # forever and provider-cache.json never advances.
    traffic_config = dmit_config.get("traffic") or {}
    use_vnstat = bool(host_metrics.get("ok")) and (
        not service_id
        or not cookie
        or dmit.get("trafficSource") == "vnstat"
        or not dmit.get("telemetryAvailable")
    )
    if use_vnstat:
        vnstat_traffic = traffic_from_vnstat(host_metrics, traffic_config, now)
        if vnstat_traffic:
            dmit.update(vnstat_traffic)
            dmit["telemetryAvailable"] = True
            dmit["healthOnly"] = False
            dmit["stale"] = False
            dmit.pop("error", None)
            if provider_error and provider_error.get("code") == "not_configured":
                provider_error = None

    # Live host metrics without a stale flag: drop placeholder cookie errors.
    if host_metrics.get("ok") and not dmit.get("stale"):
        dmit.pop("error", None)

    if dmit.get("telemetryAvailable") and not dmit.get("stale"):
        # Cache the final enriched payload too. In cookie-less mode, telemetry is
        # produced only after SSH/vnstat enrichment; caching solely after the
        # panel request leaves no fallback for a transient SSH timeout.
        atomic_write_json(cache_path, dmit, None)

    if not dmit.get("ip") and probes.get("addresses"):
        dmit["ip"] = probes["addresses"][0]
    dmit["probeOnline"] = probes_online(probes) or bool(host_metrics.get("ok"))
    dmit["collectorError"] = provider_error
    telemetry_available = bool(dmit.get("telemetryAvailable"))
    provider_state = {
        "ok": telemetry_available and not bool(dmit.get("stale")),
        "stale": bool(dmit.get("stale")),
        "errorCode": provider_error.get("code") if provider_error else None,
        "errorMessage": provider_error.get("message") if provider_error else None,
        "fetchedAt": dmit.get("fetchedAt", 0),
    }
    status_state = {
        "state": dmit["status"],
        "reachable": dmit["probeOnline"],
        "providerStatus": provider_status,
    }
    return {
        "schemaVersion": 1,
        "generatedAt": now.isoformat(),
        "generatedAtMs": int(now.timestamp() * 1000),
        "collector": "vps-band",
        "dmit": dmit,
        "provider": provider_state,
        "status": status_state,
        "hostMetrics": host_metrics,
        "probes": probes,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--state-dir", type=Path, default=DEFAULT_STATE_DIR)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--stdout", action="store_true")
    args = parser.parse_args()
    os.umask(0o027)
    config = read_json(args.config) or {}
    snapshot = collect(config, args.state_dir, dt.datetime.now(dt.timezone.utc))
    output = args.output or args.state_dir / "snapshot.json"
    if args.stdout:
        print(json.dumps(snapshot, ensure_ascii=False, indent=2))
    atomic_write_json(output, snapshot, str(config.get("output_group") or "") or None)
    maybe_run_hermes_ha_hook(config, output, snapshot)
    return 0


def maybe_run_hermes_ha_hook(
    config: dict[str, Any], output: Path, snapshot: dict[str, Any]
) -> None:
    """Invoke hermes-ha metrics hook when configured (band takeover path)."""
    ha = config.get("hermes_ha") or {}
    if ha.get("enabled") is False:
        return
    hook = str(
        ha.get("hook")
        or os.path.expanduser("~/hermes-ha/hooks/vps-metrics-trigger.sh")
    )
    hook_path = Path(os.path.expanduser(hook))
    if not hook_path.is_file():
        return
    try:
        subprocess.run(
            ["bash", str(hook_path), str(output)],
            check=False,
            timeout=float(ha.get("timeout_seconds") or 120),
            env={**os.environ, "VPS_METRICS_STATE_DIR": str(output.parent)},
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        print(f"hermes-ha hook skipped: {exc}", flush=True)


if __name__ == "__main__":
    raise SystemExit(main())
