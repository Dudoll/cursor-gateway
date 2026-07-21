#!/usr/bin/env bash
# Called by vps-metrics after writing snapshot.json when dmit looks unreachable.
#
# NOTE: vps-metrics.service uses ProtectHome=read-only and RestrictAddressFamilies
# without AF_UNIX, so this hook must ONLY write under /var/lib/vps-metrics.
# Real takeover / failback_ready is done by user timer: hermes-ha-evaluate.timer.
set -euo pipefail

STATE_DIR="${VPS_METRICS_STATE_DIR:-/var/lib/vps-metrics}"
SNAPSHOT="${1:-$STATE_DIR/snapshot.json}"
REQUEST_FILE="${HERMES_HA_EVAL_REQUEST:-$STATE_DIR/hermes-ha-evaluate.requested}"

if [[ ! -f "$SNAPSHOT" ]]; then
  echo "snapshot missing: $SNAPSHOT" >&2
  exit 0
fi

reachable="$(python3 - "$SNAPSHOT" <<'PY'
import json, sys
data = json.load(open(sys.argv[1], encoding="utf-8"))
status = data.get("status") or {}
reachable = bool(status.get("reachable"))
state = str(status.get("state") or "").lower()
if state in {"offline", "unreachable"}:
    reachable = False
print("1" if reachable else "0")
PY
)"

mkdir -p "$STATE_DIR"

if [[ "$reachable" == "1" ]]; then
  rm -f "$REQUEST_FILE"
  echo "dmit reachable; evaluate request cleared"
  exit 0
fi

date -u +%Y-%m-%dT%H:%M:%SZ > "$REQUEST_FILE"
echo "dmit unreachable; evaluate requested (evaluate.timer owns streak and takeover)"
exit 0
