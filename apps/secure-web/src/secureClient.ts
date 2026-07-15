import {
  E2EE_PROTOCOL,
  e2eeConversationRecordSchema,
  e2eeMemoryPayloadSchema,
  e2eeMemoryRecordSchema,
  e2eeProgressPayloadSchema,
  e2eeResultPayloadSchema,
  e2eeRunPayloadSchema,
  e2eeRunRecordSchema,
  e2eeRunnerDirectoryEntrySchema,
  type E2eeConversationRecord,
  type E2eeMemoryRecord,
  type E2eeProgressPayload,
  type E2eeResultPayload,
  type E2eeRunPayload,
  type E2eeRunRecord,
  type E2eeRunnerDirectoryEntry,
  type RunProgressKind
} from "@cursor-gateway/shared";
import {
  canonicalJson,
  decryptJson,
  digestValue,
  encryptJson,
  generateRootKeyBytes,
  importRootKey,
  importSigningPublicKey,
  memoryPayloadAad,
  progressPayloadAad,
  requestKeyContext,
  requestPayloadAad,
  resultPayloadAad,
  signValue,
  unsignedEnvelope,
  verifyValue,
  wrapRootKey
} from "@cursor-gateway/e2ee";
import { GatewayApi } from "./api.js";
import {
  SecureWebKeyStore,
  type ConversationSecret
} from "./keyStore.js";

export type DecryptedRun = {
  record: E2eeRunRecord;
  request: E2eeRunPayload;
  progress: E2eeProgressPayload | null;
  result: E2eeResultPayload | null;
  integrity: "verified";
};

export type DecryptedMemory = {
  record: E2eeMemoryRecord;
  content: string;
};

function requestBaseOf(request: E2eeRunRecord["request"]) {
  const { payload: _payload, signature: _signature, ...base } = request;
  return base;
}

function outputBaseOf<
  T extends {
    payload: unknown;
    signature: unknown;
  }
>(envelope: T): Omit<T, "payload" | "signature"> {
  const { payload: _payload, signature: _signature, ...base } = envelope;
  return base;
}

function truncateHistory(runs: DecryptedRun[]) {
  const completed = runs
    .filter((run) => run.result?.status === "finished" && run.result.response)
    .map((run) => ({
      prompt: run.request.prompt,
      response: run.result!.response!
    }))
    .slice(-20);
  while (
    completed.length > 0 &&
    completed.reduce((size, turn) => size + turn.prompt.length + turn.response.length, 0) >
      48_000
  ) {
    completed.shift();
  }
  return completed;
}

export class SecureGatewayClient {
  constructor(
    readonly api: GatewayApi,
    readonly keys: SecureWebKeyStore
  ) {}

  async runners(): Promise<E2eeRunnerDirectoryEntry[]> {
    const response = await this.api.get<{ runners: unknown[] }>("/api/e2ee/v1/runners");
    return response.runners.map((runner) => e2eeRunnerDirectoryEntrySchema.parse(runner));
  }

  async trustedRunner(runnerId: string) {
    const pin = await this.keys.runner(runnerId);
    if (!pin) throw new Error("runner_not_paired");
    const directory = (await this.runners()).find((runner) => runner.runnerId === runnerId);
    if (!directory) throw new Error("paired_runner_not_advertised");
    if (
      directory.e2ee.encryptionKey.fingerprint !== pin.encryptionKey.fingerprint ||
      directory.e2ee.signingKey.fingerprint !== pin.signingKey.fingerprint
    ) {
      throw new Error("runner_fingerprint_mismatch");
    }
    return { pin, directory };
  }

  async conversations() {
    const response = await this.api.get<{ conversations: unknown[] }>(
      "/api/e2ee/v1/conversations"
    );
    return response.conversations.map((conversation) =>
      e2eeConversationRecordSchema.parse(conversation)
    );
  }

