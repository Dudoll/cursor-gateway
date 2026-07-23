# Hermes production controls

These files are non-secret deployment controls. They are not applied
automatically and do not connect to, restart, or modify `vps-dmit`.

## Protected production profiles

Both live gateway profiles are protected:

- `main`
  - `HERMES_HOME=$HOME/.hermes`
  - config: `$HOME/.hermes/config.yaml`
  - state: `$HOME/.hermes/state.db`
  - routing index: `$HOME/.hermes/sessions/sessions.json`
  - gateway: `hermes-gateway.service`
  - watcher: `hermes-strict-route-guard@main.service`
- `telegram2`
  - `HERMES_HOME=$HOME/.hermes/profiles/telegram2`
  - config: `$HOME/.hermes/profiles/telegram2/config.yaml`
  - state: `$HOME/.hermes/profiles/telegram2/state.db`
  - routing index:
    `$HOME/.hermes/profiles/telegram2/sessions/sessions.json`
  - gateway: `hermes-gateway-telegram2.service`
  - watcher: `hermes-strict-route-guard@telegram2.service`

`cursor-gateway/strict-route-profiles.example.json` is the authoritative
non-secret profile layout. Install a reviewed copy at
`$HOME/.config/hermes/strict-route-profiles.json`. The guard ignores ambient
`HERMES_HOME`; it resolves config, database, routing index, key file, and
service only from the selected manifest entry.

The shipped protected homes and services are unique. A selected config/state
path must remain lexically inside its own home and outside every more-specific
protected home. The profile-scoped `resolved_roots` allow only the canonical HA
symlink targets under the shared iCloud tree, local-trees storage, and private
runtime directory. Broad account/root paths and another profile's resolved
roots are rejected. Paths are re-resolved on every check, so a post-start
symlink swap also fails closed. This permits the intended nested telegram2 home
while preventing main from pointing into telegram2 or telegram2 from escaping
to main. Only other profiles' path boundaries are consulted; their route/config
drift cannot fail the selected profile. A profile declared with
`"protected": false` is skipped before any profile state is read. Production
preflight/watch commands add `--require-protected`, so changing main or
telegram2 to false fails closed rather than bypassing protection. For these two
names it also applies compiled default home/service expectations; the gateway
preflights pass those expectations explicitly.

## Route invariants

Merge the matching fragment into each profile without replacing Telegram,
tool, or unrelated gateway settings:

- main: `cursor-gateway/config.main.strict.example.yaml`
- telegram2: `cursor-gateway/config.telegram2.strict.example.yaml`

Both effective configs must contain:

```yaml
model:
  provider: cursor-gateway
  default: gpt-5.6-sol
  base_url: http://127.0.0.1:18080/v1
  api_mode: chat_completions
providers:
  cursor-gateway:
    request_timeout_seconds: 1860
fallback_providers: []
```

`fallback_model` must be absent at every level. `fallback_providers` must be
present at the root and every occurrence must be an empty list. Divergent
channel routes, persisted `/model` overrides, conversation overrides,
active-session runtime metadata, and non-auxiliary billing usage are rejected.

The Gateway server must use `CSAPI_DEFAULT_MODEL=gpt-5.6-sol`. An online
Windows/WSL runner must advertise `gpt-5.6-sol`; setting its
`DEFAULT_MODEL=gpt-5.6-sol` is recommended.

## Required environment

- Each protected home has its own private `.env` containing a non-empty
  `CURSOR_GATEWAY_CSAPI_KEY`.
- Each value is accepted by the Gateway server's `CSAPI_API_KEYS`.
- Gateway has `CSAPI_ENABLED=true` and
  `CSAPI_DEFAULT_MODEL=gpt-5.6-sol`.
- Gateway's caller wait is `1800000` ms. Both protected Hermes units set
  `HERMES_API_TIMEOUT=1860` and `HERMES_STREAM_READ_TIMEOUT=1860`, so the
  finite client budget exceeds the queue + 29 minute absolute run envelope.
- Gateway and the one active `wsl-e2ee` shared worker both use capacity `6`.
  `/health.capacity` must report one runner identity, six total slots, a
  per-key limit of six, and effective total six.
