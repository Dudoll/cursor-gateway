#!/usr/bin/env python3

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "agent"))

import gateway_checkpoint  # noqa: E402
import leader  # noqa: E402


class GatewayCheckpointTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.config = {
            "node_id": "vps-dmit",
            "peer_id": "vps-band",
            "icloud_root": str(self.root / "icloud"),
            "runtime_dir": str(self.root / "runtime"),
            "gateway_checkpoint": {
                "enabled": True,
                "retain": 2,
                "compose_file": str(self.root / "missing-compose.yml"),
                "pg_user": "test_user",
                "pg_database": "test_db",
            },
        }
        with mock.patch.object(leader.time, "sleep", return_value=None):
            leader.acquire(self.config, mode="PRIMARY", reason="test", force=True)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    @staticmethod
    def successful_dump(cmd, **kwargs):
        kwargs["stdout"].write(b"PGDUMP")
        return subprocess.CompletedProcess(cmd, 0, stderr=b"")

    def test_create_uses_config_and_retains_limit(self) -> None:
        out = gateway_checkpoint.checkpoint_dir(self.config)
        out.mkdir(parents=True)
        for index in range(3):
            (out / f"pg-2000010{index}T000000Z.dump").write_bytes(b"old")
        with mock.patch.object(gateway_checkpoint.shutil, "which", return_value="/usr/bin/pg_dump"), mock.patch.object(
            gateway_checkpoint.subprocess, "run", side_effect=self.successful_dump
        ) as run:
            created = gateway_checkpoint.create_checkpoint(self.config)
        command = run.call_args.args[0]
        self.assertIn("test_user", command)
        self.assertIn("test_db", command)
        self.assertEqual(created.read_bytes(), b"PGDUMP")
        self.assertLessEqual(len(list(out.glob("pg-*.dump"))), 2)

    def test_non_leader_does_not_execute_dump(self) -> None:
        config = dict(self.config)
        config["node_id"] = "vps-band"
        config["peer_id"] = "vps-dmit"
        with mock.patch.object(gateway_checkpoint.subprocess, "run") as run:
            with self.assertRaisesRegex(RuntimeError, "non-leader"):
                gateway_checkpoint.create_checkpoint(config)
        run.assert_not_called()

    def test_scheduled_non_leader_is_clean_noop(self) -> None:
        config = dict(self.config)
        config["node_id"] = "vps-band"
        config["peer_id"] = "vps-dmit"
        config_path = self.root / "band-config.json"
        config_path.write_text(json.dumps(config), encoding="utf-8")
        with mock.patch.object(gateway_checkpoint, "create_checkpoint") as create:
            code = gateway_checkpoint.main(
                ["--config", str(config_path), "create", "--if-leader"]
            )
        self.assertEqual(code, 0)
        create.assert_not_called()

    def test_empty_dump_is_not_published(self) -> None:
        def empty_dump(cmd, **kwargs):
            return subprocess.CompletedProcess(cmd, 0, stderr=b"")

        with mock.patch.object(gateway_checkpoint.shutil, "which", return_value="/usr/bin/pg_dump"), mock.patch.object(
            gateway_checkpoint.subprocess, "run", side_effect=empty_dump
        ):
            with self.assertRaisesRegex(RuntimeError, "empty"):
                gateway_checkpoint.create_checkpoint(self.config)
        self.assertFalse((gateway_checkpoint.checkpoint_dir(self.config) / "manifest.json").exists())

    def test_rclone_publishes_dump_before_manifest(self) -> None:
        config = dict(self.config)
        config["gateway_checkpoint"] = {
            **self.config["gateway_checkpoint"],
            "transport": "rclone",
            "remote": "remote:gateway",
        }
        commands: list[list[str]] = []

        def run(cmd, **kwargs):
            commands.append(cmd)
            if Path(cmd[0]).name == "pg_dump":
                kwargs["stdout"].write(b"PGDUMP")
                return subprocess.CompletedProcess(cmd, 0, stderr=b"")
            if cmd[1] == "lsf":
                return subprocess.CompletedProcess(
                    cmd, 0, stdout="manifest.json\npg-current.dump\n", stderr=""
                )
            return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

        with mock.patch.object(
            gateway_checkpoint.shutil,
            "which",
            side_effect=lambda name: f"/usr/bin/{name}",
        ), mock.patch.object(gateway_checkpoint.subprocess, "run", side_effect=run):
            gateway_checkpoint.create_checkpoint(config)
        copies = [cmd for cmd in commands if len(cmd) > 1 and cmd[1] == "copyto"]
        self.assertEqual(len(copies), 2)
        self.assertTrue(copies[0][-1].endswith(".dump"))
        self.assertTrue(copies[1][-1].endswith("/manifest.json"))


if __name__ == "__main__":
    unittest.main()
