/**
 * cg-mitm/1 — Zod schema 类型草案（P1 参考实现）。
 *
 * ⚠️ 落点说明：本文件**故意放在 `docs/cg-mitm-spec/` 下**，位于所有 workspace 的 tsconfig
 * `include`（各包 `src/**\/*.ts`）之外，因此**不参与** `npm run typecheck` / `npm run build`，
 * 对生产构建零影响。P1 落地时**原样搬到 `packages/shared/src/cgMitm.ts`** 并在 `index.ts` 旁导出即可。
 *
 * 复用的现有导出（来自 `@cursor-gateway/shared`，已核对 `packages/shared/src/index.ts`）：
 *   e2eePublicKeySchema, e2eeKeyDescriptorSchema, e2eeCiphertextSchema,
 *   e2eeHpkeEnvelopeSchema, e2eeSignatureSchema
 *
 * 设计要点（详见同目录 01-schema.md）：
 *   - 握手用 HPKE 只封 32B sessionRoot（e2eeHpkeEnvelopeSchema.ciphertext 上限 64 char = 48B）。
 *   - 请求体走 encryptJson 分帧（e2eeCiphertextSchema.ciphertext 上限 2,000,000 char）。
 *   - 离线根用 Ed25519（alg 判别）；在线 / 每会话 / 设备证书签名沿用 ES256。
 */
import { z } from "zod";
import {
  e2eeCiphertextSchema,
  e2eeHpkeEnvelopeSchema,
  e2eeKeyDescriptorSchema,
  e2eePublicKeySchema,
  e2eeSignatureSchema
} from "@cursor-gateway/shared";

export const CG_MITM_PROTOCOL = "cg-mitm/1" as const;
export const CG_MITM_HPKE_SUITE = "HPKE-v1-P256-HKDF-SHA256-A256GCM" as const;

// 会话帧 / enroll 的 HKDF purpose（进入 deriveContentKey 的 info=`cursor-gateway:${purpose}`）。
export const CG_MITM_PURPOSE_C2S = "cg-mitm/1:c2s-frame" as const;
export const CG_MITM_PURPOSE_S2C = "cg-mitm/1:s2c-frame" as const;
export const CG_MITM_PURPOSE_ENROLL = "cg-mitm/1:enroll" as const;

const base64Url = (max: number) => z.string().min(1).max(max).regex(/^[A-Za-z0-9_-]+$/);
const fingerprint = z.string().regex(/^sha256:[A-Za-z0-9_-]{43}$/);
const isoTime = z.string().min(1).max(64);
const reasonCode = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]{1,127}$/);

// --- alg 判别（离线根 Ed25519 | 在线 ES256）---
export const cgSignatureAlgSchema = z.enum(["EdDSA", "ES256"]);
export type CgSignatureAlg = z.infer<typeof cgSignatureAlgSchema>;

export const cgEdDsaSignatureSchema = z
  .object({
    alg: z.literal("EdDSA"),
    keyId: z.string().trim().min(8).max(128),
    value: base64Url(120)
  })
  .strict();

export const cgAnySignatureSchema = z.union([e2eeSignatureSchema, cgEdDsaSignatureSchema]);
export type CgAnySignature = z.infer<typeof cgAnySignatureSchema>;

export const cgEd25519PublicKeySchema = z
  .object({
    kty: z.literal("OKP"),
    crv: z.literal("Ed25519"),
    x: base64Url(43).length(43)
  })
  .strict();
export type CgEd25519PublicKey = z.infer<typeof cgEd25519PublicKeySchema>;

// --- 离线根（v2，带 alg 判别）---
export const cgTrustRootPublicSchema = z
  .object({
    protocol: z.literal(CG_MITM_PROTOCOL),
    kind: z.literal("cg-trust-root-public/1"),
    alg: cgSignatureAlgSchema,
    keyId: z.string().trim().min(8).max(128),
    fingerprint,
    publicKey: z.union([cgEd25519PublicKeySchema, e2eePublicKeySchema]),
    epoch: z.number().int().nonnegative().max(1_000_000),
    createdAt: isoTime
  })
  .strict();
