#!/usr/bin/env bash
# Boot helper (pure Linux/WSL): if the sealed master key exists but tmpfs is empty,
# leave a clear "waiting for unseal" status and exit 0. Does NOT prompt
# (non-interactive boot/profile must not block). Operator then runs e2ee-up.sh.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
CG_HOME="${CURSOR_GATEWAY_HOME:-$HOME/.cursor-gateway}"
TMPFS_KEY="${E2EE_MASTER_KEY_FILE:-/dev/shm/cursor-gateway/runner-e2ee-master.key}"
ENC="${E2EE_MASTER_KEY_ENC:-$CG_HOME/runner-e2ee-master.enc}"
STATUS="$CG_HOME/e2ee-unseal.status"

mkdir -p "$CG_HOME"
chmod 700 "$CG_HOME" 2>/dev/null || true

if [ -s "$TMPFS_KEY" ]; then
  rm -f "$STATUS"
  exit 0
fi
if [ ! -s "$ENC" ]; then
  printf 'missing_sealed_key\nupdated_at=%s\nhint=run: bash %s/seal-master-key.sh once master key is in tmpfs\n' \
    "$(date -Is)" "$HERE" > "$STATUS"
  chmod 600 "$STATUS" 2>/dev/null || true
  exit 0
fi
printf 'waiting_for_unseal\nupdated_at=%s\nhint=run: bash %s/e2ee-up.sh\n' \
  "$(date -Is)" "$HERE" > "$STATUS"
chmod 600 "$STATUS" 2>/dev/null || true
exit 0
