import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DESKTOP_ACCESS_BRIDGE_CSP,
  DESKTOP_DOWNLOAD_PATH,
  desktopAccessBridgeHtml,
  desktopArtifactPaths,
  readDesktopVersionMeta,
  resolveDesktopInstallerPath
} from "./desktopPublic.js";
import {
  E2EE_PROTOCOL,
  automationCreateRunSchema,
  createRunSchema,
  e2eeApprovalSubmissionSchema,
  e2eeCreateRunRequestSchema,
  e2eeLeaseRenewalSchema,
  e2eeMemoryCreateRequestSchema,
  e2eePairingAckSchema,
  e2eePairingCompleteRequestSchema,
  e2eePairingOfferSchema,
  e2eePairingStartRequestSchema,
  e2eeCsAuthGrantSchema,
  e2eeCsAuthIntentRequestSchema,
  e2eeProgressSubmissionSchema,
  e2eeResultSubmissionSchema,
  e2eeRunRejectionSchema,
  e2eeRunnerClaimRequestSchema,
  e2eeRunnerHeartbeatSchema,
  e2eePasskeyPairingStartRequestSchema,
  e2eePasskeyPairingCompleteRequestSchema,
  e2eePasskeyPairingOptionsSchema,
  e2eePasskeyPairingAckSchema,
  e2eeDeviceApprovalRequestBodySchema,
  e2eeDeviceApprovalDecisionBodySchema,
  e2eeDeviceApprovalResultSchema,
  e2eeRecoveryPairingStartRequestSchema,
  e2eeRecoveryPairingCompleteRequestSchema,
  e2eeRecoveryPairingOfferSchema,
  e2eeRecoveryPairingAckSchema,
  e2eeRecoveryHandleSchema,
  e2eeRunnerCodePairingStartRequestSchema,
  e2eeRunnerCodePairingConfirmRequestSchema,
  e2eeRunnerCodePairingOfferSchema,
  e2eeRunnerCodePairingAckSchema,
  interviewActivationSchema,
  interviewEntitlementProvisionSchema,
  interviewProfileUpdateSchema,
  interviewProgressUpdateSchema,
  personalizedInterviewQuestionSchema,
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
import { config, isAllowedSecureOrigin } from "./config.js";
import { verifyRunnerEnvelopeSignature } from "./e2eeRunnerSignature.js";

const runnerLeaseIdentitySchema = z
  .object({
    runnerId: z.string().trim().min(1).max(128),
    leaseId: z.string().uuid()
  })
  .strict();
const runnerResultSubmissionSchema = runnerJobResultSchema
  .extend(runnerLeaseIdentitySchema.shape)
  .strict();
const runnerProgressSubmissionSchema = runnerJobProgressSchema
  .extend(runnerLeaseIdentitySchema.shape)
  .strict();
const hermesResultSubmissionSchema = runnerJobResultSchema
  .extend({ leaseId: z.string().uuid() })
  .strict();
const hermesProgressSubmissionSchema = runnerJobProgressSchema
  .extend({ leaseId: z.string().uuid() })
  .strict();

const serverRoot = dirname(fileURLToPath(import.meta.url));
const extensionZipPath = join(serverRoot, "../../../artifacts/cursor-gateway-secure.zip");
const {
  installerCandidates: desktopInstallerCandidates,
  versionPath: desktopVersionPath,
  sha256SumsPath: desktopSha256SumsPath
} = desktopArtifactPaths(serverRoot);
// Re-resolve per request so a deploy that adds the installer after startup
// (or uses a legacy layout) is picked up without a server restart.
const currentDesktopInstallerPath = () => resolveDesktopInstallerPath(desktopInstallerCandidates);
import {
  AutomationThreadWorkspaceMismatchError,
  type RunExecutor,
  addMemoryFact,
  activateInterviewEntitlement,
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
  getInterviewEntitlementForUser,
  getInterviewProfile,
  getRunByIdempotencyKey,
  getRunForUser,
  getRunWithConversation,
  getWorkspace,
  listCompletedConversationHistory,
  listAutomationThreadRuns,
  listConversationRuns,
  listConversations,
  listInterviewProgress,
  listMemoryFacts,
  listRuns,
  listTrash,
  listWorkspaces,
  recoverStaleRuns,
  renewRunLease,
  provisionInterviewEntitlement,
  restoreConversation,
  restoreRun,
  softDeleteConversation,
  softDeleteRun,
  updateConversationAgent,
  upsertInterviewProfile,
  upsertInterviewProgress,
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
  rejectE2eeRun,
  renewE2eeLease,
  scrubLegacyData,
  submitE2eeApproval,
  updateE2eeProgress,
  upsertE2eeRunner
} from "./e2eeDb.js";
import {
  PairingConflictError,
  claimNextPairingComplete,
  claimNextPairingStart,
  createPairingStart,
  getPairingForUser,
  listDevicesForUser,
  listPendingRevocations,
  markRunnerRevoked,
  publishPairingAck,
  publishPairingOffer,
  revokeDeviceForUser,
  submitPairingComplete
} from "./pairingDb.js";
import {
  CsAuthConflictError,
  claimNextCsAuth,
  consumeCsAuthGrant,
  createCsAuthIntent,
  getCsAuthForUser,
  markCsAuthPendingRunner,
  publishCsAuthGrant
} from "./csAuthDb.js";
import {
  PasskeyPairingConflictError,
  claimNextPasskeyPairingComplete,
  claimNextPasskeyPairingStart,
  createPasskeyPairingStart,
  getPasskeyPairingForUser,
  publishPasskeyPairingAck,
  publishPasskeyPairingOptions,
  submitPasskeyPairingComplete
} from "./passkeyPairingDb.js";
import {
  DeviceApprovalConflictError,
  claimNextDeviceApprovalDecision,
  createDeviceApprovalRequest,
  getDeviceApprovalForUser,
  listPendingDeviceApprovalsForUser,
  publishDeviceApprovalResult,
  submitDeviceApprovalDecision
} from "./deviceApprovalDb.js";
import {
  RecoveryPairingConflictError,
  claimNextRecoveryPairingComplete,
  claimNextRecoveryPairingStart,
  createRecoveryPairingStart,
  getRecoveryHandle,
  getRecoveryPairingForUser,
  publishRecoveryHandle,
  publishRecoveryPairingAck,
  publishRecoveryPairingOffer,
  submitRecoveryPairingComplete
} from "./recoveryPairingDb.js";
import {
  RunnerCodeConflictError,
  attachRunnerCodeDeviceCert,
  claimNextRunnerCodeConfirm,
  claimNextRunnerCodeStart,
  createRunnerCodeStart,
  getRunnerCodeForUser,
  publishRunnerCodeAck,
  publishRunnerCodeOffer,
  submitRunnerCodeConfirm
} from "./runnerCodeEnrollDb.js";
import { maybeIssueRunnerCodeDeviceCert } from "./runnerCodeCert.js";
import {
  consumeEphemeralAccessJwt,
  peekEphemeralAccessJwt,
  putEphemeralAccessJwt
} from "./ephemeralAccessJwt.js";
import { loadServerTrustRoots } from "./trustRoots.js";
import { truncateConversationHistory } from "./history.js";
import {
  buildPersonalizedInterviewPrompt,
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

const INTERVIEW_COACH_THREAD = "personalized-interview-coach";

function hashActivationToken(token: string) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function buildInterviewRecommendations(
  profile: Awaited<ReturnType<typeof getInterviewProfile>>,
  progress: Awaited<ReturnType<typeof listInterviewProgress>>
) {
  const sourceStack = profile?.sourceStack.toLowerCase() ?? "";
  const javaTransition = sourceStack.includes("java") || sourceStack.includes("spring");
  const practicing = progress.filter((item) => item.status === "practicing").length;
  const mastered = progress.filter((item) => item.status === "mastered").length;
  const due = progress.filter(
    (item) => item.nextReviewAt && Date.parse(item.nextReviewAt) <= Date.now()
  ).length;

  return [
    {
      id: "daily-focus",
      title: javaTransition ? "先练 AI Agent 的 Java 工程化迁移" : "先补齐目标岗位的系统设计主线",
      detail: javaTransition
        ? "优先完成工具调用、SSE、并发隔离和可观测性题，再进入 Agent 编排与评测。"
        : "从最新真实面经中选 2 道系统设计题，按需求、架构、失败模式、指标和取舍作答。",
      href: javaTransition ? "/reports/ai-agent-mianshi" : "/reports/ai-infra-mianshi"
    },
    {
      id: "review-load",
      title: due > 0 ? `今天有 ${due} 道题到期复习` : "建立第一组间隔复习题",
      detail: `当前练习中 ${practicing} 道，已掌握 ${mastered} 道；建议每天新增不超过 3 道。`,
      href: "/interview#progress"
    },
    {
      id: "weekly-plan",
      title: `按每周 ${profile?.weeklyHours ?? 5} 小时安排训练`,
      detail: "建议 40% 真题口述、30% 项目化编码、20% 复盘、10% 行业趋势。",
      href: "/interview#coach"
    }
  ];
}

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

async function claimJobFor(executor: RunExecutor, runnerId: string) {
  const claimed = await claimNextRun(executor, runnerId);
  if (!claimed) return undefined;
  const { run, leaseId } = claimed;

  const row = await getRunWithConversation(run.id);
  const workspace = await getWorkspace(run.workspaceId);
  if (!row || !workspace) {
    await finishRun({
      runId: run.id,
      runnerId,
      leaseId,
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
    leaseId,
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

    api.get("/desktop/download", async (request, reply) => {
      const desktopInstallerPath = currentDesktopInstallerPath();
      if (!existsSync(desktopInstallerPath)) {
        await appendAudit({
          ...(request.principal?.id ? { actorUserId: request.principal.id } : {}),
          eventType: "desktop.download.missing",
          details: { path: "/api/desktop/download" }
        });
        return reply.code(404).send({ error: "desktop_installer_unavailable" });
      }

      const { size } = statSync(desktopInstallerPath);
      await appendAudit({
        ...(request.principal?.id ? { actorUserId: request.principal.id } : {}),
        eventType: "desktop.download",
        details: { bytes: size }
      });

      return reply
        .header("content-type", "application/vnd.microsoft.portable-executable")
        .header("content-length", size)
        .header("content-disposition", 'attachment; filename="cursor-gateway-desktop-setup.exe"')
        .header("cache-control", "no-store")
        .send(createReadStream(desktopInstallerPath));
    });

    // Same-origin HTML for the Tauri Access bridge window. CF Access at the edge
    // forces login in that window; afterwards the desktop shell proxies API calls
    // through it so CF_Authorization cookies are sent (tauri.localhost is cross-site).
    api.get("/desktop/access/bridge", async (request, reply) => {
      await appendAudit({
        ...(request.principal?.id ? { actorUserId: request.principal.id } : {}),
        eventType: "desktop.access.bridge",
        details: { path: "/api/desktop/access/bridge" }
      });
      return reply
        .type("text/html; charset=utf-8")
        .header("cache-control", "no-store")
        .header("content-security-policy", DESKTOP_ACCESS_BRIDGE_CSP)
        .send(desktopAccessBridgeHtml());
    });

    api.get("/desktop/version", async () => {
      const meta = readDesktopVersionMeta({
        versionPath: desktopVersionPath,
        sha256SumsPath: desktopSha256SumsPath,
        installerPath: currentDesktopInstallerPath()
      });
      return {
        schemaVersion: 1,
        version: meta.version,
        sha256: meta.sha256,
        installerAvailable: meta.installerAvailable,
        installerUrl: new URL(DESKTOP_DOWNLOAD_PATH, config.publicOrigin).toString(),
        publishedAt: meta.publishedAt
      };
    });

    api.get("/e2ee-policy", async () => {
      const team = config.cfAccessTeamDomain;
      let cfAccessLogoutUrl: string | null = null;
      if (team) {
        try {
          const origin = team.includes("://") ? team : `https://${team}`;
          cfAccessLogoutUrl = new URL("/cdn-cgi/access/logout", origin).toString();
        } catch {
          cfAccessLogoutUrl = null;
        }
      }
      return {
        requiredForWeb: config.e2eeRequiredForWeb,
        protocol: E2EE_PROTOCOL,
        trustedClient: "signed-browser-extension",
        secureClientOrigin: config.secureClientOrigin || null,
        webE2eeReturnOrigins: [...config.webE2eeReturnOrigins],
        csAuthTtlSeconds: config.e2eeCsAuthTtlSeconds,
        runnerCodePairingEnabled: config.runnerCodePairingEnabled,
        cfAccessTeamDomain: team || null,
        cfAccessLogoutUrl,
        trustRoots: loadServerTrustRoots()
      };
    });

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
          userId: request.principal!.id,
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
          userId: request.principal!.id,
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
        userId: request.principal!.id,
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

    api.get("/interview/access", async (request) => {
      const principal = request.principal!;
      const entitlement = principal.email
        ? await getInterviewEntitlementForUser(principal.id, principal.email)
        : undefined;
      const adminAccess = principal.role === "admin";
      return {
        entitled:
          adminAccess ||
          Boolean(
            entitlement?.status === "active" && entitlement.activatedUserId === principal.id
          ),
        activationRequired: entitlement?.status === "pending",
        plan: entitlement?.plan ?? (adminAccess ? "coaching" : null),
        expiresAt: entitlement?.expiresAt ?? null,
        email: principal.email ?? null
      };
    });

    api.post("/interview/activate", async (request, reply) => {
      const principal = request.principal!;
      if (!principal.email) return reply.code(400).send({ error: "email_required" });
      const body = interviewActivationSchema.parse(request.body);
      const entitlement = await activateInterviewEntitlement({
        email: principal.email,
        userId: principal.id,
        activationTokenHash: hashActivationToken(body.token)
      });
      if (!entitlement) {
        await appendAudit({
          actorUserId: principal.id,
          eventType: "interview.entitlement.activation_denied",
          details: { email: principal.email }
        });
        return reply.code(400).send({ error: "activation_link_invalid_or_expired" });
      }
      await appendAudit({
        actorUserId: principal.id,
        eventType: "interview.entitlement.activated",
        details: { plan: entitlement.plan }
      });
      return { activated: true, plan: entitlement.plan, expiresAt: entitlement.expiresAt };
    });

    api.register(async (interview) => {
      interview.addHook("preHandler", async (request, reply) => {
        const principal = request.principal!;
        if (principal.role === "admin") return;
        const entitlement = principal.email
          ? await getInterviewEntitlementForUser(principal.id, principal.email)
          : undefined;
        if (
          entitlement?.status !== "active" ||
          entitlement.activatedUserId !== principal.id
        ) {
          return reply.code(402).send({ error: "paid_interview_access_required" });
        }
      });

      interview.get("/dashboard", async (request) => {
        const principal = request.principal!;
        const service = await upsertServicePrincipal("automation", "operator");
        const [profile, progress, coachRuns, infraRuns, agentRuns] = await Promise.all([
          getInterviewProfile(principal.id),
          listInterviewProgress(principal.id),
          listAutomationThreadRuns({
            userId: principal.id,
            threadKey: INTERVIEW_COACH_THREAD,
            limit: 30
          }),
          listAutomationThreadRuns({
            userId: service.id,
            threadKey: "daily-ai-infra-mianshi",
            limit: 1
          }),
          listAutomationThreadRuns({
            userId: service.id,
            threadKey: "daily-ai-agent-mianshi",
            limit: 1
          })
        ]);
        return {
          profile: profile ?? null,
          progress,
          recommendations: buildInterviewRecommendations(profile, progress),
          coachRuns,
          latestReports: [
            { reportId: "ai-infra-mianshi", run: infraRuns[0] ?? null },
            { reportId: "ai-agent-mianshi", run: agentRuns[0] ?? null }
          ]
        };
      });

      interview.get("/profile", async (request) => ({
        profile: (await getInterviewProfile(request.principal!.id)) ?? null
      }));

      interview.put("/profile", async (request) => {
        const body = interviewProfileUpdateSchema.parse(request.body);
        const profile = await upsertInterviewProfile(request.principal!.id, body);
        await appendAudit({
          actorUserId: request.principal!.id,
          eventType: "interview.profile.updated",
          details: { targetRole: profile.targetRole, currentLevel: profile.currentLevel }
        });
        return { profile };
      });

      interview.post("/progress", async (request) => {
        const body = interviewProgressUpdateSchema.parse(request.body);
        const progress = await upsertInterviewProgress(request.principal!.id, body);
        await appendAudit({
          actorUserId: request.principal!.id,
          eventType: "interview.progress.updated",
          details: {
            reportId: progress.reportId,
            questionKey: progress.questionKey,
            status: progress.status
          }
        });
        return { progress };
      });

      interview.get("/questions", async (request) => ({
        runs: await listAutomationThreadRuns({
          userId: request.principal!.id,
          threadKey: INTERVIEW_COACH_THREAD,
          limit: 50
        })
      }));

      interview.post("/questions", async (request, reply) => {
        const body = personalizedInterviewQuestionSchema.parse(request.body);
        if (!config.reportModelId || !config.reportWorkspaceId) {
          return reply.code(503).send({ error: "interview_ai_not_configured" });
        }
        if (!modelIsKnown(config.reportModelId)) {
          return reply.code(503).send({ error: "report_model_not_available" });
        }
        const workspace = await getWorkspace(config.reportWorkspaceId);
        if (!workspace) return reply.code(503).send({ error: "report_workspace_not_available" });

        const principal = request.principal!;
        const service = await upsertServicePrincipal("automation", "operator");
        const [profile, progress, infraRuns, agentRuns] = await Promise.all([
          getInterviewProfile(principal.id),
          listInterviewProgress(principal.id),
          listAutomationThreadRuns({
            userId: service.id,
            threadKey: "daily-ai-infra-mianshi",
            limit: 2
          }),
          listAutomationThreadRuns({
            userId: service.id,
            threadKey: "daily-ai-agent-mianshi",
            limit: 2
          })
        ]);
        const archive = [
          ...infraRuns.map((run) => ({ name: "AI Infra 面经", run })),
          ...agentRuns.map((run) => ({ name: "AI Agent 面经", run }))
        ]
          .filter((entry) => entry.run.status === "finished" && Boolean(entry.run.response))
          .map((entry) => ({
            name: entry.name,
            date: entry.run.idempotencyKey?.split(":").at(-1) ?? entry.run.createdAt.slice(0, 10),
            content: entry.run.response!
          }));
        const result = await createAutomationThreadRun({
          userId: principal.id,
          threadKey: INTERVIEW_COACH_THREAD,
          title: "定制化面经 AI 教练",
          status: "queued",
          model: config.reportModelId,
          workspaceId: workspace.id,
          prompt: buildPersonalizedInterviewPrompt({
            question: body.question,
            profile,
            progress,
            reportArchive: archive
          }),
          idempotencyKey: `coach:${body.requestId}`,
          allowWrites: false
        });
        return reply
          .code(result.created ? 202 : 200)
          .send({ run: result.run, idempotent: !result.created });
      });
    }, { prefix: "/interview" });

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
      const body = createRunSchema.parse(request.body);
      const principal = request.principal!;

      // Hermes is a plaintext Q&A-only sidecar that cannot participate in E2EE
      // (the encrypted submit path rejects it). Allow it through even when web
      // E2EE is required; every other model must use the E2EE `/api/e2ee/v1`
      // path so the plaintext gate stays closed.
      if (config.e2eeRequiredForWeb && !modelIsHermes(body.model)) {
        return reply.code(426).send({
          error: "e2ee_required_for_web",
          protocol: E2EE_PROTOCOL
        });
      }

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

        secure.post("/pairings/start", async (request, reply) => {
          const body = e2eePairingStartRequestSchema.parse(request.body);
          if (!isAllowedSecureOrigin(body.start.secureOrigin)) {
            return reply.code(400).send({ error: "secure_origin_mismatch" });
          }
          try {
            const pairing = await createPairingStart({
              userId: request.principal!.id,
              start: body.start,
              ttlSeconds: config.e2eePairingTtlSeconds
            });
            await appendAudit({
              actorUserId: request.principal!.id,
              eventType: "e2ee.pairing.started",
              details: {
                pairId: body.start.pairId,
                clientId: body.start.clientId,
                secureOrigin: body.start.secureOrigin
              }
            });
            return reply.code(202).send({
              pairId: pairing.pairId,
              status: pairing.status,
              expiresAt: pairing.expiresAt
            });
          } catch (error) {
            if (error instanceof PairingConflictError) {
              return reply.code(409).send({ error: error.code });
            }
            throw error;
          }
        });

        secure.get("/pairings/:pairId", async (request, reply) => {
          const params = z.object({ pairId: z.string().uuid() }).parse(request.params);
          const pairing = await getPairingForUser(params.pairId, request.principal!.id);
          if (!pairing) return reply.code(404).send({ error: "pairing_not_found" });
          return {
            pairId: pairing.pairId,
            status: pairing.status,
            offer: pairing.offer,
            ack: pairing.ack,
            expiresAt: pairing.expiresAt
          };
        });

        secure.post("/pairings/:pairId/complete", async (request, reply) => {
          const params = z.object({ pairId: z.string().uuid() }).parse(request.params);
          const body = e2eePairingCompleteRequestSchema.parse(request.body);
          if (body.complete.pairId !== params.pairId) {
            return reply.code(400).send({ error: "pair_id_mismatch" });
          }
          try {
            const pairing = await submitPairingComplete({
              userId: request.principal!.id,
              complete: body.complete
            });
            await appendAudit({
              actorUserId: request.principal!.id,
              eventType: "e2ee.pairing.complete_submitted",
              details: {
                pairId: body.complete.pairId,
                clientId: body.complete.clientId
              }
            });
            return {
              pairId: pairing.pairId,
              status: pairing.status
            };
          } catch (error) {
            if (error instanceof PairingConflictError) {
              return reply.code(409).send({ error: error.code });
            }
            throw error;
          }
        });

        secure.get("/devices", async (request) => ({
          devices: await listDevicesForUser(request.principal!.id)
        }));

        secure.post("/cs-auth/intent", async (request, reply) => {
          const body = e2eeCsAuthIntentRequestSchema.parse(request.body);
          const intent = body.intent;
          if (intent.gatewayOrigin !== config.publicOrigin) {
            return reply.code(400).send({ error: "gateway_origin_mismatch" });
          }
          if (
            config.webE2eeReturnOrigins.size > 0 &&
            !config.webE2eeReturnOrigins.has(intent.returnOrigin)
          ) {
            return reply.code(400).send({ error: "return_origin_not_allowed" });
          }
          if (
            intent.signingKey.fingerprint === intent.encryptionKey.fingerprint
          ) {
            // Allowed but unusual; no hard fail.
          }
          try {
            const row = await createCsAuthIntent({
              userId: request.principal!.id,
              intent,
              ttlSeconds: config.e2eeCsAuthTtlSeconds
            });
            await appendAudit({
              actorUserId: request.principal!.id,
              eventType: "e2ee.cs_auth.intent",
              details: {
                authId: intent.authId,
                clientId: intent.clientId,
                returnOrigin: intent.returnOrigin,
                signingFingerprint: intent.signingKey.fingerprint
              }
            });
            return reply.code(202).send({
              authId: row.authId,
              status: row.status,
              expiresAt: row.expiresAt
            });
          } catch (error) {
            if (error instanceof CsAuthConflictError) {
              return reply.code(409).send({ error: error.code });
            }
            throw error;
          }
        });

        secure.post("/cs-auth/:authId/request", async (request, reply) => {
          const params = z.object({ authId: z.string().uuid() }).parse(request.params);
          const body = z
            .object({
              secureClientId: z.string().trim().min(8).max(128),
              challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
              state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
              returnOrigin: z.string().url().max(512),
              clientId: z.string().trim().min(8).max(128),
              signingFingerprint: z.string().regex(/^sha256:[A-Za-z0-9_-]{43}$/),
              encryptionFingerprint: z.string().regex(/^sha256:[A-Za-z0-9_-]{43}$/)
            })
            .strict()
            .parse(request.body);
          if (
            config.webE2eeReturnOrigins.size > 0 &&
            !config.webE2eeReturnOrigins.has(body.returnOrigin)
          ) {
            return reply.code(400).send({ error: "return_origin_not_allowed" });
          }
          try {
            const row = await markCsAuthPendingRunner({
              authId: params.authId,
              userId: request.principal!.id,
              secureClientId: body.secureClientId,
              expected: body
            });
            await appendAudit({
              actorUserId: request.principal!.id,
              eventType: "e2ee.cs_auth.requested",
              details: {
                authId: params.authId,
                secureClientId: body.secureClientId,
                clientId: body.clientId
              }
            });
            return {
              authId: row.authId,
              status: row.status,
              expiresAt: row.expiresAt
            };
          } catch (error) {
            if (error instanceof CsAuthConflictError) {
              return reply.code(409).send({ error: error.code });
            }
            throw error;
          }
        });

        secure.get("/cs-auth/:authId", async (request, reply) => {
          const params = z.object({ authId: z.string().uuid() }).parse(request.params);
          const row = await getCsAuthForUser(params.authId, request.principal!.id);
          if (!row) return reply.code(404).send({ error: "auth_not_found" });
          return {
            authId: row.authId,
            status: row.status,
            grant: row.grant,
            expiresAt: row.expiresAt
          };
        });

        secure.post("/cs-auth/:authId/consume", async (request, reply) => {
          const params = z.object({ authId: z.string().uuid() }).parse(request.params);
          const body = z
            .object({
              challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
              state: z.string().regex(/^[A-Za-z0-9_-]{43}$/)
            })
            .strict()
            .parse(request.body);
          try {
            const row = await consumeCsAuthGrant({
              authId: params.authId,
              userId: request.principal!.id,
              challenge: body.challenge,
              state: body.state
            });
            await appendAudit({
              actorUserId: request.principal!.id,
              eventType: "e2ee.cs_auth.consumed",
              details: { authId: params.authId }
            });
            return { authId: row.authId, status: row.status };
          } catch (error) {
            if (error instanceof CsAuthConflictError) {
              const code = error.code === "auth_already_consumed" ? 409 : 409;
              return reply.code(code).send({ error: error.code });
            }
            throw error;
          }
        });

        secure.post("/devices/:clientId/revoke", async (request, reply) => {
          const params = z
            .object({ clientId: z.string().trim().min(8).max(128) })
            .parse(request.params);
          const device = await revokeDeviceForUser({
            userId: request.principal!.id,
            clientId: params.clientId
          });
          if (!device) return reply.code(404).send({ error: "device_not_found" });
          await appendAudit({
            actorUserId: request.principal!.id,
            eventType: "e2ee.device.revoke_requested",
            details: { clientId: params.clientId }
          });
          return { device };
        });

        // --- Passkey (WebAuthn) pairing ---

        secure.post("/passkey/start", async (request, reply) => {
          const body = e2eePasskeyPairingStartRequestSchema.parse(request.body);
          if (!isAllowedSecureOrigin(body.start.secureOrigin)) {
            return reply.code(400).send({ error: "secure_origin_mismatch" });
          }
          try {
            const pairing = await createPasskeyPairingStart({
              userId: request.principal!.id,
              start: body.start,
              ttlSeconds: config.e2eePasskeyPairingTtlSeconds
            });
            await appendAudit({
              actorUserId: request.principal!.id,
              eventType: "e2ee.passkey.started",
              details: { pairId: body.start.pairId, clientId: body.start.clientId }
            });
            return reply
              .code(202)
              .send({ pairId: pairing.pairId, status: pairing.status, expiresAt: pairing.expiresAt });
          } catch (error) {
            if (error instanceof PasskeyPairingConflictError) {
              return reply.code(409).send({ error: error.code });
            }
            throw error;
          }
        });

        secure.get("/passkey/:pairId", async (request, reply) => {
          const params = z.object({ pairId: z.string().uuid() }).parse(request.params);
          const pairing = await getPasskeyPairingForUser(params.pairId, request.principal!.id);
          if (!pairing) return reply.code(404).send({ error: "pairing_not_found" });
          return {
            pairId: pairing.pairId,
            status: pairing.status,
            options: pairing.options,
            ack: pairing.ack,
            expiresAt: pairing.expiresAt
          };
        });

        secure.post("/passkey/:pairId/complete", async (request, reply) => {
          const params = z.object({ pairId: z.string().uuid() }).parse(request.params);
          const body = e2eePasskeyPairingCompleteRequestSchema.parse(request.body);
          if (body.complete.pairId !== params.pairId) {
            return reply.code(400).send({ error: "pair_id_mismatch" });
          }
          try {
            const pairing = await submitPasskeyPairingComplete({
              userId: request.principal!.id,
              complete: body.complete
            });
            // Cloudflare Access forwards the caller's identity assertion on
            // every request; stash it ephemerally so the Runner can verify
            // it on claim — never persisted to the database or logged.
            const assertion = request.headers["cf-access-jwt-assertion"];
            const jwt = Array.isArray(assertion) ? assertion[0] : assertion;
            if (jwt) putEphemeralAccessJwt(body.complete.pairId, jwt);
            await appendAudit({
              actorUserId: request.principal!.id,
              eventType: "e2ee.passkey.complete_submitted",
              details: { pairId: body.complete.pairId, clientId: body.complete.clientId, mode: body.complete.mode }
            });
            return { pairId: pairing.pairId, status: pairing.status };
          } catch (error) {
            if (error instanceof PasskeyPairingConflictError) {
              return reply.code(409).send({ error: error.code });
            }
            throw error;
          }
        });

        // --- Paired-device approval ---

        secure.post("/approvals/request", async (request, reply) => {
          const body = e2eeDeviceApprovalRequestBodySchema.parse(request.body);
          if (!isAllowedSecureOrigin(body.request.secureOrigin)) {
            return reply.code(400).send({ error: "secure_origin_mismatch" });
          }
          try {
            const row = await createDeviceApprovalRequest({
              userId: request.principal!.id,
              request: body.request,
              ttlSeconds: config.e2eeDeviceApprovalTtlSeconds
            });
            await appendAudit({
              actorUserId: request.principal!.id,
              eventType: "e2ee.approval.requested",
              details: { approvalId: body.request.approvalId, newClientId: body.request.newClientId }
            });
            return reply
              .code(202)
              .send({ approvalId: row.approvalId, status: row.status, expiresAt: row.expiresAt });
          } catch (error) {
            if (error instanceof DeviceApprovalConflictError) {
              return reply.code(409).send({ error: error.code });
            }
            throw error;
          }
        });

        secure.get("/approvals/pending", async (request) => ({
          approvals: (await listPendingDeviceApprovalsForUser(request.principal!.id)).map((row) => ({
            approvalId: row.approvalId,
            request: row.request,
            expiresAt: row.expiresAt
          }))
        }));

        secure.get("/approvals/:approvalId", async (request, reply) => {
          const params = z.object({ approvalId: z.string().uuid() }).parse(request.params);
          const row = await getDeviceApprovalForUser(params.approvalId, request.principal!.id);
          if (!row) return reply.code(404).send({ error: "approval_not_found" });
          return {
            approvalId: row.approvalId,
            status: row.status,
            result: row.result,
            expiresAt: row.expiresAt
          };
        });

        secure.post("/approvals/:approvalId/decision", async (request, reply) => {
          const params = z.object({ approvalId: z.string().uuid() }).parse(request.params);
          const body = e2eeDeviceApprovalDecisionBodySchema
            .extend({ runnerId: z.string().trim().min(1).max(128) })
            .parse(request.body);
          if (body.decision.approvalId !== params.approvalId) {
            return reply.code(400).send({ error: "approval_id_mismatch" });
          }
          try {
            const row = await submitDeviceApprovalDecision({
              userId: request.principal!.id,
              runnerId: body.runnerId,
              decision: body.decision
            });
            await appendAudit({
              actorUserId: request.principal!.id,
              eventType: "e2ee.approval.decided",
              details: {
                approvalId: body.decision.approvalId,
                runnerId: body.runnerId,
                decision: body.decision.decision,
                approverClientId: body.decision.approverClientId
              }
            });
            return { approvalId: row.approvalId, status: row.status };
          } catch (error) {
            if (error instanceof DeviceApprovalConflictError) {
              return reply.code(409).send({ error: error.code });
            }
            throw error;
          }
        });

        // --- Recovery pairing (local high-entropy code; secret never sent here) ---

        secure.post("/recovery/start", async (request, reply) => {
          const body = e2eeRecoveryPairingStartRequestSchema.parse(request.body);
          if (!isAllowedSecureOrigin(body.start.secureOrigin)) {
            return reply.code(400).send({ error: "secure_origin_mismatch" });
          }
          try {
            const pairing = await createRecoveryPairingStart({
              userId: request.principal!.id,
              start: body.start,
              ttlSeconds: config.e2eeRecoveryPairingTtlSeconds
            });
            await appendAudit({
              actorUserId: request.principal!.id,
              eventType: "e2ee.recovery.started",
              details: { pairId: body.start.pairId, clientId: body.start.clientId }
            });
            return reply
              .code(202)
              .send({ pairId: pairing.pairId, status: pairing.status, expiresAt: pairing.expiresAt });
          } catch (error) {
            if (error instanceof RecoveryPairingConflictError) {
              return reply.code(409).send({ error: error.code });
            }
            throw error;
          }
        });

        secure.get("/recovery/handles/:recoveryId", async (request, reply) => {
          const params = z.object({ recoveryId: z.string().uuid() }).parse(request.params);
          const handle = await getRecoveryHandle(params.recoveryId);
          if (!handle) return reply.code(404).send({ error: "recovery_handle_not_found" });
          return handle;
        });

        secure.get("/recovery/:pairId", async (request, reply) => {
          const params = z.object({ pairId: z.string().uuid() }).parse(request.params);
          const pairing = await getRecoveryPairingForUser(params.pairId, request.principal!.id);
          if (!pairing) return reply.code(404).send({ error: "pairing_not_found" });
          return {
            pairId: pairing.pairId,
            status: pairing.status,
            offer: pairing.offer,
            ack: pairing.ack,
            expiresAt: pairing.expiresAt
          };
        });

        secure.post("/recovery/:pairId/complete", async (request, reply) => {
          const params = z.object({ pairId: z.string().uuid() }).parse(request.params);
          const body = e2eeRecoveryPairingCompleteRequestSchema.parse(request.body);
          if (body.complete.pairId !== params.pairId) {
            return reply.code(400).send({ error: "pair_id_mismatch" });
          }
          try {
            const pairing = await submitRecoveryPairingComplete({
              userId: request.principal!.id,
              complete: body.complete
            });
            await appendAudit({
              actorUserId: request.principal!.id,
              eventType: "e2ee.recovery.complete_submitted",
              details: { pairId: body.complete.pairId, clientId: body.complete.clientId }
            });
            return { pairId: pairing.pairId, status: pairing.status };
          } catch (error) {
            if (error instanceof RecoveryPairingConflictError) {
              return reply.code(409).send({ error: error.code });
            }
            throw error;
          }
        });

        // --- Runner-assisted manual code (RAMC): primary no-QR/no-email flow ---

        secure.post("/runner-code/start", async (request, reply) => {
          if (!config.runnerCodePairingEnabled) {
            return reply.code(404).send({ error: "runner_code_pairing_disabled" });
          }
          const body = e2eeRunnerCodePairingStartRequestSchema.parse(request.body);
          if (!isAllowedSecureOrigin(body.start.secureOrigin)) {
            return reply.code(400).send({ error: "secure_origin_mismatch" });
          }
          try {
            const row = await createRunnerCodeStart({
              userId: request.principal!.id,
              email: request.principal!.email ?? null,
              start: body.start,
              ttlSeconds: config.e2eeRunnerCodeTtlSeconds,
              maxAttempts: config.e2eeRunnerCodeMaxAttempts
            });
            await appendAudit({
              actorUserId: request.principal!.id,
              eventType: "e2ee.runner_code.started",
              details: { enrollId: body.start.enrollId, clientId: body.start.clientId }
            });
            return reply
              .code(202)
              .send({ enrollId: row.enrollId, status: row.status, expiresAt: row.expiresAt });
          } catch (error) {
            if (error instanceof RunnerCodeConflictError) {
              return reply.code(409).send({ error: error.code });
            }
            throw error;
          }
        });

        secure.get("/runner-code/:enrollId", async (request, reply) => {
          if (!config.runnerCodePairingEnabled) {
            return reply.code(404).send({ error: "runner_code_pairing_disabled" });
          }
          const params = z.object({ enrollId: z.string().uuid() }).parse(request.params);
          const row = await getRunnerCodeForUser(params.enrollId, request.principal!.id);
          if (!row) return reply.code(404).send({ error: "enrollment_not_found" });
          return {
            enrollId: row.enrollId,
            status: row.status,
            offer: row.offer,
            ack: row.ack,
            deviceCert: row.deviceCert,
            attemptsRemaining: Math.max(0, row.maxAttempts - row.attempts),
            expiresAt: row.expiresAt
          };
        });

        secure.post("/runner-code/:enrollId/confirm", async (request, reply) => {
          if (!config.runnerCodePairingEnabled) {
            return reply.code(404).send({ error: "runner_code_pairing_disabled" });
          }
          const params = z.object({ enrollId: z.string().uuid() }).parse(request.params);
          const body = e2eeRunnerCodePairingConfirmRequestSchema.parse(request.body);
          if (body.confirm.enrollId !== params.enrollId) {
            return reply.code(400).send({ error: "enroll_id_mismatch" });
          }
          try {
            const row = await submitRunnerCodeConfirm({
              userId: request.principal!.id,
              confirm: body.confirm
            });
            await appendAudit({
              actorUserId: request.principal!.id,
              eventType: "e2ee.runner_code.confirm_submitted",
              details: { enrollId: body.confirm.enrollId, clientId: body.confirm.clientId }
            });
            return { enrollId: row.enrollId, status: row.status };
          } catch (error) {
            if (error instanceof RunnerCodeConflictError) {
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

    automation.post("/interview-entitlements", async (request, reply) => {
      const body = interviewEntitlementProvisionSchema.parse(request.body);
      const token = randomBytes(32).toString("base64url");
      const activationExpiresAt = new Date(
        Date.now() + body.activationTtlHours * 60 * 60 * 1_000
      );
      const entitlement = await provisionInterviewEntitlement({
        email: body.email,
        plan: body.plan,
        paymentProvider: body.paymentProvider,
        paymentReference: body.paymentReference,
        activationTokenHash: hashActivationToken(token),
        activationExpiresAt,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null
      });
      await appendAudit({
        actorUserId: request.principal!.id,
        eventType: "interview.entitlement.provisioned",
        details: {
          email: entitlement.email,
          plan: entitlement.plan,
          paymentProvider: entitlement.paymentProvider,
          paymentReference: entitlement.paymentReference
        }
      });
      return reply.code(201).send({
        entitlement,
        activationUrl: `${config.publicOrigin}/interview/activate?token=${encodeURIComponent(token)}`
      });
    });

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
      const recovery = await recoverStaleRuns(
        "windows",
        config.runnerStaleAfterSeconds,
        config.runnerMaxAttempts
      );
      const heartbeat = await registerRunner(body);
      await appendAudit({
        eventType: "runner.heartbeat",
        details: {
          runnerId: body.runnerId,
          modelCount: body.models.length,
          workspaceCount: body.workspaces.length,
          recovery
        }
      });
      return { heartbeat };
    });

    runner.post("/jobs/claim", async (request, reply) => {
      const body = z
        .object({ runnerId: z.string().trim().min(1).max(128).default("windows-legacy") })
        .strict()
        .parse(request.body ?? {});
      const job = await claimJobFor("windows", body.runnerId);
      return job ? { job } : reply.code(204).send();
    });

    runner.post("/jobs/:runId/lease", async (request, reply) => {
      const params = z.object({ runId: z.string().uuid() }).parse(request.params);
      const body = runnerLeaseIdentitySchema.parse(request.body);
      const renewed = await renewRunLease({
        runId: params.runId,
        runnerId: body.runnerId,
        leaseId: body.leaseId
      });
      return renewed
        ? reply.code(204).send()
        : reply.code(409).send({ error: "run_lease_invalid" });
    });

    runner.post("/jobs/:runId/result", async (request, reply) => {
      const params = z.object({ runId: z.string().uuid() }).parse(request.params);
      const body = runnerResultSubmissionSchema.parse({
        ...(request.body as object),
        runId: params.runId
      });
      const run = await finishRun({
        runId: body.runId,
        runnerId: body.runnerId,
        leaseId: body.leaseId,
        status: body.status,
        response: body.response,
        error: body.error,
        inputTokens: body.inputTokens,
        outputTokens: body.outputTokens
      });

      if (!run) return reply.code(409).send({ error: "run_lease_invalid" });
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
      const body = runnerProgressSubmissionSchema.parse({
        ...(request.body as object),
        runId: params.runId
      });
      const updated = await updateRunProgress({
        runId: body.runId,
        runnerId: body.runnerId,
        leaseId: body.leaseId,
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
        runnerKeyId: body.runnerKeyId,
        maxAttempts: config.runnerMaxAttempts
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
        registered.e2ee.encryptionKey.keyId !== body.envelope.runnerKeyId
      ) {
        return reply.code(409).send({ error: "runner_e2ee_identity_mismatch" });
      }
      if (
        !(await verifyRunnerEnvelopeSignature(
          body.envelope,
          registered.e2ee.signingKey
        ))
      ) {
        return reply.code(409).send({ error: "runner_e2ee_signature_invalid" });
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
        registered.e2ee.encryptionKey.keyId !== body.envelope.runnerKeyId
      ) {
        return reply.code(409).send({ error: "runner_e2ee_identity_mismatch" });
      }
      if (
        !(await verifyRunnerEnvelopeSignature(
          body.envelope,
          registered.e2ee.signingKey
        ))
      ) {
        return reply.code(409).send({ error: "runner_e2ee_signature_invalid" });
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

    runner.post("/e2ee/v1/jobs/:runId/reject", async (request, reply) => {
      const params = z.object({ runId: z.string().uuid() }).parse(request.params);
      const body = e2eeRunRejectionSchema.parse(request.body);
      const registered = await getE2eeRunner(body.runnerId);
      if (
        !registered ||
        registered.e2ee.encryptionKey.keyId !== body.runnerKeyId
      ) {
        return reply.code(409).send({ error: "runner_e2ee_identity_mismatch" });
      }
      const run = await rejectE2eeRun({
        runId: params.runId,
        runnerId: body.runnerId,
        runnerKeyId: body.runnerKeyId,
        leaseId: body.leaseId
      });
      if (!run) return reply.code(409).send({ error: "run_lease_invalid" });
      await appendAudit({
        eventType: "e2ee.run.rejected",
        details: {
          runId: params.runId,
          runnerId: body.runnerId,
          code: body.code
        }
      });
      return { run };
    });

    runner.post("/e2ee/v1/pairings/claim-start", async (request, reply) => {
      const body = z
        .object({ runnerId: z.string().trim().min(1).max(128) })
        .parse(request.body);
      const pairing = await claimNextPairingStart({ runnerId: body.runnerId });
      return pairing
        ? {
            pairing: {
              pairId: pairing.pairId,
              status: pairing.status,
              start: pairing.start,
              expiresAt: pairing.expiresAt,
              // Access-bound app_users.email only — never from client envelope.
              recipientEmail: pairing.recipientEmail
            }
          }
        : reply.code(204).send();
    });

    runner.post("/e2ee/v1/pairings/offer", async (request, reply) => {
      const body = z
        .object({
          runnerId: z.string().trim().min(1).max(128),
          offer: e2eePairingOfferSchema
        })
        .parse(request.body);
      try {
        const pairing = await publishPairingOffer({
          runnerId: body.runnerId,
          offer: body.offer
        });
        await appendAudit({
          eventType: "e2ee.pairing.offer_published",
          details: {
            pairId: body.offer.pairId,
            runnerId: body.runnerId,
            clientId: body.offer.clientId
          }
        });
        return { status: pairing.status, expiresAt: pairing.expiresAt };
      } catch (error) {
        if (error instanceof PairingConflictError) {
          return reply.code(409).send({ error: error.code });
        }
        throw error;
      }
    });

    runner.post("/e2ee/v1/pairings/claim-complete", async (request, reply) => {
      const body = z
        .object({ runnerId: z.string().trim().min(1).max(128) })
        .parse(request.body);
      const pairing = await claimNextPairingComplete({ runnerId: body.runnerId });
      return pairing
        ? {
            pairing: {
              pairId: pairing.pairId,
              status: pairing.status,
              start: pairing.start,
              offer: pairing.offer,
              complete: pairing.complete,
              expiresAt: pairing.expiresAt
            }
          }
        : reply.code(204).send();
    });

    runner.post("/e2ee/v1/pairings/ack", async (request, reply) => {
      const body = z
        .object({
          runnerId: z.string().trim().min(1).max(128),
          ack: e2eePairingAckSchema
        })
        .parse(request.body);
      try {
        const pairing = await publishPairingAck({
          runnerId: body.runnerId,
          ack: body.ack
        });
        await appendAudit({
          eventType: "e2ee.pairing.acked",
          details: {
            pairId: body.ack.pairId,
            runnerId: body.runnerId,
            clientId: body.ack.clientId,
            status: body.ack.status
          }
        });
        return { status: pairing.status };
      } catch (error) {
        if (error instanceof PairingConflictError) {
          return reply.code(409).send({ error: error.code });
        }
        throw error;
      }
    });

    runner.post("/e2ee/v1/cs-auth/claim", async (request, reply) => {
      const body = z
        .object({ runnerId: z.string().trim().min(1).max(128) })
        .parse(request.body);
      const row = await claimNextCsAuth({ runnerId: body.runnerId });
      return row
        ? {
            auth: {
              authId: row.authId,
              status: row.status,
              intent: row.intent,
              secureClientId: row.secureClientId,
              expiresAt: row.expiresAt
            }
          }
        : reply.code(204).send();
    });

    runner.post("/e2ee/v1/cs-auth/grant", async (request, reply) => {
      const body = z
        .object({
          runnerId: z.string().trim().min(1).max(128),
          grant: e2eeCsAuthGrantSchema
        })
        .parse(request.body);
      try {
        const row = await publishCsAuthGrant({
          runnerId: body.runnerId,
          grant: body.grant
        });
        await appendAudit({
          eventType: "e2ee.cs_auth.granted",
          details: {
            authId: body.grant.authId,
            runnerId: body.runnerId,
            clientId: body.grant.clientId,
            status: body.grant.status
          }
        });
        return { status: row.status, expiresAt: row.expiresAt };
      } catch (error) {
        if (error instanceof CsAuthConflictError) {
          return reply.code(409).send({ error: error.code });
        }
        throw error;
      }
    });

    runner.get("/e2ee/v1/devices/pending-revocations", async (request) => {
      const query = z
        .object({ runnerId: z.string().trim().min(1).max(128) })
        .parse(request.query);
      return {
        revocations: await listPendingRevocations(query.runnerId)
      };
    });

    runner.post("/e2ee/v1/devices/:clientId/revoked", async (request) => {
      const params = z
        .object({ clientId: z.string().trim().min(8).max(128) })
        .parse(request.params);
      const body = z
        .object({ runnerId: z.string().trim().min(1).max(128) })
        .parse(request.body);
      await markRunnerRevoked({
        runnerId: body.runnerId,
        clientId: params.clientId
      });
      return { ok: true };
    });

    // --- Passkey (WebAuthn) pairing ---

    runner.post("/e2ee/v1/passkey/claim-start", async (request, reply) => {
      const body = z
        .object({ runnerId: z.string().trim().min(1).max(128) })
        .parse(request.body);
      const pairing = await claimNextPasskeyPairingStart({ runnerId: body.runnerId });
      return pairing
        ? {
            pairing: {
              pairId: pairing.pairId,
              status: pairing.status,
              start: pairing.start,
              expiresAt: pairing.expiresAt,
              recipientEmail: pairing.recipientEmail
            }
          }
        : reply.code(204).send();
    });

    runner.post("/e2ee/v1/passkey/options", async (request, reply) => {
      const body = z
        .object({ runnerId: z.string().trim().min(1).max(128), options: e2eePasskeyPairingOptionsSchema })
        .parse(request.body);
      try {
        const pairing = await publishPasskeyPairingOptions({
          runnerId: body.runnerId,
          options: body.options
        });
        await appendAudit({
          eventType: "e2ee.passkey.options_published",
          details: {
            pairId: body.options.pairId,
            runnerId: body.runnerId,
            clientId: body.options.clientId,
            mode: body.options.mode
          }
        });
        return { status: pairing.status, expiresAt: pairing.expiresAt };
      } catch (error) {
        if (error instanceof PasskeyPairingConflictError) {
          return reply.code(409).send({ error: error.code });
        }
        throw error;
      }
    });

    runner.post("/e2ee/v1/passkey/claim-complete", async (request, reply) => {
      const body = z
        .object({ runnerId: z.string().trim().min(1).max(128) })
        .parse(request.body);
      const pairing = await claimNextPasskeyPairingComplete({ runnerId: body.runnerId });
      if (!pairing) return reply.code(204).send();
      // Peek (non-destructive) so a lost claim response can be retried within TTL.
      const accessJwt = peekEphemeralAccessJwt(pairing.pairId);
      return {
        pairing: {
          pairId: pairing.pairId,
          status: pairing.status,
          start: pairing.start,
          options: pairing.options,
          complete: pairing.complete,
          expiresAt: pairing.expiresAt,
          accessJwt
        }
      };
    });

    runner.post("/e2ee/v1/passkey/ack", async (request, reply) => {
      const body = z
        .object({ runnerId: z.string().trim().min(1).max(128), ack: e2eePasskeyPairingAckSchema })
        .parse(request.body);
      try {
        const pairing = await publishPasskeyPairingAck({ runnerId: body.runnerId, ack: body.ack });
        consumeEphemeralAccessJwt(body.ack.pairId);
        await appendAudit({
          eventType: "e2ee.passkey.acked",
          details: {
            pairId: body.ack.pairId,
            runnerId: body.runnerId,
            clientId: body.ack.clientId,
            status: body.ack.status
          }
        });
        return { status: pairing.status };
      } catch (error) {
        if (error instanceof PasskeyPairingConflictError) {
          return reply.code(409).send({ error: error.code });
        }
        throw error;
      }
    });

    // --- Paired-device approval ---

    runner.post("/e2ee/v1/approvals/claim", async (request, reply) => {
      const body = z
        .object({ runnerId: z.string().trim().min(1).max(128) })
        .parse(request.body);
      const row = await claimNextDeviceApprovalDecision({ runnerId: body.runnerId });
      return row
        ? {
            approval: {
              approvalId: row.approvalId,
              request: row.request,
              decision: row.decision,
              expiresAt: row.expiresAt
            }
          }
        : reply.code(204).send();
    });

    runner.post("/e2ee/v1/approvals/result", async (request, reply) => {
      const body = z
        .object({ runnerId: z.string().trim().min(1).max(128), result: e2eeDeviceApprovalResultSchema })
        .parse(request.body);
      try {
        const row = await publishDeviceApprovalResult({ runnerId: body.runnerId, result: body.result });
        await appendAudit({
          eventType: "e2ee.approval.result_published",
          details: {
            approvalId: body.result.approvalId,
            runnerId: body.runnerId,
            newClientId: body.result.newClientId,
            status: body.result.status
          }
        });
        return { status: row.status };
      } catch (error) {
        if (error instanceof DeviceApprovalConflictError) {
          return reply.code(409).send({ error: error.code });
        }
        throw error;
      }
    });

    // --- Recovery pairing ---

    runner.post("/e2ee/v1/recovery/claim-start", async (request, reply) => {
      const body = z
        .object({ runnerId: z.string().trim().min(1).max(128) })
        .parse(request.body);
      const pairing = await claimNextRecoveryPairingStart({ runnerId: body.runnerId });
      return pairing
        ? {
            pairing: {
              pairId: pairing.pairId,
              status: pairing.status,
              start: pairing.start,
              expiresAt: pairing.expiresAt
            }
          }
        : reply.code(204).send();
    });

    runner.post("/e2ee/v1/recovery/offer", async (request, reply) => {
      const body = z
        .object({ runnerId: z.string().trim().min(1).max(128), offer: e2eeRecoveryPairingOfferSchema })
        .parse(request.body);
      try {
        const pairing = await publishRecoveryPairingOffer({ runnerId: body.runnerId, offer: body.offer });
        await appendAudit({
          eventType: "e2ee.recovery.offer_published",
          details: { pairId: body.offer.pairId, runnerId: body.runnerId, clientId: body.offer.clientId }
        });
        return { status: pairing.status, expiresAt: pairing.expiresAt };
      } catch (error) {
        if (error instanceof RecoveryPairingConflictError) {
          return reply.code(409).send({ error: error.code });
        }
        throw error;
      }
    });

    runner.post("/e2ee/v1/recovery/claim-complete", async (request, reply) => {
      const body = z
        .object({ runnerId: z.string().trim().min(1).max(128) })
        .parse(request.body);
      const pairing = await claimNextRecoveryPairingComplete({ runnerId: body.runnerId });
      return pairing
        ? {
            pairing: {
              pairId: pairing.pairId,
              status: pairing.status,
              start: pairing.start,
              offer: pairing.offer,
              complete: pairing.complete,
              expiresAt: pairing.expiresAt
            }
          }
        : reply.code(204).send();
    });

    runner.post("/e2ee/v1/recovery/ack", async (request, reply) => {
      const body = z
        .object({ runnerId: z.string().trim().min(1).max(128), ack: e2eeRecoveryPairingAckSchema })
        .parse(request.body);
      try {
        const pairing = await publishRecoveryPairingAck({ runnerId: body.runnerId, ack: body.ack });
        await appendAudit({
          eventType: "e2ee.recovery.acked",
          details: {
            pairId: body.ack.pairId,
            runnerId: body.runnerId,
            clientId: body.ack.clientId,
            status: body.ack.status
          }
        });
        return { status: pairing.status };
      } catch (error) {
        if (error instanceof RecoveryPairingConflictError) {
          return reply.code(409).send({ error: error.code });
        }
        throw error;
      }
    });

    runner.post("/e2ee/v1/recovery/handles", async (request, reply) => {
      const body = z
        .object({ runnerId: z.string().trim().min(1).max(128), handle: e2eeRecoveryHandleSchema })
        .parse(request.body);
      await publishRecoveryHandle({ runnerId: body.runnerId, handle: body.handle });
      return reply.code(204).send();
    });

    // --- Runner-assisted manual code (RAMC) ---

    runner.post("/e2ee/v1/runner-code/claim-start", async (request, reply) => {
      if (!config.runnerCodePairingEnabled) return reply.code(204).send();
      const body = z.object({ runnerId: z.string().trim().min(1).max(128) }).parse(request.body);
      const row = await claimNextRunnerCodeStart({ runnerId: body.runnerId });
      return row
        ? {
            enrollment: {
              enrollId: row.enrollId,
              status: row.status,
              start: row.start,
              email: row.email,
              expiresAt: row.expiresAt
            }
          }
        : reply.code(204).send();
    });

    runner.post("/e2ee/v1/runner-code/offer", async (request, reply) => {
      const body = z
        .object({ runnerId: z.string().trim().min(1).max(128), offer: e2eeRunnerCodePairingOfferSchema })
        .parse(request.body);
      try {
        const row = await publishRunnerCodeOffer({ runnerId: body.runnerId, offer: body.offer });
        await appendAudit({
          eventType: "e2ee.runner_code.offer_published",
          details: { enrollId: body.offer.enrollId, runnerId: body.runnerId, clientId: body.offer.clientId }
        });
        return { status: row.status, expiresAt: row.expiresAt };
      } catch (error) {
        if (error instanceof RunnerCodeConflictError) {
          return reply.code(409).send({ error: error.code });
        }
        throw error;
      }
    });

    runner.post("/e2ee/v1/runner-code/claim-confirm", async (request, reply) => {
      const body = z.object({ runnerId: z.string().trim().min(1).max(128) }).parse(request.body);
      const row = await claimNextRunnerCodeConfirm({ runnerId: body.runnerId });
      return row && row.offer && row.confirm
        ? {
            enrollment: {
              enrollId: row.enrollId,
              status: row.status,
              start: row.start,
              offer: row.offer,
              confirm: row.confirm,
              expiresAt: row.expiresAt
            }
          }
        : reply.code(204).send();
    });

    runner.post("/e2ee/v1/runner-code/ack", async (request, reply) => {
      const body = z
        .object({ runnerId: z.string().trim().min(1).max(128), ack: e2eeRunnerCodePairingAckSchema })
        .parse(request.body);
      try {
        const row = await publishRunnerCodeAck({ runnerId: body.runnerId, ack: body.ack });
        await appendAudit({
          eventType: "e2ee.runner_code.acked",
          details: {
            enrollId: body.ack.enrollId,
            runnerId: body.runnerId,
            clientId: body.ack.clientId,
            status: body.ack.status,
            ...(body.ack.reason ? { reason: body.ack.reason } : {})
          }
        });
        // On successful pairing, best-effort sign an account-bound cg-device-cert/2
        // so the browser can retrieve it over the cg-mitm ciphertext channel.
        if (row.status === "paired") {
          try {
            const cert = await maybeIssueRunnerCodeDeviceCert({
              accountId: row.email ?? row.userId,
              signingKey: row.start.signingKey,
              encryptionKey: row.start.encryptionKey,
              label: row.start.label ?? null
            });
            if (cert) {
              await attachRunnerCodeDeviceCert({ enrollId: row.enrollId, deviceCert: cert });
              await appendAudit({
                eventType: "e2ee.runner_code.cert_issued",
                details: { enrollId: row.enrollId, accountId: row.email ?? row.userId }
              });
            }
          } catch (error) {
            console.warn(
              "[ramc] cg-device-cert issuance failed (pairing still succeeded):",
              error instanceof Error ? error.message : "unknown"
            );
          }
        }
        return { status: row.status };
      } catch (error) {
        if (error instanceof RunnerCodeConflictError) {
          return reply.code(409).send({ error: error.code });
        }
        throw error;
      }
    });
  }, { prefix: "/api/runner" });

  app.register(async (hermesRunner) => {
    hermesRunner.addHook("preHandler", requireHermesRunner);

    hermesRunner.post("/heartbeat", async (request) => {
      const body = heartbeatSchema.parse(request.body);
      const recovery = await recoverStaleRuns(
        "hermes",
        config.runnerStaleAfterSeconds,
        config.runnerMaxAttempts
      );
      const heartbeat = await registerRunner(body);
      await appendAudit({
        eventType: "hermes_runner.heartbeat",
        details: {
          runnerId: body.runnerId,
          modelCount: body.models.length,
          recovery
        }
      });
      return { heartbeat };
    });

    hermesRunner.post("/jobs/claim", async (request, reply) => {
      const job = await claimJobFor("hermes", "hermes");
      return job ? { job } : reply.code(204).send();
    });

    hermesRunner.post("/jobs/:runId/result", async (request, reply) => {
      const params = z.object({ runId: z.string().uuid() }).parse(request.params);
      const body = hermesResultSubmissionSchema.parse({
        ...(request.body as object),
        runId: params.runId
      });
      const run = await finishRun({
        runId: body.runId,
        runnerId: "hermes",
        leaseId: body.leaseId,
        status: body.status,
        response: body.response,
        error: body.error,
        inputTokens: body.inputTokens,
        outputTokens: body.outputTokens
      });

      if (!run) return reply.code(409).send({ error: "run_lease_invalid" });
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
      const body = hermesProgressSubmissionSchema.parse({
        ...(request.body as object),
        runId: params.runId
      });
      const updated = await updateRunProgress({
        runId: body.runId,
        runnerId: "hermes",
        leaseId: body.leaseId,
        kind: body.kind,
        message: body.message
      });
      if (!updated) return reply.code(409).send({ error: "run_not_running" });
      return reply.code(204).send();
    });
  }, { prefix: "/api/hermes-runner" });
}
