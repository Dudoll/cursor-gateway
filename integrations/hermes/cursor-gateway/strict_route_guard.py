#!/usr/bin/env python3
"""Fail-closed production routing checks for explicit Hermes profiles.

The selected profile manifest entry is the only source of filesystem scope.
The guard never logs API keys, request bodies, messages, or raw records.
"""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
import os
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urlsplit, urlunsplit


COMPONENT = "hermes-strict-route-guard"
DEFAULT_PROVIDER = "cursor-gateway"
DEFAULT_MODEL = "gpt-5.6-sol"
DEFAULT_BASE_URL = "http://127.0.0.1:18080/v1"
DEFAULT_API_KEY_ENV = "CURSOR_GATEWAY_CSAPI_KEY"
REQUIRED_EFFECTIVE_CAPACITY = 6
DEFAULT_PROFILES_FILE = (
    Path.home() / ".config" / "hermes" / "strict-route-profiles.json"
)
DEFAULT_PRODUCTION_SERVICES = {
    "main": "hermes-gateway.service",
    "telegram2": "hermes-gateway-telegram2.service",
}

EXIT_OK = 0
EXIT_CONFIG = 20
EXIT_SESSION = 21
EXIT_RUNTIME = 22
EXIT_HEALTH = 23
EXIT_MODEL_OFFLINE = 24
EXIT_INTERNAL = 25

MAX_JSON_BYTES = 64 * 1024 * 1024
MAX_HTTP_BYTES = 1024 * 1024
MAX_PROFILE_BYTES = 1024 * 1024
PROFILE_NAME_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")
SERVICE_NAME_PATTERN = re.compile(
    r"^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,127}\.service$"
)


class _RejectRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_HTTP_OPENER = urllib.request.build_opener(
    urllib.request.ProxyHandler({}), _RejectRedirects()
)


