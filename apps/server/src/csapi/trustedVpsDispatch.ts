/**
 * Trusted VPS → Runner HPKE dispatch (cg-e2ee/1).
 * VPS may see plaintext; network proxies and forged TLS certs must not.
 */
import {
  E2EE_PROTOCOL,
  type E2eePublicKey,
  type E2eeRunRequestEnvelope
} from "@cursor-gateway/shared";
import {
  encryptJson,
  generateRootKeyBytes,
  importRootKey,
  requestKeyContext,
  requestPayloadAad,
  signValue,
  wrapRootKey,
  zeroize
} from "@cursor-gateway/e2ee";
import { truncateHistoryForRunner, type TruncatedTurn } from "./runnerSeal.js";

/** Client identities the WSL runner accepts as VPS-trusted sources. */
export const TRUSTED_VPS_CLIENT_IDS = [
  "cs-relay",
  "vps-csapi",
  "vps-hermes",
  "vps-telegram"
] as const;

export type TrustedVpsClientId = (typeof TRUSTED_VPS_CLIENT_IDS)[number];

export function isTrustedVpsClientId(clientId: string): clientId is TrustedVpsClientId {
  return (TRUSTED_VPS_CLIENT_IDS as readonly string[]).includes(clientId);
}

export async function buildTrustedVpsRunRequest(input: {
  clientId: TrustedVpsClientId;
  csSigningPrivateKey: CryptoKey;
  csSigningKeyId: string;
  runnerId: string;
  runnerKeyId: string;
  runnerHpkePublic: E2eePublicKey;
  conversationId: string;
  runId: string;
  model: string;
  workspaceId: string;
  turns: TruncatedTurn[];
  maxTurns: number;
  maxBytes: number;
  allowWrites?: boolean;
  sequence?: number;
  previousDigest?: string | null;
  promptOverride?: string;
}): Promise<{ envelope: E2eeRunRequestEnvelope; rootKey: CryptoKey }> {
  const truncated = truncateHistoryForRunner(input.turns, input.maxTurns, input.maxBytes);
  const prompt =
    input.promptOverride ??
    truncated.map((t) => `${t.role.toUpperCase()}: ${t.content}`).join("\n\n");
  const raw = generateRootKeyBytes();
  try {
    const root = await importRootKey(raw, false);
    const sequence = input.sequence ?? 1;
    const createdAt = new Date().toISOString();
    const routing = {
      model: input.model,
      workspaceId: input.workspaceId,
      allowWrites: input.allowWrites ?? false,
      memoryEnabled: false
    };
    const context = requestKeyContext({
      conversationId: input.conversationId,
      clientId: input.clientId,
      runnerId: input.runnerId,
      runnerKeyId: input.runnerKeyId
    });
    const wrappedConversationKey = await wrapRootKey(raw, input.runnerHpkePublic, context);
    const base = {
      protocol: E2EE_PROTOCOL,
      kind: "run-request" as const,
      messageId: input.runId,
      runId: input.runId,
      conversationId: input.conversationId,
      clientId: input.clientId,
      clientKeyId: input.csSigningKeyId,
      runnerId: input.runnerId,
      runnerKeyId: input.runnerKeyId,
      sequence,
      createdAt,
      routing,
      previousDigest: input.previousDigest ?? null,
      wrappedConversationKey,
      title: null as null
    };
    const inner = {
      protocol: E2EE_PROTOCOL,
      kind: "run-request" as const,
      messageId: input.runId,
      runId: input.runId,
      conversationId: input.conversationId,
      sequence,
      previousDigest: input.previousDigest ?? null,
      routing,
      prompt,
      history: [] as Array<{ prompt: string; response: string }>,
      memory: [] as string[]
    };
    const payload = await encryptJson(
      root,
      "browser-to-runner:run-request",
      requestPayloadAad(base),
      inner
    );
    const unsigned = { ...base, payload };
    const signature = await signValue(unsigned, input.csSigningPrivateKey, input.csSigningKeyId);
    return { envelope: { ...unsigned, signature }, rootKey: root };
  } finally {
    zeroize(raw);
  }
}
