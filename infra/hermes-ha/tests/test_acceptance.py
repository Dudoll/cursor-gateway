#!/usr/bin/env python3

from __future__ import annotations

import datetime as dt
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "agent"))

import acceptance  # noqa: E402
import leader  # noqa: E402
import state_checkpoint  # noqa: E402
from common import atomic_write_json  # noqa: E402


class AcceptanceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.home = self.root / "home"
        self.shared = self.root / "icloud" / "hermes"
        self.home.mkdir()
        self.shared.mkdir(parents=True)
        self.config = {
            "node_id": "vps-dmit",
            "peer_id": "vps-band",
            "icloud_root": str(self.root / "icloud"),
            "runtime_dir": str(self.root / "runtime"),
            "hermes_link": str(self.home),
            "shared_dirs": ["cron"],
            "local_trees": [],
            "secrets": [],
            "state_checkpoint": {"chunk_size_bytes": 128},
        }
        (self.shared / "cron").mkdir()
        (self.home / "cron").symlink_to(self.shared / "cron")
        with mock.patch.object(leader.time, "sleep", return_value=None):
            leader.acquire(self.config, mode="PRIMARY", reason="test", force=True)
        source = self.root / "state.db"
        self.content = os.urandom(2048)
        source.write_bytes(self.content)
        state_checkpoint.create_checkpoint(self.config, source)
        local = state_checkpoint.local_state_path(self.config)
        local.parent.mkdir(parents=True)
        local.write_bytes(self.content)
        gateway = self.root / "icloud" / "checkpoints" / "gateway"
        gateway.mkdir(parents=True)
        (gateway / "pg.dump").write_bytes(b"dump")
        atomic_write_json(
            gateway / "manifest.json",
            {
                "created_at": dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ"),
                "file": "pg.dump",
                "size": 4,
            },
        )

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_fixture_layout_and_checkpoints_pass(self) -> None:
        results = [
            *acceptance.verify_layout(self.config),
            *acceptance.verify_state_checkpoint(self.config),
            *acceptance.verify_gateway_checkpoint(self.config),
        ]
        self.assertTrue(all(item["ok"] for item in results), results)

    def test_corrupt_state_fails_acceptance(self) -> None:
        manifest = state_checkpoint.read_json(
            state_checkpoint.checkpoint_root(self.config) / "manifest.json"
        )
        part = state_checkpoint.checkpoint_root(self.config) / manifest["parts"][0]
        part.write_bytes(b"broken")
        results = acceptance.verify_state_checkpoint(self.config)
        self.assertFalse(all(item["ok"] for item in results))


if __name__ == "__main__":
    unittest.main()
