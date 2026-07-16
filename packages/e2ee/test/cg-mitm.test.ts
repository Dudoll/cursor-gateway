import assert from "node:assert/strict";
import test from "node:test";
import {
  buildC2sAad,
  buildHandshakeContext,
  createKeyDescriptor,
  decryptJson,
  encryptJson,
  exportE2eePublicKey,
  generateCgEd25519KeyPair,
  generateCgTrustRootKeyPair,
  generateHpkeKeyPair,
  generateRootKeyBytes,
  generateSigningKeyPair,
  importRootKey,
  importSigningPublicKey,
  issueCgDeviceCert,
  issueCgServerIdentityCert,
  sessionIdFromHpkeEnc,
  signCgEdDsa,
  signValue,
  verifyCgDeviceCert,
  verifyCgServerIdentityCert,
  verifyCgSignature,
  C2S_PURPOSE
} from "../src/index.js";
import { CG_MITM_PURPOSE_C2S } from "@cursor-gateway/shared";

async function serverKeyDescriptors() {
  const [hpke, signing] = await Promise.all([generateHpkeKeyPair(), generateSigningKeyPair()]);
  const [hpkeKey, signingKey] = await Promise.all([
    createKeyDescriptor(hpke.publicKey),
    createKeyDescriptor(signing.publicKey)
  ]);
  return { hpke, signing, hpkeKey, signingKey };
}

test("Ed25519 sign + alg-dispatched verify (EdDSA)", async () => {
  const pair = await generateCgEd25519KeyPair();
  const value = { protocol: "cg-mitm/1", hello: "world", n: 7 };
  const sig = await signCgEdDsa(value, pair.privateKey, "ed25519-testkey0000000");
  assert.equal(sig.alg, "EdDSA");
  assert.equal(sig.value.length, 86);
  assert.equal(await verifyCgSignature(value, sig, pair.publicKey), true);
  // Tamper → fail.
  assert.equal(await verifyCgSignature({ ...value, n: 8 }, sig, pair.publicKey), false);
});

test("verifyCgSignature dispatches to ES256 path", async () => {
  const signing = await generateSigningKeyPair();
  const value = { a: 1, b: "x" };
  const sig = await signValue(value, signing.privateKey, "p256-testkey0000000000");
  assert.equal(await verifyCgSignature(value, sig, signing.publicKey), true);
});

test("cg trust root issues + verifies server identity cert", async () => {
  const root = await generateCgTrustRootKeyPair(1);
  assert.equal(root.public.alg, "EdDSA");
  const server = await serverKeyDescriptors();
  const cert = await issueCgServerIdentityCert({
    rootPrivateKey: root.privateKey,
    rootPublic: root.public,
    serverId: "csapi.joelzt.org",
    hpkeKey: server.hpkeKey,
    signingKey: server.signingKey,
    allowedOrigins: ["https://csapi.joelzt.org"],
    validityDays: 30
  });
  const ok = await verifyCgServerIdentityCert({
    cert,
    trustRoots: [root.public],
    expected: {
      serverId: "csapi.joelzt.org",
      origin: "https://csapi.joelzt.org",
      hpkeFingerprint: server.hpkeKey.fingerprint,
      signingFingerprint: server.signingKey.fingerprint
    }
  });
  assert.equal(ok.ok, true);
});

