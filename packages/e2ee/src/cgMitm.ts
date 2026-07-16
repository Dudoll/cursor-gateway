/**
 * cg-mitm/1 — Ed25519 trust-root verify, purpose/KDF/AAD helpers, server-cert issue.
 *
 * Uses Web Crypto Ed25519 (Node ≥22 / modern browsers) so this stays in the
 * same export graph as the rest of `@cursor-gateway/e2ee` (no node:crypto).
 */
import {
  CG_MITM_HPKE_SUITE,
  CG_MITM_PROTOCOL,
  CG_MITM_PURPOSE_C2S,
  CG_MITM_PURPOSE_ENROLL,
  CG_MITM_PURPOSE_S2C,
  cgDeviceCertSchema,
  cgServerIdentityCertSchema,
  cgTrustRootPublicSchema,
  type CgAnySignature,
  type CgDeviceCert,
  type CgEd25519PublicKey,
  type CgServerIdentityCert,
  type CgTrustRootPublic,
  type E2eeKeyDescriptor,
  type E2eePublicKey,
  type E2eeSignature
} from "@cursor-gateway/shared";
import {
  canonicalBytes,
  decodeBase64Url,
  encodeBase64Url,
  exportPrivateJwk,
  importSigningPublicKey,
  signValue,
  verifyValue,
  type JsonValue
} from "./index.js";

function omitSignature<T extends { signature: unknown }>(
  value: T
): Omit<T, "signature"> {
  const { signature: _signature, ...rest } = value;
  return rest;
}

const subtle = globalThis.crypto.subtle;

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  const output = new Uint8Array(value.byteLength);
  output.set(value);
  return output.buffer;
}

async function sha256(value: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle.digest("SHA-256", toArrayBuffer(value)));
}

// Re-export purpose constants for callers that import from e2ee.
export {
  CG_MITM_PROTOCOL,
  CG_MITM_HPKE_SUITE,
  CG_MITM_PURPOSE_C2S,
  CG_MITM_PURPOSE_S2C,
  CG_MITM_PURPOSE_ENROLL
};

/** Alias matching the 04-handshake-kdf-aad.md names. */
export const C2S_PURPOSE = CG_MITM_PURPOSE_C2S;
export const S2C_PURPOSE = CG_MITM_PURPOSE_S2C;
export const ENROLL_PURPOSE = CG_MITM_PURPOSE_ENROLL;

export function buildHandshakeContext(v: {
  serverCertId: string;
  epoch: number;
  deviceId: string;
  adapterNonce: string;
  minSuite: string;
}): JsonValue {
  return {
    protocol: CG_MITM_PROTOCOL,
    purpose: "handshake",
    serverCertId: v.serverCertId,
    epoch: v.epoch,
    deviceId: v.deviceId,
    adapterNonce: v.adapterNonce,
    minSuite: v.minSuite
  };
}

export function buildC2sAad(env: {
  sessionId: string;
  sequence: number;
  kind: string;
}): JsonValue {
  return {
    protocol: CG_MITM_PROTOCOL,
    direction: "c2s",
    kind: env.kind,
    sessionId: env.sessionId,
    sequence: env.sequence
  };
}

export function buildS2cAad(v: {
  sessionId: string;
  sequence: number;
  frameType: string;
}): JsonValue {
  return {
    protocol: CG_MITM_PROTOCOL,
    direction: "s2c",
    sessionId: v.sessionId,
    sequence: v.sequence,
    frameType: v.frameType
  };
}

/**
 * Canonical transcript the Adapter's device signing key signs on every exchange
 * (first and subsequent frames). The server verifies it with the enrolled device
 * cert's ES256 public key. Long-term keys never enter an HTTP header — the
 * signature travels inside the encrypted `cgExchangeInner.deviceAuth`.
 */
export function buildCgDeviceAuthTranscript(v: {
  sessionId: string;
  deviceId: string;
  sequence: number;
  idempotencyKey: string;
}): JsonValue {
  return {
    protocol: CG_MITM_PROTOCOL,
    purpose: "device-auth",
    sessionId: v.sessionId,
    deviceId: v.deviceId,
    sequence: v.sequence,
    idempotencyKey: v.idempotencyKey
  };
}

