import assert from "node:assert/strict";
import test from "node:test";
import {
  E2EE_PROTOCOL,
  E2EE_RUNNER_CODE_PAIRING_KIND,
  type E2eeKeyDescriptor,
  type E2eeRunnerCodePairingOffer,
  type E2eeRunnerIdentityCert
} from "@cursor-gateway/shared";
import {
  createKeyDescriptor,
  generateHpkeKeyPair,
  generatePairingChallenge,
  generateSigningKeyPair,
  generateTrustRootKeyPair,
  issueRunnerIdentityCert
} from "@cursor-gateway/e2ee";

const databaseUrl = process.env.TEST_DATABASE_URL;

function b64(n: number, ch: string) {
  return ch.repeat(n);
}

function dummySig(keyId: string) {
  return { alg: "ES256" as const, keyId, value: b64(86, "s") };
}

async function fixtures() {
  const root = await generateTrustRootKeyPair(1);
  const signing = await generateSigningKeyPair();
  const encryption = await generateHpkeKeyPair();
  const [signingKey, encryptionKey] = await Promise.all([
    createKeyDescriptor(signing.publicKey),
    createKeyDescriptor(encryption.publicKey)
  ]);
  const cert = await issueRunnerIdentityCert({
    rootPrivateKey: root.privateKey,
    rootPublic: root.public,
    runnerId: "runner-code-test",
    encryptionKey,
    signingKey,
    allowedSecureOrigins: ["https://secure.example.com"],
    allowedRpIds: ["secure.example.com"]
  });
  return { signingKey, encryptionKey, cert };
}

function sampleStart(enrollId: string, clientId: string, keys: {
  signingKey: E2eeKeyDescriptor;
  encryptionKey: E2eeKeyDescriptor;
}) {
  return {
    protocol: E2EE_PROTOCOL,
    pairingKind: E2EE_RUNNER_CODE_PAIRING_KIND,
    enrollId,
    clientId,
    clientChallenge: b64(43, "C"),
    signingKey: keys.signingKey,
    encryptionKey: keys.encryptionKey,
    label: "test-device",
    secureOrigin: "https://secure.example.com",
    gatewayOrigin: "https://gateway.example.com",
    createdAt: new Date().toISOString()
  };
}

function sampleOffer(input: {
  enrollId: string;
  clientId: string;
  runnerId: string;
  clientKeys: { signingKey: E2eeKeyDescriptor; encryptionKey: E2eeKeyDescriptor };
  runnerKeys: { signingKey: E2eeKeyDescriptor; encryptionKey: E2eeKeyDescriptor; cert: E2eeRunnerIdentityCert };
}): E2eeRunnerCodePairingOffer {
  return {
    protocol: E2EE_PROTOCOL,
    pairingKind: E2EE_RUNNER_CODE_PAIRING_KIND,
    enrollId: input.enrollId,
    runnerId: input.runnerId,
    serverNonce: generatePairingChallenge(),
    runnerChallenge: generatePairingChallenge(),
    runnerEncryptionKey: input.runnerKeys.encryptionKey,
    runnerSigningKey: input.runnerKeys.signingKey,
    runnerCertificate: input.runnerKeys.cert,
    clientId: input.clientId,
    clientChallenge: b64(43, "C"),
    clientSigningFingerprint: input.clientKeys.signingKey.fingerprint,
    clientEncryptionFingerprint: input.clientKeys.encryptionKey.fingerprint,
    secureOrigin: "https://secure.example.com",
    gatewayOrigin: "https://gateway.example.com",
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    createdAt: new Date().toISOString()
  };
}

function sampleConfirm(enrollId: string, clientId: string, keyId: string) {
  return {
    protocol: E2EE_PROTOCOL,
    pairingKind: E2EE_RUNNER_CODE_PAIRING_KIND,
    enrollId,
    clientId,
    transcriptMac: b64(43, "m"),
    sas: ["alpha", "bravo", "cedar", "delta", "eagle", "ferry"],
    signature: dummySig(keyId),
    createdAt: new Date().toISOString()
  };
}

