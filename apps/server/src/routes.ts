import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { createReadStream, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  E2EE_PROTOCOL,
  automationCreateRunSchema,
  createRunSchema,
  e2eeApprovalSubmissionSchema,
  e2eeCreateRunRequestSchema,
  e2eeLeaseRenewalSchema,
  e2eeMemoryCreateRequestSchema,
  e2eeProgressSubmissionSchema,
  e2eeResultSubmissionSchema,
  e2eeRunnerClaimRequestSchema,
  e2eeRunnerHeartbeatSchema,
  reportIdSchema,
  reportQuestionSchema,
  runnerJobResultSchema,
  runnerJobProgressSchema,
  workspaceSchema,
  modelSchema
} from "@cursor-gateway/shared";
import {
  requireAutomation,
  requireCloudflareUser,
  requireHermesRunner,
  requireRunner,
  requireRole
} from "./auth.js";
import { config } from "./config.js";

const serverRoot = dirname(fileURLToPath(import.meta.url));
const extensionZipPath = join(serverRoot, "../../../artifacts/cursor-gateway-secure.zip");
import {
  AutomationThreadWorkspaceMismatchError,
  type RunExecutor,
  addMemoryFact,
  appendAudit,
  approveRun,
  claimNextRun,
  createAutomationThreadRun,
  createConversation,
  createRun,
  finishRun,
  updateRunProgress,
  getConversation,
  getAutomationThreadRun,
  getRunByIdempotencyKey,
  getRunForUser,
  getRunWithConversation,
  getWorkspace,
  listCompletedConversationHistory,
  listAutomationThreadRuns,
  listConversationRuns,
  listConversations,
  listMemoryFacts,
  listRuns,
  listTrash,
  listWorkspaces,
  requeueStaleRuns,
  restoreConversation,
  restoreRun,
  softDeleteConversation,
  softDeleteRun,
  updateConversationAgent,
  upsertServicePrincipal
} from "./db.js";
import {
  E2eeConflictError,
  addE2eeMemory,
  claimNextE2eeRun,
  createE2eeRun,
  finishE2eeRun,
  getE2eeRunner,
  getE2eeRunForUser,
  listE2eeConversationRuns,
  listE2eeConversations,
  listE2eeMemory,
  listE2eeRunners,
  renewE2eeLease,
  scrubLegacyData,
  submitE2eeApproval,
  updateE2eeProgress,
  upsertE2eeRunner
} from "./e2eeDb.js";
import { truncateConversationHistory } from "./history.js";
import {
  buildReportQuestionPrompt,
  getReport,
  reportQuestionThreadKey,
  REPORTS
} from "./reports.js";
import {
  listModels,
  listRunnerHeartbeats,
  modelIsHermes,
  modelIsKnown,
  registerRunner
} from "./runnerRegistry.js";

const heartbeatSchema = z.object({
  runnerId: z.string().min(1),
  models: z.array(modelSchema),
  workspaces: z.array(workspaceSchema)
});

const memoryCreateSchema = z.object({
  content: z.string().min(1),
  scope: z.enum(["user", "workspace"]).default("user"),
  workspaceId: z.string().min(1).optional()
});

const scrubLegacySchema = z
  .object({
    archiveId: z.string().uuid(),
    conversationIds: z.array(z.string().uuid()).max(1_000),
    memoryIds: z.array(z.string().uuid()).max(10_000),
    acknowledgement: z.literal("local-encrypted-archive-verified")
  })
  .strict();

// A resumed local agent that no longer exists on the runner. Distinct from
// region/model/auth errors, which must NOT clear the stored agent id.
function looksLikeMissingAgent(error: string | null): boolean {
  if (!error) return false;
  const text = error.toLowerCase();
  return (
    /\b(agent|session)\b/.test(text) &&
    /\b(not found|does not exist|no longer exists|unknown agent|unknown session)\b/.test(text)
  );
}

async function claimJobFor(executor: RunExecutor) {
  const run = await claimNextRun(executor);
  if (!run) return undefined;

  const row = await getRunWithConversation(run.id);
  const workspace = await getWorkspace(run.workspaceId);
  if (!row || !workspace) {
    await finishRun({
      runId: run.id,
      status: "error",
      response: null,
      error: "run_workspace_or_conversation_missing"
    });
    return undefined;
  }

  const [memoryFacts, completedHistory] = await Promise.all([
    row.memory_enabled
      ? listMemoryFacts({
          userId: row.user_id,
          workspaceId: run.workspaceId
        })
      : Promise.resolve([]),
    listCompletedConversationHistory({
      conversationId: run.conversationId,
      beforeRunId: run.id
    })
  ]);

  return {
    runId: run.id,
    conversationId: run.conversationId,
    agentId: row.agent_id,
    model: run.model,
    prompt: run.prompt,
    workspace,
    userIdentity: row.display_name ?? row.email ?? row.telegram_user_id ?? undefined,
    memory: memoryFacts.map((fact) => fact.content),
    history: truncateConversationHistory(completedHistory),
    allowWrites: row.allow_writes
  };
}

