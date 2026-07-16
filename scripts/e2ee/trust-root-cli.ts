#!/usr/bin/env -S npx tsx
/**
 * Offline trust-root / Runner identity certificate / recovery-code CLI.
 *
 * Root private key material NEVER touches the Gateway. Run this on an
 * operator machine (or the Runner host itself for `issue-cert` /
 * `recovery-code`), never inside the always-online Gateway process.
 *
 * Commands:
 *   trust-root-cli.ts init-root        [--epoch N] [--out-dir DIR] [--master-key-file PATH]
 *   trust-root-cli.ts issue-cert       --runner-id ID --allowed-origins a,b --allowed-rp-ids a,b
 *                                      [--validity-days N] [--epoch N]
 *                                      [--root-private PATH] [--root-public PATH] [--master-key-file PATH]
 *                                      [--encryption-key-file PATH --signing-key-file PATH | --runner-state-file PATH]
 *                                      [--out PATH]
 *   trust-root-cli.ts init-cg-root     [--epoch N] [--out-dir DIR] [--master-key-file PATH]
 *   trust-root-cli.ts gen-server-keys  [--out-dir DIR] [--seal --master-key-file PATH]
 *                                      [--hpke-out PATH --hpke-pub-out PATH]
 *                                      [--signing-out PATH --signing-pub-out PATH]
 *   trust-root-cli.ts issue-server-cert --server-id ID --allowed-origins a,b
 *                                      --hpke-key-file PATH --signing-key-file PATH
 *                                      [--validity-days N] [--epoch N]
 *                                      [--root-private PATH] [--root-public PATH] [--master-key-file PATH]
 *                                      [--out PATH]
 *   trust-root-cli.ts recovery-code    --runner-id ID [--secure-origin URL] [--ttl-seconds N]
 *                                      [--gateway-url URL --runner-shared-secret SECRET]
 *
 * See docs/trust-root-rotation.md.
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  cgTrustRootPublicSchema,
  e2eeKeyDescriptorSchema,
  e2eeTrustRootPublicSchema,
  type CgTrustRootPublic,
  type E2eeKeyDescriptor,
  type E2eeTrustRootPublic
} from "@cursor-gateway/shared";
import {
  createKeyDescriptor,
  encodeCrockfordGrouped,
  exportPrivateJwk,
  generateCgTrustRootKeyPair,
  generateHpkeKeyPair,
  generateRecoverySecret,
  generateSigningKeyPair,
  generateTrustRootKeyPair,
  importCgEd25519PrivateKey,
  importTrustRootPrivateKey,
  issueCgServerIdentityCert,
  issueRunnerIdentityCert
} from "@cursor-gateway/e2ee";

const GATEWAY_DIR = join(homedir(), ".cursor-gateway");

// --- tiny arg parser (--flag value / --flag=value / --bool-flag) ---
type Args = Record<string, string | boolean>;

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token?.startsWith("--")) continue;
    const eq = token.indexOf("=");
    if (eq !== -1) {
      args[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function requireString(args: Args, key: string, fallback?: string): string {
  const value = args[key];
  if (typeof value === "string" && value.trim()) return value.trim();
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required --${key}`);
}

function optionalString(args: Args, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

// --- master-key sealing (mirrors apps/windows-runner/src/e2eeState.ts) ---
const MASTER_MAGIC = "CG-E2EE-SCRYPT-AESGCM-v1";
const SCRYPT_PARAMS = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

function resolveMasterKey(args: Args): string {
  const inline = process.env.RUNNER_E2EE_MASTER_KEY;
  if (inline && inline.length >= 16) return inline;
  const filePath =
    optionalString(args, "master-key-file") ??
    process.env.RUNNER_E2EE_MASTER_KEY_FILE ??
    "/dev/shm/cursor-gateway/runner-e2ee-master.key";
  if (!existsSync(filePath)) {
    throw new Error(
      `No master key available: set RUNNER_E2EE_MASTER_KEY, or put one at ${filePath} ` +
        "(see scripts/e2ee/README.md for seal-master-key.sh)"
    );
  }
  const fromFile = readFileSync(filePath, "utf8").trim();
  if (fromFile.length < 16) throw new Error("Master key file contents are too short (min 16 chars)");
  return fromFile;
}

function sealWithMasterKey(plaintext: Uint8Array, masterKey: string): Uint8Array {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(Buffer.from(masterKey, "utf8"), salt, 32, SCRYPT_PARAMS);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
  const tag = cipher.getAuthTag();
  key.fill(0);
  const payload = [
    MASTER_MAGIC,
    salt.toString("base64"),
    iv.toString("base64"),
    Buffer.concat([ciphertext, tag]).toString("base64")
  ].join("\n");
  return new TextEncoder().encode(payload);
}

function openWithMasterKey(stored: Uint8Array, masterKey: string): Uint8Array {
  const [magic, saltB64, ivB64, blobB64] = new TextDecoder().decode(stored).split("\n");
  if (magic !== MASTER_MAGIC || !saltB64 || !ivB64 || !blobB64) {
    throw new Error("invalid_sealed_file_format");
  }
  const salt = Buffer.from(saltB64, "base64");
  const iv = Buffer.from(ivB64, "base64");
  const blob = Buffer.from(blobB64, "base64");
  const ciphertext = blob.subarray(0, blob.length - 16);
  const tag = blob.subarray(blob.length - 16);
  const key = scryptSync(Buffer.from(masterKey, "utf8"), salt, 32, SCRYPT_PARAMS);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  try {
    return new Uint8Array(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
  } catch {
    throw new Error("master_key_decrypt_failed (wrong master key or corrupted file)");
  } finally {
    key.fill(0);
  }
}

function writeFileAtomic(path: string, contents: string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, contents, { mode });
  renameSync(temporaryPath, path);
  try {
    chmodSync(path, mode);
  } catch {
    // Best-effort on filesystems without POSIX permission semantics.
  }
}

// --- sealed trust-root private store ---
type TrustRootPrivateEntry = {
  privateJwk: JsonWebKey;
  epoch: number;
  keyId: string;
  fingerprint: string;
  createdAt: string;
};
type TrustRootPrivateStore = { version: 1; roots: Record<string, TrustRootPrivateEntry> };

function loadPrivateStore(path: string, masterKey: string): TrustRootPrivateStore {
  if (!existsSync(path)) return { version: 1, roots: {} };
  const sealed = new Uint8Array(readFileSync(path));
  const plaintext = openWithMasterKey(sealed, masterKey);
  try {
    return JSON.parse(new TextDecoder().decode(plaintext)) as TrustRootPrivateStore;
  } finally {
    plaintext.fill(0);
  }
}

function savePrivateStore(path: string, store: TrustRootPrivateStore, masterKey: string): void {
  const plaintext = new TextEncoder().encode(JSON.stringify(store));
  const sealed = sealWithMasterKey(plaintext, masterKey);
  writeFileAtomic(path, new TextDecoder().decode(sealed), 0o600);
}

function loadPublicList(path: string): E2eeTrustRootPublic[] {
  if (!existsSync(path)) return [];
  const raw = JSON.parse(readFileSync(path, "utf8")) as { trustRoots?: unknown[] };
  return (raw.trustRoots ?? []).map((item) => e2eeTrustRootPublicSchema.parse(item));
}

function savePublicList(path: string, roots: E2eeTrustRootPublic[]): void {
  writeFileAtomic(path, JSON.stringify({ trustRoots: roots }, null, 2), 0o644);
}

// --- commands ---

async function cmdInitRoot(args: Args): Promise<void> {
  const outDir = optionalString(args, "out-dir") ?? GATEWAY_DIR;
  const privatePath = join(outDir, "trust-root-private.enc");
  const publicPath = join(outDir, "trust-root-public.json");
  const masterKey = resolveMasterKey(args);

  const privateStore = loadPrivateStore(privatePath, masterKey);
  const publicRoots = loadPublicList(publicPath);
  const maxExistingEpoch = Object.values(privateStore.roots).reduce(
    (max, entry) => Math.max(max, entry.epoch),
    0
  );
  const epochArg = optionalString(args, "epoch");
  const epoch = epochArg ? Number(epochArg) : maxExistingEpoch + 1;
  if (!Number.isInteger(epoch) || epoch < 1) throw new Error("--epoch must be a positive integer");

  const root = await generateTrustRootKeyPair(epoch);
  privateStore.roots[root.public.keyId] = {
    privateJwk: root.privateJwk,
    epoch,
    keyId: root.public.keyId,
    fingerprint: root.public.fingerprint,
    createdAt: root.public.createdAt
  };
  savePrivateStore(privatePath, privateStore, masterKey);
  savePublicList(publicPath, [...publicRoots, root.public]);

  console.log(`Generated trust root epoch ${epoch}`);
  console.log(`  keyId:       ${root.public.keyId}`);
  console.log(`  fingerprint: ${root.public.fingerprint}`);
  console.log(`  private:     ${privatePath} (sealed, 0600 — keep offline)`);
  console.log(`  public:      ${publicPath}`);
  console.log(
    "Distribute the public file to the Gateway (E2EE_TRUST_ROOTS_FILE) and to every Runner " +
      "(E2EE_TRUST_ROOTS_FILE) so certs signed by this root can be verified."
  );
}

async function cmdIssueCert(args: Args): Promise<void> {
  const outDir = optionalString(args, "out-dir") ?? GATEWAY_DIR;
  const privatePath = optionalString(args, "root-private") ?? join(outDir, "trust-root-private.enc");
  const publicPath = optionalString(args, "root-public") ?? join(outDir, "trust-root-public.json");
  const masterKey = resolveMasterKey(args);

  const runnerId = requireString(args, "runner-id", process.env.RUNNER_ID);
  const allowedSecureOrigins = splitCsv(requireString(args, "allowed-origins"));
  const allowedRpIds = splitCsv(requireString(args, "allowed-rp-ids"));
  const validityDays = Number(optionalString(args, "validity-days") ?? "365");
  const out = optionalString(args, "out") ?? join(outDir, "runner-identity-cert.json");

  const privateStore = loadPrivateStore(privatePath, masterKey);
  const publicRoots = loadPublicList(publicPath);
  const entries = Object.values(privateStore.roots);
  if (entries.length === 0) throw new Error("No trust roots found; run init-root first");
  const epochArg = optionalString(args, "epoch");
  const selected = epochArg
    ? entries.find((entry) => entry.epoch === Number(epochArg))
    : entries.reduce((latest, entry) => (entry.epoch > latest.epoch ? entry : latest));
  if (!selected) throw new Error(`No trust root found for epoch ${epochArg}`);
  const rootPublic = publicRoots.find((root) => root.keyId === selected.keyId);
  if (!rootPublic) throw new Error("Root private entry has no matching public record");

  const { encryptionKey, signingKey } = await resolveRunnerKeyDescriptors(args);
  const rootPrivateKey = await importTrustRootPrivateKey(selected.privateJwk);

  const cert = await issueRunnerIdentityCert({
    rootPrivateKey,
    rootPublic,
    runnerId,
    encryptionKey,
    signingKey,
    allowedSecureOrigins,
    allowedRpIds,
    validityDays
  });

  writeFileAtomic(out, JSON.stringify(cert, null, 2), 0o644);
  console.log(`Issued Runner identity certificate for ${runnerId}`);
  console.log(`  certId:      ${cert.certId}`);
  console.log(`  epoch:       ${cert.epoch}`);
  console.log(`  expiresAt:   ${cert.expiresAt}`);
  console.log(`  written to:  ${out}`);
  console.log("Copy this file to the Runner host as RUNNER_IDENTITY_CERT_FILE.");
}

async function resolveRunnerKeyDescriptors(
  args: Args
): Promise<{ encryptionKey: E2eeKeyDescriptor; signingKey: E2eeKeyDescriptor }> {
  const encryptionKeyFile = optionalString(args, "encryption-key-file");
  const signingKeyFile = optionalString(args, "signing-key-file");
  if (encryptionKeyFile && signingKeyFile) {
    return {
      encryptionKey: e2eeKeyDescriptorSchema.parse(
        JSON.parse(readFileSync(encryptionKeyFile, "utf8"))
      ),
      signingKey: e2eeKeyDescriptorSchema.parse(JSON.parse(readFileSync(signingKeyFile, "utf8")))
    };
  }

  const stateFile =
    optionalString(args, "runner-state-file") ??
    process.env.RUNNER_E2EE_STATE_FILE ??
    join(homedir(), ".cursor-gateway", "runner-e2ee-state.dat");
  if (!existsSync(stateFile)) {
    throw new Error(
      "Provide --encryption-key-file + --signing-key-file, or a readable --runner-state-file " +
        `(none found at ${stateFile})`
    );
  }
  const masterKey = resolveMasterKey(args);
  const sealed = new Uint8Array(readFileSync(stateFile));
  const plaintext = openWithMasterKey(sealed, masterKey);
  try {
    const state = JSON.parse(new TextDecoder().decode(plaintext)) as {
      encryption: { descriptor: unknown };
      signing: { descriptor: unknown };
    };
    return {
      encryptionKey: e2eeKeyDescriptorSchema.parse(state.encryption.descriptor),
      signingKey: e2eeKeyDescriptorSchema.parse(state.signing.descriptor)
    };
  } finally {
    plaintext.fill(0);
  }
}

type QrcodeModule = { toString(text: string, options: Record<string, unknown>): Promise<string> };

/**
 * `qrcode` is a hard dependency of the windows-runner workspace (not the
 * repo root), so resolve it from there when it isn't hoisted to the root
 * `node_modules`. QR rendering is a convenience only — the printed URL and
 * Crockford code remain fully usable if this fails.
 */