  async title(conversation: E2eeConversationRecord) {
    if (!conversation.title) return "Encrypted conversation";
    const secret = await this.keys.conversation(conversation.id);
    if (!secret) return "无法解密：本机无此会话密钥";
    const value = await decryptJson(
      secret.rootKey,
      "browser-local:conversation-title",
      { protocol: E2EE_PROTOCOL, conversationId: conversation.id },
      conversation.title
    );
    return typeof value === "string" ? value : "Encrypted conversation";
  }

  async runs(conversationId: string) {
    const response = await this.api.get<{ runs: unknown[] }>(
      `/api/e2ee/v1/conversations/${conversationId}/runs`
    );
    const records = response.runs.map((run) => e2eeRunRecordSchema.parse(run));
    const ordered = [...records].sort(
      (left, right) => left.request.sequence - right.request.sequence
    );
    let previousDigest: string | null = null;
    for (let index = 0; index < ordered.length; index += 1) {
      const record = ordered[index]!;
      if (
        record.conversationId !== conversationId ||
        record.request.conversationId !== conversationId ||
        record.request.sequence !== index + 1 ||
        record.request.previousDigest !== previousDigest
      ) {
        throw new Error("conversation_chain_invalid");
      }
      previousDigest = await digestValue(unsignedEnvelope(record.request));
    }

    const decrypted = await Promise.all(ordered.map((run) => this.decryptRun(run)));
    if (ordered.length > 0) {
      const latest = ordered[ordered.length - 1]!;
      const secret = await this.keys.conversation(conversationId);
      if (secret && latest.request.sequence >= secret.sequence) {
        await this.keys.advanceConversation(
          conversationId,
          latest.request.sequence,
          previousDigest!
        );
      }
    }
    return decrypted;
  }

  async memory(workspaceId?: string) {
    const suffix = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
    const response = await this.api.get<{ memory: unknown[] }>(
      `/api/e2ee/v1/memory${suffix}`
    );
    const records = response.memory.map((memory) => e2eeMemoryRecordSchema.parse(memory));
    return Promise.all(records.map((memory) => this.decryptMemory(memory)));
  }