export function buildEnrollContext(env: {
  serverCertId: string;
  epoch: number;
}): JsonValue {
  return {
    protocol: CG_MITM_PROTOCOL,
    purpose: "enroll-handshake",
    serverCertId: env.serverCertId,
    epoch: env.epoch
  };
}

export function buildEnrollAad(env: {
  serverCertId: string;
  epoch: number;
}): JsonValue {
  return {
    protocol: CG_MITM_PROTOCOL,
    direction: "enroll",
    serverCertId: env.serverCertId,
    epoch: env.epoch
  };
}

export function cgServerCertTranscript(
  cert: Omit<CgServerIdentityCert, "signature">
): JsonValue {
  return {
    protocol: cert.protocol,
    kind: cert.kind,
    version: cert.version,
    certId: cert.certId,
    serverId: cert.serverId,
    epoch: cert.epoch,
    hpkeFingerprint: cert.hpkeKey.fingerprint,
    hpkeKeyId: cert.hpkeKey.keyId,
    signingFingerprint: cert.signingKey.fingerprint,
    signingKeyId: cert.signingKey.keyId,
    allowedOrigins: [...cert.allowedOrigins].sort(),
    issuedAt: cert.issuedAt,
    expiresAt: cert.expiresAt,
    rootKeyId: cert.rootKeyId,
    rootFingerprint: cert.rootFingerprint,
    alg: cert.alg
  };
}

export function cgDeviceCertTranscript(
  cert: Omit<CgDeviceCert, "signature">
): JsonValue {
  return {
    protocol: cert.protocol,
    kind: cert.kind,
    version: cert.version,
    deviceId: cert.deviceId,
    signingFingerprint: cert.signingKey.fingerprint,
    signingKeyId: cert.signingKey.keyId,
    encryptionFingerprint: cert.encryptionKey.fingerprint,
    encryptionKeyId: cert.encryptionKey.keyId,
    keyIdHint: cert.keyIdHint,
    issuedAt: cert.issuedAt,
    expiresAt: cert.expiresAt,
    serverCertId: cert.serverCertId
  };
}

export async function generateCgEd25519KeyPair(): Promise<CryptoKeyPair> {
  return subtle.generateKey("Ed25519", true, ["sign", "verify"]) as Promise<CryptoKeyPair>;
}

export async function exportCgEd25519PublicKey(key: CryptoKey): Promise<CgEd25519PublicKey> {
  const jwk = await subtle.exportKey("jwk", key);
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") {
    throw new Error("invalid_ed25519_public_key");
  }
  return { kty: "OKP", crv: "Ed25519", x: jwk.x };
}

export async function importCgEd25519PublicKey(value: CgEd25519PublicKey): Promise<CryptoKey> {
  return subtle.importKey(
    "jwk",
    { ...value, ext: true, key_ops: ["verify"] },
    "Ed25519",
    true,
    ["verify"]
  );
}

export async function importCgEd25519PrivateKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return subtle.importKey(
    "jwk",
    { ...jwk, ext: true, key_ops: ["sign"] },
    "Ed25519",
    false,
    ["sign"]
  );
}

export async function createCgEd25519KeyDescriptor(key: CryptoKey): Promise<{
  keyId: string;
  fingerprint: string;
  publicKey: CgEd25519PublicKey;
}> {
  const exported = await exportCgEd25519PublicKey(key);
  const digest = encodeBase64Url(await sha256(canonicalBytes(exported)));
  return {
    keyId: `ed25519-${digest.slice(0, 22)}`,
    fingerprint: `sha256:${digest}`,
    publicKey: exported
  };
}

export async function generateCgTrustRootKeyPair(epoch = 1): Promise<{
  privateJwk: JsonWebKey;
  public: CgTrustRootPublic;
  privateKey: CryptoKey;
}> {
  const pair = await generateCgEd25519KeyPair();
  const descriptor = await createCgEd25519KeyDescriptor(pair.publicKey);
  const privateJwk = await exportPrivateJwk(pair.privateKey);
  return {
    privateJwk,
    privateKey: pair.privateKey,
    public: cgTrustRootPublicSchema.parse({
      protocol: CG_MITM_PROTOCOL,
      kind: "cg-trust-root-public/1",
      alg: "EdDSA",
      keyId: descriptor.keyId,
      fingerprint: descriptor.fingerprint,
      publicKey: descriptor.publicKey,
      epoch,
      createdAt: new Date().toISOString()
    })
  };
}

