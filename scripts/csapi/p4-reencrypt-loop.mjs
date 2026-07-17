/**
 * relay-P4 result-decrypt closure (controlled runner).
 *
 * Proves the CS side of the re-encrypt loop end-to-end WITHOUT depending on the
 * external runner's long real-agent task: we register a test runner whose keys
 * we control, drive executeCsRelayReencrypt (CS builds cg-e2ee/1 envelope, holds
 * taskRoot), then process the queued envelope exactly like the real runner
 * (unwrap taskRoot -> decrypt prompt -> encrypt+sign a short result). CS must
 * decrypt the result to plaintext; the queue/DB must stay ciphertext-only.
 *
 * Runs inside the app container (CG_* secure env + DATABASE_URL).
 */
import { randomUUID } from "node:crypto";

process.env.CS_RELAY_RUNNER_REENCRYPT = "true";

const {
  createKeyDescriptor,
  decryptJson,
  digestValue,
  encryptJson,
  exportPrivateJwk,
  generateHpkeKeyPair,
  generateSigningKeyPair,
  importHpkePrivateKey,
  importSigningPrivateKey,
  requestKeyContext,
  requestPayloadAad,
  resultPayloadAad,
  signValue,
  unsignedEnvelope,
  unwrapRootKey
} = await import("@cursor-gateway/e2ee");

const { pool, migrate } = await import("../../apps/server/dist/db.js");
const { loadCgSecureConfig } = await import("../../apps/server/dist/csapi/secure.js");
const { upsertE2eeRunner } = await import("../../apps/server/dist/e2eeDb.js");
const { executeCsRelayReencrypt } = await import(
  "../../apps/server/dist/csapi/csRelayExecute.js"
);

await migrate();

const canary = process.env.CANARY || `P4-LOOP-${randomUUID()}`;
const fail = (msg, code = 1) => {
  console.error(msg);
  process.exit(code);
};

const secure = await loadCgSecureConfig();
if (!secure) fail("P4_ERR loadCgSecureConfig_null", 2);

// --- 1) register a controlled test runner --------------------------------
const hpke = await generateHpkeKeyPair();
const signing = await generateSigningKeyPair();
const encDescriptor = await createKeyDescriptor(hpke.publicKey);
const sigDescriptor = await createKeyDescriptor(signing.publicKey);
const hpkePrivJwk = await exportPrivateJwk(hpke.privateKey);
const sigPrivJwk = await exportPrivateJwk(signing.privateKey);
const hpkePriv = await importHpkePrivateKey(hpkePrivJwk);
const sigPriv = await importSigningPrivateKey(sigPrivJwk);

const runnerId = `cs-relay-loop-${randomUUID().slice(0, 8)}`;
const workspaceId = `ws-loop-${randomUUID().slice(0, 8)}`;
await upsertE2eeRunner({
  runnerId,
  runnerVersion: "0.0.0-loop",
  e2ee: {
    protocols: ["cg-e2ee/1"],
    encryptionKey: encDescriptor,
    signingKey: sigDescriptor
  },
  models: [{ id: "default" }],
  workspaces: [{ id: workspaceId, label: "loop", writable: false }]
});
console.log(`P4_RUNNER=${runnerId} workspace=${workspaceId}`);

const userRes = await pool.query(
  `insert into app_users (email, role) values ($1,'operator') returning id`,
  [`p4loop-${randomUUID()}@example.com`]
);
const principalId = String(userRes.rows[0].id);

