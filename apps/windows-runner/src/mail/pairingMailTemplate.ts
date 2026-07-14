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
  html: string;
};

const DEFAULT_SUBJECT = "【Piallera Secure】设备配对链接（一次性，请勿转发）";

/**
 * Chinese HTML + plaintext template for Secure Web / CS magic-link pairing mail.
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

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>${escapeHtml(DEFAULT_SUBJECT)}</title></head>
<body style="font-family: system-ui, -apple-system, Segoe UI, sans-serif; line-height: 1.5; color: #111;">
  <p>您好，</p>
  <p>这是 Cursor Gateway / Piallera Secure 的设备配对邮件。</p>
  <p><strong>请在【发起配对的同一浏览器】中</strong>打开下面的链接以完成配对：</p>
  <p style="margin: 1.25rem 0;">
    <a href="${escapeHtml(input.magicLink)}" style="display:inline-block;padding:0.75rem 1.25rem;background:#0b3d2e;color:#fff;text-decoration:none;border-radius:6px;">
      完成设备配对
    </a>
  </p>
  <p style="word-break:break-all;font-size:0.9rem;color:#333;">${escapeHtml(input.magicLink)}</p>
  <h3 style="font-size:1rem;margin-top:1.5rem;">安全提示</h3>
  <ul>
    <li>此链接为<strong>一次性</strong>使用，打开并完成配对后即失效。</li>
    <li><strong>请勿转发</strong>或分享给他人；任何持有此链接的人都可以尝试完成配对。</li>
    <li>链接有效期有限（${escapeHtml(ttl)}），过期后请重新在 Secure Web 发起配对。</li>
    <li>预计过期时间（UTC）：${escapeHtml(input.expiresAt)}${expiresLocal ? `（本地参考：${escapeHtml(expiresLocal)}）` : ""}</li>
  </ul>
  <p style="color:#555;font-size:0.9rem;">配对编号（pairId）：${escapeHtml(input.pairId)}<br/>Runner：${escapeHtml(input.runnerId)}</p>
  <p>如果这不是您本人发起的操作，请忽略本邮件。</p>
  <p style="color:#777;">— Piallera Secure（no-reply）</p>
</body>
</html>`;

  return {
    subject: DEFAULT_SUBJECT,
    text,
    html
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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
