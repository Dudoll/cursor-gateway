import {
  e2eeTrustRootPublicSchema,
  type E2eeRunnerIdentityCert,
  type E2eeTrustRootPublic
} from "@cursor-gateway/shared";
import { verifyRunnerIdentityCert } from "@cursor-gateway/e2ee";
import type { GatewayApi } from "./api.js";

/**
 * Optional build-time pin. Empty by default — production deploys should embed
 * the offline trust-root public JSON here (or via Vite define) so clients do
 * not rely solely on a Gateway-served list. When both pin and policy roots are
 * present, verification accepts a cert signed by *either* set (union), so root
 * rotation can ship policy first then rebuild clients.
 *
 * Honest trust note: Secure Web static assets are currently served from the
 * VPS nginx host. A compromised VPS can replace this JS. Full independent
 * client trust requires hosting Secure Web on Cloudflare Pages (immutable
 * deploy + Access) — see docs/trust-root-rotation.md.
 */
export const PINNED_TRUST_ROOTS: E2eeTrustRootPublic[] = [];

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
        // Skip invalid entries from the Gateway.
      }
    }
  } catch {
    // Policy fetch may fail before Access login; fall back to pins only.
  }
  return [...byFingerprint.values()];
}

export async function assertRunnerCertificate(input: {
  cert: E2eeRunnerIdentityCert;
  trustRoots: E2eeTrustRootPublic[];
  runnerId: string;
  encryptionFingerprint: string;
  signingFingerprint: string;
  secureOrigin?: string;
  rpId?: string;
}): Promise<void> {
  if (input.trustRoots.length === 0) {
    throw new Error("trust_roots_not_configured");
  }
  const result = await verifyRunnerIdentityCert({
    cert: input.cert,
    trustRoots: input.trustRoots,
    expected: {
      runnerId: input.runnerId,
      encryptionFingerprint: input.encryptionFingerprint,
      signingFingerprint: input.signingFingerprint,
      ...(input.secureOrigin ? { secureOrigin: input.secureOrigin } : {}),
      ...(input.rpId ? { rpId: input.rpId } : {})
    }
  });
  if (!result.ok) throw new Error(result.reason);
}
