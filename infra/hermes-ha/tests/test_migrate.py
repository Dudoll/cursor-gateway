#!/usr/bin/env python3

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "agent"))

import migrate  # noqa: E402


class MigrateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.home = self.root / "home"
        self.home.mkdir()
        self.config = {
            "node_id": "vps-dmit",
            "peer_id": "vps-band",
            "icloud_root": str(self.root / "icloud"),
            "runtime_dir": str(self.root / "runtime"),
            "hermes_link": str(self.home),
            "shared_dirs": ["cron"],
            "shared_files": ["SOUL.md"],
            "local_trees": ["cache"],
        }

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_only_allowlisted_shared_paths_are_wired(self) -> None:
        shared = self.root / "icloud" / "hermes"
        shared.mkdir(parents=True)
        (shared / "SOUL.md").write_text("shared", encoding="utf-8")
        (self.home / "private").write_text("local", encoding="utf-8")
        migrate.wire_shared_links(self.config, self.home)
        self.assertTrue((self.home / "cron").is_symlink())
        self.assertTrue((self.home / "SOUL.md").is_symlink())
        self.assertFalse((self.home / "private").is_symlink())
        self.assertEqual((self.home / "private").read_text(encoding="utf-8"), "local")

    def test_local_tree_is_moved_outside_icloud_and_linked(self) -> None:
        cache = self.home / "cache"
        cache.mkdir()
        (cache / "item").write_text("data", encoding="utf-8")
        migrate.wire_local_trees(self.config, source_root=self.home)
        local = self.root / "runtime" / "local_trees" / "cache"
        self.assertTrue((self.home / "cache").is_symlink())
        self.assertEqual((self.home / "cache").resolve(), local.resolve())
        self.assertEqual((local / "item").read_text(encoding="utf-8"), "data")
        self.assertNotIn(str(self.root / "icloud"), str(local.resolve()))


if __name__ == "__main__":
    unittest.main()
