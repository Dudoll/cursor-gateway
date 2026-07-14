import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import test from "node:test";
import {
  E2EE_PROTOCOL,
  e2eeRunRequestEnvelopeSchema
} from "@cursor-gateway/shared";
import {
  createKeyDescriptor,
  decryptJson,
  generateHpkeKeyPair,
  generateSigningKeyPair,
  importSigningPublicKey,
  requestKeyContext,
  requestPayloadAad,
  unwrapRootKey,
  unsignedEnvelope,
  verifyValue
} from "@cursor-gateway/e2ee";
import { GatewayApi } from "../src/api.js";
import { SecureWebKeyStore } from "../src/keyStore.js";
import { SecureGatewayClient } from "../src/secureClient.js";

test("secure-web submits only ciphertext and keeps non-exportable conversation keys", async () => {
  const store = await SecureWebKeyStore.open();
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
    runnerId: "runner-secure-web-test",
    encryptionKey: runnerEncryption,
    signingKey: runnerSigning,
    createdAt: new Date().toISOString()
  });
  await store.markPaired("runner-secure-web-test");

  let submittedBody: { request?: unknown } | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), "https://gateway.example.com");
    if (url.pathname === "/api/e2ee/v1/runners") {
      return Response.json({
        runners: [
          {
            runnerId: "runner-secure-web-test",
            runnerVersion: "test",
            models: [{ id: "test-model" }],
            workspaces: [{ id: "ws-test", label: "test", writable: true }],
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
      return Response.json({
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
      });
    }
    return new Response("not_found", { status: 404 });
  };

  try {
    const client = new SecureGatewayClient(
      new GatewayApi("https://gateway.example.com"),
      store
    );
    const prompt = "secret secure-web prompt must stay ciphertext";
    const run = await client.submitRun({
      runnerId: "runner-secure-web-test",
      workspaceId: "ws-test",
      model: "test-model",
      prompt,
      allowWrites: false
    });

    const request = e2eeRunRequestEnvelopeSchema.parse(submittedBody?.request);
    const wire = JSON.stringify(submittedBody);
    assert.equal(wire.includes(prompt), false);
    assert.equal(request.protocol, E2EE_PROTOCOL);

    const device = await store.device();
    const clientPublic = await importSigningPublicKey(device.signingKey.publicKey);
    assert.equal(
      await verifyValue(unsignedEnvelope(request), request.signature, clientPublic),
      true
    );
    const root = await unwrapRootKey(
      request.wrappedConversationKey,
      runnerEncryptionKeys.privateKey,
      runnerEncryption.publicKey,
      requestKeyContext({
        conversationId: request.conversationId,
        clientId: request.clientId,
        runnerId: request.runnerId,
        runnerKeyId: request.runnerKeyId
      })
    );
    const { payload: _payload, signature: _signature, ...base } = request;
    const plaintext = await decryptJson(
      root,
      "browser-to-runner:run-request",
      requestPayloadAad(base),
      request.payload
    );
    assert.equal((plaintext as { prompt?: string }).prompt, prompt);

    const secret = await store.conversation(run.conversationId);
    assert.ok(secret);
    assert.equal(secret!.rootKey.extractable, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
