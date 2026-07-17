import {
  E2EE_CS_AUTH_KIND,
  E2EE_DEVICE_APPROVAL_KIND,
  E2EE_HPKE_SUITE,
  E2EE_PAIRING_KIND,
  E2EE_PROTOCOL,
  E2EE_RECOVERY_PAIRING_KIND,
  E2EE_RUNNER_CERT_KIND,
  E2EE_RUNNER_CODE_PAIRING_KIND,
  E2EE_TRUST_ROOT_KIND,
  e2eeCsAuthGrantSchema,
  e2eeRunnerIdentityCertSchema,
  type E2eeCiphertext,
  type E2eeCsAuthGrant,
  type E2eeCsAuthIntent,
  type E2eeDeviceApprovalDecision,
  type E2eeDeviceApprovalRequest,
  type E2eeHpkeEnvelope,
  type E2eeKeyDescriptor,
  type E2eeMemoryEnvelope,
  type E2eePairingOffer,
  type E2eePairingStart,
  type E2eeProgressEnvelope,
  type E2eePublicKey,
  type E2eeRecoveryPairingOffer,
  type E2eeRunnerCodePairingOffer,
  type E2eeResultEnvelope,
  type E2eeRunRequestEnvelope,
  type E2eeRunnerIdentityCert,
  type E2eeSignature,
  type E2eeTrustRootPublic
} from "@cursor-gateway/shared";
import {
  Aes256Gcm,
  CipherSuite,
  DhkemP256HkdfSha256,
  HkdfSha256
} from "@hpke/core";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const subtle = globalThis.crypto.subtle;
const AEAD_NONCE_LENGTH = 12;
const hpkeSuite = new CipherSuite({
  kem: new DhkemP256HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes256Gcm()
});

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

