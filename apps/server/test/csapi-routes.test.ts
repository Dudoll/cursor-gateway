import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type { RunStatus } from "@cursor-gateway/shared";
import type {
  CsapiBackend,
  CsapiRunHandle,
  CsapiRunObservation,
  CsapiRunSnapshot
} from "../src/csapi/backend.js";
import { SessionSerializer } from "../src/csapi/concurrency.js";
import { createCsapi, registerCsapi } from "../src/csapi/server.js";
import { providerForModel, type CsapiCancelReason } from "../src/csapi/runTimeouts.js";

class FakeClock {
  private currentMs = Date.parse("2026-07-22T00:00:00.000Z");
  private nextHandle = 1;
  private intervals = new Map<
    number,
    { callback: () => void; intervalMs: number; dueAt: number }
  >();

  readonly now = () => this.currentMs;

  readonly sleep = async (ms: number, signal?: AbortSignal) => {
    if (signal?.aborted) throw new Error("fake_clock_aborted");
    const target = this.currentMs + ms;
    for (;;) {
      const next = [...this.intervals.entries()]
        .filter(([, interval]) => interval.dueAt <= target)
        .sort((a, b) => a[1].dueAt - b[1].dueAt)[0];
      if (!next) break;
      const [handle, interval] = next;
      this.currentMs = interval.dueAt;
      interval.callback();
      const active = this.intervals.get(handle);
      if (active) active.dueAt += active.intervalMs;
    }
    this.currentMs = target;
  };

  readonly scheduleHeartbeat = (
    callback: () => void,
    intervalMs: number
  ): number => {
    const handle = this.nextHandle++;
    this.intervals.set(handle, {
      callback,
      intervalMs,
      dueAt: this.currentMs + intervalMs
    });
    return handle;
  };

  readonly cancelHeartbeat = (handle: unknown) => {
    if (typeof handle === "number") this.intervals.delete(handle);
  };
}

// In-memory backend that simulates a runner: a run created at T becomes
// "finished" after `finishDelayMs`. Tracks per-conversation concurrency so we
// can assert same-session serialization and cross-session parallelism.
class FakeBackend implements CsapiBackend {
  finishDelayMs = 120;
  now = Date.now;
  private runs = new Map<
    string,
    {
      createdAt: number;
      prompt: string;
      conversationId: string;
      model: string;
      keyId: string;
      idempotencyKey?: string;
      cancelledAt?: number;
      cancelReason?: CsapiCancelReason;
      lastActivityAt?: number;
    }
  >();
  private conversations = new Set<string>();
  private idempotencyRuns = new Map<string, string>();
  private sessionConversations = new Map<string, string>();
  createConversationCount = 0;
  createRunCount = 0;
  cancelCount = 0;
  maxSameConversationConcurrent = 0;
  maxDistinctConversationsConcurrent = 0;
  /** Override advertised models (default includes a Windows-style id). */
  advertisedModels: string[] = ["cursor-fast", "cursor-smart"];
  lastRunModel: string | null = null;
  lastRunPrompt: string | null = null;
  lastCancelTimeoutMs: number | undefined;
  refreshActivityOnNextTimeoutCancel = false;