// --- 2) controlled runner processor: claim the queued envelope, reply ------
let processorDone = false;
async function processorLoop() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && !processorDone) {
    const r = await pool.query(
      `select id, request_envelope from runs
       where target_runner_id=$1 and content_mode='e2ee-v1' and status in ('queued','running')
       order by created_at asc limit 1`,
      [runnerId]
    );
    const row = r.rows[0];
    if (!row) {
      await new Promise((res) => setTimeout(res, 250));
      continue;
    }
    const request = row.request_envelope;
    const rootKey = await unwrapRootKey(
      request.wrappedConversationKey,
      hpkePriv,
      encDescriptor.publicKey,
      requestKeyContext(request)
    );
    const { payload: _p, signature: _s, ...requestBase } = request;
    const inner = await decryptJson(
      rootKey,
      "browser-to-runner:run-request",
      requestPayloadAad(requestBase),
      request.payload
    );
    // Sanity: the taskRoot really decrypts and carries the canary prompt.
    if (!String(inner.prompt || "").includes(canary)) {
      console.error("P4_ERR runner_prompt_missing_canary");
    }
    const requestDigest = await digestValue(unsignedEnvelope(request));
    const resultBase = {
      protocol: request.protocol,
      kind: "run-result",
      messageId: randomUUID(),
      runId: request.runId,
      conversationId: request.conversationId,
      runnerId: request.runnerId,
      runnerKeyId: request.runnerKeyId,
      requestDigest,
      sequence: 1,
      status: "finished",
      createdAt: new Date().toISOString()
    };
    const resultPayload = {
      protocol: request.protocol,
      kind: "run-result",
      runId: request.runId,
      conversationId: request.conversationId,
      status: "finished",
      response: `echo:${canary}`,
      error: null,
      inputTokens: 3,
      outputTokens: 2
    };
    const encryptedPayload = await encryptJson(
      rootKey,
      "runner-to-browser:run-result",
      resultPayloadAad(resultBase),
      resultPayload
    );
    const unsignedResult = { ...resultBase, payload: encryptedPayload };
    const signature = await signValue(unsignedResult, sigPriv, sigDescriptor.keyId);
    const envelope = { ...unsignedResult, signature };
    await pool.query(
      `update runs set status='finished', result_envelope=$1::jsonb, finished_at=now(), updated_at=now()
       where id=$2`,
      [JSON.stringify(envelope), row.id]
    );
    console.log(`P4_RUNNER_REPLIED run=${row.id}`);
    processorDone = true;
    return;
  }
}

// --- 3) drive CS re-encrypt execute + controlled runner concurrently -------
let csResult = null;
let csError = null;
const csPromise = executeCsRelayReencrypt({
  principalId,
  workspaceId,
  model: "default",
  turns: [{ role: "user", content: `Reply with exactly this token: ${canary}` }],
  csSigningPrivateKey: secure.signingPrivateKey,
  csSigningKeyId: secure.signingKeyId,
  timeoutMs: 60_000,
  pollIntervalMs: 300
})
  .then((r) => {
    csResult = r;
  })
  .catch((e) => {
    csError = e;
  });

await Promise.all([csPromise, processorLoop()]);

// --- 4) assertions ---------------------------------------------------------
let exitCode = 0;
if (csError) {
  console.error(`P4_ERR cs_execute_failed=${csError?.reason || csError?.message || csError}`);
  exitCode = 4;
} else {
  const echoed = csResult.text.includes(canary);
  console.log(
    `P4_CS_DECRYPTED status=finished echoed_canary=${echoed} len=${csResult.text.length} in=${csResult.inputTokens} out=${csResult.outputTokens}`
  );
  if (!echoed) {
    console.error("P4_ERR cs_plaintext_missing_canary");
    exitCode = 5;
  }
}

// Queue/DB must never hold the canary in cleartext (request or result envelope).
const dump = await pool.query(
  `select id, request_envelope::text req, coalesce(result_envelope::text,'') res, content_mode
   from runs where user_id=$1`,
  [principalId]
);
let leak = false;
for (const row of dump.rows) {
  if ((row.req && row.req.includes(canary)) || (row.res && row.res.includes(canary))) {
    leak = true;
    console.error(`P4_FAIL plaintext_canary_in_db run=${row.id}`);
  }
}
if (!leak) console.log(`P4_QUEUE_NO_PLAINTEXT rows=${dump.rows.length} content_mode=${dump.rows[0]?.content_mode ?? "-"}`);
else exitCode = 6;

// --- 5) cleanup ------------------------------------------------------------
await pool.query(`delete from runs where user_id=$1`, [principalId]).catch(() => {});
await pool.query(`delete from conversations where user_id=$1`, [principalId]).catch(() => {});
await pool.query(`delete from app_users where id=$1`, [principalId]).catch(() => {});
await pool.query(`delete from runner_devices where runner_id=$1`, [runnerId]).catch(() => {});
await pool.query(`delete from workspaces where id=$1`, [workspaceId]).catch(() => {});
await pool.end();

if (exitCode === 0) console.log("PASS_RELAY_P4_LOOP");
process.exit(exitCode);