function assertJsonValue(value: unknown, path = "$"): asserts value is JsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${path}[${index}]`));
    return;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) throw new TypeError(`Undefined JSON value at ${path}.${key}`);
      assertJsonValue(item, `${path}.${key}`);
    }
    return;
  }
  throw new TypeError(`Unsupported JSON value at ${path}`);
}

export function canonicalJson(value: unknown): string {
  assertJsonValue(value);

  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return Object.is(value, -0) ? "0" : JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;

  const entries = Object.entries(value).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0
  );
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

export function canonicalBytes(value: unknown): Uint8Array {
  return encoder.encode(canonicalJson(value));
}

export function utf8(value: string): Uint8Array {
  return encoder.encode(value);
}

export function decodeUtf8(value: Uint8Array): string {
  return decoder.decode(value);
}

export function encodeBase64Url(value: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < value.length; offset += 0x8000) {
    binary += String.fromCharCode(...value.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid_base64url");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new Error("invalid_base64url");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  const output = new Uint8Array(value.byteLength);
  output.set(value);
  return output.buffer;
}

async function sha256(value: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle.digest("SHA-256", toArrayBuffer(value)));
}

function publicJwk(value: JsonWebKey): E2eePublicKey {
  if (value.kty !== "EC" || value.crv !== "P-256" || !value.x || !value.y) {
    throw new Error("invalid_p256_public_key");
  }
  return { kty: "EC", crv: "P-256", x: value.x, y: value.y };
}

function toJwk(value: E2eePublicKey, use: "ECDH" | "ECDSA"): JsonWebKey {
  return {
    ...value,
    ext: true,
    key_ops: use === "ECDH" ? [] : ["verify"]
  };
}

export async function generateHpkeKeyPair(): Promise<CryptoKeyPair> {
  return subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"]
  ) as Promise<CryptoKeyPair>;
}

export async function generateSigningKeyPair(
  extractable = true
): Promise<CryptoKeyPair> {
  return subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    extractable,
    ["sign", "verify"]
  ) as Promise<CryptoKeyPair>;
}

export async function exportE2eePublicKey(key: CryptoKey): Promise<E2eePublicKey> {
  return publicJwk(await subtle.exportKey("jwk", key));
}

export async function exportPrivateJwk(key: CryptoKey): Promise<JsonWebKey> {
  return subtle.exportKey("jwk", key);
}

export async function importHpkePrivateKey(value: JsonWebKey): Promise<CryptoKey> {
  return subtle.importKey(
    "jwk",
    { ...value, ext: true, key_ops: ["deriveBits"] },
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"]
  );
}

export async function importSigningPrivateKey(value: JsonWebKey): Promise<CryptoKey> {
  return subtle.importKey(
    "jwk",
    { ...value, ext: true, key_ops: ["sign"] },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
}

export async function importHpkePublicKey(value: E2eePublicKey): Promise<CryptoKey> {
  return subtle.importKey(
    "jwk",
    toJwk(value, "ECDH"),
    { name: "ECDH", namedCurve: "P-256" },
    true,
    []
  );
}

export async function importSigningPublicKey(value: E2eePublicKey): Promise<CryptoKey> {
  return subtle.importKey(
    "jwk",
    toJwk(value, "ECDSA"),
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["verify"]
  );
}

export async function createKeyDescriptor(key: CryptoKey): Promise<E2eeKeyDescriptor> {
  const exported = await exportE2eePublicKey(key);
  const digest = encodeBase64Url(await sha256(canonicalBytes(exported)));
  return {
    keyId: `p256-${digest.slice(0, 22)}`,
    fingerprint: `sha256:${digest}`,
    publicKey: exported
  };
}

export async function hpkeSeal(
  plaintext: Uint8Array,
  recipient: E2eePublicKey,
  context: unknown
): Promise<E2eeHpkeEnvelope> {
  const recipientKey = await importHpkePublicKey(recipient);
  const additionalData = canonicalBytes(context);
  const info = await sha256(additionalData);
  const sealed = await hpkeSuite.seal(
    {
      recipientPublicKey: recipientKey,
      info: toArrayBuffer(info)
    },
    toArrayBuffer(plaintext),
    toArrayBuffer(additionalData)
  );
  return {
    alg: E2EE_HPKE_SUITE,
    enc: encodeBase64Url(new Uint8Array(sealed.enc)),
    ciphertext: encodeBase64Url(new Uint8Array(sealed.ct))
  };
}

export async function hpkeOpen(
  envelope: E2eeHpkeEnvelope,
  recipientPrivateKey: CryptoKey,
  recipientPublicKey: E2eePublicKey,
  context: unknown
): Promise<Uint8Array> {
  if (envelope.alg !== E2EE_HPKE_SUITE) throw new Error("unsupported_hpke_suite");
  const enc = decodeBase64Url(envelope.enc);
  if (enc.length !== 65 || enc[0] !== 4) throw new Error("invalid_hpke_encapsulation");
  const additionalData = canonicalBytes(context);
  const info = await sha256(additionalData);
  const publicKey = await importHpkePublicKey(recipientPublicKey);
  try {
    return new Uint8Array(
      await hpkeSuite.open(
        {
          recipientKey: {
            privateKey: recipientPrivateKey,
            publicKey
          },
          enc: toArrayBuffer(enc),
          info: toArrayBuffer(info)
        },
        toArrayBuffer(decodeBase64Url(envelope.ciphertext)),
        toArrayBuffer(additionalData)
      )
    );
  } catch {
    throw new Error("hpke_open_failed");
  }
}

export function generateRootKeyBytes(): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(32));
}

export async function importRootKey(
  rootKey: Uint8Array,
  extractable = false
): Promise<CryptoKey> {
  if (rootKey.length !== 32) throw new Error("invalid_root_key_length");
  return subtle.importKey("raw", toArrayBuffer(rootKey), "HKDF", extractable, ["deriveKey"]);
}

async function deriveContentKey(rootKey: CryptoKey, purpose: string): Promise<CryptoKey> {
  return subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: toArrayBuffer(encoder.encode(E2EE_PROTOCOL)),
      info: toArrayBuffer(encoder.encode(`cursor-gateway:${purpose}`))
    },
    rootKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function encryptJson(
  rootKey: CryptoKey,
  purpose: string,
  additionalData: unknown,
  value: unknown
): Promise<E2eeCiphertext> {
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(AEAD_NONCE_LENGTH));
  const key = await deriveContentKey(rootKey, purpose);
  const additionalDataBytes = canonicalBytes(additionalData);
  const plaintext = canonicalBytes(value);
  const ciphertext = new Uint8Array(
    await subtle.encrypt(
      {
        name: "AES-GCM",
        iv: toArrayBuffer(nonce),
        additionalData: toArrayBuffer(additionalDataBytes),
        tagLength: 128
      },
      key,
      toArrayBuffer(plaintext)
    )
  );
  return {
    alg: "A256GCM",
    nonce: encodeBase64Url(nonce),
    ciphertext: encodeBase64Url(ciphertext)
  };
}

export async function decryptJson(
  rootKey: CryptoKey,
  purpose: string,
  additionalData: unknown,
  encrypted: E2eeCiphertext
): Promise<unknown> {
  if (encrypted.alg !== "A256GCM") throw new Error("unsupported_content_cipher");
  const nonce = decodeBase64Url(encrypted.nonce);
  if (nonce.length !== AEAD_NONCE_LENGTH) throw new Error("invalid_content_nonce");
  const key = await deriveContentKey(rootKey, purpose);
  const additionalDataBytes = canonicalBytes(additionalData);
  let plaintext: Uint8Array;
  try {
    plaintext = new Uint8Array(
      await subtle.decrypt(
        {
          name: "AES-GCM",
          iv: toArrayBuffer(nonce),
          additionalData: toArrayBuffer(additionalDataBytes),
          tagLength: 128
        },
        key,
        toArrayBuffer(decodeBase64Url(encrypted.ciphertext))
      )
    );
  } catch {
    throw new Error("content_decryption_failed");
  }
  try {
    return JSON.parse(decodeUtf8(plaintext)) as unknown;
  } catch {
    throw new Error("invalid_encrypted_json");
  }
}

export function unsignedEnvelope<T extends { signature: E2eeSignature }>(
  envelope: T
): Omit<T, "signature"> {
  const { signature: _signature, ...unsigned } = envelope;
  return unsigned;
}

export async function signValue(
  value: unknown,
  privateKey: CryptoKey,
  keyId: string
): Promise<E2eeSignature> {
  const signature = new Uint8Array(
    await subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      privateKey,
      toArrayBuffer(canonicalBytes(value))
    )
  );
  return { alg: "ES256", keyId, value: encodeBase64Url(signature) };
}

export async function verifyValue(
  value: unknown,
  signature: E2eeSignature,
  publicKey: CryptoKey
): Promise<boolean> {
  if (signature.alg !== "ES256") return false;
  try {
    return subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      toArrayBuffer(decodeBase64Url(signature.value)),
      toArrayBuffer(canonicalBytes(value))
    );
  } catch {
    return false;
  }
}

export async function digestValue(value: unknown): Promise<string> {
  return encodeBase64Url(await sha256(canonicalBytes(value)));
}

export async function wrapRootKey(
  rootKey: Uint8Array,
  recipient: E2eePublicKey,
  context: unknown
): Promise<E2eeHpkeEnvelope> {
  if (rootKey.length !== 32) throw new Error("invalid_root_key_length");
  return hpkeSeal(rootKey, recipient, context);
}

export async function unwrapRootKey(
  envelope: E2eeHpkeEnvelope,
  recipientPrivateKey: CryptoKey,
  recipientPublicKey: E2eePublicKey,
  context: unknown
): Promise<CryptoKey> {
  const raw = await hpkeOpen(envelope, recipientPrivateKey, recipientPublicKey, context);
  try {
    return await importRootKey(raw);
  } finally {
    raw.fill(0);
  }
}

export function requestKeyContext(value: {
  conversationId: string;
  clientId: string;
  runnerId: string;
  runnerKeyId: string;
}): JsonValue {
  return {
    protocol: E2EE_PROTOCOL,
    purpose: "conversation-root",
    conversationId: value.conversationId,
    clientId: value.clientId,
    runnerId: value.runnerId,
    runnerKeyId: value.runnerKeyId
  };
}

export function requestPayloadAad(
  value: Omit<E2eeRunRequestEnvelope, "payload" | "signature">
): JsonValue {
  return {
    protocol: value.protocol,
    kind: value.kind,
    messageId: value.messageId,
    runId: value.runId,
    conversationId: value.conversationId,
    clientId: value.clientId,
    clientKeyId: value.clientKeyId,
    runnerId: value.runnerId,
    runnerKeyId: value.runnerKeyId,
    sequence: value.sequence,
    createdAt: value.createdAt,
    routing: value.routing,
    previousDigest: value.previousDigest,
    wrappedConversationKey: value.wrappedConversationKey
  };
}

export function progressPayloadAad(
  value: Omit<E2eeProgressEnvelope, "payload" | "signature">
): JsonValue {
  return {
    protocol: value.protocol,
    kind: value.kind,
    messageId: value.messageId,
    runId: value.runId,
    conversationId: value.conversationId,
    runnerId: value.runnerId,
    runnerKeyId: value.runnerKeyId,
    requestDigest: value.requestDigest,
    sequence: value.sequence,
    progressKind: value.progressKind,
    createdAt: value.createdAt
  };
}

export function resultPayloadAad(
  value: Omit<E2eeResultEnvelope, "payload" | "signature">
): JsonValue {
  return {
    protocol: value.protocol,
    kind: value.kind,
    messageId: value.messageId,
    runId: value.runId,
    conversationId: value.conversationId,
    runnerId: value.runnerId,
    runnerKeyId: value.runnerKeyId,
    requestDigest: value.requestDigest,
    sequence: value.sequence,
    status: value.status,
    createdAt: value.createdAt
  };
}

export function memoryPayloadAad(
  value: Omit<E2eeMemoryEnvelope, "payload" | "signature">
): JsonValue {
  return {
    protocol: value.protocol,
    kind: value.kind,
    messageId: value.messageId,
    memoryId: value.memoryId,
    clientId: value.clientId,
    clientKeyId: value.clientKeyId,
    scope: value.scope,
    workspaceId: value.workspaceId,
    createdAt: value.createdAt
  };
}

/** 256-bit high-entropy magic-link token (base64url, 43 chars). */
export function generateMagicLinkToken(): string {
  return encodeBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(32)));
}

export function generatePairingChallenge(): string {
  return encodeBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * Canonical transcript authenticated by the magic-link token.
 * Gateway never sees the token; only public offer fields enter the relay.
 */
export function pairingTranscript(offer: E2eePairingOffer): JsonValue {
  return {
    protocol: E2EE_PROTOCOL,
    pairingKind: E2EE_PAIRING_KIND,
    purpose: "secure-web-magic-link-transcript",
    pairId: offer.pairId,
    runnerId: offer.runnerId,
    runnerChallenge: offer.runnerChallenge,
    runnerEncryptionFingerprint: offer.runnerEncryptionKey.fingerprint,
    runnerSigningFingerprint: offer.runnerSigningKey.fingerprint,
    clientId: offer.clientId,
    clientChallenge: offer.clientChallenge,
    clientSigningFingerprint: offer.clientSigningFingerprint,
    clientEncryptionFingerprint: offer.clientEncryptionFingerprint,
    secureOrigin: offer.secureOrigin,
    gatewayOrigin: offer.gatewayOrigin,
    expiresAt: offer.expiresAt
  };
}

export async function derivePairingMacKey(token: string): Promise<CryptoKey> {
  const raw = decodeBase64Url(token);
  if (raw.length !== 32) throw new Error("invalid_magic_link_token_length");
  const ikm = await subtle.importKey("raw", toArrayBuffer(raw), "HKDF", false, [
    "deriveKey"
  ]);
  return subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: toArrayBuffer(encoder.encode(E2EE_PROTOCOL)),
      info: toArrayBuffer(encoder.encode("cursor-gateway:secure-web-pairing-mac"))
    },
    ikm,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"]
  );
}

export async function macPairingTranscript(
  token: string,
  offer: E2eePairingOffer
): Promise<string> {
  const key = await derivePairingMacKey(token);
  const mac = new Uint8Array(
    await subtle.sign("HMAC", key, toArrayBuffer(canonicalBytes(pairingTranscript(offer))))
  );
  return encodeBase64Url(mac);
}

export async function verifyPairingTranscriptMac(
  token: string,
  offer: E2eePairingOffer,
  expectedMac: string
): Promise<boolean> {
  try {
    const key = await derivePairingMacKey(token);
    return subtle.verify(
      "HMAC",
      key,
      toArrayBuffer(decodeBase64Url(expectedMac)),
      toArrayBuffer(canonicalBytes(pairingTranscript(offer)))
    );
  } catch {
    return false;
  }
}

/** Generate non-extractable device signing + HPKE key pairs for secure-web. */
export async function generateNonExtractableDeviceKeys(): Promise<{
  signing: CryptoKeyPair;
  encryption: CryptoKeyPair;
}> {
  const [signing, encryption] = await Promise.all([
    generateSigningKeyPair(false),
    subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, [
      "deriveBits"
    ]) as Promise<CryptoKeyPair>
  ]);
  return { signing, encryption };
}

export function buildPairingOffer(input: {
  start: E2eePairingStart;
  runnerId: string;
  runnerChallenge: string;
  runnerEncryptionKey: E2eeKeyDescriptor;
  runnerSigningKey: E2eeKeyDescriptor;
  expiresAt: string;
  emailHint?: string;
}): E2eePairingOffer {
  return {
    protocol: E2EE_PROTOCOL,
    pairingKind: E2EE_PAIRING_KIND,
    pairId: input.start.pairId,
    runnerId: input.runnerId,
    runnerChallenge: input.runnerChallenge,
    runnerEncryptionKey: input.runnerEncryptionKey,
    runnerSigningKey: input.runnerSigningKey,
    clientId: input.start.clientId,
    clientChallenge: input.start.clientChallenge,
    clientSigningFingerprint: input.start.signingKey.fingerprint,
    clientEncryptionFingerprint: input.start.encryptionKey.fingerprint,
    secureOrigin: input.start.secureOrigin,
    gatewayOrigin: input.start.gatewayOrigin,
    ...(input.emailHint ? { emailHint: input.emailHint } : {}),
    expiresAt: input.expiresAt,
    createdAt: new Date().toISOString()
  };
}

export function keyGrantContext(value: {
  conversationId: string;
  clientId: string;
  runnerId: string;
  runnerKeyId: string;
  grantId: string;
}): JsonValue {
  return {
    protocol: E2EE_PROTOCOL,
    purpose: "conversation-key-grant",
    conversationId: value.conversationId,
    clientId: value.clientId,
    runnerId: value.runnerId,
    runnerKeyId: value.runnerKeyId,
    grantId: value.grantId
  };
}

/** Canonical fields bound by the Runner signature on a CS device auth grant. */
export function csAuthGrantTranscript(
  grant: Omit<E2eeCsAuthGrant, "signature">
): JsonValue {
  return {
    protocol: E2EE_PROTOCOL,
    authKind: E2EE_CS_AUTH_KIND,
    purpose: "cs-web-device-auth-grant",
    authId: grant.authId,
    clientId: grant.clientId,
    challenge: grant.challenge,
    state: grant.state,
    signingFingerprint: grant.signingFingerprint,
    encryptionFingerprint: grant.encryptionFingerprint,
    returnOrigin: grant.returnOrigin,
    gatewayOrigin: grant.gatewayOrigin,
    runnerId: grant.runnerId,
    runnerEncryptionFingerprint: grant.runnerEncryptionKey.fingerprint,
    runnerSigningFingerprint: grant.runnerSigningKey.fingerprint,
    ...(grant.runnerCertificate
      ? {
          runnerCertId: grant.runnerCertificate.certId,
          runnerCertRootFingerprint: grant.runnerCertificate.rootFingerprint,
          runnerCertEpoch: grant.runnerCertificate.epoch
        }
      : {}),
    status: grant.status,
    expiresAt: grant.expiresAt,
    createdAt: grant.createdAt
  };
}

export function buildCsAuthGrantUnsigned(input: {
  intent: E2eeCsAuthIntent;
  runnerId: string;
  runnerEncryptionKey: E2eeKeyDescriptor;
  runnerSigningKey: E2eeKeyDescriptor;
  status: "authorized" | "rejected";
  expiresAt: string;
  createdAt?: string;
  runnerCertificate?: E2eeRunnerIdentityCert;
}): Omit<E2eeCsAuthGrant & { runnerCertificate?: E2eeRunnerIdentityCert }, "signature"> {
  return {
    protocol: E2EE_PROTOCOL,
    authKind: E2EE_CS_AUTH_KIND,
    authId: input.intent.authId,
    clientId: input.intent.clientId,
    challenge: input.intent.challenge,
    state: input.intent.state,
    signingFingerprint: input.intent.signingKey.fingerprint,
    encryptionFingerprint: input.intent.encryptionKey.fingerprint,
    returnOrigin: input.intent.returnOrigin,
    gatewayOrigin: input.intent.gatewayOrigin,
    runnerId: input.runnerId,
    runnerEncryptionKey: input.runnerEncryptionKey,
    runnerSigningKey: input.runnerSigningKey,
    status: input.status,
    expiresAt: input.expiresAt,
    createdAt: input.createdAt ?? new Date().toISOString(),
    ...(input.runnerCertificate
      ? { runnerCertificate: input.runnerCertificate }
      : {})
  };
}

export async function signCsAuthGrant(
  unsigned: Omit<E2eeCsAuthGrant, "signature">,
  runnerSigningPrivateKey: CryptoKey,
  runnerSigningKeyId: string
): Promise<E2eeCsAuthGrant> {
  return {
    ...unsigned,
    signature: await signValue(
      csAuthGrantTranscript(unsigned),
      runnerSigningPrivateKey,
      runnerSigningKeyId
    )
  };
}

export async function verifyCsAuthGrant(
  grant: E2eeCsAuthGrant,
  runnerSigningPublicKey: CryptoKey
): Promise<boolean> {
  if (grant.signature.keyId !== grant.runnerSigningKey.keyId) return false;
  return verifyValue(
    csAuthGrantTranscript(unsignedEnvelope(grant)),
    grant.signature,
    runnerSigningPublicKey
  );
}

export type CsAuthRedirectParams = {
  authId: string;
  challenge: string;
  state: string;
  returnOrigin: string;
  signingFingerprint: string;
  encryptionFingerprint: string;
  clientId: string;
};

export function buildCsAuthRedirectUrl(
  secureOrigin: string,
  params: CsAuthRedirectParams
): string {
  const url = new URL(secureOrigin.replace(/\/$/, "") + "/");
  url.searchParams.set("cs_auth", "1");
  url.searchParams.set("auth_id", params.authId);
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("challenge", params.challenge);
  url.searchParams.set("state", params.state);
  url.searchParams.set("return_origin", params.returnOrigin);
  url.searchParams.set("signing_fp", params.signingFingerprint);
  url.searchParams.set("encryption_fp", params.encryptionFingerprint);
  return url.toString();
}

export function parseCsAuthRedirectSearch(search: string): CsAuthRedirectParams | null {
  const params = new URLSearchParams(
    search.startsWith("?") ? search.slice(1) : search
  );
  if (params.get("cs_auth") !== "1") return null;
  const authId = params.get("auth_id") ?? "";
  const clientId = params.get("client_id") ?? "";
  const challenge = params.get("challenge") ?? "";
  const state = params.get("state") ?? "";
  const returnOriginRaw = params.get("return_origin") ?? "";
  const signingFingerprint = params.get("signing_fp") ?? "";
  const encryptionFingerprint = params.get("encryption_fp") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(authId)) return null;
  if (clientId.length < 8 || clientId.length > 128) return null;
  if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) return null;
  if (!/^[A-Za-z0-9_-]{43}$/.test(state)) return null;
  if (!/^sha256:[A-Za-z0-9_-]{43}$/.test(signingFingerprint)) return null;
  if (!/^sha256:[A-Za-z0-9_-]{43}$/.test(encryptionFingerprint)) return null;
  let returnOrigin: string;
  try {
    const parsed = new URL(returnOriginRaw);
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    if (parsed.pathname !== "/" && parsed.pathname !== "") return null;
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    returnOrigin = parsed.origin;
  } catch {
    return null;
  }
  return {
    authId,
    clientId,
    challenge,
    state,
    returnOrigin,
    signingFingerprint,
    encryptionFingerprint
  };
}

export function encodeCsAuthGrantFragment(grant: E2eeCsAuthGrant): string {
  return `#cs_auth=${encodeBase64Url(canonicalBytes(grant))}`;
}

