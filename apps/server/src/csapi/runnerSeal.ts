/**
 * CS → Runner re-encryption (relay-P4).
 * CS produces taskRoot and wraps it for the runner HPKE pubkey (cg-e2ee/1 shape).
 */
import type { E2eeCiphertext, E2eeHpkeEnvelope, E2eePublicKey } from "@cursor-gateway/shared";
import {
  encryptJson,
  generateRootKeyBytes,
  importRootKey,
  wrapRootKey,
  zeroize
} from "@cursor-gateway/e2ee";

export const CS_TO_RUNNER_PURPOSE = "cs-to-runner:run-request" as const;

export type TruncatedTurn = { role: "user" | "assistant" | "system"; content: string };

/** Truncate history to recent turns / byte budget (same spirit as secureClient). */
export function truncateHistoryForRunner(
  turns: TruncatedTurn[],
  maxTurns: number,
  maxBytes: number
): TruncatedTurn[] {
  const recent = turns.slice(-Math.max(1, maxTurns));
  const out: TruncatedTurn[] = [];
  let used = 0;
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const turn = recent[i]!;
    const size = turn.content.length + turn.role.length + 8;
    if (out.length > 0 && used + size > maxBytes) break;
    out.unshift(turn);
    used += size;
  }
  return out;
}

export async function sealRunnerTaskEnvelope(input: {
  runnerHpkePublic: E2eePublicKey;
  runnerId: string;
  runId: string;
  model: string;
  workspaceId: string;
  turns: TruncatedTurn[];
  maxTurns: number;
  maxBytes: number;
}): Promise<{
  enc: E2eeHpkeEnvelope;
  requestCiphertext: E2eeCiphertext;
  contextTurns: number;
  contextBytes: number;
}> {
  const truncated = truncateHistoryForRunner(input.turns, input.maxTurns, input.maxBytes);
  const contextBytes = truncated.reduce((n, t) => n + t.content.length, 0);
  const raw = generateRootKeyBytes();
  try {
    const taskRoot = await importRootKey(raw, false);
    const context = {
      protocol: "cg-e2ee/1",
      purpose: "cs-relay-task",
      runnerId: input.runnerId,
      runId: input.runId
    };
    const enc = await wrapRootKey(raw, input.runnerHpkePublic, context);
    const requestCiphertext = await encryptJson(taskRoot, CS_TO_RUNNER_PURPOSE, context, {
      runId: input.runId,
      model: input.model,
      workspaceId: input.workspaceId,
      turns: truncated
    });
    return {
      enc,
      requestCiphertext,
      contextTurns: truncated.length,
      contextBytes
    };
  } finally {
    zeroize(raw);
  }
}
