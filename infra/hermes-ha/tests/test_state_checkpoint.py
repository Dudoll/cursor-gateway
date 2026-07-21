#!/usr/bin/env python3

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "agent"))

import leader  # noqa: E402
import state_checkpoint  # noqa: E402


class StateCheckpointTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.config = {
            "node_id": "vps-dmit",
            "peer_id": "vps-band",
            "icloud_root": str(self.root / "icloud"),
            "runtime_dir": str(self.root / "runtime"),
            "hermes_link": str(self.root / "home"),
            "state_checkpoint": {"enabled": True, "chunk_size_bytes": 256},
        }
        (self.root / "home").mkdir()
        with mock.patch.object(leader.time, "sleep", return_value=None):
            leader.acquire(self.config, mode="PRIMARY", reason="test", force=True)
        self.source = self.root / "source.db"
        self.content = os.urandom(8192)
        self.source.write_bytes(self.content)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_round_trip_is_byte_exact_and_chunked(self) -> None:
        manifest_path = state_checkpoint.create_checkpoint(self.config, self.source)
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        self.assertGreater(len(manifest["parts"]), 1)
        self.assertEqual(manifest["raw_size"], len(self.content))
        restored = self.root / "restored.db"
        state_checkpoint.restore_checkpoint(self.config, restored)
        self.assertEqual(restored.read_bytes(), self.content)
        self.assertEqual(restored.stat().st_mode & 0o777, 0o600)

    def test_non_leader_cannot_publish(self) -> None:
        non_leader = dict(self.config)
        non_leader["node_id"] = "vps-band"
        with self.assertRaisesRegex(RuntimeError, "non-leader"):
            state_checkpoint.create_checkpoint(non_leader, self.source)

    def test_scheduled_non_leader_is_clean_noop(self) -> None:
        config = dict(self.config)
        config["node_id"] = "vps-band"
        config["peer_id"] = "vps-dmit"
        config_path = self.root / "band-config.json"
        config_path.write_text(json.dumps(config), encoding="utf-8")
        with mock.patch.object(state_checkpoint, "create_checkpoint") as create:
            code = state_checkpoint.main(
                ["--config", str(config_path), "create", "--if-leader"]
            )
        self.assertEqual(code, 0)
        create.assert_not_called()

    def test_corrupt_part_is_rejected(self) -> None:
        manifest_path = state_checkpoint.create_checkpoint(self.config, self.source)
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        part = manifest_path.parent / manifest["parts"][0]
        part.write_bytes(b"corrupt")
        with self.assertRaises((RuntimeError, OSError, EOFError)):
            state_checkpoint.restore_checkpoint(self.config, self.root / "bad.db")
        self.assertFalse((self.root / "bad.db").exists())

    def test_failed_generation_preserves_previous_manifest(self) -> None:
        manifest_path = state_checkpoint.create_checkpoint(self.config, self.source)
        previous = manifest_path.read_bytes()
        with mock.patch.object(state_checkpoint.gzip, "open", side_effect=RuntimeError("boom")):
            with self.assertRaisesRegex(RuntimeError, "boom"):
                state_checkpoint.create_checkpoint(self.config, self.source)
        self.assertEqual(manifest_path.read_bytes(), previous)

    def test_rclone_publishes_manifest_after_all_parts(self) -> None:
        config = dict(self.config)
        config["state_checkpoint"] = {
            "chunk_size_bytes": 256,
            "transport": "rclone",
            "remote": "remote:checkpoint",
        }
        commands: list[list[str]] = []

        def run(cmd, **kwargs):
            commands.append(cmd)
            if cmd[1] == "cat":
                return subprocess.CompletedProcess(cmd, 1, stdout="", stderr="missing")
            if cmd[1] == "lsf":
                return subprocess.CompletedProcess(cmd, 0, stdout="manifest.json\n", stderr="")
            return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

        with mock.patch.object(state_checkpoint.shutil, "which", return_value="/usr/bin/rclone"), mock.patch.object(
            state_checkpoint.subprocess, "run", side_effect=run
        ):
            state_checkpoint.create_checkpoint(config, self.source)
        copies = [cmd for cmd in commands if cmd[1] == "copyto"]
        self.assertGreater(len(copies), 1)
        self.assertTrue(copies[-1][-1].endswith("/manifest.json"))
        self.assertTrue(all(".gz.part" in cmd[-1] for cmd in copies[:-1]))


if __name__ == "__main__":
    unittest.main()