export function parseCsAuthGrantFragment(hash: string): E2eeCsAuthGrant | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const params = new URLSearchParams(raw.includes("=") ? raw : `cs_auth=${raw}`);
  const value = params.get("cs_auth");
  if (!value) return null;
  try {
    const decoded = JSON.parse(decodeUtf8(decodeBase64Url(value))) as unknown;
    return e2eeCsAuthGrantSchema.parse(decoded);
  } catch {
    return null;
  }
}

export function clearCsAuthFragment() {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (!url.hash.includes("cs_auth=")) return;
  url.hash = "";
  window.history.replaceState(null, "", `${url.pathname}${url.search}`);
}

/**
 * Validate a grant against the pending CS redirect session and Runner signature.
 * Does not mark replay; caller must consume via Gateway.
 */
export async function validateCsAuthGrant(input: {
  grant: E2eeCsAuthGrant & { runnerCertificate?: E2eeRunnerIdentityCert };
  expected: {
    authId: string;
    clientId: string;
    challenge: string;
    state: string;
    returnOrigin: string;
    signingFingerprint: string;
    encryptionFingerprint: string;
    gatewayOrigin?: string;
  };
  nowMs?: number;
  /** When set, signature must verify under this pinned Runner key (Secure path). */
  pinnedRunnerSigningKey?: CryptoKey;
  /** Offline trust roots; when non-empty, grant.runnerCertificate is required and verified first. */
  trustRoots?: E2eeTrustRootPublic[];
  expectedSecureOrigin?: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const grant = input.grant;
  const expected = input.expected;
  const now = input.nowMs ?? Date.now();
  if (grant.protocol !== E2EE_PROTOCOL || grant.authKind !== E2EE_CS_AUTH_KIND) {
    return { ok: false, reason: "auth_kind_mismatch" };
  }
  if (grant.status !== "authorized") return { ok: false, reason: "grant_rejected" };
  if (grant.authId !== expected.authId) return { ok: false, reason: "auth_id_mismatch" };
  if (grant.clientId !== expected.clientId) return { ok: false, reason: "client_id_mismatch" };
  if (grant.challenge !== expected.challenge) return { ok: false, reason: "challenge_mismatch" };
  if (grant.state !== expected.state) return { ok: false, reason: "state_mismatch" };
  if (grant.returnOrigin !== expected.returnOrigin) {
    return { ok: false, reason: "return_origin_mismatch" };
  }
  if (grant.signingFingerprint !== expected.signingFingerprint) {
    return { ok: false, reason: "signing_fingerprint_mismatch" };
  }
  if (grant.encryptionFingerprint !== expected.encryptionFingerprint) {
    return { ok: false, reason: "encryption_fingerprint_mismatch" };
  }
  if (
    expected.gatewayOrigin &&
    grant.gatewayOrigin !== expected.gatewayOrigin
  ) {
    return { ok: false, reason: "gateway_origin_mismatch" };
  }
  if (Date.parse(grant.expiresAt) <= now) return { ok: false, reason: "grant_expired" };

  const trustRoots = input.trustRoots ?? [];
  if (trustRoots.length > 0) {
    const certCheck = await validateGrantRunnerCertificate({
      grant,
      trustRoots,
      ...(input.expectedSecureOrigin
        ? { expectedSecureOrigin: input.expectedSecureOrigin }
        : {}),
      nowMs: now
    });
    if (!certCheck.ok) return certCheck;
  }

  const verifyKey =
    input.pinnedRunnerSigningKey ??
    (await importSigningPublicKey(grant.runnerSigningKey.publicKey));
  if (!(await verifyCsAuthGrant(grant, verifyKey))) {
    return { ok: false, reason: "grant_signature_invalid" };
  }
  return { ok: true };
}

// --- Offline trust root / Runner identity certificate ---

export function runnerCertTranscript(
  cert: Omit<E2eeRunnerIdentityCert, "signature">
): JsonValue {
  return {
    protocol: cert.protocol,
    kind: cert.kind,
    version: cert.version,
    certId: cert.certId,
    runnerId: cert.runnerId,
    epoch: cert.epoch,
    encryptionFingerprint: cert.encryptionKey.fingerprint,
    encryptionKeyId: cert.encryptionKey.keyId,
    signingFingerprint: cert.signingKey.fingerprint,
    signingKeyId: cert.signingKey.keyId,
    allowedSecureOrigins: [...cert.allowedSecureOrigins].sort(),
    allowedRpIds: [...cert.allowedRpIds].sort(),
    issuedAt: cert.issuedAt,
    expiresAt: cert.expiresAt,
    rootKeyId: cert.rootKeyId,
    rootFingerprint: cert.rootFingerprint
  };
}

export async function generateTrustRootKeyPair(epoch = 1): Promise<{
  privateJwk: JsonWebKey;
  public: E2eeTrustRootPublic;
  privateKey: CryptoKey;
}> {
  const pair = await generateSigningKeyPair(true);
  const descriptor = await createKeyDescriptor(pair.publicKey);
  const privateJwk = await exportPrivateJwk(pair.privateKey);
  return {
    privateJwk,
    privateKey: pair.privateKey,
    public: {
      protocol: E2EE_PROTOCOL,
      kind: E2EE_TRUST_ROOT_KIND,
      keyId: descriptor.keyId,
      fingerprint: descriptor.fingerprint,
      publicKey: descriptor.publicKey,
      epoch,
      createdAt: new Date().toISOString()
    }
  };
}

export async function importTrustRootPrivateKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return importSigningPrivateKey(jwk);
}

