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
  "ai-infra-mianshi"
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

export const E2EE_PROTOCOL = "cg-e2ee/1" as const;
export const E2EE_HPKE_SUITE = "HPKE-v1-P256-HKDF-SHA256-A256GCM" as const;

const base64UrlSchema = (maxLength: number) =>
  z.string().min(1).max(maxLength).regex(/^[A-Za-z0-9_-]+$/);

export const e2eePublicKeySchema = z
  .object({
    kty: z.literal("EC"),
    crv: z.literal("P-256"),
    x: base64UrlSchema(43).length(43),
    y: base64UrlSchema(43).length(43)
  })
  .strict();
export type E2eePublicKey = z.infer<typeof e2eePublicKeySchema>;

export const e2eeKeyDescriptorSchema = z
  .object({
    keyId: z.string().trim().min(8).max(128),
    fingerprint: z.string().regex(/^sha256:[A-Za-z0-9_-]{43}$/),
    publicKey: e2eePublicKeySchema
  })
  .strict();
export type E2eeKeyDescriptor = z.infer<typeof e2eeKeyDescriptorSchema>;

export const e2eeCiphertextSchema = z
  .object({
    alg: z.literal("A256GCM"),
    nonce: base64UrlSchema(16).length(16),
    ciphertext: base64UrlSchema(2_000_000)
  })
  .strict();
export type E2eeCiphertext = z.infer<typeof e2eeCiphertextSchema>;

export const e2eeHpkeEnvelopeSchema = z
  .object({
    alg: z.literal(E2EE_HPKE_SUITE),
    enc: base64UrlSchema(87).length(87),
    ciphertext: base64UrlSchema(64).length(64)
  })
  .strict();
export type E2eeHpkeEnvelope = z.infer<typeof e2eeHpkeEnvelopeSchema>;

export const e2eeSignatureSchema = z
  .object({
    alg: z.literal("ES256"),
    keyId: z.string().trim().min(8).max(128),
    value: base64UrlSchema(86).length(86)
  })
  .strict();
export type E2eeSignature = z.infer<typeof e2eeSignatureSchema>;

export const publicWorkspaceSchema = z
  .object({
    id: z.string().min(1).max(256),
    label: z.string().min(1).max(256),
    writable: z.boolean()
  })
  .strict();
export type PublicWorkspace = z.infer<typeof publicWorkspaceSchema>;

export const e2eeRunnerCapabilitySchema = z
  .object({
    protocols: z.array(z.literal(E2EE_PROTOCOL)).min(1).max(4),
    encryptionKey: e2eeKeyDescriptorSchema,
    signingKey: e2eeKeyDescriptorSchema
  })
  .strict();
export type E2eeRunnerCapability = z.infer<typeof e2eeRunnerCapabilitySchema>;

export const e2eeRunRoutingSchema = z
  .object({
    model: z.string().trim().min(1).max(256),
    workspaceId: z.string().trim().min(1).max(256),
    allowWrites: z.boolean(),
    memoryEnabled: z.boolean()
  })
  .strict();
export type E2eeRunRouting = z.infer<typeof e2eeRunRoutingSchema>;

export const e2eeConversationTurnSchema = z
  .object({
    prompt: z.string().max(200_000),
    response: z.string().max(1_000_000)
  })
  .strict();

export const e2eeRunPayloadSchema = z
  .object({
    protocol: z.literal(E2EE_PROTOCOL),
    kind: z.literal("run-request"),
    messageId: z.string().uuid(),
    runId: z.string().uuid(),
    conversationId: z.string().uuid(),
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    routing: e2eeRunRoutingSchema,
    prompt: z.string().trim().min(1).max(500_000),
    history: z.array(e2eeConversationTurnSchema).max(50).default([]),
    memory: z.array(z.string().max(100_000)).max(200).default([]),
    userIdentity: z.string().max(512).optional(),
    previousDigest: base64UrlSchema(43).length(43).nullable()
  })
  .strict();