- Hermes Agent is `0.18.2` or a compatible build with
  `ProviderProfile.build_api_kwargs_extras(..., base_url=...)`.
- `$HOME/.hermes/hermes-agent/venv/bin/python` contains PyYAML.
- This repository is at `$HOME/cursor-gateway`. If not, update the paths in
  both strict drop-ins and the watcher template before installation.

The standalone guard reads the API key only from the selected profile's
`$HERMES_HOME/.env`; it does not fall back to a process-wide key. The gateway
units continue to obtain their provider key through their normal profile
environment.

## Profile and provider installation

Run from the repository root on `vps-dmit`. After both profiles are idle, stop
them before replacing provider files, then preserve both profiles:

```bash
set -euo pipefail
systemctl --user stop \
  hermes-gateway.service \
  hermes-gateway-telegram2.service

stamp="$(date -u +%Y%m%dT%H%M%SZ)"

for hermes_home in \
  "$HOME/.hermes" \
  "$HOME/.hermes/profiles/telegram2"
do
  backup="$hermes_home/backups/strict-route-$stamp"
  install -d -m 0700 "$backup"
  cp -a "$hermes_home/config.yaml" "$backup/config.yaml"
  if [ -d "$hermes_home/plugins/model-providers/cursor-gateway" ]; then
    cp -a \
      "$hermes_home/plugins/model-providers/cursor-gateway" \
      "$backup/"
  fi

  plugin_dir="$hermes_home/plugins/model-providers/cursor-gateway"
  install -d -m 0755 "$plugin_dir"
  install -m 0644 \
    integrations/hermes/cursor-gateway/__init__.py \
    "$plugin_dir/__init__.py"
  install -m 0644 \
    integrations/hermes/cursor-gateway/plugin.yaml \
    "$plugin_dir/plugin.yaml"
done

install -d -m 0700 "$HOME/.config/hermes"
install -m 0600 \
  integrations/hermes/cursor-gateway/strict-route-profiles.example.json \
  "$HOME/.config/hermes/strict-route-profiles.json"
```

Review the installed manifest before continuing. Do not copy either example
`config.yaml` over a live profile; merge only its route invariants.

## Preflight

Run both checks before restarting either gateway:

```bash
set -euo pipefail
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

Each check opens only its selected config, routing index, `.env`, and
`state.db`. `gateway_routing` rows are filtered by that profile's resolved
sessions-directory scope. A foreign scope is never parsed as the selected
profile.

The check fails closed on:

- manifest, service, home, config, provider, model, base URL, or fallback
  drift;
- divergent or incomplete session/conversation model overrides;
- active-session provider/model/base URL or fallback drift;
- non-auxiliary `session_model_usage` route drift;
- Gateway/runner health failure or any capacity value other than the strict
  one-identity/six-slot topology;
- absence of `gpt-5.6-sol` from either the health response or authenticated
  model catalog.

Do not edit `state.db` or `sessions.json` while Hermes is running. Clear an
obsolete override through `/new` or the normal session-reset flow, then rerun
the corresponding preflight.

## Machine-readable result

Every line is one JSON event with `profile`; protected checks also include the
mapped `service`. The guard never emits API keys, config records, request
bodies, message text, raw session IDs, or arbitrary observed route strings.
Divergent values and session IDs are represented only by short SHA-256
references.

Stable exit codes remain:

- `0`: valid or explicitly unprotected profile
- `20`: profile/config/policy drift
- `21`: persisted session/conversation override drift
- `22`: runtime/provider/billing/base URL drift
- `23`: Gateway, authentication, or runner health failure
- `24`: target model offline or unroutable
- `25`: dependency, database, or unexpected internal failure

## systemd installation

With both gateways still stopped, remove the legacy singleton watcher from the
earlier main-only control:

```bash
set -euo pipefail

systemctl --user disable --now \
  hermes-strict-route-guard.service 2>/dev/null || true
rm -f "$HOME/.config/systemd/user/hermes-strict-route-guard.service"