export async function issueRunnerIdentityCert(input: {
  rootPrivateKey: CryptoKey;
  rootPublic: E2eeTrustRootPublic;
  runnerId: string;
  encryptionKey: E2eeKeyDescriptor;
  signingKey: E2eeKeyDescriptor;
  allowedSecureOrigins: string[];
  allowedRpIds: string[];
  epoch?: number;
  validityDays?: number;
  issuedAt?: string;
}): Promise<E2eeRunnerIdentityCert> {
  const issuedAt = input.issuedAt ?? new Date().toISOString();
  const validityDays = input.validityDays ?? 365;
  const expiresAt = new Date(Date.parse(issuedAt) + validityDays * 86_400_000).toISOString();
  const unsigned: Omit<E2eeRunnerIdentityCert, "signature"> = {
    protocol: E2EE_PROTOCOL,
    kind: E2EE_RUNNER_CERT_KIND,
    version: 1,
    certId: crypto.randomUUID(),
    runnerId: input.runnerId,
    epoch: input.epoch ?? input.rootPublic.epoch,
    encryptionKey: input.encryptionKey,
    signingKey: input.signingKey,
    allowedSecureOrigins: input.allowedSecureOrigins,
    allowedRpIds: input.allowedRpIds,
    issuedAt,
    expiresAt,
    rootKeyId: input.rootPublic.keyId,
    rootFingerprint: input.rootPublic.fingerprint
  };
  const signature = await signValue(
    runnerCertTranscript(unsigned),
    input.rootPrivateKey,
    input.rootPublic.keyId
  );
  return e2eeRunnerIdentityCertSchema.parse({ ...unsigned, signature });
}

