#!/usr/bin/env python3

from __future__ import annotations

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
import orchestrator  # noqa: E402
import state_checkpoint  # noqa: E402


class OrchestratorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.config = {
            "node_id": "vps-band",
            "peer_id": "vps-dmit",
            "icloud_root": str(self.root / "icloud"),
            "runtime_dir": str(self.root / "runtime"),
            "hermes_link": str(self.root / "hermes"),
            "hosts": {"vps-dmit": {"ssh": "dmit-alias"}},
            "stack_units": {"user": ["writer.service"]},
            "probe": {
                "unreachable_streak_required": 3,
                "cooldown_seconds": 60,
                "failback_healthy_streak_required": 2,
            },
            "gateway_checkpoint": {"enabled": True},
            "state_checkpoint": {"enabled": True},
        }
        (self.root / "hermes").mkdir()

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def set_leader(self, node: str, mode: str, *, ready: bool = False) -> None:
        config = dict(self.config)
        config["node_id"] = node
        with mock.patch.object(leader.time, "sleep", return_value=None):
            leader.acquire(config, mode=mode, reason="test", force=True)
        if ready:
            leader.set_failback_ready(config, True)

    def test_non_leader_cannot_start_stack(self) -> None:
        self.set_leader("vps-dmit", "PRIMARY")
        with mock.patch.object(orchestrator, "apply_runtime") as apply, mock.patch.object(
            orchestrator, "run"
        ) as run:
            with self.assertRaisesRegex(RuntimeError, "non-leader"):
                orchestrator.start_stack(self.config)
        apply.assert_not_called()
        run.assert_not_called()

    def test_evaluate_requires_threshold_and_reprobes_takeover(self) -> None:
        self.set_leader("vps-dmit", "PRIMARY")
        unreachable = {"reachable": False}
        with mock.patch.object(orchestrator, "peer_reachable", return_value=unreachable), mock.patch.object(
            orchestrator, "takeover", return_value=0
        ) as takeover:
            orchestrator.evaluate_auto(self.config)
            orchestrator.evaluate_auto(self.config)
            takeover.assert_not_called()
            orchestrator.evaluate_auto(self.config)
        takeover.assert_called_once_with(self.config, force=False)

    def test_failback_checkpoints_before_release_and_uses_ssh_alias(self) -> None:
        self.set_leader("vps-band", "ACTIVE_STANDBY", ready=True)
        events: list[str] = []
        real_release = orchestrator.release_to

        def release(*args, **kwargs):
            events.append("release")
            return real_release(*args, **kwargs)

        def remote(cmd, **kwargs):
            events.append("ssh")
            self.assertIn("dmit-alias", cmd)
            return subprocess.CompletedProcess(cmd, 0, stdout="ok", stderr="")

        with mock.patch.object(orchestrator, "peer_reachable", return_value={"reachable": True}), mock.patch.object(
            orchestrator, "stop_stack"
        ), mock.patch.object(orchestrator, "wait_sync", return_value=0), mock.patch.object(
            state_checkpoint, "create_checkpoint", side_effect=lambda config: events.append("state")
        ), mock.patch.object(
            gateway_checkpoint, "create_checkpoint", side_effect=lambda config: events.append("gateway")
        ), mock.patch.object(
            orchestrator, "release_to", side_effect=release
        ), mock.patch.object(
            orchestrator.subprocess, "run", side_effect=remote
        ), mock.patch.object(
            orchestrator, "alert"
        ):
            orchestrator.failback(self.config, confirm=True, skip_dns=True)
        self.assertEqual(events, ["state", "gateway", "release", "ssh"])

    def test_failback_requires_ready_state_before_probe(self) -> None:
        self.set_leader("vps-band", "ACTIVE_STANDBY", ready=False)
        with mock.patch.object(orchestrator, "peer_reachable") as probe:
            with self.assertRaisesRegex(RuntimeError, "not ready"):
                orchestrator.failback(self.config, confirm=True, skip_dns=True)
        probe.assert_not_called()

    def test_takeover_restore_failure_never_starts_writer(self) -> None:
        self.set_leader("vps-dmit", "PRIMARY")
        with mock.patch.object(orchestrator, "peer_reachable", return_value={"reachable": False}), mock.patch.object(
            orchestrator, "stop_stack"
        ), mock.patch.object(
            gateway_checkpoint, "restore_checkpoint", side_effect=RuntimeError("restore failed")
        ), mock.patch.object(
            orchestrator, "start_stack"
        ) as start, mock.patch.object(
            leader.time, "sleep", return_value=None
        ):
            with self.assertRaisesRegex(RuntimeError, "restore failed"):
                orchestrator.takeover(self.config, skip_dns=True)
        start.assert_not_called()

    def test_peer_restore_failure_never_starts_stack(self) -> None:
        self.set_leader("vps-dmit", "PRIMARY")
        dmit = dict(self.config)
        dmit["node_id"] = "vps-dmit"
        dmit["peer_id"] = "vps-band"
        with mock.patch.object(orchestrator, "stop_stack"), mock.patch.object(
            gateway_checkpoint, "restore_checkpoint", side_effect=RuntimeError("broken")
        ), mock.patch.object(orchestrator, "start_stack") as start:
            with self.assertRaisesRegex(RuntimeError, "broken"):
                orchestrator.peer_accept_failback(dmit)
        start.assert_not_called()


if __name__ == "__main__":
    unittest.main()
