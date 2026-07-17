#!/usr/bin/env -S npx tsx
/**
 * Secure Web asset-manifest signing CLI (RAMC P3).
 *
 * Generates + signs an offline Ed25519 manifest over the built Secure Web
 * assets so a desktop localhost verifier can attest the served first-load JS
 * WITHOUT trusting the page itself. The signing PRIVATE key never enters git
 * (it is a *.pem, gitignored, chmod 0600). The PUBLIC key is committed as JSON
 * so the verifier can pin it.
 *
 * Commands:
 *   asset-manifest-cli.ts init-key   [--private-out PATH] [--public-out PATH]
 *   asset-manifest-cli.ts sign       --dist DIR --origin URL --version V
 *                                    [--private PATH] [--out PATH]
 *   asset-manifest-cli.ts verify-local --dist DIR [--public PATH]
 *
 * See docs/runner-manual-code-pairing.md §1 and docs/secure-web-verifier.md.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const MANIFEST_KIND = "secure-web-asset-manifest/1";
const MANIFEST_NAME = "asset-manifest.json";

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg?.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out[key] = next;
        i += 1;
      } else {
        out[key] = "true";
      }
    }
  }
  return out;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromB64url(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/** Deterministic JSON (sorted keys) so both signer and verifier agree byte-for-byte. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

function walk(dir: string, base = dir): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) files.push(...walk(full, base));
    else if (s.isFile() && entry !== MANIFEST_NAME) {
      files.push(relative(base, full).split("\\").join("/"));
    }
  }
  return files.sort();
}

function publicFingerprint(publicJwk: { x: string }): string {
  const digest = createHash("sha256").update(fromB64url(publicJwk.x)).digest();
  return `sha256:${b64url(digest)}`;
}

function buildManifest(input: {
  distDir: string;
  origin: string;
  version: string;
  publicJwk: { kty: string; crv: string; x: string };
}) {
  const assets = walk(input.distDir).map((rel) => {
    const bytes = readFileSync(join(input.distDir, rel));
    return { path: rel, sha256: b64url(createHash("sha256").update(bytes).digest()), bytes: bytes.length };
  });
  return {
    kind: MANIFEST_KIND,
    origin: input.origin.replace(/\/$/, ""),
    version: input.version,
    alg: "Ed25519" as const,
    publicKeyFingerprint: publicFingerprint(input.publicJwk),
    generatedAt: new Date().toISOString(),
    assets
  };
}

function initKey(args: Record<string, string>) {
  const privateOut = resolve(args["private-out"] ?? "secure-web-asset-manifest.pem");
  const publicOut = resolve(
    args["public-out"] ?? "scripts/e2ee/trust/secure-web-asset-manifest-public.json"
  );
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  mkdirSync(dirname(privateOut), { recursive: true });
  mkdirSync(dirname(publicOut), { recursive: true });
  writeFileSync(privateOut, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  chmodSync(privateOut, 0o600);
  const jwk = publicKey.export({ format: "jwk" }) as { kty: string; crv: string; x: string };
  const pinned = {
    kind: "secure-web-asset-manifest-public/1",
    alg: "Ed25519",
    publicKey: jwk,
    fingerprint: publicFingerprint(jwk),
    createdAt: new Date().toISOString()
  };
  writeFileSync(publicOut, `${JSON.stringify(pinned, null, 2)}\n`);
  process.stdout.write(`Ed25519 private key (0600): ${privateOut}\n`);
  process.stdout.write(`Pinned public key (commit):  ${publicOut}\n`);
  process.stdout.write(`Fingerprint: ${pinned.fingerprint}\n`);
}

function sign(args: Record<string, string>) {
  const distDir = resolve(args.dist ?? "apps/secure-web/dist");
  const origin = args.origin;
  const version = args.version ?? "0.0.0";
  const privatePath = resolve(args.private ?? "secure-web-asset-manifest.pem");
  if (!origin) throw new Error("--origin is required");
  if (!existsSync(distDir)) throw new Error(`dist dir not found: ${distDir}`);
  if (!existsSync(privatePath)) throw new Error(`private key not found: ${privatePath}`);
  const privateKey = createPrivateKey(readFileSync(privatePath, "utf8"));
  const privJwk = privateKey.export({ format: "jwk" }) as { kty: string; crv: string; x: string };
  const publicJwk = { kty: privJwk.kty, crv: privJwk.crv, x: privJwk.x };
  const manifest = buildManifest({ distDir, origin, version, publicJwk });
  const signature = b64url(edSign(null, Buffer.from(canonical(manifest)), privateKey));
  const signed = { ...manifest, signature };
  const outPath = resolve(args.out ?? join(distDir, MANIFEST_NAME));
  writeFileSync(outPath, `${JSON.stringify(signed, null, 2)}\n`);
  process.stdout.write(`Signed ${manifest.assets.length} assets → ${outPath}\n`);
  process.stdout.write(`Fingerprint: ${manifest.publicKeyFingerprint}\n`);
}

function verifyLocal(args: Record<string, string>) {
  const distDir = resolve(args.dist ?? "apps/secure-web/dist");
  const manifestPath = join(distDir, MANIFEST_NAME);
  if (!existsSync(manifestPath)) throw new Error(`manifest not found: ${manifestPath}`);
  const signed = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown> & {
    signature: string;
  };
  const { signature, ...manifest } = signed;
  const publicPath = resolve(
    args.public ?? "scripts/e2ee/trust/secure-web-asset-manifest-public.json"
  );
  const pinned = JSON.parse(readFileSync(publicPath, "utf8")) as { publicKey: { x: string } };
  const publicKey = createPublicKey({ key: pinned.publicKey as object, format: "jwk" });
  const sigOk = edVerify(null, Buffer.from(canonical(manifest)), publicKey, fromB64url(signature));
  if (!sigOk) throw new Error("FAIL: manifest signature invalid");
  let bad = 0;
  for (const asset of (manifest as { assets: { path: string; sha256: string }[] }).assets) {
    const bytes = readFileSync(join(distDir, asset.path));
    if (b64url(createHash("sha256").update(bytes).digest()) !== asset.sha256) {
      process.stdout.write(`  MISMATCH ${asset.path}\n`);
      bad += 1;
    }
  }
  if (bad > 0) throw new Error(`FAIL: ${bad} asset hash mismatch`);
  process.stdout.write("PASS: signature valid, all asset hashes match\n");
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (command === "init-key") return initKey(args);
  if (command === "sign") return sign(args);
  if (command === "verify-local") return verifyLocal(args);
  process.stderr.write(
    "Usage: asset-manifest-cli.ts init-key | sign --dist DIR --origin URL --version V | verify-local --dist DIR\n"
  );
  process.exit(1);
}

main();
