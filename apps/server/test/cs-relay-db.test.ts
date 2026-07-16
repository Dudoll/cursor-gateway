/**
 * Integration tests for cg_devices + cs_relay history (requires TEST_DATABASE_URL).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { MemoryKmsProvider, issueCgDeviceCertV2, createKeyDescriptor, generateHpkeKeyPair, generateSigningKeyPair } from "@cursor-gateway/e2ee";

const databaseUrl = process.env.TEST_DATABASE_URL;

test("cg_devices enroll/revoke + relay history isolation", { skip: !databaseUrl }, async () => {
  process.env.DATABASE_URL = databaseUrl!;
  process.env.JWT_SECRET ??= "test-jwt-secret-that-is-at-least-32-chars";
  process.env.RUNNER_SHARED_SECRET ??= "test-runner-shared-secret-32-chars!!";

  const { migrate, pool } = await import("../src/db.js");
  await migrate();

  const { upsertCgDevice, revokeCgDevice, getCgDevice, CgDeviceStatusCache } = await import(
    "../src/cgDevicesDb.js"
  );
  const {
    appendRelayMessage,
    listRelayMessages,
    ensureRelayConversation
  } = await import("../src/csRelayHistory.js");

  const accountA = `test-account-a-${crypto.randomUUID()}`;
  const accountB = `test-account-b-${crypto.randomUUID()}`;
  const kms = new MemoryKmsProvider("test-db-kms");

  const [hpke, signing] = await Promise.all([generateHpkeKeyPair(), generateSigningKeyPair()]);
  const [hpkeKey, signingKey] = await Promise.all([
    createKeyDescriptor(hpke.publicKey),
    createKeyDescriptor(signing.publicKey)
  ]);
  const serverSigning = await generateSigningKeyPair();
  const serverSigningKey = await createKeyDescriptor(serverSigning.publicKey);

  const deviceId = crypto.randomUUID();
  const cert = await issueCgDeviceCertV2({
    signingPrivateKey: serverSigning.privateKey,
    signingKeyId: serverSigningKey.keyId,
    accountId: accountA,
    deviceId,
    signingKey,
    encryptionKey: hpkeKey,
    keyIdHint: accountA,
    serverCertId: crypto.randomUUID()
  });
  await upsertCgDevice({
    deviceId,
    accountId: accountA,
    signingFingerprint: signingKey.fingerprint,
    encryptionFingerprint: hpkeKey.fingerprint,
    deviceCert: cert,
    epoch: 1,
    label: "test-device"
  });

  const cache = new CgDeviceStatusCache(1_000);
  const active = await cache.requireActive(deviceId);
  assert.equal(active.accountId, accountA);

  // Create a service user + workspace for conversation FK
  const user = await pool.query(
    `insert into app_users (email, role) values ($1, 'operator')
     on conflict (email) do update set updated_at = now()
     returning id`,
    [`relay-${crypto.randomUUID()}@example.com`]
  );
  const userId = String(user.rows[0]!.id);
  await pool.query(
    `insert into workspaces (id, label, path, writable, enabled)
     values ('ws-relay-test', 'Relay Test', '/tmp', false, true)
     on conflict (id) do nothing`
  );

  const { conversationId } = await ensureRelayConversation({
    kms,
    accountId: accountA,
    workspaceId: "ws-relay-test",
    userId,
    title: "hello"
  });

  await appendRelayMessage({
    kms,
    accountId: accountA,
    conversationId,
    role: "user",
    text: "PROMPT_SECRET_TOKEN_AAA",
    idempotencyKey: crypto.randomUUID()
  });
  await appendRelayMessage({
    kms,
    accountId: accountA,
    conversationId,
    role: "assistant",
    text: "RESPONSE_SECRET_TOKEN_BBB"
  });

  const page = await listRelayMessages({
    kms,
    accountId: accountA,
    conversationId,
    limit: 50
  });
  assert.equal(page.messages.length, 2);
  assert.equal(page.messages[0]!.content, "PROMPT_SECRET_TOKEN_AAA");

  // Cross-account denied
  await assert.rejects(
    () =>
      listRelayMessages({
        kms,
        accountId: accountB,
        conversationId,
        limit: 10
      }),
    /cross_account_denied/
  );

  // DB must not contain plaintext secrets
  const dump = await pool.query(
    `select content_ciphertext::text as ct, wrapped_dek::text as dek
     from cs_relay_messages m
     join conversations c on c.id = m.conversation_id
     where m.conversation_id = $1`,
    [conversationId]
  );
  const blob = JSON.stringify(dump.rows);
  assert.equal(blob.includes("PROMPT_SECRET_TOKEN_AAA"), false);
  assert.equal(blob.includes("RESPONSE_SECRET_TOKEN_BBB"), false);

  await revokeCgDevice({ accountId: accountA, targetDeviceId: deviceId });
  cache.invalidate(deviceId);
  const revoked = await getCgDevice(deviceId);
  assert.equal(revoked?.status, "revoked");
  await assert.rejects(() => cache.requireActive(deviceId), /device_revoked/);

  await pool.query(`delete from cs_relay_messages where conversation_id = $1`, [conversationId]);
  await pool.query(`delete from conversations where id = $1`, [conversationId]);
  await pool.query(`delete from cg_devices where device_id = $1`, [deviceId]);
  await pool.query(`delete from account_keks where account_id = $1`, [accountA]);
});
