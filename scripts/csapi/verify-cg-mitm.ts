#!/usr/bin/env -S npx tsx
/**
 * verify-cg-mitm.ts — runnable end-to-end demo of the cg-mitm/1 secure channel
 * using the REAL file-based loader (loadCgSecureConfig) + the generated dev
 * material in var/cg-mitm/, an in-memory fake runner backend, and the real
 * Secure Adapter facade. Proves: enroll → HPKE handshake → ciphertext exchange
 * (Anthropic/OpenAI, non-stream + SSE) → execute → reply, plus A1 (ciphertext on
 * the wire) / A6 (no apiKey in headers) / fail-closed on an unpinned root.
 *
 * Run:  scripts/csapi/dev-cg-mitm-setup.sh <origin>   # once, to make dev material
 *       tsx scripts/csapi/verify-cg-mitm.ts           # then verify
 *
 * It does NOT need a database or a live model: the fake backend echoes prompts,
 * exercising the full application-layer path deterministically.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT_DIR = process.env.CG_MITM_OUT_DIR ?? join(REPO_ROOT, "var", "cg-mitm");
const CERT_FILE = join(OUT_DIR, "cg-server-identity-cert.json");
const ROOTS_FILE = join(OUT_DIR, "cg-trust-root-public.json");

if (!existsSync(CERT_FILE) || !existsSync(ROOTS_FILE)) {
  console.error(`Missing dev material in ${OUT_DIR}. Run scripts/csapi/dev-cg-mitm-setup.sh first.`);
  process.exit(2);
}

// Derive the origin the cert was issued for (must equal the server's listen URL).
const cert = JSON.parse(readFileSync(CERT_FILE, "utf8")) as { allowedOrigins: string[] };
const origin = cert.allowedOrigins[0]!;
const url = new URL(origin);
const serverPort = Number(url.port || (url.protocol === "https:" ? 443 : 80));
const pinnedRoot = (
  JSON.parse(readFileSync(ROOTS_FILE, "utf8")) as { trustRoots: Array<{ fingerprint: string }> }
).trustRoots
  .map((r) => r.fingerprint)
  .join(",");

const CSAPI_KEY = "verify-cg-csapi-key";
const LOOPBACK_KEY = "verify-loopback-key";

// --- env MUST be set before importing config.ts / secure.ts ----------------
process.env.JWT_SECRET ??= "verify-jwt-secret-that-is-at-least-32-chars-long";
process.env.DATABASE_URL ??= "postgres://localhost:5432/verify";
process.env.RUNNER_SHARED_SECRET ??= "verify-runner-shared-secret-32-characters";
process.env.CSAPI_ENABLED = "true";
process.env.CSAPI_API_KEYS = CSAPI_KEY;
process.env.CG_SECURE_ENABLED = "true";
process.env.CG_SERVER_CERT_FILE = CERT_FILE;
process.env.CG_SERVER_HPKE_KEY_FILE = join(OUT_DIR, "cg-server-hpke-key.json");
process.env.CG_SERVER_SIGNING_KEY_FILE = join(OUT_DIR, "cg-server-signing-key.json");
process.env.CG_TRUST_ROOTS_FILE = ROOTS_FILE;

process.env.CG_ADAPTER_UPSTREAM_URL = origin;
process.env.CG_ADAPTER_API_KEY = CSAPI_KEY;
process.env.CG_ADAPTER_LOOPBACK_KEY = LOOPBACK_KEY;
process.env.CG_ADAPTER_PINNED_ROOTS = pinnedRoot;
process.env.CG_ADAPTER_LISTEN_PORT = "0";

const Fastify = (await import("fastify")).default;
const { loadCgSecureConfig, registerCsapiSecure } = await import(
  "../../apps/server/src/csapi/secure.js"
);
const { loadAdapterConfig } = await import("../../apps/secure-adapter/src/config.js");
const { createFacade } = await import("../../apps/secure-adapter/src/facade.js");
const { SecureClient } = await import("../../apps/secure-adapter/src/secureClient.js");
const { StateStore } = await import("../../apps/secure-adapter/src/state.js");

// In-memory fake runner backend (echoes prompts).
const fakeBackend = {
  runs: new Map<string, { prompt: string; conversationId: string; at: number }>(),
  lastHeaders: {} as Record<string, unknown>,
  listModelIds: () => ["hermes:default"],
  runnersOnline: () => 1,
  modelIsKnown: (m: string) => m === "auto" || m === "hermes:default",
  pickWorkspaceId: async (p?: string) => p || "ws-verify",
  getPrincipalId: async () => "principal-verify",
  createConversation: async () => crypto.randomUUID(),
  conversationExists: async () => true,
  createRun: async (input: { conversationId: string; prompt: string }) => {
    const runId = crypto.randomUUID();
    fakeBackend.runs.set(runId, { prompt: input.prompt, conversationId: input.conversationId, at: Date.now() });
    return { runId, conversationId: input.conversationId, status: "queued" as const };
  },
  getRun: async (runId: string) => {
    const run = fakeBackend.runs.get(runId);
    if (!run) return undefined;
    return {
      status: "finished" as const,
      response: `echo:${run.prompt}`,
      error: null,
      progress: null,
      inputTokens: 9,
      outputTokens: 4
    };
  },
  cancelRun: async () => {},
  audit: async () => {}
};

const secure = await loadCgSecureConfig();
if (!secure) {
  console.error("loadCgSecureConfig() returned null — check CG_* env / dev files.");
  process.exit(2);
}

const server = Fastify({ bodyLimit: 3 * 1024 * 1024 });
registerCsapiSecure(server, {
  backend: fakeBackend as never,
  config: {
    enabled: true,
    apiKeys: new Set([CSAPI_KEY]),
    defaultModel: "hermes:default",
    defaultWorkspaceId: "",
    maxConcurrencyPerKey: 8,
    runTimeoutMs: 10_000,
    allowWrites: false
  },
  pollIntervalMs: 5,
  secure
});
await server.listen({ host: url.hostname, port: serverPort });

const results: Array<{ id: string; label: string; ok: boolean; detail: string }> = [];
const record = (id: string, label: string, ok: boolean, detail = "") =>
  results.push({ id, label, ok, detail });

// Sniff the upstream request to prove A1/A6.
let sniffedBody = "";
let sniffedHeaders: Record<string, string> = {};
const sniffFetch: typeof fetch = async (input, init) => {
  if (typeof input === "string" && input.endsWith("/cg/v1/exchange")) {
    sniffedBody = String(init?.body ?? "");
    sniffedHeaders = (init?.headers as Record<string, string>) ?? {};
  }
  return fetch(input as string, init);
};

const cfg = loadAdapterConfig();
const client = new SecureClient(cfg, new StateStore(cfg.statePath), sniffFetch);
await client.init();
const facade = createFacade(cfg, client);
await facade.listen({ host: "127.0.0.1", port: 0 });
const facadeAddr = facade.server.address();
const facadePort = typeof facadeAddr === "object" && facadeAddr ? facadeAddr.port : 0;
const base = `http://127.0.0.1:${facadePort}`;

try {
  // 1) Anthropic non-stream
  const a = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": LOOPBACK_KEY },
    body: JSON.stringify({ model: "auto", max_tokens: 32, messages: [{ role: "user", content: "ping-anthropic" }] })
  });
  const aBody = (await a.json()) as { content?: Array<{ text: string }> };
  record("E1-anthropic", "Adapter → Anthropic non-stream", a.status === 200 && /echo:.*ping-anthropic/.test(aBody.content?.[0]?.text ?? ""), `status ${a.status}`);

  // A6/A1 from the sniffed upstream exchange
  const hdr = JSON.stringify(sniffedHeaders).toLowerCase();
  record("A6", "No apiKey in upstream headers", !hdr.includes(CSAPI_KEY.toLowerCase()) && !("x-api-key" in sniffedHeaders) && !("authorization" in sniffedHeaders));
  record("A1", "Wire is AEAD ciphertext (no plaintext)", !sniffedBody.includes(CSAPI_KEY) && !sniffedBody.includes("ping-anthropic") && /"payload":\{"alg":"A256GCM"/.test(sniffedBody));

  // 2) OpenAI non-stream
  const o = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${LOOPBACK_KEY}` },
    body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "ping-openai" }] })
  });
  const oBody = (await o.json()) as { choices?: Array<{ message: { content: string } }> };
  record("E1-openai", "Adapter → OpenAI non-stream", o.status === 200 && /echo:.*ping-openai/.test(oBody.choices?.[0]?.message?.content ?? ""), `status ${o.status}`);

  // 3) Anthropic SSE stream
  const s = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": LOOPBACK_KEY },
    body: JSON.stringify({ model: "auto", stream: true, messages: [{ role: "user", content: "ping-stream" }] })
  });
  const sText = await s.text();
  record("B-stream", "Adapter → Anthropic SSE stream", /event: message_start/.test(sText) && /event: message_stop/.test(sText) && /ping-stream/.test(sText));

  // 4) wrong loopback key → 401 (local)
  const u = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "wrong" },
    body: JSON.stringify({ messages: [{ role: "user", content: "x" }] })
  });
  record("401-local", "Wrong loopback key → 401", u.status === 401, `status ${u.status}`);

  // 5) fail-closed: unpinned root aborts a fresh client init
  const badCfg = { ...cfg, pinnedRootFingerprints: ["sha256:" + "A".repeat(43)] };
  const badClient = new SecureClient(badCfg, new StateStore(join(OUT_DIR, "verify-bad-state.json")));
  let failClosed = false;
  try {
    await badClient.init();
  } catch (err) {
    failClosed = err instanceof Error && err.message === "root_fingerprint_not_pinned";
  }
  record("A4", "Fail-closed on unpinned root", failClosed);
} finally {
  await facade.close();
  await server.close();
}

console.log("\n cg-mitm/1 end-to-end verification");
console.log("──────────────────────────────────────────────────────────────");
let allOk = true;
for (const r of results) {
  allOk = allOk && r.ok;
  console.log(` ${r.ok ? "PASS" : "FAIL"}  [${r.id}] ${r.label}${r.detail ? `  (${r.detail})` : ""}`);
}
console.log("──────────────────────────────────────────────────────────────");
console.log(allOk ? " ALL CHECKS PASSED" : " SOME CHECKS FAILED");
process.exit(allOk ? 0 : 1);
