#!/usr/bin/env bash
# One-time: seal the live tmpfs master key under a passphrase (pure Linux,
# scrypt+AES-256-GCM). The passphrase is NEVER written to disk. The resulting
# .enc holds only ciphertext; without the passphrase it cannot be used, so the
# persistent disk never carries a directly-usable master key.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
CG_HOME="${CURSOR_GATEWAY_HOME:-$HOME/.cursor-gateway}"
TMPFS_KEY="${E2EE_MASTER_KEY_FILE:-/dev/shm/cursor-gateway/runner-e2ee-master.key}"
ENC="${E2EE_MASTER_KEY_ENC:-$CG_HOME/runner-e2ee-master.enc}"
NODE="${NODE_BIN:-$(command -v node)}"

[ -n "$NODE" ] && [ -x "$NODE" ] || { echo "node not found; set NODE_BIN or PATH" >&2; exit 1; }
[ -s "$TMPFS_KEY" ] || { echo "no live master key in tmpfs ($TMPFS_KEY) to seal" >&2; exit 1; }
mkdir -p "$CG_HOME"
chmod 700 "$CG_HOME" 2>/dev/null || true
if [ -z "${E2EE_MASTER_PASSPHRASE:-}" ]; then
  read -rs -p "Set E2EE master passphrase (min 8): " E2EE_MASTER_PASSPHRASE; echo
  read -rs -p "Confirm passphrase: " CONFIRM; echo
  [ "$E2EE_MASTER_PASSPHRASE" = "$CONFIRM" ] || { echo "passphrase mismatch" >&2; exit 1; }
fi
export E2EE_MASTER_PASSPHRASE
"$NODE" "$HERE/mk-seal.cjs" "$TMPFS_KEY" "$ENC"
rm -f "$CG_HOME/MASTER_KEY_RESEAL_REQUIRED"
unset E2EE_MASTER_PASSPHRASE
