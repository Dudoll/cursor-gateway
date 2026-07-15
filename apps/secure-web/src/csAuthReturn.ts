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

export const PENDING_CS_AUTH_KEY = "cg-secure-web:pending-cs-auth";

/** Client-side TTL for CS→Secure return context (must outlive typical mail+pair). */
export const CS_AUTH_RETURN_TTL_MS = 10 * 60 * 1000;

/** Shown on Secure after CS grant succeeds, before `location.replace` back to CS. */
export const CS_AUTH_RETURNING_NOTICE = "验证完成，即将跳转回原页面…";

/** Brief pause so the returning notice can paint before navigation. */
export const CS_AUTH_RETURNING_DELAY_MS = 600;

export function delayBeforeCsRedirect(
  ms = CS_AUTH_RETURNING_DELAY_MS
): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type StoredCsAuthReturn = {
  params: CsAuthRedirectParams;
  savedAt: number;
  expiresAt: number;
  /** Set once grant redirect URL is built; prevents reuse across tabs. */
  consumed?: boolean;
};

export type CsAuthStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function browserSessionStorage(): CsAuthStorage | null {
  try {
    return typeof sessionStorage !== "undefined" ? sessionStorage : null;
  } catch {
    return null;
  }
}

function browserLocalStorage(): CsAuthStorage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

export function buildStoredCsAuthReturn(
  params: CsAuthRedirectParams,
  now = Date.now(),
  ttlMs = CS_AUTH_RETURN_TTL_MS
): StoredCsAuthReturn {
  return {
    params,
    savedAt: now,
    expiresAt: now + ttlMs,
    consumed: false
  };
}

/**
 * Parse persisted return context. Returns null if missing, malformed, expired, or consumed.
 * Distinguishes expiry via `reason` when provided.
 */
export function parseStoredCsAuthReturn(
  raw: string | null | undefined,
  now = Date.now()
):
  | { ok: true; value: StoredCsAuthReturn }
  | { ok: false; reason: "missing" | "malformed" | "expired" | "consumed" } {
  if (!raw) return { ok: false, reason: "missing" };
  try {
    const parsed = JSON.parse(raw) as StoredCsAuthReturn | CsAuthRedirectParams;
    // Legacy: bare params object without TTL wrapper.
    if (
      parsed &&
      typeof parsed === "object" &&
      "authId" in parsed &&
      !("params" in parsed)
    ) {
      const params = parsed as CsAuthRedirectParams;
      if (!params.authId || !params.returnOrigin) {
        return { ok: false, reason: "malformed" };
      }
      return {
        ok: true,
        value: buildStoredCsAuthReturn(params, now)
      };
    }
    const stored = parsed as StoredCsAuthReturn;
    if (!stored?.params?.authId || !stored.params.returnOrigin) {
      return { ok: false, reason: "malformed" };
    }
    if (stored.consumed) return { ok: false, reason: "consumed" };
    if (typeof stored.expiresAt === "number" && stored.expiresAt <= now) {
      return { ok: false, reason: "expired" };
    }
    return { ok: true, value: stored };
  } catch {
    return { ok: false, reason: "malformed" };
  }
}

function writeStored(
  storage: CsAuthStorage | null,
  value: StoredCsAuthReturn | null
) {
  if (!storage) return;
  try {
    if (!value) {
      storage.removeItem(PENDING_CS_AUTH_KEY);
      return;
    }
    storage.setItem(PENDING_CS_AUTH_KEY, JSON.stringify(value));
  } catch {
    // Quota / private mode — best-effort.
  }
}

function readRaw(storage: CsAuthStorage | null): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(PENDING_CS_AUTH_KEY);
  } catch {
    return null;
  }
}

/** Persist CS return intent on secure origin (session + local) so magic-link tabs can resume. */
export function savePendingCsAuthRedirect(
  params: CsAuthRedirectParams,
  options?: {
    now?: number;
    ttlMs?: number;
    session?: CsAuthStorage | null;
    local?: CsAuthStorage | null;
  }
): StoredCsAuthReturn {
  const stored = buildStoredCsAuthReturn(
    params,
    options?.now ?? Date.now(),
    options?.ttlMs ?? CS_AUTH_RETURN_TTL_MS
  );
  writeStored(options?.session ?? browserSessionStorage(), stored);
  writeStored(options?.local ?? browserLocalStorage(), stored);
  return stored;
}

