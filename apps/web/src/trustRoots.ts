import {
  e2eeTrustRootPublicSchema,
  type E2eeTrustRootPublic
} from "@cursor-gateway/shared";
import type { GatewayApi } from "./api.js";

/**
 * Optional build-time pin for offline trust roots. Prefer embedding the
 * public root JSON after `trust-root-cli init-root` so CS does not solely
 * trust a Gateway-served list. See docs/trust-root-rotation.md.
 */
export const PINNED_TRUST_ROOTS: E2eeTrustRootPublic[] = [
  {
    protocol: "cg-e2ee/1",
    kind: "trust-root-public/1",
    keyId: "p256-wMuD5PIQsA3H9vQupggwmB",
    fingerprint: "sha256:wMuD5PIQsA3H9vQupggwmBGHzrdLIix2T77R12zDJMM",
    publicKey: {
      kty: "EC",
      crv: "P-256",
      x: "AVeiOWxUSi21MNra5pVDbODYNf7T5S68l-tuZUbOmuI",
      y: "YwfjlRa_-4JrDAu03wRKIuyDxjFIsPjFjjQhHAlNqkY"
    },
    epoch: 1,
    createdAt: "2026-07-14T12:47:31.093Z"
  }
];

export async function loadTrustRoots(api: GatewayApi): Promise<E2eeTrustRootPublic[]> {
  const byFingerprint = new Map<string, E2eeTrustRootPublic>();
  for (const root of PINNED_TRUST_ROOTS) {
    byFingerprint.set(root.fingerprint, root);
  }
  try {
    const policy = await api.get<{ trustRoots?: unknown }>("/api/e2ee-policy");
    const list = Array.isArray(policy.trustRoots) ? policy.trustRoots : [];
    for (const item of list) {
      try {
        const root = e2eeTrustRootPublicSchema.parse(item);
        byFingerprint.set(root.fingerprint, root);
      } catch {
        // Ignore malformed policy entries.
      }
    }
  } catch {
    // Fall back to pins when policy is unavailable.
  }
  return [...byFingerprint.values()];
}
