import assert from "node:assert/strict";
import test from "node:test";
import { e2eeRunRequestEnvelopeSchema } from "@cursor-gateway/shared";
import {
  canonicalJson,
  createKeyDescriptor,
  decryptJson,
  encryptJson,
  exportE2eePublicKey,
  exportPrivateJwk,
  generateHpkeKeyPair,
  generateRootKeyBytes,
  generateSigningKeyPair,
  importRootKey,
  importHpkePrivateKey,
  requestKeyContext,
  signValue,
  unwrapRootKey,
  verifyValue,
  wrapRootKey
} from "../src/index.js";

test("canonical JSON is stable and rejects undefined", () => {
  assert.equal(
    canonicalJson({ z: [3, { b: true, a: "x" }], a: -0 }),
    '{"a":0,"z":[3,{"a":"x","b":true}]}'
  );
  assert.throws(() => canonicalJson({ unsafe: undefined }), /Undefined JSON value/);
});

test("HPKE wraps a conversation root only for the intended context", async () => {
  const runnerKeys = await generateHpkeKeyPair();
  const runnerPublic = await exportE2eePublicKey(runnerKeys.publicKey);
  const descriptor = await createKeyDescriptor(runnerKeys.publicKey);
  const context = requestKeyContext({
    conversationId: "b4a681ff-e791-40fb-ac2c-8f1ee48f214d",
    clientId: "client-test-1",
    runnerId: "runner-test",
    runnerKeyId: descriptor.keyId
  });
  const rawRoot = generateRootKeyBytes();
  const wrapped = await wrapRootKey(rawRoot, runnerPublic, context);
  const opened = await unwrapRootKey(
    wrapped,
    runnerKeys.privateKey,
    runnerPublic,
    context
  );

  const routing = {
    runId: "598a8fdb-73db-4588-bd10-8e6665a55d4e",
    conversationId: "b4a681ff-e791-40fb-ac2c-8f1ee48f214d",
    sequence: 1
  };
  const encrypted = await encryptJson(opened, "browser-to-runner:run-request", routing, {
    prompt: "sentinel-secret"
  });
  assert.deepEqual(
    await decryptJson(opened, "browser-to-runner:run-request", routing, encrypted),
    { prompt: "sentinel-secret" }
  );

  await assert.rejects(
    unwrapRootKey(
      wrapped,
      runnerKeys.privateKey,
      runnerPublic,
      { ...context, runnerId: "attacker-runner" }
    ),
    /hpke_open_failed/
  );
  rawRoot.fill(0);
});

test("HPKE private keys survive protected-state export and import", async () => {
  for (let index = 0; index < 12; index += 1) {
    const generated = await generateHpkeKeyPair();
    const publicKey = await exportE2eePublicKey(generated.publicKey);
    const importedPrivate = await importHpkePrivateKey(
      await exportPrivateJwk(generated.privateKey)
    );
    const context = { protocol: "cg-e2ee/1", purpose: "state-round-trip", index };
    const plaintext = generateRootKeyBytes();
    const sealed = await wrapRootKey(plaintext, publicKey, context);
    const opened = await unwrapRootKey(
      sealed,
      importedPrivate,
      publicKey,
      context
    );
    const encrypted = await encryptJson(opened, "state-round-trip", context, {
      index
    });
    assert.deepEqual(
      await decryptJson(opened, "state-round-trip", context, encrypted),
      { index }
    );
    plaintext.fill(0);
  }
});