export type CgTrustRootPublic = z.infer<typeof cgTrustRootPublicSchema>;

// --- 服务端证书（离线根签名）---
export const cgServerIdentityCertSchema = z
  .object({
    protocol: z.literal(CG_MITM_PROTOCOL),
    kind: z.literal("cg-server-identity-cert/1"),
    version: z.literal(1),
    certId: z.string().uuid(),
    serverId: z.string().trim().min(1).max(128),
    epoch: z.number().int().nonnegative().max(1_000_000),
    hpkeKey: e2eeKeyDescriptorSchema,
    signingKey: e2eeKeyDescriptorSchema,
    allowedOrigins: z.array(z.string().url().max(512)).min(1).max(16),
    issuedAt: isoTime,
    expiresAt: isoTime,
    rootKeyId: z.string().trim().min(8).max(128),
    rootFingerprint: fingerprint,
    alg: cgSignatureAlgSchema,
    signature: cgAnySignatureSchema
  })
  .strict();
export type CgServerIdentityCert = z.infer<typeof cgServerIdentityCertSchema>;

// --- 设备证书（服务端 ES256 签名）---
export const cgDeviceCertSchema = z
  .object({
    protocol: z.literal(CG_MITM_PROTOCOL),
    kind: z.literal("cg-device-cert/1"),
    version: z.literal(1),
    deviceId: z.string().uuid(),
    signingKey: e2eeKeyDescriptorSchema,
    encryptionKey: e2eeKeyDescriptorSchema,
    keyIdHint: z.string().trim().min(1).max(128),
    issuedAt: isoTime,
    expiresAt: isoTime,
    serverCertId: z.string().uuid(),
    signature: e2eeSignatureSchema
  })
  .strict();
export type CgDeviceCert = z.infer<typeof cgDeviceCertSchema>;

// --- GET /cg/v1/server-keys ---
export const cgServerKeysResponseSchema = z
  .object({
    protocol: z.literal(CG_MITM_PROTOCOL),
    kind: z.literal("server-keys"),
    serverId: z.string().trim().min(1).max(128),
    epoch: z.number().int().nonnegative().max(1_000_000),
    cert: cgServerIdentityCertSchema,
    previousCert: cgServerIdentityCertSchema.nullable(),
    trustRoots: z.array(cgTrustRootPublicSchema).min(1).max(8),
    minSuite: z.literal(CG_MITM_HPKE_SUITE),
    createdAt: isoTime
  })
  .strict();
export type CgServerKeysResponse = z.infer<typeof cgServerKeysResponseSchema>;

// --- POST /cg/v1/enroll ---
export const cgEnrollInnerSchema = z
  .object({
    protocol: z.literal(CG_MITM_PROTOCOL),
    kind: z.literal("enroll-inner"),
    apiKey: z.string().min(1).max(512),
    deviceSigningKey: e2eeKeyDescriptorSchema,
    deviceEncryptionKey: e2eeKeyDescriptorSchema,
    label: z.string().trim().min(1).max(128).nullable(),
    createdAt: isoTime
  })
  .strict();
export type CgEnrollInner = z.infer<typeof cgEnrollInnerSchema>;

export const cgEnrollRequestSchema = z
  .object({
    protocol: z.literal(CG_MITM_PROTOCOL),
    kind: z.literal("enroll-request"),
    serverCertId: z.string().uuid(),
    epoch: z.number().int().nonnegative().max(1_000_000),
    enc: e2eeHpkeEnvelopeSchema,
    payload: e2eeCiphertextSchema,
    createdAt: isoTime
  })
  .strict();
export type CgEnrollRequest = z.infer<typeof cgEnrollRequestSchema>;

