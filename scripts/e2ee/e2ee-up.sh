#!/usr/bin/env bash
# Post-reboot convenience: unseal the master key (prompts once for passphrase),
# then launch the E2EE runner wrapper. Pure Linux, no Windows dependencies.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
TMPFS_KEY="${E2EE_MASTER_KEY_FILE:-/dev/shm/cursor-gateway/runner-e2ee-master.key}"
NODE="${NODE_BIN:-$(command -v node)}"
NODE_DIR="$(dirname "${NODE:-/usr/bin/node}")"

if [ ! -s "$TMPFS_KEY" ]; then
  bash "$HERE/unseal-master-key.sh"
fi
nohup env -i PATH="$NODE_DIR:/usr/bin:/bin" HOME="$HOME" \
  bash "$HERE/run-e2ee-runner.sh" >/dev/null 2>&1 & disown
echo "E2EE runner wrapper launched (unsealed key in tmpfs)."