test("AES-GCM binds ciphertext to purpose and metadata", async () => {
  const root = await importRootKey(generateRootKeyBytes());
  const aad = { runId: "4fb2f663-3eaf-4fcb-90da-a38eeb33f48c", sequence: 4 };
  const encrypted = await encryptJson(root, "runner-to-browser:run-result", aad, {
    response: "private response"
  });

  await assert.rejects(
    decryptJson(
      root,
      "runner-to-browser:run-result",
      { ...aad, sequence: 5 },
      encrypted
    ),
    /content_decryption_failed/
  );
  await assert.rejects(
    decryptJson(root, "browser-to-runner:run-request", aad, encrypted),
    /content_decryption_failed/
  );
  const replacement = encrypted.ciphertext.startsWith("A") ? "B" : "A";
  await assert.rejects(
    decryptJson(
      root,
      "runner-to-browser:run-result",
      aad,
      { ...encrypted, ciphertext: replacement + encrypted.ciphertext.slice(1) }
    ),
    /content_decryption_failed/
  );
  await assert.rejects(
    decryptJson(
      await importRootKey(generateRootKeyBytes()),
      "runner-to-browser:run-result",
      aad,
      encrypted
    ),
    /content_decryption_failed/
  );
});

test("ECDSA rejects modified signed metadata", async () => {
  const keys = await generateSigningKeyPair();
  const value = {
    protocol: "cg-e2ee/1",
    runId: "b55daf7f-36af-4fc4-94ef-a98cb409d909",
    allowWrites: false
  };
  const descriptor = await createKeyDescriptor(keys.publicKey);
  const signature = await signValue(value, keys.privateKey, descriptor.keyId);

  assert.equal(await verifyValue(value, signature, keys.publicKey), true);
  assert.equal(
    await verifyValue({ ...value, allowWrites: true }, signature, keys.publicKey),
    false
  );
});

test("network schema is strict and never accepts a plaintext prompt", () => {
  const result = e2eeRunRequestEnvelopeSchema.safeParse({
    protocol: "cg-e2ee/1",
    kind: "run-request",
    prompt: "plaintext must not be accepted"
  });
  assert.equal(result.success, false);
});

test("magic-link pairing MAC authenticates the full transcript", async () => {
  const { generateMagicLinkToken, macPairingTranscript, verifyPairingTranscriptMac, createKeyDescriptor, generateSigningKeyPair, generateHpkeKeyPair, exportE2eePublicKey } =
    await import("../src/index.js");
  const token = generateMagicLinkToken();
  const [clientSign, clientEnc, runnerSign, runnerEnc] = await Promise.all([
    generateSigningKeyPair(),
    generateHpkeKeyPair(),
    generateSigningKeyPair(),
    generateHpkeKeyPair()
  ]);
  const [clientSigning, clientEncryption, runnerSigning, runnerEncryption] =
    await Promise.all([
      createKeyDescriptor(clientSign.publicKey),
      createKeyDescriptor(clientEnc.publicKey),
      createKeyDescriptor(runnerSign.publicKey),
      createKeyDescriptor(runnerEnc.publicKey)
    ]);
  const offer = {
    protocol: "cg-e2ee/1" as const,
    pairingKind: "secure-web-magic-link/1" as const,
    pairId: "11111111-1111-4111-8111-111111111111",
    runnerId: "runner-test",
    runnerChallenge: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    runnerEncryptionKey: runnerEncryption,
    runnerSigningKey: runnerSigning,
    clientId: "client-test-1",
    clientChallenge: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    clientSigningFingerprint: clientSigning.fingerprint,
    clientEncryptionFingerprint: clientEncryption.fingerprint,
    secureOrigin: "https://secure.example.com",
    gatewayOrigin: "https://gateway.example.com",
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    createdAt: new Date().toISOString()
  };
  const mac = await macPairingTranscript(token, offer);
  assert.equal(await verifyPairingTranscriptMac(token, offer, mac), true);
  assert.equal(
    await verifyPairingTranscriptMac(token, { ...offer, runnerId: "evil" }, mac),
    false
  );
  const otherToken = generateMagicLinkToken();
  assert.equal(await verifyPairingTranscriptMac(otherToken, offer, mac), false);
  // Silence unused when generateHpkeKeyPair path only needs descriptors
  assert.ok((await exportE2eePublicKey(clientEnc.publicKey)).kty === "EC");
});
