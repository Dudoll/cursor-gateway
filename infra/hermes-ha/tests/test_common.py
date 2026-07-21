#!/usr/bin/env python3

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "agent"))

import common  # noqa: E402


class ConfigTests(unittest.TestCase):
    def test_explicit_valid_config_loads(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "config.json"
            path.write_text(
                json.dumps(
                    {
                        "node_id": "vps-band",
                        "peer_id": "vps-dmit",
                        "icloud_root": f"{tmp}/icloud",
                        "runtime_dir": f"{tmp}/runtime",
                    }
                ),
                encoding="utf-8",
            )
            loaded = common.load_config(path)
            self.assertEqual(loaded["node_id"], "vps-band")
            self.assertEqual(loaded["_config_path"], str(path))

    def test_invalid_config_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "config.json"
            path.write_text('{"node_id":"same","peer_id":"same"}', encoding="utf-8")
            with self.assertRaises(common.ConfigError):
                common.load_config(path)

    def test_example_is_not_implicit_production_fallback(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(
            os.environ,
            {"HOME": tmp},
            clear=True,
        ):
            with self.assertRaises(FileNotFoundError):
                common.load_config()


if __name__ == "__main__":
    unittest.main()
