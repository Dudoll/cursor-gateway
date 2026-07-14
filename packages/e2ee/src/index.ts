import {
  E2EE_CS_AUTH_KIND,
  E2EE_HPKE_SUITE,
  E2EE_PAIRING_KIND,
  E2EE_PROTOCOL,
  e2eeCsAuthGrantSchema,
  type E2eeCiphertext,
  type E2eeCsAuthGrant,
  type E2eeCsAuthIntent,
  type E2eeHpkeEnvelope,
  type E2eeKeyDescriptor,
  type E2eeMemoryEnvelope,
  type E2eePairingOffer,
  type E2eePairingStart,
  type E2eeProgressEnvelope,
  type E2eePublicKey,
  type E2eeResultEnvelope,
  type E2eeRunRequestEnvelope,
  type E2eeSignature
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
}): Omit<E2eeCsAuthGrant, "signature"> {
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
    createdAt: input.createdAt ?? new Date().toISOString()
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
  grant: E2eeCsAuthGrant;
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

  const verifyKey =
    input.pinnedRunnerSigningKey ??
    (await importSigningPublicKey(grant.runnerSigningKey.publicKey));
  if (input.pinnedRunnerSigningKey) {
    // Pin continuity: grant must advertise the same key id / fingerprint as pin.
    // Fingerprint check is done by caller comparing descriptors when available.
  }
  if (!(await verifyCsAuthGrant(grant, verifyKey))) {
    return { ok: false, reason: "grant_signature_invalid" };
  }
  return { ok: true };
}
