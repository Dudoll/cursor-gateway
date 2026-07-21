#!/usr/bin/env python3
"""Unit tests for hermes-ha leader lock (tmp filesystem)."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "agent"))

import common  # noqa: E402
import leader  # noqa: E402


class LeaderTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "hermes-ha").mkdir()
        self.config = {
            "node_id": "vps-band",
            "peer_id": "vps-dmit",
            "icloud_root": str(self.root / "hermes-ha"),
            "runtime_dir": str(self.root / "runtime"),
        }
        self.sleep = mock.patch.object(leader.time, "sleep", return_value=None)
        self.sleep.start()

    def tearDown(self) -> None:
        self.sleep.stop()
        self.tmp.cleanup()

    def test_acquire_increments_epoch(self) -> None:
        first = leader.acquire(self.config, mode="TAKEOVER", reason="test", force=True)
        self.assertEqual(first["role_holder"], "vps-band")
        self.assertEqual(first["epoch"], 1)
        second = leader.acquire(self.config, mode="ACTIVE_STANDBY", reason="again", force=True)
        self.assertEqual(second["epoch"], 2)

    def test_is_leader(self) -> None:
        leader.acquire(self.config, mode="PRIMARY", reason="init", force=True)
        self.assertTrue(leader.is_leader(self.config))
        other = dict(self.config)
        other["node_id"] = "vps-dmit"
        self.assertFalse(leader.is_leader(other))

    def test_takeover_cannot_steal_without_force(self) -> None:
        other = dict(self.config)
        other["node_id"] = "vps-dmit"
        leader.acquire(other, mode="PRIMARY", reason="init", force=True)
        with self.assertRaisesRegex(RuntimeError, "leadership held"):
            leader.acquire(self.config, mode="TAKEOVER", reason="unsafe", force=False)

    def test_only_leader_can_set_failback_ready(self) -> None:
        other = dict(self.config)
        other["node_id"] = "vps-dmit"
        leader.acquire(other, mode="PRIMARY", reason="init", force=True)
        with self.assertRaisesRegex(RuntimeError, "only leader"):
            leader.set_failback_ready(self.config)


if __name__ == "__main__":
    unittest.main()
