import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { RunStatus } from "@cursor-gateway/shared";
import type { CsapiBackend, CsapiRunHandle, CsapiRunSnapshot } from "../src/csapi/backend.js";
import { createCsapi, registerCsapi } from "../src/csapi/server.js";

// In-memory backend that simulates a runner: a run created at T becomes
// "finished" after `finishDelayMs`. Tracks per-conversation concurrency so we
// can assert same-session serialization and cross-session parallelism.
class FakeBackend implements CsapiBackend {
  finishDelayMs = 120;
  private runs = new Map<
    string,
    { createdAt: number; prompt: string; conversationId: string; cancelledAt?: number }
  >();
  private conversations = new Set<string>();
  createConversationCount = 0;
  createRunCount = 0;
  cancelCount = 0;
  maxSameConversationConcurrent = 0;
  maxDistinctConversationsConcurrent = 0;

  listModelIds() {
    return ["cursor-fast", "cursor-smart"];
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
  async createRun(input: {
    conversationId: string;
    prompt: string;
  }): Promise<CsapiRunHandle> {
    const runId = randomUUID();
    this.runs.set(runId, { createdAt: Date.now(), prompt: input.prompt, conversationId: input.conversationId });
    this.createRunCount += 1;
    return { runId, conversationId: input.conversationId, status: "queued" as RunStatus };
  }
  private statusOf(runId: string): RunStatus {
    const run = this.runs.get(runId)!;
    if (run.cancelledAt) return "cancelled";
    const elapsed = Date.now() - run.createdAt;
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
    if (status === "finished") {
      return { status, response: `echo:${run.prompt}`, error: null, progress: null, inputTokens: 7, outputTokens: 5 };
    }
    if (status === "error") {
      return { status, response: null, error: "upstream boom", progress: null, inputTokens: null, outputTokens: null };
    }
    if (status === "cancelled") {
      return { status, response: null, error: "cancelled", progress: null, inputTokens: null, outputTokens: null };
    }
    return { status, response: null, error: null, progress: "working", inputTokens: null, outputTokens: null };
  }
  async cancelRun(runId: string) {
    const run = this.runs.get(runId);
    if (run && !run.cancelledAt) {
      run.cancelledAt = Date.now();
      this.cancelCount += 1;
    }
  }
  async audit() {
    /* no-op */
  }
}

const KEY = "test-csapi-key-1";

function buildApp(options?: { maxConc?: number; runTimeoutMs?: number; finishDelayMs?: number }) {
  const backend = new FakeBackend();
  if (options?.finishDelayMs !== undefined) backend.finishDelayMs = options.finishDelayMs;
  const app = Fastify();
  registerCsapi(app, {
    backend,
    config: {
      enabled: true,
      apiKeys: new Set([KEY]),
      defaultModel: "auto",
      defaultWorkspaceId: "",
      maxConcurrencyPerKey: options?.maxConc ?? 8,
      runTimeoutMs: options?.runTimeoutMs ?? 5_000,
      allowWrites: false
    },
    pollIntervalMs: 10
  });
  return { app, backend };
}

async function closeApp(app: FastifyInstance) {
  await app.close();
}

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
  assert.match(payload, /event: message_start/);
  assert.match(payload, /event: content_block_delta/);
  assert.match(payload, /streamme/);
  assert.match(payload, /event: message_stop/);
  await closeApp(app);
});

test("OpenAI /v1/chat/completions non-stream returns standard shape", async () => {
  const { app } = buildApp({ finishDelayMs: 30 });
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
  assert.match(body.choices[0].message.content, /echo:.*ping/);
  assert.equal(body.choices[0].finish_reason, "stop");
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
  assert.match(payload, /chat\.completion\.chunk/);
  assert.match(payload, /hey/);
  assert.match(payload, /data: \[DONE\]/);
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

test("run timeout maps to 504 and cancels the run", async () => {
  const { app, backend } = buildApp({ runTimeoutMs: 40, finishDelayMs: 10_000 });
  const res = await app.inject({
    method: "POST",
    url: "/v1/messages",
    headers: { "x-api-key": KEY },
    payload: { model: "auto", messages: [{ role: "user", content: "slow" }] }
  });
  assert.equal(res.statusCode, 504);
  assert.ok(backend.cancelCount >= 1);
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
      maxConcurrencyPerKey: 8,
      runTimeoutMs: 10_000,
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
