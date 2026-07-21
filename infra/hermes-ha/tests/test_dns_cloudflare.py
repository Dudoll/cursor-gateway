#!/usr/bin/env python3

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "agent"))

import dns_cloudflare  # noqa: E402


class DnsTests(unittest.TestCase):
    def base_config(self) -> dict:
        return {
            "hosts": {"vps-band": {"public_ip": "192.0.2.20"}},
            "dns": {
                "records": [
                    {"zone": "example.com", "name": "same", "type": "A", "proxied": True},
                    {"zone": "example.com", "name": "change", "type": "A", "proxied": True},
                    {"zone": "example.com", "name": "new", "type": "A", "proxied": False},
                ]
            },
        }

    def test_token_reads_secure_env_file_without_sourcing_shell(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "cloudflare.env"
            path.write_text(
                "UNRELATED=$(touch should-not-run)\nCLOUDFLARE_API_TOKEN=test-token\n",
                encoding="utf-8",
            )
            path.chmod(0o600)
            config = {"dns": {"cloudflare_env_file": str(path), "cloudflare_token_file": str(Path(tmp) / "none")}}
            with mock.patch.dict(os.environ, {}, clear=True):
                self.assertEqual(dns_cloudflare.token(config), "test-token")
            self.assertFalse((Path.cwd() / "should-not-run").exists())

    def test_insecure_token_file_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "token"
            path.write_text("secret", encoding="utf-8")
            path.chmod(0o644)
            config = {"dns": {"cloudflare_token_file": str(path), "cloudflare_env_file": str(Path(tmp) / "none")}}
            with mock.patch.dict(os.environ, {}, clear=True), self.assertRaisesRegex(
                dns_cloudflare.DnsError, "chmod 600"
            ):
                dns_cloudflare.token(config)

    def test_point_to_classifies_noop_update_and_create(self) -> None:
        config = self.base_config()
        lookups = iter(
            [
                {"success": True, "result": [{"id": "zone"}]},
                {"success": True, "result": [{"id": "same", "content": "192.0.2.20", "proxied": True}]},
                {"success": True, "result": [{"id": "zone"}]},
                {"success": True, "result": [{"id": "change", "content": "192.0.2.10", "proxied": True}]},
                {"success": True, "result": [{"id": "zone"}]},
                {"success": True, "result": []},
            ]
        )

        def fake_api(config, method, path, payload=None):
            if method in {"PUT", "POST"}:
                return {"success": True, "result": {}}
            return next(lookups)

        with mock.patch.object(dns_cloudflare, "api", side_effect=fake_api) as api:
            changes = dns_cloudflare.point_to(config, "vps-band")
        self.assertEqual([item["action"] for item in changes], ["noop", "update", "create"])
        self.assertEqual([call.args[1] for call in api.call_args_list].count("PUT"), 1)
        self.assertEqual([call.args[1] for call in api.call_args_list].count("POST"), 1)


if __name__ == "__main__":
    unittest.main()