export const cgEnrollResponseSchema = z
  .object({
    protocol: z.literal(CG_MITM_PROTOCOL),
    kind: z.literal("enroll-response"),
    status: z.enum(["enrolled", "rejected"]),
    reason: reasonCode.optional(),
    deviceCert: cgDeviceCertSchema.optional(),
    payload: e2eeCiphertextSchema.optional(),
    createdAt: isoTime
  })
  .strict();
export type CgEnrollResponse = z.infer<typeof cgEnrollResponseSchema>;

// --- POST /cg/v1/exchange ---
export const cgWireSchema = z.enum(["anthropic", "openai"]);
export type CgWire = z.infer<typeof cgWireSchema>;
export const cgFrameTypeSchema = z.enum(["open", "delta", "usage", "done", "error"]);
export type CgFrameType = z.infer<typeof cgFrameTypeSchema>;

export const cgExchangeRequestSchema = z
  .object({
    protocol: z.literal(CG_MITM_PROTOCOL),
    kind: z.literal("exchange-request"),
    sessionId: base64Url(43).length(43),
    deviceId: z.string().uuid(),
    serverCertId: z.string().uuid(),
    epoch: z.number().int().nonnegative().max(1_000_000),
    enc: e2eeHpkeEnvelopeSchema.optional(),
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    idempotencyKey: z.string().uuid(),
    createdAt: isoTime,
    payload: e2eeCiphertextSchema
  })
  .strict();
export type CgExchangeRequest = z.infer<typeof cgExchangeRequestSchema>;

export const cgExchangeInnerSchema = z
  .object({
    protocol: z.literal(CG_MITM_PROTOCOL),
    kind: z.literal("exchange-inner"),
    apiKey: z.string().min(1).max(512),
    wire: cgWireSchema,
    body: z.record(z.string(), z.unknown()),
    sessionKey: z.string().trim().min(1).max(256).nullable(),
    clientAbortable: z.boolean().default(true),
    deviceAuth: e2eeSignatureSchema,
    pad: z.string().max(200_000).optional()
  })
  .strict();
export type CgExchangeInner = z.infer<typeof cgExchangeInnerSchema>;

export const cgExchangeResponseSchema = z
  .object({
    protocol: z.literal(CG_MITM_PROTOCOL),
    kind: z.literal("exchange-response"),
    sessionId: base64Url(43).length(43),
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    createdAt: isoTime,
    payload: e2eeCiphertextSchema
  })
  .strict();
export type CgExchangeResponse = z.infer<typeof cgExchangeResponseSchema>;

export const cgResponseInnerSchema = z
  .object({
    kind: z.literal("response-inner"),
    ok: z.boolean(),
    httpStatus: z.number().int().min(100).max(599),
    wire: cgWireSchema,
    body: z.record(z.string(), z.unknown()).nullable(),
    errorKind: z.string().trim().max(64).optional(),
    pad: z.string().max(200_000).optional()
  })
  .strict();
export type CgResponseInner = z.infer<typeof cgResponseInnerSchema>;

export const cgSseFrameInnerSchema = z
  .object({
    kind: z.literal("sse-frame-inner"),
    frameType: cgFrameTypeSchema,
    sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    data: z.record(z.string(), z.unknown()),
    pad: z.string().max(65_536).optional()
  })
  .strict();
export type CgSseFrameInner = z.infer<typeof cgSseFrameInnerSchema>;

// --- POST /cg/v1/cancel ---
export const cgCancelInnerSchema = z
  .object({
    kind: z.literal("cancel-inner"),
    idempotencyKey: z.string().uuid()
  })
  .strict();
export type CgCancelInner = z.infer<typeof cgCancelInnerSchema>;

export const cgCancelRequestSchema = z
  .object({
    protocol: z.literal(CG_MITM_PROTOCOL),
    kind: z.literal("cancel-request"),
    sessionId: base64Url(43).length(43),
    deviceId: z.string().uuid(),
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    createdAt: isoTime,
    payload: e2eeCiphertextSchema
  })
  .strict();
export type CgCancelRequest = z.infer<typeof cgCancelRequestSchema>;
