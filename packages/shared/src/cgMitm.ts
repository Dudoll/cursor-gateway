/**
 * cg-mitm/1 — application-layer anti-MITM channel schema (P1 cryptographic surface).
 *
 * Ported from docs/cg-mitm-spec/cgMitm.draft.ts and 01-schema.md. Reuses the existing
 * `e2ee*` primitives from ./index.ts; adds an `alg` discriminant so the offline root can
 * use Ed25519 while online / per-session signatures stay ES256. Pure zod — no runtime
 * crypto — safe to re-export from the shared index (browser + server).
 */
import { z } from "zod";
import {
  e2eeCiphertextSchema,
  e2eeHpkeEnvelopeSchema,
  e2eeKeyDescriptorSchema,
  e2eePublicKeySchema,
  e2eeSignatureSchema
} from "./e2eeSchemas.js";

export const CG_MITM_PROTOCOL = "cg-mitm/1" as const;
export const CG_MITM_HPKE_SUITE = "HPKE-v1-P256-HKDF-SHA256-A256GCM" as const;

// HKDF purposes (info = `cursor-gateway:${purpose}`); direction isolation via distinct keys.
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

// --- alg discriminant (offline root Ed25519 | online ES256) ---
export const cgSignatureAlgSchema = z.enum(["EdDSA", "ES256"]);
export type CgSignatureAlg = z.infer<typeof cgSignatureAlgSchema>;

// Ed25519 signature: 64 raw bytes → 86 base64url chars.
export const cgEdDsaSignatureSchema = z
  .object({
    alg: z.literal("EdDSA"),
    keyId: z.string().trim().min(8).max(128),
    value: base64Url(86).length(86)
  })
  .strict();
export type CgEdDsaSignature = z.infer<typeof cgEdDsaSignatureSchema>;

export const cgAnySignatureSchema = z.union([e2eeSignatureSchema, cgEdDsaSignatureSchema]);
export type CgAnySignature = z.infer<typeof cgAnySignatureSchema>;

// Ed25519 public key (OKP); x = 32 bytes → 43 base64url chars.
export const cgEd25519PublicKeySchema = z
  .object({
    kty: z.literal("OKP"),
    crv: z.literal("Ed25519"),
    x: base64Url(43).length(43)
  })
  .strict();
export type CgEd25519PublicKey = z.infer<typeof cgEd25519PublicKeySchema>;

// --- offline trust root (v2, with alg discriminant) ---
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

// --- server identity certificate (signed by the offline root) ---
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

// --- device certificate (ES256 server signature) ---
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
