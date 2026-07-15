/**
 * Maps Passkey / WebAuthn failure codes to actionable Chinese copy.
 * Keep codes stable; never surface secrets, JWTs, or raw challenges.
 */

const PASSKEY_ERROR_ZH: Record<string, string> = {
  passkey_unsupported_browser:
    "当前浏览器不支持 Passkey。请改用最新版 Chrome / Edge，或使用「二维码 / 恢复码」。",
  passkey_user_cancelled: "已取消 Passkey 验证。若不是你主动取消，请确认已设置 Windows Hello PIN 后重试。",
  passkey_not_allowed:
    "系统拒绝了 Passkey 操作（常见于未设置 Windows Hello PIN、权限被策略禁用，或本机没有可用的平台认证器）。请检查 Windows Hello 后重试，或改用「二维码 / 恢复码」。",
  passkey_not_allowed_or_timeout:
    "Passkey 未完成：可能超时、被取消，或 Windows Hello / 指纹不可用。请确认已设置 Windows Hello PIN，在同一浏览器重试；仍失败请改用「二维码 / 恢复码」。",
  passkey_timed_out: "Passkey 验证超时。请尽快在系统弹窗中输入 PIN / 使用指纹后重试。",
  passkey_aborted: "Passkey 验证被中断。请重试，或改用「二维码 / 恢复码」。",
  passkey_security_error:
    "Passkey 安全上下文错误（页面源与 RP ID 不匹配，或非 HTTPS）。请确认地址栏是 https://secure.joelzt.org。",
  passkey_credential_already_registered_locally:
    "本机已注册过该 Passkey。请直接再次点击继续完成验证；若反复失败，请用「二维码 / 恢复码」。",
  passkey_ceremony_failed: "Passkey 仪式失败。请重试；若持续失败请改用「二维码 / 恢复码」。",
  passkey_options_timeout: "等待 Runner 签发 Passkey 挑战超时。请确认本机 Runner（wsl-e2ee）在线后重试。",
  passkey_expired: "Passkey 挑战已过期。请重新点击「使用 Passkey 继续」。",
  passkey_secure_origin_mismatch:
    "页面源与挑战中的 Secure origin 不一致。请只在 https://secure.joelzt.org 操作，不要用 pages.dev 或其他镜像。",
  passkey_client_mismatch: "设备 clientId 与挑战不匹配。请刷新页面后重试。",
  passkey_fingerprint_mismatch: "设备密钥指纹与挑战不匹配。请刷新页面后重试。",
  passkey_ack_timeout: "已完成系统验证，但等待 Runner 确认超时。请确认 Runner 在线后重试。",
  passkey_ack_signature_invalid: "Runner 确认签名无效。请检查信任根 / Runner 证书后重试。",
  passkey_rejected_by_runner: "Runner 拒绝了此次 Passkey 配对。请查看下方具体原因，或改用恢复码。",
  passkey_rejected: "Runner 拒绝了此次 Passkey 配对。请改用「二维码 / 恢复码」。",
  passkey_pending_missing: "Runner 侧找不到对应挑战（可能已过期或已使用）。请重新发起 Passkey。",
  passkey_challenge_expired: "Runner 侧挑战已过期。请重新发起 Passkey。",
  passkey_mode_mismatch: "Passkey 注册/验证模式不匹配。请重新发起。",
  passkey_client_signature_invalid: "设备签名校验失败。请刷新页面后重试。",
  passkey_registration_verification_failed: "Passkey 注册校验失败（origin / RP ID / UV）。请确认在 https://secure.joelzt.org 并用 Windows Hello 重试。",
  passkey_authentication_verification_failed:
    "Passkey 验证校验失败。若更换过电脑或重置过 Windows Hello，请改用「二维码 / 恢复码」重新配对。",
  passkey_credential_not_offered: "提交的 Passkey 不在本次允许列表中。请用本机已注册的 Windows Hello，或改用恢复码。",
  passkey_access_jwt_invalid: "Cloudflare Access 登录态无效。请先完成 Access 登录后再试 Passkey。",
  passkey_access_jwt_email_mismatch: "Access 登录邮箱与 Passkey 绑定邮箱不一致。请用同一账号登录后重试。",
  trust_roots_not_configured: "未配置 Runner 信任根。请联系管理员。",
  cloudflare_login_required: "需要先完成 Cloudflare Access 登录。",
  secure_origin_mismatch: "Secure 页面源不被 Gateway 允许。请确认打开的是 https://secure.joelzt.org。"
};

/** Maps a handful of common WebAuthn ceremony failures to stable codes. */
export function classifyWebauthnError(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  const message = (error instanceof Error ? error.message : "").toLowerCase();

  if (name === "NotAllowedError") {
    // Chrome/Edge often use the same DOMException for cancel, timeout, and
    // authenticator/policy failures — do not label all of them as "user cancelled".
    if (message.includes("timed out") && !message.includes("not allowed")) {
      return "passkey_timed_out";
    }
    if (message.includes("timed out or was not allowed") || message.includes("timeout")) {
      return "passkey_not_allowed_or_timeout";
    }
    if (message.includes("cancel")) return "passkey_user_cancelled";
    return "passkey_not_allowed";
  }
  if (name === "InvalidStateError") return "passkey_credential_already_registered_locally";
  if (name === "SecurityError") return "passkey_security_error";
  if (name === "AbortError") return "passkey_aborted";
  return "passkey_ceremony_failed";
}

export function formatPasskeyError(error: unknown): string {
  const code =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "passkey_ceremony_failed";

  if (code.startsWith("passkey_runner_cert_")) {
    return `Runner 证书校验失败（${code.replace("passkey_runner_cert_", "")}）。请确认信任根与证书未过期。`;
  }
  if (code.startsWith("passkey_access_jwt_")) {
    const mapped = PASSKEY_ERROR_ZH[code];
    if (mapped) return mapped;
    return `Cloudflare Access 校验失败（${code}）。请重新登录 Access 后重试。`;
  }
  return PASSKEY_ERROR_ZH[code] ?? `Passkey 配对失败：${code}`;
}