  listModelIds() {
    return this.advertisedModels;
  }
  runnersOnline() {
    return 1;
  }
  modelIsKnown(model: string) {
    return model === "auto" || this.listModelIds().includes(model);
  }
  async pickWorkspaceId(preferred?: string) {
    return preferred || "ws-test";
  }
  async getPrincipalId() {
    return "principal-test";
  }
  async createConversation() {
    const id = randomUUID();
    this.conversations.add(id);
    this.createConversationCount += 1;
    return id;
  }
  async conversationExists(conversationId: string) {
    return this.conversations.has(conversationId);
  }
  async resolveConversation(input: {
    sessionKey: string;
  }): Promise<{ conversationId: string; created: boolean }> {
    const existing = this.sessionConversations.get(input.sessionKey);
    if (existing) return { conversationId: existing, created: false };
    const conversationId = await this.createConversation();
    this.sessionConversations.set(input.sessionKey, conversationId);
    return { conversationId, created: true };
  }
  async createRun(input: {
    conversationId: string;
    prompt: string;
    model: string;
    keyId: string;
    idempotencyKey?: string;
  }): Promise<CsapiRunHandle> {
    if (input.idempotencyKey) {
      const existing = this.idempotencyRuns.get(input.idempotencyKey);
      if (existing) {
        const run = this.runs.get(existing)!;
        return {
          runId: existing,
          conversationId: run.conversationId,
          status: this.statusOf(existing)
        };
      }
    }
    const runId = randomUUID();
    this.runs.set(runId, {
      createdAt: this.now(),
      prompt: input.prompt,
      conversationId: input.conversationId,
      model: input.model,
      keyId: input.keyId,
      ...(input.idempotencyKey
        ? { idempotencyKey: input.idempotencyKey }
        : {})
    });
    this.createRunCount += 1;
    this.lastRunModel = input.model;
    this.lastRunPrompt = input.prompt;
    if (input.idempotencyKey) this.idempotencyRuns.set(input.idempotencyKey, runId);
    return { runId, conversationId: input.conversationId, status: "queued" as RunStatus };
  }
  private statusOf(runId: string): RunStatus {
    const run = this.runs.get(runId)!;
    if (run.cancelledAt) return "cancelled";
    const elapsed = this.now() - run.createdAt;
    if (run.prompt.includes("FORCE_ERROR")) return elapsed >= this.finishDelayMs ? "error" : "running";
    return elapsed >= this.finishDelayMs ? "finished" : "running";
  }
  private trackConcurrency() {
    const active: string[] = [];
    for (const [runId, run] of this.runs) {
      const status = this.statusOf(runId);
      if (status === "running" || status === "queued") active.push(run.conversationId);
    }
    const byConv = new Map<string, number>();
    for (const conv of active) byConv.set(conv, (byConv.get(conv) ?? 0) + 1);
    let sameMax = 0;
    for (const count of byConv.values()) sameMax = Math.max(sameMax, count);
    this.maxSameConversationConcurrent = Math.max(this.maxSameConversationConcurrent, sameMax);
    this.maxDistinctConversationsConcurrent = Math.max(this.maxDistinctConversationsConcurrent, byConv.size);
  }
  async getRun(runId: string): Promise<CsapiRunSnapshot | undefined> {
    const run = this.runs.get(runId);
    if (!run) return undefined;
    this.trackConcurrency();
    const status = this.statusOf(runId);
    const lifecycle = {
      queuedAt: new Date(run.createdAt).toISOString(),
      startedAt: new Date(run.createdAt).toISOString(),
      finishedAt:
        status === "finished" || status === "error" || status === "cancelled"
          ? new Date(
              run.cancelledAt ?? run.createdAt + this.finishDelayMs
            ).toISOString()
          : null,
      lastActivityAt: new Date(run.lastActivityAt ?? run.createdAt).toISOString(),
      cancelReason: run.cancelReason ?? null,
      model: run.model,
      provider: providerForModel(run.model)
    };
    if (status === "finished") {
      return {
        status,
        response: run.prompt.includes("STREAM_PROGRESS_DIVERGED")
          ? "polished final"
          : run.prompt.includes("STREAM_PROGRESS")
            ? "partial-final"
            : `echo:${run.prompt}`,
        error: null,
        progress: null,
        progressKind: null,
        inputTokens: 7,
        outputTokens: 5,
        ...lifecycle
      };
    }
    if (status === "error") {
      return {
        status,
        response: null,
        error: "upstream boom",
        progress: null,
        progressKind: null,
        inputTokens: null,
        outputTokens: null,
        ...lifecycle
      };
    }
    if (status === "cancelled") {
      return {
        status,
        response: null,
        error: "cancelled",
        progress: null,
        progressKind: null,
        inputTokens: null,
        outputTokens: null,
        ...lifecycle
      };
    }
    return {
      status,
      response: null,
      error: null,
      progress: run.prompt.includes("STREAM_PROGRESS_DIVERGED")
        ? "early draft"
        : run.prompt.includes("STREAM_PROGRESS")
          ? "partial"
          : "working",
      progressKind: run.prompt.includes("STREAM_PROGRESS") ? "responding" : "working",
      inputTokens: null,
      outputTokens: null,
      ...lifecycle
    };
  }
  private observation(
    runId: string,
    run: CsapiRunSnapshot
  ): CsapiRunObservation {
    return {
      runId,
      status: run.status,
      queuedAt: run.queuedAt,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      lastActivityAt: run.lastActivityAt,
      terminal:
        run.status === "finished" ||
        run.status === "error" ||
        run.status === "cancelled",
      cancelReason: run.cancelReason,
      claimAttempts: 1,
      provider: run.provider,
      model: run.model,
      applicationStatusCode:
        run.status === "finished"
          ? "CSAPI_COMPLETED"
          : run.status === "error"
            ? "CSAPI_RUN_ERROR"
            : run.status === "cancelled"
              ? "CSAPI_RUN_CANCELLED"
              : null
    };
  }
  async observeByIdempotencyKey(
    idempotencyKey: string,
    _principalId: string,
    keyId: string
  ): Promise<CsapiRunObservation[]> {
    const runId = this.idempotencyRuns.get(idempotencyKey);
    if (!runId) return [];
    const stored = this.runs.get(runId);
    const run = await this.getRun(runId);
    if (!stored || stored.keyId !== keyId || !run) return [];
    return [this.observation(runId, run)];
  }
  async observeByRunId(
    runId: string,
    _principalId: string,
    keyId: string
  ): Promise<CsapiRunObservation | undefined> {
    const stored = this.runs.get(runId);
    const run = await this.getRun(runId);
    if (!stored || stored.keyId !== keyId || !run) return undefined;
    return this.observation(runId, run);
  }
  async cancelRun(
    runId: string,
    _principalId: string,
    reason: CsapiCancelReason,
    timeoutMs?: number
  ): Promise<CsapiRunSnapshot | undefined> {
    const run = this.runs.get(runId);
    this.lastCancelTimeoutMs = timeoutMs;
    if (
      run &&
      this.refreshActivityOnNextTimeoutCancel &&
      (reason === "queue_timeout" ||
        reason === "idle_timeout" ||
        reason === "absolute_timeout")
    ) {
      this.refreshActivityOnNextTimeoutCancel = false;
      run.lastActivityAt = this.now();
      return undefined;
    }
    if (run && !run.cancelledAt) {
      run.cancelledAt = this.now();
      run.cancelReason = reason;
      this.cancelCount += 1;
    }
    return this.getRun(runId);
  }
  async audit() {
    /* no-op */
  }
}

