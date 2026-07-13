import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import test from "node:test";
import {
  E2EE_PROTOCOL,
  e2eeRunPayloadSchema,
  e2eeRunRequestEnvelopeSchema
} from "@cursor-gateway/shared";
import {
  createKeyDescriptor,
  decryptJson,
  generateHpkeKeyPair,
  generateSigningKeyPair,
  requestKeyContext,
  requestPayloadAad,
  unwrapRootKey,
  verifyValue,
  unsignedEnvelope
} from "@cursor-gateway/e2ee";
import { GatewayApi } from "../src/api.js";
import { SecureKeyStore } from "../src/keyStore.js";
import { SecureGatewayClient } from "../src/secureClient.js";

test("extension sends only ciphertext and keeps recoverable encrypted keys", async () => {
  const store = await SecureKeyStore.open();
  const [runnerEncryptionKeys, runnerSigningKeys] = await Promise.all([
    generateHpkeKeyPair(),
    generateSigningKeyPair()
  ]);
  const [runnerEncryption, runnerSigning] = await Promise.all([
    createKeyDescriptor(runnerEncryptionKeys.publicKey),
    createKeyDescriptor(runnerSigningKeys.publicKey)
  ]);
  await store.importRunner({
    protocol: E2EE_PROTOCOL,
    kind: "runner-pairing",
    runnerId: "runner-browser-test",
    encryptionKey: runnerEncryption,
    signingKey: runnerSigning,
    createdAt: new Date().toISOString()
  });

  let submittedBody: { request?: unknown } | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/e2ee/v1/runners") {
      return Response.json({
        runners: [
          {
            runnerId: "runner-browser-test",
            runnerVersion: "test",
            models: [{ id: "test-model" }],
            workspaces: [{ id: "ws-browser-test", label: "test", writable: true }],
            e2ee: {
              protocols: [E2EE_PROTOCOL],
              encryptionKey: runnerEncryption,
              signingKey: runnerSigning
            },
            lastSeenAt: new Date().toISOString(),
            online: true
          }
        ]
      });
    }
    if (url.pathname === "/api/e2ee/v1/memory") {
      return Response.json({ memory: [] });
    }
    if (url.pathname === "/api/e2ee/v1/runs" && init?.method === "POST") {
      submittedBody = JSON.parse(String(init.body)) as { request?: unknown };
      const request = e2eeRunRequestEnvelopeSchema.parse(submittedBody.request);
      const now = new Date().toISOString();
      return Response.json(
        {
          run: {
            id: request.runId,
            conversationId: request.conversationId,
            status: "queued",
            model: request.routing.model,
            workspaceId: request.routing.workspaceId,
            allowWrites: request.routing.allowWrites,
            request,
            approval: null,
            progress: null,
            result: null,
            createdAt: now,
            startedAt: null,
            finishedAt: null,
            updatedAt: now
          }
        },
        { status: 202 }
      );
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  };

  try {
    const client = new SecureGatewayClient(
      new GatewayApi("https://gateway.test"),
      store
    );
    await client.submitRun({
      runnerId: "runner-browser-test",
      workspaceId: "ws-browser-test",
      model: "test-model",
      prompt: "sentinel-browser-private-prompt",
      allowWrites: false
    });

    assert.ok(submittedBody?.request);
    assert.equal(
      JSON.stringify(submittedBody).includes("sentinel-browser-private-prompt"),
      false
    );
    const request = e2eeRunRequestEnvelopeSchema.parse(submittedBody.request);
    const device = await store.device();
    const clientPublic = await import("@cursor-gateway/e2ee").then((module) =>
      module.importSigningPublicKey(device.signingKey.publicKey)
    );
    assert.equal(
      await verifyValue(unsignedEnvelope(request), request.signature, clientPublic),
      true
    );

    const runnerRoot = await unwrapRootKey(
      request.wrappedConversationKey,
      runnerEncryptionKeys.privateKey,
      runnerEncryption.publicKey,
      requestKeyContext(request)
    );
    const { payload: _payload, signature: _signature, ...base } = request;
    const plaintext = e2eeRunPayloadSchema.parse(
      await decryptJson(
        runnerRoot,
        "browser-to-runner:run-request",
        requestPayloadAad(base),
        request.payload
      )
    );
    assert.equal(plaintext.prompt, "sentinel-browser-private-prompt");

    const backup = await store.exportBackup("correct horse battery staple");
    assert.equal(backup.includes("sentinel-browser-private-prompt"), false);
    await store.importBackup(backup, "correct horse battery staple");
    assert.equal((await store.device()).clientId, device.clientId);
    assert.equal((await store.runner("runner-browser-test"))?.runnerId, "runner-browser-test");

    const archive = await store.archiveLegacyData({
      version: 1,
      exportedAt: new Date().toISOString(),
      conversations: [],
      memory: [
        {
          id: globalThis.crypto.randomUUID(),
          scope: "user",
          workspaceId: null,
          content: "sentinel-legacy-memory",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      ]
    });
    const archiveBackup = await store.exportBackup("correct horse battery staple");
    assert.equal(archiveBackup.includes("sentinel-legacy-memory"), false);
    await store.importBackup(archiveBackup, "correct horse battery staple");
    assert.equal(
      (await store.legacyArchive(archive.id)).memory[0]?.content,
      "sentinel-legacy-memory"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
