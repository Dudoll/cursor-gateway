import type { Workspace } from "@cursor-gateway/shared";
import {
  E2EE_PROTOCOL,
  e2eeProgressEnvelopeSchema,
  e2eeProgressPayloadSchema,
  e2eeResultEnvelopeSchema,
  e2eeResultPayloadSchema,
  e2eeRunPayloadSchema,
  type E2eeProgressEnvelope,
  type E2eeResultEnvelope,
  type E2eeRunnerJob,
  type RunProgressKind
} from "@cursor-gateway/shared";
import {
  canonicalJson,
  decryptJson,
  digestValue,
  encryptJson,
  importSigningPublicKey,
  progressPayloadAad,
  requestKeyContext,
  requestPayloadAad,
  resultPayloadAad,
  signValue,
  unsignedEnvelope,
  unwrapRootKey,
  verifyValue
} from "@cursor-gateway/e2ee";
import { runCursorJob } from "./cursorAgent.js";
import { RunnerE2eeState } from "./e2eeState.js";

export type EncryptedProgressReporter = (
  envelope: E2eeProgressEnvelope
) => Promise<void>;
type CursorJobRunner = typeof runCursorJob;

function fixedProtocolError(error: unknown) {
  if (error instanceof Error && error.message === "e2ee_replay_incomplete") {
    return "This request was already started locally and was not re-executed.";
  }
  if (error instanceof Error && error.message === "e2ee_replay_result_unavailable") {
    return "This completed request was not re-executed because its cached encrypted result expired.";
  }
  return "The local Cursor runner rejected or failed the encrypted request.";
}

export class E2eeJobProcessor {
  constructor(
    private readonly state: RunnerE2eeState,
    private readonly workspaces: Map<string, Workspace>,
    private readonly runJob: CursorJobRunner = runCursorJob
  ) {}

