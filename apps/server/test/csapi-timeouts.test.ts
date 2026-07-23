import assert from "node:assert/strict";
import test from "node:test";
import {
  CSAPI_DEFAULT_ABSOLUTE_TIMEOUT_MS,
  CSAPI_DEFAULT_CALLER_WAIT_TIMEOUT_MS,
  CSAPI_DEFAULT_IDLE_TIMEOUT_MS,
  CSAPI_DEFAULT_QUEUE_TIMEOUT_MS,
  evaluateCsapiRunTimeout,
  minimumCsapiCallerWaitTimeoutMs,
  resolveCsapiCallerWaitTimeoutMs
} from "../src/csapi/runTimeouts.js";

const origin = Date.parse("2026-07-21T00:00:00.000Z");
const iso = (offsetMs: number) => new Date(origin + offsetMs).toISOString();
const defaults = {
  queueTimeoutMs: CSAPI_DEFAULT_QUEUE_TIMEOUT_MS,
  idleTimeoutMs: CSAPI_DEFAULT_IDLE_TIMEOUT_MS,
  absoluteTimeoutMs: CSAPI_DEFAULT_ABSOLUTE_TIMEOUT_MS
};

test("caller budget covers queue, absolute lifetime, and finite safety buffer", () => {
  assert.equal(
    minimumCsapiCallerWaitTimeoutMs(defaults),
    1_800_000
  );
  assert.equal(CSAPI_DEFAULT_CALLER_WAIT_TIMEOUT_MS, 1_800_000);
  assert.equal(
    resolveCsapiCallerWaitTimeoutMs({
      requestedMs: 300_000,
      queueTimeoutMs: defaults.queueTimeoutMs,
      absoluteTimeoutMs: defaults.absoluteTimeoutMs
    }),
    1_800_000
  );
  assert.equal(
    resolveCsapiCallerWaitTimeoutMs({
      requestedMs: 1_900_000,
      queueTimeoutMs: defaults.queueTimeoutMs,
      absoluteTimeoutMs: defaults.absoluteTimeoutMs
    }),
    1_900_000
  );
});

test("active progress or lease keeps a run healthy beyond 300 seconds", () => {
  const decision = evaluateCsapiRunTimeout(
    {
      status: "running",
      queuedAt: iso(0),
      startedAt: iso(1_000),
      lastActivityAt: iso(300_000)
    },
    defaults,
    origin + 301_000
  );
  assert.equal(decision, undefined);
});

test("queued run reaches the 30 second queue timeout", () => {
  assert.equal(
    evaluateCsapiRunTimeout(
      {
        status: "queued",
        queuedAt: iso(0),
        startedAt: null,
        lastActivityAt: null
      },
      defaults,
      origin + 29_999
    ),
    undefined
  );
  assert.deepEqual(
    evaluateCsapiRunTimeout(
      {
        status: "queued",
        queuedAt: iso(0),
        startedAt: null,
        lastActivityAt: null
      },
      defaults,
      origin + 30_000
    ),
    {
      reason: "queue_timeout",
      applicationStatusCode: "CSAPI_QUEUE_TIMEOUT",
      message: "run queue timeout"
    }
  );
});

test("requeued run uses its latest queue deadline while preserving startedAt", () => {
  assert.deepEqual(
    evaluateCsapiRunTimeout(
      {
        status: "queued",
        queuedAt: iso(60_000),
        startedAt: iso(1_000),
        lastActivityAt: null
      },
      defaults,
      origin + 90_000
    ),
    {
      reason: "queue_timeout",
      applicationStatusCode: "CSAPI_QUEUE_TIMEOUT",
      message: "run queue timeout"
    }
  );
});

test("running run reaches the 120 second idle timeout", () => {
  assert.deepEqual(
    evaluateCsapiRunTimeout(
      {
        status: "running",
        queuedAt: iso(0),
        startedAt: iso(1_000),
        lastActivityAt: iso(10_000)
      },
      defaults,
      origin + 130_000
    ),
    {
      reason: "idle_timeout",
      applicationStatusCode: "CSAPI_IDLE_TIMEOUT",
      message: "run idle timeout"
    }
  );
});

test("29 minute absolute deadline wins even with recent activity", () => {
  const absoluteAt = 1_000 + CSAPI_DEFAULT_ABSOLUTE_TIMEOUT_MS;
  assert.deepEqual(
    evaluateCsapiRunTimeout(
      {
        status: "running",
        queuedAt: iso(0),
        startedAt: iso(1_000),
        lastActivityAt: iso(absoluteAt - 1_000)
      },
      defaults,
      origin + absoluteAt
    ),
    {
      reason: "absolute_timeout",
      applicationStatusCode: "CSAPI_ABSOLUTE_TIMEOUT",
      message: "run execution deadline exceeded"
    }
  );
});
