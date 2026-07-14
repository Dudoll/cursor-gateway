import assert from "node:assert/strict";
import test from "node:test";
import {
  E2EE_CONTENT_MODE,
  E2EE_ENCRYPTED_BADGE,
  E2EE_PROTOCOL_LABEL,
  e2eeEncryptedTooltip,
  e2eeRunEvidenceLabel,
  e2eeRunEvidenceTitle
} from "../src/e2eeStatusUi.js";

test("encrypted badge copy is concise and protocol-aware", () => {
  assert.equal(E2EE_ENCRYPTED_BADGE, "本次聊天已加密");
  assert.equal(E2EE_CONTENT_MODE, "e2ee-v1");
  assert.equal(E2EE_PROTOCOL_LABEL, "cg-e2ee/1");
});

test("tooltip states UI is not cryptographic proof and includes evidence fields", () => {
  const tip = e2eeEncryptedTooltip({
    runnerId: "runner-a",
    lastRunId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
  });
  assert.match(tip, /经 cg-e2ee\/1/);
  assert.match(tip, /content_mode=e2ee-v1/);
  assert.match(tip, /不是密码学证明|不能单独当作密码学证明/);
  assert.match(tip, /Runner runner-a/);
  assert.match(tip, /aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/);
});

test("run evidence labels expose content_mode and runId without flooding", () => {
  const runId = "11111111-2222-4333-8444-555555555555";
  assert.equal(e2eeRunEvidenceLabel(runId), "e2ee-v1 · 11111111");
  const title = e2eeRunEvidenceTitle(runId);
  assert.match(title, new RegExp(`runId=${runId}`));
  assert.match(title, /content_mode=e2ee-v1/);
  assert.match(title, /\/api\/e2ee\/v1\/runs/);
});
