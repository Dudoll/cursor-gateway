export type PairingMailTemplateInput = {
  magicLink: string;
  pairId: string;
  runnerId: string;
  expiresAt: string;
  /** Optional human-readable TTL hint, e.g. "15 分钟". */
  ttlHint?: string;
};

export type PairingMailContent = {
  subject: string;
  text: string;
};

const DEFAULT_SUBJECT = "【Piallera Secure】设备配对链接（一次性，请勿转发）";

/**
 * Chinese plaintext template for Secure Web / CS magic-link pairing mail.
 */
export function buildPairingMailContent(input: PairingMailTemplateInput): PairingMailContent {
  const expiresLocal = formatExpires(input.expiresAt);
  const ttl = input.ttlHint ?? "约 15 分钟";
  const text = [
    "您好，",
    "",
    "这是 Cursor Gateway / Piallera Secure 的设备配对邮件。",
    "请在【发起配对的同一浏览器】中打开下面的链接以完成配对：",
    "",
    input.magicLink,
    "",
    "安全提示：",
    "- 此链接为一次性使用，打开并完成配对后即失效。",
    "- 请勿转发或分享给他人；任何持有此链接的人都可以尝试完成配对。",
    `- 链接有效期有限（${ttl}），过期后请重新在 Secure Web 发起配对。`,
    `- 预计过期时间（UTC）：${input.expiresAt}${expiresLocal ? `（本地参考：${expiresLocal}）` : ""}`,
    "",
    `配对编号（pairId）：${input.pairId}`,
    `Runner：${input.runnerId}`,
    "",
    "如果这不是您本人发起的操作，请忽略本邮件。",
    "",
    "— Piallera Secure（no-reply）"
  ].join("\n");

  return {
    subject: DEFAULT_SUBJECT,
    text
  };
}

function formatExpires(iso: string): string | undefined {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return undefined;
  try {
    return new Date(ms).toLocaleString("zh-CN", { hour12: false });
  } catch {
    return undefined;
  }
}
