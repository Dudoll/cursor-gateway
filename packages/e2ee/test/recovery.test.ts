import assert from "node:assert/strict";
import test from "node:test";
import {
  E2EE_PROTOCOL,
  E2EE_RECOVERY_PAIRING_KIND,
  type E2eeRecoveryPairingOffer
} from "@cursor-gateway/shared";
import {
  createKeyDescriptor,
  decodeCrockfordGrouped,
  encodeCrockfordGrouped,
  generateHpkeKeyPair,
  generatePairingChallenge,
  generateRecoverySecret,
  generateSigningKeyPair,
  generateTrustRootKeyPair,
  issueRunnerIdentityCert,
  macRecoveryTranscript,
  normalizeRecoverySecretInput,
  verifyRecoveryTranscriptMac
} from "../src/index.js";

test("recovery secret is high-entropy and MAC binds transcript", async () => {
  const secret = generateRecoverySecret();
  assert.equal(secret.length, 43);
  const crockford = encodeCrockfordGrouped(secret);
  assert.match(crockford, /^[0-9A-HJKMNP-TV-Z]+(-[0-9A-HJKMNP-TV-Z]+)+$/);
  assert.equal(decodeCrockfordGrouped(crockford), secret);
  assert.equal(normalizeRecoverySecretInput(crockford), secret);
  assert.equal(normalizeRecoverySecretInput(secret), secret);

  const root = await generateTrustRootKeyPair(1);
  const signing = await generateSigningKeyPair();
  const encryption = await generateHpkeKeyPair();
  const [signingKey, encryptionKey] = await Promise.all([
    createKeyDescriptor(signing.publicKey),
    createKeyDescriptor(encryption.publicKey)
  ]);
  const cert = await issueRunnerIdentityCert({
    rootPrivateKey: root.privateKey,
    rootPublic: root.public,
    runnerId: "wsl-e2ee",
    encryptionKey,
    signingKey,
    allowedSecureOrigins: ["https://secure.joelzt.org"],
    allowedRpIds: ["secure.joelzt.org"]
  });
  const offer: E2eeRecoveryPairingOffer = {
    protocol: E2EE_PROTOCOL,
    pairingKind: E2EE_RECOVERY_PAIRING_KIND,
    pairId: crypto.randomUUID(),
    runnerId: "wsl-e2ee",
    runnerChallenge: generatePairingChallenge(),
    runnerEncryptionKey: encryptionKey,
    runnerSigningKey: signingKey,
    runnerCertificate: cert,
    clientId: crypto.randomUUID(),
    clientChallenge: generatePairingChallenge(),
    clientSigningFingerprint: signingKey.fingerprint,
    clientEncryptionFingerprint: encryptionKey.fingerprint,
    secureOrigin: "https://secure.joelzt.org",
    gatewayOrigin: "https://cs.joelzt.org",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdAt: new Date().toISOString()
  };
  const mac = await macRecoveryTranscript(secret, offer);
  assert.equal(await verifyRecoveryTranscriptMac(secret, offer, mac), true);
  assert.equal(await verifyRecoveryTranscriptMac(generateRecoverySecret(), offer, mac), false);
  const mutated = { ...offer, clientId: crypto.randomUUID() };
  assert.equal(await verifyRecoveryTranscriptMac(secret, mutated, mac), false);
});