install -D -m 0644 \
  integrations/hermes/systemd/hermes-strict-route-guard@.service \
  "$HOME/.config/systemd/user/hermes-strict-route-guard@.service"

install -D -m 0644 \
  integrations/hermes/systemd/hermes-gateway.service.d/zz-resource-limits.conf \
  "$HOME/.config/systemd/user/hermes-gateway.service.d/zz-resource-limits.conf"
install -D -m 0644 \
  integrations/hermes/systemd/hermes-gateway.service.d/zz-strict-route.conf \
  "$HOME/.config/systemd/user/hermes-gateway.service.d/zz-strict-route.conf"

install -D -m 0644 \
  integrations/hermes/systemd/hermes-gateway-telegram2.service.d/zz-resource-limits.conf \
  "$HOME/.config/systemd/user/hermes-gateway-telegram2.service.d/zz-resource-limits.conf"
install -D -m 0644 \
  integrations/hermes/systemd/hermes-gateway-telegram2.service.d/zz-strict-route.conf \
  "$HOME/.config/systemd/user/hermes-gateway-telegram2.service.d/zz-strict-route.conf"

systemctl --user daemon-reload
systemd-analyze --user verify \
  hermes-gateway.service \
  hermes-gateway-telegram2.service \
  hermes-strict-route-guard@main.service \
  hermes-strict-route-guard@telegram2.service
```

The main drop-in binds only to `@main`; telegram2 binds only to `@telegram2`.
Each drop-in performs its own service, manifest-home, and effective
`HERMES_HOME` preflight. If one watcher exits on drift, `BindsTo=` stops only
that watcher’s gateway. The other gateway has no dependency on that instance.

Both gateway drop-ins and the watcher template set `Restart=no`. A failed
preflight or watcher therefore remains stopped instead of entering a restart
loop. `StopWhenUnneeded=yes` stops a healthy watcher when its gateway is
intentionally stopped.

After both preflights pass and both profiles are idle:

```bash
systemctl --user enable \
  hermes-gateway.service \
  hermes-gateway-telegram2.service

systemctl --user reset-failed \
  hermes-strict-route-guard@main.service \
  hermes-strict-route-guard@telegram2.service \
  hermes-gateway.service \
  hermes-gateway-telegram2.service

systemctl --user restart hermes-gateway.service
systemctl --user restart hermes-gateway-telegram2.service

systemctl --user --no-pager --full status \
  hermes-gateway.service \
  hermes-strict-route-guard@main.service \
  hermes-gateway-telegram2.service \
  hermes-strict-route-guard@telegram2.service
```

Inspect redacted guard events:

```bash
journalctl --user \
  -u hermes-strict-route-guard@main.service \
  -u hermes-strict-route-guard@telegram2.service \
  -n 100 --no-pager
```

After correcting one failed profile, reset and start only its pair. For
telegram2:

```bash
systemctl --user reset-failed \
  hermes-strict-route-guard@telegram2.service \
  hermes-gateway-telegram2.service
systemctl --user start hermes-gateway-telegram2.service
```

## Session and memory limits

Apply profile-local limits before restarting idle units:

```bash
HERMES_HOME="$HOME/.hermes" \
  hermes config set gateway.max_concurrent_sessions 2

HERMES_HOME="$HOME/.hermes/profiles/telegram2" \
  hermes --profile telegram2 config set gateway.max_concurrent_sessions 1
```

Main keeps `MemoryHigh=500M` / `MemoryMax=650M`; telegram2 keeps
`MemoryHigh=430M` / `MemoryMax=550M`. Both use `TasksMax=128` and
`OOMPolicy=stop`.

## Repository verification

Run from the repository root:

```bash
python3 -m unittest discover \
  integrations/hermes/cursor-gateway -p 'test_*.py' -v
python3 -m compileall -q integrations/hermes/cursor-gateway
python3 -m json.tool \
  integrations/hermes/cursor-gateway/strict-route-profiles.example.json \
  >/dev/null
systemd-analyze verify \
  integrations/hermes/systemd/hermes-strict-route-guard@.service
git diff --check -- integrations/hermes
```

These controls do not install or enable any Windows/WSL runner startup
mechanism.
