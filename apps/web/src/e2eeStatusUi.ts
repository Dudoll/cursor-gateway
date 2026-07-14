/** UI copy for CS encryption status. Badges are UX only — not cryptographic proof. */

export const E2EE_CONTENT_MODE = "e2ee-v1" as const;
export const E2EE_PROTOCOL_LABEL = "cg-e2ee/1" as const;

export const E2EE_ENCRYPTED_BADGE = "本次聊天已加密";

export function e2eeEncryptedTooltip(input?: {
  runnerId?: string | null;
  lastRunId?: string | null;
}): string {
  const parts = [
    `经 ${E2EE_PROTOCOL_LABEL}，网关不可见明文`,
    `content_mode=${E2EE_CONTENT_MODE}`,
    "徽章仅为 UI 状态，不能单独当作密码学证明"
  ];
  if (input?.runnerId) {
    parts.push(`Runner ${input.runnerId}`);
  }
  if (input?.lastRunId) {
    parts.push(`最近 runId ${input.lastRunId}`);
  }
  return parts.join(" · ");
}

export function e2eeRunEvidenceLabel(runId: string): string {
  return `${E2EE_CONTENT_MODE} · ${runId.slice(0, 8)}`;
}

export function e2eeRunEvidenceTitle(runId: string): string {
  return [
    `runId=${runId}`,
    `content_mode=${E2EE_CONTENT_MODE}`,
    `protocol=${E2EE_PROTOCOL_LABEL}`,
    "经 /api/e2ee/v1/runs；请求体为密文信封"
  ].join(" · ");
}
