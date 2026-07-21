// Backend abstraction for the csapi facade.
//
// The route layer depends only on this interface, which lets us wire the real
// PostgreSQL-backed gateway in production and an in-memory fake in tests (no
// database required). Everything here is plaintext (方案 B); there is no E2EE.
import { createHash } from "node:crypto";
import type { RunStatus } from "@cursor-gateway/shared";
import {
  applicationStatusCodeForRun,
  isTerminalRunStatus,
  providerForModel,
  type CsapiCancelReason,
  type CsapiProvider
} from "./runTimeouts.js";

export interface CsapiRunHandle {
  runId: string;
  conversationId: string;
  status: RunStatus;
}

export interface CsapiRunSnapshot {
  status: RunStatus;
  response: string | null;
  error: string | null;
  progress: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  lastActivityAt: string | null;
  cancelReason: string | null;
  model: string;
  provider: CsapiProvider;
}

export interface CsapiRunObservation {
  runId: string;
  status: RunStatus;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  lastActivityAt: string | null;
  terminal: boolean;
  cancelReason: string | null;
  claimAttempts: number;
  provider: CsapiProvider;
  model: string;
  applicationStatusCode: string | null;
}

export interface CsapiCapacitySummary {
  runnerIdentities: number;
  totalRunnerSlots: number;
}

export interface CsapiBackend {
  /** Model ids currently advertised by online runners (excluding synthetic "auto"). */
  listModelIds(): string[];
  /** Number of runners that have sent a heartbeat recently. */
  runnersOnline(): number;
  /** Aggregate advertised worker capacity, without exposing runner identities. */
  capacitySummary?(): CsapiCapacitySummary;
  /** Whether a model id is routable ("auto" is always routable). */
  modelIsKnown(model: string): boolean;
  /** Resolve a usable workspace id, preferring `preferred`. Undefined if none. */
  pickWorkspaceId(preferred?: string): Promise<string | undefined>;
  /** The service principal user id that owns csapi runs. */
  getPrincipalId(): Promise<string>;
  /** Create a fresh conversation, returning its id. */
  createConversation(input: {
    principalId: string;
    workspaceId: string;
    title: string;
  }): Promise<string>;
  /** Whether a conversation still exists and is usable for this principal. */
  conversationExists(conversationId: string, principalId: string): Promise<boolean>;
  /** Resolve a durable conversation for an upstream session id, when supported. */
  resolveConversation?(input: {
    principalId: string;
    workspaceId: string;
    sessionKey: string;
    title: string;
  }): Promise<{ conversationId: string; created: boolean }>;
  /** Enqueue a plaintext run and return a handle. */
  createRun(input: {
    principalId: string;
    conversationId: string;
    model: string;
    workspaceId: string;
    prompt: string;
    allowWrites: boolean;
    keyId: string;
    idempotencyKey?: string;
  }): Promise<CsapiRunHandle>;
  /** Fetch the current run state for polling. Undefined if not found. */
  getRun(runId: string, principalId: string): Promise<CsapiRunSnapshot | undefined>;
  /** Read-only, API-key-scoped evidence lookup for acceptance validation. */
  observeByIdempotencyKey(
    idempotencyKey: string,
    principalId: string,
    keyId: string
  ): Promise<CsapiRunObservation[]>;
  /** Read-only, API-key-scoped evidence lookup by opaque run UUID. */
  observeByRunId(
    runId: string,
    principalId: string,
    keyId: string
  ): Promise<CsapiRunObservation | undefined>;
  /** Conditionally cancel an active plaintext run and return its terminal snapshot. */
  cancelRun(
    runId: string,
    principalId: string,
    reason: CsapiCancelReason,
    timeoutMs?: number
  ): Promise<CsapiRunSnapshot | undefined>;
  /** Structured audit hook (no secrets / no prompt content). */
  audit(input: { actorUserId?: string; eventType: string; details?: unknown }): Promise<void>;
}

type EvidenceRun = {
  id: string;
  status: RunStatus;
  response: string | null;
  error: string | null;
  progress: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  lastActivityAt: string | null;
  cancelReason: string | null;
  claimAttempts: number;
  model: string;
};

function snapshotFromRun(run: EvidenceRun): CsapiRunSnapshot {
  return {
    status: run.status,
    response: run.response,
    error: run.error,
    progress: run.progress,
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    queuedAt: run.queuedAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    lastActivityAt: run.lastActivityAt,
    cancelReason: run.cancelReason,
    model: run.model,
    provider: providerForModel(run.model)
  };
}

