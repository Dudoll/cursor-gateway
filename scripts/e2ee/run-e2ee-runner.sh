#!/usr/bin/env bash
# Crash-restart wrapper for a Linux/WSL E2EE runner.
# Pure Linux: no Windows Scheduled Task, cmdkey, DPAPI, or WinFS key storage.
# Use this when systemd is unavailable (e.g. some WSL1 setups).
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="${CURSOR_GATEWAY_REPO:-$(cd "$HERE/../.." && pwd)}"
CG_HOME="${CURSOR_GATEWAY_HOME:-$HOME/.cursor-gateway}"
RUNNER_DIR="${E2EE_RUNNER_DIR:-$REPO_ROOT/apps/windows-runner}"
LOG_DIR="$RUNNER_DIR/logs"
LOG="$LOG_DIR/e2ee-runner.log"
STATUS="$CG_HOME/e2ee-unseal.status"
MASTER_KEY_FILE="${E2EE_MASTER_KEY_FILE:-/dev/shm/cursor-gateway/runner-e2ee-master.key}"
NODE="${NODE_BIN:-$(command -v node)}"
mkdir -p "$LOG_DIR" "$CG_HOME"
chmod 700 "$CG_HOME" 2>/dev/null || true

log() { echo "[$(date -Is)] wrapper: $*" >> "$LOG"; }

[ -n "$NODE" ] && [ -x "$NODE" ] || { echo "node not found; set NODE_BIN or PATH" >&2; exit 1; }

# Single-instance guard: refuse to start if an e2ee runner is already running
# from this repo's dist/index.js.
for pid in $(pgrep -x node 2>/dev/null); do
  args=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null)
  cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null)
  case "$args:$cwd" in
    *dist/index.js*:*"$RUNNER_DIR"*) log "runner already running (pid $pid); exiting wrapper"; exit 0;;
  esac
done

cd "$RUNNER_DIR" || { log "cannot cd to $RUNNER_DIR"; exit 1; }

# Master key lives in tmpfs (RAM). Persistent disk only holds passphrase-sealed
# ciphertext ($CG_HOME/runner-e2ee-master.enc). This wrapper never prompts and
# never auto-unseals (that would require a secret on disk).
if [ ! -s "$MASTER_KEY_FILE" ]; then
  printf 'waiting_for_unseal\nupdated_at=%s\nhint=run: bash %s/e2ee-up.sh\n' \
    "$(date -Is)" "$HERE" > "$STATUS"
  chmod 600 "$STATUS" 2>/dev/null || true
  log "FATAL: master key not in tmpfs. Run: bash $HERE/unseal-master-key.sh (enter passphrase), or $HERE/e2ee-up.sh. Exiting."
  echo "E2EE runner: waiting for unseal. Run: bash $HERE/e2ee-up.sh" >&2
  exit 1
fi

rm -f "$STATUS"
log "starting E2EE runner wrapper (pid $$)"

delay=5
while true; do
  if [ ! -s "$MASTER_KEY_FILE" ]; then
    printf 'waiting_for_unseal\nupdated_at=%s\nhint=run: bash %s/e2ee-up.sh\n' \
      "$(date -Is)" "$HERE" > "$STATUS"
    log "FATAL: master key disappeared from tmpfs; stopping wrapper"
    exit 1
  fi
  start=$(date +%s)
  # Clean env so only apps/windows-runner/.env drives config (plus PATH/HOME),
  # plus outbound proxy config. Hosts with no direct egress to Cursor/Anthropic
  # (e.g. region-blocked networks) need HTTPS_PROXY/HTTP_PROXY; NODE_OPTIONS
  # preloads a global undici dispatcher because Node's built-in fetch does not
  # honor *_PROXY env vars on its own. NO_PROXY keeps the self-hosted gateway and
  # loopback DIRECT so pairing/heartbeat are not routed through the proxy. All are
  # optional: unset -> no proxy, and the preload is a no-op without *_PROXY.
  env -i PATH="$(dirname "$NODE"):/usr/bin:/bin" HOME="$HOME" \
    ${HTTPS_PROXY:+HTTPS_PROXY="$HTTPS_PROXY"} \
    ${HTTP_PROXY:+HTTP_PROXY="$HTTP_PROXY"} \
    ${NO_PROXY:+NO_PROXY="$NO_PROXY"} \
    ${CURSOR_PROXY_PRELOAD:+NODE_OPTIONS="--import $CURSOR_PROXY_PRELOAD"} \
    "$NODE" dist/index.js >> "$LOG" 2>&1
  code=$?
  ran=$(( $(date +%s) - start ))
  log "runner exited code=$code after ${ran}s; restarting in ${delay}s"
  sleep "$delay"
  if [ "$ran" -ge 60 ]; then delay=5; else delay=$(( delay * 2 )); [ "$delay" -gt 120 ] && delay=120; fi
done
