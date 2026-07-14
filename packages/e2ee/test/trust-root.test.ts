import assert from "node:assert/strict";
import test from "node:test";
import {
  createKeyDescriptor,
  generateHpkeKeyPair,
  generateSigningKeyPair,
  generateTrustRootKeyPair,
  issueRunnerIdentityCert,
  verifyRunnerIdentityCert
} from "../src/index.js";

async function sampleRunnerKeys() {
  const signing = await generateSigningKeyPair();
  const encryption = await generateHpkeKeyPair();
  const [signingKey, encryptionKey] = await Promise.all([
    createKeyDescriptor(signing.publicKey),
    createKeyDescriptor(encryption.publicKey)
  ]);
  return { signing, encryption, signingKey, encryptionKey };
}

test("trust root signs runner cert and verifies", async () => {
  const root = await generateTrustRootKeyPair(1);
  const runner = await sampleRunnerKeys();
  const cert = await issueRunnerIdentityCert({
    rootPrivateKey: root.privateKey,
    rootPublic: root.public,
    runnerId: "wsl-e2ee",
    encryptionKey: runner.encryptionKey,
    signingKey: runner.signingKey,
    allowedSecureOrigins: ["https://secure.joelzt.org"],
    allowedRpIds: ["secure.joelzt.org"],
    validityDays: 30
  });
  const ok = await verifyRunnerIdentityCert({
    cert,
    trustRoots: [root.public],
    expected: {
      runnerId: "wsl-e2ee",
      secureOrigin: "https://secure.joelzt.org",
      rpId: "secure.joelzt.org",
      signingFingerprint: runner.signingKey.fingerprint,
      encryptionFingerprint: runner.encryptionKey.fingerprint
    }
  });
  assert.equal(ok.ok, true);
});

test("runner cert rejects expiry, tamper, wrong runner/epoch/origin", async () => {
  const root = await generateTrustRootKeyPair(2);
  const runner = await sampleRunnerKeys();
  const cert = await issueRunnerIdentityCert({
    rootPrivateKey: root.privateKey,
    rootPublic: root.public,
    runnerId: "wsl-e2ee",
    encryptionKey: runner.encryptionKey,
    signingKey: runner.signingKey,
    allowedSecureOrigins: ["https://secure.joelzt.org"],
    allowedRpIds: ["secure.joelzt.org"],
    epoch: 2,
    validityDays: 1
  });

  const expired = await verifyRunnerIdentityCert({
    cert,
    trustRoots: [root.public],
    nowMs: Date.parse(cert.expiresAt) + 1_000
  });
  assert.equal(expired.ok, false);
  if (!expired.ok) assert.equal(expired.reason, "cert_expired");

  const wrongRunner = await verifyRunnerIdentityCert({
    cert,
    trustRoots: [root.public],
    expected: { runnerId: "other-runner" }
  });
  assert.equal(wrongRunner.ok, false);
  if (!wrongRunner.ok) assert.equal(wrongRunner.reason, "cert_runner_mismatch");

  const wrongEpoch = await verifyRunnerIdentityCert({
    cert,
    trustRoots: [root.public],
    expected: { epoch: 99 }
  });
  assert.equal(wrongEpoch.ok, false);
  if (!wrongEpoch.ok) assert.equal(wrongEpoch.reason, "cert_epoch_mismatch");

  const wrongOrigin = await verifyRunnerIdentityCert({
    cert,
    trustRoots: [root.public],
    expected: { secureOrigin: "https://evil.example" }
  });
  assert.equal(wrongOrigin.ok, false);
  if (!wrongOrigin.ok) assert.equal(wrongOrigin.reason, "cert_secure_origin_not_allowed");

  const tampered = {
    ...cert,
    runnerId: "tampered-runner"
  };
  const tamper = await verifyRunnerIdentityCert({
    cert: tampered,
    trustRoots: [root.public]
  });
  assert.equal(tamper.ok, false);
  if (!tamper.ok) assert.equal(tamper.reason, "cert_signature_invalid");
});

test("dual trust roots allow migration epoch", async () => {
  const oldRoot = await generateTrustRootKeyPair(1);
  const newRoot = await generateTrustRootKeyPair(2);
  const runner = await sampleRunnerKeys();
  const cert = await issueRunnerIdentityCert({
    rootPrivateKey: newRoot.privateKey,
    rootPublic: newRoot.public,
    runnerId: "wsl-e2ee",
    encryptionKey: runner.encryptionKey,
    signingKey: runner.signingKey,
    allowedSecureOrigins: ["https://secure.joelzt.org"],
    allowedRpIds: ["secure.joelzt.org"],
    epoch: 2
  });
  const ok = await verifyRunnerIdentityCert({
    cert,
    trustRoots: [oldRoot.public, newRoot.public]
  });
  assert.equal(ok.ok, true);
});
