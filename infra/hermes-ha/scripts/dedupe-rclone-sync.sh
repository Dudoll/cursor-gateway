#!/usr/bin/env bash
# Keep a single rclone sync for hermes-ha (kill duplicate PIDs only).
set -euo pipefail
mapfile -t pids < <(pgrep -f '/.local/bin/rclone sync .*/.hermes/ icloud:hermes-ha/hermes' || true)
if ((${#pids[@]} <= 1)); then
  echo "rclone sync count=${#pids[@]}"
  exit 0
fi
# keep the newest
keep="${pids[-1]}"
for pid in "${pids[@]}"; do
  if [[ "$pid" != "$keep" ]]; then
    echo "killing duplicate rclone sync pid=$pid"
    kill "$pid" 2>/dev/null || true
  fi
done
echo "kept pid=$keep"