export type RunnerCertValidation =
  | { ok: true; root: E2eeTrustRootPublic }
  | { ok: false; reason: string };

export async function verifyRunnerIdentityCert(input: {
  cert: E2eeRunnerIdentityCert;
  trustRoots: E2eeTrustRootPublic[];
  expected?: {
    runnerId?: string;
    epoch?: number;
    secureOrigin?: string;
    rpId?: string;
    encryptionFingerprint?: string;
    signingFingerprint?: string;
  };
  nowMs?: number;
}): Promise<RunnerCertValidation> {
  const cert = input.cert;
  const now = input.nowMs ?? Date.now();
  if (cert.protocol !== E2EE_PROTOCOL || cert.kind !== E2EE_RUNNER_CERT_KIND) {
    return { ok: false, reason: "cert_kind_mismatch" };
  }
  if (cert.version !== 1) return { ok: false, reason: "cert_version_unsupported" };
  if (Date.parse(cert.expiresAt) <= now) return { ok: false, reason: "cert_expired" };
  if (Date.parse(cert.issuedAt) > now + 60_000) return { ok: false, reason: "cert_not_yet_valid" };
  if (input.expected?.runnerId && cert.runnerId !== input.expected.runnerId) {
    return { ok: false, reason: "cert_runner_mismatch" };
  }
  if (input.expected?.epoch !== undefined && cert.epoch !== input.expected.epoch) {
    return { ok: false, reason: "cert_epoch_mismatch" };
  }
  if (
    input.expected?.encryptionFingerprint &&
    cert.encryptionKey.fingerprint !== input.expected.encryptionFingerprint
  ) {
    return { ok: false, reason: "cert_encryption_fingerprint_mismatch" };
  }
  if (
    input.expected?.signingFingerprint &&
    cert.signingKey.fingerprint !== input.expected.signingFingerprint
  ) {
    return { ok: false, reason: "cert_signing_fingerprint_mismatch" };
  }
  if (
    input.expected?.secureOrigin &&
    !cert.allowedSecureOrigins.includes(input.expected.secureOrigin)
  ) {
    return { ok: false, reason: "cert_secure_origin_not_allowed" };
  }
  if (input.expected?.rpId && !cert.allowedRpIds.includes(input.expected.rpId)) {
    return { ok: false, reason: "cert_rp_id_not_allowed" };
  }
  const root = input.trustRoots.find(
    (candidate) =>
      candidate.keyId === cert.rootKeyId &&
      candidate.fingerprint === cert.rootFingerprint
  );
  if (!root) return { ok: false, reason: "trust_root_not_found" };
  const rootKey = await importSigningPublicKey(root.publicKey);
  if (cert.signature.keyId !== root.keyId) {
    return { ok: false, reason: "cert_signature_key_mismatch" };
  }
  const valid = await verifyValue(
    runnerCertTranscript(unsignedEnvelope(cert)),
    cert.signature,
    rootKey
  );
  if (!valid) return { ok: false, reason: "cert_signature_invalid" };
  return { ok: true, root };
}

