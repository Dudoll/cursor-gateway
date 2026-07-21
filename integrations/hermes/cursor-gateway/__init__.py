"""Hermes model-provider profile for the local Cursor Gateway CSAPI."""

from __future__ import annotations

import hashlib
import json
import os
import re
import threading
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from providers import register_provider
from providers.base import ProviderProfile


STRICT_PROVIDER = "cursor-gateway"
STRICT_MODEL = "gpt-5.6-sol"
STRICT_BASE_URL = "http://127.0.0.1:18080/v1"
STRICT_API_KEY_ENV = "CURSOR_GATEWAY_CSAPI_KEY"
STRICT_EFFECTIVE_CAPACITY = 6
_MAX_PROBE_BYTES = 1024 * 1024
_PROFILE_LABEL_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")
_SERVICE_LABEL_PATTERN = re.compile(
    r"^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,127}\.service$"
)
_PRODUCTION_SERVICES = {
    "main": "hermes-gateway.service",
    "telegram2": "hermes-gateway-telegram2.service",
}


class _RejectRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_HTTP_OPENER = urllib.request.build_opener(
    urllib.request.ProxyHandler({}), _RejectRedirects()
)


class StrictRouteViolation(RuntimeError):
    """Raised before inference when the production route is not exact."""


def _strict_context() -> tuple[bool, str]:
    enabled = str(os.environ.get("HERMES_STRICT_ROUTE_ENABLED") or "").lower()
    if enabled not in {"1", "true", "yes", "on"}:
        return False, ""
    active_profile = str(
        os.environ.get("HERMES_STRICT_ROUTE_ACTIVE_PROFILE") or ""
    ).strip()
    expected_profile = str(
        os.environ.get("HERMES_STRICT_ROUTE_PROFILE") or ""
    ).strip()
    if not active_profile or not expected_profile:
        raise _strict_error("HSG_PROFILE_SCOPE_MISSING", "scope")
    if active_profile != expected_profile:
        raise _strict_error("HSG_PROFILE_SCOPE_MISMATCH", "scope")
    active_service = str(
        os.environ.get("HERMES_STRICT_ROUTE_SERVICE") or ""
    ).strip()
    required_service = _PRODUCTION_SERVICES.get(active_profile)
    if (
        not _SERVICE_LABEL_PATTERN.fullmatch(active_service)
        or (required_service and active_service != required_service)
    ):
        raise _strict_error("HSG_PROFILE_SERVICE_MISMATCH", "scope")

    active_home = str(os.environ.get("HERMES_HOME") or "").strip()
    expected_home = str(
        os.environ.get("HERMES_STRICT_ROUTE_HOME") or ""
    ).strip()
    try:
        active_home_path = Path(active_home).expanduser().resolve()
        expected_home_path = Path(expected_home).expanduser().resolve()
    except (OSError, RuntimeError, ValueError) as exc:
        raise _strict_error("HSG_PROFILE_HOME_INVALID", "scope") from exc
    if (
        not active_home
        or not expected_home
        or active_home_path != expected_home_path
    ):
        raise _strict_error("HSG_PROFILE_HOME_MISMATCH", "scope")
    return True, active_profile


def _normalized_base_url(value: Any) -> str:
    try:
        parsed = urlsplit(str(value or "").strip())
        if (
            not parsed.scheme
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.query
            or parsed.fragment
        ):
            return ""
        host = parsed.hostname.lower()
        if ":" in host and not host.startswith("["):
            host = f"[{host}]"
        port = f":{parsed.port}" if parsed.port is not None else ""
        path = parsed.path.rstrip("/") or "/"
        return urlunsplit((parsed.scheme.lower(), f"{host}{port}", path, "", ""))
    except (TypeError, ValueError):
        return ""


def _strict_error(code: str, check: str) -> StrictRouteViolation:
    if code in {"HSG_TARGET_MODEL_OFFLINE", "HSG_TARGET_MODEL_UNROUTABLE"}:
        exit_code = 24
    elif check == "health":
        exit_code = 23
    else:
        exit_code = 22
    payload = {
        "check": check,
        "code": code,
        "component": "hermes-strict-route-guard",
        "event": "provider.request_rejected",
        "exit_code": exit_code,
        "status": "failed",
    }
    profile = str(
        os.environ.get("HERMES_STRICT_ROUTE_ACTIVE_PROFILE") or ""
    ).strip()
    service = str(
        os.environ.get("HERMES_STRICT_ROUTE_SERVICE") or ""
    ).strip()
    if _PROFILE_LABEL_PATTERN.fullmatch(profile):
        payload["profile"] = profile
    if _SERVICE_LABEL_PATTERN.fullmatch(service):
        payload["service"] = service
    return StrictRouteViolation(
        json.dumps(payload, ensure_ascii=True, sort_keys=True)
    )


