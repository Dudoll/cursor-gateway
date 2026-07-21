#!/usr/bin/env python3
"""Regression: cookie-less mode must refresh vnstat and clear stale on SSH success."""

from __future__ import annotations

import datetime as dt
import importlib.util
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parent
COLLECTOR_PATH = ROOT / "collector.py"


def load_collector():
    spec = importlib.util.spec_from_file_location("vps_metrics_collector", COLLECTOR_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class StaleRefreshTests(unittest.TestCase):
    def setUp(self) -> None:
        self.mod = load_collector()
        self.tmp = tempfile.TemporaryDirectory()
        self.state_dir = Path(self.tmp.name)
        self.now = dt.datetime(2026, 7, 20, 5, 10, tzinfo=dt.timezone.utc)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _config(self) -> dict:
        return {
            "cache_max_age_seconds": 86400,
            "dmit": {
                "service_id": "",
                "cookie": "",
                "alias": "DMIT",
                "traffic": {
                    "quota_gb": 1500,
                    "reset_day": 9,
                    "direction": "bi",
                },
            },
            "ssh": {"enabled": True, "host": "vps-dmit", "timeout_seconds": 8},
            "probe": {"host": "vps-dmit", "ports": [22], "timeout_seconds": 1},
        }

    def _host_metrics(self, rx: int, tx: int) -> dict:
        month_start = int(
            dt.datetime(2026, 7, 9, tzinfo=dt.timezone.utc).timestamp()
        )
        return {
            "ok": True,
            "hostname": "DMIT-Qav3lpqMoT",
            "uptime": 1000,
            "load": "0.1 0.2 0.3",
            "os": "Ubuntu",
            "ramTotalBytes": 2 * 1024**3,
            "ramAvailableBytes": 1 * 1024**3,
            "diskTotalBytes": 40 * 1024**3,
            "diskUsedBytes": 20 * 1024**3,
            "networkRxBytes": rx,
            "networkTxBytes": tx,
            "vnstatMonth": {
                "rxBytes": rx,
                "txBytes": tx,
                "monthStartTs": month_start,
                "createdTs": month_start,
            },
        }

    def test_stale_vnstat_cache_is_refreshed_when_ssh_succeeds(self) -> None:
        # Seed the stuck state observed in production: old vnstat cache marked
        # fresh enough that the collector kept reloading it as stale forever.
        old = {
            "provider": "dmit",
            "providerName": "DMIT",
            "source": "bandwagon-collector",
            "telemetryAvailable": True,
            "trafficSource": "vnstat",
            "trafficRemainGB": 1454.0,
            "trafficUsedGB": 46.0,
            "trafficTotalGB": 1500.0,
            "trafficRatio": 46.0 / 1500.0,
            "trafficInGB": 26.0,
            "trafficOutGB": 20.0,
            "stale": False,
            "error": None,
            "fetchedAt": int((self.now - dt.timedelta(hours=13)).timestamp() * 1000),
            "status": "running",
            "providerStatus": "unknown",
            "billingStatus": "",
            "ramAvailable": True,
            "diskAvailable": True,
        }
        self.mod.atomic_write_json(self.state_dir / "provider-cache.json", old, None)

        # Live vnstat shows a small increase since the stuck cache.
        live_rx = int(27.0 * 1024**3)
        live_tx = int(20.5 * 1024**3)
        host = self._host_metrics(live_rx, live_tx)

        with mock.patch.object(
            self.mod,
            "collect_probes",
            return_value={
                "host": "vps-dmit",
                "addresses": ["1.2.3.4"],
                "tcp": {22: {"ok": True, "latencyMs": 12}},
                "http": {"ok": True},
            },
        ), mock.patch.object(self.mod, "collect_host_metrics", return_value=host):
            snap = self.mod.collect(self._config(), self.state_dir, self.now)

        dmit = snap["dmit"]
        self.assertTrue(dmit["telemetryAvailable"])
        self.assertFalse(dmit.get("stale"), "live SSH/vnstat must clear stale")
        self.assertIsNone(dmit.get("error"), "not_configured must not stick after vnstat refresh")
        self.assertEqual(dmit.get("trafficSource"), "vnstat")
        self.assertGreater(dmit["trafficUsedGB"], old["trafficUsedGB"])
        self.assertLess(dmit["trafficRemainGB"], old["trafficRemainGB"])
        self.assertEqual(snap["provider"]["stale"], False)
        self.assertTrue(snap["provider"]["ok"])

        cache = self.mod.read_json(self.state_dir / "provider-cache.json")
        self.assertIsNotNone(cache)
        self.assertFalse(cache.get("stale"))
        self.assertIsNone(cache.get("error"))
        self.assertEqual(cache.get("fetchedAt"), dmit.get("fetchedAt"))
        self.assertAlmostEqual(cache["trafficRemainGB"], dmit["trafficRemainGB"], places=6)

    def test_ssh_failure_keeps_cached_vnstat_as_stale(self) -> None:
        old = {
            "provider": "dmit",
            "providerName": "DMIT",
            "source": "bandwagon-collector",
            "telemetryAvailable": True,
            "trafficSource": "vnstat",
            "trafficRemainGB": 1450.0,
            "trafficUsedGB": 50.0,
            "trafficTotalGB": 1500.0,
            "trafficRatio": 50.0 / 1500.0,
            "stale": False,
            "error": None,
            "fetchedAt": int((self.now - dt.timedelta(minutes=3)).timestamp() * 1000),
            "status": "running",
            "providerStatus": "unknown",
            "billingStatus": "",
            "ramAvailable": True,
            "diskAvailable": True,
        }
        self.mod.atomic_write_json(self.state_dir / "provider-cache.json", old, None)

        with mock.patch.object(self.mod, "collect_probes", return_value={"host": "vps-dmit", "addresses": [], "tcp": {}, "http": {"ok": False}}), \
             mock.patch.object(self.mod, "collect_host_metrics", return_value={"ok": False, "error": "timeout"}):
            snap = self.mod.collect(self._config(), self.state_dir, self.now)

        dmit = snap["dmit"]
        self.assertTrue(dmit["telemetryAvailable"])
        self.assertTrue(dmit.get("stale"))
        self.assertAlmostEqual(dmit["trafficRemainGB"], 1450.0, places=6)

    def test_hermes_hook_expands_configured_home_path(self) -> None:
        config = {
            "hermes_ha": {
                "enabled": True,
                "hook": "~/hermes-ha/hooks/vps-metrics-trigger.sh",
            }
        }
        output = self.state_dir / "snapshot.json"
        with mock.patch.dict(os.environ, {"HOME": str(self.state_dir)}), mock.patch.object(
            self.mod.Path, "is_file", return_value=True
        ), mock.patch.object(self.mod.subprocess, "run") as run:
            self.mod.maybe_run_hermes_ha_hook(config, output, {})
        command = run.call_args.args[0]
        self.assertEqual(
            command[1],
            str(self.state_dir / "hermes-ha" / "hooks" / "vps-metrics-trigger.sh"),
        )


if __name__ == "__main__":
    result = unittest.main(verbosity=2, exit=False)
    sys.exit(0 if result.result.wasSuccessful() else 1)