export function clearPendingCsAuthRedirect(options?: {
  session?: CsAuthStorage | null;
  local?: CsAuthStorage | null;
}) {
  writeStored(options?.session ?? browserSessionStorage(), null);
  writeStored(options?.local ?? browserLocalStorage(), null);
}

/**
 * Load valid (non-expired, non-consumed) CS return params.
 * Prefers sessionStorage, then localStorage (cross-tab / Gmail→same-browser).
 */
export function loadPendingCsAuthRedirect(options?: {
  now?: number;
  session?: CsAuthStorage | null;
  local?: CsAuthStorage | null;
}): CsAuthRedirectParams | null {
  const now = options?.now ?? Date.now();
  const session = options?.session ?? browserSessionStorage();
  const local = options?.local ?? browserLocalStorage();

  for (const storage of [session, local]) {
    const parsed = parseStoredCsAuthReturn(readRaw(storage), now);
    if (parsed.ok) {
      // Refresh both stores so the other tab sees the same TTL wrapper.
      writeStored(session, parsed.value);
      writeStored(local, parsed.value);
      return parsed.value.params;
    }
    if (parsed.reason === "expired" || parsed.reason === "consumed") {
      writeStored(storage, null);
    }
  }
  return null;
}

/**
 * Capture from URL query (CS→Secure) and/or restore from secure-origin storage.
 * Query params are stripped after capture so magic-link hash navigation stays clean.
 */
export function captureCsAuthRedirectParams(options?: {
  search?: string;
  now?: number;
  session?: CsAuthStorage | null;
  local?: CsAuthStorage | null;
  replaceUrl?: (pathWithHash: string) => void;
}): CsAuthRedirectParams | null {
  const search =
    options?.search ??
    (typeof window !== "undefined" ? window.location.search : "");
  const fromSearch = parseCsAuthRedirectSearch(search);
  if (fromSearch) {
    savePendingCsAuthRedirect(fromSearch, options);
    // Strip cs_auth query so magic-link hash navigation stays clean.
    if (options?.replaceUrl) {
      if (typeof window !== "undefined") {
        const url = new URL(window.location.href);
        url.search = "";
        options.replaceUrl(`${url.pathname}${url.hash}`);
      } else {
        options.replaceUrl("/");
      }
    } else if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.search = "";
      window.history.replaceState(null, "", `${url.pathname}${url.hash}`);
    }
    return fromSearch;
  }
  return loadPendingCsAuthRedirect(options);
}

/** Mark return context consumed (single-use) before navigating back to CS. */
export function markPendingCsAuthRedirectConsumed(options?: {
  now?: number;
  session?: CsAuthStorage | null;
  local?: CsAuthStorage | null;
}): void {
  const now = options?.now ?? Date.now();
  const session = options?.session ?? browserSessionStorage();
  const local = options?.local ?? browserLocalStorage();
  for (const storage of [session, local]) {
    const parsed = parseStoredCsAuthReturn(readRaw(storage), now);
    if (!parsed.ok) continue;
    writeStored(storage, { ...parsed.value, consumed: true });
  }
  // Fully clear so a second tab does not reuse.
  clearPendingCsAuthRedirect({ session, local });
}

export function formatCsAuthReturnError(error: unknown): string {
  const code =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "unknown_error";
  switch (code) {
    case "cs_auth_return_context_missing":
      return "缺少 CS 回跳上下文（可能在其他浏览器打开了邮件链接）。请回到 CS 重新点「启用加密」。";
    case "cs_auth_return_context_expired":
    case "cs_auth_expired":
      return "CS 授权已过期。请回到 CS 重新点「启用加密」。";
    case "cs_auth_consumed":
      return "该次 CS 授权已使用。请回到 CS 重新点「启用加密」。";
    case "cs_auth_rejected":
    case "cs_auth_grant_rejected":
      return "CS 授权被拒绝。请回到 CS 重新点「启用加密」。";
    case "cs_auth_grant_timeout":
      return "等待 Runner 签发授权超时。请回到 CS 重新点「启用加密」。";
    case "secure_not_paired":
      return "Secure 尚未完成配对，无法签发 CS 授权。请先完成 magic-link 配对。";
    case "return_origin_not_allowed":
      return "回跳 origin 不在白名单。请确认从正确的 CS 站点发起授权。";
    default:
      if (code.startsWith("cs_auth_")) {
        return `CS 授权失败（${code}）。请回到 CS 重新点「启用加密」。`;
      }
      return `CS 授权失败：${code}。请回到 CS 重新点「启用加密」。`;
  }
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
  markPendingCsAuthRedirectConsumed();
  return { grant, returnUrl };
}