export type E2eeRunPayload = z.infer<typeof e2eeRunPayloadSchema>;

export const e2eeRunRequestEnvelopeSchema = z
  .object({
    protocol: z.literal(E2EE_PROTOCOL),
    kind: z.literal("run-request"),
    messageId: z.string().uuid(),
    runId: z.string().uuid(),
    conversationId: z.string().uuid(),
    clientId: z.string().trim().min(8).max(128),
    clientKeyId: z.string().trim().min(8).max(128),
    runnerId: z.string().trim().min(1).max(128),
    runnerKeyId: z.string().trim().min(8).max(128),
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    createdAt: z.string().min(1).max(64),
    routing: e2eeRunRoutingSchema,
    previousDigest: base64UrlSchema(43).length(43).nullable(),
    wrappedConversationKey: e2eeHpkeEnvelopeSchema,
    title: e2eeCiphertextSchema.nullable(),
    payload: e2eeCiphertextSchema,
    signature: e2eeSignatureSchema
  })
  .strict();
export type E2eeRunRequestEnvelope = z.infer<typeof e2eeRunRequestEnvelopeSchema>;

export const e2eeApprovalEnvelopeSchema = z
  .object({
    protocol: z.literal(E2EE_PROTOCOL),
    kind: z.literal("run-approval"),
    messageId: z.string().uuid(),
    runId: z.string().uuid(),
    conversationId: z.string().uuid(),
    clientId: z.string().trim().min(8).max(128),
    clientKeyId: z.string().trim().min(8).max(128),
    runnerId: z.string().trim().min(1).max(128),
    runnerKeyId: z.string().trim().min(8).max(128),
    requestDigest: base64UrlSchema(43).length(43),
    allowWrites: z.literal(true),
    createdAt: z.string().min(1).max(64),
    signature: e2eeSignatureSchema
  })
  .strict();
export type E2eeApprovalEnvelope = z.infer<typeof e2eeApprovalEnvelopeSchema>;

export const e2eeProgressPayloadSchema = z
  .object({
    protocol: z.literal(E2EE_PROTOCOL),
    kind: z.literal("run-progress"),
    runId: z.string().uuid(),
    conversationId: z.string().uuid(),
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    progressKind: runProgressKindSchema,
    message: z.string().trim().min(1).max(200_000)
  })
  .strict();
export type E2eeProgressPayload = z.infer<typeof e2eeProgressPayloadSchema>;

export const e2eeProgressEnvelopeSchema = z
  .object({
    protocol: z.literal(E2EE_PROTOCOL),
    kind: z.literal("run-progress"),
    messageId: z.string().uuid(),
    runId: z.string().uuid(),
    conversationId: z.string().uuid(),
    runnerId: z.string().trim().min(1).max(128),
    runnerKeyId: z.string().trim().min(8).max(128),
    requestDigest: base64UrlSchema(43).length(43),
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    progressKind: runProgressKindSchema,
    createdAt: z.string().min(1).max(64),
    payload: e2eeCiphertextSchema,
    signature: e2eeSignatureSchema
  })
  .strict();
export type E2eeProgressEnvelope = z.infer<typeof e2eeProgressEnvelopeSchema>;

export const e2eeResultStatusSchema = z.enum(["finished", "error", "cancelled"]);

export const e2eeResultPayloadSchema = z
  .object({
    protocol: z.literal(E2EE_PROTOCOL),
    kind: z.literal("run-result"),
    runId: z.string().uuid(),
    conversationId: z.string().uuid(),
    status: e2eeResultStatusSchema,
    response: z.string().max(2_000_000).nullable(),
    error: z.string().max(200_000).nullable(),
    inputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable()
  })
  .strict();
export type E2eeResultPayload = z.infer<typeof e2eeResultPayloadSchema>;

