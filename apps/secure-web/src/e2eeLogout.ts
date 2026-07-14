import { GatewayApi } from "./api.js";
import { clearPendingCsAuthRedirect } from "./csAuthReturn.js";
import { SecureWebKeyStore } from "./keyStore.js";

/** UI copy for logout / re-pair (shown in paired-device meta, not the top header). */
export const E2EE_LOGOUT_LABEL = "退出加密";

export const E2EE_LOGOUT_CONFIRM =
  "将清除本浏览器的 Secure 设备密钥与 Runner 配对；不会删除服务端用户。清除后可重新「开始配对」。是否继续？";

export const E2EE_LOGOUT_DONE = "本机加密授权已清除。可重新走 magic-link 配对。";

export const E2EE_ACCESS_LOGOUT_CONFIRM =
  "是否同时打开 Cloudflare Access 退出页？（Gateway 登录会话）";

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

export async function clearLocalE2eeAuthorization(input: {
  api: GatewayApi | null;
  keys: SecureWebKeyStore | null;
  clientId?: string | null;
}): Promise<{ revoked: boolean }> {
  let revoked = false;
  const clientId = input.clientId?.trim();
  if (input.api && clientId) {
    try {
      await input.api.post(`/api/e2ee/v1/devices/${encodeURIComponent(clientId)}/revoke`, {});
      revoked = true;
    } catch {
      // Best-effort; local wipe continues.
    }
  }
  clearPendingCsAuthRedirect();
  await SecureWebKeyStore.wipe(input.keys);
  return { revoked };
}