const KEY = "test-csapi-key-1";
const SECOND_KEY = "test-csapi-key-2";

function buildApp(options?: {
  apiKeys?: Set<string>;
  maxConc?: number;
  callerWaitTimeoutMs?: number;
  queueTimeoutMs?: number;
  idleTimeoutMs?: number;
  absoluteTimeoutMs?: number;
  finishDelayMs?: number;
  maxPromptChars?: number;
  heartbeatIntervalMs?: number;
  pollIntervalMs?: number;
  clock?: FakeClock;
  backend?: FakeBackend;
}) {
  const backend = options?.backend ?? new FakeBackend();
  if (options?.clock) backend.now = options.clock.now;
  if (options?.finishDelayMs !== undefined) backend.finishDelayMs = options.finishDelayMs;
  const app = Fastify();
  registerCsapi(app, {
    backend,
    config: {
      enabled: true,
      apiKeys: options?.apiKeys ?? new Set([KEY]),
      defaultModel: "auto",
      defaultWorkspaceId: "",
      maxConcurrencyPerKey: options?.maxConc ?? 6,
      callerWaitTimeoutMs: options?.callerWaitTimeoutMs ?? 5_000,
      queueTimeoutMs: options?.queueTimeoutMs ?? 5_000,
      idleTimeoutMs: options?.idleTimeoutMs ?? 5_000,
      absoluteTimeoutMs: options?.absoluteTimeoutMs ?? 10_000,
      maxPromptChars: options?.maxPromptChars ?? 96_000,
      allowWrites: false
    },
    pollIntervalMs: options?.pollIntervalMs ?? 10,
    heartbeatIntervalMs: options?.heartbeatIntervalMs ?? 10_000,
    ...(options?.clock
      ? {
          now: options.clock.now,
          sleep: options.clock.sleep,
          scheduleHeartbeat: options.clock.scheduleHeartbeat,
          cancelHeartbeat: options.clock.cancelHeartbeat
        }
      : {})
  });
  return { app, backend };
}

async function closeApp(app: FastifyInstance) {
  await app.close();
}

test("configured API-key namespace collisions fail closed", () => {
  assert.throws(
    () =>
      createCsapi({
        backend: new FakeBackend(),
        config: {
          enabled: true,
          apiKeys: new Set([
            "vsKR5K1ThKuf4UY6r4fr",
            "NrGsVZVBNbgPGroQVqAQ"
          ]),
          defaultModel: "auto",
          defaultWorkspaceId: "",
          maxConcurrencyPerKey: 6,
          callerWaitTimeoutMs: 5_000,
          queueTimeoutMs: 5_000,
          idleTimeoutMs: 5_000,
          absoluteTimeoutMs: 10_000,
          maxPromptChars: 96_000,
          allowWrites: false
        }
      }),
    /colliding key identifiers/
  );
});

test("auth: missing or wrong key → 401", async () => {
  const { app } = buildApp();
  const noKey = await app.inject({ method: "POST", url: "/v1/messages", payload: { messages: [{ role: "user", content: "hi" }] } });
  assert.equal(noKey.statusCode, 401);
  const wrong = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: "Bearer nope" },
    payload: { messages: [{ role: "user", content: "hi" }] }
  });
  assert.equal(wrong.statusCode, 401);
  await closeApp(app);
});

test("health is open and reports plaintext (not e2ee)", async () => {
  const { app } = buildApp();
  const res = await app.inject({ method: "GET", url: "/health" });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.e2ee, false);
  assert.equal(body.runnersOnline, 1);
  assert.deepEqual(body.capacity, {
    maxConcurrencyPerKey: 6,
    runnerIdentities: 1,
    totalRunnerSlots: 6,
    effectiveTotal: 6
  });
  await closeApp(app);
});

test("models requires auth and lists auto + registered models", async () => {
  const { app } = buildApp();
  const unauth = await app.inject({ method: "GET", url: "/v1/models" });
  assert.equal(unauth.statusCode, 401);
  const res = await app.inject({ method: "GET", url: "/v1/models", headers: { "x-api-key": KEY } });
  assert.equal(res.statusCode, 200);
  const ids = (res.json().data as Array<{ id: string }>).map((m) => m.id);
  assert.deepEqual(ids, ["auto", "cursor-fast", "cursor-smart"]);
  await closeApp(app);
});

