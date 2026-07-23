#!/usr/bin/env bash
# Capture VPS resource baseline for gateway-performance-refactor-plan.md targets.
set -euo pipefail
OUT_DIR="${1:-./var/perf-baseline}"
mkdir -p "$OUT_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
REPORT="$OUT_DIR/baseline-$STAMP.txt"

{
  echo "=== host ==="
  date -u
  hostname
  free -m
  nproc
  echo
  echo "=== docker stats ==="
  docker stats --no-stream --format '{{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}\t{{.PIDs}}' || true
  echo
  echo "=== node smaps (infra-app-1) ==="
  docker exec infra-app-1 sh -c 'egrep "^(Rss|Pss|Pss_Anon|Swap):" /proc/1/smaps_rollup' 2>/dev/null || true
  echo
  echo "=== hermes systemd ==="
  systemctl --user show hermes-gateway-telegram2.service \
    -p ActiveState -p MainPID -p MemoryCurrent -p MemoryPeak -p CPUUsageNSec --no-pager 2>/dev/null || true
  echo
  echo "=== cold start tip ==="
  echo "Restart app and measure listenMs from 'gateway ready' log field."
} | tee "$REPORT"

echo "Wrote $REPORT"
