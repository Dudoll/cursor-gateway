import builtins
import contextlib
import importlib.util
import io
import json
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


def load_guard():
    module_name = "hermes_strict_route_guard_test"
    existing = sys.modules.get(module_name)
    if existing is not None:
        return existing
    source = Path(__file__).with_name("strict_route_guard.py")
    spec = importlib.util.spec_from_file_location(module_name, source)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


guard = load_guard()


class StrictRouteGuardTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)
        self.main_home = self.root / ".hermes"
        self.telegram_home = self.main_home / "profiles" / "telegram2"
        self.isolated_home = self.root / "isolated-test"
        self.profile_homes = {
            "main": self.main_home,
            "telegram2": self.telegram_home,
        }
        self.profile_services = {
            "main": "hermes-gateway.service",
            "telegram2": "hermes-gateway-telegram2.service",
        }
        self.profile_keys = {
            "main": "main-test-key-never-log",
            "telegram2": "telegram2-test-key-never-log",
        }
        for profile, home in self.profile_homes.items():
            (home / "sessions").mkdir(parents=True)
            (home / ".env").write_text(
                f"{guard.DEFAULT_API_KEY_ENV}={self.profile_keys[profile]}\n",
                encoding="utf-8",
            )
            self.write_config(profile)

        self.profiles_file = self.root / "strict-route-profiles.json"
        self.write_profiles()
        self.runners_online = 1
        self.health_models = [guard.DEFAULT_MODEL]
        self.catalog_models = [guard.DEFAULT_MODEL]
        self.accepted_keys = set(self.profile_keys.values())

    def tearDown(self):
        self.tempdir.cleanup()

    def profile_entry(self, profile):
        return {
            "protected": True,
            "hermes_home": str(self.profile_homes[profile]),
            "config": "config.yaml",
            "state_db": "state.db",
            "sessions": "sessions/sessions.json",
            "service": self.profile_services[profile],
            "provider": guard.DEFAULT_PROVIDER,
            "model": guard.DEFAULT_MODEL,
            "base_url": guard.DEFAULT_BASE_URL,
            "api_key_env": guard.DEFAULT_API_KEY_ENV,
            "health_timeout_seconds": 1,
        }

    def write_profiles(self, *, mutate=None):
        document = {
            "schema_version": 1,
            "profiles": {
                "main": self.profile_entry("main"),
                "telegram2": self.profile_entry("telegram2"),
                "isolated-test": {"protected": False},
            },
        }
        if mutate is not None:
            mutate(document)
        self.profiles_file.write_text(json.dumps(document), encoding="utf-8")

    def write_config(
        self,
        profile,
        *,
        provider=guard.DEFAULT_PROVIDER,
        model=guard.DEFAULT_MODEL,
        base_url=guard.DEFAULT_BASE_URL,
        fallback_config=None,
        extra=None,
    ):
        config = {
            "model": {
                "provider": provider,
                "default": model,
                "base_url": base_url,
                "api_mode": "chat_completions",
            },
            "fallback_providers": [],
        }
        if fallback_config is not None:
            config.pop("fallback_providers")
            config.update(fallback_config)
        if extra:
            config.update(extra)
        (self.profile_homes[profile] / "config.yaml").write_text(
            json.dumps(config), encoding="utf-8"
        )

    def fake_request(self, url, *, timeout, api_key=None):
        self.assertGreater(timeout, 0)
        if url.endswith("/health"):
            return {
                "ok": True,
                "runnersOnline": self.runners_online,
                "models": ["auto", *self.health_models],
                "capacity": {
                    "maxConcurrencyPerKey": 6,
                    "runnerIdentities": self.runners_online,
                    "totalRunnerSlots": self.runners_online * 6,
                    "effectiveTotal": min(6, self.runners_online * 6),
                },
            }
        if url.endswith("/v1/models"):
            if api_key not in self.accepted_keys:
                raise guard.GuardFailure(
                    exit_code=guard.EXIT_HEALTH,
                    code="HSG_HEALTH_AUTH_FAILED",
                    check="health",
                    message="authenticated model probe failed",
                )
            return {
                "data": [{"id": model} for model in self.catalog_models],
            }
        self.fail(f"unexpected probe URL: {url}")

    def run_guard(
        self,
        profile,
        *,
        command="preflight",
        expected_service=None,
        expected_home=None,
        ambient_home=None,
        require_protected=None,
        check_environment_home=False,
    ):
        argv = [
            command,
            "--profile",
            profile,
            "--profiles-file",
            str(self.profiles_file),
        ]
        if expected_service is not None:
            argv.extend(["--expected-service", expected_service])
        if expected_home is None and profile in self.profile_homes:
            expected_home = self.profile_homes[profile]
        if expected_home is not None:
            argv.extend(["--expected-home", str(expected_home)])
        if require_protected is None:
            require_protected = profile in {"main", "telegram2"}
        if require_protected:
            argv.append("--require-protected")
        if check_environment_home:
            argv.append("--check-environment-home")
        stdout = io.StringIO()
        stderr = io.StringIO()
        ambient_secret = "ambient-key-must-never-be-used-or-logged"
        with mock.patch.dict(
            os.environ,
            {
                guard.DEFAULT_API_KEY_ENV: ambient_secret,
                "HOME": str(self.root),
                "HERMES_HOME": str(ambient_home or self.main_home),
            },
            clear=False,
        ):
            with mock.patch.object(
                guard, "_request_json", side_effect=self.fake_request
            ):
                with contextlib.redirect_stdout(
                    stdout
                ), contextlib.redirect_stderr(stderr):
                    exit_code = guard.main(argv)
        rendered = stdout.getvalue() + stderr.getvalue()
        self.assertNotIn(ambient_secret, rendered)
        return exit_code, stdout.getvalue(), stderr.getvalue()

    def assert_event(self, rendered, expected_code):
        events = [json.loads(line) for line in rendered.splitlines() if line]
        self.assertTrue(events)
        event = events[-1]
        self.assertEqual(event["code"], expected_code)
        self.assertIsInstance(event["exit_code"], int)
        return event

    def create_state_db(self, profile):
        state_db = self.profile_homes[profile] / "state.db"
        connection = sqlite3.connect(state_db)
        connection.executescript(
            """
            CREATE TABLE gateway_routing (
                scope TEXT NOT NULL DEFAULT '',
                session_key TEXT NOT NULL,
                entry_json TEXT NOT NULL,
                updated_at REAL NOT NULL,
                PRIMARY KEY (scope, session_key)
            );
            CREATE TABLE sessions (
                id TEXT,
                ended_at REAL,
                model TEXT,
                model_config TEXT,
                billing_provider TEXT,
                billing_base_url TEXT,
                api_call_count INTEGER
            );
            CREATE TABLE session_model_usage (
                session_id TEXT,
                model TEXT,
                billing_provider TEXT,
                billing_base_url TEXT,
                api_call_count INTEGER,
                task TEXT
            );
            """
        )
        return connection

    def add_routing_entry(
        self,
        connection,
        profile,
        *,
        session_id,
        provider=guard.DEFAULT_PROVIDER,
        model=guard.DEFAULT_MODEL,
        base_url=guard.DEFAULT_BASE_URL,
        scope=None,
        entry_json=None,
    ):
        if entry_json is None:
            entry_json = json.dumps(
                {
                    "session_id": session_id,
                    "model_override": {
                        "provider": provider,
                        "model": model,
                        "base_url": base_url,
                    },
                }
            )
        routing_scope = (
            str((self.profile_homes[profile] / "sessions").resolve())
            if scope is None
            else scope
        )
        connection.execute(
            "INSERT INTO gateway_routing VALUES (?, ?, ?, ?)",
            (routing_scope, f"{profile}:private", entry_json, 1.0),
        )

    def test_main_and_telegram2_both_pass_with_independent_scope(self):
        for profile in ("main", "telegram2"):
            with self.subTest(profile=profile):
                exit_code, stdout, stderr = self.run_guard(
                    profile,
                    expected_service=self.profile_services[profile],
                    ambient_home=self.main_home,
                )
                self.assertEqual(exit_code, guard.EXIT_OK)
                self.assertEqual(stderr, "")
                event = self.assert_event(stdout, "HSG_OK")
                self.assertEqual(event["profile"], profile)
                self.assertEqual(event["service"], self.profile_services[profile])
                self.assertEqual(
                    event["details"]["provider"], guard.DEFAULT_PROVIDER
                )
                self.assertEqual(event["details"]["model"], guard.DEFAULT_MODEL)
                self.assertEqual(event["details"]["runners_online"], 1)

    def test_telegram2_provider_and_model_drift_are_rejected_and_redacted(self):
        cases = (
            ({"provider": "telegram-provider-secret"}, "telegram-provider-secret"),
            ({"model": "openai-codex/gpt-5.5-secret"}, "gpt-5.5-secret"),
        )
        for overrides, sensitive in cases:
            with self.subTest(overrides=overrides):
                self.write_config("telegram2", **overrides)
                exit_code, stdout, stderr = self.run_guard("telegram2")
                rendered = stdout + stderr
                self.assertEqual(exit_code, guard.EXIT_CONFIG)
                event = self.assert_event(rendered, "HSG_CONFIG_ROUTE_DRIFT")
                self.assertEqual(event["profile"], "telegram2")
                self.assertNotIn(sensitive, rendered)
                self.assertIn("sha256:", rendered)
                self.write_config("telegram2")

    def test_telegram2_fallback_drift_is_rejected_without_secret_leak(self):
        secret = "fallback-secret-never-log"
        cases = (
            (
                {
                    "fallback_model": {
                        "provider": "openai-codex",
                        "model": secret,
                    }
                },
                "HSG_LEGACY_FALLBACK_FORBIDDEN",
            ),
            (
                {
                    "fallback_providers": [
                        {"provider": "openai-codex", "api_key": secret}
                    ]
                },
                "HSG_FALLBACK_FORBIDDEN",
            ),
            ({}, "HSG_FALLBACK_REQUIRED"),
        )
        for fallback_config, expected_code in cases:
            with self.subTest(expected_code=expected_code):
                self.write_config(
                    "telegram2", fallback_config=fallback_config
                )
                exit_code, stdout, stderr = self.run_guard("telegram2")
                rendered = stdout + stderr
                self.assertEqual(exit_code, guard.EXIT_CONFIG)
                self.assert_event(rendered, expected_code)
                self.assertNotIn(secret, rendered)
                self.write_config("telegram2")

    def test_telegram2_session_override_drift_is_rejected_and_hashed(self):
        raw_session_id = "telegram-sensitive-session-id"
        secret = "conversation-route-secret"
        state = {
            "telegram:private": {
                "session_id": raw_session_id,
                "conversation_model_override": {
                    "provider": secret,
                    "model": "openai-codex/gpt-5.5",
                    "base_url": "https://credential@example.invalid/v1",
                },
            }
        }
        (self.telegram_home / "sessions" / "sessions.json").write_text(
            json.dumps(state), encoding="utf-8"
        )
        exit_code, stdout, stderr = self.run_guard(
            "telegram2", command="runtime"
        )
        rendered = stdout + stderr
        self.assertEqual(exit_code, guard.EXIT_SESSION)
        event = self.assert_event(rendered, "HSG_SESSION_ROUTE_DRIFT")
        self.assertEqual(event["profile"], "telegram2")
        self.assertIn("session_ref", event["details"])
        self.assertNotIn(raw_session_id, rendered)
        self.assertNotIn(secret, rendered)
        self.assertNotIn("credential", rendered)

    def test_database_conversation_override_uses_only_selected_scope(self):
        foreign_secret = "foreign-main-routing-secret"
        connection = self.create_state_db("telegram2")
        try:
            self.add_routing_entry(
                connection,
                "telegram2",
                session_id="foreign",
                scope=str((self.main_home / "sessions").resolve()),
                entry_json=foreign_secret,
            )
            connection.commit()
        finally:
            connection.close()

        exit_code, stdout, stderr = self.run_guard(
            "telegram2", command="runtime"
        )
        self.assertEqual(exit_code, guard.EXIT_OK)
        self.assert_event(stdout + stderr, "HSG_OK")
        self.assertNotIn(foreign_secret, stdout + stderr)

        (self.telegram_home / "state.db").unlink()
        connection = self.create_state_db("telegram2")
        raw_session_id = "telegram-db-session-secret"
        try:
            self.add_routing_entry(
                connection,
                "telegram2",
                session_id=raw_session_id,
                provider="openai-codex",
                model="gpt-5.5",
            )
            connection.commit()
        finally:
            connection.close()
        exit_code, stdout, stderr = self.run_guard(
            "telegram2", command="runtime"
        )
        rendered = stdout + stderr
        self.assertEqual(exit_code, guard.EXIT_SESSION)
        self.assert_event(rendered, "HSG_SESSION_ROUTE_DRIFT")
        self.assertNotIn(raw_session_id, rendered)

    def test_telegram2_runtime_billing_provider_and_base_url_drift(self):
        session_id = "billing-session-secret"
        connection = self.create_state_db("telegram2")
        try:
            self.add_routing_entry(
                connection, "telegram2", session_id=session_id
            )
            connection.execute(
                "INSERT INTO sessions VALUES (?, NULL, ?, ?, ?, ?, ?)",
                (
                    session_id,
                    guard.DEFAULT_MODEL,
                    json.dumps(
                        {
                            "gateway_runtime": {
                                "provider": guard.DEFAULT_PROVIDER,
                                "base_url": guard.DEFAULT_BASE_URL,
                                "fallback_active": False,
                            }
                        }
                    ),
                    guard.DEFAULT_PROVIDER,
                    guard.DEFAULT_BASE_URL,
                    1,
                ),
            )
            connection.execute(
                "INSERT INTO session_model_usage VALUES (?, ?, ?, ?, ?, ?)",
                (
                    session_id,
                    guard.DEFAULT_MODEL,
                    "billing-provider-secret",
                    "https://billing-secret.example/v1",
                    1,
                    "",
                ),
            )
            connection.commit()
        finally:
            connection.close()

        exit_code, stdout, stderr = self.run_guard(
            "telegram2", command="runtime"
        )
        rendered = stdout + stderr
        self.assertEqual(exit_code, guard.EXIT_RUNTIME)
        event = self.assert_event(rendered, "HSG_RUNTIME_ROUTE_DRIFT")
        self.assertEqual(event["profile"], "telegram2")
        self.assertEqual(event["details"]["source"], "session_model_usage")
        self.assertNotIn(session_id, rendered)
        self.assertNotIn("billing-provider-secret", rendered)
        self.assertNotIn("billing-secret", rendered)

    def test_two_hermes_homes_never_read_each_others_config_or_database(self):
        main_secret = "main-config-secret-never-read-by-telegram2"
        self.main_home.joinpath("config.yaml").write_text(
            f"not: [valid\n{main_secret}", encoding="utf-8"
        )
        exit_code, stdout, stderr = self.run_guard(
            "telegram2", ambient_home=self.main_home
        )
        self.assertEqual(exit_code, guard.EXIT_OK)
        self.assert_event(stdout + stderr, "HSG_OK")
        self.assertNotIn(main_secret, stdout + stderr)

        self.write_config("main")
        telegram_db_secret = "telegram-db-secret-never-read-by-main"
        self.telegram_home.joinpath("state.db").write_text(
            telegram_db_secret, encoding="utf-8"
        )
        exit_code, stdout, stderr = self.run_guard(
            "main", ambient_home=self.telegram_home
        )
        self.assertEqual(exit_code, guard.EXIT_OK)
        self.assert_event(stdout + stderr, "HSG_OK")
        self.assertNotIn(telegram_db_secret, stdout + stderr)

    def test_nonselected_profile_drift_cannot_stop_healthy_profile(self):
        self.write_config(
            "telegram2", provider="telegram2-provider-drift-secret"
        )
        exit_code, stdout, stderr = self.run_guard("main")
        self.assertEqual(exit_code, guard.EXIT_OK)
        self.assert_event(stdout + stderr, "HSG_OK")
        self.assertNotIn(
            "telegram2-provider-drift-secret", stdout + stderr
        )

        self.write_config("telegram2")
        self.write_profiles(
            mutate=lambda document: document["profiles"]["telegram2"].update(
                {"model": "telegram2-manifest-drift-secret"}
            )
        )
        exit_code, stdout, stderr = self.run_guard("main")
        self.assertEqual(exit_code, guard.EXIT_OK)
        self.assert_event(stdout + stderr, "HSG_OK")
        self.assertNotIn(
            "telegram2-manifest-drift-secret", stdout + stderr
        )

    def test_manifest_cannot_point_main_into_nested_telegram2_home(self):
        self.write_profiles(
            mutate=lambda document: document["profiles"]["main"].update(
                {"config": "profiles/telegram2/foreign-config.yaml"}
            )
        )
        exit_code, stdout, stderr = self.run_guard("main")
        self.assertEqual(exit_code, guard.EXIT_CONFIG)
        self.assert_event(
            stdout + stderr, "HSG_PROFILE_SCOPE_VIOLATION"
        )

    def test_ha_profile_links_stay_within_explicit_resolved_roots(self):
        shared = self.root / "iCloudDrive" / "hermes-ha" / "hermes"
        local_trees = self.root / ".config" / "hermes-ha" / "local_trees"
        runtime = self.root / ".config" / "hermes-ha" / "runtime"
        (shared / "sessions").mkdir(parents=True)
        local_trees.mkdir(parents=True)
        runtime.mkdir(parents=True)

        main_config = self.main_home / "config.yaml"
        main_config.rename(shared / "config.yaml")
        main_config.symlink_to(shared / "config.yaml")
        (shared / "sessions" / "sessions.json").write_text(
            "{}", encoding="utf-8"
        )
        (self.main_home / "sessions" / "sessions.json").symlink_to(
            shared / "sessions" / "sessions.json"
        )
        (self.main_home / "state.db").symlink_to(local_trees / "state.db")
        main_env = self.main_home / ".env"
        main_env.rename(runtime / ".env")
        main_env.symlink_to(runtime / ".env")

        self.write_profiles(
            mutate=lambda document: document["profiles"]["main"].update(
                {
                    "resolved_roots": [
                        str(shared),
                        str(local_trees),
                        str(runtime),
                    ]
                }
            )
        )
        exit_code, stdout, stderr = self.run_guard("main")
        self.assertEqual(exit_code, guard.EXIT_OK)
        self.assert_event(stdout + stderr, "HSG_OK")

    def test_unlisted_or_overbroad_resolved_roots_fail_closed(self):
        shared = self.root / "iCloudDrive" / "hermes-ha" / "hermes"
        shared.mkdir(parents=True)
        main_config = self.main_home / "config.yaml"
        main_config.rename(shared / "config.yaml")
        main_config.symlink_to(shared / "config.yaml")

        exit_code, stdout, stderr = self.run_guard("main")
        self.assertEqual(exit_code, guard.EXIT_CONFIG)
        self.assert_event(stdout + stderr, "HSG_PROFILE_PATH_ESCAPE")

        self.write_profiles(
            mutate=lambda document: document["profiles"]["main"].update(
                {"resolved_roots": [str(self.root)]}
            )
        )
        exit_code, stdout, stderr = self.run_guard("main")
        self.assertEqual(exit_code, guard.EXIT_CONFIG)
        self.assert_event(
            stdout + stderr, "HSG_PROFILE_RESOLVED_ROOTS_INVALID"
        )

    def test_ha_shared_root_cannot_cross_into_other_profile_scope(self):
        shared = self.root / "iCloudDrive" / "hermes-ha" / "hermes"
        telegram_shared = shared / "profiles" / "telegram2"
        telegram_shared.mkdir(parents=True)
        (telegram_shared / "config.yaml").write_text(
            json.dumps(
                {
                    "model": {
                        "provider": guard.DEFAULT_PROVIDER,
                        "default": guard.DEFAULT_MODEL,
                        "base_url": guard.DEFAULT_BASE_URL,
                        "api_mode": "chat_completions",
                    },
                    "fallback_providers": [],
                }
            ),
            encoding="utf-8",
        )
        main_config = self.main_home / "config.yaml"
        main_config.unlink()
        main_config.symlink_to(telegram_shared / "config.yaml")
        self.write_profiles(
            mutate=lambda document: (
                document["profiles"]["main"].update(
                    {"resolved_roots": [str(shared)]}
                ),
                document["profiles"]["telegram2"].update(
                    {"resolved_roots": [str(telegram_shared)]}
                ),
            )
        )
        exit_code, stdout, stderr = self.run_guard("main")
        self.assertEqual(exit_code, guard.EXIT_CONFIG)
        self.assert_event(
            stdout + stderr, "HSG_PROFILE_SCOPE_VIOLATION"
        )

    def test_ha_symlink_swap_cannot_move_into_other_resolved_root(self):
        shared = self.root / "iCloudDrive" / "hermes-ha" / "hermes"
        telegram_shared = shared / "profiles" / "telegram2"
        telegram_shared.mkdir(parents=True)
        main_config = self.main_home / "config.yaml"
        main_config.rename(shared / "config.yaml")
        main_config.symlink_to(shared / "config.yaml")
        (telegram_shared / "config.yaml").write_text(
            (shared / "config.yaml").read_text(encoding="utf-8"),
            encoding="utf-8",
        )
        self.write_profiles(
            mutate=lambda document: (
                document["profiles"]["main"].update(
                    {"resolved_roots": [str(shared)]}
                ),
                document["profiles"]["telegram2"].update(
                    {"resolved_roots": [str(telegram_shared)]}
                ),
            )
        )
        with mock.patch.dict(os.environ, {"HOME": str(self.root)}):
            policy = guard.load_policy(
                profiles_file=self.profiles_file,
                profile="main",
                expected_service="hermes-gateway.service",
                timeout_override=None,
            )
        main_config.unlink()
        main_config.symlink_to(telegram_shared / "config.yaml")
        with self.assertRaises(guard.GuardFailure) as caught:
            guard.validate_config(policy)
        self.assertEqual(
            caught.exception.code, "HSG_PROFILE_SCOPE_VIOLATION"
        )

    def test_post_start_symlink_swap_cannot_cross_profile_scope(self):
        policy = guard.load_policy(
            profiles_file=self.profiles_file,
            profile="main",
            expected_service="hermes-gateway.service",
            timeout_override=None,
        )
        main_config = self.main_home / "config.yaml"
        main_config.rename(self.main_home / "config.before-symlink.yaml")
        main_config.symlink_to(self.telegram_home / "config.yaml")
        with self.assertRaises(guard.GuardFailure) as caught:
            guard.validate_config(policy)
        self.assertEqual(
            caught.exception.code, "HSG_PROFILE_SCOPE_VIOLATION"
        )
        self.assertEqual(caught.exception.exit_code, guard.EXIT_CONFIG)

    def test_service_identity_mismatch_fails_closed(self):
        exit_code, stdout, stderr = self.run_guard(
            "telegram2", expected_service="hermes-gateway.service"
        )
        self.assertEqual(exit_code, guard.EXIT_CONFIG)
        event = self.assert_event(
            stdout + stderr, "HSG_PROFILE_SERVICE_MISMATCH"
        )
        self.assertEqual(event["profile"], "telegram2")

    def test_manifest_home_drift_fails_before_profile_state_is_read(self):
        wrong_home = self.root / "wrong-telegram-home"
        wrong_home.mkdir()
        self.write_profiles(
            mutate=lambda document: document["profiles"]["telegram2"].update(
                {"hermes_home": str(wrong_home)}
            )
        )
        exit_code, stdout, stderr = self.run_guard("telegram2")
        self.assertEqual(exit_code, guard.EXIT_CONFIG)
        self.assert_event(
            stdout + stderr, "HSG_PROFILE_HOME_MISMATCH"
        )

    def test_gateway_preflight_rejects_ambient_home_crossing_profiles(self):
        exit_code, stdout, stderr = self.run_guard(
            "telegram2",
            ambient_home=self.main_home,
            check_environment_home=True,
        )
        self.assertEqual(exit_code, guard.EXIT_CONFIG)
        self.assert_event(
            stdout + stderr, "HSG_PROFILE_HOME_MISMATCH"
        )

        exit_code, stdout, stderr = self.run_guard(
            "telegram2",
            ambient_home=self.telegram_home,
            check_environment_home=True,
        )
        self.assertEqual(exit_code, guard.EXIT_OK)
        self.assert_event(stdout + stderr, "HSG_OK")

    def test_unprotected_isolated_profile_skips_without_reading_state(self):
        secret = "isolated-state-secret"
        self.isolated_home.mkdir()
        self.isolated_home.joinpath("config.yaml").write_text(
            secret, encoding="utf-8"
        )
        self.write_profiles(
            mutate=lambda document: document["profiles"][
                "isolated-test"
            ].update(
                {
                    "hermes_home": str(self.isolated_home),
                    "config": "config.yaml",
                    "untrusted_secret_field": secret,
                }
            )
        )
        exit_code, stdout, stderr = self.run_guard("isolated-test")
        self.assertEqual(exit_code, guard.EXIT_OK)
        self.assertEqual(stderr, "")
        self.assert_event(stdout, "HSG_PROFILE_NOT_ENFORCED")
        self.assertNotIn(secret, stdout)

        exit_code, stdout, stderr = self.run_guard(
            "isolated-test", require_protected=True
        )
        self.assertEqual(exit_code, guard.EXIT_CONFIG)
        self.assert_event(
            stdout + stderr, "HSG_PROFILE_PROTECTION_REQUIRED"
        )

    def test_profile_policy_drift_is_redacted_and_rejected(self):
        secret = "manifest-provider-secret"
        self.write_profiles(
            mutate=lambda document: document["profiles"]["telegram2"].update(
                {"provider": secret}
            )
        )
        exit_code, stdout, stderr = self.run_guard("telegram2")
        rendered = stdout + stderr
        self.assertEqual(exit_code, guard.EXIT_CONFIG)
        self.assert_event(rendered, "HSG_PROFILE_POLICY_DRIFT")
        self.assertNotIn(secret, rendered)

    def test_selected_profile_api_key_comes_only_from_its_own_env_file(self):
        self.telegram_home.joinpath(".env").write_text(
            "UNRELATED=value\n", encoding="utf-8"
        )
        exit_code, stdout, stderr = self.run_guard("telegram2")
        rendered = stdout + stderr
        self.assertEqual(exit_code, guard.EXIT_HEALTH)
        self.assert_event(rendered, "HSG_HEALTH_AUTH_MISSING")
        self.assertNotIn(self.profile_keys["main"], rendered)

    def test_runner_and_target_model_health_are_profile_scoped(self):
        self.runners_online = 0
        exit_code, stdout, stderr = self.run_guard("telegram2", command="runtime")
        self.assertEqual(exit_code, guard.EXIT_HEALTH)
        event = self.assert_event(stdout + stderr, "HSG_RUNNER_OFFLINE")
        self.assertEqual(event["profile"], "telegram2")
        self.assertEqual(
            event["service"], "hermes-gateway-telegram2.service"
        )

        self.runners_online = 2
        exit_code, stdout, stderr = self.run_guard(
            "main", command="runtime"
        )
        self.assertEqual(exit_code, guard.EXIT_HEALTH)
        event = self.assert_event(
            stdout + stderr, "HSG_CAPACITY_DRIFT"
        )
        self.assertEqual(
            event["details"]["expected"]["effectiveTotal"], 6
        )
        self.assertEqual(
            event["details"]["observed"]["runnerIdentities"], 2
        )

        self.runners_online = 1
        self.health_models = []
        exit_code, stdout, stderr = self.run_guard("main", command="runtime")
        self.assertEqual(exit_code, guard.EXIT_MODEL_OFFLINE)
        event = self.assert_event(stdout + stderr, "HSG_TARGET_MODEL_OFFLINE")
        self.assertEqual(event["profile"], "main")

        self.health_models = [guard.DEFAULT_MODEL]
        self.catalog_models = []
        exit_code, stdout, stderr = self.run_guard(
            "telegram2", command="runtime"
        )
        self.assertEqual(exit_code, guard.EXIT_MODEL_OFFLINE)
        self.assert_event(
            stdout + stderr, "HSG_TARGET_MODEL_UNROUTABLE"
        )

    def test_watch_exits_on_first_profile_failure_without_internal_restart(self):
        argv = [
            "watch",
            "--profile",
            "telegram2",
            "--profiles-file",
            str(self.profiles_file),
            "--expected-service",
            "hermes-gateway-telegram2.service",
            "--expected-home",
            str(self.telegram_home),
            "--require-protected",
            "--interval",
            "0.01",
            "--heartbeat-seconds",
            "1",
        ]
        with mock.patch.object(
            guard,
            "_execute_once",
            side_effect=[guard.EXIT_OK, guard.EXIT_RUNTIME],
        ) as execute_once:
            with mock.patch.object(guard.time, "sleep") as sleep:
                exit_code = guard.main(argv)
        self.assertEqual(exit_code, guard.EXIT_RUNTIME)
        self.assertEqual(execute_once.call_count, 2)
        sleep.assert_called_once_with(0.01)

    def test_json_yaml_subset_loads_without_pyyaml(self):
        real_import = builtins.__import__

        def import_without_yaml(name, globals=None, locals=None, fromlist=(), level=0):
            if name == "yaml":
                raise ImportError("test-only missing PyYAML")
            return real_import(name, globals, locals, fromlist, level)

        with mock.patch.object(
            builtins, "__import__", side_effect=import_without_yaml
        ):
            loaded = guard._load_yaml_mapping(
                self.telegram_home / "config.yaml"
            )
        self.assertEqual(
            loaded["model"]["provider"], guard.DEFAULT_PROVIDER
        )


class StrictRouteSystemdTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.hermes_root = Path(__file__).resolve().parent.parent
        cls.systemd_root = cls.hermes_root / "systemd"
        cls.main_dropin = (
            cls.systemd_root
            / "hermes-gateway.service.d"
            / "zz-strict-route.conf"
        ).read_text(encoding="utf-8")
        cls.telegram_dropin = (
            cls.systemd_root
            / "hermes-gateway-telegram2.service.d"
            / "zz-strict-route.conf"
        ).read_text(encoding="utf-8")
        cls.guard_template = (
            cls.systemd_root / "hermes-strict-route-guard@.service"
        ).read_text(encoding="utf-8")

    def test_each_gateway_binds_only_its_own_guard_instance(self):
        self.assertIn(
            "BindsTo=hermes-strict-route-guard@main.service",
            self.main_dropin,
        )
        self.assertNotIn("@telegram2.service", self.main_dropin)
        self.assertIn(
            "BindsTo=hermes-strict-route-guard@telegram2.service",
            self.telegram_dropin,
        )
        self.assertNotIn(
            "BindsTo=hermes-strict-route-guard@main.service",
            self.telegram_dropin,
        )

    def test_preflight_scope_and_service_match_each_gateway(self):
        for rendered, profile, service, home in (
            (
                self.main_dropin,
                "main",
                "hermes-gateway.service",
                "%h/.hermes",
            ),
            (
                self.telegram_dropin,
                "telegram2",
                "hermes-gateway-telegram2.service",
                "%h/.hermes/profiles/telegram2",
            ),
        ):
            with self.subTest(profile=profile):
                self.assertIn(f"--profile {profile}", rendered)
                self.assertIn(f"--expected-service {service}", rendered)
                self.assertIn(f"--expected-home {home}", rendered)
                self.assertIn("--require-protected", rendered)
                self.assertIn("--check-environment-home", rendered)
                self.assertIn(f"Environment=HERMES_HOME={home}", rendered)
                self.assertIn(
                    f"Environment=HERMES_STRICT_ROUTE_HOME={home}",
                    rendered,
                )
                self.assertIn("Restart=no", rendered)

    def test_guard_template_is_instance_scoped_and_does_not_restart(self):
        self.assertIn("--profile %i", self.guard_template)
        self.assertIn("--require-protected", self.guard_template)
        self.assertIn("StopWhenUnneeded=yes", self.guard_template)
        self.assertIn("Restart=no", self.guard_template)
        self.assertNotIn("PartOf=hermes-gateway.service", self.guard_template)
        self.assertNotIn("systemctl", self.guard_template)

    def test_shipped_profile_example_matches_systemd_bindings(self):
        profiles_file = (
            self.hermes_root
            / "cursor-gateway"
            / "strict-route-profiles.example.json"
        )
        document = json.loads(profiles_file.read_text(encoding="utf-8"))
        self.assertEqual(document["schema_version"], 1)
        self.assertEqual(
            document["profiles"]["main"]["service"],
            "hermes-gateway.service",
        )
        self.assertEqual(
            document["profiles"]["telegram2"]["service"],
            "hermes-gateway-telegram2.service",
        )
        for profile in ("main", "telegram2"):
            self.assertTrue(document["profiles"][profile]["protected"])
            self.assertEqual(
                document["profiles"][profile]["provider"],
                guard.DEFAULT_PROVIDER,
            )
            self.assertEqual(
                document["profiles"][profile]["model"],
                guard.DEFAULT_MODEL,
            )
            policy = guard.load_policy(
                profiles_file=profiles_file,
                profile=profile,
                expected_service="",
                expected_home=None,
                timeout_override=None,
                require_protected=True,
            )
            self.assertEqual(
                policy.service, document["profiles"][profile]["service"]
            )


if __name__ == "__main__":
    unittest.main()
