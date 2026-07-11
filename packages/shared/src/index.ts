import { z } from "zod";

export const roleSchema = z.enum(["admin", "operator", "viewer"]);
export type Role = z.infer<typeof roleSchema>;

export const runStatusSchema = z.enum([
  "queued",
  "waiting_approval",
  "running",
  "finished",
  "error",
  "cancelled"
]);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const runProgressKindSchema = z.enum(["working", "thinking", "tool", "responding"]);
export type RunProgressKind = z.infer<typeof runProgressKindSchema>;

export const originSchema = z.enum(["web", "telegram", "automation"]);
export type Origin = z.infer<typeof originSchema>;

export const workspaceSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  path: z.string().min(1),
  writable: z.boolean().default(false)
});
export type Workspace = z.infer<typeof workspaceSchema>;

export const principalSchema = z.object({
  id: z.string().min(1),
  email: z.string().email().optional(),
  telegramUserId: z.string().optional(),
  displayName: z.string().optional(),
  role: roleSchema
});
export type Principal = z.infer<typeof principalSchema>;

export const createRunSchema = z.object({
  origin: z.literal("web"),
  prompt: z.string().min(1),
  conversationId: z.string().uuid().optional(),
  model: z.string().min(1),
  workspaceId: z.string().min(1),
  memoryEnabled: z.boolean().default(true),
  allowWrites: z.boolean().default(false)
});
export type CreateRunRequest = z.infer<typeof createRunSchema>;

export const automationCreateRunSchema = z
  .object({
    threadKey: z.string().trim().min(1).max(256),
    title: z.string().trim().min(1).max(200).optional(),
    prompt: z.string().trim().min(1),
    model: z.string().trim().min(1),
    workspaceId: z.string().trim().min(1),
    idempotencyKey: z.string().trim().min(1).max(256),
    allowWrites: z.boolean().default(false)
  })
  .strict();
export type AutomationCreateRunRequest = z.infer<typeof automationCreateRunSchema>;

export const conversationSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().min(1),
  title: z.string().nullable(),
  runCount: z.number().int().nonnegative(),
  lastRunAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string()
});
export type Conversation = z.infer<typeof conversationSchema>;

export const runRecordSchema = z.object({
  id: z.string().uuid(),
  conversationId: z.string().uuid(),
  origin: originSchema,
  status: runStatusSchema,
  model: z.string(),
  workspaceId: z.string(),
  prompt: z.string(),
  response: z.string().nullable(),
  error: z.string().nullable(),
  progress: z.string().nullable(),
  progressKind: runProgressKindSchema.nullable(),
  allowWrites: z.boolean(),
  idempotencyKey: z.string().nullable(),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  updatedAt: z.string()
});
export type RunRecord = z.infer<typeof runRecordSchema>;

export const conversationTurnSchema = z.object({
  prompt: z.string(),
  response: z.string()
});
export type ConversationTurn = z.infer<typeof conversationTurnSchema>;

export const runnerJobSchema = z.object({
  runId: z.string().uuid(),
  conversationId: z.string().uuid(),
  agentId: z.string().nullable(),
  model: z.string().min(1),
  prompt: z.string().min(1),
  workspace: workspaceSchema,
  userIdentity: z.string().optional(),
  memory: z.array(z.string()).default([]),
  history: z.array(conversationTurnSchema).default([]),
  allowWrites: z.boolean()
});
export type RunnerJob = z.infer<typeof runnerJobSchema>;

export const runnerJobResultSchema = z.object({
  runId: z.string().uuid(),
  status: z.enum(["finished", "error", "cancelled"]),
  response: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
  agentId: z.string().nullable().default(null),
  inputTokens: z.number().int().nonnegative().nullable().default(null),
  outputTokens: z.number().int().nonnegative().nullable().default(null)
});
export type RunnerJobResult = z.infer<typeof runnerJobResultSchema>;

export const runnerJobProgressSchema = z.object({
  runId: z.string().uuid(),
  kind: runProgressKindSchema,
  message: z.string().trim().min(1).max(200_000)
});
export type RunnerJobProgress = z.infer<typeof runnerJobProgressSchema>;

export const modelSchema = z.object({
  id: z.string(),
  displayName: z.string().optional()
});
export type ModelInfo = z.infer<typeof modelSchema>;

export const reportIdSchema = z.enum([
  "finance",
  "news",
  "ai-infra-tips",
  "ai-infra-interview",
  "ai-infra-mianshi",
  "ai-agent-mianshi"
]);
export type ReportId = z.infer<typeof reportIdSchema>;

export const reportDefinitionSchema = z.object({
  id: reportIdSchema,
  name: z.string(),
  shortName: z.string(),
  description: z.string(),
  schedule: z.string(),
  threadKey: z.string()
});
export type ReportDefinition = z.infer<typeof reportDefinitionSchema>;

export const reportQuestionSchema = z
  .object({
    question: z.string().trim().min(1).max(8_000),
    requestId: z.string().uuid()
  })
  .strict();
export type ReportQuestionRequest = z.infer<typeof reportQuestionSchema>;

export const memoryFactSchema = z.object({
  id: z.string().uuid(),
  scope: z.enum(["user", "workspace"]),
  workspaceId: z.string().nullable(),
  content: z.string().min(1),
  createdAt: z.string(),
  updatedAt: z.string()
});
export type MemoryFact = z.infer<typeof memoryFactSchema>;
