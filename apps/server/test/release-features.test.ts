import assert from "node:assert/strict";
import test from "node:test";
import {
  interviewEntitlementProvisionSchema,
  interviewProfileUpdateSchema,
  reportIdSchema,
  type RunRecord
} from "@cursor-gateway/shared";
import { getReport, REPORTS } from "../src/reports.js";
import { buildXiaohongshuDraft } from "../src/social.js";

test("release report catalog preserves both interview tracks", () => {
  const ids = REPORTS.map((report) => report.id);
  assert.ok(ids.includes("ai-infra-mianshi"));
  assert.ok(ids.includes("ai-agent-mianshi"));
  assert.equal(getReport("ai-agent-mianshi")?.threadKey, "daily-ai-agent-mianshi");
  assert.equal(reportIdSchema.parse("ai-agent-mianshi"), "ai-agent-mianshi");
});

test("paid interview schemas remain strict and bounded", () => {
  const entitlement = interviewEntitlementProvisionSchema.parse({
    email: "candidate@example.test",
    plan: "pro",
    paymentProvider: "manual",
    paymentReference: "payment-1",
    expiresAt: null,
    activationTtlHours: 24
  });
  assert.equal(entitlement.plan, "pro");
  assert.throws(() =>
    interviewProfileUpdateSchema.parse({
      targetRole: "AI Infra",
      sourceStack: "Java",
      targetCompanies: [],
      currentLevel: "starting",
      weeklyHours: 5,
      targetDate: null,
      goals: "",
      unexpected: true
    })
  );
});

test("Xiaohongshu draft derives cards without leaking markup", () => {
  const run: RunRecord = {
    id: "00000000-0000-4000-8000-000000000001",
    conversationId: "00000000-0000-4000-8000-000000000002",
    origin: "automation",
    status: "finished",
    model: "auto",
    workspaceId: "release-content",
    prompt: "generate",
    response: [
      "### W1｜来源线索：Example",
      "**题目：** Prefix cache 是什么？",
      "**考察点：** 推理优化",
      "**参考答案：** 复用已计算的 KV cache。",
      "",
      "## 今日总结",
      "先掌握缓存命中率与失效边界。"
    ].join("\n"),
    error: null,
    progress: null,
    progressKind: null,
    allowWrites: false,
    idempotencyKey: "daily-ai-infra-mianshi:2026-07-21",
    inputTokens: null,
    outputTokens: null,
    createdAt: "2026-07-21T00:00:00.000Z",
    startedAt: "2026-07-21T00:00:01.000Z",
    finishedAt: "2026-07-21T00:00:02.000Z",
    updatedAt: "2026-07-21T00:00:02.000Z"
  };
  const draft = buildXiaohongshuDraft({
    reportId: "ai-infra-mianshi",
    reportName: "AI Infra 面经",
    run,
    publicOrigin: "https://release.example.test"
  });
  assert.equal(draft.landingUrl, "https://release.example.test/reports/ai-infra-mianshi");
  assert.ok(draft.cards.some((card) => card.kind === "question"));
  assert.ok(draft.cards.some((card) => card.kind === "summary"));
  assert.doesNotMatch(draft.body, /\*\*/);
});
