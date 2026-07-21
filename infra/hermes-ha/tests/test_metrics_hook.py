#!/usr/bin/env python3

from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HOOK = ROOT / "hooks" / "vps-metrics-trigger.sh"


class MetricsHookTests(unittest.TestCase):
    def run_hook(self, state: Path, reachable: bool) -> subprocess.CompletedProcess[str]:
        snapshot = state / "snapshot.json"
        snapshot.write_text(
            json.dumps({"status": {"reachable": reachable, "state": "online" if reachable else "offline"}}),
            encoding="utf-8",
        )
        return subprocess.run(
            ["bash", str(HOOK), str(snapshot)],
            env={"VPS_METRICS_STATE_DIR": str(state), "PATH": "/usr/bin:/bin"},
            text=True,
            capture_output=True,
            check=False,
        )

    def test_unreachable_creates_request_without_duplicate_streak(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp)
            result = self.run_hook(state, False)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue((state / "hermes-ha-evaluate.requested").is_file())
            self.assertFalse((state / "hermes-ha-unreachable-streak").exists())

    def test_reachable_clears_request(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp)
            self.run_hook(state, False)
            result = self.run_hook(state, True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse((state / "hermes-ha-evaluate.requested").exists())


if __name__ == "__main__":
    unittest.main()
