import { readFileSync, writeFileSync } from "node:fs";
import { migrate, pool } from "../../apps/server/dist/db.js";
import { FileMasterKeyProvider } from "@cursor-gateway/e2ee";
import {
  appendRelayMessage,
  ensureRelayConversation,
  listRelayMessages
} from "../../apps/server/dist/csRelayHistory.js";
import { closeSyncBus } from "../../apps/server/dist/csapi/syncBus.js";

await migrate();

if (process.env.CANARY_CLEANUP_STATE) {
  const state = JSON.parse(readFileSync(process.env.CANARY_CLEANUP_STATE, "utf8"));
  await pool.query(`delete from cs_relay_messages where conversation_id=$1`, [
    state.conversationId
  ]);
  await pool.query(`delete from conversations where id=$1`, [state.conversationId]);
  await pool.query(`delete from account_keks where account_id=$1`, [state.accountId]);
  await pool.query(`delete from app_users where id=$1`, [state.userId]);
  await closeSyncBus();
  await pool.end();
  console.log("PASS_CLEANED");
  process.exit(0);
}

const canary = process.env.CANARY;
if (!canary) throw new Error("CANARY required");
const master = readFileSync(
  process.env.CS_RELAY_MASTER_KEY_FILE || process.env.CG_MASTER_KEY_FILE,
  "utf8"
).trim();
const kms = new FileMasterKeyProvider("file-master-1", master);
const accountId = `canary-account-${crypto.randomUUID()}`;
const user = await pool.query(
  `insert into app_users (email, role) values ($1,'operator') returning id`,
  [`canary-${crypto.randomUUID()}@example.com`]
);
await pool.query(
  `insert into workspaces (id, label, path, writable, enabled)
   values ('ws-canary','Canary','/tmp',false,true) on conflict do nothing`
);
const { conversationId } = await ensureRelayConversation({
  kms,
  accountId,
  workspaceId: "ws-canary",
  userId: String(user.rows[0].id),
  title: "canary"
});
await appendRelayMessage({
  kms,
  accountId,
  conversationId,
  role: "user",
  text: canary,
  idempotencyKey: crypto.randomUUID()
});
await appendRelayMessage({
  kms,
  accountId,
  conversationId,
  role: "assistant",
  text: "ack"
});
const page = await listRelayMessages({ kms, accountId, conversationId, limit: 10 });
if (page.messages[0]?.content !== canary) throw new Error("roundtrip_failed");
const dump = await pool.query(
  `select m.content_ciphertext::text as ct, c.wrapped_dek::text as dek, c.title
   from cs_relay_messages m join conversations c on c.id=m.conversation_id
   where m.conversation_id=$1`,
  [conversationId]
);
const blob = JSON.stringify(dump.rows);
if (blob.includes(canary)) {
  console.error("FAIL_PLAINTEXT_IN_DB");
  process.exit(2);
}
console.log("PASS_DB_NO_PLAINTEXT");
if (process.env.KEEP_CANARY === "1") {
  const stateFile = process.env.CANARY_STATE_FILE;
  if (!stateFile) throw new Error("CANARY_STATE_FILE required with KEEP_CANARY=1");
  writeFileSync(
    stateFile,
    JSON.stringify({
      accountId,
      conversationId,
      userId: String(user.rows[0].id)
    }),
    { mode: 0o600 }
  );
  await closeSyncBus();
  await pool.end();
  console.log("PASS_KEPT_FOR_EXTERNAL_SCAN");
  process.exit(0);
}

await pool.query(`delete from cs_relay_messages where conversation_id=$1`, [conversationId]);
await pool.query(`delete from conversations where id=$1`, [conversationId]);
await pool.query(`delete from account_keks where account_id=$1`, [accountId]);
await pool.query(`delete from app_users where id=$1`, [user.rows[0].id]);
await closeSyncBus();
await pool.end();
console.log("PASS_CLEANED");