function observationFromRun(run: EvidenceRun): CsapiRunObservation {
  return {
    runId: run.id,
    status: run.status,
    queuedAt: run.queuedAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    lastActivityAt: run.lastActivityAt,
    terminal: isTerminalRunStatus(run.status),
    cancelReason: run.cancelReason,
    claimAttempts: run.claimAttempts,
    provider: providerForModel(run.model),
    model: run.model,
    applicationStatusCode: applicationStatusCodeForRun(
      run.status,
      run.cancelReason
    )
  };
}

/**
 * Build the production backend wired to the gateway's PostgreSQL layer and the
 * in-memory runner registry. Imported lazily so tests can avoid pulling in the
 * database module.
 */
export async function createDbBackend(): Promise<CsapiBackend> {
  const db = await import("../db.js");
  const registry = await import("../runnerRegistry.js");

  let cachedPrincipalId: string | undefined;

  return {
    listModelIds() {
      return registry.listModels().map((m) => m.id);
    },
    runnersOnline() {
      return registry.listRunnerHeartbeats().length;
    },
    capacitySummary() {
      const runners = registry.listRunnerHeartbeats();
      return {
        runnerIdentities: runners.length,
        totalRunnerSlots: runners.reduce(
          (total, runner) => total + runner.maxConcurrentJobs,
          0
        )
      };
    },
    modelIsKnown(model: string) {
      return registry.modelIsKnown(model);
    },
    async pickWorkspaceId(preferred?: string) {
      const workspaces = await db.listWorkspaces();
      if (preferred) {
        const match = workspaces.find((w) => w.id === preferred);
        if (match) return match.id;
      }
      return workspaces[0]?.id;
    },
    async getPrincipalId() {
      if (cachedPrincipalId) return cachedPrincipalId;
      const service = await db.upsertServicePrincipal("csapi", "operator");
      cachedPrincipalId = service.id;
      return cachedPrincipalId;
    },
    async createConversation(input) {
      const conversation = await db.createConversation({
        userId: input.principalId,
        workspaceId: input.workspaceId,
        title: input.title.slice(0, 80)
      });
      return conversation.id;
    },
    async conversationExists(conversationId, principalId) {
      const conversation = await db.getConversation(conversationId, principalId);
      return Boolean(conversation);
    },
    async resolveConversation(input) {
      const threadHash = createHash("sha256").update(input.sessionKey).digest("hex");
      const resolved = await db.getOrCreateAutomationThreadConversation({
        userId: input.principalId,
        threadKey: `csapi:${threadHash}`,
        workspaceId: input.workspaceId,
        title: input.title.slice(0, 80)
      });
      return resolved;
    },
    async createRun(input) {
      if (input.idempotencyKey) {
        const existing = await db.getRunByIdempotencyKey(input.principalId, input.idempotencyKey);
        if (existing) {
          return { runId: existing.id, conversationId: existing.conversationId, status: existing.status };
        }
      }
      let run;
      try {
        run = await db.createRun({
          conversationId: input.conversationId,
          userId: input.principalId,
          origin: "automation",
          status: "queued",
          model: input.model,
          workspaceId: input.workspaceId,
          prompt: input.prompt,
          allowWrites: input.allowWrites,
          memoryEnabled: false,
          csapiKeyId: input.keyId,
          ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {})
        });
      } catch (error) {
        if (
          !input.idempotencyKey ||
          !error ||
          typeof error !== "object" ||
          (error as { code?: unknown }).code !== "23505"
        ) {
          throw error;
        }
        const existing = await db.getRunByIdempotencyKey(input.principalId, input.idempotencyKey);
        if (!existing) throw error;
        return { runId: existing.id, conversationId: existing.conversationId, status: existing.status };
      }
      return { runId: run.id, conversationId: run.conversationId, status: run.status };
    },
    async getRun(runId, principalId) {
      const run = await db.getRunForUser(runId, principalId);
      if (!run) return undefined;
      return snapshotFromRun(run);
    },
    async observeByIdempotencyKey(idempotencyKey, principalId, keyId) {
      const run = await db.getRunByIdempotencyKey(
        principalId,
        idempotencyKey
      );
      if (!run || run.csapiKeyId !== keyId) return [];
      return [observationFromRun(run)];
    },
    async observeByRunId(runId, principalId, keyId) {
      const run = await db.getRunForUser(runId, principalId);
      if (!run || run.csapiKeyId !== keyId) return undefined;
      return observationFromRun(run);
    },
    async cancelRun(runId, principalId, reason, timeoutMs) {
      const run = await db.cancelRun(runId, principalId, reason, timeoutMs);
      if (!run) return undefined;
      return snapshotFromRun(run);
    },
    async audit(input) {
      await db.appendAudit(input);
    }
  };
}
