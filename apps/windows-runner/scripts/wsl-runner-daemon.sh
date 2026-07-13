#!/usr/bin/env bash
# Keeps the Cursor Gateway runner alive inside WSL1.
# Runs the compiled runner, restarts it with exponential backoff on exit, and
# writes rolling logs. Intended to be launched at Windows startup via a
# Scheduled Task that runs `wsl.exe`.
set -u

ROOT="${1:-$HOME/cursor-vps/cursor-gateway}"
RUNNER_DIR="$ROOT/apps/windows-runner"
LOG_DIR="$RUNNER_DIR/logs"
LOG="$LOG_DIR/wsl-runner-daemon.log"

export PATH="$HOME/.node22/bin:$PATH"
mkdir -p "$LOG_DIR"

log() { echo "[$(date -Is)] $*" >> "$LOG"; }

if [ -f "$LOG" ] && [ "$(stat -c%s "$LOG" 2>/dev/null || echo 0)" -gt 10485760 ]; then
  mv -f "$LOG" "$LOG.1"
fi

cd "$RUNNER_DIR" || { log "FATAL: cannot cd to $RUNNER_DIR"; exit 1; }

log "WSL runner daemon started (pid $$), node=$(node -v 2>/dev/null || echo missing)"

delay=10
while true; do
  start=$(date +%s)
  log "starting runner (node dist/index.js)"
  node dist/index.js >> "$LOG" 2>&1
  code=$?
  ran=$(( $(date +%s) - start ))
  if [ "$ran" -ge 60 ]; then
    delay=10
  fi
  log "runner exited code=$code after ${ran}s; restarting in ${delay}s"
  sleep "$delay"
  if [ "$ran" -lt 60 ]; then
    delay=$(( delay * 2 ))
    [ "$delay" -gt 300 ] && delay=300
  fi
done