export async function validateGrantRunnerCertificate(input: {
  grant: E2eeCsAuthGrant & { runnerCertificate?: E2eeRunnerIdentityCert };
  trustRoots: E2eeTrustRootPublic[];
  expectedSecureOrigin?: string;
  nowMs?: number;
}): Promise<RunnerCertValidation> {
  const cert = input.grant.runnerCertificate;
  if (!cert) return { ok: false, reason: "runner_certificate_required" };
  if (input.trustRoots.length === 0) {
    return { ok: false, reason: "trust_roots_not_configured" };
  }
  return verifyRunnerIdentityCert({
    cert,
    trustRoots: input.trustRoots,
    expected: {
      runnerId: input.grant.runnerId,
      encryptionFingerprint: input.grant.runnerEncryptionKey.fingerprint,
      signingFingerprint: input.grant.runnerSigningKey.fingerprint,
      ...(input.expectedSecureOrigin
        ? { secureOrigin: input.expectedSecureOrigin }
        : {})
    },
    ...(input.nowMs !== undefined ? { nowMs: input.nowMs } : {})
  });
}

// --- High-entropy recovery secret (not OTP) ---

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 256-bit recovery secret as base64url (43 chars). */
export function generateRecoverySecret(): string {
  return encodeBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(32)));
}

/** Encode 128+ bit material as Crockford base32 groups for manual entry. */
export function encodeCrockfordGrouped(secretBase64Url: string, groups = 8): string {
  const bytes = decodeBase64Url(secretBase64Url);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31];
  const chunk = Math.ceil(out.length / groups);
  const parts: string[] = [];
  for (let i = 0; i < out.length; i += chunk) parts.push(out.slice(i, i + chunk));
  return parts.join("-");
}

/** Decode Crockford-grouped display form back to the base64url recovery secret. */
export function decodeCrockfordGrouped(grouped: string, expectedBytes = 32): string {
  const normalized = grouped
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of normalized) {
    const index = CROCKFORD.indexOf(ch);
    if (index < 0) throw new Error("invalid_crockford_character");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  if (bytes.length < expectedBytes) throw new Error("invalid_crockford_length");
  return encodeBase64Url(Uint8Array.from(bytes.slice(0, expectedBytes)));
}

/**
 * Accept either the raw base64url recovery secret or its Crockford display form.
 */
export function normalizeRecoverySecretInput(raw: string): string {
  const trimmed = raw.trim();
  if (/^[A-Za-z0-9_-]{43}$/.test(trimmed)) return trimmed;
  // Grouped / ungrouped Crockford (I/L/O tolerated; decode normalizes them).
  const crockfordLike = /^[0-9A-HJKMNPQRSTVWXYZa-hjmnpqrstvwxyzILOilo\s-]+$/;
  if (crockfordLike.test(trimmed) && /[0-9A-Ha-hJjKkMmNnPpQqRrSsTtVvWwXxYyZzIlOo-]/.test(trimmed)) {
    return decodeCrockfordGrouped(trimmed);
  }
  throw new Error("invalid_recovery_secret_format");
}