class GuardFailure(Exception):
    """A controlled failure with a stable process exit code."""

    def __init__(
        self,
        *,
        exit_code: int,
        code: str,
        check: str,
        message: str,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.exit_code = exit_code
        self.code = code
        self.check = check
        self.message = message
        self.details = details or {}


@dataclass(frozen=True)
class GuardPolicy:
    profile: str
    protected: bool
    hermes_home: Path
    config_path: Path
    state_db_path: Path
    sessions_path: Path
    service: str
    provider: str
    model: str
    base_url: str
    api_key_env: str
    timeout: float
    other_protected_homes: tuple[Path, ...] = ()

    @property
    def enabled(self) -> bool:
        return self.protected


def _utc_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def emit(
    *,
    event: str,
    status: str,
    code: str,
    exit_code: int,
    profile: str,
    service: str = "",
    check: str,
    message: str,
    details: dict[str, Any] | None = None,
) -> None:
    payload: dict[str, Any] = {
        "check": check,
        "code": code,
        "component": COMPONENT,
        "event": event,
        "exit_code": exit_code,
        "message": message,
        "profile": profile,
        "status": status,
        "timestamp": _utc_timestamp(),
    }
    if service:
        payload["service"] = service
    if details:
        payload["details"] = details
    stream = sys.stderr if status == "failed" else sys.stdout
    print(json.dumps(payload, ensure_ascii=True, sort_keys=True), file=stream, flush=True)


def _session_ref(value: Any) -> str:
    material = str(value or "unknown").encode("utf-8", errors="replace")
    return hashlib.sha256(material).hexdigest()[:12]


def normalize_base_url(value: Any) -> str:
    raw = str(value or "").strip()
    try:
        parsed = urlsplit(raw)
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


def _public_route_value(value: Any, expected: str, *, url: bool = False) -> str:
    """Render only expected values; hash every divergent value."""
    text = str(value or "").strip()
    if not text:
        return "(missing)"
    normalized = normalize_base_url(text) if url else text
    if normalized and normalized == expected:
        return expected
    material = (normalized or text).encode("utf-8", errors="replace")
    return f"sha256:{hashlib.sha256(material).hexdigest()[:12]}"


def _route_details(route: dict[str, Any], policy: GuardPolicy) -> dict[str, Any]:
    return {
        "expected": {
            "base_url": policy.base_url,
            "model": policy.model,
            "provider": policy.provider,
        },
        "observed": {
            "base_url": _public_route_value(
                route.get("base_url"), policy.base_url, url=True
            ),
            "model": _public_route_value(
                route.get("default") or route.get("model") or route.get("name"),
                policy.model,
            ),
            "provider": _public_route_value(
                route.get("provider"), policy.provider
            ),
        },
    }


def _validate_route(
    route: Any,
    policy: GuardPolicy,
    *,
    check: str,
    code: str,
    exit_code: int,
    require_complete: bool,
    session_id: Any = None,
) -> None:
    if not isinstance(route, dict):
        raise GuardFailure(
            exit_code=exit_code,
            code=code,
            check=check,
            message="route metadata is not a mapping",
            details={"session_ref": _session_ref(session_id)} if session_id else None,
        )

    provider = str(route.get("provider") or "").strip()
    model = str(
        route.get("default") or route.get("model") or route.get("name") or ""
    ).strip()
    base_url = normalize_base_url(route.get("base_url"))
    api_mode = str(route.get("api_mode") or "").strip()

    missing = []
    if require_complete and not provider:
        missing.append("provider")
    if require_complete and not model:
        missing.append("model")
    if require_complete and not base_url:
        missing.append("base_url")

    drift = bool(
        missing
        or (provider and provider != policy.provider)
        or (model and model != policy.model)
        or (base_url and base_url != policy.base_url)
        or (api_mode and api_mode != "chat_completions")
    )
    if not drift:
        return

    details = _route_details(route, policy)
    if missing:
        details["missing"] = sorted(missing)
    if session_id is not None:
        details["session_ref"] = _session_ref(session_id)
    raise GuardFailure(
        exit_code=exit_code,
        code=code,
        check=check,
        message="route differs from the strict production policy",
        details=details,
    )


def _unique_mapping(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON mapping key")
        result[key] = value
    return result


def _profile_failure(
    code: str,
    message: str,
    *,
    field: str | None = None,
) -> GuardFailure:
    details = {"field": field} if field else None
    return GuardFailure(
        exit_code=EXIT_CONFIG,
        code=code,
        check="scope",
        message=message,
        details=details,
    )


def _load_profile_document(path: Path) -> dict[str, Any]:
    try:
        if path.stat().st_size > MAX_PROFILE_BYTES:
            raise _profile_failure(
                "HSG_PROFILES_FILE_TOO_LARGE",
                "protected profile configuration exceeds the size limit",
            )
        with path.open("r", encoding="utf-8") as handle:
            loaded = json.load(handle, object_pairs_hook=_unique_mapping)
    except GuardFailure:
        raise
    except (OSError, TypeError, UnicodeError, ValueError) as exc:
        raise _profile_failure(
            "HSG_PROFILES_FILE_INVALID",
            "protected profile configuration is missing, unreadable, or invalid JSON",
        ) from exc
    if not isinstance(loaded, dict):
        raise _profile_failure(
            "HSG_PROFILES_FILE_INVALID",
            "protected profile configuration must be a JSON object",
        )
    if (
        type(loaded.get("schema_version")) is not int
        or loaded.get("schema_version") != 1
    ):
        raise _profile_failure(
            "HSG_PROFILES_SCHEMA_UNSUPPORTED",
            "protected profile configuration must use schema_version 1",
            field="schema_version",
        )
    profiles = loaded.get("profiles")
    if not isinstance(profiles, dict) or not profiles:
        raise _profile_failure(
            "HSG_PROFILES_INVALID",
            "protected profile configuration must define profiles",
            field="profiles",
        )
    return loaded


def _resolve_home(value: Any, *, profile: str) -> Path:
    if not isinstance(value, str) or not value.strip():
        raise _profile_failure(
            "HSG_PROFILE_HOME_INVALID",
            "a protected profile must define an absolute HERMES_HOME",
            field=f"profiles.{profile}.hermes_home",
        )
    raw = Path(value.strip()).expanduser()
    if not raw.is_absolute():
        raise _profile_failure(
            "HSG_PROFILE_HOME_INVALID",
            "a protected profile HERMES_HOME must be absolute or start with ~",
            field=f"profiles.{profile}.hermes_home",
        )
    return raw.resolve()


def _resolve_profile_path(
    value: Any,
    *,
    profile: str,
    field: str,
    hermes_home: Path,
) -> Path:
    if not isinstance(value, str) or not value.strip():
        raise _profile_failure(
            "HSG_PROFILE_PATH_INVALID",
            "a protected profile path is missing or invalid",
            field=f"profiles.{profile}.{field}",
        )
    raw = Path(value.strip()).expanduser()
    resolved = (raw if raw.is_absolute() else hermes_home / raw).resolve()
    try:
        resolved.relative_to(hermes_home)
    except ValueError as exc:
        raise _profile_failure(
            "HSG_PROFILE_PATH_ESCAPE",
            "a protected profile path escapes its HERMES_HOME",
            field=f"profiles.{profile}.{field}",
        ) from exc
    if resolved == hermes_home:
        raise _profile_failure(
            "HSG_PROFILE_PATH_INVALID",
            "a protected profile file path cannot equal HERMES_HOME",
            field=f"profiles.{profile}.{field}",
        )
    return resolved


def _parse_protected_profile(
    profile: str,
    value: dict[str, Any],
    *,
    timeout_override: float | None,
) -> GuardPolicy:
    allowed_fields = {
        "api_key_env",
        "base_url",
        "config",
        "health_timeout_seconds",
        "hermes_home",
        "model",
        "protected",
        "provider",
        "service",
        "sessions",
        "state_db",
    }
    unknown_fields = sorted(set(value) - allowed_fields)
    if unknown_fields:
        raise _profile_failure(
            "HSG_PROFILE_FIELD_UNKNOWN",
            "a protected profile contains unsupported fields",
            field=f"profiles.{profile}.<unknown>",
        )

    hermes_home = _resolve_home(value.get("hermes_home"), profile=profile)
    config_path = _resolve_profile_path(
        value.get("config"),
        profile=profile,
        field="config",
        hermes_home=hermes_home,
    )
    state_db_path = _resolve_profile_path(
        value.get("state_db"),
        profile=profile,
        field="state_db",
        hermes_home=hermes_home,
    )
    sessions_path = _resolve_profile_path(
        value.get("sessions"),
        profile=profile,
        field="sessions",
        hermes_home=hermes_home,
    )
    if len({config_path, state_db_path, sessions_path}) != 3:
        raise _profile_failure(
            "HSG_PROFILE_PATH_COLLISION",
            "config, state database, and sessions paths must be distinct",
            field=f"profiles.{profile}",
        )

    service = str(value.get("service") or "").strip()
    if not SERVICE_NAME_PATTERN.fullmatch(service):
        raise _profile_failure(
            "HSG_PROFILE_SERVICE_INVALID",
            "a protected profile must name one systemd service",
            field=f"profiles.{profile}.service",
        )

    route_fields = {
        "provider": (str(value.get("provider") or "").strip(), DEFAULT_PROVIDER),
        "model": (str(value.get("model") or "").strip(), DEFAULT_MODEL),
        "base_url": (normalize_base_url(value.get("base_url")), DEFAULT_BASE_URL),
        "api_key_env": (
            str(value.get("api_key_env") or "").strip(),
            DEFAULT_API_KEY_ENV,
        ),
    }
    for field, (observed, required) in route_fields.items():
        if observed != required:
            raise _profile_failure(
                "HSG_PROFILE_POLICY_DRIFT",
                "protected profiles must use the compiled strict route policy",
                field=f"profiles.{profile}.{field}",
            )

    raw_timeout = (
        timeout_override
        if timeout_override is not None
        else value.get("health_timeout_seconds")
    )
    if isinstance(raw_timeout, bool):
        raise _profile_failure(
            "HSG_POLICY_TIMEOUT_INVALID",
            "health probe timeout must be a positive number",
            field=f"profiles.{profile}.health_timeout_seconds",
        )
    try:
        timeout = float(raw_timeout)
    except (TypeError, ValueError) as exc:
        raise _profile_failure(
            "HSG_POLICY_TIMEOUT_INVALID",
            "health probe timeout must be a positive number",
            field=f"profiles.{profile}.health_timeout_seconds",
        ) from exc
    if timeout <= 0 or timeout > 30:
        raise _profile_failure(
            "HSG_POLICY_TIMEOUT_INVALID",
            "health probe timeout must be greater than zero and at most 30 seconds",
            field=f"profiles.{profile}.health_timeout_seconds",
        )

    return GuardPolicy(
        profile=profile,
        protected=True,
        hermes_home=hermes_home,
        config_path=config_path,
        state_db_path=state_db_path,
        sessions_path=sessions_path,
        service=service,
        provider=DEFAULT_PROVIDER,
        model=DEFAULT_MODEL,
        base_url=DEFAULT_BASE_URL,
        api_key_env=DEFAULT_API_KEY_ENV,
        timeout=timeout,
    )


def _lenient_protected_home(value: Any) -> Path | None:
    if not isinstance(value, dict) or value.get("protected") is not True:
        return None
    raw_value = value.get("hermes_home")
    if not isinstance(raw_value, str) or not raw_value.strip():
        return None
    raw_path = Path(raw_value.strip()).expanduser()
    if not raw_path.is_absolute():
        return None
    try:
        return raw_path.resolve()
    except (OSError, RuntimeError, ValueError):
        return None


def _validate_selected_isolation(
    policy: GuardPolicy, profile_values: dict[str, Any]
) -> tuple[Path, ...]:
    """Reserve other valid homes without validating their route/state policy.

    A provider/model/config drift in telegram2 must not make main fail (or the
    reverse). Only the non-selected profile's home boundary is consulted here.
    That boundary is needed to reject a selected path that crosses into a more
    specific nested profile.
    """
    other_homes: set[Path] = set()
    for other_name, other_value in profile_values.items():
        if other_name == policy.profile:
            continue
        other_home = _lenient_protected_home(other_value)
        if other_home is None:
            continue
        other_homes.add(other_home)
        if other_home == policy.hermes_home:
            raise _profile_failure(
                "HSG_PROFILE_HOME_COLLISION",
                "the selected profile shares HERMES_HOME with another profile",
                field=f"profiles.{policy.profile}.hermes_home",
            )
        if len(other_home.parts) <= len(policy.hermes_home.parts):
            continue
        for field, path in (
            ("config", policy.config_path),
            ("state_db", policy.state_db_path),
            ("sessions", policy.sessions_path),
        ):
            try:
                path.relative_to(other_home)
            except ValueError:
                continue
            raise _profile_failure(
                "HSG_PROFILE_SCOPE_VIOLATION",
                "a selected profile path belongs to another HERMES_HOME",
                field=f"profiles.{policy.profile}.{field}",
            )
    return tuple(sorted(other_homes, key=str))


def _current_profile_path(
    policy: GuardPolicy, path: Path, *, field: str
) -> Path:
    """Re-resolve profile paths so a later symlink swap fails closed."""
    try:
        resolved = path.resolve()
        resolved.relative_to(policy.hermes_home)
    except (OSError, RuntimeError, ValueError) as exc:
        raise _profile_failure(
            "HSG_PROFILE_PATH_ESCAPE",
            "a selected profile path escaped its HERMES_HOME",
            field=f"profiles.{policy.profile}.{field}",
        ) from exc
    for other_home in policy.other_protected_homes:
        if len(other_home.parts) <= len(policy.hermes_home.parts):
            continue
        try:
            resolved.relative_to(other_home)
        except ValueError:
            continue
        raise _profile_failure(
            "HSG_PROFILE_SCOPE_VIOLATION",
            "a selected profile path moved into another HERMES_HOME",
            field=f"profiles.{policy.profile}.{field}",
        )
    return resolved


def load_policy(
    *,
    profiles_file: Path,
    profile: str,
    expected_service: str,
    timeout_override: float | None,
    expected_home: Path | None = None,
    require_protected: bool = False,
) -> GuardPolicy:
    if not PROFILE_NAME_PATTERN.fullmatch(profile):
        raise _profile_failure(
            "HSG_PROFILE_NAME_INVALID",
            "profile name is missing or invalid",
            field="profile",
        )
    document = _load_profile_document(profiles_file)
    profile_values = document["profiles"]
    if profile not in profile_values:
        raise _profile_failure(
            "HSG_PROFILE_NOT_CONFIGURED",
            "profile is not explicitly configured",
            field=f"profiles.{profile}",
        )

    selected_value = profile_values[profile]
    if not isinstance(selected_value, dict) or not isinstance(
        selected_value.get("protected"), bool
    ):
        raise _profile_failure(
            "HSG_PROFILE_INVALID",
            "the selected profile must explicitly set protected to true or false",
            field=f"profiles.{profile}",
        )
    if not selected_value["protected"]:
        if require_protected:
            raise _profile_failure(
                "HSG_PROFILE_PROTECTION_REQUIRED",
                "the invoking service requires a protected production profile",
                field=f"profiles.{profile}.protected",
            )
        return GuardPolicy(
            profile=profile,
            protected=False,
            hermes_home=Path("/"),
            config_path=Path("/"),
            state_db_path=Path("/"),
            sessions_path=Path("/"),
            service="",
            provider=DEFAULT_PROVIDER,
            model=DEFAULT_MODEL,
            base_url=DEFAULT_BASE_URL,
            api_key_env=DEFAULT_API_KEY_ENV,
            timeout=3.0,
        )

    policy = _parse_protected_profile(
        profile, selected_value, timeout_override=timeout_override
    )
    policy = replace(
        policy,
        other_protected_homes=_validate_selected_isolation(
            policy, profile_values
        ),
    )
    if require_protected:
        if not expected_service:
            expected_service = DEFAULT_PRODUCTION_SERVICES.get(profile, "")
        if expected_home is None:
            if profile == "main":
                expected_home = Path.home() / ".hermes"
            elif profile == "telegram2":
                expected_home = (
                    Path.home() / ".hermes" / "profiles" / "telegram2"
                )
        if not expected_service or expected_home is None:
            raise _profile_failure(
                "HSG_PROFILE_EXPECTATION_REQUIRED",
                "a protected service must declare its expected home and service",
                field=f"profiles.{profile}",
            )
    if expected_home is not None:
        expected_home = expected_home.expanduser()
        if not expected_home.is_absolute():
            raise _profile_failure(
                "HSG_PROFILE_HOME_MISMATCH",
                "the invoking service expected an invalid HERMES_HOME",
                field=f"profiles.{profile}.hermes_home",
            )
        try:
            resolved_expected_home = expected_home.resolve()
        except (OSError, RuntimeError, ValueError) as exc:
            raise _profile_failure(
                "HSG_PROFILE_HOME_MISMATCH",
                "the invoking service expected an invalid HERMES_HOME",
                field=f"profiles.{profile}.hermes_home",
            ) from exc
        if resolved_expected_home != policy.hermes_home:
            raise _profile_failure(
                "HSG_PROFILE_HOME_MISMATCH",
                "the invoking service HERMES_HOME does not match the selected profile",
                field=f"profiles.{profile}.hermes_home",
            )
    if expected_service and expected_service != policy.service:
        raise _profile_failure(
            "HSG_PROFILE_SERVICE_MISMATCH",
            "the invoking gateway service does not match the selected profile",
            field=f"profiles.{profile}.service",
        )
    return policy


def _load_yaml_mapping(path: Path) -> dict[str, Any]:
    try:
        import yaml
    except ImportError as exc:
        try:
            with path.open("r", encoding="utf-8") as handle:
                loaded_json = json.load(handle, object_pairs_hook=_unique_mapping)
        except (OSError, TypeError, UnicodeError, ValueError):
            raise GuardFailure(
                exit_code=EXIT_INTERNAL,
                code="HSG_YAML_UNAVAILABLE",
                check="config",
                message="PyYAML is required for non-JSON config.yaml validation",
            ) from exc
        if not isinstance(loaded_json, dict):
            raise GuardFailure(
                exit_code=EXIT_CONFIG,
                code="HSG_CONFIG_INVALID",
                check="config",
                message="config.yaml must contain a top-level mapping",
            )
        return loaded_json

    class UniqueKeyLoader(yaml.SafeLoader):
        pass

    def construct_mapping(
        loader: Any, node: Any, deep: bool = False
    ) -> dict[str, Any]:
        loader.flatten_mapping(node)
        result: dict[str, Any] = {}
        for key_node, value_node in node.value:
            key = loader.construct_object(key_node, deep=deep)
            if key in result:
                raise ValueError("duplicate YAML mapping key")
            result[key] = loader.construct_object(value_node, deep=deep)
        return result

    UniqueKeyLoader.add_constructor(
        yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, construct_mapping
    )

    try:
        with path.open("r", encoding="utf-8") as handle:
            loaded = yaml.load(handle, Loader=UniqueKeyLoader)
    except (OSError, TypeError, ValueError, yaml.YAMLError) as exc:
        raise GuardFailure(
            exit_code=EXIT_CONFIG,
            code="HSG_CONFIG_UNREADABLE",
            check="config",
            message="config.yaml is missing, unreadable, duplicated, or invalid YAML",
        ) from exc
    if not isinstance(loaded, dict):
        raise GuardFailure(
            exit_code=EXIT_CONFIG,
            code="HSG_CONFIG_INVALID",
            check="config",
            message="config.yaml must contain a top-level mapping",
        )
    return loaded


def _validate_channel_routes(value: Any, policy: GuardPolicy) -> int:
    checked = 0
    if isinstance(value, dict):
        if any(key in value for key in ("provider", "model", "base_url", "api_mode")):
            _validate_route(
                value,
                policy,
                check="config",
                code="HSG_CHANNEL_ROUTE_DRIFT",
                exit_code=EXIT_CONFIG,
                require_complete=False,
            )
            checked += 1
        for child in value.values():
            checked += _validate_channel_routes(child, policy)
    elif isinstance(value, list):
        for child in value:
            checked += _validate_channel_routes(child, policy)
    return checked


def _validate_fallback_tree(value: Any, *, depth: int = 0) -> int:
    checked = 0
    if isinstance(value, dict):
        scope = "root" if depth == 0 else "nested"
        if "fallback_model" in value:
            raise GuardFailure(
                exit_code=EXIT_CONFIG,
                code="HSG_LEGACY_FALLBACK_FORBIDDEN",
                check="config",
                message="fallback_model is forbidden in a protected profile",
                details={"scope": scope},
            )
        if "fallback_providers" in value:
            providers = value.get("fallback_providers")
            if not isinstance(providers, list):
                raise GuardFailure(
                    exit_code=EXIT_CONFIG,
                    code="HSG_FALLBACK_INVALID",
                    check="config",
                    message="fallback_providers must be an empty list",
                    details={"scope": scope},
                )
            if providers:
                raise GuardFailure(
                    exit_code=EXIT_CONFIG,
                    code="HSG_FALLBACK_FORBIDDEN",
                    check="config",
                    message="fallback_providers must be empty in a protected profile",
                    details={
                        "fallback_count": len(providers),
                        "scope": scope,
                    },
                )
            checked += 1
        for child in value.values():
            checked += _validate_fallback_tree(child, depth=depth + 1)
    elif isinstance(value, list):
        for child in value:
            checked += _validate_fallback_tree(child, depth=depth + 1)
    return checked


def validate_config(policy: GuardPolicy) -> dict[str, int]:
    config_path = _current_profile_path(
        policy, policy.config_path, field="config"
    )
    config = _load_yaml_mapping(config_path)
    fallback_count = _validate_fallback_tree(config)
    if "fallback_providers" not in config:
        raise GuardFailure(
            exit_code=EXIT_CONFIG,
            code="HSG_FALLBACK_REQUIRED",
            check="config",
            message="fallback_providers: [] must be explicit in a protected profile",
        )

    model_config = config.get("model")
    _validate_route(
        model_config,
        policy,
        check="config",
        code="HSG_CONFIG_ROUTE_DRIFT",
        exit_code=EXIT_CONFIG,
        require_complete=True,
    )
    if not isinstance(model_config, dict) or "default" not in model_config:
        raise GuardFailure(
            exit_code=EXIT_CONFIG,
            code="HSG_DEFAULT_MODEL_REQUIRED",
            check="config",
            message="model.default must explicitly name the strict production model",
        )
    conflicting_aliases = sorted(
        key
        for key in ("model", "name")
        if model_config.get(key) not in (None, "", policy.model)
    )
    if conflicting_aliases:
        raise GuardFailure(
            exit_code=EXIT_CONFIG,
            code="HSG_MODEL_ALIAS_DRIFT",
            check="config",
            message="alternate model keys conflict with model.default",
            details={"conflicting_keys": conflicting_aliases},
        )

    root_route = {
        key: config.get(key)
        for key in ("provider", "base_url", "api_mode")
        if config.get(key) not in (None, "")
    }
    if root_route:
        _validate_route(
            root_route,
            policy,
            check="config",
            code="HSG_ROOT_ROUTE_DRIFT",
            exit_code=EXIT_CONFIG,
            require_complete=False,
        )

    channel_count = _validate_channel_routes(
        config.get("channel_overrides", {}), policy
    )
    return {
        "channel_routes_checked": channel_count,
        "fallback_lists_checked": fallback_count,
    }


def _load_json_file(path: Path) -> Any:
    try:
        if path.stat().st_size > MAX_JSON_BYTES:
            raise GuardFailure(
                exit_code=EXIT_SESSION,
                code="HSG_SESSION_STATE_TOO_LARGE",
                check="session",
                message="session routing metadata exceeds the guard size limit",
            )
        with path.open("r", encoding="utf-8") as handle:
            return json.load(handle)
    except GuardFailure:
        raise
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise GuardFailure(
            exit_code=EXIT_SESSION,
            code="HSG_SESSION_STATE_INVALID",
            check="session",
            message="session routing metadata is unreadable or invalid JSON",
        ) from exc


def _inspect_override_tree(
    value: Any,
    policy: GuardPolicy,
    *,
    inherited_session_id: Any = None,
) -> tuple[int, set[str]]:
    checked = 0
    session_ids: set[str] = set()
    if isinstance(value, dict):
        session_id = value.get("session_id", inherited_session_id)
        if session_id not in (None, ""):
            session_ids.add(str(session_id))

        direct_model = (
            value.get("default")
            or value.get("model")
            or value.get("name")
        )
        direct_provider = value.get("provider") or value.get("model_provider")
        if direct_model not in (None, "") and (
            direct_provider not in (None, "")
            or value.get("base_url") not in (None, "")
        ):
            direct_route = dict(value)
            if "provider" not in direct_route and direct_provider not in (None, ""):
                direct_route["provider"] = direct_provider
            _validate_route(
                direct_route,
                policy,
                check="session",
                code="HSG_SESSION_ROUTE_DRIFT",
                exit_code=EXIT_SESSION,
                require_complete=True,
                session_id=session_id,
            )
            checked += 1

        override_keys = {
            key
            for key in value
            if key == "model_override" or key.endswith("_model_override")
        }
        for key in sorted(override_keys):
            override = value.get(key)
            if override in (None, {}):
                continue
            _validate_route(
                override,
                policy,
                check="session",
                code="HSG_SESSION_ROUTE_DRIFT",
                exit_code=EXIT_SESSION,
                require_complete=True,
                session_id=session_id,
            )
            checked += 1

        for key, child in value.items():
            if key in override_keys:
                continue
            child_checked, child_ids = _inspect_override_tree(
                child, policy, inherited_session_id=session_id
            )
            checked += child_checked
            session_ids.update(child_ids)
    elif isinstance(value, list):
        for child in value:
            child_checked, child_ids = _inspect_override_tree(
                child, policy, inherited_session_id=inherited_session_id
            )
            checked += child_checked
            session_ids.update(child_ids)
    return checked, session_ids


def validate_sessions_file(policy: GuardPolicy) -> tuple[dict[str, int], set[str]]:
    sessions_path = _current_profile_path(
        policy, policy.sessions_path, field="sessions"
    )
    if not sessions_path.exists():
        return {"session_overrides_checked": 0}, set()
    value = _load_json_file(sessions_path)
    checked, session_ids = _inspect_override_tree(value, policy)
    return {"session_overrides_checked": checked}, session_ids


def _table_columns(connection: sqlite3.Connection, table: str) -> set[str]:
    return {
        str(row[1])
        for row in connection.execute(f'PRAGMA table_info("{table}")').fetchall()
    }


def _parse_database_json(value: Any, *, session_id: Any) -> Any:
    if value in (None, ""):
        return None
    try:
        return json.loads(str(value))
    except (TypeError, ValueError) as exc:
        raise GuardFailure(
            exit_code=EXIT_RUNTIME,
            code="HSG_RUNTIME_METADATA_INVALID",
            check="runtime",
            message="runtime route metadata in state.db is invalid JSON",
            details={"session_ref": _session_ref(session_id)},
        ) from exc


def _validate_runtime_route(
    *,
    policy: GuardPolicy,
    session_id: Any,
    model: Any,
    provider: Any,
    base_url: Any,
    api_calls: Any,
    source: str,
) -> None:
    calls = 0
    try:
        calls = int(api_calls or 0)
    except (TypeError, ValueError):
        calls = 0

    route = {
        "model": str(model or "").strip(),
        "provider": str(provider or "").strip(),
        "base_url": str(base_url or "").strip(),
    }
    require_complete = calls > 0
    try:
        _validate_route(
            route,
            policy,
            check="runtime",
            code="HSG_RUNTIME_ROUTE_DRIFT",
            exit_code=EXIT_RUNTIME,
            require_complete=require_complete,
            session_id=session_id,
        )
    except GuardFailure as failure:
        failure.details["source"] = source
        raise


def _inspect_runtime_metadata(
    value: Any,
    policy: GuardPolicy,
    *,
    session_id: Any,
    source: str,
) -> int:
    checked = 0
    if isinstance(value, dict):
        for key, child in value.items():
            if (
                key in {"gateway_runtime", "runtime_route"}
                or key == "model_override"
                or key.endswith("_model_override")
            ) and child not in (None, {}) and not isinstance(child, dict):
                raise GuardFailure(
                    exit_code=EXIT_RUNTIME,
                    code="HSG_RUNTIME_METADATA_INVALID",
                    check="runtime",
                    message="runtime route metadata is not a mapping",
                    details={
                        "session_ref": _session_ref(session_id),
                        "source": source,
                    },
                )
        if bool(value.get("fallback_active")):
            raise GuardFailure(
                exit_code=EXIT_RUNTIME,
                code="HSG_RUNTIME_FALLBACK_ACTIVE",
                check="runtime",
                message="an active session reports provider fallback",
                details={
                    "session_ref": _session_ref(session_id),
                    "source": source,
                },
            )

        route_keys = {"provider", "base_url", "api_mode"}
        has_route = bool(route_keys.intersection(value))
        has_model = any(
            value.get(key) not in (None, "")
            for key in ("default", "model", "name")
        )
        if has_route or has_model:
            try:
                _validate_route(
                    value,
                    policy,
                    check="runtime",
                    code="HSG_RUNTIME_ROUTE_DRIFT",
                    exit_code=EXIT_RUNTIME,
                    require_complete=False,
                    session_id=session_id,
                )
            except GuardFailure as failure:
                failure.details["source"] = source
                raise
            checked += 1

        for child in value.values():
            checked += _inspect_runtime_metadata(
                child,
                policy,
                session_id=session_id,
                source=source,
            )
    elif isinstance(value, list):
        for child in value:
            checked += _inspect_runtime_metadata(
                child,
                policy,
                session_id=session_id,
                source=source,
            )
    return checked


def _select_rows(
    connection: sqlite3.Connection,
    table: str,
    wanted: Iterable[str],
    *,
    where: str = "",
    parameters: Iterable[Any] = (),
) -> tuple[list[str], list[sqlite3.Row]]:
    columns = _table_columns(connection, table)
    selected = [name for name in wanted if name in columns]
    if not selected:
        return [], []
    sql_columns = ", ".join(f'"{name}"' for name in selected)
    query = f'SELECT {sql_columns} FROM "{table}"'
    if where:
        query = f"{query} WHERE {where}"
    rows = connection.execute(query, tuple(parameters)).fetchall()
    return selected, rows


def validate_state_db(
    policy: GuardPolicy, file_session_ids: set[str]
) -> dict[str, int]:
    state_db_path = _current_profile_path(
        policy, policy.state_db_path, field="state_db"
    )
    if not state_db_path.exists():
        return {
            "billing_routes_checked": 0,
            "database_sessions_checked": 0,
            "database_overrides_checked": 0,
            "runtime_metadata_checked": 0,
        }

    try:
        uri = f"{state_db_path.as_uri()}?mode=ro"
        connection = sqlite3.connect(uri, uri=True, timeout=5.0)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA query_only = ON")
    except sqlite3.Error as exc:
        raise GuardFailure(
            exit_code=EXIT_INTERNAL,
            code="HSG_STATE_DB_UNREADABLE",
            check="runtime",
            message="state.db could not be opened read-only",
        ) from exc

    counts = {
        "billing_routes_checked": 0,
        "database_sessions_checked": 0,
        "database_overrides_checked": 0,
        "runtime_metadata_checked": 0,
    }
    active_ids = set(file_session_ids)
    try:
        current_sessions_path = _current_profile_path(
            policy, policy.sessions_path, field="sessions"
        )
        tables = {
            str(row[0])
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            ).fetchall()
        }
        routing_authoritative = (
            "gateway_routing" in tables or current_sessions_path.exists()
        )

        if "gateway_routing" in tables:
            routing_columns = _table_columns(connection, "gateway_routing")
            required_columns = {"scope", "session_key", "entry_json"}
            if not required_columns.issubset(routing_columns):
                raise GuardFailure(
                    exit_code=EXIT_RUNTIME,
                    code="HSG_ROUTING_SCOPE_INVALID",
                    check="runtime",
                    message="gateway routing metadata lacks profile scope columns",
                )
            routing_scope = str(current_sessions_path.parent.resolve())
            _, rows = _select_rows(
                connection,
                "gateway_routing",
                ("session_key", "entry_json"),
                where='"scope" = ?',
                parameters=(routing_scope,),
            )
            for row in rows:
                raw = row["entry_json"] if "entry_json" in row.keys() else None
                parsed = _parse_database_json(
                    raw,
                    session_id=row["session_key"]
                    if "session_key" in row.keys()
                    else None,
                )
                checked, found_ids = _inspect_override_tree(parsed, policy)
                counts["database_overrides_checked"] += checked
                active_ids.update(found_ids)

        if "sessions" in tables:
            candidate_ids = set(active_ids)
            validated_active_ids: set[str] = set()
            wanted = (
                "id",
                "ended_at",
                "model",
                "model_config",
                "billing_provider",
                "billing_base_url",
                "api_call_count",
                "message_count",
            )
            session_columns = _table_columns(connection, "sessions")
            required_session_columns = {
                "id",
                "model",
                "model_config",
                "billing_provider",
                "billing_base_url",
            }
            if not required_session_columns.issubset(session_columns):
                raise GuardFailure(
                    exit_code=EXIT_RUNTIME,
                    code="HSG_RUNTIME_SCHEMA_INVALID",
                    check="runtime",
                    message="sessions table lacks required route metadata columns",
                )
            session_where = (
                '"ended_at" IS NULL' if "ended_at" in session_columns else ""
            )
            if routing_authoritative and not candidate_ids:
                rows = []
            else:
                _, rows = _select_rows(
                    connection, "sessions", wanted, where=session_where
                )
            for row in rows:
                session_id = row["id"] if "id" in row.keys() else ""
                if "ended_at" in row.keys() and row["ended_at"] is not None:
                    continue
                if candidate_ids and str(session_id) not in candidate_ids:
                    continue
                validated_active_ids.add(str(session_id))
                calls = (
                    row["api_call_count"]
                    if "api_call_count" in row.keys()
                    else row["message_count"]
                    if "message_count" in row.keys()
                    else 0
                )
                _validate_runtime_route(
                    policy=policy,
                    session_id=session_id,
                    model=row["model"] if "model" in row.keys() else None,
                    provider=(
                        row["billing_provider"]
                        if "billing_provider" in row.keys()
                        else None
                    ),
                    base_url=(
                        row["billing_base_url"]
                        if "billing_base_url" in row.keys()
                        else None
                    ),
                    api_calls=calls,
                    source="sessions",
                )
                counts["database_sessions_checked"] += 1

                model_config = (
                    _parse_database_json(row["model_config"], session_id=session_id)
                    if "model_config" in row.keys()
                    else None
                )
                if isinstance(model_config, dict):
                    counts["runtime_metadata_checked"] += _inspect_runtime_metadata(
                        model_config,
                        policy,
                        session_id=session_id,
                        source="sessions.model_config",
                    )
                elif model_config is not None:
                    raise GuardFailure(
                        exit_code=EXIT_RUNTIME,
                        code="HSG_RUNTIME_METADATA_INVALID",
                        check="runtime",
                        message="runtime model metadata is not a mapping",
                        details={"session_ref": _session_ref(session_id)},
                    )
            active_ids = validated_active_ids

        if "session_model_usage" in tables:
            usage_columns = _table_columns(connection, "session_model_usage")
            required_usage_columns = {
                "session_id",
                "model",
                "billing_provider",
                "billing_base_url",
                "api_call_count",
            }
            if not required_usage_columns.issubset(usage_columns):
                raise GuardFailure(
                    exit_code=EXIT_RUNTIME,
                    code="HSG_RUNTIME_SCHEMA_INVALID",
                    check="runtime",
                    message="usage table lacks required route metadata columns",
                )
            wanted = (
                "session_id",
                "model",
                "billing_provider",
                "billing_base_url",
                "api_call_count",
                "task",
            )
            if not active_ids:
                rows = []
            else:
                placeholders = ", ".join("?" for _ in active_ids)
                _, rows = _select_rows(
                    connection,
                    "session_model_usage",
                    wanted,
                    where=f'"session_id" IN ({placeholders})',
                    parameters=sorted(active_ids),
                )
            for row in rows:
                session_id = (
                    str(row["session_id"])
                    if "session_id" in row.keys()
                    else ""
                )
                if not active_ids or session_id not in active_ids:
                    continue
                if "task" in row.keys() and str(row["task"] or "").strip():
                    continue
                calls = row["api_call_count"] if "api_call_count" in row.keys() else 0
                if not calls:
                    continue
                _validate_runtime_route(
                    policy=policy,
                    session_id=session_id,
                    model=row["model"] if "model" in row.keys() else None,
                    provider=(
                        row["billing_provider"]
                        if "billing_provider" in row.keys()
                        else None
                    ),
                    base_url=(
                        row["billing_base_url"]
                        if "billing_base_url" in row.keys()
                        else None
                    ),
                    api_calls=calls,
                    source="session_model_usage",
                )
                counts["billing_routes_checked"] += 1
    except GuardFailure:
        raise
    except sqlite3.Error as exc:
        raise GuardFailure(
            exit_code=EXIT_INTERNAL,
            code="HSG_STATE_DB_QUERY_FAILED",
            check="runtime",
            message="state.db routing checks could not complete",
        ) from exc
    finally:
        connection.close()
    return counts


def _dotenv_value(path: Path, key: str) -> str:
    found: str | None = None
    try:
        with path.open("r", encoding="utf-8") as handle:
            for raw_line in handle:
                line = raw_line.strip()
                if not line or line.startswith("#"):
                    continue
                if line.startswith("export "):
                    line = line[7:].lstrip()
                name, separator, raw_value = line.partition("=")
                if not separator or name.strip() != key:
                    continue
                if found is not None:
                    return ""
                value = raw_value.strip()
                if (
                    len(value) >= 2
                    and value[0] == value[-1]
                    and value[0] in {"'", '"'}
                ):
                    try:
                        decoded = ast.literal_eval(value)
                        found = (
                            str(decoded) if isinstance(decoded, str) else ""
                        )
                    except (SyntaxError, ValueError):
                        return ""
                else:
                    found = value
    except (OSError, UnicodeError):
        return ""
    return found or ""


def _api_key(policy: GuardPolicy) -> str:
    dotenv_path = _current_profile_path(
        policy, policy.hermes_home / ".env", field=".env"
    )
    token = _dotenv_value(
        dotenv_path, policy.api_key_env
    ).strip()
    if token:
        return token
    raise GuardFailure(
        exit_code=EXIT_HEALTH,
        code="HSG_HEALTH_AUTH_MISSING",
        check="health",
        message="the selected profile lacks its authenticated model probe key",
    )


def _request_json(
    url: str, *, timeout: float, api_key: str | None = None
) -> Any:
    headers = {
        "Accept": "application/json",
        "User-Agent": f"{COMPONENT}/1",
    }
    if api_key:
        headers["X-API-Key"] = api_key
    request = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with _HTTP_OPENER.open(request, timeout=timeout) as response:
            payload = response.read(MAX_HTTP_BYTES + 1)
    except urllib.error.HTTPError as exc:
        raise GuardFailure(
            exit_code=EXIT_HEALTH,
            code=(
                "HSG_HEALTH_AUTH_FAILED"
                if exc.code in {401, 403}
                else "HSG_HEALTH_HTTP_FAILED"
            ),
            check="health",
            message="Cursor Gateway health probe returned an error",
            details={"http_status": int(exc.code)},
        ) from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise GuardFailure(
            exit_code=EXIT_HEALTH,
            code="HSG_HEALTH_UNREACHABLE",
            check="health",
            message="Cursor Gateway health probe is unreachable",
        ) from exc
    if len(payload) > MAX_HTTP_BYTES:
        raise GuardFailure(
            exit_code=EXIT_HEALTH,
            code="HSG_HEALTH_RESPONSE_TOO_LARGE",
            check="health",
            message="Cursor Gateway health response exceeds the guard size limit",
        )
    try:
        return json.loads(payload.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise GuardFailure(
            exit_code=EXIT_HEALTH,
            code="HSG_HEALTH_RESPONSE_INVALID",
            check="health",
            message="Cursor Gateway health response is not valid JSON",
        ) from exc


def _health_urls(base_url: str) -> tuple[str, str]:
    parsed = urlsplit(base_url)
    path = parsed.path.rstrip("/")
    root_path = path[:-3] if path.endswith("/v1") else path
    health_path = f"{root_path}/health" if root_path else "/health"
    health_url = urlunsplit(
        (parsed.scheme, parsed.netloc, health_path, "", "")
    )
    models_url = f"{base_url.rstrip('/')}/models"
    return health_url, models_url


def _model_ids(payload: Any) -> set[str]:
    if not isinstance(payload, dict):
        return set()
    data = payload.get("data")
    if not isinstance(data, list):
        return set()
    return {
        str(item.get("id"))
        for item in data
        if isinstance(item, dict) and item.get("id") not in (None, "")
    }


def _capacity_value(value: Any) -> int | None:
    if type(value) is not int or value < 0 or value > 10_000:
        return None
    return value


def validate_health(policy: GuardPolicy) -> dict[str, int]:
    health_url, models_url = _health_urls(policy.base_url)
    health = _request_json(health_url, timeout=policy.timeout)
    if not isinstance(health, dict) or health.get("ok") is not True:
        raise GuardFailure(
            exit_code=EXIT_HEALTH,
            code="HSG_RUNNER_UNHEALTHY",
            check="health",
            message="Cursor Gateway did not report a healthy CSAPI service",
        )
    try:
        runners_online = int(health.get("runnersOnline", 0))
    except (TypeError, ValueError):
        runners_online = 0
    if runners_online < 1:
        raise GuardFailure(
            exit_code=EXIT_HEALTH,
            code="HSG_RUNNER_OFFLINE",
            check="health",
            message="no Cursor Gateway runner is online",
            details={"runners_online": runners_online},
        )

    capacity = health.get("capacity")
    expected_capacity = {
        "effectiveTotal": REQUIRED_EFFECTIVE_CAPACITY,
        "maxConcurrencyPerKey": REQUIRED_EFFECTIVE_CAPACITY,
        "runnerIdentities": 1,
        "totalRunnerSlots": REQUIRED_EFFECTIVE_CAPACITY,
    }
    observed_capacity = {
        key: _capacity_value(capacity.get(key))
        if isinstance(capacity, dict)
        else None
        for key in expected_capacity
    }
    if any(
        observed_capacity[key] != expected
        for key, expected in expected_capacity.items()
    ):
        raise GuardFailure(
            exit_code=EXIT_HEALTH,
            code="HSG_CAPACITY_DRIFT",
            check="health",
            message="Cursor Gateway execution capacity is not exactly six",
            details={
                "expected": expected_capacity,
                "observed": observed_capacity,
            },
        )

    advertised = health.get("models")
    health_models = (
        {str(item) for item in advertised if item not in (None, "")}
        if isinstance(advertised, list)
        else set()
    )
    if policy.model not in health_models:
        raise GuardFailure(
            exit_code=EXIT_MODEL_OFFLINE,
            code="HSG_TARGET_MODEL_OFFLINE",
            check="health",
            message="the strict target model is not advertised by an online runner",
            details={"model": policy.model, "runners_online": runners_online},
        )

    catalog = _request_json(
        models_url, timeout=policy.timeout, api_key=_api_key(policy)
    )
    if policy.model not in _model_ids(catalog):
        raise GuardFailure(
            exit_code=EXIT_MODEL_OFFLINE,
            code="HSG_TARGET_MODEL_UNROUTABLE",
            check="health",
            message="the authenticated model catalog does not contain the strict target",
            details={"model": policy.model, "runners_online": runners_online},
        )
    return {
        "effective_capacity": observed_capacity["effectiveTotal"]
        or 0,
        "runner_identities": observed_capacity["runnerIdentities"]
        or 0,
        "runners_online": runners_online,
        "total_runner_slots": observed_capacity["totalRunnerSlots"]
        or 0,
    }


def run_checks(policy: GuardPolicy) -> dict[str, Any]:
    config_counts = validate_config(policy)
    session_counts, file_session_ids = validate_sessions_file(policy)
    database_counts = validate_state_db(policy, file_session_ids)
    health_counts = validate_health(policy)
    return {
        **config_counts,
        **session_counts,
        **database_counts,
        **health_counts,
        "base_url": policy.base_url,
        "model": policy.model,
        "provider": policy.provider,
    }


def _common_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--profile", required=True)
    parser.add_argument(
        "--profiles-file",
        type=Path,
        default=Path(
            os.environ.get("HERMES_STRICT_ROUTE_PROFILES_FILE")
            or DEFAULT_PROFILES_FILE
        ),
    )
    parser.add_argument(
        "--expected-service",
        default=os.environ.get("HERMES_STRICT_ROUTE_EXPECTED_SERVICE", ""),
    )
    parser.add_argument(
        "--expected-home",
        type=Path,
        default=(
            Path(os.environ["HERMES_STRICT_ROUTE_EXPECTED_HOME"])
            if os.environ.get("HERMES_STRICT_ROUTE_EXPECTED_HOME")
            else None
        ),
    )
    parser.add_argument("--require-protected", action="store_true")
    parser.add_argument("--check-environment-home", action="store_true")
    parser.add_argument("--timeout", type=float)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Validate and monitor strict Hermes cursor-gateway routing"
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    for command in ("preflight", "runtime"):
        child = subparsers.add_parser(command)
        _common_arguments(child)
    watch = subparsers.add_parser("watch")
    _common_arguments(watch)
    watch.add_argument("--interval", type=float, default=5.0)
    watch.add_argument("--heartbeat-seconds", type=float, default=300.0)
    return parser


def _policy_from_args(args: argparse.Namespace) -> GuardPolicy:
    policy = load_policy(
        profiles_file=args.profiles_file.expanduser().resolve(),
        profile=str(args.profile).strip(),
        expected_service=str(args.expected_service or "").strip(),
        timeout_override=args.timeout,
        expected_home=args.expected_home,
        require_protected=bool(args.require_protected),
    )
    if args.check_environment_home:
        raw_environment_home = str(os.environ.get("HERMES_HOME") or "").strip()
        try:
            environment_home = Path(raw_environment_home).expanduser()
            matches = bool(
                raw_environment_home
                and environment_home.is_absolute()
                and environment_home.resolve() == policy.hermes_home
            )
        except (OSError, RuntimeError, ValueError):
            matches = False
        if not matches:
            raise _profile_failure(
                "HSG_PROFILE_HOME_MISMATCH",
                "the gateway environment HERMES_HOME does not match its profile",
                field=f"profiles.{policy.profile}.hermes_home",
            )
    return policy


def _execute_once(policy: GuardPolicy, phase: str, *, emit_success: bool) -> int:
    try:
        details = run_checks(policy)
    except GuardFailure as failure:
        emit(
            event="guard.failed",
            status="failed",
            code=failure.code,
            exit_code=failure.exit_code,
            profile=policy.profile,
            service=policy.service,
            check=failure.check,
            message=failure.message,
            details=failure.details,
        )
        return failure.exit_code
    except Exception as exc:
        emit(
            event="guard.failed",
            status="failed",
            code="HSG_INTERNAL_ERROR",
            exit_code=EXIT_INTERNAL,
            profile=policy.profile,
            service=policy.service,
            check="internal",
            message="strict route guard failed closed on an unexpected error",
            details={"exception_type": type(exc).__name__},
        )
        return EXIT_INTERNAL

    if emit_success:
        emit(
            event="guard.passed",
            status="ok",
            code="HSG_OK",
            exit_code=EXIT_OK,
            profile=policy.profile,
            service=policy.service,
            check=phase,
            message="strict production route is valid and routable",
            details=details,
        )
    return EXIT_OK


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        policy = _policy_from_args(args)
    except GuardFailure as failure:
        emit(
            event="guard.failed",
            status="failed",
            code=failure.code,
            exit_code=failure.exit_code,
            profile=str(getattr(args, "profile", "")),
            check=failure.check,
            message=failure.message,
            details=failure.details,
        )
        return failure.exit_code

    if not policy.enabled:
        emit(
            event="guard.skipped",
            status="skipped",
            code="HSG_PROFILE_NOT_ENFORCED",
            exit_code=EXIT_OK,
            profile=policy.profile,
            check="scope",
            message="profile is intentionally outside the strict production scope",
            details={"protected": False},
        )
        return EXIT_OK

    if args.command != "watch":
        return _execute_once(policy, args.command, emit_success=True)

    if args.interval <= 0 or args.heartbeat_seconds <= 0:
        emit(
            event="guard.failed",
            status="failed",
            code="HSG_WATCH_INTERVAL_INVALID",
            exit_code=EXIT_CONFIG,
            profile=policy.profile,
            service=policy.service,
            check="policy",
            message="watch intervals must be positive",
        )
        return EXIT_CONFIG

    first = True
    last_heartbeat = 0.0
    while True:
        now = time.monotonic()
        should_emit = first or now - last_heartbeat >= args.heartbeat_seconds
        result = _execute_once(policy, "runtime", emit_success=should_emit)
        if result != EXIT_OK:
            return result
        if should_emit:
            last_heartbeat = now
        first = False
        try:
            time.sleep(args.interval)
        except KeyboardInterrupt:
            return EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
