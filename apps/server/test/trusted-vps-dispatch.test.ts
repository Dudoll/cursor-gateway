import assert from "node:assert/strict";
import test from "node:test";
import {
  createKeyDescriptor,
  generateHpkeKeyPair,
  generateSigningKeyPair
} from "@cursor-gateway/e2ee";
import {
  buildTrustedVpsRunRequest,
  isTrustedVpsClientId
} from "../src/csapi/trustedVpsDispatch.js";

test("trusted VPS client ids are enumerated", () => {
  assert.equal(isTrustedVpsClientId("cs-relay"), true);
  assert.equal(isTrustedVpsClientId("vps-hermes"), true);
  assert.equal(isTrustedVpsClientId("vps-telegram"), true);
  assert.equal(isTrustedVpsClientId("browser"), false);
});

test("buildTrustedVpsRunRequest seals prompt for runner HPKE key", async () => {
  const runnerHpke = await generateHpkeKeyPair();
  const csSigning = await generateSigningKeyPair();
  const runnerKey = await createKeyDescriptor(runnerHpke.publicKey);
  const csKey = await createKeyDescriptor(csSigning.publicKey);
  const { envelope, rootKey } = await buildTrustedVpsRunRequest({
    clientId: "vps-hermes",
    csSigningPrivateKey: csSigning.privateKey,
    csSigningKeyId: csKey.keyId,
    runnerId: "wsl-e2ee",
    runnerKeyId: runnerKey.keyId,
    runnerHpkePublic: runnerKey.publicKey,
    conversationId: crypto.randomUUID(),
    runId: crypto.randomUUID(),
    model: "auto",
    workspaceId: "ws-test",
    turns: [{ role: "user", content: "hello from hermes" }],
    maxTurns: 20,
    maxBytes: 48_000
  });
  assert.equal(envelope.clientId, "vps-hermes");
  assert.equal(envelope.kind, "run-request");
  assert.ok(envelope.payload.ciphertext.length > 0);
  assert.ok(envelope.signature.value.length > 0);
  assert.ok(rootKey);
});