def _probe_json(url: str, *, timeout: float, api_key: str | None = None) -> Any:
    headers = {
        "Accept": "application/json",
        "User-Agent": "hermes-cursor-gateway-strict/1",
    }
    if api_key:
        headers["X-API-Key"] = api_key
    request = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with _HTTP_OPENER.open(request, timeout=timeout) as response:
            payload = response.read(_MAX_PROBE_BYTES + 1)
    except urllib.error.HTTPError as exc:
        code = (
            "HSG_HEALTH_AUTH_FAILED"
            if exc.code in {401, 403}
            else "HSG_HEALTH_HTTP_FAILED"
        )
        raise _strict_error(code, "health") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise _strict_error("HSG_HEALTH_UNREACHABLE", "health") from exc
    if len(payload) > _MAX_PROBE_BYTES:
        raise _strict_error("HSG_HEALTH_RESPONSE_TOO_LARGE", "health")
    try:
        return json.loads(payload.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise _strict_error("HSG_HEALTH_RESPONSE_INVALID", "health") from exc


def _probe_strict_target(*, base_url: str, model: str) -> None:
    token = str(os.environ.get(STRICT_API_KEY_ENV) or "").strip()
    if not token:
        raise _strict_error("HSG_HEALTH_AUTH_MISSING", "health")
    try:
        timeout = float(
            os.environ.get("HERMES_STRICT_ROUTE_PROBE_TIMEOUT") or "3"
        )
    except ValueError:
        timeout = 3.0
    timeout = min(max(timeout, 0.1), 10.0)

    parsed = urlsplit(base_url)
    path = parsed.path.rstrip("/")
    root_path = path[:-3] if path.endswith("/v1") else path
    health_path = f"{root_path}/health" if root_path else "/health"
    health_url = urlunsplit(
        (parsed.scheme, parsed.netloc, health_path, "", "")
    )
    health = _probe_json(health_url, timeout=timeout)
    if not isinstance(health, dict) or health.get("ok") is not True:
        raise _strict_error("HSG_RUNNER_UNHEALTHY", "health")
    try:
        runners_online = int(health.get("runnersOnline", 0))
    except (TypeError, ValueError):
        runners_online = 0
    advertised = health.get("models")
    if (
        runners_online < 1
        or not isinstance(advertised, list)
        or model not in {str(item) for item in advertised}
    ):
        raise _strict_error("HSG_TARGET_MODEL_OFFLINE", "health")
    capacity = health.get("capacity")
    expected_capacity = {
        "effectiveTotal": STRICT_EFFECTIVE_CAPACITY,
        "maxConcurrencyPerKey": STRICT_EFFECTIVE_CAPACITY,
        "runnerIdentities": 1,
        "totalRunnerSlots": STRICT_EFFECTIVE_CAPACITY,
    }
    if not isinstance(capacity, dict) or any(
        type(capacity.get(key)) is not int
        or capacity.get(key) != expected
        for key, expected in expected_capacity.items()
    ):
        raise _strict_error("HSG_CAPACITY_DRIFT", "health")

    catalog = _probe_json(
        f"{base_url.rstrip('/')}/models", timeout=timeout, api_key=token
    )
    data = catalog.get("data") if isinstance(catalog, dict) else None
    model_ids = {
        str(item.get("id"))
        for item in data or []
        if isinstance(item, dict) and item.get("id") not in (None, "")
    }
    if model not in model_ids:
        raise _strict_error("HSG_TARGET_MODEL_UNROUTABLE", "health")


class CursorGatewayProfile(ProviderProfile):
    """Attach durable headers and enforce the opt-in production route."""

    def __init__(self) -> None:
        super().__init__(
            name=STRICT_PROVIDER,
            aliases=("csapi", "cursor_gateway"),
            display_name="Cursor Gateway",
            description="Local Cursor Gateway CSAPI (/v1) — runner-backed models",
            env_vars=(STRICT_API_KEY_ENV,),
            base_url=STRICT_BASE_URL,
            models_url=f"{STRICT_BASE_URL}/models",
            api_mode="chat_completions",
            auth_type="api_key",
            supports_health_check=True,
            default_aux_model=STRICT_MODEL,
            fallback_models=(STRICT_MODEL,),
        )
        self._request_state = threading.local()

    def _assert_strict_route(self, *, model: str, base_url: Any) -> None:
        enabled, _profile = _strict_context()
        if not enabled:
            return
        expected_provider = str(
            os.environ.get("HERMES_STRICT_ROUTE_PROVIDER") or STRICT_PROVIDER
        ).strip()
        expected_model = str(
            os.environ.get("HERMES_STRICT_ROUTE_MODEL") or STRICT_MODEL
        ).strip()
        expected_base_url = _normalized_base_url(
            os.environ.get("HERMES_STRICT_ROUTE_BASE_URL") or STRICT_BASE_URL
        )
        if expected_provider != self.name:
            raise _strict_error("HSG_PROVIDER_POLICY_DRIFT", "provider")
        if expected_model != STRICT_MODEL:
            raise _strict_error("HSG_MODEL_POLICY_DRIFT", "model")
        if expected_base_url != STRICT_BASE_URL:
            raise _strict_error("HSG_BASE_URL_POLICY_DRIFT", "base_url")
        if model != expected_model:
            raise _strict_error("HSG_RUNTIME_MODEL_DRIFT", "model")
        if (
            not expected_base_url
            or _normalized_base_url(base_url) != expected_base_url
        ):
            raise _strict_error("HSG_RUNTIME_BASE_URL_DRIFT", "base_url")
        _probe_strict_target(base_url=expected_base_url, model=expected_model)

    def prepare_messages(self, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        canonical = json.dumps(
            messages,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            default=str,
        )
        self._request_state.messages_digest = hashlib.sha256(
            canonical.encode("utf-8")
        ).hexdigest()
        return messages

    def build_api_kwargs_extras(
        self,
        *,
        reasoning_config: dict | None = None,
        **context: Any,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        del reasoning_config
        session_id = str(context.get("session_id") or "").strip()
        model = str(context.get("model") or "").strip()
        self._assert_strict_route(
            model=model,
            base_url=context.get("base_url"),
        )
        messages_digest = str(
            getattr(self._request_state, "messages_digest", "")
        )
        headers: dict[str, str] = {}
        if session_id:
            headers["x-session-id"] = f"hermes:{session_id}"
        if messages_digest:
            material = "\0".join(
                ["cursor-gateway-v1", session_id, model, messages_digest]
            )
            headers["idempotency-key"] = hashlib.sha256(
                material.encode("utf-8")
            ).hexdigest()
        return {}, {"extra_headers": headers} if headers else {}


register_provider(CursorGatewayProfile())
