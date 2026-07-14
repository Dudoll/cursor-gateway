#!/usr/bin/env bash
# Start the foolproof deploy wizard (host-side).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

if [ -x "$HOME/.node22/bin/node" ]; then
  export PATH="$HOME/.node22/bin:$PATH"
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22+ is required. Install Node or run apps/windows-runner/scripts/setup-runner.sh first." >&2
  exit 1
fi

cd "$ROOT"
exec node "$SCRIPT_DIR/wizard.mjs" "$@"