test("run observation is read-only, redacted, authenticated, and API-key scoped", async () => {
  const { app } = buildApp({
    apiKeys: new Set([KEY, SECOND_KEY]),
    finishDelayMs: 20
  });
  const rawIdempotencyKey = "observe-safe-run";
  const promptSecret = "PROMPT-MUST-NOT-BE-OBSERVED";
  const completed = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: {
      authorization: `Bearer ${KEY}`,
      "idempotency-key": rawIdempotencyKey
    },
    payload: {
      model: "auto",
      messages: [{ role: "user", content: promptSecret }]
    }
  });
  assert.equal(completed.statusCode, 200);

  const unauthenticated = await app.inject({
    method: "GET",
    url: `/validation/v1/runs/by-idempotency/${rawIdempotencyKey}`
  });
  assert.equal(unauthenticated.statusCode, 401);

  const byKey = await app.inject({
    method: "GET",
    url: `/validation/v1/runs/by-idempotency/${rawIdempotencyKey}`,
    headers: { authorization: `Bearer ${KEY}` }
  });
  assert.equal(byKey.statusCode, 200);
  assert.equal(byKey.headers["cache-control"], "no-store");
  const runs = byKey.json().runs as Array<Record<string, unknown>>;
  assert.equal(runs.length, 1);
  const run = runs[0]!;
  assert.deepEqual(
    Object.keys(run).sort(),
    [
      "applicationStatusCode",
      "cancelReason",
      "claimAttempts",
      "finishedAt",
      "lastActivityAt",
      "model",
      "provider",
      "queuedAt",
      "runId",
      "startedAt",
      "status",
      "terminal"
    ]
  );
  assert.equal(run.status, "finished");
  assert.equal(run.terminal, true);
  assert.equal(run.cancelReason, null);
  assert.equal(run.applicationStatusCode, "CSAPI_COMPLETED");
  assert.equal(run.provider, "cursor-gateway");
  assert.equal(run.model, "auto");
  assert.doesNotMatch(byKey.payload, new RegExp(promptSecret, "u"));
  assert.doesNotMatch(byKey.payload, /response|authorization|token/iu);

  const byRun = await app.inject({
    method: "GET",
    url: `/validation/v1/runs/${String(run.runId)}`,
    headers: { "x-api-key": KEY }
  });
  assert.equal(byRun.statusCode, 200);
  assert.deepEqual(byRun.json().run, run);

  const foreignByKey = await app.inject({
    method: "GET",
    url: `/validation/v1/runs/by-idempotency/${rawIdempotencyKey}`,
    headers: { "x-api-key": SECOND_KEY }
  });
  assert.equal(foreignByKey.statusCode, 200);
  assert.deepEqual(foreignByKey.json(), { runs: [] });

  const foreignByRun = await app.inject({
    method: "GET",
    url: `/validation/v1/runs/${String(run.runId)}`,
    headers: { "x-api-key": SECOND_KEY }
  });
  assert.equal(foreignByRun.statusCode, 404);
  assert.equal(
    foreignByRun.json().error.applicationStatusCode,
    "CSAPI_RUN_NOT_FOUND"
  );
  await closeApp(app);
});

test("auto rewrites to hermes:* when only Hermes models are online", async () => {
  const { app, backend } = buildApp({ finishDelayMs: 20 });
  backend.advertisedModels = ["hermes:default"];
  const res = await app.inject({
    method: "POST",
    url: "/v1/messages",
    headers: { "x-api-key": KEY },
    payload: { model: "auto", max_tokens: 32, messages: [{ role: "user", content: "ping" }] }
  });
  assert.equal(res.statusCode, 200);
  assert.equal(backend.lastRunModel, "hermes:default");
  await closeApp(app);
});

test("auto stays auto when a Windows-style model is online", async () => {
  const { app, backend } = buildApp({ finishDelayMs: 20 });
  backend.advertisedModels = ["cursor-fast", "hermes:default"];
  const res = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: `Bearer ${KEY}` },
    payload: { model: "auto", messages: [{ role: "user", content: "ping" }] }
  });
  assert.equal(res.statusCode, 200);
  assert.equal(backend.lastRunModel, "auto");
  await closeApp(app);
});

test("Anthropic /v1/messages non-stream returns standard shape", async () => {
  const { app } = buildApp({ finishDelayMs: 30 });
  const res = await app.inject({
    method: "POST",
    url: "/v1/messages",
    headers: { "x-api-key": KEY },
    payload: { model: "claude-3-5-sonnet", max_tokens: 128, messages: [{ role: "user", content: "ping" }] }
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.type, "message");
  assert.equal(body.model, "claude-3-5-sonnet");
  assert.match(body.content[0].text, /echo:.*ping/);
  assert.equal(body.usage.output_tokens, 5);
  await closeApp(app);
});

test("Anthropic /v1/messages streaming emits SSE frames", async () => {
  const { app } = buildApp({ finishDelayMs: 30 });
  const res = await app.inject({
    method: "POST",
    url: "/v1/messages",
    headers: { "x-api-key": KEY },
    payload: { model: "auto", stream: true, messages: [{ role: "user", content: "streamme" }] }
  });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["content-type"] as string, /text\/event-stream/);
  const payload = res.payload;
  assert.match(payload, /event: ping/);
  assert.match(payload, /event: message_start/);
  assert.match(payload, /event: content_block_delta/);
  assert.match(payload, /streamme/);
  assert.match(payload, /event: message_stop/);
  await closeApp(app);
});

test("OpenAI /v1/chat/completions non-stream returns standard shape", async () => {
  const { app, backend } = buildApp({ finishDelayMs: 30 });
  const res = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: `Bearer ${KEY}` },
    payload: { model: "gpt-4o", messages: [{ role: "system", content: "be terse" }, { role: "user", content: "ping" }] }
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.object, "chat.completion");
  assert.equal(body.model, "gpt-4o");
  assert.match(body.choices[0].message.content, /echo:[\s\S]*ping/);
  assert.equal(body.choices[0].finish_reason, "stop");
  assert.match(backend.lastRunPrompt ?? "", /be terse/);
  await closeApp(app);
});

