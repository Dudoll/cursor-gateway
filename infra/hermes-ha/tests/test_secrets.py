#!/usr/bin/env python3

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "agent"))

import secrets as ha_secrets  # noqa: E402


class SecretsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.home = self.root / "hermes"
        self.home.mkdir()
        self.config = {
            "node_id": "vps-band",
            "peer_id": "vps-dmit",
            "icloud_root": str(self.root / "icloud"),
            "runtime_dir": str(self.root / "runtime"),
            "hermes_link": str(self.home),
            "age_identity": str(self.root / "age.key"),
            "age_recipients_file": str(self.root / "recipients"),
            "secrets": [
                {"name": "env", "source": ".env", "encrypted": "secrets/env.age"},
                {"name": "auth", "source": "auth.json", "encrypted": "secrets/auth.age"},
            ],
        }

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_recipient_args_deduplicates_shared_and_local(self) -> None:
        shared = self.root / "icloud" / "secrets" / "age.recipients"
        shared.parent.mkdir(parents=True)
        shared.write_text("# peer\nage1peer\n", encoding="utf-8")
        local = self.root / "recipients"
        local.write_text("age1peer\nage1local\n", encoding="utf-8")
        self.assertEqual(
            ha_secrets.recipient_args(self.config),
            ["-r", "age1peer", "-r", "age1local"],
        )

    def test_apply_runtime_creates_private_files_and_local_links(self) -> None:
        def fake_decrypt(config, ciphertext, plaintext):
            plaintext.parent.mkdir(parents=True, exist_ok=True)
            plaintext.write_text(ciphertext.name, encoding="utf-8")
            plaintext.chmod(0o600)

        with mock.patch.object(ha_secrets, "ensure_identity"), mock.patch.object(
            ha_secrets, "decrypt_file", side_effect=fake_decrypt
        ):
            ha_secrets.apply_runtime(self.config)
        runtime = self.root / "runtime" / "runtime"
        self.assertEqual(runtime.stat().st_mode & 0o777, 0o700)
        for name in (".env", "auth.json"):
            self.assertTrue((self.home / name).is_symlink())
            self.assertEqual((self.home / name).resolve().parent, runtime)
            self.assertEqual((self.home / name).resolve().stat().st_mode & 0o777, 0o600)

    def test_apply_refuses_directory_secret_target(self) -> None:
        (self.home / ".env").mkdir()

        def fake_decrypt(config, ciphertext, plaintext):
            plaintext.parent.mkdir(parents=True, exist_ok=True)
            plaintext.write_text("secret", encoding="utf-8")

        with mock.patch.object(ha_secrets, "ensure_identity"), mock.patch.object(
            ha_secrets, "decrypt_file", side_effect=fake_decrypt
        ), self.assertRaisesRegex(ha_secrets.SecretsError, "non-file"):
            ha_secrets.apply_runtime(self.config)


if __name__ == "__main__":
    unittest.main()
