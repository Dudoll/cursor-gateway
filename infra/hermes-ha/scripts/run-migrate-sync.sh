#!/usr/bin/env bash
# Background entrypoint — keep argv free of patterns that remote admin pkill may match.
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
exec hermes-ha migrate sync
