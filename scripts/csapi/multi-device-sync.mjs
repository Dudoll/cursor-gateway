import { readFileSync } from "node:fs";
import { migrate, pool } from "../apps/server/dist/db.js";
import {
  FileMasterKeyProvider,
  issueCgDeviceCertV2,
  createKeyDescriptor,
  generateHpkeKeyPair,
  generateSigningKeyPair
} from "@cursor-gateway/e2ee";
import { upsertCgDevice, revokeCgDevice, CgDeviceStatusCache } from "../apps/server/dist/cgDevicesDb.js";
import {
  appendRelayMessage,
  ensureRelayConversation,
  listRelayMessages,
  listRelayConversations
} from "../apps/server/dist/csRelayHistory.js";

await migrate();
const master = readFileSync(process.env.CS_RELAY_MASTER_KEY_FILE, "utf8").trim();
const kms = new FileMasterKeyProvider("file-master-1", master);
const accountA = `md-a-${crypto.randomUUID()}`;
const accountB = `md-b-${crypto.randomUUID()}`;

const serverSigning = await generateSigningKeyPair();
const serverSigningKey = await createKeyDescriptor(serverSigning.publicKey);

async function enroll(accountId) {
  const [hpke, signing] = await Promise.all([generateHpkeKeyPair(), generateSigningKeyPair()]);
  const [hpkeKey, signingKey] = await Promise.all([
    createKeyDescriptor(hpke.publicKey),
    createKeyDescriptor(signing.publicKey)
  ]);
  const deviceId = crypto.randomUUID();
  const cert = await issueCgDeviceCertV2({
    signingPrivateKey: serverSigning.privateKey,
    signingKeyId: serverSigningKey.keyId,
    accountId,
    deviceId,
    signingKey,
    encryptionKey: hpkeKey,
    keyIdHint: accountId,
    serverCertId: crypto.randomUUID()
  });
  await upsertCgDevice({
    deviceId,
    accountId,
    signingFingerprint: signingKey.fingerprint,
    encryptionFingerprint: hpkeKey.fingerprint,
    deviceCert: cert,
    epoch: 1,
    label: "d"
  });
  return deviceId;
}

const d1 = await enroll(accountA);
const d2 = await enroll(accountA);
const d3 = await enroll(accountB);
const cache = new CgDeviceStatusCache(1000);
await cache.requireActive(d1);
await cache.requireActive(d2);

const user = await pool.query(
  `insert into app_users (email, role) values ($1,'operator') returning id`,
  [`md-${crypto.randomUUID()}@example.com`]
);
await pool.query(
  `insert into workspaces (id,label,path,writable,enabled) values ('ws-md','MD','/tmp',false,true) on conflict do nothing`
);
const { conversationId } = await ensureRelayConversation({
  kms, accountId: accountA, workspaceId: "ws-md", userId: String(user.rows[0].id)
});
await appendRelayMessage({ kms, accountId: accountA, conversationId, role: "user", text: "hello-from-d1", idempotencyKey: crypto.randomUUID() });
await appendRelayMessage({ kms, accountId: accountA, conversationId, role: "assistant", text: "reply" });

const page1 = await listRelayMessages({ kms, accountId: accountA, conversationId, limit: 50 });
const page2 = await listRelayMessages({ kms, accountId: accountA, conversationId, sinceSequence: 0, limit: 50 });
if (page1.messages.length !== 2 || page2.messages.length !== 2) throw new Error("sync_mismatch");
const list = await listRelayConversations({ accountId: accountA, limit: 20 });
if (!list.conversations.some((c) => c.id === conversationId)) throw new Error("list_missing");

let denied = false;
try {
  await listRelayMessages({ kms, accountId: accountB, conversationId, limit: 10 });
} catch (e) {
  denied = String(e.message).includes("cross_account_denied");
}
if (!denied) throw new Error("expected_cross_account_denied");

await revokeCgDevice({ accountId: accountA, targetDeviceId: d2 });
cache.invalidate(d2);
let revoked = false;
try { await cache.requireActive(d2); } catch (e) { revoked = String(e.message).includes("device_revoked"); }
if (!revoked) throw new Error("expected_device_revoked");

// expectedSequence conflict
let conflict = false;
try {
  await appendRelayMessage({
    kms, accountId: accountA, conversationId, role: "user", text: "x",
    expectedSequence: 999
  });
} catch (e) {
  conflict = String(e.message).includes("sequence_conflict");
}
if (!conflict) throw new Error("expected_sequence_conflict");

await pool.query(`delete from cs_relay_messages where conversation_id=$1`, [conversationId]);
await pool.query(`delete from conversations where id=$1`, [conversationId]);
await pool.query(`delete from cg_devices where account_id in ($1,$2)`, [accountA, accountB]);
await pool.query(`delete from account_keks where account_id in ($1,$2)`, [accountA, accountB]);
await pool.query(`delete from app_users where id=$1`, [user.rows[0].id]);
await pool.end();
console.log("PASS_MULTI_DEVICE_SYNC");
