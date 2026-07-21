#!/usr/bin/env bash
# Sync hermes-agent source peer-to-peer over SSH (not via iCloud — too large / 413).
set -euo pipefail

PEER="${1:-}"
if [[ -z "$PEER" ]]; then
  echo "Usage: $0 <ssh-host>   # e.g. vps-band or vps-dmit" >&2
  exit 2
fi

SRC="${HERMES_HOME:-$HOME/.hermes}/hermes-agent/"
DEST="${2:-$SRC}"

rsync -a --delete \
  --exclude '.venv/' \
  --exclude 'venv/' \
  --exclude 'node_modules/' \
  --exclude '.git/' \
  --exclude '__pycache__/' \
  --exclude 'website/' \
  --exclude 'tests/' \
  --exclude '*.pyc' \
  "$SRC" "${PEER}:${DEST}"

echo "synced hermes-agent -> ${PEER}:${DEST}"
echo "On peer: recreate venv if needed (python3 -m venv venv && pip install -r requirements.txt)"
