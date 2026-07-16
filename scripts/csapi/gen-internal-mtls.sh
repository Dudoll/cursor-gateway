#!/usr/bin/env bash
# Internal CA + mTLS material for Runner↔CS (relay-P4 optional transport).
# Application-layer envelope MUST NOT wait on mTLS — these certs are additive.
set -euo pipefail
OUT="${1:-$HOME/.cursor-gateway/mtls}"
mkdir -p "$OUT"
chmod 700 "$OUT"

if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl required" >&2
  exit 1
fi

CA_KEY="$OUT/internal-ca.key"
CA_CRT="$OUT/internal-ca.crt"
SERVER_KEY="$OUT/cs-server.key"
SERVER_CRT="$OUT/cs-server.crt"
CLIENT_KEY="$OUT/runner-client.key"
CLIENT_CRT="$OUT/runner-client.crt"

if [[ ! -f "$CA_KEY" ]]; then
  openssl genrsa -out "$CA_KEY" 4096
  chmod 600 "$CA_KEY"
  openssl req -x509 -new -nodes -key "$CA_KEY" -sha256 -days 3650 \
    -subj "/CN=Cursor Gateway Internal CA" -out "$CA_CRT"
  chmod 644 "$CA_CRT"
fi

openssl genrsa -out "$SERVER_KEY" 2048
chmod 600 "$SERVER_KEY"
openssl req -new -key "$SERVER_KEY" -subj "/CN=cs.joelzt.org" -out "$OUT/cs-server.csr"
openssl x509 -req -in "$OUT/cs-server.csr" -CA "$CA_CRT" -CAkey "$CA_KEY" -CAcreateserial \
  -out "$SERVER_CRT" -days 825 -sha256
chmod 644 "$SERVER_CRT"

openssl genrsa -out "$CLIENT_KEY" 2048
chmod 600 "$CLIENT_KEY"
openssl req -new -key "$CLIENT_KEY" -subj "/CN=runner-client" -out "$OUT/runner-client.csr"
openssl x509 -req -in "$OUT/runner-client.csr" -CA "$CA_CRT" -CAkey "$CA_KEY" -CAcreateserial \
  -out "$CLIENT_CRT" -days 825 -sha256
chmod 644 "$CLIENT_CRT"

rm -f "$OUT"/*.csr "$OUT"/*.srl
echo "wrote mTLS material under $OUT (keys 0600). Configure nginx optionally; app envelope path independent."