export const e2eeResultEnvelopeSchema = z
  .object({
    protocol: z.literal(E2EE_PROTOCOL),
    kind: z.literal("run-result"),
    messageId: z.string().uuid(),
    runId: z.string().uuid(),
    conversationId: z.string().uuid(),
    runnerId: z.string().trim().min(1).max(128),
    runnerKeyId: z.string().trim().min(8).max(128),
    requestDigest: base64UrlSchema(43).length(43),
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    status: e2eeResultStatusSchema,
    createdAt: z.string().min(1).max(64),
    payload: e2eeCiphertextSchema,
    signature: e2eeSignatureSchema
  })
  .strict();
export type E2eeResultEnvelope = z.infer<typeof e2eeResultEnvelopeSchema>;

export const e2eeMemoryPayloadSchema = z
  .object({
    protocol: z.literal(E2EE_PROTOCOL),
    kind: z.literal("memory"),
    memoryId: z.string().uuid(),
    scope: z.enum(["user", "workspace"]),
    workspaceId: z.string().min(1).max(256).nullable(),
    content: z.string().trim().min(1).max(100_000)
  })
  .strict();
export type E2eeMemoryPayload = z.infer<typeof e2eeMemoryPayloadSchema>;

export const e2eeMemoryEnvelopeSchema = z
  .object({
    protocol: z.literal(E2EE_PROTOCOL),
    kind: z.literal("memory"),
    messageId: z.string().uuid(),
    memoryId: z.string().uuid(),
    clientId: z.string().trim().min(8).max(128),
    clientKeyId: z.string().trim().min(8).max(128),
    scope: z.enum(["user", "workspace"]),
    workspaceId: z.string().min(1).max(256).nullable(),
    createdAt: z.string().min(1).max(64),
    payload: e2eeCiphertextSchema,
    signature: e2eeSignatureSchema
  })
  .strict();
export type E2eeMemoryEnvelope = z.infer<typeof e2eeMemoryEnvelopeSchema>;

export const e2eeRunnerJobSchema = z
  .object({
    contentMode: z.literal("e2ee-v1"),
    leaseId: z.string().uuid(),
    leaseExpiresAt: z.string().min(1).max(64),
    request: e2eeRunRequestEnvelopeSchema,
    approval: e2eeApprovalEnvelopeSchema.nullable()
  })
  .strict();
export type E2eeRunnerJob = z.infer<typeof e2eeRunnerJobSchema>;

export const e2eeProgressSubmissionSchema = z
  .object({
    leaseId: z.string().uuid(),
    envelope: e2eeProgressEnvelopeSchema
  })
  .strict();
export type E2eeProgressSubmission = z.infer<typeof e2eeProgressSubmissionSchema>;

export const e2eeResultSubmissionSchema = z
  .object({
    leaseId: z.string().uuid(),
    envelope: e2eeResultEnvelopeSchema
  })
  .strict();
export type E2eeResultSubmission = z.infer<typeof e2eeResultSubmissionSchema>;

export const e2eeRunRecordSchema = z
  .object({
    id: z.string().uuid(),
    conversationId: z.string().uuid(),
    status: runStatusSchema,
    model: z.string(),
    workspaceId: z.string(),
    allowWrites: z.boolean(),
    request: e2eeRunRequestEnvelopeSchema,
    approval: e2eeApprovalEnvelopeSchema.nullable(),
    progress: e2eeProgressEnvelopeSchema.nullable(),
    result: e2eeResultEnvelopeSchema.nullable(),
    createdAt: z.string(),
    startedAt: z.string().nullable(),
    finishedAt: z.string().nullable(),
    updatedAt: z.string()
  })
  .strict();
export type E2eeRunRecord = z.infer<typeof e2eeRunRecordSchema>;

export const e2eeConversationRecordSchema = z
  .object({
    id: z.string().uuid(),
    workspaceId: z.string(),
    runnerId: z.string(),
    runnerKeyId: z.string(),
    title: e2eeCiphertextSchema.nullable(),
    runCount: z.number().int().nonnegative(),
    lastRunAt: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string()
  })
  .strict();
