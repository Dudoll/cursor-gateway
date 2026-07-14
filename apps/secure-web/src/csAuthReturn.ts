import {
  e2eeCsAuthGrantSchema,
  type E2eeCsAuthGrant
} from "@cursor-gateway/shared";
import {
  encodeCsAuthGrantFragment,
  parseCsAuthRedirectSearch,
  type CsAuthRedirectParams
} from "@cursor-gateway/e2ee";
import { GatewayApi } from "./api.js";
import { SecureWebKeyStore } from "./keyStore.js";

const PENDING_CS_AUTH_KEY = "cg-secure-web:pending-cs-auth";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function captureCsAuthRedirectParams(): CsAuthRedirectParams | null {
  const fromSearch = parseCsAuthRedirectSearch(window.location.search);
  if (fromSearch) {
    sessionStorage.setItem(PENDING_CS_AUTH_KEY, JSON.stringify(fromSearch));
    // Drop query so magic-link hash navigation does not re-parse stale params forever.
    const url = new URL(window.location.href);
    url.search = "";
    window.history.replaceState(null, "", `${url.pathname}${url.hash}`);
    return fromSearch;
  }
  try {
    const raw = sessionStorage.getItem(PENDING_CS_AUTH_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as CsAuthRedirectParams;
  } catch {
    return null;
  }
}

export function clearPendingCsAuthRedirect() {
  sessionStorage.removeItem(PENDING_CS_AUTH_KEY);
}

/**
 * After Secure Web is paired with the Runner, request a one-time CS grant and
 * return to CS via URL fragment (grant never goes through Gateway as a redirect).
 */
export async function completeCsAuthReturn(input: {
  api: GatewayApi;
  keys: SecureWebKeyStore;
  params: CsAuthRedirectParams;
  options?: { timeoutMs?: number; intervalMs?: number };
}): Promise<{ grant: E2eeCsAuthGrant; returnUrl: string }> {
  const device = await input.keys.device();
  if (!device.pairedRunnerId) {
    throw new Error("secure_not_paired");
  }
  await input.api.post(`/api/e2ee/v1/cs-auth/${input.params.authId}/request`, {
    secureClientId: device.clientId,
    challenge: input.params.challenge,
    state: input.params.state,
    returnOrigin: input.params.returnOrigin,
    clientId: input.params.clientId,
    signingFingerprint: input.params.signingFingerprint,
    encryptionFingerprint: input.params.encryptionFingerprint
  });

  const timeoutMs = input.options?.timeoutMs ?? 120_000;
  const intervalMs = input.options?.intervalMs ?? 2_000;
  const deadline = Date.now() + timeoutMs;
  let grant: E2eeCsAuthGrant | null = null;
  while (Date.now() < deadline) {
    const status = await input.api.get<{
      authId: string;
      status: string;
      grant: unknown | null;
      expiresAt: string;
    }>(`/api/e2ee/v1/cs-auth/${input.params.authId}`);
    if (status.grant) {
      grant = e2eeCsAuthGrantSchema.parse(status.grant);
      break;
    }
    if (
      status.status === "expired" ||
      status.status === "rejected" ||
      status.status === "consumed"
    ) {
      throw new Error(`cs_auth_${status.status}`);
    }
    await sleep(intervalMs);
  }
  if (!grant) throw new Error("cs_auth_grant_timeout");
  if (grant.status !== "authorized") {
    throw new Error("cs_auth_grant_rejected");
  }

  const fragment = encodeCsAuthGrantFragment(grant);
  const returnUrl = `${input.params.returnOrigin.replace(/\/$/, "")}/${fragment}`;
  clearPendingCsAuthRedirect();
  return { grant, returnUrl };
}