export function recoveryPairingTranscript(offer: E2eeRecoveryPairingOffer): JsonValue {
  return {
    protocol: E2EE_PROTOCOL,
    pairingKind: E2EE_RECOVERY_PAIRING_KIND,
    purpose: "secure-web-recovery-transcript",
    pairId: offer.pairId,
    runnerId: offer.runnerId,
    runnerChallenge: offer.runnerChallenge,
    runnerEncryptionFingerprint: offer.runnerEncryptionKey.fingerprint,
    runnerSigningFingerprint: offer.runnerSigningKey.fingerprint,
    runnerCertId: offer.runnerCertificate.certId,
    clientId: offer.clientId,
    clientChallenge: offer.clientChallenge,
    clientSigningFingerprint: offer.clientSigningFingerprint,
    clientEncryptionFingerprint: offer.clientEncryptionFingerprint,
    secureOrigin: offer.secureOrigin,
    gatewayOrigin: offer.gatewayOrigin,
    expiresAt: offer.expiresAt
  };
}

export async function deriveRecoveryMacKey(secret: string): Promise<CryptoKey> {
  const raw = decodeBase64Url(secret);
  if (raw.length < 16) throw new Error("invalid_recovery_secret_length");
  const ikm = await subtle.importKey("raw", toArrayBuffer(raw), "HKDF", false, [
    "deriveKey"
  ]);
  return subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: toArrayBuffer(encoder.encode(E2EE_PROTOCOL)),
      info: toArrayBuffer(encoder.encode("cursor-gateway:secure-web-recovery-mac"))
    },
    ikm,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"]
  );
}

export async function macRecoveryTranscript(
  secret: string,
  offer: E2eeRecoveryPairingOffer
): Promise<string> {
  const key = await deriveRecoveryMacKey(secret);
  const mac = new Uint8Array(
    await subtle.sign(
      "HMAC",
      key,
      toArrayBuffer(canonicalBytes(recoveryPairingTranscript(offer)))
    )
  );
  return encodeBase64Url(mac);
}

export async function verifyRecoveryTranscriptMac(
  secret: string,
  offer: E2eeRecoveryPairingOffer,
  expectedMac: string
): Promise<boolean> {
  try {
    const key = await deriveRecoveryMacKey(secret);
    return subtle.verify(
      "HMAC",
      key,
      toArrayBuffer(decodeBase64Url(expectedMac)),
      toArrayBuffer(canonicalBytes(recoveryPairingTranscript(offer)))
    );
  } catch {
    return false;
  }
}

// --- Runner-assisted manual code (RAMC): secure-web-runner-code/1 ---

/**
 * 256-word SAS lexicon (1 byte → 1 word). Short, phonetically distinct common
 * words so an operator can read a 6-word code aloud / compare it on-screen.
 * Index = byte value; the list MUST stay exactly 256 entries and MUST NOT be
 * reordered (it is part of the wire-visible SAS derivation).
 */
export const RAMC_SAS_WORDLIST: readonly string[] = (
  "acid acorn actor agent alarm album alert alien alpha amber angel apple april arena armor arrow " +
  "aspen atlas atom aura axis bacon badge baker banjo basil beach beacon beans beard beast begin " +
  "bench berry bison black blade blaze bliss block bloom board bonus boost booth brave bread brick " +
  "broom brush cabin cable cacao cadet camel candy canoe canon cargo carol catch cedar chalk charm " +
  "chess chief chili chord cider cigar civic clamp clay cliff cloak clock cloud clover coach cobra " +
  "cocoa comet coral cover crane crate cream crest crisp crown cube curve dance dawn debut decoy " +
  "delta demon depot diary diver dodge donor dough dozen draft drama dream drift drum eagle early " +
  "earth easel ebony echo edge eject elbow elder elf ember emu envoy epic equal ether ever exit " +
  "fable fairy fancy fang feast fern fever fiber field flame flash fleet flint float flood flora " +
  "flour focus forge fox frame frost fruit fuel gamma garlic gate gecko genie ghost giant glade " +
  "glass globe glory glove gnome grade grain grape grass green grill grove guard guest gulf habit " +
  "harp hazel heart hedge helm herb hero hive honey hood horn hotel hound hue human ice icon idea " +
  "igloo image indgo input iris iron ivory ivy jade jazz jelly jewel joker jolly juice july jumbo " +
  "juno kayak kebab kelp kettle key kiwi knight koala label lace lake lamp lance larch laser latch " +
  "lava layer leaf ledge lemon lens level lever lilac lily lime linen lion llama lobby locus lotus " +
  "lunar lynx macro magic mango maple march mask maze meadow melon"
).trim().split(/\s+/);

/** 128-bit one-time device code as base64url (22 chars). Generated on the Runner. */
export function generateRunnerDeviceCode(): string {
  return encodeBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(16)));
}

/** Human display form: Crockford base32 in groups (e.g. XXXX-XXXX-XXXX-XXXX). */
export function runnerDeviceCodeDisplay(codeBase64Url: string): string {
  return encodeCrockfordGrouped(codeBase64Url, 5);
}

/** Accept the raw base64url code or its Crockford display form; returns base64url. */
export function normalizeRunnerDeviceCodeInput(raw: string): string {
  const trimmed = raw.trim();
  if (/^[A-Za-z0-9_-]{22}$/.test(trimmed)) return trimmed;
  const crockfordLike = /^[0-9A-HJKMNPQRSTVWXYZa-hjmnpqrstvwxyzILOilo\s-]+$/;
  if (crockfordLike.test(trimmed) && trimmed.replace(/[\s-]/g, "").length >= 20) {
    return decodeCrockfordGrouped(trimmed, 16);
  }
  throw new Error("invalid_runner_device_code_format");
}

/**
 * Canonical transcript authenticated by the one-time code. Binds every field
 * the P0 spec requires: enrollId, serverNonce, both parties' signing +
 * encryption fingerprints, the Runner cert id, the root id/fingerprint/epoch,
 * and the origins. The Gateway never sees the code; only this public material.
 */