async function loadQrcode(): Promise<QrcodeModule | null> {
  try {
    return ((await import("qrcode")) as { default: QrcodeModule }).default;
  } catch {
    // Fall through to the workspace-relative resolution below.
  }
  try {
    const fallback = new URL(
      "../../apps/windows-runner/node_modules/qrcode/lib/index.js",
      import.meta.url
    );
    return ((await import(fallback.href)) as { default: QrcodeModule }).default;
  } catch {
    return null;
  }
}

// --- cg-mitm/1 Ed25519 offline root + server identity certificate ---

type CgTrustRootPrivateEntry = {
  privateJwk: JsonWebKey;
  epoch: number;
  keyId: string;
  fingerprint: string;
  createdAt: string;
  alg: "EdDSA";
};
type CgTrustRootPrivateStore = { version: 1; roots: Record<string, CgTrustRootPrivateEntry> };

function loadCgPrivateStore(path: string, masterKey: string): CgTrustRootPrivateStore {
  if (!existsSync(path)) return { version: 1, roots: {} };
  const sealed = new Uint8Array(readFileSync(path));
  const plaintext = openWithMasterKey(sealed, masterKey);
  try {
    return JSON.parse(new TextDecoder().decode(plaintext)) as CgTrustRootPrivateStore;
  } finally {
    plaintext.fill(0);
  }
}

