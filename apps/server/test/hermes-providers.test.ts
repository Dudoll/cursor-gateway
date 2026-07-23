import assert from "node:assert/strict";
import test from "node:test";
import {
  HermesConcurrencyController,
  parseHermesProvider,
  resolveProviderOrThrow
} from "../src/hermesProviders.js";

test("parseHermesProvider accepts only known providers", () => {
  assert.equal(parseHermesProvider("csgateway"), "csgateway");
  assert.equal(parseHermesProvider("openai-codex"), "openai-codex");
  assert.equal(parseHermesProvider("deepseek"), "deepseek");
  assert.equal(parseHermesProvider("unknown"), undefined);
});

test("resolveProviderOrThrow is fail-closed (no auto-fallback)", () => {
  assert.equal(resolveProviderOrThrow(undefined, "csgateway"), "csgateway");
  assert.equal(resolveProviderOrThrow("deepseek", "csgateway"), "deepseek");
  assert.throws(() => resolveProviderOrThrow("gpt", "csgateway"), /unknown_provider/);
});

test("three distinct chats start in parallel; fourth queues", () => {
  const ctl = new HermesConcurrencyController(3, 30);
  assert.equal(ctl.admit({ chatId: "1", requestId: "a", provider: "csgateway", enqueuedAt: 1 }).status, "started");
  assert.equal(ctl.admit({ chatId: "2", requestId: "b", provider: "openai-codex", enqueuedAt: 2 }).status, "started");
  assert.equal(ctl.admit({ chatId: "3", requestId: "c", provider: "deepseek", enqueuedAt: 3 }).status, "started");
  const fourth = ctl.admit({ chatId: "4", requestId: "d", provider: "csgateway", enqueuedAt: 4 });
  assert.equal(fourth.status, "queued");
  assert.equal(ctl.activeCount(), 3);
  assert.equal(ctl.queueDepth(), 1);
});

test("same chat is serial; complete wakes next", () => {
  const ctl = new HermesConcurrencyController(3, 30);
  assert.equal(ctl.admit({ chatId: "1", requestId: "a", provider: "csgateway", enqueuedAt: 1 }).status, "started");
  const second = ctl.admit({ chatId: "1", requestId: "b", provider: "csgateway", enqueuedAt: 2 });
  assert.equal(second.status, "queued");
  const next = ctl.complete("1", "a");
  assert.ok(next);
  assert.equal(next.requestId, "b");
  assert.equal(ctl.isChatActive("1"), true);
});

test("queue rejects beyond maxQueue", () => {
  const ctl = new HermesConcurrencyController(1, 2);
  assert.equal(ctl.admit({ chatId: "1", requestId: "a", provider: "csgateway", enqueuedAt: 1 }).status, "started");
  assert.equal(ctl.admit({ chatId: "2", requestId: "b", provider: "csgateway", enqueuedAt: 2 }).status, "queued");
  assert.equal(ctl.admit({ chatId: "3", requestId: "c", provider: "csgateway", enqueuedAt: 3 }).status, "queued");
  const rejected = ctl.admit({ chatId: "4", requestId: "d", provider: "csgateway", enqueuedAt: 4 });
  assert.deepEqual(rejected, { status: "rejected", reason: "busy" });
});

test("duplicate requestId is rejected", () => {
  const ctl = new HermesConcurrencyController(3, 30);
  assert.equal(ctl.admit({ chatId: "1", requestId: "a", provider: "csgateway", enqueuedAt: 1 }).status, "started");
  assert.deepEqual(
    ctl.admit({ chatId: "2", requestId: "a", provider: "deepseek", enqueuedAt: 2 }),
    { status: "rejected", reason: "duplicate" }
  );
});
