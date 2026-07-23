import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SDKMessage } from "@cursor/sdk";

const root = mkdtempSync(join(tmpdir(), "cursor-gateway-progress-test-"));
process.env.GATEWAY_URL = "https://gateway.test";
process.env.RUNNER_ID = "runner-progress-test";
process.env.RUNNER_SHARED_SECRET = "x".repeat(32);
process.env.RUNNER_WORKSPACES = root;
process.env.CURSOR_API_KEY = "cursor-test";
process.env.RUNNER_E2EE_ALLOW_INSECURE_DEV_STORAGE = "true";
process.env.RUNNER_E2EE_STATE_FILE = join(root, "runner-state.dat");
process.env.RUNNER_E2EE_MASTER_KEY_FILE = "";
delete process.env.RUNNER_E2EE_MASTER_KEY;

const { progressFromMessage } = await import("../src/cursorAgent.js");

const base = {
  agent_id: "agent-test",
  run_id: "run-test"
};

test("createPlan publishes the user-facing plan body", () => {
  const progress = progressFromMessage({
    ...base,
    type: "tool_call",
    call_id: "call-test",
    name: "createPlan",
    status: "running",
    args: { plan: "# Plan\n\n1. Pair the device\n2. Encrypt the run" }
  } satisfies SDKMessage);

  assert.deepEqual(progress, {
    kind: "working",
    message: "# Plan\n\n1. Pair the device\n2. Encrypt the run"
  });
});

test("thinking never exposes hidden reasoning text", () => {
  const progress = progressFromMessage({
    ...base,
    type: "thinking",
    text: "private chain of thought"
  } satisfies SDKMessage);

  assert.deepEqual(progress, {
    kind: "thinking",
    message: "The model is thinking."
  });
});

test("assistant stream publishes user-visible response text", () => {
  const progress = progressFromMessage({
    ...base,
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Visible progress" }]
    }
  } satisfies SDKMessage);

  assert.deepEqual(progress, {
    kind: "responding",
    message: "Visible progress"
  });
});