export function runnerCodePairingTranscript(offer: E2eeRunnerCodePairingOffer): JsonValue {
  return {
    protocol: E2EE_PROTOCOL,
    pairingKind: E2EE_RUNNER_CODE_PAIRING_KIND,
    purpose: "secure-web-runner-code-transcript",
    enrollId: offer.enrollId,
    serverNonce: offer.serverNonce,
    runnerId: offer.runnerId,
    runnerChallenge: offer.runnerChallenge,
    runnerEncryptionFingerprint: offer.runnerEncryptionKey.fingerprint,
    runnerSigningFingerprint: offer.runnerSigningKey.fingerprint,
    runnerCertId: offer.runnerCertificate.certId,
    rootKeyId: offer.runnerCertificate.rootKeyId,
    rootFingerprint: offer.runnerCertificate.rootFingerprint,
    rootEpoch: offer.runnerCertificate.epoch,
    clientId: offer.clientId,
    clientChallenge: offer.clientChallenge,
    clientSigningFingerprint: offer.clientSigningFingerprint,
    clientEncryptionFingerprint: offer.clientEncryptionFingerprint,
    secureOrigin: offer.secureOrigin,
    gatewayOrigin: offer.gatewayOrigin,
    expiresAt: offer.expiresAt
  };
}

async function deriveRunnerCodeKey(
  code: string,
  purpose: "mac" | "sas"
): Promise<CryptoKey> {
  const raw = decodeBase64Url(code);
  if (raw.length !== 16) throw new Error("invalid_runner_device_code_length");
  const ikm = await subtle.importKey("raw", toArrayBuffer(raw), "HKDF", false, ["deriveKey"]);
  return subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: toArrayBuffer(encoder.encode(E2EE_PROTOCOL)),
      info: toArrayBuffer(encoder.encode(`cursor-gateway:secure-web-runner-code-${purpose}`))
    },
    ikm,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"]
  );
}

export async function macRunnerCodeTranscript(
  code: string,
  offer: E2eeRunnerCodePairingOffer
): Promise<string> {
  const key = await deriveRunnerCodeKey(code, "mac");
  const mac = new Uint8Array(
    await subtle.sign("HMAC", key, toArrayBuffer(canonicalBytes(runnerCodePairingTranscript(offer))))
  );
  return encodeBase64Url(mac);
}

export async function verifyRunnerCodeTranscriptMac(
  code: string,
  offer: E2eeRunnerCodePairingOffer,
  expectedMac: string
): Promise<boolean> {
  try {
    const key = await deriveRunnerCodeKey(code, "mac");
    return subtle.verify(
      "HMAC",
      key,
      toArrayBuffer(decodeBase64Url(expectedMac)),
      toArrayBuffer(canonicalBytes(runnerCodePairingTranscript(offer)))
    );
  } catch {
    return false;
  }
}

/**
 * 6-word Short Authentication String bound to the code AND the full transcript.
 * Both the Runner terminal and the browser compute it independently; they match
 * iff the same code was used over the same (untampered) transcript — this is the
 * human channel that detects a relay tampering with public keys/origins.
 */
export async function runnerCodeSas(
  code: string,
  offer: E2eeRunnerCodePairingOffer
): Promise<string[]> {
  const key = await deriveRunnerCodeKey(code, "sas");
  const mac = new Uint8Array(
    await subtle.sign("HMAC", key, toArrayBuffer(canonicalBytes(runnerCodePairingTranscript(offer))))
  );
  return Array.from(mac.subarray(0, 6), (byte) => RAMC_SAS_WORDLIST[byte]!);
}

/**
 * Deterministic 6-word SAS over a PUBLIC trust-root fingerprint (RAMC P4).
 * No secret involved — this is a human-comparable encoding of which offline
 * root the client is pinned to. The mobile PWA and the Runner terminal (or an
 * already-authorized device) compute the same words from the same fingerprint;
 * the human compares them on first install to detect a swapped rogue root.
 */
export async function trustRootSas(fingerprint: string): Promise<string[]> {
  const digest = await sha256(utf8(`cursor-gateway:trust-root-sas:${fingerprint}`));
  return Array.from(digest.subarray(0, 6), (byte) => RAMC_SAS_WORDLIST[byte]!);
}

export function runnerCodeSasEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i]!.toLowerCase() !== b[i]!.toLowerCase()) mismatch += 1;
  }
  return mismatch === 0;
}

/** Device-approval transcript signed by an already-paired device. */
export function deviceApprovalTranscript(
  request: E2eeDeviceApprovalRequest,
  decision: Omit<E2eeDeviceApprovalDecision, "signature">
): JsonValue {
  return {
    protocol: E2EE_PROTOCOL,
    approvalKind: E2EE_DEVICE_APPROVAL_KIND,
    purpose: "paired-device-approval-decision",
    approvalId: request.approvalId,
    newClientId: request.newClientId,
    newSigningFingerprint: request.newSigningFingerprint,
    newEncryptionFingerprint: request.newEncryptionFingerprint,
    secureOrigin: request.secureOrigin,
    gatewayOrigin: request.gatewayOrigin,
    expiresAt: request.expiresAt,
    approverClientId: decision.approverClientId,
    decision: decision.decision,
    createdAt: decision.createdAt
  };
}

export async function signDeviceApprovalDecision(input: {
  request: E2eeDeviceApprovalRequest;
  approverClientId: string;
  decision: "approved" | "rejected";
  signingPrivateKey: CryptoKey;
  signingKeyId: string;
}): Promise<E2eeDeviceApprovalDecision> {
  const unsigned: Omit<E2eeDeviceApprovalDecision, "signature"> = {
    protocol: E2EE_PROTOCOL,
    approvalKind: E2EE_DEVICE_APPROVAL_KIND,
    approvalId: input.request.approvalId,
    approverClientId: input.approverClientId,
    decision: input.decision,
    createdAt: new Date().toISOString()
  };
  return {
    ...unsigned,
    signature: await signValue(
      deviceApprovalTranscript(input.request, unsigned),
      input.signingPrivateKey,
      input.signingKeyId
    )
  };
}

export async function verifyDeviceApprovalDecision(input: {
  request: E2eeDeviceApprovalRequest;
  decision: E2eeDeviceApprovalDecision;
  approverSigningPublicKey: CryptoKey;
}): Promise<boolean> {
  if (input.decision.approvalId !== input.request.approvalId) return false;
  return verifyValue(
    deviceApprovalTranscript(input.request, unsignedEnvelope(input.decision)),
    input.decision.signature,
    input.approverSigningPublicKey
  );
}

// cg-mitm/1 helpers (Ed25519 root, purpose/AAD, server/device cert). Exported
// last so the primitives above are initialized before cgMitm.ts imports them.
export * from "./cgMitm.js";
export * from "./csRelay.js";