export async function signCgEdDsa(
  value: unknown,
  privateKey: CryptoKey,
  keyId: string
): Promise<Extract<CgAnySignature, { alg: "EdDSA" }>> {
  const signature = new Uint8Array(
    await subtle.sign("Ed25519", privateKey, toArrayBuffer(canonicalBytes(value)))
  );
  return {
    alg: "EdDSA",
    keyId,
    value: encodeBase64Url(signature)
  };
}

/**
 * alg discriminant: EdDSA → Web Crypto Ed25519; ES256 → existing verifyValue.
 */
export async function verifyCgSignature(
  value: unknown,
  sig: CgAnySignature,
  pub: CryptoKey
): Promise<boolean> {
  if (sig.alg === "ES256") {
    return verifyValue(value, sig as E2eeSignature, pub);
  }
  try {
    return subtle.verify(
      "Ed25519",
      pub,
      toArrayBuffer(decodeBase64Url(sig.value)),
      toArrayBuffer(canonicalBytes(value))
    );
  } catch {
    return false;
  }
}

export async function issueCgServerIdentityCert(input: {
  rootPrivateKey: CryptoKey;
  rootPublic: CgTrustRootPublic;
  serverId: string;
  hpkeKey: E2eeKeyDescriptor;
  signingKey: E2eeKeyDescriptor;
  allowedOrigins: string[];
  epoch?: number;
  validityDays?: number;
  issuedAt?: string;
}): Promise<CgServerIdentityCert> {
  if (input.rootPublic.alg !== "EdDSA") {
    throw new Error("cg_server_cert_requires_eddsa_root");
  }
  const issuedAt = input.issuedAt ?? new Date().toISOString();
  const validityDays = input.validityDays ?? 365;
  const expiresAt = new Date(Date.parse(issuedAt) + validityDays * 86_400_000).toISOString();
  const unsigned: Omit<CgServerIdentityCert, "signature"> = {
    protocol: CG_MITM_PROTOCOL,
    kind: "cg-server-identity-cert/1",
    version: 1,
    certId: crypto.randomUUID(),
    serverId: input.serverId,
    epoch: input.epoch ?? input.rootPublic.epoch,
    hpkeKey: input.hpkeKey,
    signingKey: input.signingKey,
    allowedOrigins: input.allowedOrigins,
    issuedAt,
    expiresAt,
    rootKeyId: input.rootPublic.keyId,
    rootFingerprint: input.rootPublic.fingerprint,
    alg: "EdDSA"
  };
  const signature = await signCgEdDsa(
    cgServerCertTranscript(unsigned),
    input.rootPrivateKey,
    input.rootPublic.keyId
  );
  return cgServerIdentityCertSchema.parse({ ...unsigned, signature });
}

export type CgServerCertValidation =
  | { ok: true; root: CgTrustRootPublic }
  | { ok: false; reason: string };

