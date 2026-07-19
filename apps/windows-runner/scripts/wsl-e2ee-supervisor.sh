#!/usr/bin/env bash
# Canonical WSL1 supervisor for runnerId=wsl-e2ee.
# It never stores or prompts for the passphrase. After reboot it waits until the
# operator unseals the encrypted master key into /dev/shm, then starts the
# existing crash-restart wrapper. flock guarantees one supervisor instance.
set -u

HOME_DIR="${HOME:-/home/dministrator}"
STATE_DIR="$HOME_DIR/.cursor-gateway"
MASTER_KEY_FILE="/dev/shm/cursor-gateway/runner-e2ee-master.key"
WRAPPER="$STATE_DIR/run-e2ee-runner.sh"
WAIT_HELPER="$STATE_DIR/e2ee-wait-unseal.sh"
STATUS="$STATE_DIR/e2ee-unseal.status"
LOG="/home/dministrator/cursor-e2ee/apps/windows-runner/logs/e2ee-runner.log"
LOCK="/tmp/cursor-gateway-wsl-e2ee-supervisor.lock"

mkdir -p "$(dirname "$LOG")" "$STATE_DIR"
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "[$(date -Is)] supervisor: another instance is active; exiting" >> "$LOG"
  exit 0
fi

log() { echo "[$(date -Is)] supervisor: $*" >> "$LOG"; }

runner_is_active() {
  local pid args cwd
  for pid in $(pgrep -x node 2>/dev/null); do
    args=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null)
    cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null)
    case "$args:$cwd" in
      *dist/index.js*:*cursor-e2ee/apps/windows-runner*) return 0 ;;
    esac
  done
  return 1
}

if [ ! -x "$WRAPPER" ]; then
  log "FATAL: wrapper missing or not executable: $WRAPPER"
  exit 1
fi

delay=10
log "canonical supervisor started (pid $$)"
while true; do
  if [ ! -s "$MASTER_KEY_FILE" ]; then
    if [ -x "$WAIT_HELPER" ]; then
      "$WAIT_HELPER" || true
    fi
    log "waiting for tmpfs key; run: bash ~/.cursor-gateway/e2ee-up.sh"
    sleep "$delay"
    delay=$((delay * 2))
    [ "$delay" -gt 60 ] && delay=60
    continue
  fi

  rm -f "$STATUS"
  if runner_is_active; then
    delay=10
    sleep 30
    continue
  fi
  delay=10
  log "tmpfs key available; launching canonical runner wrapper"
  bash "$WRAPPER"
  code=$?
  log "wrapper exited code=$code; retrying in ${delay}s"
  sleep "$delay"
  delay=$((delay * 2))
  [ "$delay" -gt 120 ] && delay=120
done
