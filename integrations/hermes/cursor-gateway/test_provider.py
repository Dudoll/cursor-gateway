import importlib.util
import os
import sys
import threading
import types
import unittest
from pathlib import Path
from unittest import mock


class ProviderProfile:
    def __init__(self, **kwargs):
        for key, value in kwargs.items():
            setattr(self, key, value)


def load_profile_module():
    registered = []
    providers = types.ModuleType("providers")
    providers.register_provider = registered.append
    base = types.ModuleType("providers.base")
    base.ProviderProfile = ProviderProfile
    previous = {
        name: sys.modules.get(name)
        for name in ("providers", "providers.base", "cursor_gateway_provider_test")
    }
    sys.modules["providers"] = providers
    sys.modules["providers.base"] = base
    try:
        source = Path(__file__).with_name("__init__.py")
        spec = importlib.util.spec_from_file_location(
            "cursor_gateway_provider_test", source
        )
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        assert len(registered) == 1
        return module, registered[0]
    finally:
        for name, value in previous.items():
            if value is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = value


def load_profile():
    return load_profile_module()[1]


class CursorGatewayProviderTests(unittest.TestCase):
    def setUp(self):
        self.strict_disabled = mock.patch.dict(
            os.environ, {"HERMES_STRICT_ROUTE_ENABLED": ""}, clear=False
        )
        self.strict_disabled.start()

    def tearDown(self):
        self.strict_disabled.stop()

    def strict_env(self, profile="main"):
        home = (
            "/tmp/hermes-main"
            if profile == "main"
            else f"/tmp/hermes-profiles/{profile}"
        )
        service = (
            "hermes-gateway.service"
            if profile == "main"
            else f"hermes-gateway-{profile}.service"
        )
        return {
            "CURSOR_GATEWAY_CSAPI_KEY": "test-only-key",
            "HERMES_API_TIMEOUT": "1860",
            "HERMES_HOME": home,
            "HERMES_STREAM_READ_TIMEOUT": "1860",
            "HERMES_STRICT_ROUTE_ACTIVE_PROFILE": profile,
            "HERMES_STRICT_ROUTE_ENABLED": "1",
            "HERMES_STRICT_ROUTE_HOME": home,
            "HERMES_STRICT_ROUTE_PROFILE": profile,
            "HERMES_STRICT_ROUTE_SERVICE": service,
        }

    def test_profile_catalog_is_pinned_to_the_strict_target(self):
        module, profile = load_profile_module()
        self.assertEqual(profile.name, module.STRICT_PROVIDER)
        self.assertEqual(profile.base_url, module.STRICT_BASE_URL)
        self.assertEqual(profile.default_aux_model, module.STRICT_MODEL)
        self.assertEqual(profile.fallback_models, (module.STRICT_MODEL,))

    def test_shipped_profiles_pin_finite_long_call_budgets(self):
        root = Path(__file__).resolve().parents[3]
        for name in (
            "config.main.strict.example.yaml",
            "config.telegram2.strict.example.yaml",
        ):
            text = (Path(__file__).with_name(name)).read_text(encoding="utf-8")
            self.assertIn("request_timeout_seconds: 1860", text)
        for relative in (
            "integrations/hermes/systemd/hermes-gateway.service.d/zz-strict-route.conf",
            "integrations/hermes/systemd/hermes-gateway-telegram2.service.d/zz-strict-route.conf",
        ):
            text = (root / relative).read_text(encoding="utf-8")
            self.assertIn("Environment=HERMES_API_TIMEOUT=1860", text)
            self.assertIn("Environment=HERMES_STREAM_READ_TIMEOUT=1860", text)

    def test_headers_are_stable_for_retry_and_change_for_new_turn(self):
        module, profile = load_profile_module()
        first = [{"role": "user", "content": "hello"}]
        profile.prepare_messages(first)
        _, kwargs_a = profile.build_api_kwargs_extras(
            session_id="session-1", model=module.STRICT_MODEL
        )
        profile.prepare_messages(first)
        _, kwargs_b = profile.build_api_kwargs_extras(
            session_id="session-1", model=module.STRICT_MODEL
        )
        profile.prepare_messages([{"role": "user", "content": "next"}])
        _, kwargs_c = profile.build_api_kwargs_extras(
            session_id="session-1", model=module.STRICT_MODEL
        )

        headers_a = kwargs_a["extra_headers"]
        headers_b = kwargs_b["extra_headers"]
        headers_c = kwargs_c["extra_headers"]
        self.assertEqual(headers_a["x-session-id"], "hermes:session-1")
        self.assertEqual(headers_a["idempotency-key"], headers_b["idempotency-key"])
        self.assertNotEqual(headers_a["idempotency-key"], headers_c["idempotency-key"])

    def test_message_digest_is_isolated_per_thread(self):
        module, profile = load_profile_module()
        results = {}

        def build(name):
            profile.prepare_messages([{"role": "user", "content": name}])
            _, kwargs = profile.build_api_kwargs_extras(
                session_id=name, model=module.STRICT_MODEL
            )
            results[name] = kwargs["extra_headers"]["idempotency-key"]

        threads = [threading.Thread(target=build, args=(name,)) for name in ("a", "b")]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertNotEqual(results["a"], results["b"])

    def test_strict_request_accepts_both_protected_profiles(self):
        module, profile = load_profile_module()
        for profile_name in ("main", "telegram2"):
            with self.subTest(profile=profile_name):
                with mock.patch.dict(
                    os.environ, self.strict_env(profile_name), clear=False
                ):
                    with mock.patch.object(
                        module, "_probe_strict_target"
                    ) as probe:
                        _, kwargs = profile.build_api_kwargs_extras(
                            session_id="strict-session",
                            model=module.STRICT_MODEL,
                            base_url=module.STRICT_BASE_URL,
                        )
                probe.assert_called_once_with(
                    base_url=module.STRICT_BASE_URL,
                    model=module.STRICT_MODEL,
                )
                self.assertEqual(
                    kwargs["extra_headers"]["x-session-id"],
                    "hermes:strict-session",
                )

    def test_strict_request_rejects_model_base_url_and_policy_drift(self):
        module, profile = load_profile_module()
        secret = "never-print-this-token"
        strict_env = {**self.strict_env("telegram2"), "CURSOR_GATEWAY_CSAPI_KEY": secret}
        cases = (
            (
                {"model": "deepseek-chat", "base_url": module.STRICT_BASE_URL},
                "HSG_RUNTIME_MODEL_DRIFT",
                {},
            ),
            (
                {
                    "model": module.STRICT_MODEL,
                    "base_url": "https://api.deepseek.com/v1",
                },
                "HSG_RUNTIME_BASE_URL_DRIFT",
                {},
            ),
            (
                {
                    "model": module.STRICT_MODEL,
                    "base_url": module.STRICT_BASE_URL,
                },
                "HSG_PROVIDER_POLICY_DRIFT",
                {"HERMES_STRICT_ROUTE_PROVIDER": "deepseek"},
            ),
        )
        for route, code, extra_env in cases:
            with self.subTest(code=code):
                with mock.patch.dict(
                    os.environ, {**strict_env, **extra_env}, clear=False
                ):
                    with self.assertRaises(module.StrictRouteViolation) as caught:
                        profile.build_api_kwargs_extras(**route)
                rendered = str(caught.exception)
                self.assertIn(code, rendered)
                self.assertNotIn(secret, rendered)

    def test_unprotected_isolated_profile_is_not_enforced(self):
        module, profile = load_profile_module()
        with mock.patch.dict(
            os.environ,
            {
                "HERMES_STRICT_ROUTE_ACTIVE_PROFILE": "telegram2",
                "HERMES_STRICT_ROUTE_ENABLED": "",
            },
            clear=False,
        ):
            with mock.patch.object(module, "_probe_strict_target") as probe:
                profile.build_api_kwargs_extras(
                    model="isolated-model",
                    base_url="http://127.0.0.1:9999/v1",
                )
        probe.assert_not_called()

    def test_enabled_profile_scope_and_home_mismatch_fail_closed(self):
        module, profile = load_profile_module()
        cases = (
            (
                {"HERMES_STRICT_ROUTE_PROFILE": "main"},
                "HSG_PROFILE_SCOPE_MISMATCH",
            ),
            (
                {"HERMES_HOME": "/tmp/wrong-profile-home"},
                "HSG_PROFILE_HOME_MISMATCH",
            ),
            (
                {"HERMES_STRICT_ROUTE_SERVICE": "hermes-gateway.service"},
                "HSG_PROFILE_SERVICE_MISMATCH",
            ),
        )
        for extra, code in cases:
            with self.subTest(code=code):
                with mock.patch.dict(
                    os.environ,
                    {**self.strict_env("telegram2"), **extra},
                    clear=False,
                ):
                    with self.assertRaises(
                        module.StrictRouteViolation
                    ) as caught:
                        profile.build_api_kwargs_extras(
                            model=module.STRICT_MODEL,
                            base_url=module.STRICT_BASE_URL,
                        )
                rendered = str(caught.exception)
                self.assertIn(code, rendered)
                self.assertIn('"profile": "telegram2"', rendered)

    def test_short_request_budget_fails_closed_without_logging_values(self):
        module, profile = load_profile_module()
        secret_marker = "never-log-timeout-marker"
        with mock.patch.dict(
            os.environ,
            {
                **self.strict_env("telegram2"),
                "HERMES_API_TIMEOUT": "300",
                "HERMES_STREAM_READ_TIMEOUT": secret_marker,
            },
            clear=False,
        ):
            with self.assertRaises(module.StrictRouteViolation) as caught:
                profile.build_api_kwargs_extras(
                    model=module.STRICT_MODEL,
                    base_url=module.STRICT_BASE_URL,
                )
        rendered = str(caught.exception)
        self.assertIn("HSG_REQUEST_TIMEOUT_BUDGET_DRIFT", rendered)
        self.assertNotIn("300", rendered)
        self.assertNotIn(secret_marker, rendered)

    def test_target_offline_is_an_explicit_request_failure(self):
        module, profile = load_profile_module()
        with mock.patch.dict(
            os.environ,
            self.strict_env("main"),
            clear=False,
        ):
            with mock.patch.object(
                module,
                "_probe_strict_target",
                side_effect=module._strict_error(
                    "HSG_TARGET_MODEL_OFFLINE", "health"
                ),
            ):
                with self.assertRaises(module.StrictRouteViolation) as caught:
                    profile.build_api_kwargs_extras(
                        model=module.STRICT_MODEL,
                        base_url=module.STRICT_BASE_URL,
                    )
        self.assertIn("HSG_TARGET_MODEL_OFFLINE", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
