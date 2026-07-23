#!/usr/bin/env bash
# Rolling host-load sample wrapper (extends scripts/perf/baseline.sh for ongoing use).
# Prefer the installed Hermes HA copy; fall back to the versioned source tree.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CANDIDATES=(
  "${HERMES_HA_INSTALL:-$HOME/hermes-ha}/scripts/sample-host-load.py"
  "$ROOT/infra/hermes-ha/scripts/sample-host-load.py"
)

for script in "${CANDIDATES[@]}"; do
  if [[ -x "$script" || -f "$script" ]]; then
    exec python3 "$script" "$@"
  fi
done

echo "sample-host-load.py not found (install hermes-ha or run from repo)" >&2
exit 1