function saveCgPrivateStore(path: string, store: CgTrustRootPrivateStore, masterKey: string): void {
  const plaintext = new TextEncoder().encode(JSON.stringify(store));
  const sealed = sealWithMasterKey(plaintext, masterKey);
  writeFileAtomic(path, new TextDecoder().decode(sealed), 0o600);
}

function loadCgPublicList(path: string): CgTrustRootPublic[] {
  if (!existsSync(path)) return [];
  const raw = JSON.parse(readFileSync(path, "utf8")) as { trustRoots?: unknown[] };
  return (raw.trustRoots ?? []).map((item) => cgTrustRootPublicSchema.parse(item));
}

function saveCgPublicList(path: string, roots: CgTrustRootPublic[]): void {
  writeFileAtomic(path, JSON.stringify({ trustRoots: roots }, null, 2), 0o644);
}

async function cmdInitCgRoot(args: Args): Promise<void> {
  const outDir = optionalString(args, "out-dir") ?? GATEWAY_DIR;
  const privatePath = join(outDir, "cg-trust-root-private.enc");
  const publicPath = join(outDir, "cg-trust-root-public.json");
  const masterKey = resolveMasterKey(args);

  const privateStore = loadCgPrivateStore(privatePath, masterKey);
  const publicRoots = loadCgPublicList(publicPath);
  const maxExistingEpoch = Object.values(privateStore.roots).reduce(
    (max, entry) => Math.max(max, entry.epoch),
    0
  );
  const epochArg = optionalString(args, "epoch");
  const epoch = epochArg ? Number(epochArg) : maxExistingEpoch + 1;
  if (!Number.isInteger(epoch) || epoch < 1) throw new Error("--epoch must be a positive integer");

  const root = await generateCgTrustRootKeyPair(epoch);
  privateStore.roots[root.public.keyId] = {
    privateJwk: root.privateJwk,
    epoch,
    keyId: root.public.keyId,
    fingerprint: root.public.fingerprint,
    createdAt: root.public.createdAt,
    alg: "EdDSA"
  };
  saveCgPrivateStore(privatePath, privateStore, masterKey);
  saveCgPublicList(publicPath, [...publicRoots, root.public]);

  console.log(`Generated cg-mitm Ed25519 trust root epoch ${epoch}`);
  console.log(`  keyId:       ${root.public.keyId}`);
  console.log(`  fingerprint: ${root.public.fingerprint}`);
  console.log(`  private:     ${privatePath} (sealed, 0600 — keep offline)`);
  console.log(`  public:      ${publicPath}`);
  console.log(
    "Distribute the public file with CG_TRUST_ROOTS_FILE (or embed in server-keys). " +
      "Root private material must never touch the always-online Gateway."
  );
}

