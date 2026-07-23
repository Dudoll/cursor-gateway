#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "sample-host-load.py"


def load_module():
    spec = importlib.util.spec_from_file_location("sample_host_load", SCRIPT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class SampleHostLoadTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.mod = load_module()

    def test_redact_masks_secrets_and_tokens(self) -> None:
        raw = (
            "python worker --api-key=sk-abc123456789 --token=deadbeef "
            "Authorization: Bearer supersecret TELEGRAM 1234567890:AAHxxxxxxxxxxxxxxxxxxxx"
        )
        cleaned = self.mod.redact(raw)
        self.assertNotIn("sk-abc123456789", cleaned)
        self.assertNotIn("supersecret", cleaned)
        self.assertNotIn("AAHxxxxxxxxxxxxxxxxxxxx", cleaned)
        self.assertNotIn("deadbeef", cleaned)
        self.assertIn("***", cleaned)

    def test_roll_samples_keeps_newest(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            samples = Path(tmp)
            for idx in range(1, 6):
                (samples / f"2026010{idx}T000000Z.json").write_text("{}\n", encoding="utf-8")
            removed = self.mod.roll_samples(samples, keep=3)
            remaining = sorted(p.name for p in samples.glob("*.json"))
            self.assertEqual(removed, 2)
            self.assertEqual(
                remaining,
                [
                    "20260103T000000Z.json",
                    "20260104T000000Z.json",
                    "20260105T000000Z.json",
                ],
            )

    def test_main_writes_latest_and_exits_zero(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp) / "host-load"
            code = self.mod.main([str(state)])
            self.assertEqual(code, 0)
            latest = state / "latest.json"
            self.assertTrue(latest.is_file())
            payload = json.loads(latest.read_text(encoding="utf-8"))
            self.assertEqual(payload.get("collector"), "hermes-ha/sample-host-load")
            self.assertIn("memory", payload)
            self.assertIn("load", payload)
            self.assertIn("docker", payload)
            self.assertIn("hermes", payload)
            self.assertIn("top", payload)
            samples = list((state / "samples").glob("*.json"))
            self.assertEqual(len(samples), 1)


if __name__ == "__main__":
    unittest.main()
