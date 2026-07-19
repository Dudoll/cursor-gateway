import assert from "node:assert/strict";
import test from "node:test";
import { GatewayApiError } from "../src/api.js";
import {
  accessRetryDelay,
  isRetryableAccessError,
  waitForStableAccess
} from "../src/accessRetry.js";

test("Access login survives transient failures and requires consecutive success", async () => {
  const outcomes: Array<"login" | "network" | "ok"> = [
    "login",
    "network",
    "ok",
    "network",
    "ok",
    "ok"
  ];
  const delays: number[] = [];
  const events: Array<{ code: string | null; consecutiveSuccesses: number }> = [];
  const result = await waitForStableAccess({
    probe: async () => {
      const outcome = outcomes.shift();
      if (outcome === "login") {
        throw new GatewayApiError(401, "cloudflare_login_required");
      }
      if (outcome === "network") throw new Error("network_unreachable");
      return { ready: true };
    },
    random: () => 0.5,
    sleep: async (ms) => {
      delays.push(ms);
    },
    onAttempt: (event) => {
      events.push({
        code: event.code,
        consecutiveSuccesses: event.consecutiveSuccesses
      });
    }
  });
  assert.deepEqual(result, { ready: true });
  assert.deepEqual(delays, [2_000, 500, 350, 500, 350]);
  assert.equal(events.at(-1)?.consecutiveSuccesses, 2);
});

test("Access retry stops immediately on permanent 403/configuration errors", async () => {
  let attempts = 0;
  await assert.rejects(
    waitForStableAccess({
      probe: async () => {
        attempts += 1;
        throw new GatewayApiError(403, "email_not_allowed");
      },
      sleep: async () => {
        throw new Error("sleep_must_not_run");
      }
    }),
    /email_not_allowed/
  );
  assert.equal(attempts, 1);
  assert.equal(isRetryableAccessError(new Error("secure_origin_mismatch")), false);
});

test("Access retry has bounded exhaustion and exponential jitter", async () => {
  let attempts = 0;
  await assert.rejects(
    waitForStableAccess({
      probe: async () => {
        attempts += 1;
        throw new Error("access_bridge_fetch_timeout");
      },
      maxTransientFailures: 3,
      random: () => 0.5,
      sleep: async () => {}
    }),
    /access_network_retry_exhausted/
  );
  assert.equal(attempts, 4);
  assert.deepEqual(
    [1, 2, 3, 4].map((transientFailures) =>
      accessRetryDelay({ transientFailures, waitingForLogin: false, random: () => 0.5 })
    ),
    [500, 1_000, 2_000, 4_000]
  );
});

test("Access retry cancellation interrupts waiting without another probe", async () => {
  const controller = new AbortController();
  let attempts = 0;
  await assert.rejects(
    waitForStableAccess({
      signal: controller.signal,
      probe: async () => {
        attempts += 1;
        throw new GatewayApiError(401, "cloudflare_login_required");
      },
      sleep: async () => {
        controller.abort();
        throw new Error("access_login_cancelled");
      }
    }),
    /access_login_cancelled/
  );
  assert.equal(attempts, 1);
});
