#!/usr/bin/env bash
# =============================================================================
# dev-cg-mitm-setup.sh — generate LOCAL dev trust material for cg-mitm/1.
# -----------------------------------------------------------------------------
# Produces (all under $OUT_DIR, gitignored via var/):
#   - cg-trust-root-private.enc      offline Ed25519 root (SEALED, keep offline)
#   - cg-trust-root-public.json      root public list  → CG_TRUST_ROOTS_FILE
#   - cg-server-hpke-key.json        server HPKE private → CG_SERVER_HPKE_KEY_FILE
#   - cg-server-signing-key.json     server ES256 private → CG_SERVER_SIGNING_KEY_FILE
#   - cg-server-identity-cert.json   root-signed server cert → CG_SERVER_CERT_FILE
#   - master.key                     dev master key that seals the root private store
#
# It then prints the exact CG_* env for the server and the CG_ADAPTER_* env for
# the Secure Adapter, including the offline-pinned root fingerprint.
#
# THIS IS FOR LOCAL/DEV ONLY. In production the root private key never touches the
# always-online Gateway; generate/sign it on an operator machine.
#
# Usage:
#   scripts/csapi/dev-cg-mitm-setup.sh [ORIGIN...]
#   ORIGIN defaults to "http://127.0.0.1:18080" (the csapi server the Adapter hits).
#   Pass every origin the Adapter may use as CG_ADAPTER_UPSTREAM_URL, e.g.:
#     scripts/csapi/dev-cg-mitm-setup.sh http://127.0.0.1:18080 https://csapi.joelzt.org
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT_DIR="${CG_MITM_OUT_DIR:-$REPO_ROOT/var/cg-mitm}"
SERVER_ID="${CG_SERVER_ID:-cg-dev-server}"
CLI="$REPO_ROOT/scripts/e2ee/trust-root-cli.ts"

# Origins the server cert is valid for (must include the Adapter's upstream URL).
if [ "$#" -gt 0 ]; then
  ORIGINS="$(IFS=,; echo "$*")"
else
  ORIGINS="http://127.0.0.1:18080"
fi

# Resolve a tsx runner. Prefer the repo-local binary; fall back to npx.
if [ -x "$REPO_ROOT/node_modules/.bin/tsx" ]; then
  TSX_RUN=("$REPO_ROOT/node_modules/.bin/tsx")
elif command -v tsx >/dev/null 2>&1; then
  TSX_RUN=(tsx)
else
  TSX_RUN=(npx tsx)
fi
run_cli() { "${TSX_RUN[@]}" "$CLI" "$@"; }

mkdir -p "$OUT_DIR"
chmod 700 "$OUT_DIR" 2>/dev/null || true

MASTER_KEY_FILE="$OUT_DIR/master.key"
if [ ! -f "$MASTER_KEY_FILE" ]; then
  head -c 32 /dev/urandom | base64 | tr -d '\n' > "$MASTER_KEY_FILE"
  chmod 600 "$MASTER_KEY_FILE"
fi

echo "== 1/3 init offline Ed25519 root (sealed) =="
if [ ! -f "$OUT_DIR/cg-trust-root-public.json" ]; then
  run_cli init-cg-root --out-dir "$OUT_DIR" --master-key-file "$MASTER_KEY_FILE"
else
  echo "  (reusing existing $OUT_DIR/cg-trust-root-public.json)"
fi

echo "== 2/3 generate server HPKE + ES256 keypairs (dev plaintext) =="
run_cli gen-server-keys --out-dir "$OUT_DIR"

echo "== 3/3 issue root-signed server identity cert for: $ORIGINS =="
run_cli issue-server-cert \
  --out-dir "$OUT_DIR" \
  --server-id "$SERVER_ID" \
  --allowed-origins "$ORIGINS" \
  --hpke-key-file "$OUT_DIR/cg-server-hpke-pub.json" \
  --signing-key-file "$OUT_DIR/cg-server-signing-pub.json" \
  --master-key-file "$MASTER_KEY_FILE"

# Extract the pinned root fingerprint for the Adapter.
FINGERPRINT="$(node -e 'const f=require(process.argv[1]);console.log((f.trustRoots||[]).map(r=>r.fingerprint).join(","))' "$OUT_DIR/cg-trust-root-public.json")"

FIRST_ORIGIN="${ORIGINS%%,*}"

cat <<EOF

=============================================================================
Done. Dev material in: $OUT_DIR
Pinned root fingerprint(s): $FINGERPRINT
-----------------------------------------------------------------------------
# --- csapi SERVER env (enable secure channel; keep plaintext /v1/* for A/B) ---
export CG_SECURE_ENABLED=true
# export CG_REQUIRE_SECURE=false   # leave false so plaintext /v1/* stays up
export CG_SERVER_CERT_FILE="$OUT_DIR/cg-server-identity-cert.json"
export CG_SERVER_HPKE_KEY_FILE="$OUT_DIR/cg-server-hpke-key.json"
export CG_SERVER_SIGNING_KEY_FILE="$OUT_DIR/cg-server-signing-key.json"
export CG_TRUST_ROOTS_FILE="$OUT_DIR/cg-trust-root-public.json"
# (CSAPI_ENABLED + CSAPI_API_KEYS must already be configured)

# --- Secure Adapter env (run on the client / trust domain) ---
export CG_ADAPTER_UPSTREAM_URL="$FIRST_ORIGIN"
export CG_ADAPTER_LISTEN_PORT=8788
export CG_ADAPTER_LOOPBACK_KEY="dev-local-loopback-key"
export CG_ADAPTER_API_KEY="<your real CSAPI_API_KEYS value>"
export CG_ADAPTER_PINNED_ROOTS="$FINGERPRINT"

# --- point your CLI at the Adapter (fully local, ciphertext to csapi) ---
export ANTHROPIC_BASE_URL="http://127.0.0.1:8788"
export ANTHROPIC_API_KEY="dev-local-loopback-key"
export OPENAI_BASE_URL="http://127.0.0.1:8788/v1"
export OPENAI_API_KEY="dev-local-loopback-key"
=============================================================================
EOF
