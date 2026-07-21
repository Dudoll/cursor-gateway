/**
 * Production CS → Runner re-encrypt execute path (relay-P4).
 * Queue/DB store only cg-e2ee/1 envelopes; CS holds taskRoot until result decrypt.
 */
import { randomUUID } from "node:crypto";
import {
  e2eeResultEnvelopeSchema,
  e2eeResultPayloadSchema,
  type E2eePublicKey,
  type E2eeRunRequestEnvelope,
  type E2eeRunnerDirectoryEntry
} from "@cursor-gateway/shared";
import {
  decryptJson,
  importSigningPublicKey,
  resultPayloadAad,
  unsignedEnvelope,
  verifyValue
} from "@cursor-gateway/e2ee";
import { config as appConfig } from "../config.js";
import {
  cancelE2eeRun,
  createE2eeRun,
  getE2eeRunForUser,
  listE2eeRunners
} from "../e2eeDb.js";
import { buildCsRelayRunRequest } from "./csRelayDispatch.js";
import type { TruncatedTurn } from "./runnerSeal.js";

export class CsRelayExecuteError extends Error {
  constructor(
    readonly reason: string,
    readonly status = 503
  ) {
    super(reason);
    this.name = "CsRelayExecuteError";
  }
}

function pickOnlineRunner(
  runners: E2eeRunnerDirectoryEntry[],
  model: string,
  workspaceId: string
): E2eeRunnerDirectoryEntry {
  const online = runners.filter((r) => r.online);
  const match = online.find((r) => {
    const wsOk = r.workspaces.some((w) => w.id === workspaceId);
    if (!wsOk) return false;
    if (model === "auto" || model === "default") return true;
    return r.models.some((m) => m.id === model);
  });
  if (!match) {
    throw new CsRelayExecuteError("cs_relay_e2ee_runner_offline", 503);
  }
  return match;
}

export async function executeCsRelayReencrypt(input: {
  principalId: string;
  workspaceId: string;
  model: string;
  turns: TruncatedTurn[];
  csSigningPrivateKey: CryptoKey;
  csSigningKeyId: string;
  allowWrites?: boolean;
  signal?: AbortSignal;
  pollIntervalMs?: number;
  timeoutMs?: number;
}): Promise<{
  text: string;
  inputTokens: number;
  outputTokens: number;
  runId: string;
  /** E2EE queue conversation (content_mode=e2ee-v1); not the relay history id. */
  e2eeConversationId: string;
  requestEnvelope: E2eeRunRequestEnvelope;
}> {
  if (!appConfig.csRelay.runnerReencrypt) {
    throw new CsRelayExecuteError("cs_relay_runner_reencrypt_disabled", 503);
  }
  const runners = await listE2eeRunners();
  const runner = pickOnlineRunner(runners, input.model, input.workspaceId);
  const runId = randomUUID();
  const e2eeConversationId = randomUUID();
  const hpke = runner.e2ee.encryptionKey.publicKey as E2eePublicKey;
  const { envelope, rootKey } = await buildCsRelayRunRequest({
    csSigningPrivateKey: input.csSigningPrivateKey,
    csSigningKeyId: input.csSigningKeyId,
    runnerId: runner.runnerId,
    runnerKeyId: runner.e2ee.encryptionKey.keyId,
    runnerHpkePublic: hpke,
    conversationId: e2eeConversationId,
    runId,
    model: input.model === "auto" ? "default" : input.model,
    workspaceId: input.workspaceId,
    turns: input.turns,
    maxTurns: appConfig.csRelay.maxHistoryTurns,
    maxBytes: appConfig.csRelay.maxHistoryBytes,
    allowWrites: input.allowWrites ?? false
  });

  const { run } = await createE2eeRun({
    userId: input.principalId,
    request: envelope
  });

  const timeoutMs = input.timeoutMs ?? appConfig.csapi.absoluteTimeoutMs;
  const pollMs = input.pollIntervalMs ?? 400;
  const deadline = Date.now() + timeoutMs;
  const runnerSigning = await importSigningPublicKey(runner.e2ee.signingKey.publicKey);

  for (;;) {
    if (input.signal?.aborted) {
      await cancelE2eeRun(run.id, input.principalId);
      throw new CsRelayExecuteError("client_aborted", 499);
    }
    const snapshot = await getE2eeRunForUser(run.id, input.principalId);
    if (!snapshot) throw new CsRelayExecuteError("run_disappeared", 502);
    if (snapshot.status === "finished" || snapshot.status === "error") {
      if (!snapshot.result) {
        throw new CsRelayExecuteError(`run_${snapshot.status}_without_envelope`, 502);
      }
      const resultEnv = e2eeResultEnvelopeSchema.parse(snapshot.result);
      if (
        !(await verifyValue(unsignedEnvelope(resultEnv), resultEnv.signature, runnerSigning))
      ) {
        throw new CsRelayExecuteError("result_signature_invalid", 502);
      }
      const { payload: _p, signature: _s, ...resultBase } = resultEnv;
      const plaintext = e2eeResultPayloadSchema.parse(
        await decryptJson(
          rootKey,
          "runner-to-browser:run-result",
          resultPayloadAad(resultBase),
          resultEnv.payload
        )
      );
      if (plaintext.status === "error") {
        throw new CsRelayExecuteError(plaintext.error ?? "runner_error", 502);
      }
      return {
        text: plaintext.response ?? "",
        inputTokens: plaintext.inputTokens ?? 0,
        outputTokens: plaintext.outputTokens ?? 0,
        runId: run.id,
        e2eeConversationId,
        requestEnvelope: envelope
      };
    }
    if (snapshot.status === "cancelled") {
      throw new CsRelayExecuteError("run_cancelled", 502);
    }
    if (Date.now() > deadline) {
      await cancelE2eeRun(run.id, input.principalId);
      throw new CsRelayExecuteError("run_timed_out", 504);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
