import assert from "node:assert/strict";
import test from "node:test";
import {
  E2EE_CS_AUTH_KIND,
  E2EE_PROTOCOL,
  type E2eeCsAuthIntent
} from "@cursor-gateway/shared";
import {
  buildCsAuthGrantUnsigned,
  buildCsAuthRedirectUrl,
  createKeyDescriptor,
  encodeCsAuthGrantFragment,
  generateHpkeKeyPair,
  generateNonExtractableDeviceKeys,
  generatePairingChallenge,
  generateSigningKeyPair,
  parseCsAuthGrantFragment,
  parseCsAuthRedirectSearch,
  signCsAuthGrant,
  validateCsAuthGrant
} from "../src/index.js";

async function sampleIntent(): Promise<E2eeCsAuthIntent> {
  const device = await generateNonExtractableDeviceKeys();
  const [signingKey, encryptionKey] = await Promise.all([
    createKeyDescriptor(device.signing.publicKey),
    createKeyDescriptor(device.encryption.publicKey)
  ]);
  return {
    protocol: E2EE_PROTOCOL,
    authKind: E2EE_CS_AUTH_KIND,
    authId: crypto.randomUUID(),
    clientId: crypto.randomUUID(),
    challenge: generatePairingChallenge(),
    state: generatePairingChallenge(),
    signingKey,
    encryptionKey,
    returnOrigin: "https://cs.example.test",
    gatewayOrigin: "https://cs.example.test",
    createdAt: new Date().toISOString()
  };
}

test("CS auth redirect URL round-trips query bindings", () => {
  const authId = "11111111-1111-4111-8111-111111111111";
  const challenge = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const state = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
  const url = buildCsAuthRedirectUrl("https://secure.example.test", {
    authId,
    clientId: "client-cs-1",
    challenge,
    state,
    returnOrigin: "https://cs.example.test",
    signingFingerprint: "sha256:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
    encryptionFingerprint: "sha256:DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD"
  });
  const parsed = parseCsAuthRedirectSearch(new URL(url).search);
  assert.ok(parsed);
  assert.equal(parsed.authId, authId);
  assert.equal(parsed.returnOrigin, "https://cs.example.test");
  assert.equal(parsed.challenge, challenge);
  assert.equal(parseCsAuthRedirectSearch(""), null);
  assert.equal(parseCsAuthRedirectSearch("?cs_auth=1&auth_id=bad"), null);
});

test("Runner-signed CS auth grant verifies and rejects replay bindings", async () => {
  const intent = await sampleIntent();
  const runnerSigning = await generateSigningKeyPair();
  const runnerEncryption = await generateHpkeKeyPair();
  const [runnerSigningKey, runnerEncryptionKey] = await Promise.all([
    createKeyDescriptor(runnerSigning.publicKey),
    createKeyDescriptor(runnerEncryption.publicKey)
  ]);
  const unsigned = buildCsAuthGrantUnsigned({
    intent,
    runnerId: "wsl-e2ee",
    runnerEncryptionKey,
    runnerSigningKey,
    status: "authorized",
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  });
  const grant = await signCsAuthGrant(
    unsigned,
    runnerSigning.privateKey,
    runnerSigningKey.keyId
  );

  const fragment = encodeCsAuthGrantFragment(grant);
  const parsed = parseCsAuthGrantFragment(fragment);
  assert.ok(parsed);
  assert.equal(parsed.authId, intent.authId);

  const ok = await validateCsAuthGrant({
    grant,
    expected: {
      authId: intent.authId,
      clientId: intent.clientId,
      challenge: intent.challenge,
      state: intent.state,
      returnOrigin: intent.returnOrigin,
      signingFingerprint: intent.signingKey.fingerprint,
      encryptionFingerprint: intent.encryptionKey.fingerprint,
      gatewayOrigin: intent.gatewayOrigin
    }
  });
  assert.equal(ok.ok, true);

  const badChallenge = await validateCsAuthGrant({
    grant,
    expected: {
      authId: intent.authId,
      clientId: intent.clientId,
      challenge: generatePairingChallenge(),
      state: intent.state,
      returnOrigin: intent.returnOrigin,
      signingFingerprint: intent.signingKey.fingerprint,
      encryptionFingerprint: intent.encryptionKey.fingerprint
    }
  });
  assert.equal(badChallenge.ok, false);
  if (!badChallenge.ok) assert.equal(badChallenge.reason, "challenge_mismatch");

  const expired = await validateCsAuthGrant({
    grant: { ...grant, expiresAt: new Date(Date.now() - 1_000).toISOString() },
    expected: {
      authId: intent.authId,
      clientId: intent.clientId,
      challenge: intent.challenge,
      state: intent.state,
      returnOrigin: intent.returnOrigin,
      signingFingerprint: intent.signingKey.fingerprint,
      encryptionFingerprint: intent.encryptionKey.fingerprint
    }
  });
  // Signature still valid for original transcript; expiresAt change invalidates signature path
  // when we don't resign — either signature invalid or expired depending on check order.
  assert.equal(expired.ok, false);
});

test("CS auth grant fragment does not embed private keys", async () => {
  const intent = await sampleIntent();
  const runnerSigning = await generateSigningKeyPair();
  const runnerEncryption = await generateHpkeKeyPair();
  const [runnerSigningKey, runnerEncryptionKey] = await Promise.all([
    createKeyDescriptor(runnerSigning.publicKey),
    createKeyDescriptor(runnerEncryption.publicKey)
  ]);
  const grant = await signCsAuthGrant(
    buildCsAuthGrantUnsigned({
      intent,
      runnerId: "wsl-e2ee",
      runnerEncryptionKey,
      runnerSigningKey,
      status: "authorized",
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    }),
    runnerSigning.privateKey,
    runnerSigningKey.keyId
  );
  const encoded = encodeCsAuthGrantFragment(grant);
  assert.doesNotMatch(encoded, /d"|private|sk_/i);
  assert.match(encoded, /^#cs_auth=/);
});
