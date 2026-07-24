// End-to-end integration tests for the cg-mitm/1 Secure Adapter against a real
// listening csapi secure server (registerCsapiSecure) backed by an in-memory
// fake runner. Covers: enroll → HPKE handshake → ciphertext exchange (Anthropic
// + OpenAI, non-stream + SSE), fail-closed on unpinned root / forged server,
// wrong API key → 401, plus AEAD tamper (A2) and replay (A3) rejection.
import "./_env.js";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import {
  createKeyDescriptor,
  exportE2eePublicKey,
  exportPrivateJwk,
  generateCgTrustRootKeyPair,
  generateHpkeKeyPair,
  generateSigningKeyPair,
  importHpkePrivateKey,
  importSigningPrivateKey,
  issueCgServerIdentityCert
} from "@cursor-gateway/e2ee";
import {
  cgServerKeysResponseSchema,
  CG_MITM_HPKE_SUITE,
  CG_MITM_PROTOCOL,
  type CgTrustRootPublic
} from "@cursor-gateway/shared";
import type { RunStatus } from "@cursor-gateway/shared";
import type { CsapiBackend, CsapiRunHandle, CsapiRunSnapshot } from "../../server/src/csapi/backend.js";
import { registerCsapiSecure, type CsapiSecureConfig } from "../../server/src/csapi/secure.js";
import type { AdapterConfig } from "../src/config.js";
import { createFacade } from "../src/facade.js";
import { AdapterError, FailClosedError, SecureClient } from "../src/secureClient.js";
import { StateStore } from "../src/state.js";

const KEY = "test-csapi-key-cg-1";
const LOOPBACK = "loopback-local-key";

