#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="${HERMES_HA_CONFIG:-$HOME/.config/hermes-ha/config.json}"

exec python3 "$ROOT/agent/acceptance.py" --config "$CONFIG" "$@"