  async submitRun(input: {
    runnerId: string;
    workspaceId: string;
    model: string;
    prompt: string;
    allowWrites: boolean;
    conversationId?: string;
  }) {
    const { pin } = await this.trustedRunner(input.runnerId);
    const device = await this.keys.device();
    let secret: ConversationSecret;
    let isNewConversation = false;

    if (input.conversationId) {
      const existing = await this.keys.conversation(input.conversationId);
      if (!existing) throw new Error("conversation_key_missing");
      if (
        existing.runnerId !== pin.runnerId ||
        existing.runnerKeyId !== pin.encryptionKey.keyId ||
        existing.workspaceId !== input.workspaceId
      ) {
        throw new Error("conversation_context_mismatch");
      }
      secret = existing;
    } else {
      isNewConversation = true;
      const conversationId = crypto.randomUUID();
      const rawRoot = generateRootKeyBytes();
      const rootKey = await importRootKey(rawRoot);
      const wrappedConversationKey = await wrapRootKey(
        rawRoot,
        pin.encryptionKey.publicKey,
        requestKeyContext({
          conversationId,
          clientId: device.clientId,
          runnerId: pin.runnerId,
          runnerKeyId: pin.encryptionKey.keyId
        })
      );
      secret = await this.keys.createConversation({
        id: conversationId,
        rawRoot,
        rootKey,
        wrappedConversationKey,
        runnerId: pin.runnerId,
        runnerKeyId: pin.encryptionKey.keyId,
        workspaceId: input.workspaceId,
        model: input.model
      });
      rawRoot.fill(0);
    }

    const [existingRuns, memories] = await Promise.all([
      isNewConversation ? Promise.resolve([]) : this.runs(secret.id),
      this.memory(input.workspaceId)
    ]);
    if (!isNewConversation) {
      const synchronized = await this.keys.conversation(secret.id);
      if (!synchronized) throw new Error("conversation_key_missing");
      secret = synchronized;
    }
    const sequence = secret.sequence + 1;
    const runId = crypto.randomUUID();
    const routing = {
      model: input.model,
      workspaceId: input.workspaceId,
      allowWrites: input.allowWrites,
      memoryEnabled: true
    };
    const title = isNewConversation
      ? await encryptJson(
          secret.rootKey,
          "browser-local:conversation-title",
          { protocol: E2EE_PROTOCOL, conversationId: secret.id },
          input.prompt.trim().slice(0, 80)
        )
      : null;
    const requestBase = {
      protocol: E2EE_PROTOCOL,
      kind: "run-request" as const,
      messageId: runId,
      runId,
      conversationId: secret.id,
      clientId: device.clientId,
      clientKeyId: device.signingKey.keyId,
      runnerId: pin.runnerId,
      runnerKeyId: pin.encryptionKey.keyId,
      sequence,
      createdAt: new Date().toISOString(),
      routing,
      previousDigest: secret.lastDigest,
      wrappedConversationKey: secret.wrappedConversationKey,
      title
    };
    const plaintext = e2eeRunPayloadSchema.parse({
      protocol: E2EE_PROTOCOL,
      kind: "run-request",
      messageId: runId,
      runId,
      conversationId: secret.id,
      sequence,
      routing,
      prompt: input.prompt,
      history: truncateHistory(existingRuns),
      memory: memories.map((memory) => memory.content),
      previousDigest: secret.lastDigest
    });
    const payload = await encryptJson(
      secret.rootKey,
      "browser-to-runner:run-request",
      requestPayloadAad(requestBase),
      plaintext
    );
    const unsignedRequest = { ...requestBase, payload };
    const request = {
      ...unsignedRequest,
      signature: await signValue(
        unsignedRequest,
        device.signingPrivateKey,
        device.signingKey.keyId
      )
    };
    const requestDigest = await digestValue(unsignedRequest);
    const response = await this.api.post<{ run: unknown }>("/api/e2ee/v1/runs", {
      request
    });
    let run = e2eeRunRecordSchema.parse(response.run);
    await this.keys.advanceConversation(secret.id, sequence, requestDigest);

    if (input.allowWrites) {
      const unsignedApproval = {
        protocol: E2EE_PROTOCOL,
        kind: "run-approval" as const,
        messageId: crypto.randomUUID(),
        runId,
        conversationId: secret.id,
        clientId: device.clientId,
        clientKeyId: device.signingKey.keyId,
        runnerId: pin.runnerId,
        runnerKeyId: pin.encryptionKey.keyId,
        requestDigest,
        allowWrites: true as const,
        createdAt: new Date().toISOString()
      };
      const approval = {
        ...unsignedApproval,
        signature: await signValue(
          unsignedApproval,
          device.signingPrivateKey,
          device.signingKey.keyId
        )
      };
      const approved = await this.api.post<{ run: unknown }>(
        `/api/e2ee/v1/runs/${runId}/approval`,
        { approval }
      );
      run = e2eeRunRecordSchema.parse(approved.run);
    }

    return run;
  }

