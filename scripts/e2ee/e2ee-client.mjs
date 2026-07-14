// Headless E2EE client for cg-e2ee/1 (stands in for the signed browser extension).
// Runs on the trusted WSL host next to the runner. Talks to the gateway over an
// SSH tunnel to 127.0.0.1 with a Cloudflare-Access identity header. Only
// ciphertext ever reaches the gateway; the client signing key + conversation
// root keys stay in a 0600 file on this host.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { spawn } from "node:child_process";
import * as shared from "@cursor-gateway/shared";
import * as e2ee from "@cursor-gateway/e2ee";

const home = process.env.HOME || process.env.USERPROFILE || ".";
const STATE_FILE =
  process.env.E2EE_CLIENT_STATE ?? `${home}/.cursor-gateway/e2ee-client-state.json`;
// The client runs on the trusted runner host; each HTTP call can be proxied
// through SSH to the VPS loopback gateway. Bodies are ciphertext envelopes;
// decryption stays on this host, so the gateway only ever sees ciphertext.
const SSH_HOST = process.env.CLIENT_SSH_HOST ?? "gateway-vps";
const REMOTE_BASE = process.env.CLIENT_REMOTE_BASE ?? "http://127.0.0.1:18080";
const EMAIL = process.env.CLIENT_EMAIL ?? "e2ee-cli@local.test";
const RUNNER_ID = process.env.CLIENT_RUNNER_ID ?? "linux-e2ee";
const P = shared.E2EE_PROTOCOL;

function loadState() {
  if (existsSync(STATE_FILE)) return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  return {};
}
function saveState(state) {
  mkdirSync(dirname(STATE_FILE), { recursive: true, mode: 0o700 });
  writeFileSync(STATE_FILE, JSON.stringify(state), { mode: 0o600 });
  chmodSync(STATE_FILE, 0o600);
}

async function ensureDevice(state) {
  if (state.device) return state;
  const keys = await e2ee.generateSigningKeyPair(true);
  const signingPrivateJwk = await e2ee.exportPrivateJwk(keys.privateKey);
  const signingKey = await e2ee.createKeyDescriptor(keys.publicKey);
  state.device = { clientId: crypto.randomUUID(), signingPrivateJwk, signingKey };
  saveState(state);
  return state;
}
async function deviceSigningPrivate(state) {
  return e2ee.importSigningPrivateKey(state.device.signingPrivateJwk);
}

