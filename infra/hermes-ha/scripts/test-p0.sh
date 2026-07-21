#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKSPACE="$(cd "$ROOT/.." && pwd)"

python3 -m compileall -q "$ROOT/agent" "$ROOT/tests"

while IFS= read -r -d '' script; do
  bash -n "$script"
done < <(find "$ROOT/scripts" "$ROOT/hooks" -type f -name '*.sh' -print0)

python3 -m unittest discover -s "$ROOT/tests" -v
python3 "$WORKSPACE/vps-metrics/test_collector_stale_refresh.py"

for unit in "$ROOT"/systemd/*.service "$ROOT"/systemd/*.timer; do
  [[ -s "$unit" ]]
  grep -q '^\[Unit\]' "$unit"
done

echo "P0 automated gate: PASS"