export type E2eeConversationRecord = z.infer<typeof e2eeConversationRecordSchema>;

export const e2eeCreateRunRequestSchema = z
  .object({
    request: e2eeRunRequestEnvelopeSchema
  })
  .strict();
export type E2eeCreateRunRequest = z.infer<typeof e2eeCreateRunRequestSchema>;

export const e2eeApprovalSubmissionSchema = z
  .object({
    approval: e2eeApprovalEnvelopeSchema
  })
  .strict();
export type E2eeApprovalSubmission = z.infer<typeof e2eeApprovalSubmissionSchema>;

export const e2eeRunnerClaimRequestSchema = z
  .object({
    runnerId: z.string().trim().min(1).max(128),
    runnerKeyId: z.string().trim().min(8).max(128),
    protocols: z.array(z.literal(E2EE_PROTOCOL)).min(1).max(4)
  })
  .strict();
export type E2eeRunnerClaimRequest = z.infer<typeof e2eeRunnerClaimRequestSchema>;

export const e2eeLeaseRenewalSchema = z
  .object({
    runnerId: z.string().trim().min(1).max(128),
    runnerKeyId: z.string().trim().min(8).max(128),
    leaseId: z.string().uuid()
  })
  .strict();
export type E2eeLeaseRenewal = z.infer<typeof e2eeLeaseRenewalSchema>;

export const e2eeRunnerHeartbeatSchema = z
  .object({
    runnerId: z.string().trim().min(1).max(128),
    runnerVersion: z.string().trim().min(1).max(64),
    models: z.array(modelSchema).max(256),
    workspaces: z.array(publicWorkspaceSchema).max(256),
    e2ee: e2eeRunnerCapabilitySchema
  })
  .strict();
export type E2eeRunnerHeartbeat = z.infer<typeof e2eeRunnerHeartbeatSchema>;

export const e2eeRunnerDirectoryEntrySchema = e2eeRunnerHeartbeatSchema
  .extend({
    lastSeenAt: z.string(),
    online: z.boolean()
  })
  .strict();
export type E2eeRunnerDirectoryEntry = z.infer<typeof e2eeRunnerDirectoryEntrySchema>;

export const e2eeMemoryCreateRequestSchema = z
  .object({
    envelope: e2eeMemoryEnvelopeSchema
  })
  .strict();
export type E2eeMemoryCreateRequest = z.infer<typeof e2eeMemoryCreateRequestSchema>;

export const e2eeMemoryRecordSchema = z
  .object({
    id: z.string().uuid(),
    scope: z.enum(["user", "workspace"]),
    workspaceId: z.string().nullable(),
    envelope: e2eeMemoryEnvelopeSchema,
    createdAt: z.string(),
    updatedAt: z.string()
  })
  .strict();
export type E2eeMemoryRecord = z.infer<typeof e2eeMemoryRecordSchema>;

export const e2eeRunnerPairingBundleSchema = z
  .object({
    protocol: z.literal(E2EE_PROTOCOL),
    kind: z.literal("runner-pairing"),
    runnerId: z.string().trim().min(1).max(128),
    encryptionKey: e2eeKeyDescriptorSchema,
    signingKey: e2eeKeyDescriptorSchema,
    createdAt: z.string().min(1).max(64)
  })
  .strict();
export type E2eeRunnerPairingBundle = z.infer<typeof e2eeRunnerPairingBundleSchema>;

export const e2eeClientPairingBundleSchema = z
  .object({
    protocol: z.literal(E2EE_PROTOCOL),
    kind: z.literal("client-pairing"),
    clientId: z.string().trim().min(8).max(128),
    signingKey: e2eeKeyDescriptorSchema,
    // Optional for legacy Chrome extension offline pairing; required for secure-web.
    encryptionKey: e2eeKeyDescriptorSchema.optional(),
    createdAt: z.string().min(1).max(64)
  })
  .strict();
