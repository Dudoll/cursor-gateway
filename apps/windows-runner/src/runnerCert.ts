import { existsSync, readFileSync } from "node:fs";
import {
  e2eeRunnerIdentityCertSchema,
  e2eeTrustRootPublicSchema,
  type E2eeRunnerIdentityCert,
  type E2eeTrustRootPublic
} from "@cursor-gateway/shared";
import { verifyRunnerIdentityCert } from "@cursor-gateway/e2ee";
import { config } from "./config.js";
import type { RunnerE2eeState } from "./e2eeState.js";

const CACHE_TTL_MS = 30_000;

type CertCache = {
  cachedAt: number;
  cert: E2eeRunnerIdentityCert | undefined;
};

let cache: CertCache | undefined;

function readJsonFile(path: string): unknown | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    console.warn(`[runner-cert] Failed to parse JSON file at ${path}`);
    return undefined;
  }
}

/** Load offline trust roots from E2EE_TRUST_ROOTS_FILE (public-only JSON). */
export function loadTrustRoots(): E2eeTrustRootPublic[] {
  const path = config.e2eeTrustRootsFile;
  if (!path) return [];
  const raw = readJsonFile(path) as { trustRoots?: unknown[] } | unknown[] | undefined;
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : raw.trustRoots ?? [];
  const roots: E2eeTrustRootPublic[] = [];
  for (const item of list) {
    try {
      roots.push(e2eeTrustRootPublicSchema.parse(item));
    } catch {
      console.warn("[runner-cert] Skipping invalid trust root entry");
    }
  }
  return roots;
}

/** Load the Runner's own signed identity certificate from RUNNER_IDENTITY_CERT_FILE. */
export function loadRunnerCertificateFromDisk(): E2eeRunnerIdentityCert | undefined {
  const path = config.runnerIdentityCertFile;
  const raw = readJsonFile(path);
  if (!raw) return undefined;
  try {
    return e2eeRunnerIdentityCertSchema.parse(raw);
  } catch {
    console.warn(`[runner-cert] Invalid runner identity certificate at ${path}`);
    return undefined;
  }
}

/**
 * Load, validate (against configured trust roots) and cache the Runner's
 * identity certificate. Returns undefined (with a one-time warning) when no
 * cert is configured or it fails validation — passkey/recovery/device-approval
 * flows that require a cert simply stay disabled until one is issued.
 */
export async function getRunnerCertificate(
  state: RunnerE2eeState
): Promise<E2eeRunnerIdentityCert | undefined> {
  const now = Date.now();
  if (cache && now - cache.cachedAt < CACHE_TTL_MS) return cache.cert;

  const cert = loadRunnerCertificateFromDisk();
  if (!cert) {
    cache = { cachedAt: now, cert: undefined };
    return undefined;
  }

  const trustRoots = loadTrustRoots();
  const result = await verifyRunnerIdentityCert({
    cert,
    trustRoots,
    expected: {
      runnerId: config.runnerId,
      encryptionFingerprint: state.encryptionKey.fingerprint,
      signingFingerprint: state.signingKey.fingerprint
    }
  });
  if (!result.ok) {
    console.warn(`[runner-cert] Certificate failed validation: ${result.reason}`);
    cache = { cachedAt: now, cert: undefined };
    return undefined;
  }
  cache = { cachedAt: now, cert };
  return cert;
}

/** Force a re-read on the next call (e.g. after `issue-cert` rotates the file). */
export function invalidateRunnerCertificateCache() {
  cache = undefined;
}