function sampleAck(input: {
  enrollId: string;
  clientId: string;
  runnerId: string;
  status: "paired" | "rejected";
  reason?: string;
  runnerKeys: { signingKey: E2eeKeyDescriptor; encryptionKey: E2eeKeyDescriptor; cert: E2eeRunnerIdentityCert };
}) {
  return {
    protocol: E2EE_PROTOCOL,
    pairingKind: E2EE_RUNNER_CODE_PAIRING_KIND,
    enrollId: input.enrollId,
    clientId: input.clientId,
    runnerId: input.runnerId,
    status: input.status,
    ...(input.reason ? { reason: input.reason } : {}),
    runnerEncryptionKey: input.runnerKeys.encryptionKey,
    runnerSigningKey: input.runnerKeys.signingKey,
    runnerCertificate: input.runnerKeys.cert,
    createdAt: new Date().toISOString(),
    signature: dummySig(input.runnerKeys.signingKey.keyId)
  };
}

function setEnv() {
  process.env.NODE_ENV = "test";
  process.env.PUBLIC_ORIGIN = "https://gateway.test";
  process.env.JWT_SECRET = "j".repeat(32);
  process.env.DATABASE_URL = databaseUrl!;
  process.env.RUNNER_SHARED_SECRET = "r".repeat(32);
}

