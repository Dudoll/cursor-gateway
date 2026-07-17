/**
 * relay-P4 smoke: drive the real CS → Runner re-encrypt path with a canary.
 * Proves: runner decrypts taskRoot, runs model, re-encrypts result; CS decrypts;
 * and the queued `runs.request_envelope` contains ONLY ciphertext (no canary).
 *
 * Runs inside the app container (has CG_* secure env + DATABASE_URL).
 * Requires an online cg-e2ee/1 runner. Sets its own CS_RELAY_RUNNER_REENCRYPT=true
 * so the server flag can stay disabled during grayscale.
 */
process.env.CS_RELAY_RUNNER_REENCRYPT = "true";

const { pool, migrate } = await import("../../apps/server/dist/db.js");
const { loadCgSecureConfig } = await import("../../apps/server/dist/csapi/secure.js");
const { listE2eeRunners } = await import("../../apps/server/dist/e2eeDb.js");
const { executeCsRelayReencrypt } = await import(
  "../../apps/server/dist/csapi/csRelayExecute.js"
);

await migrate();

const canary = process.env.CANARY || `P4-CANARY-${crypto.randomUUID()}`;

const secure = await loadCgSecureConfig();
if (!secure) {
  console.error("P4_ERR loadCgSecureConfig_null");
  process.exit(2);
}

const runners = await listE2eeRunners();
const online = runners.filter((r) => r.online);
if (online.length === 0) {
  console.error("P4_ERR no_online_runner");
  process.exit(3);
}
const runner = online[0];
const workspaceId = runner.workspaces[0]?.id;
if (!workspaceId) {
  console.error("P4_ERR runner_has_no_workspace");
  process.exit(3);
}
console.log(`P4_RUNNER=${runner.runnerId} workspace=${workspaceId} models=${runner.models.map((m) => m.id).join(",")}`);

// Ensure server-side workspace + principal rows exist for the run/conversation FKs.
await pool.query(
  `insert into workspaces (id, label, path, writable, enabled)
   values ($1,$1,'/tmp',false,true) on conflict (id) do nothing`,
  [workspaceId]
);
const userRes = await pool.query(
  `insert into app_users (email, role) values ($1,'operator') returning id`,
  [`p4-${crypto.randomUUID()}@example.com`]
);
const principalId = String(userRes.rows[0].id);

let runId;
let failure = null;
try {
  const result = await executeCsRelayReencrypt({
    principalId,
    workspaceId,
    model: "auto",
    turns: [{ role: "user", content: `Reply with exactly this token: ${canary}` }],
    csSigningPrivateKey: secure.signingPrivateKey,
    csSigningKeyId: secure.signingKeyId,
    timeoutMs: Number(process.env.P4_TIMEOUT_MS || 60_000),
    pollIntervalMs: 500
  });
  runId = result.runId;
  const echoed = result.text.includes(canary);
  console.log(`P4_RESULT status=finished echoed_canary=${echoed} len=${result.text.length} tokens_in=${result.inputTokens} out=${result.outputTokens}`);
  if (!echoed) console.log("P4_NOTE model_reply_did_not_include_canary (still valid crypto roundtrip)");
} catch (error) {
  failure = error;
  console.error(`P4_ERR execute_failed=${error?.reason || error?.message || error}`);
}

// Inspect the queued envelope for plaintext leakage regardless of run outcome.
const dump = await pool.query(
  `select id, request_envelope::text env, content_mode from runs where user_id=$1 order by created_at desc limit 3`,
  [principalId]
);
let leak = false;
for (const row of dump.rows) {
  if (row.env && row.env.includes(canary)) {
    leak = true;
    console.error(`P4_FAIL plaintext_canary_in_queue run=${row.id}`);
  }
}
if (!leak) console.log(`P4_QUEUE_NO_PLAINTEXT rows=${dump.rows.length} content_mode=${dump.rows[0]?.content_mode ?? "-"}`);

// Cleanup test rows.
if (runId) await pool.query(`delete from runs where id=$1`, [runId]).catch(() => {});
await pool.query(`delete from runs where user_id=$1`, [principalId]).catch(() => {});
await pool.query(`delete from conversations where user_id=$1`, [principalId]).catch(() => {});
await pool.query(`delete from app_users where id=$1`, [principalId]).catch(() => {});
await pool.end();

if (failure) process.exit(4);
if (leak) process.exit(5);
console.log("PASS_RELAY_P4_SMOKE");
process.exit(0);
