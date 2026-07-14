import { GatewayApi } from "./api.js";
import { clearPendingCsAuth } from "./csAuth.js";
import { CsWebKeyStore } from "./keyStore.js";

/** UI copy for logout / re-pair (shown inside the encrypted-status badge panel). */
export const E2EE_LOGOUT_LABEL = "退出加密";

export const E2EE_LOGOUT_CONFIRM =
  "将清除本浏览器的设备密钥、Runner 配对与待授权状态；不会删除服务端用户。清除后可再次点「启用加密」从头配对。是否继续？";

export const E2EE_LOGOUT_DONE = "本机加密授权已清除。可再次点「启用加密」重新配对。";

export const E2EE_ACCESS_LOGOUT_CONFIRM =
  "是否同时退出 Cloudflare Access 登录？（可换账号后重新测配对）";

/**
 * Build Cloudflare Access logout URL.
 * Prefer team domain: https://<team>.cloudflareaccess.com/cdn-cgi/access/logout
 */
export function buildCfAccessLogoutUrl(teamDomain: string, returnTo?: string): string | null {
  const trimmed = teamDomain.trim();
  if (!trimmed) return null;
  try {
    const origin = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
    const url = new URL("/cdn-cgi/access/logout", origin);
    if (returnTo) url.searchParams.set("returnTo", returnTo);
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Best-effort remote revoke + wipe local IndexedDB / pending CS auth.
 * Does not delete the server user. Revoke failures do not block local wipe.
 */
export async function clearLocalE2eeAuthorization(input: {
  api: GatewayApi;
  keys: CsWebKeyStore | null;
  clientId?: string | null;
}): Promise<{ revoked: boolean }> {
  let revoked = false;
  const clientId = input.clientId?.trim();
  if (clientId) {
    try {
      await input.api.post(`/api/e2ee/v1/devices/${encodeURIComponent(clientId)}/revoke`, {});
      revoked = true;
    } catch {
      // Local wipe must proceed even if the device was never registered / already revoked.
    }
  }
  clearPendingCsAuth();
  await CsWebKeyStore.wipe(input.keys);
  return { revoked };
}