class FakeBackend implements CsapiBackend {
  finishDelayMs = 10;
  private runs = new Map<string, { createdAt: number; prompt: string; conversationId: string }>();
  lastPrompt: string | null = null;
  cancelCount = 0;
  listModelIds() {
    return ["hermes:default"];
  }
  runnersOnline() {
    return 1;
  }
  modelIsKnown(model: string) {
    return model === "auto" || this.listModelIds().includes(model);
  }
  async pickWorkspaceId(preferred?: string) {
    return preferred || "ws-test";
  }
  async getPrincipalId() {
    return "principal-test";
  }
  async createConversation() {
    return crypto.randomUUID();
  }
  async conversationExists() {
    return true;
  }
  async createRun(input: { conversationId: string; prompt: string }): Promise<CsapiRunHandle> {
    const runId = crypto.randomUUID();
    this.runs.set(runId, { createdAt: Date.now(), prompt: input.prompt, conversationId: input.conversationId });
    this.lastPrompt = input.prompt;
    return { runId, conversationId: input.conversationId, status: "queued" as RunStatus };
  }
  async getRun(runId: string): Promise<CsapiRunSnapshot | undefined> {
    const run = this.runs.get(runId);
    if (!run) return undefined;
    if (Date.now() - run.createdAt < this.finishDelayMs) {
      return { status: "running", response: null, error: null, progress: "working", inputTokens: null, outputTokens: null };
    }
    return { status: "finished", response: `echo:${run.prompt}`, error: null, progress: null, inputTokens: 11, outputTokens: 7 };
  }
  async cancelRun() {
    this.cancelCount += 1;
  }
  async audit() {
    /* no-op */
  }
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

interface Harness {
  app: FastifyInstance;
  origin: string;
  root: CgTrustRootPublic;
  backend: FakeBackend;
  close: () => Promise<void>;
}

async function startSecureServer(): Promise<Harness> {
  const port = await getFreePort();
  const origin = `http://127.0.0.1:${port}`;

  const rootPair = await generateCgTrustRootKeyPair(1);
  const hpkePair = await generateHpkeKeyPair();
  const signingPair = await generateSigningKeyPair(true);
  const hpkeDescriptor = await createKeyDescriptor(hpkePair.publicKey);
  const signingDescriptor = await createKeyDescriptor(signingPair.publicKey);

  const cert = await issueCgServerIdentityCert({
    rootPrivateKey: rootPair.privateKey,
    rootPublic: rootPair.public,
    serverId: "cg-test-server",
    hpkeKey: hpkeDescriptor,
    signingKey: signingDescriptor,
    allowedOrigins: [origin]
  });

  const serverKeysResponse = cgServerKeysResponseSchema.parse({
    protocol: CG_MITM_PROTOCOL,
    kind: "server-keys",
    serverId: cert.serverId,
    epoch: cert.epoch,
    cert,
    previousCert: null,
    trustRoots: [rootPair.public],
    minSuite: CG_MITM_HPKE_SUITE,
    createdAt: new Date().toISOString()
  });

  const secure: CsapiSecureConfig = {
    enabled: true,
    requireSecure: false,
    serverCertId: cert.certId,
    serverEpoch: cert.epoch,
    serverId: cert.serverId,
    hpkePrivateKey: await importHpkePrivateKey(await exportPrivateJwk(hpkePair.privateKey)),
    hpkePublicJwk: await exportE2eePublicKey(hpkePair.publicKey),
    signingPrivateKey: await importSigningPrivateKey(await exportPrivateJwk(signingPair.privateKey)),
    signingKeyId: signingDescriptor.keyId,
    serverKeysResponse,
    currentCert: cert,
    previousCert: null,
    allowedOrigins: cert.allowedOrigins,
    padBuckets: [512, 2048, 8192, 32768, 131072]
  };

  const backend = new FakeBackend();
  const app = Fastify({ bodyLimit: 3 * 1024 * 1024 });
  registerCsapiSecure(app, {
    backend,
    config: {
      enabled: true,
      apiKeys: new Set([KEY]),
      defaultModel: "hermes:default",
      defaultWorkspaceId: "",
      maxConcurrencyPerKey: 8,
      runTimeoutMs: 5_000,
      allowWrites: false
    },
    pollIntervalMs: 5,
    secure
  });
  await app.listen({ host: "127.0.0.1", port });

  return {
    app,
    origin,
    root: rootPair.public,
    backend,
    close: async () => {
      await app.close();
    }
  };
}

function makeAdapterConfig(h: Harness, overrides: Partial<AdapterConfig> = {}): AdapterConfig {
  const dir = mkdtempSync(join(tmpdir(), "cg-adapter-"));
  return {
    listenHost: "127.0.0.1",
    listenPort: 0,
    loopbackKey: LOOPBACK,
    upstreamUrl: h.origin,
    apiKey: KEY,
    pinnedRootFingerprints: [h.root.fingerprint],
    minSuite: CG_MITM_HPKE_SUITE,
    padBuckets: [512, 2048, 8192, 32768, 131072],
    statePath: join(dir, "state.json"),
    ...overrides
  };
}

test("enroll + Anthropic non-stream exchange returns standard shape (ciphertext channel)", async () => {
  const h = await startSecureServer();
  try {
    const client = new SecureClient(makeAdapterConfig(h), new StateStore(makeAdapterConfig(h).statePath));
    await client.init();
    const body = await client.exchange({
      wire: "anthropic",
      body: { model: "claude-3-5-sonnet", max_tokens: 64, messages: [{ role: "user", content: "ping" }] },
      sessionKey: null,
      idempotencyKey: crypto.randomUUID()
    });
    assert.equal(body.type, "message");
    assert.match((body.content as Array<{ text: string }>)[0].text, /echo:.*ping/);
    assert.match(h.backend.lastPrompt ?? "", /ping/);
  } finally {
    await h.close();
  }
});

test("OpenAI non-stream exchange returns standard shape", async () => {
  const h = await startSecureServer();
  try {
    const client = new SecureClient(makeAdapterConfig(h), new StateStore(makeAdapterConfig(h).statePath));
    await client.init();
    const body = await client.exchange({
      wire: "openai",
      body: { model: "gpt-4o", messages: [{ role: "user", content: "hey" }] },
      sessionKey: null,
      idempotencyKey: crypto.randomUUID()
    });
    assert.equal(body.object, "chat.completion");
    assert.match((body.choices as Array<{ message: { content: string } }>)[0].message.content, /echo:.*hey/);
  } finally {
    await h.close();
  }
});

test("streaming exchange yields ordered ciphertext frames", async () => {
  const h = await startSecureServer();
  try {
    const client = new SecureClient(makeAdapterConfig(h), new StateStore(makeAdapterConfig(h).statePath));
    await client.init();
    const frames: string[] = [];
    let text = "";
    for await (const frame of client.exchangeStream({
      wire: "anthropic",
      body: { model: "auto", stream: true, messages: [{ role: "user", content: "streamme" }] },
      sessionKey: null,
      idempotencyKey: crypto.randomUUID()
    })) {
      frames.push(frame.frameType);
      if (frame.frameType === "delta") text += String(frame.data.text ?? "");
    }
    assert.equal(frames[0], "open");
    assert.equal(frames[frames.length - 1], "done");
    assert.ok(frames.includes("usage"));
    assert.match(text, /echo:.*streamme/);
  } finally {
    await h.close();
  }
});

test("concurrent streams are serialized on one strictly ordered session", async () => {
  const h = await startSecureServer();
  try {
    const cfg = makeAdapterConfig(h);
    const client = new SecureClient(cfg, new StateStore(cfg.statePath));
    await client.init();
    const consume = async (label: string) => {
      let text = "";
      for await (const frame of client.exchangeStream({
        wire: "openai",
        body: { model: "auto", stream: true, messages: [{ role: "user", content: label }] },
        sessionKey: null,
        idempotencyKey: crypto.randomUUID()
      })) {
        if (frame.frameType === "delta") text += String(frame.data.text ?? "");
      }
      return text;
    };

    const [first, second] = await Promise.all([consume("first"), consume("second")]);
    assert.match(first, /echo:.*first/);
    assert.match(second, /echo:.*second/);
  } finally {
    await h.close();
  }
});

test("facade end-to-end: CLI-style HTTP request through the loopback facade", async () => {
  const h = await startSecureServer();
  const cfg = makeAdapterConfig(h);
  const client = new SecureClient(cfg, new StateStore(cfg.statePath));
  await client.init();
  const facade = createFacade(cfg, client);
  const port = await getFreePort();
  await facade.listen({ host: "127.0.0.1", port });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": LOOPBACK },
      body: JSON.stringify({ model: "auto", max_tokens: 32, messages: [{ role: "user", content: "facade-ping" }] })
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { content: Array<{ text: string }> };
    assert.match(body.content[0].text, /echo:.*facade-ping/);

    // Streaming through the facade produces standard Anthropic SSE.
    const streamRes = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": LOOPBACK },
      body: JSON.stringify({ model: "auto", stream: true, messages: [{ role: "user", content: "facade-stream" }] })
    });
    const sseText = await streamRes.text();
    assert.match(sseText, /event: message_start/);
    assert.match(sseText, /event: content_block_delta/);
    assert.match(sseText, /facade-stream/);
    assert.match(sseText, /event: message_stop/);

