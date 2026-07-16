import { readFileSync } from "node:fs";
import { migrate, pool } from "../apps/server/dist/db.js";
import { FileMasterKeyProvider } from "@cursor-gateway/e2ee";
import {
  appendRelayMessage,
  ensureRelayConversation,
  listRelayMessages
} from "../apps/server/dist/csRelayHistory.js";

const canary = process.env.CANARY;
if (!canary) throw new Error("CANARY required");
await migrate();
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
await pool.query(`delete from cs_relay_messages where conversation_id=$1`, [conversationId]);
await pool.query(`delete from conversations where id=$1`, [conversationId]);
await pool.query(`delete from account_keks where account_id=$1`, [accountId]);
await pool.query(`delete from app_users where id=$1`, [user.rows[0].id]);
await pool.end();
console.log("PASS_CLEANED");
