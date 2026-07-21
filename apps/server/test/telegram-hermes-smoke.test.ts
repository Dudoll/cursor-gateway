/**
 * Telegram → Hermes → CSAPI → fake runner scenario matrix (CI-safe).
 * Real Bot API path lives in scripts/diagnostics/telegram-real-smoke.mjs and is skipped unless TELEGRAM_SMOKE=1.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  TELEGRAM_MESSAGE_LIMIT,
  buildSmokeStack,
  closeSmokeStack
} from "./helpers/telegramSmokeHarness.js";

test("S1 cold start: first Telegram message returns typing + reply via CSAPI", async () => {
  const { app, backend, bot, bridge } = buildSmokeStack({ finishDelayMs: 25, heartbeatIntervalMs: 5 });
  const result = await bridge.handleUserMessage({ chatId: "chat-cold", text: "contract-ping" });

  assert.equal(result.statusCode, 200);
  assert.equal(bot.typingCount("chat-cold"), 1);
  assert.equal(bot.events[0]?.kind, "typing");
  assert.match(result.replyTexts.join(""), /contract-ping/);
  assert.equal(backend.createConversationCount, 1);
  assert.equal(backend.createRunCount, 1);
  await closeSmokeStack(app);
});

test("S2 same chat follow-up reuses conversation and sends only latest turn", async () => {
  const { app, backend, bridge } = buildSmokeStack({ finishDelayMs: 20 });
  const first = await bridge.handleUserMessage({ chatId: "chat-follow", text: "first-turn" });
  const second = await bridge.handleUserMessage({ chatId: "chat-follow", text: "second-turn" });

  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal(backend.createConversationCount, 1);
  assert.equal(backend.createRunCount, 2);
  assert.match(backend.prompts[0] ?? "", /first-turn/);
  assert.equal(backend.prompts[1], "second-turn");
  assert.ok(
    (backend.prompts[1]?.length ?? Infinity) < (backend.prompts[0]?.length ?? 0),
    "continued turn must not resend the first-turn transcript"
  );
  await closeSmokeStack(app);
});

test("S3 cross-chat parallelism creates distinct conversations", async () => {
  const { app, backend, bridge } = buildSmokeStack({ finishDelayMs: 80 });
  const results = await Promise.all([
    bridge.handleUserMessage({ chatId: "chat-a", text: "parallel-a" }),
    bridge.handleUserMessage({ chatId: "chat-b", text: "parallel-b" }),
    bridge.handleUserMessage({ chatId: "chat-c", text: "parallel-c" })
  ]);
  for (const result of results) assert.equal(result.statusCode, 200);
  assert.equal(backend.createConversationCount, 3);
  assert.ok(
    backend.maxDistinctConversationsConcurrent >= 2,
    `expected parallel chats, saw ${backend.maxDistinctConversationsConcurrent}`
  );
  await closeSmokeStack(app);
});

test("S4 short ask stays small; controlled long context is truncated", async () => {
  const { app, backend, bridge } = buildSmokeStack({ finishDelayMs: 15, maxPromptChars: 1_024 });
  const short = await bridge.handleUserMessage({ chatId: "chat-short", text: "ping" });
  assert.equal(short.statusCode, 200);
  const shortChars = backend.lastRunPrompt?.length ?? Infinity;
  assert.ok(shortChars < 200, `short prompt should stay compact, saw ${shortChars}`);

  // Direct CSAPI inject with huge history (session-first path) to assert truncation.
  const long = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: {
      authorization: "Bearer telegram-smoke-csapi-key",
      "x-session-id": "hermes:telegram:chat-long-context"
    },
    payload: {
      model: "auto",
      stream: false,
      messages: [
        { role: "system", content: `system-${"s".repeat(2_000)}` },
        { role: "user", content: `old-${"x".repeat(5_000)}` },
        { role: "assistant", content: `reply-${"y".repeat(5_000)}` },
        { role: "user", content: "LATEST-CONTEXT-TURN" }
      ]
    }
  });
  assert.equal(long.statusCode, 200);
  assert.ok((backend.lastRunPrompt?.length ?? Infinity) <= 1_024);
  assert.match(backend.lastRunPrompt ?? "", /LATEST-CONTEXT-TURN/);
  assert.match(backend.lastRunPrompt ?? "", /Earlier context truncated/);
  await closeSmokeStack(app);
});

test("S5 timeout cancels run and surfaces a visible failure", async () => {
  const { app, backend, bot, bridge } = buildSmokeStack({
    idleTimeoutMs: 35,
    finishDelayMs: 10_000
  });
  // Non-stream so HTTP status reflects 504 (stream hijacks 200 before execute ends).
  const result = await bridge.handleUserMessage({
    chatId: "chat-timeout",
    text: "slow-please",
    stream: false
  });
  assert.equal(result.statusCode, 504);
  assert.ok(backend.cancelCount >= 1);
  assert.ok(bot.events.some((event) => event.kind === "error" && event.chatId === "chat-timeout"));
  await closeSmokeStack(app);
});

test("S6 timeout/cancel path releases runner work (cancelCount >= 1)", async () => {
  const { app, backend, bot, bridge } = buildSmokeStack({
    finishDelayMs: 10_000,
    idleTimeoutMs: 30
  });
  const timed = await bridge.handleUserMessage({
    chatId: "chat-abort",
    text: "hold",
    stream: false
  });
  assert.equal(timed.statusCode, 504);
  assert.ok(backend.cancelCount >= 1);
  assert.ok(bot.events.some((event) => event.kind === "error" && event.chatId === "chat-abort"));
  await closeSmokeStack(app);
});

test("S7 backpressure returns explicit 429 (no silent hang)", async () => {
  const { app, bot, bridge } = buildSmokeStack({ maxConc: 1, finishDelayMs: 120 });
  const [a, b] = await Promise.all([
    bridge.handleUserMessage({ chatId: "bp-1", text: "one" }),
    bridge.handleUserMessage({ chatId: "bp-2", text: "two" })
  ]);
  const codes = [a.statusCode, b.statusCode].sort((x, y) => x - y);
  assert.deepEqual(codes, [200, 429]);
  const limited = a.statusCode === 429 ? a : b;
  assert.equal(limited.response?.headers["retry-after"], "1");
  assert.ok(bot.events.some((event) => event.kind === "error" && /429/.test(event.text)));
  await closeSmokeStack(app);
});

test("S8 long reply is chunked for Telegram without content loss", async () => {
  const { app, bot, bridge } = buildSmokeStack({ finishDelayMs: 15 });
  const source = `LONG-REPLY-${"x".repeat(9_000)}`;
  const result = await bridge.handleUserMessage({ chatId: "chat-long-reply", text: source });
  assert.equal(result.statusCode, 200);
  assert.ok(result.replyTexts.length >= 3);
  assert.ok(result.replyTexts.every((chunk) => chunk.length <= TELEGRAM_MESSAGE_LIMIT));
  assert.equal(result.replyTexts.join(""), bot.messagesFor("chat-long-reply").map((m) => m.text).join(""));
  assert.match(result.replyTexts.join(""), /LONG-REPLY-/);
  await closeSmokeStack(app);
});

test("S9 gateway unreachable surfaces visible failure", async () => {
  const { app, bot, bridge } = buildSmokeStack({ finishDelayMs: 10 });
  const result = await bridge.handleUserMessage({
    chatId: "chat-down",
    text: "hello",
    forceGatewayDown: true
  });
  assert.equal(result.statusCode, 503);
  assert.ok(bot.events.some((event) => event.kind === "error" && /unreachable/.test(event.text)));
  await closeSmokeStack(app);
});

test("S10 runner busy / no workers maps to user-visible failure", async () => {
  const { app, backend, bot, bridge } = buildSmokeStack({ finishDelayMs: 10 });
  backend.busyReject = true;
  const result = await bridge.handleUserMessage({
    chatId: "chat-busy",
    text: "hello",
    stream: false
  });
  assert.ok(result.statusCode >= 400);
  assert.match(result.replyTexts.join(""), /workspace|runner/i);
  assert.ok(bot.events.some((event) => event.kind === "error"));
  await closeSmokeStack(app);
});

test("S11 unknown model falls back to default auto (no silent hang)", async () => {
  const { app, backend, bridge } = buildSmokeStack({ finishDelayMs: 15 });
  const result = await bridge.handleUserMessage({
    chatId: "chat-bad-model",
    text: "model-check",
    model: "definitely-not-a-real-model"
  });
  assert.equal(result.statusCode, 200);
  assert.equal(backend.lastRunModel, "auto");
  await closeSmokeStack(app);
});

test("S12 typing/ack visibility precedes first outbound message", async () => {
  const { app, bot, bridge } = buildSmokeStack({ finishDelayMs: 20, heartbeatIntervalMs: 5 });
  await bridge.handleUserMessage({ chatId: "chat-typing", text: "visible-ack" });
  const kinds = bot.events.filter((event) => event.chatId === "chat-typing").map((event) => event.kind);
  assert.equal(kinds[0], "typing");
  assert.ok(kinds.includes("message"));
  assert.ok(kinds.indexOf("typing") < kinds.indexOf("message"));
  await closeSmokeStack(app);
});

test("S13 Hermes session limit returns explicit error instead of queueing forever", async () => {
  const { app, bot, bridge } = buildSmokeStack({ finishDelayMs: 200, maxConcurrentSessions: 1 });
  // Hold one session open by starting a slow request, then hit the limit with another chat.
  const firstPromise = bridge.handleUserMessage({ chatId: "limit-1", text: "hold" });
  // Allow the first to mark itself active.
  await new Promise((resolve) => setImmediate(resolve));
  const second = await bridge.handleUserMessage({ chatId: "limit-2", text: "blocked" });
  assert.equal(second.statusCode, 429);
  assert.match(second.replyTexts.join(""), /active session limit/i);
  assert.ok(bot.events.some((event) => event.kind === "error" && event.chatId === "limit-2"));
  await firstPromise;
  await closeSmokeStack(app);
});

test("S14 stream heartbeats keep the first-byte path observable on slow runs", async () => {
  const { app } = buildSmokeStack({ finishDelayMs: 60, heartbeatIntervalMs: 10 });
  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: {
      authorization: "Bearer telegram-smoke-csapi-key",
      "x-session-id": "hermes:telegram:chat-heartbeat"
    },
    payload: {
      model: "auto",
      stream: true,
      messages: [{ role: "user", content: "slow stream" }]
    }
  });
  const heartbeatCount = (response.payload.match(/chatcmpl-heartbeat/g) ?? []).length;
  assert.ok(heartbeatCount >= 2, `expected heartbeats, saw ${heartbeatCount}`);
  await closeSmokeStack(app);
});