    // Wrong loopback key → 401 locally, before any ciphertext is sent.
    const unauth = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "wrong" },
      body: JSON.stringify({ messages: [{ role: "user", content: "x" }] })
    });
    assert.equal(unauth.status, 401);
  } finally {
    await facade.close();
    await h.close();
  }
});

test("fail-closed: unpinned root fingerprint aborts init (no plaintext fallback)", async () => {
  const h = await startSecureServer();
  try {
    const cfg = makeAdapterConfig(h, { pinnedRootFingerprints: ["sha256:" + "A".repeat(43)] });
    const client = new SecureClient(cfg, new StateStore(cfg.statePath));
    await assert.rejects(
      () => client.init(),
      (err: unknown) => err instanceof FailClosedError && err.reason === "root_fingerprint_not_pinned"
    );
  } finally {
    await h.close();
  }
});

test("fail-closed: forged server (self-signed cert, unknown root) is rejected", async () => {
  const h = await startSecureServer();
  // Stand up a rogue server on another port that serves a cert signed by a
  // DIFFERENT (attacker) root, but advertises the victim's pinned fingerprint.
  const roguePort = await getFreePort();
  const rogueOrigin = `http://127.0.0.1:${roguePort}`;
  const attackerRoot = await generateCgTrustRootKeyPair(1);
  const hpkePair = await generateHpkeKeyPair();
  const signingPair = await generateSigningKeyPair(true);
  const cert = await issueCgServerIdentityCert({
    rootPrivateKey: attackerRoot.privateKey,
    rootPublic: attackerRoot.public,
    serverId: "cg-test-server",
    hpkeKey: await createKeyDescriptor(hpkePair.publicKey),
    signingKey: await createKeyDescriptor(signingPair.publicKey),
    allowedOrigins: [rogueOrigin]
  });
  // Forge trustRoots to CLAIM the victim fingerprint while keeping attacker key.
  const forgedRoot = { ...attackerRoot.public, fingerprint: h.root.fingerprint };
  const rogue = Fastify();
  rogue.get("/cg/v1/server-keys", (_req, reply) =>
    reply.send({
      protocol: CG_MITM_PROTOCOL,
      kind: "server-keys",
      serverId: cert.serverId,
      epoch: cert.epoch,
      cert,
      previousCert: null,
      trustRoots: [forgedRoot],
      minSuite: CG_MITM_HPKE_SUITE,
      createdAt: new Date().toISOString()
    })
  );
  await rogue.listen({ host: "127.0.0.1", port: roguePort });
  try {
    const cfg = makeAdapterConfig(h, { upstreamUrl: rogueOrigin, pinnedRootFingerprints: [h.root.fingerprint] });
    const client = new SecureClient(cfg, new StateStore(cfg.statePath));
    // The forged root's fingerprint matches, but the cert signature won't verify
    // against the (real) pinned key material → fail-closed.
    await assert.rejects(() => client.init(), (err: unknown) => err instanceof FailClosedError);
  } finally {
    await rogue.close();
    await h.close();
  }
});

