#!/usr/bin/env bash
# Generate locally-verifiable signed extension package (relay-P6).
# Private signing key stays 0600 outside git. Public key may be committed.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
EXT="$ROOT/apps/browser-extension"
ART="$ROOT/artifacts/signed-extension"
KEY_DIR="${CS_EXTENSION_SIGNING_DIR:-$HOME/.cursor-gateway/extension-signing}"
mkdir -p "$ART" "$KEY_DIR"
chmod 700 "$KEY_DIR"

export PATH="${HOME}/.node22/bin:/usr/local/bin:$PATH"

echo "[1/4] build extension"
npm run build -w @cursor-gateway/browser-extension

echo "[2/4] pack zip"
node "$EXT/scripts/pack-extension-zip.mjs" "$EXT/dist" "$ART/cursor-gateway-secure.zip"

echo "[3/4] SHA256"
(
  cd "$ART"
  sha256sum cursor-gateway-secure.zip > SHA256SUMS
)

echo "[4/4] sign (minisign preferred; Node Ed25519 fallback)"
PRIV_MS="$KEY_DIR/minisign.key"
PUB_MS="$KEY_DIR/minisign.pub"
if command -v minisign >/dev/null 2>&1; then
  if [[ ! -f "$PRIV_MS" ]]; then
    printf '\n\n' | minisign -G -s "$PRIV_MS" -p "$PUB_MS"
    chmod 600 "$PRIV_MS"
    chmod 644 "$PUB_MS"
    cp "$PUB_MS" "$ROOT/scripts/csapi/trust/extension-minisign.pub"
  fi
  minisign -S -s "$PRIV_MS" -m "$ART/cursor-gateway-secure.zip" -x "$ART/cursor-gateway-secure.zip.minisig"
  echo "signed: $ART/cursor-gateway-secure.zip.minisig"
else
  echo "minisign missing — using Node crypto Ed25519 detached signature"
  node <<'NODE'
const { generateKeyPairSync, sign, createPrivateKey, createPublicKey, verify } = require("crypto");
const fs = require("fs");
const path = require("path");
const root = process.cwd();
const art = path.join(root, "artifacts/signed-extension");
const keyDir = process.env.CS_EXTENSION_SIGNING_DIR || path.join(process.env.HOME, ".cursor-gateway/extension-signing");
fs.mkdirSync(keyDir, { recursive: true });
const privPath = path.join(keyDir, "ed25519.pem");
const pubPath = path.join(keyDir, "ed25519.pub.pem");
if (!fs.existsSync(privPath)) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  fs.writeFileSync(privPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  fs.writeFileSync(pubPath, publicKey.export({ type: "spki", format: "pem" }), { mode: 0o644 });
  fs.copyFileSync(pubPath, path.join(root, "scripts/csapi/trust/extension-ed25519.pub.pem"));
}
const zip = fs.readFileSync(path.join(art, "cursor-gateway-secure.zip"));
const sig = sign(null, zip, createPrivateKey(fs.readFileSync(privPath)));
fs.writeFileSync(path.join(art, "cursor-gateway-secure.zip.ed25519"), sig);
const ok = verify(null, zip, createPublicKey(fs.readFileSync(pubPath)), sig);
if (!ok) process.exit(1);
console.log("ed25519 signature ok; pubkey at scripts/csapi/trust/extension-ed25519.pub.pem");
NODE
fi
echo "done: $ART"