async function cmdGenServerKeys(args: Args): Promise<void> {
  const outDir = optionalString(args, "out-dir") ?? GATEWAY_DIR;
  const hpkePrivatePath = optionalString(args, "hpke-out") ?? join(outDir, "cg-server-hpke-key.json");
  const hpkePubPath = optionalString(args, "hpke-pub-out") ?? join(outDir, "cg-server-hpke-pub.json");
  const signingPrivatePath =
    optionalString(args, "signing-out") ?? join(outDir, "cg-server-signing-key.json");
  const signingPubPath =
    optionalString(args, "signing-pub-out") ?? join(outDir, "cg-server-signing-pub.json");
  const seal = args.seal === true;

  const hpkePair = await generateHpkeKeyPair();
  const signingPair = await generateSigningKeyPair(true);
  const hpkeDescriptor = await createKeyDescriptor(hpkePair.publicKey);
  const signingDescriptor = await createKeyDescriptor(signingPair.publicKey);
  const hpkePrivateJwk = await exportPrivateJwk(hpkePair.privateKey);
  const signingPrivateJwk = await exportPrivateJwk(signingPair.privateKey);

  const writePrivate = (path: string, privateJwk: JsonWebKey): void => {
    const json = JSON.stringify({ privateJwk });
    if (seal) {
      const masterKey = resolveMasterKey(args);
      const sealed = sealWithMasterKey(new TextEncoder().encode(json), masterKey);
      writeFileAtomic(path, new TextDecoder().decode(sealed), 0o600);
    } else {
      writeFileAtomic(path, json, 0o600);
    }
  };

  writePrivate(hpkePrivatePath, hpkePrivateJwk);
  writePrivate(signingPrivatePath, signingPrivateJwk);
  writeFileAtomic(hpkePubPath, JSON.stringify(hpkeDescriptor, null, 2), 0o644);
  writeFileAtomic(signingPubPath, JSON.stringify(signingDescriptor, null, 2), 0o644);

  console.log("Generated cg-mitm server HPKE + ES256 signing keypairs");
  console.log(`  hpke private:    ${hpkePrivatePath} (${seal ? "sealed" : "plaintext"}, 0600)`);
  console.log(`  hpke public:     ${hpkePubPath}`);
  console.log(`  signing private: ${signingPrivatePath} (${seal ? "sealed" : "plaintext"}, 0600)`);
  console.log(`  signing public:  ${signingPubPath}`);
  console.log(
    "Next: issue-server-cert --hpke-key-file " +
      `${hpkePubPath} --signing-key-file ${signingPubPath} ...`
  );
  console.log(
    "Set CG_SERVER_HPKE_KEY_FILE / CG_SERVER_SIGNING_KEY_FILE to the private files on the Gateway."
  );
}