test("wrong API key → authentication_error surfaced as 401 through the envelope", async () => {
  const h = await startSecureServer();
  try {
    const cfg = makeAdapterConfig(h, { apiKey: "not-the-real-key" });
    const client = new SecureClient(cfg, new StateStore(cfg.statePath));
    // Enrollment itself requires a valid apiKey, so init() fails closed here.
    await assert.rejects(
      () => client.init(),
      (err: unknown) => err instanceof FailClosedError && err.reason === "enroll_unauthorized"
    );
  } finally {
    await h.close();
  }
});

test("A1 wire is ciphertext + A6 no apiKey in headers; A2 tamper + A3 replay rejected", async () => {
  const h = await startSecureServer();
  const cfg = makeAdapterConfig(h);
  let lastExchangeBody: string | null = null;
  let lastHeaders: Record<string, string> = {};
  const capturingFetch: typeof fetch = async (input, init) => {
    if (typeof input === "string" && input.endsWith("/cg/v1/exchange") && init?.method === "POST") {
      lastExchangeBody = String(init.body);
      lastHeaders = (init.headers as Record<string, string>) ?? {};
    }
    return fetch(input as string, init);
  };
  const client = new SecureClient(cfg, new StateStore(cfg.statePath), capturingFetch);
  try {
    await client.init();
    await client.exchange({
      wire: "anthropic",
      body: { model: "auto", messages: [{ role: "user", content: "tamper-src-SECRETPROMPT" }] },
      sessionKey: null,
      idempotencyKey: crypto.randomUUID()
    });
    assert.ok(lastExchangeBody, "captured an exchange body");

    // A6: the real csapi apiKey never appears in any upstream HTTP header.
    const headerBlob = JSON.stringify(lastHeaders).toLowerCase();
    assert.ok(!headerBlob.includes(KEY.toLowerCase()), "apiKey must not be in headers");
    assert.ok(!("x-api-key" in lastHeaders) && !("authorization" in lastHeaders), "no auth headers");
    // A1: the plaintext prompt and apiKey are NOT present on the wire (ciphertext).
    assert.ok(!lastExchangeBody!.includes(KEY), "apiKey must not be on the wire");
    assert.ok(!lastExchangeBody!.includes("SECRETPROMPT"), "prompt must not be on the wire");
    assert.match(lastExchangeBody!, /"payload":\{"alg":"A256GCM"/, "wire carries AEAD ciphertext");
    const env = JSON.parse(lastExchangeBody!) as {
      payload: { ciphertext: string };
      sequence: number;
    };

    // A3 replay: resend the exact captured envelope → sequence already seen.
    const replay = await fetch(`${h.origin}/cg/v1/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: lastExchangeBody!
    });
    const replayJson = (await replay.json()) as { kind: string; reason: string };
    assert.equal(replayJson.kind, "secure-error");
    assert.equal(replayJson.reason, "c2s_sequence_replayed");

    // A2 tamper: flip a ciphertext char and bump the sequence so it isn't a
    // replay → AEAD open must fail.
    const tampered = { ...env, sequence: env.sequence + 5 };
    const ct = env.payload.ciphertext;
    const flipped = (ct[0] === "A" ? "B" : "A") + ct.slice(1);
    tampered.payload = { ...env.payload, ciphertext: flipped };
    const tamperRes = await fetch(`${h.origin}/cg/v1/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(tampered)
    });
    const tamperJson = (await tamperRes.json()) as { kind: string; reason: string };
    assert.equal(tamperJson.kind, "secure-error");
    assert.equal(tamperJson.reason, "c2s_decrypt_failed");
  } finally {
    await h.close();
  }
});
