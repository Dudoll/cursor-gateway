#!/usr/bin/env bash
# Locally-verifiable signed release for the Windows desktop installer.
# Mirrors scripts/csapi/sign-extension-release.sh: SHA256SUMS + detached Ed25519
# signature (minisign preferred, Node crypto fallback). Private signing key stays
# 0600 OUTSIDE git; only the public key is committed.
#
# Usage:
#   scripts/desktop/sign-desktop-release.sh [path/to/cursor-gateway-desktop-setup.exe]
# Default input: artifacts/desktop/cursor-gateway-desktop-setup.exe
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ART="$ROOT/artifacts/desktop"
INSTALLER="${1:-$ART/cursor-gateway-desktop-setup.exe}"
KEY_DIR="${CS_DESKTOP_SIGNING_DIR:-$HOME/.cursor-gateway/desktop-signing}"

export PATH="${HOME}/.node22/bin:/usr/local/bin:$PATH"

if [[ ! -f "$INSTALLER" ]]; then
  echo "installer not found: $INSTALLER" >&2
  echo "Build it first (Windows/CI): npm run build -w @cursor-gateway/desktop" >&2
  exit 1
fi

mkdir -p "$ART" "$KEY_DIR"
chmod 700 "$KEY_DIR"
# Normalize into the artifacts dir under the canonical name.
if [[ "$INSTALLER" != "$ART/cursor-gateway-desktop-setup.exe" ]]; then
  cp "$INSTALLER" "$ART/cursor-gateway-desktop-setup.exe"
fi

echo "[1/3] SHA256SUMS"
(
  cd "$ART"
  sha256sum cursor-gateway-desktop-setup.exe > SHA256SUMS
  cat SHA256SUMS
)

echo "[2/3] sign (minisign preferred; Node Ed25519 fallback)"
PRIV_MS="$KEY_DIR/minisign.key"
PUB_MS="$KEY_DIR/minisign.pub"
if command -v minisign >/dev/null 2>&1; then
  if [[ ! -f "$PRIV_MS" ]]; then
    printf '\n\n' | minisign -G -s "$PRIV_MS" -p "$PUB_MS"
    chmod 600 "$PRIV_MS"; chmod 644 "$PUB_MS"
    cp "$PUB_MS" "$ROOT/scripts/csapi/trust/desktop-minisign.pub"
  fi
  minisign -S -s "$PRIV_MS" -m "$ART/cursor-gateway-desktop-setup.exe" \
    -x "$ART/cursor-gateway-desktop-setup.exe.minisig"
  echo "signed: $ART/cursor-gateway-desktop-setup.exe.minisig"
else
  echo "minisign missing — using Node crypto Ed25519 detached signature"
  node <<'NODE'
const { generateKeyPairSync, sign, createPrivateKey, createPublicKey, verify } = require("crypto");
const fs = require("fs");
const path = require("path");
const root = process.cwd();
const art = path.join(root, "artifacts/desktop");
const keyDir = process.env.CS_DESKTOP_SIGNING_DIR || path.join(process.env.HOME, ".cursor-gateway/desktop-signing");
fs.mkdirSync(keyDir, { recursive: true });
const privPath = path.join(keyDir, "ed25519.pem");
const pubPath = path.join(keyDir, "ed25519.pub.pem");
if (!fs.existsSync(privPath)) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  fs.writeFileSync(privPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  fs.writeFileSync(pubPath, publicKey.export({ type: "spki", format: "pem" }), { mode: 0o644 });
  fs.copyFileSync(pubPath, path.join(root, "scripts/csapi/trust/desktop-ed25519.pub.pem"));
}
const exe = fs.readFileSync(path.join(art, "cursor-gateway-desktop-setup.exe"));
const sig = sign(null, exe, createPrivateKey(fs.readFileSync(privPath)));
fs.writeFileSync(path.join(art, "cursor-gateway-desktop-setup.exe.ed25519"), sig);
const ok = verify(null, exe, createPublicKey(fs.readFileSync(pubPath)), sig);
if (!ok) { console.error("self-verify failed"); process.exit(1); }
console.log("signed: " + path.join(art, "cursor-gateway-desktop-setup.exe.ed25519"));
NODE
fi

echo "[3/3] done — publish artifacts/desktop/{cursor-gateway-desktop-setup.exe,SHA256SUMS,*.sig|*.ed25519}"
