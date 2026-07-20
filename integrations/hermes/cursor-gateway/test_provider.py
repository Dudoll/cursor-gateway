import importlib.util
import sys
import threading
import types
import unittest
from pathlib import Path


class ProviderProfile:
    def __init__(self, **kwargs):
        for key, value in kwargs.items():
            setattr(self, key, value)


def load_profile():
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
        return registered[0]
    finally:
        for name, value in previous.items():
            if value is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = value


class CursorGatewayProviderTests(unittest.TestCase):
    def test_headers_are_stable_for_retry_and_change_for_new_turn(self):
        profile = load_profile()
        first = [{"role": "user", "content": "hello"}]
        profile.prepare_messages(first)
        _, kwargs_a = profile.build_api_kwargs_extras(
            session_id="session-1", model="auto"
        )
        profile.prepare_messages(first)
        _, kwargs_b = profile.build_api_kwargs_extras(
            session_id="session-1", model="auto"
        )
        profile.prepare_messages([{"role": "user", "content": "next"}])
        _, kwargs_c = profile.build_api_kwargs_extras(
            session_id="session-1", model="auto"
        )

        headers_a = kwargs_a["extra_headers"]
        headers_b = kwargs_b["extra_headers"]
        headers_c = kwargs_c["extra_headers"]
        self.assertEqual(headers_a["x-session-id"], "hermes:session-1")
        self.assertEqual(headers_a["idempotency-key"], headers_b["idempotency-key"])
        self.assertNotEqual(headers_a["idempotency-key"], headers_c["idempotency-key"])

    def test_message_digest_is_isolated_per_thread(self):
        profile = load_profile()
        results = {}

        def build(name):
            profile.prepare_messages([{"role": "user", "content": name}])
            _, kwargs = profile.build_api_kwargs_extras(
                session_id=name, model="auto"
            )
            results[name] = kwargs["extra_headers"]["idempotency-key"]

        threads = [threading.Thread(target=build, args=(name,)) for name in ("a", "b")]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertNotEqual(results["a"], results["b"])


if __name__ == "__main__":
    unittest.main()
