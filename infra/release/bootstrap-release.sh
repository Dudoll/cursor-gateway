#!/usr/bin/env bash
set -euo pipefail

release_root="${RELEASE_ROOT:-/home/joel/cursor-gateway-release}"
internal_env="${INTERNAL_ENV:-/home/joel/cursor-gateway/.env}"
release_env="$release_root/.env"
runner_env="$release_root/.runner.env"

read_env() {
  local name="$1"
  local file="$2"
  awk -F= -v key="$name" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$file"
}

if [[ ! -f "$internal_env" ]]; then
  echo "Internal environment file not found: $internal_env" >&2
  exit 1
fi

umask 077
if [[ ! -f "$release_env" ]]; then
  db_password="$(openssl rand -hex 24)"
  jwt_secret="$(openssl rand -hex 32)"
  runner_secret="$(openssl rand -hex 32)"
  automation_secret="$(openssl rand -hex 32)"
  hermes_secret="$(openssl rand -hex 32)"
  webhook_secret="$(openssl rand -hex 32)"
  allowed_emails="$(read_env ALLOWED_EMAILS "$internal_env")"

  {
    printf '%s\n' 'PUBLIC_ORIGIN=https://ai.piallera.com'
    printf '%s\n' 'NODE_ENV=production' 'SERVER_HOST=0.0.0.0' 'SERVER_PORT=8080'
    printf 'JWT_SECRET=%s\n' "$jwt_secret"
    printf '%s\n' 'POSTGRES_USER=cursor_gateway_release'
    printf 'POSTGRES_PASSWORD=%s\n' "$db_password"
    printf '%s\n' 'POSTGRES_DB=cursor_gateway_release'
    printf 'DATABASE_URL=postgres://cursor_gateway_release:%s@postgres:5432/cursor_gateway_release\n' "$db_password"
    printf '%s\n' 'REDIS_URL=redis://redis:6379'
    printf 'ALLOWED_EMAILS=%s\n' "$allowed_emails"
    printf '%s\n' 'ALLOWED_CLOUDFLARE_AUD=release-access-aud-not-configured'
    printf '%s\n' 'TELEGRAM_BOT_TOKEN=' 'TELEGRAM_ALLOWED_USER_IDS='
    printf 'TELEGRAM_WEBHOOK_SECRET=%s\n' "$webhook_secret"
    printf 'RUNNER_SHARED_SECRET=%s\n' "$runner_secret"
    printf 'AUTOMATION_SHARED_SECRET=%s\n' "$automation_secret"
    printf 'HERMES_RUNNER_SHARED_SECRET=%s\n' "$hermes_secret"
    printf '%s\n' 'RUNNER_REQUIRE_APPROVAL=false' 'RUNNER_MAX_CONCURRENT_JOBS=3'
    printf '%s\n' 'WEB_DEFAULT_MODEL=hermes:default'
    printf '%s\n' 'REPORT_MODEL_ID=hermes:default' 'REPORT_WORKSPACE_ID=release-content'
    printf '%s\n' 'PUBLIC_REPORTS=true'
  } > "$release_env"
fi

hermes_secret="$(read_env HERMES_RUNNER_SHARED_SECRET "$release_env")"
{
  printf '%s\n' 'CURSOR_GATEWAY_INTERNAL_URL=http://127.0.0.1:18081'
  printf 'CURSOR_GATEWAY_HERMES_RUNNER_SECRET=%s\n' "$hermes_secret"
  printf '%s\n' 'CURSOR_GATEWAY_HERMES_RUNNER_ID=hermes-vps-dmit-release'
  printf '%s\n' 'CURSOR_GATEWAY_HERMES_MODEL_ID=hermes:default'
  printf '%s\n' 'CURSOR_GATEWAY_HERMES_MODEL_NAME=Hermes · release'
  printf '%s\n' 'CURSOR_GATEWAY_HERMES_PENDING_RESULT=/home/joel/cursor-gateway-release/hermes_pending_result.json'
} > "$runner_env"

chmod 600 "$release_env" "$runner_env"
echo "Release environment is ready."
