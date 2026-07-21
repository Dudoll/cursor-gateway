#!/usr/bin/env python3

from __future__ import annotations

import datetime as dt
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "agent"))

import checkpoint_watchdog  # noqa: E402
import leader  # noqa: E402


class CheckpointWatchdogTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.config = {
            "node_id": "vps-dmit",
            "peer_id": "vps-band",
            "icloud_root": str(self.root / "icloud"),
            "runtime_dir": str(self.root / "runtime"),
            "gateway_checkpoint": {"max_age_seconds": 600},
            "alert": {"command": ""},
        }
        with mock.patch.object(leader.time, "sleep", return_value=None):
            leader.acquire(self.config, mode="PRIMARY", reason="test", force=True)
        self.checkpoint = self.root / "icloud" / "checkpoints" / "gateway"
        self.checkpoint.mkdir(parents=True)
        (self.checkpoint / "pg.dump").write_bytes(b"dump")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def write_manifest(self, created_at: float) -> None:
        stamp = dt.datetime.fromtimestamp(created_at, dt.timezone.utc).strftime(
            "%Y%m%dT%H%M%SZ"
        )
        (self.checkpoint / "manifest.json").write_text(
            json.dumps({"created_at": stamp, "file": "pg.dump", "size": 4}),
            encoding="utf-8",
        )

    def test_stale_alert_is_deduplicated_and_recovery_alerts(self) -> None:
        now = 1_700_000_000
        self.write_manifest(now - 601)
        with mock.patch.object(checkpoint_watchdog, "alert") as send:
            self.assertEqual(
                checkpoint_watchdog.run_watchdog(self.config, now=now), 2
            )
            self.assertEqual(
                checkpoint_watchdog.run_watchdog(self.config, now=now + 30), 2
            )
            self.assertEqual(send.call_count, 1)

            self.write_manifest(now + 31)
            self.assertEqual(
                checkpoint_watchdog.run_watchdog(self.config, now=now + 32), 0
            )
            self.assertEqual(send.call_count, 2)
            self.assertIn("recovered", send.call_args.args[1])

    def test_incomplete_dump_fails_even_when_timestamp_is_fresh(self) -> None:
        now = 1_700_000_000
        self.write_manifest(now)
        (self.checkpoint / "pg.dump").write_bytes(b"partial")
        status = checkpoint_watchdog.checkpoint_status(self.config, now=now)
        self.assertFalse(status["ok"])
        self.assertEqual(status["reason"], "dump_missing_or_incomplete")

    def test_non_leader_skips_without_alert(self) -> None:
        standby = {**self.config, "node_id": "vps-band", "peer_id": "vps-dmit"}
        with mock.patch.object(checkpoint_watchdog, "alert") as send:
            self.assertEqual(
                checkpoint_watchdog.run_watchdog(standby, now=1_700_000_000), 0
            )
        send.assert_not_called()


if __name__ == "__main__":
    unittest.main()
