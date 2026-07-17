/**
 * relay-P3 sync bus contract: Redis pub/sub must carry ONLY
 * accountId/conversationId/sequence — never message content.
 * Requires TEST_REDIS_URL (skipped otherwise).
 */
import assert from "node:assert/strict";
import test from "node:test";

const redisUrl = process.env.TEST_REDIS_URL;

test("sync notify carries only account/conversation/sequence", { skip: !redisUrl }, async () => {
  process.env.REDIS_URL = redisUrl!;
  process.env.JWT_SECRET ??= "test-jwt-secret-that-is-at-least-32-chars";
  process.env.DATABASE_URL ??= "postgres://localhost:5432/verify";
  process.env.RUNNER_SHARED_SECRET ??= "test-runner-shared-secret-32-chars!!";

  const { publishSyncNotify, subscribeSyncAccount, closeSyncBus } = await import(
    "../src/csapi/syncBus.js"
  );

  const accountId = `sync-test-${crypto.randomUUID()}`;
  const conversationId = crypto.randomUUID();
  const received: Array<Record<string, unknown>> = [];

  const unsubscribe = await subscribeSyncAccount(accountId, (payload) => {
    received.push(payload as unknown as Record<string, unknown>);
  });

  // Inject forbidden fields; the bus must strip them on both ends.
  await publishSyncNotify({
    accountId,
    conversationId,
    sequence: 7,
    // @ts-expect-error deliberately smuggle content to prove it is dropped
    content: "PLAINTEXT_MUST_NOT_TRAVEL",
    // @ts-expect-error deliberately smuggle text to prove it is dropped
    text: "SECRET_BODY"
  });

  // Wait for the subscriber to observe the message.
  const deadline = Date.now() + 5000;
  while (received.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }

  unsubscribe();
  await closeSyncBus();

  assert.equal(received.length, 1, "subscriber should receive exactly one notify");
  const got = received[0]!;
  assert.deepEqual(Object.keys(got).sort(), ["accountId", "conversationId", "sequence"]);
  assert.equal(got.accountId, accountId);
  assert.equal(got.conversationId, conversationId);
  assert.equal(got.sequence, 7);
  assert.equal("content" in got, false);
  assert.equal("text" in got, false);
});
