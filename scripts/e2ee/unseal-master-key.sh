#!/usr/bin/env bash
# Per-reboot: unseal the passphrase-encrypted master key back into tmpfs (RAM).
# Passphrase is prompted (or taken from env E2EE_MASTER_PASSPHRASE) and never
# stored. Run this once after a reboot before the runner can start.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
CG_HOME="${CURSOR_GATEWAY_HOME:-$HOME/.cursor-gateway}"
TMPFS_KEY="${E2EE_MASTER_KEY_FILE:-/dev/shm/cursor-gateway/runner-e2ee-master.key}"
ENC="${E2EE_MASTER_KEY_ENC:-$CG_HOME/runner-e2ee-master.enc}"
NODE="${NODE_BIN:-$(command -v node)}"

[ -n "$NODE" ] && [ -x "$NODE" ] || { echo "node not found; set NODE_BIN or PATH" >&2; exit 1; }
[ -s "$ENC" ] || { echo "no sealed key ($ENC); run seal-master-key.sh first" >&2; exit 1; }
if [ -s "$TMPFS_KEY" ]; then echo "master key already present in tmpfs"; exit 0; fi
if [ -z "${E2EE_MASTER_PASSPHRASE:-}" ]; then
  read -rs -p "E2EE master passphrase: " E2EE_MASTER_PASSPHRASE; echo
fi
export E2EE_MASTER_PASSPHRASE
"$NODE" "$HERE/mk-unseal.cjs" "$ENC" "$TMPFS_KEY"
unset E2EE_MASTER_PASSPHRASE