export async function verifyCgServerIdentityCert(input: {
  cert: CgServerIdentityCert;
  trustRoots: CgTrustRootPublic[];
  expected?: {
    serverId?: string;
    epoch?: number;
    origin?: string;
    hpkeFingerprint?: string;
    signingFingerprint?: string;
  };
  nowMs?: number;
}): Promise<CgServerCertValidation> {
  const cert = input.cert;
  const now = input.nowMs ?? Date.now();
  if (cert.protocol !== CG_MITM_PROTOCOL || cert.kind !== "cg-server-identity-cert/1") {
    return { ok: false, reason: "cert_kind_mismatch" };
  }
  if (cert.version !== 1) return { ok: false, reason: "cert_version_unsupported" };
  if (Date.parse(cert.expiresAt) <= now) return { ok: false, reason: "cert_expired" };
  if (Date.parse(cert.issuedAt) > now + 60_000) return { ok: false, reason: "cert_not_yet_valid" };
  if (input.expected?.serverId && cert.serverId !== input.expected.serverId) {
    return { ok: false, reason: "cert_server_mismatch" };
  }
  if (input.expected?.epoch !== undefined && cert.epoch !== input.expected.epoch) {
    return { ok: false, reason: "cert_epoch_mismatch" };
  }
  if (
    input.expected?.hpkeFingerprint &&
    cert.hpkeKey.fingerprint !== input.expected.hpkeFingerprint
  ) {
    return { ok: false, reason: "cert_hpke_fingerprint_mismatch" };
  }
  if (
    input.expected?.signingFingerprint &&
    cert.signingKey.fingerprint !== input.expected.signingFingerprint
  ) {
    return { ok: false, reason: "cert_signing_fingerprint_mismatch" };
  }
  if (input.expected?.origin && !cert.allowedOrigins.includes(input.expected.origin)) {
    return { ok: false, reason: "cert_origin_not_allowed" };
  }
  const root = input.trustRoots.find(
    (candidate) =>
      candidate.keyId === cert.rootKeyId &&
      candidate.fingerprint === cert.rootFingerprint
  );
  if (!root) return { ok: false, reason: "trust_root_not_found" };
  if (root.alg !== "EdDSA" || root.publicKey.kty !== "OKP") {
    return { ok: false, reason: "trust_root_alg_mismatch" };
  }
  if (cert.signature.alg !== "EdDSA") return { ok: false, reason: "cert_signature_alg_mismatch" };
  if (cert.signature.keyId !== root.keyId) {
    return { ok: false, reason: "cert_signature_key_mismatch" };
  }
  const rootKey = await importCgEd25519PublicKey(root.publicKey);
  const valid = await verifyCgSignature(
    cgServerCertTranscript(omitSignature(cert)),
    cert.signature,
    rootKey
  );
  if (!valid) return { ok: false, reason: "cert_signature_invalid" };
  return { ok: true, root };
}

export async function issueCgDeviceCert(input: {
  signingPrivateKey: CryptoKey;
  signingKeyId: string;
  deviceId: string;
  signingKey: E2eeKeyDescriptor;
  encryptionKey: E2eeKeyDescriptor;
  keyIdHint: string;
  serverCertId: string;
  validityDays?: number;
  issuedAt?: string;
}): Promise<CgDeviceCert> {
  const issuedAt = input.issuedAt ?? new Date().toISOString();
  const validityDays = input.validityDays ?? 365;
  const expiresAt = new Date(Date.parse(issuedAt) + validityDays * 86_400_000).toISOString();
  const unsigned: Omit<CgDeviceCert, "signature"> = {
    protocol: CG_MITM_PROTOCOL,
    kind: "cg-device-cert/1",
    version: 1,
    deviceId: input.deviceId,
    signingKey: input.signingKey,
    encryptionKey: input.encryptionKey,
    keyIdHint: input.keyIdHint,
    issuedAt,
    expiresAt,
    serverCertId: input.serverCertId
  };
  const signature = await signValue(
    cgDeviceCertTranscript(unsigned),
    input.signingPrivateKey,
    input.signingKeyId
  );
  return cgDeviceCertSchema.parse({ ...unsigned, signature });
}

export async function verifyCgDeviceCert(input: {
  cert: CgDeviceCert;
  serverSigningPublicKey: CryptoKey | E2eePublicKey;
}): Promise<boolean> {
  if (input.cert.signature.keyId.length < 8) return false;
  const pub =
    "kty" in input.serverSigningPublicKey
      ? await importSigningPublicKey(input.serverSigningPublicKey)
      : input.serverSigningPublicKey;
  return verifyValue(
    cgDeviceCertTranscript(omitSignature(input.cert)),
    input.cert.signature,
    pub
  );
}

/** sessionId = base64url(SHA-256(decodeBase64Url(enc.enc))). */
export async function sessionIdFromHpkeEnc(encBase64Url: string): Promise<string> {
  return encodeBase64Url(await sha256(decodeBase64Url(encBase64Url)));
}
