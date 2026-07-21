#!/usr/bin/env python3
"""Cloudflare DNS A-record switcher for Hermes HA."""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

from common import load_config, node_id


API = "https://api.cloudflare.com/client/v4"


class DnsError(RuntimeError):
    pass


def _secure_file(path: Path) -> None:
    if path.stat().st_mode & 0o077:
        raise DnsError(f"Cloudflare token file must be chmod 600: {path}")


def token(config: dict[str, Any]) -> str:
    dns = config.get("dns") or {}
    env_name = str(dns.get("cloudflare_token_env") or "CF_DNS_API_TOKEN")
    value = os.environ.get(env_name, "").strip()
    if not value:
        value = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
    if not value:
        value = os.environ.get("CF_API_TOKEN", "").strip()
    if not value:
        path = Path(
            os.path.expanduser(
                str(dns.get("cloudflare_token_file") or "~/.config/hermes-ha/cf_dns_token")
            )
        )
        if path.is_file():
            _secure_file(path)
            value = path.read_text(encoding="utf-8").strip()
    if not value:
        env_file = Path(
            os.path.expanduser(
                str(
                    dns.get("cloudflare_env_file")
                    or "~/.config/cloudflare/cloudflare.env"
                )
            )
        )
        if env_file.is_file():
            _secure_file(env_file)
            values: dict[str, str] = {}
            for line in env_file.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, item = line.split("=", 1)
                values[key.strip()] = item.strip().strip("\"'")
            value = (
                values.get(env_name)
                or values.get("CLOUDFLARE_API_TOKEN")
                or values.get("CF_API_TOKEN")
                or ""
            ).strip()
    if not value:
        raise DnsError(
            f"Cloudflare DNS token missing (${env_name}, configured token file, or env file)"
        )
    return value


def api(
    config: dict[str, Any],
    method: str,
    path: str,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{API}{path}",
        data=body,
        method=method,
        headers={
            "Authorization": f"Bearer {token(config)}",
            "Content-Type": "application/json",
            "User-Agent": "hermes-ha-dns/1.0",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise DnsError(f"Cloudflare HTTP {exc.code}: {detail}") from exc
    if not data.get("success"):
        raise DnsError(f"Cloudflare API error: {data.get('errors')}")
    return data


def zone_id(config: dict[str, Any], zone_name: str) -> str:
    query = urllib.parse.urlencode({"name": zone_name})
    data = api(config, "GET", f"/zones?{query}")
    results = data.get("result") or []
    if not results:
        raise DnsError(f"zone not found: {zone_name}")
    return str(results[0]["id"])


def host_ip(config: dict[str, Any], target: str) -> str:
    hosts = config.get("hosts") or {}
    entry = hosts.get(target) or {}
    ip = str(entry.get("public_ip") or "").strip()
    if not ip:
        raise DnsError(f"no public_ip for host {target}")
    return ip


def list_records(config: dict[str, Any]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for rec in (config.get("dns") or {}).get("records") or []:
        zone = str(rec["zone"])
        name = str(rec["name"])
        fqdn = f"{name}.{zone}" if name != "@" else zone
        zid = zone_id(config, zone)
        query = urllib.parse.urlencode({"type": rec.get("type") or "A", "name": fqdn})
        data = api(config, "GET", f"/zones/{zid}/dns_records?{query}")
        results = data.get("result") or []
        out.append(
            {
                "zone": zone,
                "name": name,
                "fqdn": fqdn,
                "configured_proxied": bool(rec.get("proxied", True)),
                "records": [
                    {
                        "id": item.get("id"),
                        "type": item.get("type"),
                        "content": item.get("content"),
                        "proxied": item.get("proxied"),
                        "ttl": item.get("ttl"),
                    }
                    for item in results
                ],
            }
        )
    return out


def point_to(config: dict[str, Any], target: str, *, dry_run: bool = False) -> list[dict[str, Any]]:
    ip = host_ip(config, target)
    changes: list[dict[str, Any]] = []
    for rec in (config.get("dns") or {}).get("records") or []:
        zone = str(rec["zone"])
        name = str(rec["name"])
        rtype = str(rec.get("type") or "A")
        proxied = bool(rec.get("proxied", True))
        fqdn = f"{name}.{zone}" if name != "@" else zone
        zid = zone_id(config, zone)
        query = urllib.parse.urlencode({"type": rtype, "name": fqdn})
        data = api(config, "GET", f"/zones/{zid}/dns_records?{query}")
        results = data.get("result") or []
        payload = {"type": rtype, "name": fqdn, "content": ip, "ttl": 1, "proxied": proxied}
        if not results:
            change = {"fqdn": fqdn, "action": "create", "content": ip, "dry_run": dry_run}
            if not dry_run:
                api(config, "POST", f"/zones/{zid}/dns_records", payload)
            changes.append(change)
            continue
        existing = results[0]
        if str(existing.get("content")) == ip and bool(existing.get("proxied")) == proxied:
            changes.append({"fqdn": fqdn, "action": "noop", "content": ip})
            continue
        change = {
            "fqdn": fqdn,
            "action": "update",
            "from": existing.get("content"),
            "to": ip,
            "dry_run": dry_run,
        }
        if not dry_run:
            api(config, "PUT", f"/zones/{zid}/dns_records/{existing['id']}", payload)
        changes.append(change)
    return changes


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Hermes HA Cloudflare DNS")
    parser.add_argument("--config", type=Path)
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("show")
    p_to = sub.add_parser("to")
    p_to.add_argument("target", choices=["vps-dmit", "vps-band"])
    p_to.add_argument("--dry-run", action="store_true")
    p_band = sub.add_parser("to-band")
    p_band.add_argument("--dry-run", action="store_true")
    p_dmit = sub.add_parser("to-dmit")
    p_dmit.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    config = load_config(args.config)

    if args.cmd == "show":
        print(json.dumps({"node": node_id(config), "records": list_records(config)}, indent=2))
        return 0
    target = {
        "to": getattr(args, "target", None),
        "to-band": "vps-band",
        "to-dmit": "vps-dmit",
    }[args.cmd]
    if target is None:
        parser.error("target is required")
    dry = bool(getattr(args, "dry_run", False))
    changes = point_to(config, target, dry_run=dry)
    print(json.dumps({"target": target, "changes": changes}, indent=2))
    return 0


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    raise SystemExit(main())
