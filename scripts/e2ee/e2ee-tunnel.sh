#!/usr/bin/env bash
# Optional: persistent SSH local-forward so a headless E2EE client on the runner
# host can reach the gateway app on the VPS loopback without exposing it publicly.
# Defaults: local 127.0.0.1:18099 -> remote 127.0.0.1:18080 via SSH host alias.
set -u
SSH_HOST="${CLIENT_SSH_HOST:-gateway-vps}"
LOCAL_PORT="${CLIENT_LOCAL_PORT:-18099}"
REMOTE_PORT="${CLIENT_REMOTE_PORT:-18080}"
LOG="${E2EE_TUNNEL_LOG:-/tmp/e2ee-tunnel.log}"

exec ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -L "127.0.0.1:${LOCAL_PORT}:127.0.0.1:${REMOTE_PORT}" "$SSH_HOST" </dev/null >>"$LOG" 2>&1