test("OpenAI streaming emits chunks and [DONE]", async () => {
  const { app } = buildApp({ finishDelayMs: 30 });
  const res = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: `Bearer ${KEY}` },
    payload: { model: "auto", stream: true, messages: [{ role: "user", content: "hey" }] }
  });
  assert.equal(res.statusCode, 200);
  const payload = res.payload;
  assert.match(payload, /chatcmpl-heartbeat/);
  assert.match(payload, /chat\.completion\.chunk/);
  assert.match(payload, /reasoning_content/);
  assert.match(payload, /hey/);
  assert.match(payload, /data: \[DONE\]/);
  await closeApp(app);
});

test("OpenAI streaming sends the authoritative terminal response once", async () => {
  const { app } = buildApp({ finishDelayMs: 30 });
  const res = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: `Bearer ${KEY}` },
    payload: {
      model: "auto",
      stream: true,
      messages: [{ role: "user", content: "STREAM_PROGRESS" }]
    }
  });
  const content = res.payload
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>)
    .flatMap((frame) => (frame.choices as Array<Record<string, unknown>> | undefined) ?? [])
    .map((choice) => (choice.delta as { content?: string } | undefined)?.content ?? "")
    .join("");
  assert.equal(content, "partial-final");
  assert.equal((content.match(/partial/g) ?? []).length, 1);
  await closeApp(app);
});

test("OpenAI streaming does not concatenate a divergent response draft", async () => {
  const { app } = buildApp({ finishDelayMs: 30 });
  const res = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: `Bearer ${KEY}` },
    payload: {
      model: "auto",
      stream: true,
      messages: [{ role: "user", content: "STREAM_PROGRESS_DIVERGED" }]
    }
  });
  const frames = res.payload
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
  const content = frames
    .flatMap((frame) => (frame.choices as Array<Record<string, unknown>> | undefined) ?? [])
    .map((choice) => (choice.delta as { content?: string } | undefined)?.content ?? "")
    .join("");
  assert.equal(content, "polished final");
  assert.doesNotMatch(res.payload, /early draft/);
  await closeApp(app);
});

test("OpenAI streaming keeps a Hermes-compatible request alive beyond 300 seconds", async () => {
  const clock = new FakeClock();
  const startedAt = clock.now();
  const { app } = buildApp({
    clock,
    finishDelayMs: 310_000,
    callerWaitTimeoutMs: 1_800_000,
    queueTimeoutMs: 30_000,
    idleTimeoutMs: 400_000,
    absoluteTimeoutMs: 1_740_000,
    pollIntervalMs: 10_000,
    heartbeatIntervalMs: 10_000
  });
  const res = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: `Bearer ${KEY}` },
    payload: { model: "auto", stream: true, messages: [{ role: "user", content: "slow stream" }] }
  });
  const heartbeatCount = (res.payload.match(/chatcmpl-heartbeat/g) ?? []).length;
  assert.equal(res.statusCode, 200);
  assert.ok(clock.now() - startedAt >= 310_000);
  assert.ok(heartbeatCount >= 31, `expected repeated heartbeat frames, saw ${heartbeatCount}`);
  assert.doesNotMatch(res.payload, /CSAPI_CALLER_WAIT_TIMEOUT/);
  assert.match(res.payload, /data: \[DONE\]/);
  await closeApp(app);
});

test("Telegram → Hermes contract → gateway → fake runner → Telegram reply", async () => {
  const { app } = buildApp({ finishDelayMs: 30, heartbeatIntervalMs: 5 });
  const telegramEvents: Array<{ kind: "typing" | "message"; text?: string }> = [];
  telegramEvents.push({ kind: "typing" });

  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: {
      authorization: `Bearer ${KEY}`,
      "x-session-id": "telegram-chat-1",
      "idempotency-key": "telegram-update-1001"
    },
    payload: {
      model: "auto",
      stream: true,
      messages: [
        { role: "system", content: "Telegram Hermes bridge" },
        { role: "user", content: "contract-ping" }
      ]
    }
  });
  const text = response.payload
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>)
    .flatMap((frame) => (frame.choices as Array<Record<string, unknown>> | undefined) ?? [])
    .map((choice) => (choice.delta as { content?: string } | undefined)?.content ?? "")
    .join("");
  for (let offset = 0; offset < text.length; offset += 4_096) {
    telegramEvents.push({ kind: "message", text: text.slice(offset, offset + 4_096) });
  }

  assert.equal(response.statusCode, 200);
  assert.equal(telegramEvents[0]?.kind, "typing");
  assert.match(telegramEvents.map((event) => event.text ?? "").join(""), /contract-ping/);
  await closeApp(app);
});