export async function registerRoutes(app: FastifyInstance) {
  app.get("/healthz", async () => ({ ok: true }));

  app.register(async (api) => {
    api.addHook("preHandler", requireCloudflareUser);

    api.get("/me", async (request) => ({ principal: request.principal }));

    api.get("/extension/download", async (request, reply) => {
      if (!existsSync(extensionZipPath)) {
        await appendAudit({
          ...(request.principal?.id ? { actorUserId: request.principal.id } : {}),
          eventType: "extension.download.missing",
          details: { path: "/api/extension/download" }
        });
        return reply.code(404).send({ error: "extension_bundle_unavailable" });
      }

      const { size } = statSync(extensionZipPath);
      await appendAudit({
        ...(request.principal?.id ? { actorUserId: request.principal.id } : {}),
        eventType: "extension.download",
        details: { bytes: size }
      });

      return reply
        .header("content-type", "application/zip")
        .header("content-length", size)
        .header("content-disposition", 'attachment; filename="cursor-gateway-secure.zip"')
        .header("cache-control", "no-store")
        .send(createReadStream(extensionZipPath));
    });

    api.get("/e2ee-policy", async () => ({
      requiredForWeb: config.e2eeRequiredForWeb,
      protocol: E2EE_PROTOCOL,
      trustedClient: "signed-browser-extension"
    }));

    api.get("/models", async () => ({
      models: [{ id: "auto", displayName: "Auto" }, ...listModels()],
      defaultModelId: config.webDefaultModel
    }));

    api.get("/workspaces", async () => ({ workspaces: await listWorkspaces() }));

    api.get("/trash", async (request) => {
      return listTrash(request.principal!.id);
    });

    api.post("/trash/runs/:runId/restore", async (request, reply) => {
      const params = z.object({ runId: z.string().uuid() }).parse(request.params);
      const run = await restoreRun(params.runId, request.principal!.id);
      if (!run) return reply.code(404).send({ error: "trashed_run_not_found" });
      await appendAudit({
        actorUserId: request.principal!.id,
        eventType: "run.restored",
        details: { runId: params.runId }
      });
      return { restored: true, run };
    });

    api.post("/trash/conversations/:conversationId/restore", async (request, reply) => {
      const params = z.object({ conversationId: z.string().uuid() }).parse(request.params);
      const restored = await restoreConversation(params.conversationId, request.principal!.id);
      if (!restored) {
        return reply.code(404).send({ error: "trashed_conversation_not_found" });
      }
      await appendAudit({
        actorUserId: request.principal!.id,
        eventType: "conversation.restored",
        details: { conversationId: params.conversationId }
      });
      return { restored: true };
    });

    api.get("/reports", async () => {
      const service = await upsertServicePrincipal("automation", "operator");
      const reports = await Promise.all(
        REPORTS.map(async (report) => {
          const runs = await listAutomationThreadRuns({
            userId: service.id,
            threadKey: report.threadKey
          });
          return {
            ...report,
            runCount: runs.length,
            latestRun: runs[0] ?? null
          };
        })
      );
      return {
        reports,
        configured: Boolean(config.reportModelId && config.reportWorkspaceId)
      };
    });

    api.get("/reports/:reportId", async (request, reply) => {
      const params = z.object({ reportId: reportIdSchema }).parse(request.params);
      const report = getReport(params.reportId);
      if (!report) return reply.code(404).send({ error: "report_not_found" });
      const service = await upsertServicePrincipal("automation", "operator");
      const [editions, questions] = await Promise.all([
        listAutomationThreadRuns({
          userId: service.id,
          threadKey: report.threadKey
        }),
        listAutomationThreadRuns({
          userId: service.id,
          threadKey: reportQuestionThreadKey(report)
        })
      ]);
      return {
        report,
        runs: [...editions, ...questions].sort(
          (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)
        ),
        configured: Boolean(config.reportModelId && config.reportWorkspaceId)
      };
    });

    api.get("/reports/:reportId/runs/:runId", async (request, reply) => {
      const params = z
        .object({ reportId: reportIdSchema, runId: z.string().uuid() })
        .parse(request.params);
      const report = getReport(params.reportId);
      if (!report) return reply.code(404).send({ error: "report_not_found" });
      const service = await upsertServicePrincipal("automation", "operator");
      const edition = await getAutomationThreadRun({
        userId: service.id,
        threadKey: report.threadKey,
        runId: params.runId
      });
      const run =
        edition ??
        (await getAutomationThreadRun({
          userId: service.id,
          threadKey: reportQuestionThreadKey(report),
          runId: params.runId
        }));
      if (!run) return reply.code(404).send({ error: "run_not_found" });
      return { run };
    });

    api.post("/reports/:reportId/questions", async (request, reply) => {
      const params = z.object({ reportId: reportIdSchema }).parse(request.params);
      const body = reportQuestionSchema.parse(request.body);
      const report = getReport(params.reportId);
      if (!report) return reply.code(404).send({ error: "report_not_found" });
      if (!config.reportModelId) {
        return reply.code(503).send({ error: "report_model_not_configured" });
      }
      if (!config.reportWorkspaceId) {
        return reply.code(503).send({ error: "report_workspace_not_configured" });
      }
      if (!modelIsKnown(config.reportModelId)) {
        return reply.code(503).send({ error: "report_model_not_available" });
      }
      const workspace = await getWorkspace(config.reportWorkspaceId);
      if (!workspace) {
        return reply.code(503).send({ error: "report_workspace_not_available" });
      }

      const service = await upsertServicePrincipal("automation", "operator");
      const reportHistory = await listAutomationThreadRuns({
        userId: service.id,
        threadKey: report.threadKey
      });
      const reportArchive = reportHistory
        .filter((run) => run.status === "finished" && Boolean(run.response))
        .slice(0, 3)
        .map((run) => ({
          date: run.idempotencyKey?.split(":").at(-1) ?? run.createdAt.slice(0, 10),
          content: run.response!
        }));
      const result = await createAutomationThreadRun({
        userId: service.id,
        threadKey: reportQuestionThreadKey(report),
        title: `${report.name} · AI 问答`,
        status: "queued",
        model: config.reportModelId,
        workspaceId: workspace.id,
        prompt: buildReportQuestionPrompt(report, body.question, reportArchive),
        idempotencyKey: `qa:${report.id}:${body.requestId}`,
        allowWrites: false
      });
      if (result.created) {
        await appendAudit({
          actorUserId: request.principal!.id,
          eventType: "report.question.created",
          details: {
            reportId: report.id,
            runId: result.run.id,
            conversationId: result.run.conversationId
          }
        });
      }
      return reply
        .code(result.created ? 202 : 200)
        .send({ run: result.run, idempotent: !result.created });
    });

    api.get("/conversations", async (request) => {
      const query = z
        .object({ limit: z.coerce.number().int().positive().max(1_000).default(100) })
        .parse(request.query);
      return {
        conversations: await listConversations(request.principal!.id, query.limit)
      };
    });

    api.get("/conversations/:conversationId/runs", async (request, reply) => {
      const params = z.object({ conversationId: z.string().uuid() }).parse(request.params);
      const runs = await listConversationRuns({
        conversationId: params.conversationId,
        userId: request.principal!.id
      });
      if (!runs) return reply.code(404).send({ error: "conversation_not_found" });
      return { runs };
    });

    api.delete("/conversations/:conversationId", async (request, reply) => {
      const params = z.object({ conversationId: z.string().uuid() }).parse(request.params);
      const result = await softDeleteConversation(params.conversationId, request.principal!.id);
      if (result.status === "not_found") {
        return reply.code(404).send({ error: "conversation_not_found" });
      }
      if (result.status === "running") {
        return reply.code(409).send({ error: "conversation_has_running_run" });
      }
      await appendAudit({
        actorUserId: request.principal!.id,
        eventType: "conversation.deleted",
        details: { conversationId: params.conversationId, mode: "soft" }
      });
      return { deleted: true };
    });

    // Use a dashboard-specific path instead of `/api/runners`: Cloudflare
    // Access policies for the host-local runner API may bypass `/api/runner*`,
    // which also catches plural `/api/runners` and strips the identity header.
    // Without the CF email header the app correctly returns email_not_allowed.
    api.get("/dashboard-runners", async (request, reply) => {
      if (!request.principal || !requireRole(request.principal, ["admin", "operator"])) {
        return reply.code(403).send({ error: "not_allowed" });
      }
      return { runners: listRunnerHeartbeats() };
    });

    api.get("/runs", async (request) => {
      return { runs: await listRuns(request.principal!.id) };
    });

    api.get("/runs/:runId", async (request, reply) => {
      const params = z.object({ runId: z.string().uuid() }).parse(request.params);
      const run = await getRunForUser(params.runId, request.principal!.id);
      if (!run) return reply.code(404).send({ error: "run_not_found" });
      return { run };
    });

    api.delete("/runs/:runId", async (request, reply) => {
      const params = z.object({ runId: z.string().uuid() }).parse(request.params);
      const result = await softDeleteRun(params.runId, request.principal!.id);
      if (result.status === "not_found") {
        return reply.code(404).send({ error: "run_not_found" });
      }
      if (result.status === "running") {
        return reply.code(409).send({ error: "run_is_running" });
      }
      await appendAudit({
        actorUserId: request.principal!.id,
        eventType: "run.deleted",
        details: { runId: params.runId, mode: "soft" }
      });
      return { deleted: true };
    });

    api.post("/runs/:runId/approve", async (request, reply) => {
      const params = z.object({ runId: z.string().uuid() }).parse(request.params);
      const run = await approveRun(params.runId, request.principal!.id);
      if (!run) return reply.code(404).send({ error: "run_not_approvable" });
      await appendAudit({
        actorUserId: request.principal!.id,
        eventType: "run.approved",
        details: { runId: params.runId }
      });
      return { run };
    });

    api.post("/runs", async (request, reply) => {
      if (config.e2eeRequiredForWeb) {
        return reply.code(426).send({
          error: "e2ee_required_for_web",
          protocol: E2EE_PROTOCOL
        });
      }
      const body = createRunSchema.parse(request.body);
      const principal = request.principal!;

      if (!modelIsKnown(body.model)) {
        return reply.code(400).send({ error: "model_not_available" });
      }
      if (body.allowWrites && modelIsHermes(body.model)) {
        return reply.code(400).send({ error: "hermes_model_is_qa_only" });
      }

      const workspace = await getWorkspace(body.workspaceId);
      if (!workspace) return reply.code(400).send({ error: "workspace_not_allowed" });
      if (body.allowWrites && !workspace.writable) {
        return reply.code(403).send({ error: "workspace_read_only" });
      }

      const conversation = body.conversationId
        ? await getConversation(body.conversationId, principal.id)
        : await createConversation({
            userId: principal.id,
            workspaceId: body.workspaceId,
            title: body.prompt.slice(0, 80)
          });

      if (!conversation) return reply.code(404).send({ error: "conversation_not_found" });
      if (conversation.workspace_id !== body.workspaceId) {
        return reply.code(400).send({ error: "conversation_workspace_mismatch" });
      }

      const status = config.runnerRequireApproval && body.allowWrites ? "waiting_approval" : "queued";
      const run = await createRun({
        conversationId: conversation.id,
        userId: principal.id,
        origin: body.origin,
        status,
        model: body.model,
        workspaceId: body.workspaceId,
        prompt: body.prompt,
        allowWrites: body.allowWrites,
        memoryEnabled: body.memoryEnabled
      });

      await appendAudit({
        actorUserId: principal.id,
        eventType: "run.created",
        details: {
          runId: run.id,
          conversationId: run.conversationId,
          model: run.model,
          workspaceId: run.workspaceId,
          origin: body.origin,
          allowWrites: body.allowWrites,
          status
        }
      });

      return reply.code(202).send({ run });
    });

    api.get("/memory", async (request) => {
      const query = z
        .object({
          workspaceId: z.string().optional(),
          limit: z.coerce.number().int().positive().max(10_000).default(12)
        })
        .parse(request.query);
      return {
        facts: await listMemoryFacts({
          userId: request.principal!.id,
          workspaceId: query.workspaceId,
          limit: query.limit
        })
      };
    });

    api.post("/memory", async (request, reply) => {
      if (config.e2eeRequiredForWeb) {
        return reply.code(426).send({
          error: "e2ee_required_for_web_memory",
          protocol: E2EE_PROTOCOL
        });
      }
      const body = memoryCreateSchema.parse(request.body);
      if (body.scope === "workspace" && !body.workspaceId) {
        return reply.code(400).send({ error: "workspace_required" });
      }
      const fact = await addMemoryFact({
        userId: request.principal!.id,
        scope: body.scope,
        workspaceId: body.scope === "workspace" ? body.workspaceId! : null,
        content: body.content
      });
      await appendAudit({
        actorUserId: request.principal!.id,
        eventType: "memory.created",
        details: { factId: fact.id, scope: fact.scope, workspaceId: fact.workspaceId }
      });
      return reply.code(201).send({ fact });
    });

    api.register(
      async (secure) => {
        secure.addHook("onSend", async (_request, reply, payload) => {
          reply.header("cache-control", "no-store");
          reply.header("pragma", "no-cache");
          return payload;
        });

        secure.get("/runners", async () => ({ runners: await listE2eeRunners() }));

        secure.get("/conversations", async (request) => ({
          conversations: await listE2eeConversations(request.principal!.id)
        }));

        secure.get("/conversations/:conversationId/runs", async (request, reply) => {
          const params = z.object({ conversationId: z.string().uuid() }).parse(request.params);
          const runs = await listE2eeConversationRuns({
            userId: request.principal!.id,
            conversationId: params.conversationId
          });
          if (!runs) return reply.code(404).send({ error: "conversation_not_found" });
          return { runs };
        });

        secure.get("/runs/:runId", async (request, reply) => {
          const params = z.object({ runId: z.string().uuid() }).parse(request.params);
          const run = await getE2eeRunForUser(params.runId, request.principal!.id);
          if (!run) return reply.code(404).send({ error: "run_not_found" });
          return { run };
        });

        secure.post("/runs", async (request, reply) => {
          const body = e2eeCreateRunRequestSchema.parse(request.body);
          const envelope = body.request;
          const runner = await getE2eeRunner(envelope.runnerId);
          if (!runner || !runner.online) {
            return reply.code(503).send({ error: "e2ee_runner_offline" });
          }
          if (
            !runner.e2ee.protocols.includes(E2EE_PROTOCOL) ||
            runner.e2ee.encryptionKey.keyId !== envelope.runnerKeyId
          ) {
            return reply.code(409).send({ error: "e2ee_runner_key_mismatch" });
          }
          const workspace = runner.workspaces.find(
            (item) => item.id === envelope.routing.workspaceId
          );
          if (!workspace) {
            return reply.code(400).send({ error: "workspace_not_available_on_runner" });
          }
          if (envelope.routing.allowWrites && !workspace.writable) {
            return reply.code(403).send({ error: "workspace_read_only" });
          }
          if (
            envelope.routing.model !== "auto" &&
            !runner.models.some((item) => item.id === envelope.routing.model)
          ) {
            return reply.code(400).send({ error: "model_not_available_on_runner" });
          }
          if (modelIsHermes(envelope.routing.model)) {
            return reply.code(400).send({ error: "e2ee_hermes_not_supported" });
          }

          try {
            const result = await createE2eeRun({
              userId: request.principal!.id,
              request: envelope
            });
            if (result.created) {
              await appendAudit({
                actorUserId: request.principal!.id,
                eventType: "e2ee.run.created",
                details: {
                  runId: envelope.runId,
                  conversationId: envelope.conversationId,
                  clientId: envelope.clientId,
                  targetRunnerId: envelope.runnerId,
                  runnerKeyId: envelope.runnerKeyId,
                  model: envelope.routing.model,
                  workspaceId: envelope.routing.workspaceId,
                  allowWrites: envelope.routing.allowWrites,
                  ciphertextBytes: envelope.payload.ciphertext.length
                }
              });
            }
            return reply
              .code(result.created ? 202 : 200)
              .send({ run: result.run, idempotent: !result.created });
          } catch (error) {
            if (error instanceof E2eeConflictError) {
              return reply.code(409).send({ error: error.code });
            }
            throw error;
          }
        });

        secure.post("/runs/:runId/approval", async (request, reply) => {
          const params = z.object({ runId: z.string().uuid() }).parse(request.params);
          const body = e2eeApprovalSubmissionSchema.parse(request.body);
          if (body.approval.runId !== params.runId) {
            return reply.code(400).send({ error: "run_id_mismatch" });
          }
          try {
            const run = await submitE2eeApproval({
              userId: request.principal!.id,
              approval: body.approval
            });
            if (!run) return reply.code(404).send({ error: "run_not_approvable" });
            await appendAudit({
              actorUserId: request.principal!.id,
              eventType: "e2ee.run.approved",
              details: {
                runId: body.approval.runId,
                conversationId: body.approval.conversationId,
                clientId: body.approval.clientId
              }
            });
            return { run };
          } catch (error) {
            if (error instanceof E2eeConflictError) {
              return reply.code(409).send({ error: error.code });
            }
            throw error;
          }
        });

        secure.get("/memory", async (request) => {
          const query = z.object({ workspaceId: z.string().optional() }).parse(request.query);
          return {
            memory: await listE2eeMemory({
              userId: request.principal!.id,
              workspaceId: query.workspaceId
            })
          };
        });

        secure.post("/memory", async (request, reply) => {
          const body = e2eeMemoryCreateRequestSchema.parse(request.body);
          try {
            const result = await addE2eeMemory({
              userId: request.principal!.id,
              envelope: body.envelope
            });
            if (result.created) {
              await appendAudit({
                actorUserId: request.principal!.id,
                eventType: "e2ee.memory.created",
                details: {
                  memoryId: body.envelope.memoryId,
                  clientId: body.envelope.clientId,
                  scope: body.envelope.scope,
                  workspaceId: body.envelope.workspaceId,
                  ciphertextBytes: body.envelope.payload.ciphertext.length
                }
              });
            }
            return reply
              .code(result.created ? 201 : 200)
              .send({ memory: result.memory, idempotent: !result.created });
          } catch (error) {
            if (error instanceof E2eeConflictError) {
              return reply.code(409).send({ error: error.code });
            }
            throw error;
          }
        });

        secure.post("/migrations/scrub-legacy", async (request, reply) => {
          const body = scrubLegacySchema.parse(request.body);
          try {
            const scrubbed = await scrubLegacyData({
              userId: request.principal!.id,
              conversationIds: body.conversationIds,
              memoryIds: body.memoryIds
            });
            await appendAudit({
              actorUserId: request.principal!.id,
              eventType: "e2ee.legacy.scrubbed",
              details: {
                archiveId: body.archiveId,
                conversationCount: scrubbed.conversations,
                runCount: scrubbed.runs,
                memoryCount: scrubbed.memory
              }
            });
            return scrubbed;
          } catch (error) {
            if (error instanceof E2eeConflictError) {
              return reply.code(409).send({ error: error.code });
            }
            throw error;
          }
        });
      },
      { prefix: "/e2ee/v1" }
    );
  }, { prefix: "/api" });

  app.register(async (automation) => {
    automation.addHook("preHandler", requireAutomation);

    automation.get("/models", async () => ({
      models: [{ id: "auto", displayName: "Auto" }, ...listModels()]
    }));

    automation.get("/workspaces", async () => ({
      workspaces: await listWorkspaces()
    }));

    automation.get("/runs/:runId", async (request, reply) => {
      const params = z.object({ runId: z.string().uuid() }).parse(request.params);
      const run = await getRunForUser(params.runId, request.principal!.id);
      if (!run) return reply.code(404).send({ error: "run_not_found" });
      return { run };
    });

    automation.post("/runs", async (request, reply) => {
      const body = automationCreateRunSchema.parse(request.body);
      const principal = request.principal!;

      const existing = await getRunByIdempotencyKey(principal.id, body.idempotencyKey);
      if (existing) return reply.code(200).send({ run: existing, idempotent: true });

      if (!modelIsKnown(body.model)) {
        return reply.code(400).send({ error: "model_not_available" });
      }
      if (body.allowWrites && modelIsHermes(body.model)) {
        return reply.code(400).send({ error: "hermes_model_is_qa_only" });
      }

      const workspace = await getWorkspace(body.workspaceId);
      if (!workspace) return reply.code(400).send({ error: "workspace_not_allowed" });
      if (body.allowWrites && !workspace.writable) {
        return reply.code(403).send({ error: "workspace_read_only" });
      }

      const status = config.runnerRequireApproval && body.allowWrites ? "waiting_approval" : "queued";
      try {
        const result = await createAutomationThreadRun({
          userId: principal.id,
          threadKey: body.threadKey,
          ...(body.title ? { title: body.title } : {}),
          status,
          model: body.model,
          workspaceId: body.workspaceId,
          prompt: body.prompt,
          idempotencyKey: body.idempotencyKey,
          allowWrites: body.allowWrites
        });

        if (result.created) {
          await appendAudit({
            actorUserId: principal.id,
            eventType: "automation.run.created",
            details: {
              runId: result.run.id,
              conversationId: result.run.conversationId,
              threadKey: body.threadKey,
              model: result.run.model,
              workspaceId: result.run.workspaceId,
              allowWrites: result.run.allowWrites,
              status: result.run.status
            }
          });
        }

        return reply
          .code(result.created ? 202 : 200)
          .send({ run: result.run, idempotent: !result.created });
      } catch (error) {
        if (error instanceof AutomationThreadWorkspaceMismatchError) {
          return reply.code(409).send({
            error: "thread_workspace_mismatch",
            workspaceId: error.existingWorkspaceId
          });
        }
        throw error;
      }
    });
  }, { prefix: "/api/automation" });

  app.register(async (runner) => {
    runner.addHook("preHandler", requireRunner);

    runner.post("/heartbeat", async (request) => {
      const body = heartbeatSchema.parse(request.body);
      const heartbeat = await registerRunner(body);
      await appendAudit({
        eventType: "runner.heartbeat",
        details: {
          runnerId: body.runnerId,
          modelCount: body.models.length,
          workspaceCount: body.workspaces.length
        }
      });
      return { heartbeat };
    });

    runner.post("/jobs/claim", async (request, reply) => {
      const job = await claimJobFor("windows");
      return job ? { job } : reply.code(204).send();
    });

    runner.post("/jobs/:runId/result", async (request, reply) => {
      const params = z.object({ runId: z.string().uuid() }).parse(request.params);
      const body = runnerJobResultSchema.parse({ ...(request.body as object), runId: params.runId });
      const run = await finishRun({
        runId: body.runId,
        status: body.status,
        response: body.response,
        error: body.error,
        inputTokens: body.inputTokens,
        outputTokens: body.outputTokens
      });

      if (!run) return reply.code(404).send({ error: "run_not_found" });
      // Only trust an agent id from a successful run. Storing the id from a
      // failed run (e.g. a created agent that then hit a region/model error)
      // poisons the conversation: every later turn tries to resume a dead
      // agent. On a missing-agent failure, clear the stored id so the next
      // turn rebuilds a fresh agent instead of looping on the same error.
      if (body.status === "finished") {
        if (body.agentId) {
          await updateConversationAgent(run.conversationId, body.agentId);
        }
      } else if (looksLikeMissingAgent(body.error)) {
        await updateConversationAgent(run.conversationId, null);
      }
      await appendAudit({
        eventType: "run.finished",
        details: {
          runId: body.runId,
          status: body.status,
          agentId: body.agentId
        }
      });
      return { run };
    });

    runner.post("/jobs/:runId/progress", async (request, reply) => {
      const params = z.object({ runId: z.string().uuid() }).parse(request.params);
      const body = runnerJobProgressSchema.parse({ ...(request.body as object), runId: params.runId });
      const updated = await updateRunProgress({
        runId: body.runId,
        kind: body.kind,
        message: body.message
      });
      if (!updated) return reply.code(409).send({ error: "run_not_running" });
      return reply.code(204).send();
    });

    runner.post("/e2ee/v1/heartbeat", async (request) => {
      const body = e2eeRunnerHeartbeatSchema.parse(request.body);
      const heartbeat = await upsertE2eeRunner(body);
      await appendAudit({
        eventType: "e2ee.runner.heartbeat",
        details: {
          runnerId: body.runnerId,
          runnerVersion: body.runnerVersion,
          encryptionKeyId: body.e2ee.encryptionKey.keyId,
          signingKeyId: body.e2ee.signingKey.keyId,
          modelCount: body.models.length,
          workspaceCount: body.workspaces.length
        }
      });
      return { heartbeat };
    });

    runner.post("/e2ee/v1/jobs/claim", async (request, reply) => {
      const body = e2eeRunnerClaimRequestSchema.parse(request.body);
      const registered = await getE2eeRunner(body.runnerId);
      if (
        !registered ||
        registered.e2ee.encryptionKey.keyId !== body.runnerKeyId ||
        !body.protocols.includes(E2EE_PROTOCOL)
      ) {
        return reply.code(409).send({ error: "runner_e2ee_identity_mismatch" });
      }
      const job = await claimNextE2eeRun({
        runnerId: body.runnerId,
        runnerKeyId: body.runnerKeyId
      });
      return job ? { job } : reply.code(204).send();
    });

    runner.post("/e2ee/v1/jobs/:runId/lease", async (request, reply) => {
      const params = z.object({ runId: z.string().uuid() }).parse(request.params);
      const body = e2eeLeaseRenewalSchema.parse(request.body);
      const registered = await getE2eeRunner(body.runnerId);
      if (
        !registered ||
        registered.e2ee.encryptionKey.keyId !== body.runnerKeyId
      ) {
        return reply.code(409).send({ error: "runner_e2ee_identity_mismatch" });
      }
      const renewed = await renewE2eeLease({
        runId: params.runId,
        runnerId: body.runnerId,
        runnerKeyId: body.runnerKeyId,
        leaseId: body.leaseId
      });
      if (!renewed) return reply.code(409).send({ error: "run_lease_invalid" });
      return reply.code(204).send();
    });

    runner.post("/e2ee/v1/jobs/:runId/progress", async (request, reply) => {
      const params = z.object({ runId: z.string().uuid() }).parse(request.params);
      const body = e2eeProgressSubmissionSchema.parse(request.body);
      if (body.envelope.runId !== params.runId) {
        return reply.code(400).send({ error: "run_id_mismatch" });
      }
      const registered = await getE2eeRunner(body.envelope.runnerId);
      if (
        !registered ||
        registered.e2ee.signingKey.keyId !== body.envelope.signature.keyId ||
        registered.e2ee.encryptionKey.keyId !== body.envelope.runnerKeyId
      ) {
        return reply.code(409).send({ error: "runner_e2ee_identity_mismatch" });
      }
      const updated = await updateE2eeProgress({
        runnerId: body.envelope.runnerId,
        leaseId: body.leaseId,
        envelope: body.envelope
      });
      if (!updated) return reply.code(409).send({ error: "run_lease_or_sequence_invalid" });
      return reply.code(204).send();
    });

    runner.post("/e2ee/v1/jobs/:runId/result", async (request, reply) => {
      const params = z.object({ runId: z.string().uuid() }).parse(request.params);
      const body = e2eeResultSubmissionSchema.parse(request.body);
      if (body.envelope.runId !== params.runId) {
        return reply.code(400).send({ error: "run_id_mismatch" });
      }
      const registered = await getE2eeRunner(body.envelope.runnerId);
      if (
        !registered ||
        registered.e2ee.signingKey.keyId !== body.envelope.signature.keyId ||
        registered.e2ee.encryptionKey.keyId !== body.envelope.runnerKeyId
      ) {
        return reply.code(409).send({ error: "runner_e2ee_identity_mismatch" });
      }
      const run = await finishE2eeRun({
        runnerId: body.envelope.runnerId,
        leaseId: body.leaseId,
        envelope: body.envelope
      });
      if (!run) return reply.code(409).send({ error: "run_lease_invalid" });
      await appendAudit({
        eventType: "e2ee.run.finished",
        details: {
          runId: body.envelope.runId,
          conversationId: body.envelope.conversationId,
          runnerId: body.envelope.runnerId,
          status: body.envelope.status,
          resultMessageId: body.envelope.messageId,
          ciphertextBytes: body.envelope.payload.ciphertext.length
        }
      });
      return { run };
    });
  }, { prefix: "/api/runner" });

  app.register(async (hermesRunner) => {
    hermesRunner.addHook("preHandler", requireHermesRunner);

    hermesRunner.post("/heartbeat", async (request) => {
      const body = heartbeatSchema.parse(request.body);
      const requeued = await requeueStaleRuns("hermes");
      const heartbeat = await registerRunner(body);
      await appendAudit({
        eventType: "hermes_runner.heartbeat",
        details: {
          runnerId: body.runnerId,
          modelCount: body.models.length,
          requeued
        }
      });
      return { heartbeat };
    });

    hermesRunner.post("/jobs/claim", async (request, reply) => {
      const job = await claimJobFor("hermes");
      return job ? { job } : reply.code(204).send();
    });

    hermesRunner.post("/jobs/:runId/result", async (request, reply) => {
      const params = z.object({ runId: z.string().uuid() }).parse(request.params);
      const body = runnerJobResultSchema.parse({ ...(request.body as object), runId: params.runId });
      const run = await finishRun({
        runId: body.runId,
        status: body.status,
        response: body.response,
        error: body.error,
        inputTokens: body.inputTokens,
        outputTokens: body.outputTokens
      });

      if (!run) return reply.code(404).send({ error: "run_not_found" });
      if (body.status === "finished") {
        // A later Windows turn must rebuild from PostgreSQL history so it
        // includes turns answered by Hermes.
        await updateConversationAgent(run.conversationId, null);
      }
      await appendAudit({
        eventType: "hermes_runner.run.finished",
        details: {
          runId: body.runId,
          status: body.status
        }
      });
      return { run };
    });

    hermesRunner.post("/jobs/:runId/progress", async (request, reply) => {
      const params = z.object({ runId: z.string().uuid() }).parse(request.params);
      const body = runnerJobProgressSchema.parse({ ...(request.body as object), runId: params.runId });
      const updated = await updateRunProgress({
        runId: body.runId,
        kind: body.kind,
        message: body.message
      });
      if (!updated) return reply.code(409).send({ error: "run_not_running" });
      return reply.code(204).send();
    });
  }, { prefix: "/api/hermes-runner" });
}
