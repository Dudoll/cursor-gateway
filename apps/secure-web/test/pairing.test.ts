import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import test from "node:test";
import {
  E2EE_PAIRING_KIND,
  E2EE_PROTOCOL
} from "@cursor-gateway/shared";
import {
  buildPairingOffer,
  createKeyDescriptor,
  generateHpkeKeyPair,
  generateMagicLinkToken,
  generateNonExtractableDeviceKeys,
  generatePairingChallenge,
  generateSigningKeyPair,
  macPairingTranscript,
  signValue,
  verifyPairingTranscriptMac,
  verifyValue
} from "@cursor-gateway/e2ee";
import {
  clearMagicLinkFragment,
  parseMagicLinkFragment,
  SecureWebKeyStore
} from "../src/keyStore.js";

test("parseMagicLinkFragment accepts pairId.token shape", () => {
  const pairId = "11111111-1111-4111-8111-111111111111";
  const token = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const parsed = parseMagicLinkFragment(`#pair=${pairId}.${token}`);
  assert.deepEqual(parsed, { pairId, token });
  assert.equal(parseMagicLinkFragment("#pair=bad"), null);
  assert.equal(parseMagicLinkFragment(""), null);
});

test("device keys persist non-extractable and public descriptors export", async () => {
  const store = await SecureWebKeyStore.open();
  const device = await store.device();
  assert.equal(device.signingPrivateKey.extractable, false);
  assert.equal(device.encryptionPrivateKey.extractable, false);
  assert.match(device.signingKey.fingerprint, /^sha256:/);
  assert.match(device.encryptionKey.fingerprint, /^sha256:/);

  const again = await store.device();
  assert.equal(again.clientId, device.clientId);
});

test("dry pairing: client MAC + signature round-trip with runner token", async () => {
  const token = generateMagicLinkToken();
  assert.equal(token.length, 43);

  const deviceKeys = await generateNonExtractableDeviceKeys();
  const [clientSigning, clientEncryption] = await Promise.all([
    createKeyDescriptor(deviceKeys.signing.publicKey),
    createKeyDescriptor(deviceKeys.encryption.publicKey)
  ]);
  const [runnerSign, runnerEnc] = await Promise.all([
    generateSigningKeyPair(),
    generateHpkeKeyPair()
  ]);
  const [runnerSigning, runnerEncryption] = await Promise.all([
    createKeyDescriptor(runnerSign.publicKey),
    createKeyDescriptor(runnerEnc.publicKey)
  ]);

  const start = {
    protocol: E2EE_PROTOCOL,
    pairingKind: E2EE_PAIRING_KIND,
    pairId: "22222222-2222-4222-8222-222222222222",
    clientId: "secure-web-client-dry",
    clientChallenge: generatePairingChallenge(),
    signingKey: clientSigning,
    encryptionKey: clientEncryption,
    secureOrigin: "https://secure.example.com",
    gatewayOrigin: "https://gateway.example.com",
    createdAt: new Date().toISOString()
  };
  const offer = buildPairingOffer({
    start,
    runnerId: "runner-dry",
    runnerChallenge: generatePairingChallenge(),
    runnerEncryptionKey: runnerEncryption,
    runnerSigningKey: runnerSigning,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    emailHint: "ops@example.com"
  });

  const transcriptMac = await macPairingTranscript(token, offer);
  assert.equal(await verifyPairingTranscriptMac(token, offer, transcriptMac), true);

  const unsigned = {
    protocol: E2EE_PROTOCOL,
    pairingKind: E2EE_PAIRING_KIND,
    pairId: offer.pairId,
    clientId: start.clientId,
    transcriptMac,
    createdAt: new Date().toISOString()
  };
  const complete = {
    ...unsigned,
    signature: await signValue(
      unsigned,
      deviceKeys.signing.privateKey,
      clientSigning.keyId
    )
  };
  assert.equal(
    await verifyValue(unsigned, complete.signature, deviceKeys.signing.publicKey),
    true
  );

  // Mutating offer breaks MAC (anti-substitution).
  assert.equal(
    await verifyPairingTranscriptMac(
      token,
      { ...offer, runnerId: "evil-runner" },
      transcriptMac
    ),
    false
  );
});

test("clearMagicLinkFragment is a no-op without window history mutation in node", () => {
  // jsdom-less: function guards on window; ensure call does not throw.
  assert.doesNotThrow(() => clearMagicLinkFragment());
});