test("Telegram contract splits a long Hermes reply without losing content", async () => {
  const { app } = buildApp({ finishDelayMs: 20 });
  const source = `LONG-REPLY-${"x".repeat(9_000)}`;
  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: {
      authorization: `Bearer ${KEY}`,
      "x-session-id": "telegram-long-reply",
      "idempotency-key": "telegram-long-reply-turn"
    },
    payload: {
      model: "auto",
      stream: true,
      messages: [{ role: "user", content: source }]
    }
  });
  const text = response.payload
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>)
    .flatMap((frame) => (frame.choices as Array<Record<string, unknown>> | undefined) ?? [])
    .map((choice) => (choice.delta as { content?: string } | undefined)?.content ?? "")
    .join("");
  const telegramChunks = Array.from(
    { length: Math.ceil(text.length / 4_096) },
    (_, index) => text.slice(index * 4_096, (index + 1) * 4_096)
  );
  assert.ok(telegramChunks.length >= 3);
  assert.ok(telegramChunks.every((chunk) => chunk.length <= 4_096));
  assert.equal(telegramChunks.join(""), text);
  assert.match(text, /LONG-REPLY-/);
  await closeApp(app);
});

test("upstream run error maps to 502", async () => {
  const { app } = buildApp({ finishDelayMs: 20 });
  const res = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: `Bearer ${KEY}` },
    payload: { model: "auto", messages: [{ role: "user", content: "FORCE_ERROR please" }] }
  });
  assert.equal(res.statusCode, 502);
  assert.match(res.json().error.message, /upstream boom/);
  await closeApp(app);
});

test("idempotent retries return the same real terminal error", async () => {
  const { app, backend } = buildApp({ finishDelayMs: 20 });
  const fire = () =>
    app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: `Bearer ${KEY}`,
        "idempotency-key": "stable-terminal-error"
      },
      payload: {
        model: "auto",
        messages: [{ role: "user", content: "FORCE_ERROR stable" }]
      }
    });
  const first = await fire();
  const retry = await fire();
  assert.equal(first.statusCode, 502);
  assert.equal(retry.statusCode, 502);
  assert.deepEqual(retry.json().error, first.json().error);
  assert.equal(first.json().error.applicationStatusCode, "CSAPI_RUN_ERROR");
  assert.equal(backend.createRunCount, 1);
  await closeApp(app);
});

test("structured failure logs omit prompt, token and auth data", async () => {
  const backend = new FakeBackend();
  backend.finishDelayMs = 20;
  const records: unknown[] = [];
  const log = {
    info(bindings: unknown) {
      records.push(bindings);
    },
    warn(bindings: unknown) {
      records.push(bindings);
    }
  } as unknown as FastifyRequest["log"];
  const csapi = createCsapi({
    backend,
    config: {
      enabled: true,
      apiKeys: new Set([KEY]),
      defaultModel: "auto",
      defaultWorkspaceId: "",
      maxConcurrencyPerKey: 6,
      callerWaitTimeoutMs: 5_000,
      queueTimeoutMs: 5_000,
      idleTimeoutMs: 5_000,
      absoluteTimeoutMs: 10_000,
      maxPromptChars: 96_000,
      allowWrites: false
    },
    pollIntervalMs: 10
  });
  await assert.rejects(
    csapi.execute({
      keyId: "k_safe",
      system: "",
      messages: [{ role: "user", text: "FORCE_ERROR PROMPT_SECRET_123" }],
      requestedModel: "auto",
      sessionKey: null,
      requestId: "request-safe",
      log
    })
  );
  const serialized = JSON.stringify(records);
  assert.doesNotMatch(serialized, /PROMPT_SECRET_123|inputTokens|outputTokens|authorization|apiKey/);
  assert.match(serialized, /CSAPI_RUN_ERROR/);
  assert.match(serialized, /"provider":"cursor-gateway"/);
  assert.match(serialized, /"model":"auto"/);
});

test("same-session requests serialize; only one conversation is created", async () => {
  const { app, backend } = buildApp({ finishDelayMs: 80 });
  const fire = () =>
    app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${KEY}`, "x-session-id": "sessionA" },
      payload: { model: "auto", messages: [{ role: "user", content: "turn" }] }
    });
  const [a, b] = await Promise.all([fire(), fire()]);
  assert.equal(a.statusCode, 200);
  assert.equal(b.statusCode, 200);
  // Serialized: the same conversation never had two active runs at once.
  assert.equal(backend.maxSameConversationConcurrent, 1);
  // Both turns reused a single conversation for the session.
  assert.equal(backend.createConversationCount, 1);
  assert.equal(backend.createRunCount, 2);
  await closeApp(app);
});

test("session conversation survives csapi instance recreation", async () => {
  const backend = new FakeBackend();
  backend.finishDelayMs = 20;
  const firstApp = buildApp({ backend }).app;
  const first = await firstApp.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: `Bearer ${KEY}`, "x-session-id": "durable-session" },
    payload: { model: "auto", messages: [{ role: "user", content: "first durable turn" }] }
  });
  assert.equal(first.statusCode, 200);
  await closeApp(firstApp);

  const secondApp = buildApp({ backend }).app;
  const second = await secondApp.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: `Bearer ${KEY}`, "x-session-id": "durable-session" },
    payload: {
      model: "auto",
      messages: [
        { role: "user", content: "first durable turn" },
        { role: "assistant", content: "first reply" },
        { role: "user", content: "second durable turn" }
      ]
    }
  });
  assert.equal(second.statusCode, 200);
  assert.equal(backend.createConversationCount, 1);
  assert.equal(backend.lastRunPrompt, "second durable turn");
  await closeApp(secondApp);
});

test("a disconnected queued session request releases immediately", async () => {
  const serializer = new SessionSerializer();
  let releaseFirst!: () => void;
  const first = serializer.run(
    "session-a",
    () =>
      new Promise<void>((resolve) => {
        releaseFirst = resolve;
      })
  );
  await new Promise<void>((resolve) => setImmediate(resolve));

  const controller = new AbortController();
  let secondStarted = false;
  const second = serializer.run(
    "session-a",
    async () => {
      secondStarted = true;
    },
    controller.signal
  );
  assert.equal(serializer.depth("session-a"), 2);

  controller.abort();
  await assert.rejects(second, /session_wait_aborted/);
  assert.equal(secondStarted, false);
  assert.equal(serializer.depth("session-a"), 1);

  releaseFirst();
  await first;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(serializer.depth("session-a"), 0);
});

test("cross-session requests run in parallel", async () => {
  const { app, backend } = buildApp({ finishDelayMs: 100 });
  const fire = (session: string) =>
    app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${KEY}`, "x-session-id": session },
      payload: { model: "auto", messages: [{ role: "user", content: "turn" }] }
    });
  const results = await Promise.all([fire("s1"), fire("s2"), fire("s3")]);
  for (const r of results) assert.equal(r.statusCode, 200);
  assert.ok(
    backend.maxDistinctConversationsConcurrent >= 2,
    `expected parallel sessions, saw ${backend.maxDistinctConversationsConcurrent}`
  );
  await closeApp(app);
});