  async process(
    job: E2eeRunnerJob,
    reportEncryptedProgress: EncryptedProgressReporter
  ): Promise<E2eeResultEnvelope> {
    const request = job.request;
    if (
      request.runnerId !== this.state.runnerPairingBundle().runnerId ||
      request.runnerKeyId !== this.state.encryptionKey.keyId
    ) {
      throw new Error("e2ee_wrong_runner");
    }

    const client = this.state.getPairedClient(request.clientId, request.clientKeyId);
    // cs-relay: CS signs with its server signing key; accept when configured via
    // RUNNER_CS_RELAY_SIGNING_PUBLIC_JWK (or already paired as clientId cs-relay).
    let clientSigningKey: CryptoKey;
    if (request.clientId === "cs-relay") {
      const csPub = this.state.getCsRelaySigningPublicKey?.();
      if (csPub) {
        clientSigningKey = await importSigningPublicKey(csPub);
      } else if (client && client.signingKey.keyId === request.signature.keyId) {
        clientSigningKey = await importSigningPublicKey(client.signingKey.publicKey);
      } else {
        throw new Error("e2ee_cs_relay_client_not_configured");
      }
    } else {
      if (!client || client.signingKey.keyId !== request.signature.keyId) {
        throw new Error("e2ee_client_not_paired");
      }
      clientSigningKey = await importSigningPublicKey(client.signingKey.publicKey);
    }
    if (
      !(await verifyValue(
        unsignedEnvelope(request),
        request.signature,
        clientSigningKey
      ))
    ) {
      throw new Error("e2ee_request_signature_invalid");
    }

    const requestDigest = await digestValue(unsignedEnvelope(request));
    if (request.routing.allowWrites) {
      const approval = job.approval;
      if (
        !approval ||
        approval.runId !== request.runId ||
        approval.conversationId !== request.conversationId ||
        approval.clientId !== request.clientId ||
        approval.clientKeyId !== request.clientKeyId ||
        approval.runnerId !== request.runnerId ||
        approval.runnerKeyId !== request.runnerKeyId ||
        approval.requestDigest !== requestDigest ||
        approval.signature.keyId !== request.clientKeyId ||
        !(await verifyValue(
          unsignedEnvelope(approval),
          approval.signature,
          clientSigningKey
        ))
      ) {
        throw new Error("e2ee_write_approval_invalid");
      }
    } else if (job.approval) {
      throw new Error("e2ee_unexpected_write_approval");
    }

    const priorMessage = this.state.messageState(request.messageId);
    const cachedResult = this.state.cachedResult(request.runId);
    if (priorMessage && priorMessage.runId !== request.runId) {
      throw new Error("e2ee_message_id_run_mismatch");
    }
    if (priorMessage?.state === "finished" && cachedResult) return cachedResult;

    const rootKey = await unwrapRootKey(
      request.wrappedConversationKey,
      this.state.encryptionPrivateKey,
      this.state.encryptionKey.publicKey,
      requestKeyContext(request)
    );
    const { payload: _payload, signature: _signature, ...requestBase } = request;
    const plaintext = e2eeRunPayloadSchema.parse(
      await decryptJson(
        rootKey,
        "browser-to-runner:run-request",
        requestPayloadAad(requestBase),
        request.payload
      )
    );

    if (
      plaintext.protocol !== request.protocol ||
      plaintext.kind !== request.kind ||
      plaintext.messageId !== request.messageId ||
      plaintext.runId !== request.runId ||
      plaintext.conversationId !== request.conversationId ||
      plaintext.sequence !== request.sequence ||
      plaintext.previousDigest !== request.previousDigest ||
      canonicalJson(plaintext.routing) !== canonicalJson(request.routing)
    ) {
      throw new Error("e2ee_inner_outer_mismatch");
    }

    const workspace = this.workspaces.get(plaintext.routing.workspaceId);
    if (!workspace) throw new Error("e2ee_workspace_not_configured_locally");
    if (plaintext.routing.allowWrites && !workspace.writable) {
      throw new Error("e2ee_workspace_read_only_locally");
    }

    const previousDigest = this.state.conversationDigest(request.conversationId);
    const previousSequence = this.state.conversationSequence(request.conversationId);
    const replayWithoutCachedResult =
      priorMessage?.state === "finished" && !cachedResult;
    const resumedIncompleteReplay =
      priorMessage?.state === "running" &&
      previousDigest === requestDigest &&
      (previousSequence === 0 || previousSequence === request.sequence);
    if (
      !resumedIncompleteReplay &&
      !replayWithoutCachedResult &&
      ((request.sequence === 1 &&
        (request.previousDigest !== null ||
          previousDigest !== null ||
          previousSequence !== 0)) ||
        (request.sequence > 1 &&
          (!previousDigest ||
            request.previousDigest !== previousDigest ||
            (previousSequence !== 0 && request.sequence !== previousSequence + 1))))
    ) {
      throw new Error("e2ee_conversation_chain_mismatch");
    }

    const seen = await this.state.markMessageStarted(request.messageId, request.runId);
    if (seen?.state === "finished" && cachedResult) return cachedResult;

    let progressSequence = 0;
    const createProgress = async (progress: {
      kind: RunProgressKind;
      message: string;
    }) => {
      progressSequence += 1;
      const base = {
        protocol: E2EE_PROTOCOL,
        kind: "run-progress" as const,
        messageId: crypto.randomUUID(),
        runId: request.runId,
        conversationId: request.conversationId,
        runnerId: request.runnerId,
        runnerKeyId: request.runnerKeyId,
        requestDigest,
        sequence: progressSequence,
        progressKind: progress.kind,
        createdAt: new Date().toISOString()
      };
      const progressPayload = e2eeProgressPayloadSchema.parse({
        protocol: E2EE_PROTOCOL,
        kind: "run-progress",
        runId: request.runId,
        conversationId: request.conversationId,
        sequence: progressSequence,
        progressKind: progress.kind,
        message: progress.message.slice(-200_000)
      });
      const payload = await encryptJson(
        rootKey,
        "runner-to-browser:run-progress",
        progressPayloadAad(base),
        progressPayload
      );
      const unsigned = { ...base, payload };
      const envelope = e2eeProgressEnvelopeSchema.parse({
        ...unsigned,
        signature: await signValue(
          unsigned,
          this.state.signingPrivateKey,
          this.state.signingKey.keyId
        )
      });
      try {
        await reportEncryptedProgress(envelope);
      } catch {
        // Progress is best-effort; the final encrypted result remains authoritative.
      }
    };

    let resultStatus: "finished" | "error" | "cancelled";
    let response: string | null = null;
    let error: string | null = null;
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;

    if (seen?.state === "finished") {
      resultStatus = "error";
      error = fixedProtocolError(new Error("e2ee_replay_result_unavailable"));
    } else if (seen?.state === "running") {
      resultStatus = "error";
      error = fixedProtocolError(new Error("e2ee_replay_incomplete"));
    } else {
      await this.state.setConversationPosition(
        request.conversationId,
        request.sequence,
        requestDigest
      );
      await createProgress({ kind: "working", message: "Starting the model." });
      try {
        const result = await this.runJob(
          {
            runId: request.runId,
            conversationId: request.conversationId,
            agentId: this.state.agentId(request.conversationId),
            model: plaintext.routing.model,
            prompt: plaintext.prompt,
            workspace,
            ...(plaintext.userIdentity ? { userIdentity: plaintext.userIdentity } : {}),
            memory: plaintext.memory,
            history: plaintext.history,
            allowWrites: plaintext.routing.allowWrites
          },
          createProgress
        );
        resultStatus = result.status;
        response = result.response;
        error = result.error;
        inputTokens = result.inputTokens;
        outputTokens = result.outputTokens;
        if (result.status === "finished") {
          await this.state.setAgentId(request.conversationId, result.agentId);
        }
      } catch (cause) {
        resultStatus = "error";
        error =
          cause instanceof Error
            ? cause.message.slice(0, 200_000)
            : fixedProtocolError(cause);
      }
    }

    const resultSequence = progressSequence + 1;
    const resultBase = {
      protocol: E2EE_PROTOCOL,
      kind: "run-result" as const,
      messageId: crypto.randomUUID(),
      runId: request.runId,
      conversationId: request.conversationId,
      runnerId: request.runnerId,
      runnerKeyId: request.runnerKeyId,
      requestDigest,
      sequence: resultSequence,
      status: resultStatus,
      createdAt: new Date().toISOString()
    };
    const resultPayload = e2eeResultPayloadSchema.parse({
      protocol: E2EE_PROTOCOL,
      kind: "run-result",
      runId: request.runId,
      conversationId: request.conversationId,
      status: resultStatus,
      response,
      error,
      inputTokens,
      outputTokens
    });
    const encryptedPayload = await encryptJson(
      rootKey,
      "runner-to-browser:run-result",
      resultPayloadAad(resultBase),
      resultPayload
    );
    const unsignedResult = { ...resultBase, payload: encryptedPayload };
    const envelope = e2eeResultEnvelopeSchema.parse({
      ...unsignedResult,
      signature: await signValue(
        unsignedResult,
        this.state.signingPrivateKey,
        this.state.signingKey.keyId
      )
    });
    await this.state.markMessageFinished(request.messageId, request.runId, envelope);
    return envelope;
  }
}
