// Unseal the passphrase-encrypted master key into tmpfs (RAM, 0600).
// Passphrase comes from env E2EE_MASTER_PASSPHRASE (never argv/disk).
// Usage: node mk-unseal.cjs <encPath> <tmpfsKeyOutPath>
const { scryptSync, createDecipheriv } = require("node:crypto");
const fs = require("node:fs");
const { dirname } = require("node:path");

const [encPath, keyPath] = process.argv.slice(2);
const pass = process.env.E2EE_MASTER_PASSPHRASE || "";
if (pass.length < 8) {
  console.error("passphrase too short (min 8 chars)");
  process.exit(1);
}
const parts = fs.readFileSync(encPath, "utf8").split("\n");
const [magic, saltB64, ivB64, blobB64] = parts;
if (magic !== "CG-MK-SCRYPT-AESGCM-v1" || !saltB64 || !ivB64 || !blobB64) {
  console.error("bad sealed key format");
  process.exit(1);
}
const salt = Buffer.from(saltB64, "base64");
const iv = Buffer.from(ivB64, "base64");
const blob = Buffer.from(blobB64, "base64");
const ct = blob.subarray(0, blob.length - 16);
const tag = blob.subarray(blob.length - 16);
const dk = scryptSync(Buffer.from(pass, "utf8"), salt, 32, {
  N: 16384,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024
});
const decipher = createDecipheriv("aes-256-gcm", dk, iv);
decipher.setAuthTag(tag);
let pt;
try {
  pt = Buffer.concat([decipher.update(ct), decipher.final()]);
} catch {
  dk.fill(0);
  console.error("unseal failed (wrong passphrase or tampered file)");
  process.exit(2);
}
dk.fill(0);
fs.mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
fs.writeFileSync(keyPath, pt, { mode: 0o600 });
fs.chmodSync(keyPath, 0o600);
pt.fill(0);
console.log("unsealed master key -> " + keyPath);
