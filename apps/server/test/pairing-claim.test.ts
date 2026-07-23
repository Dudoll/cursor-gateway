import assert from "node:assert/strict";
import test from "node:test";
import {
  assertTrustedRecipientEmail,
  maskEmailHint,
  recipientEmailFingerprint
} from "../src/pairingRecipient.js";

test("assertTrustedRecipientEmail accepts normal addresses", () => {
  assert.equal(assertTrustedRecipientEmail("Ops@Example.COM"), "ops@example.com");
  assert.equal(assertTrustedRecipientEmail(" a.b+c@sub.example.com "), "a.b+c@sub.example.com");
});

test("assertTrustedRecipientEmail rejects missing/illegal values", () => {
  assert.throws(() => assertTrustedRecipientEmail(undefined), /recipient_email_missing/);
  assert.throws(() => assertTrustedRecipientEmail(""), /recipient_email_missing/);
  assert.throws(() => assertTrustedRecipientEmail("not-an-email"), /recipient_email_invalid/);
  assert.throws(() => assertTrustedRecipientEmail("a@b"), /recipient_email_invalid/);
  assert.throws(
    () => assertTrustedRecipientEmail("evil@example.com\r\nBcc:x@y.com"),
    /recipient_email_injection/
  );
});

test("recipient fingerprint is stable and does not embed the email", () => {
  const a = recipientEmailFingerprint("user@example.com");
  const b = recipientEmailFingerprint("user@example.com");
  const c = recipientEmailFingerprint("other@example.com");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(a.includes("@"), false);
  assert.equal(a.includes("user"), false);
});

test("maskEmailHint hides local-part", () => {
  assert.equal(maskEmailHint("joel@example.com"), "j***@example.com");
});

function sampleStart(pairId: string, clientId: string) {
  const b64 = (n: number, ch: string) => ch.repeat(n);
  return {
    protocol: "cg-e2ee/1" as const,
    pairingKind: "secure-web-magic-link/1" as const,
    pairId,
    clientId,
    clientChallenge: b64(43, "C"),
    signingKey: {
      keyId: "signing-key-1",
      fingerprint: `sha256:${b64(43, "A")}`,
      publicKey: { kty: "EC" as const, crv: "P-256" as const, x: b64(43, "x"), y: b64(43, "y") }
    },
    encryptionKey: {
      keyId: "encrypt-key-1",
      fingerprint: `sha256:${b64(43, "B")}`,
      publicKey: { kty: "EC" as const, crv: "P-256" as const, x: b64(43, "u"), y: b64(43, "v") }
    },
    secureOrigin: "https://secure.example.com",
    gatewayOrigin: "https://gateway.example.com",
    createdAt: new Date().toISOString()
  };
}

const databaseUrl = process.env.TEST_DATABASE_URL;

test(
  "claim-start returns Access-bound recipientEmail and ignores client envelope email fields",
  { skip: !databaseUrl },
  async () => {
    process.env.NODE_ENV = "test";
    process.env.PUBLIC_ORIGIN = "https://gateway.test";
    process.env.JWT_SECRET = "j".repeat(32);
    process.env.DATABASE_URL = databaseUrl;
    process.env.RUNNER_SHARED_SECRET = "r".repeat(32);

    const { migrate, pool } = await import("../src/db.js");
    const { createPairingStart, claimNextPairingStart } = await import("../src/pairingDb.js");
    await migrate();

    const userId = globalThis.crypto.randomUUID();
    const pairId = globalThis.crypto.randomUUID();
    const trustedEmail = `trusted-${userId.slice(0, 8)}@access.example`;
    const runnerId = "runner-pairing-claim-test";

    try {
      await pool.query(
        `insert into app_users (id, email, role) values ($1, $2, 'admin')`,
        [userId, trustedEmail]
      );

      await createPairingStart({
        userId,
        start: sampleStart(pairId, "client-claim-test"),
        ttlSeconds: 900
      });

      // Plant forged recipient fields in stored JSON; claim must still use app_users.email.
      await pool.query(
        `
          update e2ee_pairings
          set start_envelope = start_envelope || '{"email":"forged@evil.example","recipientEmail":"forged@evil.example"}'::jsonb
          where pair_id = $1
        `,
        [pairId]
      );

      const claimed = await claimNextPairingStart({ runnerId });
      assert.ok(claimed);
      assert.equal(claimed.pairId, pairId);
      assert.equal(claimed.recipientEmail, trustedEmail);
      assert.notEqual(claimed.recipientEmail, "forged@evil.example");
      assert.equal("email" in claimed.start, false);
      assert.equal("recipientEmail" in claimed.start, false);
    } finally {
      await pool.query("delete from e2ee_pairings where pair_id = $1", [pairId]);
      await pool.query("delete from app_users where id = $1", [userId]);
      await pool.end();
    }
  }
);

test(
  "claim-start rejects pairings whose app_users.email is missing or illegal",
  { skip: !databaseUrl },
  async () => {
    process.env.NODE_ENV = "test";
    process.env.PUBLIC_ORIGIN = "https://gateway.test";
    process.env.JWT_SECRET = "j".repeat(32);
    process.env.DATABASE_URL = databaseUrl;
    process.env.RUNNER_SHARED_SECRET = "r".repeat(32);

    const { migrate, pool } = await import("../src/db.js");
    const { createPairingStart, claimNextPairingStart, getPairingForUser } = await import(
      "../src/pairingDb.js"
    );
    await migrate();

    const userId = globalThis.crypto.randomUUID();
    const pairId = globalThis.crypto.randomUUID();
    const runnerId = "runner-pairing-bad-email";

    try {
      await pool.query(
        `insert into app_users (id, email, role) values ($1, $2, 'admin')`,
        [userId, "temp-valid@example.com"]
      );

      await createPairingStart({
        userId,
        start: sampleStart(pairId, "client-bad-email"),
        ttlSeconds: 900
      });
      await pool.query("update app_users set email = $2 where id = $1", [userId, "not-an-email"]);

      const claimed = await claimNextPairingStart({ runnerId });
      assert.equal(claimed, undefined);
      const row = await getPairingForUser(pairId, userId);
      assert.equal(row?.status, "rejected");
    } finally {
      await pool.query("delete from e2ee_pairings where pair_id = $1", [pairId]);
      await pool.query("delete from app_users where id = $1", [userId]);
      await pool.end();
    }
  }
);
