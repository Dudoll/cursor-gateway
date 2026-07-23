#!/usr/bin/env python3

from __future__ import annotations

import contextlib
import io
import json
import sys
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "agent"))

import gateway_version_sync  # noqa: E402
import leader  # noqa: E402


TARGET = "a" * 40
OLD = "b" * 40
TARGET_IMAGE = "sha256:" + "c" * 64
OLD_IMAGE = "sha256:" + "d" * 64


class FakeSync(gateway_version_sync.GatewayVersionSync):
    def __init__(self, config):
        super().__init__(config, sleep=lambda _seconds: None)
        self.calls: list[str] = []
        self.notifications: list[tuple[str, str]] = []
        self.current = {
            "exists": True,
            "revision": OLD,
            "image_id": OLD_IMAGE,
            "health": "healthy",
            "status": "running",
        }
        self.active_reason: str | None = None
        self.runs = 0
        self.fail_health = False

    def stable_primary(self):
        self.calls.append("primary")
        return TARGET, {"revision": TARGET, "image_id": TARGET_IMAGE}

    def verify_github_revision(self, revision):
        self.calls.append("github")
        self.assert_revision(revision)

    @staticmethod
    def assert_revision(revision):
        if revision != TARGET:
            raise AssertionError(revision)

    def current_app(self):
        self.calls.append("current")
        return dict(self.current)

    def standby_active_reason(self):
        self.calls.append("role")
        return self.active_reason

    def active_runs(self):
        self.calls.append("runs")
        return self.runs

    def validate_environment(self):
        self.calls.append("environment")
        return "e" * 64

    def stage_release(self, revision):
        self.calls.append("stage")
        release = self.state_root / "release"
        release.mkdir(parents=True, exist_ok=True)
        return release, "f" * 64

    def build_candidate(self, release, revision):
        self.calls.append("build")
        return f"infra-app:candidate-{revision}"

    def preflight_candidate(self, release, candidate):
        self.calls.append("preflight")

    def backup_current(self, current, env_sha):
        self.calls.append("backup")
        rollback = self.state_root / "rollbacks" / "test"
        rollback.mkdir(parents=True, exist_ok=True)
        checkpoint = rollback / "checkpoint.dump"
        checkpoint.write_bytes(b"checkpoint")
        context = {
            "path": str(rollback),
            "current": current,
            "local_dump": str(checkpoint),
            "upstream_dump": None,
            "compose_existed": True,
            "postgres_was_running": True,
            "redis_was_running": True,
        }
        return context

    def install_compose(self, release):
        self.calls.append("compose")

    def ensure_support_services(self):
        self.calls.append("support")

    def migration_preflight(self, candidate, checkpoint):
        self.calls.append("migration")

    def activate_candidate(self, candidate, revision):
        self.calls.append("activate")
        if self.fail_health:
            raise gateway_version_sync.SyncError("candidate_health_failed")
        self.current = {
            "exists": True,
            "revision": revision,
            "image_id": TARGET_IMAGE,
            "health": "healthy",
            "status": "running",
        }
        return TARGET_IMAGE

    def rollback(self, context):
        self.calls.append("rollback")

    def cleanup_releases(self, active):
        self.calls.append("cleanup")

    def file_sha256(self, path):
        if path == self.env_file:
            return "e" * 64
        return super().file_sha256(path)

    def notify_once(self, key, message):
        self.notifications.append((key, message))


class GatewayVersionSyncTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.config = {
            "node_id": "vps-band",
            "peer_id": "vps-dmit",
            "icloud_root": str(self.root / "icloud"),
            "runtime_dir": str(self.root / "runtime"),
            "alert": {"command": ""},
            "gateway_version_sync": {
                "state_dir": str(self.root / "state"),
                "deploy_root": str(self.root / "deploy"),
                "env_file": str(self.root / "deploy/.env"),
                "compose_file": str(self.root / "deploy/infra/docker-compose.yml"),
                "releases_dir": str(self.root / "releases"),
                "cache_repo": str(self.root / "cache.git"),
                "primary_stability_seconds": 0,
            },
        }
        dmit = {**self.config, "node_id": "vps-dmit", "peer_id": "vps-band"}
        with mock.patch.object(leader.time, "sleep", return_value=None):
            leader.acquire(dmit, mode="PRIMARY", reason="test", force=True)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_same_revision_is_no_op(self) -> None:
        sync = FakeSync(self.config)
        sync.current["revision"] = TARGET
        self.assertEqual(sync.execute(), 0)
        state = sync.load_state()
        self.assertEqual(state["result"], "no_op")
        self.assertEqual(state["applied"], TARGET)
        self.assertNotIn("build", sync.calls)
        self.assertNotIn("backup", sync.calls)

    def test_primary_unreachable_fails_closed(self) -> None:
        sync = FakeSync(self.config)
        sync.stable_primary = mock.Mock(
            side_effect=gateway_version_sync.SyncError("primary_probe_unavailable")
        )
        self.assertEqual(sync.execute(), 2)
        state = sync.load_state()
        self.assertEqual(state["result"], "failed")
        self.assertEqual(state["last_error"], "primary_probe_unavailable")
        self.assertNotIn("build", sync.calls)
        self.assertTrue(
            any(key.startswith("failure:primary_probe_unavailable") for key, _ in sync.notifications)
        )

    def test_dirty_primary_source_is_rejected(self) -> None:
        sync = gateway_version_sync.GatewayVersionSync(self.config)
        payload = {
            "revision": TARGET,
            "source": "https://github.com/Dudoll/cursor-gateway",
            "status": "running",
            "health": "healthy",
            "repo_is_git": True,
            "repo_head": TARGET,
            "repo_dirty": True,
            "image_id": TARGET_IMAGE,
        }
        with self.assertRaisesRegex(
            gateway_version_sync.SyncError, "primary_source_dirty"
        ):
            sync.validate_primary(payload)

    def test_unmerged_or_unsigned_github_commit_is_rejected(self) -> None:
        sync = gateway_version_sync.GatewayVersionSync(self.config)
        sync.ensure_git_revision = mock.Mock(return_value=False)
        sync.github_get = mock.Mock(
            side_effect=[
                {
                    "sha": TARGET,
                    "commit": {
                        "verification": {"verified": True, "reason": "valid"}
                    },
                },
                [
                    {
                        "merged_at": None,
                        "merge_commit_sha": TARGET,
                        "base": {"ref": "main"},
                    }
                ],
            ]
        )
        with self.assertRaisesRegex(
            gateway_version_sync.SyncError, "github_revision_unmerged"
        ):
            sync.verify_github_revision(TARGET)

        sync.github_get = mock.Mock(
            return_value={
                "sha": TARGET,
                "commit": {
                    "verification": {"verified": False, "reason": "unsigned"}
                },
            }
        )
        with self.assertRaisesRegex(
            gateway_version_sync.SyncError, "github_signature_unverified"
        ):
            sync.verify_github_revision(TARGET)

    def test_active_failover_defers_without_build(self) -> None:
        sync = FakeSync(self.config)
        sync.active_reason = "standby_is_role_holder"
        self.assertEqual(sync.execute(), 0)
        self.assertEqual(sync.load_state()["result"], "standby_is_role_holder")
        self.assertNotIn("environment", sync.calls)
        self.assertNotIn("build", sync.calls)

    def test_active_runs_defer_without_interrupting(self) -> None:
        sync = FakeSync(self.config)
        sync.runs = 2
        self.assertEqual(sync.execute(), 0)
        self.assertEqual(sync.load_state()["result"], "standby_active_runs")
        self.assertNotIn("build", sync.calls)

    def test_successful_upgrade_orders_preflight_before_activation(self) -> None:
        sync = FakeSync(self.config)
        self.assertEqual(sync.execute(), 0)
        state = sync.load_state()
        self.assertEqual(state["result"], "applied")
        self.assertEqual(state["target"], TARGET)
        self.assertEqual(state["applied"], TARGET)
        self.assertEqual(state["image_id"], TARGET_IMAGE)
        self.assertLess(sync.calls.index("build"), sync.calls.index("backup"))
        self.assertLess(sync.calls.index("preflight"), sync.calls.index("backup"))
        self.assertLess(sync.calls.index("migration"), sync.calls.index("activate"))
        self.assertNotIn("rollback", sync.calls)
        self.assertEqual(leader.read_leader(self.config)["role_holder"], "vps-dmit")
        self.assertTrue(any(key.startswith("drift:") for key, _ in sync.notifications))
        self.assertTrue(any(key.startswith("applied:") for key, _ in sync.notifications))

    def test_health_failure_triggers_automatic_rollback(self) -> None:
        sync = FakeSync(self.config)
        sync.fail_health = True
        self.assertEqual(sync.execute(), 2)
        self.assertIn("rollback", sync.calls)
        state = sync.load_state()
        self.assertEqual(state["result"], "failed")
        self.assertEqual(state["last_error"], "candidate_health_failed")
        self.assertIsNone(state.get("applied"))

    def test_checksum_failure_never_activates(self) -> None:
        sync = FakeSync(self.config)
        sync.stage_release = mock.Mock(
            side_effect=gateway_version_sync.SyncError(
                "artifact_commit_checksum_mismatch"
            )
        )
        self.assertEqual(sync.execute(), 2)
        self.assertNotIn("activate", sync.calls)
        self.assertNotIn("rollback", sync.calls)
        self.assertEqual(
            sync.load_state()["last_error"], "artifact_commit_checksum_mismatch"
        )

    def test_nonblocking_flock_prevents_concurrent_sync(self) -> None:
        first = gateway_version_sync.GatewayVersionSync(self.config)
        second = gateway_version_sync.GatewayVersionSync(self.config)
        with first.lock() as acquired:
            self.assertTrue(acquired)
            with second.lock() as second_acquired:
                self.assertFalse(second_acquired)

    def test_timer_is_persistent_and_twelve_hourly(self) -> None:
        timer = (
            ROOT / "systemd/hermes-ha-gateway-version-sync.timer"
        ).read_text(encoding="utf-8")
        self.assertIn("Persistent=true", timer)
        self.assertIn("OnCalendar=*-*-* 00,12:00:00", timer)
        self.assertIn("RandomizedDelaySec=45min", timer)
        service = (
            ROOT / "systemd/hermes-ha-gateway-version-sync.service"
        ).read_text(encoding="utf-8")
        self.assertIn("Restart=on-failure", service)
        self.assertIn("RestartSec=30min", service)
        self.assertIn("StartLimitBurst=3", service)

    def test_protected_route_accepts_configured_access_denial(self) -> None:
        config = {
            **self.config,
            "gateway_version_sync": {
                **self.config["gateway_version_sync"],
                "route_health_url": "https://standby.example/healthz",
                "route_expected_statuses": [200, 401, 403],
            },
        }
        error = urllib.error.HTTPError(
            "https://standby.example/healthz",
            403,
            "Forbidden",
            {},
            None,
        )
        sync = gateway_version_sync.GatewayVersionSync(
            config, urlopen=mock.Mock(side_effect=error)
        )
        sync.route_check()

    def test_structured_logs_redact_sensitive_values(self) -> None:
        sync = gateway_version_sync.GatewayVersionSync(self.config)
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            sync.log(
                "test",
                token="literal-token-value",
                detail=(
                    "Authorization: Bearer bearer-value "
                    "password=plain-password "
                    "https://user:private-value@example.invalid"
                ),
            )
        rendered = output.getvalue()
        self.assertNotIn("literal-token-value", rendered)
        self.assertNotIn("bearer-value", rendered)
        self.assertNotIn("plain-password", rendered)
        self.assertNotIn("private-value", rendered)
        self.assertIn("[REDACTED]", rendered)
        json.loads(rendered)


if __name__ == "__main__":
    unittest.main()
