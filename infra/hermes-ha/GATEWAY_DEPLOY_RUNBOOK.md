# Cursor Gateway controlled deployment

This runbook deploys an immutable artifact built from the recorded merge
commit; it never builds from `$HOME/hermes-ha`, a dirty checkout, or either
existing production Git tree. Production compose and secret-bearing
configuration remain at:

- compose: `/home/joel/cursor-gateway/infra/docker-compose.yml`
- environment: `/home/joel/cursor-gateway/.env` (`0600`)
- app container: `infra-app-1`, loopback port `127.0.0.1:18080`

Do not deploy the timeout/model code until its tests and config schema pass.

## 1. Capture a rollback point

```bash
set -euo pipefail
umask 077
release_id="$(date -u +%Y%m%dT%H%M%SZ)"
rollback="$HOME/.local/state/hermes-ha/rollbacks/$release_id"
install -d -m 700 "$rollback"

# Secret-bearing; keep local and never print or upload this file.
install -m 600 "$HOME/cursor-gateway/.env" "$rollback/gateway.env"

git -C "$HOME/cursor-gateway" rev-parse HEAD >"$rollback/git-head"
git -C "$HOME/cursor-gateway" status --porcelain=v1 >"$rollback/git-status"
docker inspect infra-app-1 \
  --format '{{.Image}} {{.Created}} {{.State.Health.Status}}' \
  >"$rollback/container-version"
docker image inspect infra-app:latest \
  --format '{{.Id}} {{.Created}}' >"$rollback/image-version"
sha256sum "$HOME/cursor-gateway/infra/docker-compose.yml" \
  >"$rollback/compose.sha256"

old_image="$(awk '{print $1}' "$rollback/image-version")"
docker tag "$old_image" "infra-app:rollback-$release_id"
```

The rollback directory and `infra-app:rollback-$release_id` are the rollback
point. They contain no prompt/token logs. `gateway.env` does contain secrets and
must remain mode `0600`.

## 2. Stage and preflight the new image

Unpack the reviewed source into a new immutable directory such as
`$HOME/releases/cursor-gateway-$release_id`; do not overwrite
`cursor-gateway` or `cursor-gateway-release`.

```bash
docker build \
  -t "infra-app:candidate-$release_id" \
  -f "$HOME/releases/cursor-gateway-$release_id/Dockerfile" \
  "$HOME/releases/cursor-gateway-$release_id"

docker run --rm \
  --env-file "$HOME/cursor-gateway/.env" \
  "infra-app:candidate-$release_id" \
  node -e "import('./apps/server/dist/config.js').then(()=>console.log('config-ok'))"
```

The preflight must print only `config-ok`; it must not print environment values.

## 3. Inject reviewed non-secret settings

Update `/home/joel/cursor-gateway/.env` atomically while preserving mode `0600`.
The pending application schema is expected to accept:

```dotenv
CSAPI_DEFAULT_MODEL=gpt-5.6-sol
CSAPI_MAX_CONCURRENCY_PER_KEY=6
RUNNER_MAX_CONCURRENT_JOBS=6
CSAPI_CALLER_WAIT_TIMEOUT_MS=1800000
CSAPI_QUEUE_TIMEOUT_MS=30000
CSAPI_IDLE_TIMEOUT_MS=120000
CSAPI_ABSOLUTE_TIMEOUT_MS=1740000
```

Remove the obsolete `CSAPI_RUN_TIMEOUT_MS` only after the candidate preflight
confirms the replacement schema. Before cutover, the model/provider guard must
also confirm that `gpt-5.6-sol` maps to the online Cursor Gateway provider and
does not fall back.

`RUNNER_MAX_CONCURRENT_JOBS` in the VPS app environment is a server-side gate;
it does not configure the real executor. The active executor is local
`runnerId=wsl-e2ee`, whose separate
`/home/dministrator/cursor-e2ee/apps/windows-runner/.env` must also contain:

```dotenv
RUNNER_MAX_CONCURRENT_JOBS=6
RUNNER_E2EE_ENABLED=true
RUNNER_LEGACY_ENABLED=true
```

Its shared-pool build exposes all six slots to legacy/CSAPI when E2EE is idle,
keeps at most one encrypted job active, and never exceeds six total jobs.
Back up that env and the runner source/dist before restarting its existing
WSL supervisor.

## 4. Controlled app-only cutover

Wait until the active run count is zero. PostgreSQL and Redis are not restarted.

```bash
docker tag "infra-app:candidate-$release_id" infra-app:latest
docker compose -f "$HOME/cursor-gateway/infra/docker-compose.yml" \
  up -d --no-build --no-deps --force-recreate app

for _ in $(seq 1 30); do
  status="$(docker inspect infra-app-1 --format '{{.State.Health.Status}}')"
  [ "$status" = healthy ] && break
  sleep 2
done
[ "$(docker inspect infra-app-1 --format '{{.State.Health.Status}}')" = healthy ]
curl -fsS http://127.0.0.1:18080/healthz >/dev/null
```

Run the authenticated model/config preflight and six-request smoke only after
the unauthenticated health check succeeds. The health payload must report one
runner identity, six total slots, and effective total six. Use the authenticated
`/validation/v1/runs/by-idempotency/...` and `/validation/v1/runs/...` routes
for lifecycle evidence; never query production tables with prompt/response
columns for acceptance output.

## 5. Roll back on any failed gate

```bash
install -m 600 "$rollback/gateway.env" "$HOME/cursor-gateway/.env"
docker tag "infra-app:rollback-$release_id" infra-app:latest
docker compose -f "$HOME/cursor-gateway/infra/docker-compose.yml" \
  up -d --no-build --no-deps --force-recreate app
curl -fsS http://127.0.0.1:18080/healthz >/dev/null
```

Do not delete the rollback tag or directory until the 24-hour observation
window has completed.