async function cmdIssueServerCert(args: Args): Promise<void> {
  const outDir = optionalString(args, "out-dir") ?? GATEWAY_DIR;
  const privatePath =
    optionalString(args, "root-private") ?? join(outDir, "cg-trust-root-private.enc");
  const publicPath =
    optionalString(args, "root-public") ?? join(outDir, "cg-trust-root-public.json");
  const masterKey = resolveMasterKey(args);

  const serverId = requireString(args, "server-id");
  const allowedOrigins = splitCsv(requireString(args, "allowed-origins"));
  const validityDays = Number(optionalString(args, "validity-days") ?? "365");
  const out = optionalString(args, "out") ?? join(outDir, "cg-server-identity-cert.json");

  const hpkeKey = e2eeKeyDescriptorSchema.parse(
    JSON.parse(readFileSync(requireString(args, "hpke-key-file"), "utf8"))
  );
  const signingKey = e2eeKeyDescriptorSchema.parse(
    JSON.parse(readFileSync(requireString(args, "signing-key-file"), "utf8"))
  );

  const privateStore = loadCgPrivateStore(privatePath, masterKey);
  const publicRoots = loadCgPublicList(publicPath);
  const entries = Object.values(privateStore.roots);
  if (entries.length === 0) throw new Error("No cg trust roots found; run init-cg-root first");
  const epochArg = optionalString(args, "epoch");
  const selected = epochArg
    ? entries.find((entry) => entry.epoch === Number(epochArg))
    : entries.reduce((latest, entry) => (entry.epoch > latest.epoch ? entry : latest));
  if (!selected) throw new Error(`No cg trust root found for epoch ${epochArg}`);
  const rootPublic = publicRoots.find((root) => root.keyId === selected.keyId);
  if (!rootPublic) throw new Error("Cg root private entry has no matching public record");

  const rootPrivateKey = await importCgEd25519PrivateKey(selected.privateJwk);
  const cert = await issueCgServerIdentityCert({
    rootPrivateKey,
    rootPublic,
    serverId,
    hpkeKey,
    signingKey,
    allowedOrigins,
    validityDays
  });

  writeFileAtomic(out, JSON.stringify(cert, null, 2), 0o644);
  console.log(`Issued cg-mitm server identity certificate for ${serverId}`);
  console.log(`  certId:      ${cert.certId}`);
  console.log(`  epoch:       ${cert.epoch}`);
  console.log(`  expiresAt:   ${cert.expiresAt}`);
  console.log(`  written to:  ${out}`);
  console.log("Copy this file to the Gateway host as CG_SERVER_CERT_FILE.");
}