export type E2eeClientPairingBundle = z.infer<typeof e2eeClientPairingBundleSchema>;

/** Magic-link pairing protocol kinds (MVP secure-web). */
export const E2EE_PAIRING_KIND = "secure-web-magic-link/1" as const;

export const e2eePairingStartSchema = z
  .object({
    protocol: z.literal(E2EE_PROTOCOL),
    pairingKind: z.literal(E2EE_PAIRING_KIND),
    pairId: z.string().uuid(),
    clientId: z.string().trim().min(8).max(128),
    clientChallenge: base64UrlSchema(43).length(43),
    signingKey: e2eeKeyDescriptorSchema,
    encryptionKey: e2eeKeyDescriptorSchema,
    secureOrigin: z.string().url().max(512),
    gatewayOrigin: z.string().url().max(512),
    createdAt: z.string().min(1).max(64)
  })
  .strict();
export type E2eePairingStart = z.infer<typeof e2eePairingStartSchema>;

export const e2eePairingOfferSchema = z
  .object({
    protocol: z.literal(E2EE_PROTOCOL),
    pairingKind: z.literal(E2EE_PAIRING_KIND),
    pairId: z.string().uuid(),
    runnerId: z.string().trim().min(1).max(128),
    runnerChallenge: base64UrlSchema(43).length(43),
    runnerEncryptionKey: e2eeKeyDescriptorSchema,
    runnerSigningKey: e2eeKeyDescriptorSchema,
    clientId: z.string().trim().min(8).max(128),
    clientChallenge: base64UrlSchema(43).length(43),
    clientSigningFingerprint: z.string().regex(/^sha256:[A-Za-z0-9_-]{43}$/),
    clientEncryptionFingerprint: z.string().regex(/^sha256:[A-Za-z0-9_-]{43}$/),
    secureOrigin: z.string().url().max(512),
    gatewayOrigin: z.string().url().max(512),
    emailHint: z.string().email().max(320).optional(),
    expiresAt: z.string().min(1).max(64),
    createdAt: z.string().min(1).max(64)
  })
  .strict();
export type E2eePairingOffer = z.infer<typeof e2eePairingOfferSchema>;

export const e2eePairingCompleteSchema = z
  .object({
    protocol: z.literal(E2EE_PROTOCOL),
    pairingKind: z.literal(E2EE_PAIRING_KIND),
    pairId: z.string().uuid(),
    clientId: z.string().trim().min(8).max(128),
    transcriptMac: base64UrlSchema(43).length(43),
    signature: e2eeSignatureSchema,
    createdAt: z.string().min(1).max(64)
  })
  .strict();
export type E2eePairingComplete = z.infer<typeof e2eePairingCompleteSchema>;

export const e2eePairingAckSchema = z
  .object({
    protocol: z.literal(E2EE_PROTOCOL),
    pairingKind: z.literal(E2EE_PAIRING_KIND),
    pairId: z.string().uuid(),
    clientId: z.string().trim().min(8).max(128),
    runnerId: z.string().trim().min(1).max(128),
    status: z.enum(["paired", "rejected"]),
    runnerEncryptionKey: e2eeKeyDescriptorSchema,
    runnerSigningKey: e2eeKeyDescriptorSchema,
    createdAt: z.string().min(1).max(64),
    signature: e2eeSignatureSchema
  })
  .strict();
export type E2eePairingAck = z.infer<typeof e2eePairingAckSchema>;

export const e2eePairingStatusSchema = z.enum([
  "pending_start",
  "offer_ready",
  "complete_submitted",
  "paired",
  "rejected",
  "expired"
]);
export type E2eePairingStatus = z.infer<typeof e2eePairingStatusSchema>;

export const e2eeDeviceRecordSchema = z
  .object({
    clientId: z.string().trim().min(8).max(128),
    signingKey: e2eeKeyDescriptorSchema,
    encryptionKey: e2eeKeyDescriptorSchema.nullable(),
    pairedAt: z.string().min(1).max(64),
    label: z.string().max(128).nullable(),
    revokedAt: z.string().min(1).max(64).nullable()
  })
  .strict();
