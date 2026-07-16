#!/usr/bin/env bash
# =============================================================================
# run-secure-adapter.sh — start the cg-mitm/1 Secure Adapter.
# -----------------------------------------------------------------------------
# The Adapter exposes a LOCAL Anthropic/OpenAI facade and speaks the ciphertext
# cg-mitm/1 channel to the csapi server's /cg/v1/*. Plaintext exists only inside
# this process; it NEVER falls back to plaintext csapi (fail-closed).
#
# Required env (see scripts/csapi/dev-cg-mitm-setup.sh output, or .env.example):
#   CG_ADAPTER_UPSTREAM_URL   e.g. http://127.0.0.1:18080 or https://csapi.joelzt.org
#   CG_ADAPTER_API_KEY        the real CSAPI key (only ever inside the envelope)
#   CG_ADAPTER_LOOPBACK_KEY   the local key your CLI presents to the facade
#   CG_ADAPTER_PINNED_ROOTS   comma-separated sha256:... offline root fingerprints
# Optional:
#   CG_ADAPTER_LISTEN_HOST (127.0.0.1) CG_ADAPTER_LISTEN_PORT (8788)
#   CG_ADAPTER_STATE_FILE  CG_ADAPTER_PAD_BUCKETS  CG_ADAPTER_MASTER_KEY[_FILE]
#   CG_ADAPTER_PINNED_ROOTS_FILE (cg-trust-root-public.json path — alt to inline)
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ADAPTER_DIR="$REPO_ROOT/apps/secure-adapter"

# Load a .env if present (does not override already-exported vars).
if [ -f "$REPO_ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$REPO_ROOT/.env"
  set +a
fi

if [ -x "$REPO_ROOT/node_modules/.bin/tsx" ]; then
  TSX_RUN=("$REPO_ROOT/node_modules/.bin/tsx")
elif command -v tsx >/dev/null 2>&1; then
  TSX_RUN=(tsx)
else
  TSX_RUN=(npx tsx)
fi

# Prefer a compiled build if present; otherwise run the TS entry via tsx.
if [ -f "$ADAPTER_DIR/dist/index.js" ] && [ "${CG_ADAPTER_FORCE_TSX:-0}" != "1" ]; then
  exec node "$ADAPTER_DIR/dist/index.js"
else
  exec "${TSX_RUN[@]}" "$ADAPTER_DIR/src/index.ts"
fi
