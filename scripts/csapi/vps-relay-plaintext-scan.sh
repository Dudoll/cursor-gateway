#!/usr/bin/env bash
# VPS relay-P2 acceptance: ciphertext round-trip plus DB/Redis/WAL/log plaintext scan.
# Generates the canary at runtime and never prints it.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APP_CONTAINER="${APP_CONTAINER:-infra-app-1}"
PG_CONTAINER="${PG_CONTAINER:-infra-postgres-1}"
REDIS_CONTAINER="${REDIS_CONTAINER:-infra-redis-1}"
STATE_FILE="/tmp/cs-relay-canary-state.json"
CANARY="CS_RELAY_ACCEPTANCE_$(date +%s)_${RANDOM}_${RANDOM}"

cleanup() {
  if sudo docker exec "$APP_CONTAINER" test -f "$STATE_FILE" 2>/dev/null; then
    sudo docker exec \
      -e CANARY_CLEANUP_STATE="$STATE_FILE" \
      "$APP_CONTAINER" \
      node /app/scripts/csapi/canary-relay.mjs >/dev/null
    sudo docker exec "$APP_CONTAINER" rm -f "$STATE_FILE"
  fi
}
trap cleanup EXIT

sudo docker exec "$APP_CONTAINER" mkdir -p /app/scripts/csapi
sudo docker cp \
  "$ROOT/scripts/csapi/canary-relay.mjs" \
  "$APP_CONTAINER:/app/scripts/csapi/canary-relay.mjs" >/dev/null

sudo docker exec \
  -e CANARY="$CANARY" \
  -e KEEP_CANARY=1 \
  -e CANARY_STATE_FILE="$STATE_FILE" \
  "$APP_CONTAINER" \
  node /app/scripts/csapi/canary-relay.mjs

DB_HITS="$(
  cat <<'SQL' | sudo docker exec -i -e CANARY="$CANARY" "$PG_CONTAINER" sh -c \
    'PGPASSWORD="$POSTGRES_PASSWORD" psql -v ON_ERROR_STOP=1 -v canary="$CANARY" -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At'
select
  (select count(*) from cs_relay_messages
    where position(:'canary' in content_ciphertext::text) > 0)
  + (select count(*) from conversations
    where position(:'canary' in coalesce(title, '')) > 0
       or position(:'canary' in coalesce(encrypted_title::text, '')) > 0
       or position(:'canary' in coalesce(wrapped_dek::text, '')) > 0)
  + (select count(*) from account_keks
    where position(:'canary' in wrapped_kek::text) > 0)
  + (select count(*) from runs
    where position(:'canary' in coalesce(prompt, '')) > 0
       or position(:'canary' in coalesce(response, '')) > 0
       or position(:'canary' in coalesce(error, '')) > 0
       or position(:'canary' in coalesce(progress, '')) > 0
       or position(:'canary' in coalesce(request_envelope::text, '')) > 0
       or position(:'canary' in coalesce(result_envelope::text, '')) > 0);
SQL
)"

REDIS_HITS=0
while IFS= read -r key; do
  [[ -n "$key" ]] || continue
  if sudo docker exec "$REDIS_CONTAINER" redis-cli --raw DUMP "$key" 2>/dev/null |
    grep -aFq -- "$CANARY"; then
    REDIS_HITS=$((REDIS_HITS + 1))
  fi
done < <(sudo docker exec "$REDIS_CONTAINER" redis-cli --raw --scan)

WAL_HITS="$(
  sudo docker exec -e CANARY="$CANARY" "$PG_CONTAINER" sh -c \
    'grep -aRIlF -- "$CANARY" "$PGDATA/pg_wal" 2>/dev/null | wc -l'
)"

if sudo docker logs "$APP_CONTAINER" 2>&1 | grep -aFq -- "$CANARY"; then
  LOG_HITS=1
else
  LOG_HITS=0
fi

CONSTRAINTS="$(
  cat <<'SQL' | sudo docker exec -i "$PG_CONTAINER" sh -c \
    'PGPASSWORD="$POSTGRES_PASSWORD" psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At'
select conname || ':' || convalidated
from pg_constraint
where conname in (
  'conversations_cs_relay_plaintext_empty',
  'runs_cs_relay_plaintext_empty'
)
order by conname;
SQL
)"

echo "DB_PLAINTEXT_HITS=$DB_HITS"
echo "REDIS_PLAINTEXT_HITS=$REDIS_HITS"
echo "WAL_PLAINTEXT_HITS=$WAL_HITS"
echo "LOG_PLAINTEXT_HITS=$LOG_HITS"
echo "$CONSTRAINTS"

if [[ "$DB_HITS" != "0" || "$REDIS_HITS" != "0" || "$WAL_HITS" != "0" || "$LOG_HITS" != "0" ]]; then
  echo "FAIL_RELAY_PLAINTEXT_SCAN" >&2
  exit 2
fi

echo "PASS_RELAY_P2_ACCEPTANCE"
