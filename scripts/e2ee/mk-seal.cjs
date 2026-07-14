// Seal the runner master key with a passphrase (scrypt -> AES-256-GCM).
// Passphrase comes from env E2EE_MASTER_PASSPHRASE (never argv/disk).
// Usage: node mk-seal.cjs <masterKeyPath> <encOutPath>
const { scryptSync, randomBytes, createCipheriv } = require("node:crypto");
const fs = require("node:fs");

const [keyPath, encPath] = process.argv.slice(2);
const pass = process.env.E2EE_MASTER_PASSPHRASE || "";
if (pass.length < 8) {
  console.error("passphrase too short (min 8 chars)");
  process.exit(1);
}
const keyBytes = fs.readFileSync(keyPath);
const salt = randomBytes(16);
const iv = randomBytes(12);
const dk = scryptSync(Buffer.from(pass, "utf8"), salt, 32, {
  N: 16384,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024
});
const cipher = createCipheriv("aes-256-gcm", dk, iv);
const ct = Buffer.concat([cipher.update(keyBytes), cipher.final()]);
const tag = cipher.getAuthTag();
dk.fill(0);
const out = [
  "CG-MK-SCRYPT-AESGCM-v1",
  salt.toString("base64"),
  iv.toString("base64"),
  Buffer.concat([ct, tag]).toString("base64")
].join("\n");
fs.writeFileSync(encPath, out, { mode: 0o600 });
fs.chmodSync(encPath, 0o600);
console.log("sealed master key -> " + encPath);