  private async decryptRun(record: E2eeRunRecord): Promise<DecryptedRun> {
    const secret = await this.keys.conversation(record.conversationId);
    if (!secret) throw new Error("conversation_key_missing");
    const pin = await this.keys.runner(record.request.runnerId);
    if (!pin) throw new Error("runner_not_paired");
    const device = await this.keys.device();
    if (
      record.request.clientId !== device.clientId ||
      record.request.clientKeyId !== device.signingKey.keyId
    ) {
      throw new Error("run_created_by_unrecognized_client");
    }
    const clientPublicKey = await importSigningPublicKey(device.signingKey.publicKey);
    if (
      !(await verifyValue(
        unsignedEnvelope(record.request),
        record.request.signature,
        clientPublicKey
      ))
    ) {
      throw new Error("request_signature_invalid");
    }
    const request = e2eeRunPayloadSchema.parse(
      await decryptJson(
        secret.rootKey,
        "browser-to-runner:run-request",
        requestPayloadAad(requestBaseOf(record.request)),
        record.request.payload
      )
    );
    if (
      request.runId !== record.id ||
      request.conversationId !== record.conversationId ||
      request.sequence !== record.request.sequence ||
      canonicalJson(request.routing) !== canonicalJson(record.request.routing)
    ) {
      throw new Error("request_integrity_mismatch");
    }
    const requestDigest = await digestValue(unsignedEnvelope(record.request));
    const runnerSigningKey = await importSigningPublicKey(pin.signingKey.publicKey);

    let progress: E2eeProgressPayload | null = null;
    if (record.progress) {
      if (
        record.progress.signature.keyId !== pin.signingKey.keyId ||
        record.progress.requestDigest !== requestDigest ||
        !(await verifyValue(
          unsignedEnvelope(record.progress),
          record.progress.signature,
          runnerSigningKey
        ))
      ) {
        throw new Error("progress_signature_invalid");
      }
      progress = e2eeProgressPayloadSchema.parse(
        await decryptJson(
          secret.rootKey,
          "runner-to-browser:run-progress",
          progressPayloadAad(outputBaseOf(record.progress)),
          record.progress.payload
        )
      );
      if (
        progress.runId !== record.id ||
        progress.conversationId !== record.conversationId ||
        progress.sequence !== record.progress.sequence ||
        progress.progressKind !== record.progress.progressKind
      ) {
        throw new Error("progress_integrity_mismatch");
      }
    }

    let result: E2eeResultPayload | null = null;
    if (record.result) {
      if (
        record.result.signature.keyId !== pin.signingKey.keyId ||
        record.result.requestDigest !== requestDigest ||
        !(await verifyValue(
          unsignedEnvelope(record.result),
          record.result.signature,
          runnerSigningKey
        ))
      ) {
        throw new Error("result_signature_invalid");
      }
      result = e2eeResultPayloadSchema.parse(
        await decryptJson(
          secret.rootKey,
          "runner-to-browser:run-result",
          resultPayloadAad(outputBaseOf(record.result)),
          record.result.payload
        )
      );
      if (result.status !== record.result.status) {
        throw new Error("result_status_mismatch");
      }
      if (
        result.runId !== record.id ||
        result.conversationId !== record.conversationId
      ) {
        throw new Error("result_integrity_mismatch");
      }
      if (record.progress && record.result.sequence <= record.progress.sequence) {
        throw new Error("result_sequence_invalid");
      }
    }
    return { record, request, progress, result, integrity: "verified" };
  }

  private async decryptMemory(record: E2eeMemoryRecord): Promise<DecryptedMemory> {
    const device = await this.keys.device();
    if (
      record.envelope.clientId !== device.clientId ||
      record.envelope.clientKeyId !== device.signingKey.keyId
    ) {
      throw new Error("memory_created_by_unrecognized_client");
    }
    const publicKey = await importSigningPublicKey(device.signingKey.publicKey);
    if (
      !(await verifyValue(
        unsignedEnvelope(record.envelope),
        record.envelope.signature,
        publicKey
      ))
    ) {
      throw new Error("memory_signature_invalid");
    }
    const payload = e2eeMemoryPayloadSchema.parse(
      await decryptJson(
        device.memoryRootKey,
        "browser-local:memory",
        memoryPayloadAad(outputBaseOf(record.envelope)),
        record.envelope.payload
      )
    );
    if (
      payload.memoryId !== record.id ||
      payload.scope !== record.scope ||
      payload.workspaceId !== record.workspaceId
    ) {
      throw new Error("memory_integrity_mismatch");
    }
    return { record, content: payload.content };
  }
}

export function progressLabel(kind: RunProgressKind) {
  if (kind === "thinking") return "思考中";
  if (kind === "tool") return "正在使用工具";
  if (kind === "responding") return "正在回复";
  return "处理中";
}
