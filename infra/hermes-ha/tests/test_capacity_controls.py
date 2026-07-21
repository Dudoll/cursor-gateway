#!/usr/bin/env python3

from __future__ import annotations

import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class CapacityControlTests(unittest.TestCase):
    def test_six_slots_are_owned_by_the_local_shared_runner(self) -> None:
        config = json.loads((ROOT / "config.example.json").read_text(encoding="utf-8"))
        units = (config.get("stack_units") or {}).get("user") or []
        capacity = config["execution_capacity"]
        self.assertEqual(capacity["total_slots"], 6)
        self.assertEqual(capacity["runner_id"], "wsl-e2ee")
        self.assertEqual(capacity["managed_on"], "local-wsl")
        self.assertNotIn("hermes-cursor-runner.service", units)
        self.assertNotIn("hermes-cursor-runner-release.service", units)
        self.assertFalse(
            any(unit.startswith("hermes-cursor-worker@") for unit in units)
        )
        smoke = (
            ROOT / "scripts" / "csapi-capacity-smoke.py"
        ).read_text(encoding="utf-8")
        self.assertIn("request_count = args.slots + 1", smoke)
        self.assertIn("queued_while_full", smoke)
        self.assertIn("peak != args.slots", smoke)

    def test_checkpoint_timer_repeats_after_failures(self) -> None:
        timer = (
            ROOT / "systemd" / "hermes-ha-gateway-checkpoint.timer"
        ).read_text(encoding="utf-8")
        self.assertIn("OnCalendar=*:0/5", timer)
        self.assertNotIn("OnUnitActiveSec", timer)
        service = (
            ROOT / "systemd" / "hermes-ha-gateway-checkpoint.service"
        ).read_text(encoding="utf-8")
        self.assertIn("MemoryMax=256M", service)
        self.assertIn("TimeoutStartSec=4min", service)

    def test_installer_requires_versioned_reproducible_source(self) -> None:
        installer = (
            ROOT / "scripts" / "install-local.sh"
        ).read_text(encoding="utf-8")
        self.assertIn("status --porcelain=v1", installer)
        self.assertIn("HERMES_HA_SOURCE_COMMIT", installer)
        self.assertIn("HERMES_HA_SOURCE_SHA256", installer)
        self.assertIn(".install-source.json", installer)


if __name__ == "__main__":
    unittest.main()