function sshCurl(method, path, body) {
  return new Promise((resolve, reject) => {
    const hasBody = body !== undefined;
    const remote =
      `curl -s -m 30 -w '\\n%{http_code}' -X ${method} ` +
      `-H 'cf-access-authenticated-user-email: ${EMAIL}' ` +
      (hasBody ? `-H 'content-type: application/json' --data-binary @- ` : "") +
      `'${REMOTE_BASE}${path}'`;
    const p = spawn("ssh", ["-o", "BatchMode=yes", SSH_HOST, remote], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ssh/curl exit ${code}: ${err}`));
      const idx = out.lastIndexOf("\n");
      resolve({ status: parseInt(out.slice(idx + 1).trim(), 10), body: out.slice(0, idx) });
    });
    if (hasBody) p.stdin.write(body);
    p.stdin.end();
  });
}

async function api(path, init = {}) {
  const method = init.method ?? "GET";
  const { status, body } = await sshCurl(method, path, init.body);
  if (status < 200 || status >= 300) throw new Error(`${method} ${path} -> ${status} ${body}`);
  return body && status !== 204 ? JSON.parse(body) : undefined;
}

function clientBundle(state) {
  return {
    protocol: P,
    kind: "client-pairing",
    clientId: state.device.clientId,
    signingKey: state.device.signingKey,
    createdAt: new Date().toISOString()
  };
}

async function cmdBundle(state) {
  console.log("client_id=" + state.device.clientId);
  console.log("client_signing_fingerprint=" + state.device.signingKey.fingerprint);
  console.log("CLIENT_BUNDLE=" + e2ee.encodeBase64Url(e2ee.utf8(JSON.stringify(clientBundle(state)))));
}

async function directoryRunner() {
  const { runners } = await api("/api/e2ee/v1/runners");
  const entry = runners.map((r) => shared.e2eeRunnerDirectoryEntrySchema.parse(r)).find((r) => r.runnerId === RUNNER_ID);
  if (!entry) throw new Error(`runner ${RUNNER_ID} not in directory`);
  return entry;
}

async function cmdPin(state, runnerBundleB64) {
  const bundle = shared.e2eeRunnerPairingBundleSchema.parse(
    JSON.parse(e2ee.decodeUtf8(e2ee.decodeBase64Url(runnerBundleB64.trim())))
  );
  const dir = await directoryRunner();
  // Automated fingerprint verification (stands in for human check): compare the
  // fingerprints the GATEWAY advertises against the out-of-band runner bundle.
  const encMatch = dir.e2ee.encryptionKey.fingerprint === bundle.encryptionKey.fingerprint;
  const sigMatch = dir.e2ee.signingKey.fingerprint === bundle.signingKey.fingerprint;
  console.log("runner_id=" + bundle.runnerId);
  console.log("bundle_enc_fp =" + bundle.encryptionKey.fingerprint);
  console.log("dir_enc_fp    =" + dir.e2ee.encryptionKey.fingerprint);
  console.log("bundle_sig_fp =" + bundle.signingKey.fingerprint);
  console.log("dir_sig_fp    =" + dir.e2ee.signingKey.fingerprint);
  console.log(`FINGERPRINT_COMPARE: encryption=${encMatch ? "MATCH" : "MISMATCH"} signing=${sigMatch ? "MATCH" : "MISMATCH"}`);
  if (!encMatch || !sigMatch) throw new Error("runner_fingerprint_mismatch (aborting pin)");
  state.runnerPin = bundle;
  saveState(state);
  console.log("PINNED runner " + bundle.runnerId);
}

async function cmdRun(state, mode, prompt) {
  const allowWrites = mode === "write";
  const pin = state.runnerPin;
  if (!pin) throw new Error("no runner pinned; run 'pin' first");
  const dir = await directoryRunner();
  if (dir.e2ee.encryptionKey.fingerprint !== pin.encryptionKey.fingerprint ||
      dir.e2ee.signingKey.fingerprint !== pin.signingKey.fingerprint) {
    throw new Error("runner_fingerprint_mismatch at run time");
  }
  if (!dir.online) throw new Error("runner offline");
  const workspaceId = dir.workspaces[0]?.id;
  if (!workspaceId) throw new Error("runner advertises no workspace");
  const model = "auto";

  const signingPrivate = await deviceSigningPrivate(state);
  const clientId = state.device.clientId;
  const clientKeyId = state.device.signingKey.keyId;
  const runnerKeyId = pin.encryptionKey.keyId;

  const conversationId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const rawRoot = e2ee.generateRootKeyBytes();
  const rootKey = await e2ee.importRootKey(rawRoot);
  const wrappedConversationKey = await e2ee.wrapRootKey(
    rawRoot, pin.encryptionKey.publicKey,
    e2ee.requestKeyContext({ conversationId, clientId, runnerId: pin.runnerId, runnerKeyId })
  );
  rawRoot.fill(0);

  const routing = { model, workspaceId, allowWrites, memoryEnabled: true };
  const title = await e2ee.encryptJson(rootKey, "browser-local:conversation-title",
    { protocol: P, conversationId }, prompt.trim().slice(0, 80));
  const requestBase = {
    protocol: P, kind: "run-request", messageId: runId, runId, conversationId,
    clientId, clientKeyId, runnerId: pin.runnerId, runnerKeyId, sequence: 1,
    createdAt: new Date().toISOString(), routing, previousDigest: null,
    wrappedConversationKey, title
  };
  const plaintext = shared.e2eeRunPayloadSchema.parse({
    protocol: P, kind: "run-request", messageId: runId, runId, conversationId,
    sequence: 1, routing, prompt, history: [], memory: [], previousDigest: null
  });
  const payload = await e2ee.encryptJson(rootKey, "browser-to-runner:run-request",
    e2ee.requestPayloadAad(requestBase), plaintext);
  const unsignedRequest = { ...requestBase, payload };
  const signature = await e2ee.signValue(unsignedRequest, signingPrivate, clientKeyId);
  const request = shared.e2eeRunRequestEnvelopeSchema.parse({ ...unsignedRequest, signature });
  const requestDigest = await e2ee.digestValue(unsignedRequest);

  console.log(`\n[${mode}] runId=${runId} conversationId=${conversationId} workspace=${workspaceId}`);
  await api("/api/e2ee/v1/runs", { method: "POST", body: JSON.stringify({ request }) });
  console.log("submitted encrypted run (server received CIPHERTEXT only)");

  if (allowWrites) {
    const unsignedApproval = {
      protocol: P, kind: "run-approval", messageId: crypto.randomUUID(), runId,
      conversationId, clientId, clientKeyId, runnerId: pin.runnerId, runnerKeyId,
      requestDigest, allowWrites: true, createdAt: new Date().toISOString()
    };
    const approval = { ...unsignedApproval,
      signature: await e2ee.signValue(unsignedApproval, signingPrivate, clientKeyId) };
    await api(`/api/e2ee/v1/runs/${runId}/approval`, { method: "POST", body: JSON.stringify({ approval }) });
    console.log("submitted signed write approval (bound to requestDigest)");
  }

  // Poll for the encrypted result.
  const runnerSigningPub = await e2ee.importSigningPublicKey(pin.signingKey.publicKey);
  let record;
  for (let i = 0; i < 90; i++) {
    const { run } = await api(`/api/e2ee/v1/runs/${runId}`);
    record = shared.e2eeRunRecordSchema.parse(run);
    if (record.result) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!record?.result) { console.log("STATUS=" + record?.status + " (no result within timeout)"); return; }

  const r = record.result;
  const okSig = r.signature.keyId === pin.signingKey.keyId &&
    r.requestDigest === requestDigest &&
    (await e2ee.verifyValue(e2ee.unsignedEnvelope(r), r.signature, runnerSigningPub));
  const { payload: _p, signature: _s, ...base } = r;
  const opened = shared.e2eeResultPayloadSchema.parse(
    await e2ee.decryptJson(rootKey, "runner-to-browser:run-result", e2ee.resultPayloadAad(base), r.payload));
  console.log("RESULT status=" + record.status + " / payload.status=" + opened.status);
  console.log("runner_signature_verified=" + okSig);
  console.log("requestDigest_bound=" + (r.requestDigest === requestDigest));
  console.log("DECRYPTED_RESPONSE=" + JSON.stringify((opened.response ?? opened.error ?? "").slice(0, 300)));
  console.log("EVIDENCE_RUN_ID=" + runId);
}

const [cmd, arg1, ...rest] = process.argv.slice(2);
let state = await ensureDevice(loadState());
if (cmd === "bundle") await cmdBundle(state);
else if (cmd === "pin") await cmdPin(state, arg1);
else if (cmd === "run") await cmdRun(state, arg1, rest.join(" "));
else { console.error("usage: bundle | pin <runnerBundleB64> | run <read|write> <prompt>"); process.exit(1); }
