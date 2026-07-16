/**
 * Base E2EE Zod schemas shared by index.ts and cgMitm.ts.
 * Kept in a separate module so cgMitm can import without a circular dependency
 * through index.ts.
 */
import { z } from "zod";

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
