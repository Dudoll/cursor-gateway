import assert from "node:assert/strict";
import test from "node:test";
import {
  createKeyDescriptor,
  decryptRelayMessage,
  encryptRelayMessage,
  exportE2eePublicKey,
  generateHpkeKeyPair,
  generateRootKeyBytes,
  generateSigningKeyPair,
  importRootKey,
  importSigningPublicKey,
  issueCgDeviceCert,
  issueCgDeviceCertV2,
  MemoryKmsProvider,
  openDek,
  sealDek,
  verifyCgDeviceCert,
  zeroize
} from "../src/index.js";

async function serverKeyDescriptors() {
  const [hpke, signing] = await Promise.all([generateHpkeKeyPair(), generateSigningKeyPair()]);
  const [hpkeKey, signingKey] = await Promise.all([
    createKeyDescriptor(hpke.publicKey),
    createKeyDescriptor(signing.publicKey)
  ]);
  return { hpke, signing, hpkeKey, signingKey };
}

test("cg-device-cert/2 issues + verifies with accountId binding", async () => {
  const server = await serverKeyDescriptors();
  const device = await serverKeyDescriptors();
  const cert = await issueCgDeviceCertV2({
    signingPrivateKey: server.signing.privateKey,
    signingKeyId: server.signingKey.keyId,
    accountId: "oidc:user-1",
    deviceId: crypto.randomUUID(),
    epoch: 2,
    authScope: "oidc",
    signingKey: device.signingKey,
    encryptionKey: device.hpkeKey,
    keyIdHint: "oidc:user-1",
    serverCertId: crypto.randomUUID()
  });
  assert.equal(cert.kind, "cg-device-cert/2");
  assert.equal(cert.accountId, "oidc:user-1");
  assert.equal(cert.epoch, 2);
  const pub = await importSigningPublicKey(await exportE2eePublicKey(server.signing.publicKey));
  assert.equal(await verifyCgDeviceCert({ cert, serverSigningPublicKey: pub }), true);
  const tampered = { ...cert, accountId: "oidc:other" };
  assert.equal(await verifyCgDeviceCert({ cert: tampered, serverSigningPublicKey: pub }), false);
});

test("v1 device cert still issues for compatibility", async () => {
  const server = await serverKeyDescriptors();
  const device = await serverKeyDescriptors();
  const cert = await issueCgDeviceCert({
    signingPrivateKey: server.signing.privateKey,
    signingKeyId: server.signingKey.keyId,
    deviceId: crypto.randomUUID(),
    signingKey: device.signingKey,
    encryptionKey: device.hpkeKey,
    keyIdHint: "legacy",
    serverCertId: crypto.randomUUID()
  });
  assert.equal(cert.kind, "cg-device-cert/1");
});

test("MemoryKms + sealDek/openDek + message AEAD roundtrip; zeroize clears buffer", async () => {
  const kms = new MemoryKmsProvider("test-kms");
  const accountKekBytes = generateRootKeyBytes();
  const wrappedKek = await kms.wrap(accountKekBytes, { accountId: "a1", epoch: 1 });
  const openedKek = await kms.unwrap(wrappedKek, { accountId: "a1", epoch: 1 });
  assert.deepEqual(Buffer.from(openedKek), Buffer.from(accountKekBytes));

  const kek = await importRootKey(accountKekBytes, false);
  const dekBytes = generateRootKeyBytes();
  const wrappedDek = await sealDek(kek, dekBytes, { conversationId: "c1" });
  const openedDek = await openDek(kek, wrappedDek, { conversationId: "c1" });
  assert.deepEqual(Buffer.from(openedDek), Buffer.from(dekBytes));

  const dek = await importRootKey(dekBytes, false);
  const ct = await encryptRelayMessage(
    dek,
    { conversationId: "c1", sequence: 1, role: "user" },
    { role: "user", text: "secret-prompt-should-not-leak" }
  );
  const plain = await decryptRelayMessage<{ text: string }>(
    dek,
    { conversationId: "c1", sequence: 1, role: "user" },
    ct
  );
  assert.equal(plain.text, "secret-prompt-should-not-leak");
  assert.equal(JSON.stringify(ct).includes("secret-prompt"), false);

  zeroize(dekBytes);
  assert.equal(dekBytes.every((b) => b === 0), true);
  zeroize(accountKekBytes);
  zeroize(openedKek);
  zeroize(openedDek);
});
