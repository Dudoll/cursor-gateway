# Hermes Cursor Gateway provider

This Hermes provider targets `http://127.0.0.1:18080/v1` and pins production
routing to `cursor-gateway/gpt-5.6-sol`.

It supplies:

- durable `x-session-id` and idempotency headers;
- an opt-in request-time route, model, and exact one-runner/six-slot health
  guard;
- `strict_route_guard.py` for profile-local config, session, conversation,
  runtime, billing, and health validation;
- an explicit profile manifest for both `main` and `telegram2`.

## Protected profiles

Install a reviewed copy of `strict-route-profiles.example.json` as:

```text
$HOME/.config/hermes/strict-route-profiles.json
```

The shipped manifest protects:

- `main` at `$HOME/.hermes`, mapped to `hermes-gateway.service`;
- `telegram2` at `$HOME/.hermes/profiles/telegram2`, mapped to
  `hermes-gateway-telegram2.service`.

The guard uses only the selected manifest entry. Ambient `HERMES_HOME` cannot
redirect it to another profile. Nested-home ownership checks prevent main from
reading telegram2 state, and database routing entries are filtered by the
selected sessions-directory scope.

`resolved_roots` is the narrow allowlist for the canonical Hermes HA layout.
The path named by `config`, `state_db`, or `sessions` must still be lexically
inside that profile's `HERMES_HOME`; only its symlink target may resolve into
one of these account-local roots. Main permits the shared iCloud Hermes tree,
the HA local-trees directory, and the private runtime-secret directory.
Telegram2 permits only its own shared iCloud subtree in addition to its
resolved home. Broad roots and links into another protected profile fail
closed, including links swapped after startup.

Install this provider independently under both homes:

```text
$HERMES_HOME/plugins/model-providers/cursor-gateway/
```

Merge `config.main.strict.example.yaml` into main and
`config.telegram2.strict.example.yaml` into telegram2. Both routes must be:

```yaml
model:
  provider: cursor-gateway
  default: gpt-5.6-sol
  base_url: http://127.0.0.1:18080/v1
  api_mode: chat_completions
fallback_providers: []
```

`fallback_model` must be absent. Every `fallback_providers` occurrence must be
empty. The provider profile’s `fallback_models` tuple is only an offline model
catalog fallback and contains the same pinned model; it is not provider
failover.

Each protected profile also sets `providers.cursor-gateway.request_timeout_seconds`
to `1860`. Its systemd drop-in pins both `HERMES_API_TIMEOUT` and
`HERMES_STREAM_READ_TIMEOUT` to the same finite 31 minute budget. This exceeds
the Gateway's 30 minute queue/caller envelope while SSE heartbeats keep the
active socket observable.

## Manual preflight

```bash
python="$HOME/.hermes/hermes-agent/venv/bin/python"
guard="$HOME/cursor-gateway/integrations/hermes/cursor-gateway/strict_route_guard.py"
profiles="$HOME/.config/hermes/strict-route-profiles.json"

"$python" "$guard" preflight \
  --profile main \
  --profiles-file "$profiles" \
  --expected-service hermes-gateway.service \
  --expected-home "$HOME/.hermes" \
  --require-protected

"$python" "$guard" preflight \
  --profile telegram2 \
  --profiles-file "$profiles" \
  --expected-service hermes-gateway-telegram2.service \
  --expected-home "$HOME/.hermes/profiles/telegram2" \
  --require-protected
```

Each profile must have its own `.env` containing
`CURSOR_GATEWAY_CSAPI_KEY`. The guard reads no process-wide fallback key.

## Request-time protection

Strict request enforcement is enabled only by the matching gateway drop-in.
Each protected unit sets:

- `HERMES_STRICT_ROUTE_ENABLED=1`;
- matching active/expected profile names;
- matching actual/expected `HERMES_HOME`;
- the exact provider, model, base URL, and service identity.

An enabled profile fails closed if its profile or home environment disagrees.
An unrelated service without `HERMES_STRICT_ROUTE_ENABLED=1` is unaffected.

The instance watcher is
`hermes-strict-route-guard@<profile>.service`. Main and telegram2 bind to
different instances, so one profile’s drift cannot stop the other.

All guard events are JSON and identify the selected profile and mapped
service. Arbitrary observed route strings, credentials, response bodies, and
raw session IDs are never logged.

## Tests

```bash
python3 -m unittest discover \
  integrations/hermes/cursor-gateway -p 'test_*.py' -v
python3 -m compileall -q integrations/hermes/cursor-gateway
```

See `../PRODUCTION_CONTROLS.md` for complete `vps-dmit` installation,
verification, recovery, and enablement commands.