export type E2eeDeviceRecord = z.infer<typeof e2eeDeviceRecordSchema>;

/** Runner rewraps conversation root for a newly paired device (no private-key sync). */
export const e2eeKeyGrantSchema = z
  .object({
    protocol: z.literal(E2EE_PROTOCOL),
    kind: z.literal("conversation-key-grant"),
    grantId: z.string().uuid(),
    conversationId: z.string().uuid(),
    clientId: z.string().trim().min(8).max(128),
    runnerId: z.string().trim().min(1).max(128),
    runnerKeyId: z.string().trim().min(8).max(128),
    wrappedConversationKey: e2eeHpkeEnvelopeSchema,
    createdAt: z.string().min(1).max(64),
    signature: e2eeSignatureSchema
  })
  .strict();
export type E2eeKeyGrant = z.infer<typeof e2eeKeyGrantSchema>;

/**
 * CS → Secure redirect authorization: Runner signs a one-time grant for a CS
 * device public key (private key never leaves cs origin).
 */
export const E2EE_CS_AUTH_KIND = "cs-web-device-auth/1" as const;

export const e2eeCsAuthStatusSchema = z.enum([
  "intent_ready",
  "pending_runner",
  "granted",
  "rejected",
  "consumed",
  "expired"
]);
export type E2eeCsAuthStatus = z.infer<typeof e2eeCsAuthStatusSchema>;

export const e2eeCsAuthIntentSchema = z
  .object({
    protocol: z.literal(E2EE_PROTOCOL),
    authKind: z.literal(E2EE_CS_AUTH_KIND),
    authId: z.string().uuid(),
    clientId: z.string().trim().min(8).max(128),
    challenge: base64UrlSchema(43).length(43),
    state: base64UrlSchema(43).length(43),
    signingKey: e2eeKeyDescriptorSchema,
    encryptionKey: e2eeKeyDescriptorSchema,
    returnOrigin: z.string().url().max(512),
    gatewayOrigin: z.string().url().max(512),
    createdAt: z.string().min(1).max(64)
  })
  .strict();
export type E2eeCsAuthIntent = z.infer<typeof e2eeCsAuthIntentSchema>;

export const e2eeCsAuthGrantSchema = z
  .object({
    protocol: z.literal(E2EE_PROTOCOL),
    authKind: z.literal(E2EE_CS_AUTH_KIND),
    authId: z.string().uuid(),
    clientId: z.string().trim().min(8).max(128),
    challenge: base64UrlSchema(43).length(43),
    state: base64UrlSchema(43).length(43),
    signingFingerprint: z.string().regex(/^sha256:[A-Za-z0-9_-]{43}$/),
    encryptionFingerprint: z.string().regex(/^sha256:[A-Za-z0-9_-]{43}$/),
    returnOrigin: z.string().url().max(512),
    gatewayOrigin: z.string().url().max(512),
    runnerId: z.string().trim().min(1).max(128),
    runnerEncryptionKey: e2eeKeyDescriptorSchema,
    runnerSigningKey: e2eeKeyDescriptorSchema,
    status: z.enum(["authorized", "rejected"]),
    expiresAt: z.string().min(1).max(64),
    createdAt: z.string().min(1).max(64),
    signature: e2eeSignatureSchema
  })
  .strict();
export type E2eeCsAuthGrant = z.infer<typeof e2eeCsAuthGrantSchema>;

export const e2eeCsAuthIntentRequestSchema = z
  .object({
    intent: e2eeCsAuthIntentSchema
  })
  .strict();

export const e2eePairingStartRequestSchema = z
  .object({
    start: e2eePairingStartSchema
  })
  .strict();

export const e2eePairingCompleteRequestSchema = z
  .object({
    complete: e2eePairingCompleteSchema
  })
  .strict();