async function cmdRecoveryCode(args: Args): Promise<void> {
  const runnerId = requireString(args, "runner-id", process.env.RUNNER_ID);
  const secureOrigin = (optionalString(args, "secure-origin") ?? "https://secure.joelzt.org").replace(
    /\/$/,
    ""
  );
  const ttlSeconds = Number(optionalString(args, "ttl-seconds") ?? "1800");

  const secret = generateRecoverySecret();
  const recoveryId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

  const pendingPath = join(
    GATEWAY_DIR,
    `recovery-pending-${runnerId.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`
  );
  const existing = existsSync(pendingPath)
    ? (JSON.parse(readFileSync(pendingPath, "utf8")) as {
        version: 1;
        codes: Record<string, unknown>;
      })
    : { version: 1 as const, codes: {} };
  existing.codes[recoveryId] = { secret, runnerId, createdAt, expiresAt, usedAt: null };
  writeFileAtomic(pendingPath, JSON.stringify(existing, null, 2), 0o600);

  const url = `${secureOrigin}/#recover=${recoveryId}.${secret}`;
  const code = encodeCrockfordGrouped(secret);

  console.log(`Recovery code for Runner ${runnerId}`);
  console.log(`  recoveryId: ${recoveryId}`);
  console.log(`  expiresAt:  ${expiresAt}`);
  console.log(`  pending:    ${pendingPath} (0600 — never sent to the Gateway)`);
  console.log("");
  console.log(`URL:  ${url}`);
  console.log(`Code: ${code}`);
  console.log("");

  const QRCode = await loadQrcode();
  if (QRCode) {
    console.log(await QRCode.toString(url, { type: "terminal", small: true }));
  } else {
    console.warn(
      "(QR rendering unavailable: `qrcode` not installed — run `npm install` in " +
        "apps/windows-runner, or install it at the repo root)"
    );
  }

  const gatewayUrl = optionalString(args, "gateway-url") ?? process.env.GATEWAY_URL;
  const sharedSecret =
    optionalString(args, "runner-shared-secret") ?? process.env.RUNNER_SHARED_SECRET;
  if (gatewayUrl && sharedSecret) {
    try {
      const response = await fetch(
        `${gatewayUrl.replace(/\/$/, "")}/api/runner/e2ee/v1/recovery/handles`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${sharedSecret}`, "content-type": "application/json" },
          body: JSON.stringify({ runnerId, handle: { recoveryId, expiresAt } })
        }
      );
      if (!response.ok) throw new Error(`gateway_returned_${response.status}`);
      console.log("Published public recovery handle to the Gateway (no secret sent).");
    } catch (error) {
      console.warn(
        `Could not advertise the recovery handle to the Gateway (non-fatal): ` +
          `${error instanceof Error ? error.message : "unknown"}`
      );
    }
  } else {
    console.log(
      "Tip: pass --gateway-url and --runner-shared-secret to advertise a public " +
        "(secret-free) handle so Secure Web can pre-validate this code before pairing."
    );
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  switch (command) {
    case "init-root":
      return cmdInitRoot(args);
    case "issue-cert":
      return cmdIssueCert(args);
    case "init-cg-root":
      return cmdInitCgRoot(args);
    case "gen-server-keys":
      return cmdGenServerKeys(args);
    case "issue-server-cert":
      return cmdIssueServerCert(args);
    case "recovery-code":
      return cmdRecoveryCode(args);
    default:
      console.error(
        "Usage: trust-root-cli.ts <init-root|issue-cert|init-cg-root|gen-server-keys|issue-server-cert|recovery-code> [options]\n" +
          "See scripts/e2ee/README.md for full option reference."
      );
      process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "trust_root_cli_failed");
  process.exit(1);
});
