import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = mkdtempSync(join(tmpdir(), "cursor-gateway-controls-test-"));
process.env.GATEWAY_URL = "https://gateway.test";
process.env.RUNNER_ID = "runner-controls-test";
process.env.RUNNER_SHARED_SECRET = "x".repeat(32);
process.env.RUNNER_WORKSPACES = root;
process.env.CURSOR_API_KEY = "cursor-test";
process.env.RUNNER_E2EE_ALLOW_INSECURE_DEV_STORAGE = "true";
process.env.RUNNER_E2EE_STATE_FILE = join(root, "runner-state.dat");
process.env.RUNNER_E2EE_MASTER_KEY_FILE = "";
delete process.env.RUNNER_E2EE_MASTER_KEY;

test("run timeout cancels the Cursor SDK run", async () => {
  const { waitForRunWithControls } = await import("../src/cursorAgent.js");
  let cancellations = 0;
  const run = {
    supports: (operation: string) => operation === "cancel",
    cancel: async () => {
      cancellations += 1;
    }
  };

  await assert.rejects(
    waitForRunWithControls(
      run,
      () => new Promise<never>(() => undefined),
      { timeoutMs: 10, cancelGraceMs: 100 }
    ),
    /runner_job_timeout/
  );
  assert.equal(cancellations, 1);
});

test("gateway abort cancels the Cursor SDK run", async () => {
  const { waitForRunWithControls } = await import("../src/cursorAgent.js");
  const controller = new AbortController();
  let cancellations = 0;
  const run = {
    supports: (operation: string) => operation === "cancel",
    cancel: async () => {
      cancellations += 1;
    }
  };

  const waiting = waitForRunWithControls(
    run,
    () => new Promise<never>(() => undefined),
    { timeoutMs: 1_000, cancelGraceMs: 100, signal: controller.signal }
  );
  controller.abort();
  await assert.rejects(waiting, /runner_job_cancelled/);
  assert.equal(cancellations, 1);
});

test("relay server-key fetch forwards the Cloudflare service token", async () => {
  const { csRelayServerKeyRequestHeaders } = await import("../src/e2eeState.js");
  assert.deepEqual(
    csRelayServerKeyRequestHeaders("service-id", "service-secret"),
    {
      accept: "application/json",
      "cf-access-client-id": "service-id",
      "cf-access-client-secret": "service-secret"
    }
  );
  assert.deepEqual(csRelayServerKeyRequestHeaders("service-id"), {
    accept: "application/json"
  });
});
