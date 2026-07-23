import assert from "node:assert/strict";
import test from "node:test";
import { e2eeRunRequestEnvelopeSchema } from "@cursor-gateway/shared";

const databaseUrl = process.env.TEST_DATABASE_URL;

test(
  "Postgres stores E2EE runs without plaintext and enforces the canary constraint",
  { skip: !databaseUrl },
  async () => {
    process.env.NODE_ENV = "test";
    process.env.PUBLIC_ORIGIN = "https://gateway.test";
    process.env.JWT_SECRET = "j".repeat(32);
    process.env.DATABASE_URL = databaseUrl;
    process.env.RUNNER_SHARED_SECRET = "r".repeat(32);

    const { migrate, pool } = await import("../src/db.js");
    const { createE2eeRun } = await import("../src/e2eeDb.js");
    await migrate();

    const userId = globalThis.crypto.randomUUID();
    const conversationId = globalThis.crypto.randomUUID();
    const runId = globalThis.crypto.randomUUID();
    const workspaceId = `ws-test-${runId.slice(0, 8)}`;
    const sentinel = `e2ee-canary-${globalThis.crypto.randomUUID()}`;

    try {
      await pool.query(
        `
          insert into app_users (id, email, role)
          values ($1, $2, 'admin')
        `,
        [userId, `${userId}@example.test`]
      );
      await pool.query(
        `
          insert into workspaces (id, label, path, writable, runner_id)
          values ($1, 'E2EE test', null, false, 'runner-test')
        `,
        [workspaceId]
      );

      const request = e2eeRunRequestEnvelopeSchema.parse({
        protocol: "cg-e2ee/1",
        kind: "run-request",
        messageId: runId,
        runId,
        conversationId,
        clientId: "client-test-db",
        clientKeyId: "client-key-test",
        runnerId: "runner-test",
        runnerKeyId: "runner-key-test",
        sequence: 1,
        createdAt: new Date().toISOString(),
        routing: {
          model: "test-model",
          workspaceId,
          allowWrites: false,
          memoryEnabled: true
        },
        previousDigest: null,
        wrappedConversationKey: {
          alg: "HPKE-v1-P256-HKDF-SHA256-A256GCM",
          enc: "A".repeat(87),
          ciphertext: "B".repeat(64)
        },
        title: null,
        payload: {
          alg: "A256GCM",
          nonce: "C".repeat(16),
          ciphertext: "D".repeat(128)
        },
        signature: {
          alg: "ES256",
          keyId: "client-key-test",
          value: "E".repeat(86)
        }
      });
      await createE2eeRun({ userId, request });

      const stored = await pool.query(
        `
          select prompt, response, error, progress, input_tokens, output_tokens,
                 request_envelope::text as envelope
          from runs
          where id = $1
        `,
        [runId]
      );
      assert.equal(stored.rows[0]?.prompt, null);
      assert.equal(stored.rows[0]?.response, null);
      assert.equal(stored.rows[0]?.error, null);
      assert.equal(stored.rows[0]?.progress, null);
      assert.equal(stored.rows[0]?.input_tokens, null);
      assert.equal(stored.rows[0]?.output_tokens, null);
      assert.equal(JSON.stringify(stored.rows[0]).includes(sentinel), false);

      await assert.rejects(
        pool.query("update runs set prompt = $2 where id = $1", [runId, sentinel]),
        /runs_e2ee_plaintext_empty/
      );
    } finally {
      await pool.query("delete from runs where id = $1", [runId]);
      await pool.query("delete from conversations where id = $1", [conversationId]);
      await pool.query("delete from workspaces where id = $1", [workspaceId]);
      await pool.query("delete from app_users where id = $1", [userId]);
      await pool.end();
    }
  }
);
