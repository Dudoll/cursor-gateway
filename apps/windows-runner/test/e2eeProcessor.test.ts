import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RunnerJob } from "@cursor-gateway/shared";
import type { ProgressReporter } from "../src/cursorAgent.js";

const root = mkdtempSync(join(tmpdir(), "cursor-gateway-runner-test-"));
process.env.GATEWAY_URL = "https://gateway.test";
process.env.RUNNER_ID = "runner-test";
process.env.RUNNER_SHARED_SECRET = "x".repeat(32);
process.env.RUNNER_WORKSPACES = root;
process.env.CURSOR_API_KEY = "cursor-test";
process.env.RUNNER_E2EE_ALLOW_INSECURE_DEV_STORAGE = "true";
process.env.RUNNER_E2EE_STATE_FILE = join(root, "runner-state.dat");
// Isolate from developer .env master-key settings (config loadEnv uses ??=).
process.env.RUNNER_E2EE_MASTER_KEY_FILE = "";
delete process.env.RUNNER_E2EE_MASTER_KEY;

test("runner verifies, decrypts, executes once, and encrypts the response", async () => {
  const shared = await import("@cursor-gateway/shared");
  const crypto = await import("@cursor-gateway/e2ee");
  const { RunnerE2eeState } = await import("../src/e2eeState.js");
  const { E2eeJobProcessor } = await import("../src/e2eeProcessor.js");

  const state = await RunnerE2eeState.loadOrCreate();
  const clientKeys = await crypto.generateSigningKeyPair();
  const clientDescriptor = await crypto.createKeyDescriptor(clientKeys.publicKey);
  const clientId = "browser-client-test";
  await state.pairClient({
    protocol: shared.E2EE_PROTOCOL,
    kind: "client-pairing",
    clientId,
    signingKey: clientDescriptor,
    createdAt: new Date().toISOString()
  });

  const conversationId = globalThis.crypto.randomUUID();
  const runId = globalThis.crypto.randomUUID();
  const rawRoot = crypto.generateRootKeyBytes();
  const browserRoot = await crypto.importRootKey(rawRoot);
  const keyContext = crypto.requestKeyContext({
    conversationId,
    clientId,
    runnerId: "runner-test",
    runnerKeyId: state.encryptionKey.keyId
  });
  const wrappedConversationKey = await crypto.wrapRootKey(
    rawRoot,
    state.encryptionKey.publicKey,
    keyContext
  );
  rawRoot.fill(0);

  const routing = {
    model: "test-model",
    workspaceId: "ws-test",
    allowWrites: false,
    memoryEnabled: true
  };
  const requestBase = {
    protocol: shared.E2EE_PROTOCOL,
    kind: "run-request" as const,
    messageId: runId,
    runId,
    conversationId,
    clientId,
    clientKeyId: clientDescriptor.keyId,
    runnerId: "runner-test",
    runnerKeyId: state.encryptionKey.keyId,
    sequence: 1,
    createdAt: new Date().toISOString(),
    routing,
    previousDigest: null,
    wrappedConversationKey,
    title: null
  };
  const plaintext = shared.e2eeRunPayloadSchema.parse({
    protocol: shared.E2EE_PROTOCOL,
    kind: "run-request",
    messageId: runId,
    runId,
    conversationId,
    sequence: 1,
    routing,
    prompt: "sentinel-private-prompt",
    history: [],
    memory: ["sentinel-private-memory"],
    previousDigest: null
  });
  const encryptedPayload = await crypto.encryptJson(
    browserRoot,
    "browser-to-runner:run-request",
    crypto.requestPayloadAad(requestBase),
    plaintext
  );
  const unsignedRequest = { ...requestBase, payload: encryptedPayload };
  const request = shared.e2eeRunRequestEnvelopeSchema.parse({
    ...unsignedRequest,
    signature: await crypto.signValue(
      unsignedRequest,
      clientKeys.privateKey,
      clientDescriptor.keyId
    )
  });

  let executions = 0;
  const fakeRun = async (job: RunnerJob, report?: ProgressReporter) => {
    executions += 1;
    assert.equal(job.prompt, "sentinel-private-prompt");
    assert.deepEqual(job.memory, ["sentinel-private-memory"]);
    await report?.({ kind: "working", message: "sentinel-private-progress" });
    return {
      runId: job.runId,
      status: "finished" as const,
      response: "sentinel-private-response",
      error: null,
      agentId: "local-agent-test",
      inputTokens: 12,
      outputTokens: 8
    };
  };
  const processor = new E2eeJobProcessor(
    state,
    new Map([
      [
        "ws-test",
        { id: "ws-test", label: "test", path: root, writable: true }
      ]
    ]),
    fakeRun
  );
  const progress: unknown[] = [];
  const job = shared.e2eeRunnerJobSchema.parse({
    contentMode: "e2ee-v1",
    leaseId: globalThis.crypto.randomUUID(),
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    request,
    approval: null
  });
  const tamperedJob = shared.e2eeRunnerJobSchema.parse({
    ...job,
    request: {
      ...request,
      routing: { ...request.routing, model: "tampered-model" }
    }
  });
  await assert.rejects(
    processor.process(tamperedJob, async () => {}),
    /e2ee_request_signature_invalid/
  );

  const result = await processor.process(job, async (envelope) => {
    progress.push(envelope);
  });
  assert.equal(executions, 1);
  assert.equal(JSON.stringify(result).includes("sentinel-private-response"), false);
  assert.equal(JSON.stringify(progress).includes("sentinel-private-progress"), false);

  const runnerSigningKey = await crypto.importSigningPublicKey(
    state.signingKey.publicKey
  );
  assert.equal(
    await crypto.verifyValue(
      crypto.unsignedEnvelope(result),
      result.signature,
      runnerSigningKey
    ),
    true
  );
  const { payload: _resultPayload, signature: _resultSignature, ...resultBase } = result;
  const openedResult = shared.e2eeResultPayloadSchema.parse(
    await crypto.decryptJson(
      browserRoot,
      "runner-to-browser:run-result",
      crypto.resultPayloadAad(resultBase),
      result.payload
    )
  );
  assert.equal(openedResult.response, "sentinel-private-response");

  const replayed = await processor.process(job, async () => {});
  assert.equal(replayed.messageId, result.messageId);
  assert.equal(executions, 1);
});
