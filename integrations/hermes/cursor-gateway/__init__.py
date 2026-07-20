"""Hermes model-provider profile for the local Cursor Gateway CSAPI."""

from __future__ import annotations

import hashlib
import json
import threading
from typing import Any

from providers import register_provider
from providers.base import ProviderProfile


class CursorGatewayProfile(ProviderProfile):
    """Attach durable session and retry-idempotency headers to each turn."""

    def __init__(self) -> None:
        super().__init__(
            name="cursor-gateway",
            aliases=("csapi", "cursor_gateway"),
            display_name="Cursor Gateway",
            description="Local Cursor Gateway CSAPI (/v1) — runner-backed models",
            env_vars=("CURSOR_GATEWAY_CSAPI_KEY",),
            base_url="http://127.0.0.1:18080/v1",
            models_url="http://127.0.0.1:18080/v1/models",
            api_mode="chat_completions",
            auth_type="api_key",
            supports_health_check=True,
            default_aux_model="gpt-5-mini",
            fallback_models=(
                "auto",
                "gpt-5.6-sol",
                "gpt-5.4",
                "claude-sonnet-4-5",
                "hermes:default",
            ),
        )
        self._request_state = threading.local()

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
