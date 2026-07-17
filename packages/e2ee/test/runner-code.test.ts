import assert from "node:assert/strict";
import test from "node:test";
import {
  E2EE_PROTOCOL,
  E2EE_RUNNER_CODE_PAIRING_KIND,
  type E2eeRunnerCodePairingOffer
} from "@cursor-gateway/shared";
import {
  RAMC_SAS_WORDLIST,
  createKeyDescriptor,
  generateHpkeKeyPair,
  generatePairingChallenge,
  generateRunnerDeviceCode,
  generateSigningKeyPair,
  generateTrustRootKeyPair,
  issueRunnerIdentityCert,
  macRunnerCodeTranscript,
  normalizeRunnerDeviceCodeInput,
  runnerCodeSas,
  runnerCodeSasEqual,
  runnerDeviceCodeDisplay,
  verifyRunnerCodeTranscriptMac
} from "../src/index.js";

async function buildOffer(): Promise<E2eeRunnerCodePairingOffer> {
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
  return {
    protocol: E2EE_PROTOCOL,
    pairingKind: E2EE_RUNNER_CODE_PAIRING_KIND,
    enrollId: crypto.randomUUID(),
    runnerId: "wsl-e2ee",
    serverNonce: generatePairingChallenge(),
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
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    createdAt: new Date().toISOString()
  };
}

test("SAS wordlist is exactly 256 unique entries", () => {
  assert.equal(RAMC_SAS_WORDLIST.length, 256);
  assert.equal(new Set(RAMC_SAS_WORDLIST).size, 256);
});

test("device code is 128-bit and display form round-trips", () => {
  const code = generateRunnerDeviceCode();
  assert.match(code, /^[A-Za-z0-9_-]{22}$/);
  const display = runnerDeviceCodeDisplay(code);
  assert.equal(normalizeRunnerDeviceCodeInput(display), code);
  assert.equal(normalizeRunnerDeviceCodeInput(code), code);
});

test("HMAC transcript tag binds the code and the full transcript", async () => {
  const code = generateRunnerDeviceCode();
  const offer = await buildOffer();
  const mac = await macRunnerCodeTranscript(code, offer);
  assert.equal(await verifyRunnerCodeTranscriptMac(code, offer, mac), true);
  // Wrong code fails.
  assert.equal(await verifyRunnerCodeTranscriptMac(generateRunnerDeviceCode(), offer, mac), false);
  // Tampered transcript (relay swaps a key/origin) fails closed.
  const tampered = { ...offer, secureOrigin: "https://evil.example" };
  assert.equal(await verifyRunnerCodeTranscriptMac(code, tampered, mac), false);
  const tampered2 = { ...offer, serverNonce: generatePairingChallenge() };
  assert.equal(await verifyRunnerCodeTranscriptMac(code, tampered2, mac), false);
});

test("SAS matches for the same code+transcript and mismatches otherwise", async () => {
  const code = generateRunnerDeviceCode();
  const offer = await buildOffer();
  const sasA = await runnerCodeSas(code, offer);
  const sasB = await runnerCodeSas(code, offer);
  assert.equal(sasA.length, 6);
  assert.equal(runnerCodeSasEqual(sasA, sasB), true);
  for (const word of sasA) assert.ok(RAMC_SAS_WORDLIST.includes(word));
  // Different code → different SAS (overwhelmingly).
  const sasWrong = await runnerCodeSas(generateRunnerDeviceCode(), offer);
  assert.equal(runnerCodeSasEqual(sasA, sasWrong), false);
  // Tampered transcript → different SAS.
  const sasTampered = await runnerCodeSas(code, { ...offer, runnerChallenge: generatePairingChallenge() });
  assert.equal(runnerCodeSasEqual(sasA, sasTampered), false);
});

test("normalize rejects malformed codes", () => {
  assert.throws(() => normalizeRunnerDeviceCodeInput("short"));
  assert.throws(() => normalizeRunnerDeviceCodeInput("!!!not-a-code!!!"));
});