test("server cert rejects expiry, tamper, wrong root, wrong origin", async () => {
  const root = await generateCgTrustRootKeyPair(2);
  const server = await serverKeyDescriptors();
  const cert = await issueCgServerIdentityCert({
    rootPrivateKey: root.privateKey,
    rootPublic: root.public,
    serverId: "csapi.joelzt.org",
    hpkeKey: server.hpkeKey,
    signingKey: server.signingKey,
    allowedOrigins: ["https://csapi.joelzt.org"],
    validityDays: 1
  });

  const expired = await verifyCgServerIdentityCert({
    cert,
    trustRoots: [root.public],
    nowMs: Date.parse(cert.expiresAt) + 1000
  });
  assert.equal(expired.ok, false);
  if (!expired.ok) assert.equal(expired.reason, "cert_expired");

  const wrongOrigin = await verifyCgServerIdentityCert({
    cert,
    trustRoots: [root.public],
    expected: { origin: "https://evil.example" }
  });
  assert.equal(wrongOrigin.ok, false);
  if (!wrongOrigin.ok) assert.equal(wrongOrigin.reason, "cert_origin_not_allowed");

  const otherRoot = await generateCgTrustRootKeyPair(2);
  const wrongRoot = await verifyCgServerIdentityCert({ cert, trustRoots: [otherRoot.public] });
  assert.equal(wrongRoot.ok, false);
  if (!wrongRoot.ok) assert.equal(wrongRoot.reason, "trust_root_not_found");

  const tampered = { ...cert, serverId: "evil.example" };
  const tamper = await verifyCgServerIdentityCert({ cert: tampered, trustRoots: [root.public] });
  assert.equal(tamper.ok, false);
  if (!tamper.ok) assert.equal(tamper.reason, "cert_signature_invalid");
});

test("device cert signed by server ES256 verifies + tamper fails", async () => {
  const server = await serverKeyDescriptors();
  const device = await serverKeyDescriptors();
  const cert = await issueCgDeviceCert({
    signingPrivateKey: server.signing.privateKey,
    signingKeyId: server.signingKey.keyId,
    deviceId: crypto.randomUUID(),
    signingKey: device.signingKey,
    encryptionKey: device.hpkeKey,
    keyIdHint: "csapi-key-0001",
    serverCertId: crypto.randomUUID(),
    validityDays: 30
  });
  const serverSigningPublic = await importSigningPublicKey(await exportE2eePublicKey(server.signing.publicKey));
  assert.equal(await verifyCgDeviceCert({ cert, serverSigningPublicKey: serverSigningPublic }), true);
  const tampered = { ...cert, keyIdHint: "csapi-key-9999" };
  assert.equal(
    await verifyCgDeviceCert({ cert: tampered, serverSigningPublicKey: serverSigningPublic }),
    false
  );
});

test("purpose alias matches shared constant", () => {
  assert.equal(C2S_PURPOSE, CG_MITM_PURPOSE_C2S);
});

test("c2s frame AEAD binds AAD (tamper of routing header fails)", async () => {
  const rootBytes = generateRootKeyBytes();
  const sessionRoot = await importRootKey(rootBytes);
  const aad = buildC2sAad({ sessionId: "s".repeat(43), sequence: 1, kind: "exchange-request" });
  const value = { protocol: "cg-mitm/1", kind: "exchange-inner", apiKey: "secret" };
  const ct = await encryptJson(sessionRoot, C2S_PURPOSE, aad, value);
  const roundtrip = await decryptJson(sessionRoot, C2S_PURPOSE, aad, ct);
  assert.deepEqual(roundtrip, value);

  // Tampering the sequence in the AAD → AEAD open fails.
  const tamperedAad = buildC2sAad({ sessionId: "s".repeat(43), sequence: 2, kind: "exchange-request" });
  await assert.rejects(() => decryptJson(sessionRoot, C2S_PURPOSE, tamperedAad, ct));
});

test("handshake context + sessionId derivation are deterministic", async () => {
  const ctx = buildHandshakeContext({
    serverCertId: "cert-1",
    epoch: 3,
    deviceId: "dev-1",
    adapterNonce: "n".repeat(43),
    minSuite: "HPKE-v1-P256-HKDF-SHA256-A256GCM"
  });
  assert.equal((ctx as { purpose: string }).purpose, "handshake");
  const enc = "A".repeat(87);
  const a = await sessionIdFromHpkeEnc(enc);
  const b = await sessionIdFromHpkeEnc(enc);
  assert.equal(a, b);
  assert.equal(a.length, 43);
});