test("backpressure: per-key concurrency limit returns 429 + Retry-After", async () => {
  const { app } = buildApp({ maxConc: 1, finishDelayMs: 120 });
  const fire = (session: string) =>
    app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${KEY}`, "x-session-id": session },
      payload: { model: "auto", messages: [{ role: "user", content: "turn" }] }
    });
  const [a, b] = await Promise.all([fire("p1"), fire("p2")]);
  const codes = [a.statusCode, b.statusCode].sort();
  assert.deepEqual(codes, [200, 429]);
  const limited = a.statusCode === 429 ? a : b;
  assert.equal(limited.headers["retry-after"], "1");
  await closeApp(app);
});

test("per-key concurrency admits six runs and rejects the seventh", async () => {
  const { app } = buildApp({ maxConc: 6, finishDelayMs: 150 });
  const results = await Promise.all(
    Array.from({ length: 7 }, (_, index) =>
      app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          authorization: `Bearer ${KEY}`,
          "x-session-id": `capacity-${index}`
        },
        payload: { model: "auto", messages: [{ role: "user", content: "hold" }] }
      })
    )
  );
  assert.deepEqual(
    results.map((result) => result.statusCode).sort((a, b) => a - b),
    [200, 200, 200, 200, 200, 200, 429]
  );
  await closeApp(app);
});

test("idle timeout maps to a stable 504 and cancels the run", async () => {
  const { app, backend } = buildApp({ idleTimeoutMs: 40, finishDelayMs: 10_000 });
  const res = await app.inject({
    method: "POST",
    url: "/v1/messages",
    headers: { "x-api-key": KEY },
    payload: { model: "auto", messages: [{ role: "user", content: "slow" }] }
  });
  assert.equal(res.statusCode, 504);
  assert.equal(res.json().error.applicationStatusCode, "CSAPI_IDLE_TIMEOUT");
  assert.equal(res.json().error.cancelReason, "idle_timeout");
  assert.equal(backend.lastCancelTimeoutMs, 40);
  assert.ok(backend.cancelCount >= 1);
  await closeApp(app);
});

test("fresh activity racing an idle timeout prevents false cancellation", async () => {
  const backend = new FakeBackend();
  backend.finishDelayMs = 35;
  backend.refreshActivityOnNextTimeoutCancel = true;
  const { app } = buildApp({
    backend,
    callerWaitTimeoutMs: 500,
    idleTimeoutMs: 20,
    absoluteTimeoutMs: 1_000
  });
  const res = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: `Bearer ${KEY}` },
    payload: {
      model: "auto",
      messages: [{ role: "user", content: "activity race" }]
    }
  });
  assert.equal(res.statusCode, 200);
  assert.equal(backend.lastCancelTimeoutMs, 20);
  assert.equal(backend.cancelCount, 0);
  await closeApp(app);
});

test("stream errors expose status code, cancel reason, provider and model", async () => {
  const { app } = buildApp({ idleTimeoutMs: 35, finishDelayMs: 10_000 });
  const res = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: `Bearer ${KEY}` },
    payload: {
      model: "auto",
      stream: true,
      messages: [{ role: "user", content: "slow stream" }]
    }
  });
  assert.equal(res.statusCode, 200);
  const errorLine = res.payload
    .split("\n")
    .find((line) => line.startsWith("data: ") && line.includes("applicationStatusCode"));
  assert.ok(errorLine);
  const payload = JSON.parse(errorLine.slice(6));
  assert.equal(payload.error.applicationStatusCode, "CSAPI_IDLE_TIMEOUT");
  assert.equal(payload.error.cancelReason, "idle_timeout");
  assert.equal(payload.error.provider, "cursor-gateway");
  assert.equal(payload.error.model, "auto");
  assert.doesNotMatch(res.payload, /slow stream|test-csapi-key-1/);
  await closeApp(app);
});

test("idempotency key reuses a completed run", async () => {
  const { app, backend } = buildApp({ finishDelayMs: 20 });
  const fire = () =>
    app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: `Bearer ${KEY}`,
        "x-session-id": "idem-session",
        "idempotency-key": "idem-turn-1"
      },
      payload: { model: "auto", messages: [{ role: "user", content: "idempotent" }] }
    });
  const first = await fire();
  const second = await fire();
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal(backend.createRunCount, 1);
  await closeApp(app);
});

test("caller timeout leaves a healthy idempotent run active and retry reattaches", async () => {
  const clock = new FakeClock();
  const { app, backend } = buildApp({
    clock,
    callerWaitTimeoutMs: 30,
    idleTimeoutMs: 1_000,
    absoluteTimeoutMs: 2_000,
    finishDelayMs: 50
  });
  const fire = () =>
    app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: `Bearer ${KEY}`,
        "x-session-id": "timeout-idem-session",
        "idempotency-key": "timeout-idem-turn"
      },
      payload: { model: "auto", messages: [{ role: "user", content: "slow idempotent" }] }
    });
  const first = await fire();
  const second = await fire();
  assert.equal(first.statusCode, 504);
  assert.equal(first.json().error.applicationStatusCode, "CSAPI_CALLER_WAIT_TIMEOUT");
  assert.equal(second.statusCode, 200);
  assert.equal(backend.createRunCount, 1);
  assert.equal(backend.cancelCount, 0);
  await closeApp(app);
});

test("structured CSAPI logs omit prompt, key, session, and authorization data", async () => {
  const clock = new FakeClock();
  const backend = new FakeBackend();
  backend.now = clock.now;
  backend.finishDelayMs = 20;
  const events: unknown[] = [];
  const log = {
    info(value: unknown) {
      events.push(value);
    },
    warn(value: unknown) {
      events.push(value);
    }
  } as unknown as FastifyRequest["log"];
  const csapi = createCsapi({
    backend,
    config: {
      enabled: true,
      apiKeys: new Set([KEY]),
      defaultModel: "auto",
      defaultWorkspaceId: "",
      maxConcurrencyPerKey: 6,
      callerWaitTimeoutMs: 100,
      queueTimeoutMs: 100,
      idleTimeoutMs: 1_000,
      absoluteTimeoutMs: 2_000,
      maxPromptChars: 96_000,
      allowWrites: false
    },
    pollIntervalMs: 10,
    now: clock.now,
    sleep: clock.sleep
  });
  await assert.rejects(
    csapi.execute({
      keyId: "secret-key-id-marker",
      system: "",
      messages: [
        {
          role: "user",
          text: "FORCE_ERROR secret-prompt-marker Authorization: Bearer hidden"
        }
      ],
      requestedModel: "auto",
      sessionKey: "secret-session-marker",
      requestId: "safe-request-id",
      log
    })
  );
  const rendered = JSON.stringify(events);
  assert.match(rendered, /CSAPI_RUN_ERROR/);
  assert.doesNotMatch(
    rendered,
    /secret-key-id-marker|secret-prompt-marker|secret-session-marker|Bearer hidden/
  );
});

test("large initial transcript is bounded and retains latest user turn", async () => {
  const { app, backend } = buildApp({ finishDelayMs: 20, maxPromptChars: 1_024 });
  const res = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: {
      authorization: `Bearer ${KEY}`,
      "x-session-id": "large-context-session"
    },
    payload: {
      model: "auto",
      messages: [
        { role: "system", content: `system-${"s".repeat(2_000)}` },
        { role: "user", content: `old-${"x".repeat(5_000)}` },
        { role: "assistant", content: `reply-${"y".repeat(5_000)}` },
        { role: "user", content: "LATEST-CONTEXT-TURN" }
      ]
    }
  });
  assert.equal(res.statusCode, 200);
  assert.ok((backend.lastRunPrompt?.length ?? Infinity) <= 1_024);
  assert.match(backend.lastRunPrompt ?? "", /LATEST-CONTEXT-TURN/);
  assert.match(backend.lastRunPrompt ?? "", /Earlier context truncated/);
  await closeApp(app);
});

test("abort during execute cancels the queued run", async () => {
  const backend = new FakeBackend();
  backend.finishDelayMs = 10_000;
  const csapi = createCsapi({
    backend,
    config: {
      enabled: true,
      apiKeys: new Set([KEY]),
      defaultModel: "auto",
      defaultWorkspaceId: "",
      maxConcurrencyPerKey: 6,
      callerWaitTimeoutMs: 10_000,
      queueTimeoutMs: 5_000,
      idleTimeoutMs: 5_000,
      absoluteTimeoutMs: 10_000,
      maxPromptChars: 96_000,
      allowWrites: false
    },
    pollIntervalMs: 10
  });
  const controller = new AbortController();
  const promise = csapi.execute({
    keyId: "k_test",
    system: "",
    messages: [{ role: "user", text: "hello" }],
    requestedModel: "auto",
    sessionKey: null,
    signal: controller.signal
  });
  setTimeout(() => controller.abort(), 25);
  await assert.rejects(promise);
  assert.ok(backend.cancelCount >= 1, "expected the aborted run to be cancelled");
});
