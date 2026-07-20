// Backend abstraction for the csapi facade.
//
// The route layer depends only on this interface, which lets us wire the real
// PostgreSQL-backed gateway in production and an in-memory fake in tests (no
// database required). Everything here is plaintext (方案 B); there is no E2EE.
import { createHash } from "node:crypto";
import type { RunStatus } from "@cursor-gateway/shared";

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
}

export interface CsapiBackend {
  /** Model ids currently advertised by online runners (excluding synthetic "auto"). */
  listModelIds(): string[];
  /** Number of runners that have sent a heartbeat recently. */
  runnersOnline(): number;
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
    idempotencyKey?: string;
  }): Promise<CsapiRunHandle>;
  /** Fetch the current run state for polling. Undefined if not found. */
  getRun(runId: string, principalId: string): Promise<CsapiRunSnapshot | undefined>;
  /** Best-effort cancel of a queued or running plaintext run. */
  cancelRun(runId: string, principalId: string): Promise<void>;
  /** Structured audit hook (no secrets / no prompt content). */
  audit(input: { actorUserId?: string; eventType: string; details?: unknown }): Promise<void>;
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
      return {
        status: run.status,
        response: run.response,
        error: run.error,
        progress: run.progress,
        inputTokens: run.inputTokens,
        outputTokens: run.outputTokens
      };
    },
    async cancelRun(runId, principalId) {
      await db.cancelRun(runId, principalId);
    },
    async audit(input) {
      await db.appendAudit(input);
    }
  };
}