test("RAMC server-flow acceptance", { skip: !databaseUrl }, async (t) => {
  setEnv();
  const { migrate, pool } = await import("../src/db.js");
  const db = await import("../src/runnerCodeEnrollDb.js");
  await migrate();

  try {
    await t.test("happy path pairs the device and writes e2ee_devices", async () => {
      const keys = await fixtures();
      const runnerKeys = await fixtures();
      const userId = globalThis.crypto.randomUUID();
      const enrollId = globalThis.crypto.randomUUID();
      const clientId = `client-${enrollId.slice(0, 8)}`;
      const runnerId = "runner-code-test-happy";
      try {
        await pool.query(`insert into app_users (id, email, role) values ($1,$2,'admin')`, [userId, `u-${userId.slice(0, 8)}@ex.com`]);
        await db.createRunnerCodeStart({ userId, email: "u@ex.com", start: sampleStart(enrollId, clientId, keys), ttlSeconds: 300, maxAttempts: 3 });
        const claimed = await db.claimNextRunnerCodeStart({ runnerId });
        assert.equal(claimed?.enrollId, enrollId);
        await db.publishRunnerCodeOffer({ runnerId, offer: sampleOffer({ enrollId, clientId, runnerId, clientKeys: keys, runnerKeys }) });
        await db.submitRunnerCodeConfirm({ userId, confirm: sampleConfirm(enrollId, clientId, keys.signingKey.keyId) });
        const claimConfirm = await db.claimNextRunnerCodeConfirm({ runnerId });
        assert.equal(claimConfirm?.status, "confirm_submitted");
        const acked = await db.publishRunnerCodeAck({ runnerId, ack: sampleAck({ enrollId, clientId, runnerId, status: "paired", runnerKeys }) });
        assert.equal(acked.status, "paired");
        const device = await pool.query(`select * from e2ee_devices where client_id = $1`, [clientId]);
        assert.equal(device.rowCount, 1);
        assert.equal(device.rows[0].user_id, userId);
        // Replay: confirm after paired is rejected.
        await assert.rejects(
          db.submitRunnerCodeConfirm({ userId, confirm: sampleConfirm(enrollId, clientId, keys.signingKey.keyId) }),
          /enrollment_status_invalid/
        );
        // Cross-account isolation.
        assert.equal(await db.getRunnerCodeForUser(enrollId, globalThis.crypto.randomUUID()), undefined);
      } finally {
        await pool.query(`delete from e2ee_devices where client_id = $1`, [clientId]);
        await pool.query(`delete from e2ee_runner_code_enrollments where enroll_id = $1`, [enrollId]);
        await pool.query(`delete from app_users where id = $1`, [userId]);
      }
    });

    await t.test("locks after 3 bad-code attempts", async () => {
      const keys = await fixtures();
      const runnerKeys = await fixtures();
      const userId = globalThis.crypto.randomUUID();
      const enrollId = globalThis.crypto.randomUUID();
      const clientId = `client-${enrollId.slice(0, 8)}`;
      const runnerId = "runner-code-test-lock";
      try {
        await pool.query(`insert into app_users (id, email, role) values ($1,$2,'admin')`, [userId, `u-${userId.slice(0, 8)}@ex.com`]);
        await db.createRunnerCodeStart({ userId, email: "u@ex.com", start: sampleStart(enrollId, clientId, keys), ttlSeconds: 300, maxAttempts: 3 });
        await db.claimNextRunnerCodeStart({ runnerId });
        await db.publishRunnerCodeOffer({ runnerId, offer: sampleOffer({ enrollId, clientId, runnerId, clientKeys: keys, runnerKeys }) });
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          await db.submitRunnerCodeConfirm({ userId, confirm: sampleConfirm(enrollId, clientId, keys.signingKey.keyId) });
          const row = await db.publishRunnerCodeAck({ runnerId, ack: sampleAck({ enrollId, clientId, runnerId, status: "rejected", reason: "code_mismatch", runnerKeys }) });
          assert.equal(row.status, attempt < 3 ? "offered" : "locked");
        }
        await assert.rejects(
          db.submitRunnerCodeConfirm({ userId, confirm: sampleConfirm(enrollId, clientId, keys.signingKey.keyId) }),
          /enrollment_locked/
        );
      } finally {
        await pool.query(`delete from e2ee_runner_code_enrollments where enroll_id = $1`, [enrollId]);
        await pool.query(`delete from app_users where id = $1`, [userId]);
      }
    });

    await t.test("expiry sweeps to expired and is not claimable", async () => {
      const keys = await fixtures();
      const userId = globalThis.crypto.randomUUID();
      const enrollId = globalThis.crypto.randomUUID();
      const clientId = `client-${enrollId.slice(0, 8)}`;
      const runnerId = "runner-code-test-expire";
      try {
        await pool.query(`insert into app_users (id, email, role) values ($1,$2,'admin')`, [userId, `u-${userId.slice(0, 8)}@ex.com`]);
        await db.createRunnerCodeStart({ userId, email: "u@ex.com", start: sampleStart(enrollId, clientId, keys), ttlSeconds: 1, maxAttempts: 3 });
        await pool.query(`update e2ee_runner_code_enrollments set expires_at = now() - interval '1 second' where enroll_id = $1`, [enrollId]);
        assert.equal(await db.claimNextRunnerCodeStart({ runnerId }), undefined);
        const row = await db.getRunnerCodeForUser(enrollId, userId);
        assert.equal(row?.status, "expired");
      } finally {
        await pool.query(`delete from e2ee_runner_code_enrollments where enroll_id = $1`, [enrollId]);
        await pool.query(`delete from app_users where id = $1`, [userId]);
      }
    });

    await t.test("runner mismatch on offer is rejected", async () => {
      const keys = await fixtures();
      const runnerKeys = await fixtures();
      const userId = globalThis.crypto.randomUUID();
      const enrollId = globalThis.crypto.randomUUID();
      const clientId = `client-${enrollId.slice(0, 8)}`;
      try {
        await pool.query(`insert into app_users (id, email, role) values ($1,$2,'admin')`, [userId, `u-${userId.slice(0, 8)}@ex.com`]);
        await db.createRunnerCodeStart({ userId, email: "u@ex.com", start: sampleStart(enrollId, clientId, keys), ttlSeconds: 300, maxAttempts: 3 });
        await db.claimNextRunnerCodeStart({ runnerId: "runner-a" });
        await assert.rejects(
          db.publishRunnerCodeOffer({ runnerId: "runner-b", offer: sampleOffer({ enrollId, clientId, runnerId: "runner-b", clientKeys: keys, runnerKeys }) }),
          /enrollment_runner_mismatch/
        );
      } finally {
        await pool.query(`delete from e2ee_runner_code_enrollments where enroll_id = $1`, [enrollId]);
        await pool.query(`delete from app_users where id = $1`, [userId]);
      }
    });
  } finally {
    await pool.end();
  }
});
