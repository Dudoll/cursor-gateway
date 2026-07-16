// cg-mitm/1 secure csapi endpoints (/cg/v1/*). Application-layer anti-MITM channel
// on top of the plaintext csapi facade. See docs/cg-mitm-spec/02-server-secure.md.
import {
  createDecipheriv,
  scryptSync
} from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  CG_MITM_PROTOCOL,
  cgCancelInnerSchema,
  cgCancelRequestSchema,
  cgEnrollInnerSchema,
  cgEnrollRequestSchema,
  cgExchangeInnerSchema,
  cgExchangeRequestSchema,
  cgRevokeInnerSchema,
  cgRevokeRequestSchema,
  cgServerIdentityCertSchema,
  cgServerKeysResponseSchema,
  cgSyncInnerSchema,
  cgSyncRequestSchema,
  type CgDeviceCert,
  type CgExchangeInner,
  type CgExchangeRequest,
  type CgFrameType,
  type CgServerIdentityCert,
  type CgServerKeysResponse,
  type E2eeCiphertext,
  type E2eePublicKey
} from "@cursor-gateway/shared";
import {
  buildC2sAad,
  buildCgDeviceAuthTranscript,
  buildEnrollAad,
  buildEnrollContext,
  buildHandshakeContext,
  buildS2cAad,
  C2S_PURPOSE,
  decodeBase64Url,
  decryptJson,
  encodeBase64Url,
  encryptJson,
  ENROLL_PURPOSE,
  FileMasterKeyProvider,
  importHpkePrivateKey,
  importSigningPrivateKey,
  importSigningPublicKey,
  issueCgDeviceCert,
  issueCgDeviceCertV2,
  MemoryKmsProvider,
  S2C_PURPOSE,
  unwrapRootKey,
  verifyValue,
  type KmsProvider
} from "@cursor-gateway/e2ee";
import {
  CgDeviceStatusCache,
  getCgDevice,
  revokeCgDevice,
  touchCgDevice,
  upsertCgDevice
} from "../cgDevicesDb.js";
import {
  appendRelayMessage,
  archiveRelayConversation,
  bumpAccountKekEpoch,
  ensureAccountKek,
  listRelayConversations,
  listRelayMessages,
  softDeleteRelayConversation
} from "../csRelayHistory.js";
import { resolveAccountAuth } from "./accountAuth.js";
import { createCgEnrollChallenge } from "./passkeyEnroll.js";
import { CsRelayExecuteError, executeCsRelayReencrypt } from "./csRelayExecute.js";
import { subscribeSyncAccount } from "./syncBus.js";
import { loadCgTrustRoots } from "../cgTrustRoots.js";
import { config as appConfig } from "../config.js";
import type { CsapiDeps } from "./server.js";
import { createCsapi } from "./server.js";
import {
  buildAnthropicResponse,
  buildOpenAiResponse,
  chunkText,
  extractSystem,
  matchApiKey,
  normalizeMessages
} from "./protocol.js";

const MASTER_MAGIC = "CG-E2EE-SCRYPT-AESGCM-v1";
const SCRYPT_PARAMS = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

export class CgSecureError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "CgSecureError";
  }
}

export interface CsapiSecureConfig {
  enabled: boolean;
  requireSecure: boolean;
  serverCertId: string;
  serverEpoch: number;
  serverId: string;
  hpkePrivateKey: CryptoKey;
  hpkePublicJwk: E2eePublicKey;
  signingPrivateKey: CryptoKey;
  signingKeyId: string;
  serverKeysResponse: CgServerKeysResponse;
  currentCert: CgServerIdentityCert;
  previousCert: CgServerIdentityCert | null;
  allowedOrigins: string[];
  padBuckets: number[];
}

export interface CsapiSecureDeps extends CsapiDeps {
  secure: CsapiSecureConfig;
}

interface SecureSession {
  sessionId: string;
  deviceId: string;
  accountId: string | null;
  sessionRoot: CryptoKey;
  lastC2sSeq: number;
  lastS2cSeq: number;
  createdAt: number;
}

interface CompletedRunLike {
  text: string;
  inputTokens: number;
  outputTokens: number;
  runId: string;
  conversationId: string;
}

function openWithMasterKey(stored: Uint8Array, masterKey: string): Uint8Array {
  const [magic, saltB64, ivB64, blobB64] = new TextDecoder().decode(stored).split("\n");
  if (magic !== MASTER_MAGIC || !saltB64 || !ivB64 || !blobB64) {
    throw new Error("invalid_sealed_file_format");
  }
  const salt = Buffer.from(saltB64, "base64");
  const iv = Buffer.from(ivB64, "base64");
  const blob = Buffer.from(blobB64, "base64");
  const ciphertext = blob.subarray(0, blob.length - 16);
  const tag = blob.subarray(blob.length - 16);
  const key = scryptSync(Buffer.from(masterKey, "utf8"), salt, 32, SCRYPT_PARAMS);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  try {
    return new Uint8Array(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
  } finally {
    key.fill(0);
  }
}

function resolveMasterKey(): string | undefined {
  const inline = appConfig.cg.masterKey.trim();
  if (inline.length >= 16) return inline;
  const filePath = appConfig.cg.masterKeyFile.trim();
  if (!filePath || !existsSync(filePath)) return undefined;
  const fromFile = readFileSync(filePath, "utf8").trim();
  return fromFile.length >= 16 ? fromFile : undefined;
}

function readPrivateJwkFile(path: string): JsonWebKey {
  const raw = readFileSync(path);
  const preview = raw.subarray(0, Math.min(raw.length, MASTER_MAGIC.length)).toString("utf8");
  let plaintext: Uint8Array;
  if (preview === MASTER_MAGIC) {
    const masterKey = resolveMasterKey();
    if (!masterKey) throw new Error("cg_master_key_required_for_sealed_key_file");
    plaintext = openWithMasterKey(raw, masterKey);
  } else {
    plaintext = raw;
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as { privateJwk?: JsonWebKey };
    if (!parsed.privateJwk || typeof parsed.privateJwk !== "object") {
      throw new Error("invalid_private_key_file");
    }
    return parsed.privateJwk;
  } finally {
    plaintext.fill(0);
  }
}

function parsePadBuckets(value: string): number[] {
  const buckets = value
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  return buckets.length > 0 ? buckets : [512, 2048, 8192, 32768, 131072];
}

function withPad<T extends Record<string, unknown>>(value: T, buckets: number[]): T {
  const json = JSON.stringify(value);
  const target = buckets.find((bucket) => bucket >= json.length) ?? buckets[buckets.length - 1]!;
  const padLen = Math.max(0, target - json.length);
  return padLen > 0 ? { ...value, pad: "0".repeat(padLen) } : value;
}

async function sha256(value: Uint8Array): Promise<Uint8Array> {
  const buf = new Uint8Array(value.byteLength);
  buf.set(value);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", buf.buffer));
}

function isAcceptedServerCert(
  cfg: CsapiSecureConfig,
  serverCertId: string,
  epoch: number
): boolean {
  if (serverCertId === cfg.currentCert.certId && epoch === cfg.currentCert.epoch) return true;
  if (
    cfg.previousCert &&
    serverCertId === cfg.previousCert.certId &&
    epoch === cfg.previousCert.epoch
  ) {
    return true;
  }
  return false;
}

function cgReason(error: unknown): string {
  if (error instanceof CgSecureError) return error.reason;
  if (error instanceof Error) {
    const msg = error.message.trim();
    // Map plain Error reasons thrown by helpers (accountAuth, history, devices).
    if (/^[a-z][a-z0-9_]{1,127}$/.test(msg)) return msg;
  }
  return "internal_error";
}

function sendCgError(reply: FastifyReply, reason: string, status = 400) {
  return reply.code(status).send({
    protocol: CG_MITM_PROTOCOL,
    kind: "secure-error",
    reason,
    createdAt: new Date().toISOString()
  });
}

function toExecuteInput(
  keyId: string,
  inner: CgExchangeInner,
  deps: CsapiSecureDeps,
  signal?: AbortSignal
) {
  const body = inner.body as Record<string, unknown>;
  const messages = normalizeMessages(body.messages);
  return {
    keyId,
    system: inner.wire === "anthropic" ? extractSystem(body.system) : "",
    messages,
    requestedModel: typeof body.model === "string" ? body.model : deps.config.defaultModel,
    sessionKey: inner.sessionKey,
    ...(signal ? { signal } : {})
  };
}

function modelOf(inner: CgExchangeInner): string {
  const body = inner.body as Record<string, unknown>;
  return typeof body.model === "string" && body.model ? body.model : "auto";
}

export async function loadCgSecureConfig(): Promise<CsapiSecureConfig | null> {
  if (!appConfig.cg.secureEnabled) return null;

  const certPath = appConfig.cg.serverCertFile.trim();
  const hpkePath = appConfig.cg.serverHpkeKeyFile.trim();
  const signingPath = appConfig.cg.serverSigningKeyFile.trim();
  if (!certPath || !hpkePath || !signingPath) {
    console.warn(
      "[cg-secure] CG_SECURE_ENABLED but CG_SERVER_CERT_FILE / CG_SERVER_HPKE_KEY_FILE / " +
        "CG_SERVER_SIGNING_KEY_FILE not all set; secure routes will not mount"
    );
    return null;
  }
  if (!existsSync(certPath) || !existsSync(hpkePath) || !existsSync(signingPath)) {
    console.warn("[cg-secure] One or more cg secure key/cert files are missing; routes will not mount");
    return null;
  }

  const trustRoots = loadCgTrustRoots();
  if (trustRoots.length === 0) {
    console.warn("[cg-secure] No cg trust roots configured (CG_TRUST_ROOTS_FILE / JSON); routes will not mount");
    return null;
  }

  const currentCert = cgServerIdentityCertSchema.parse(JSON.parse(readFileSync(certPath, "utf8")));
  const previousPath = appConfig.cg.previousServerCertFile.trim();
  const previousCert =
    previousPath && existsSync(previousPath)
      ? cgServerIdentityCertSchema.parse(JSON.parse(readFileSync(previousPath, "utf8")))
      : null;

  const hpkePrivateJwk = readPrivateJwkFile(hpkePath);
  const signingPrivateJwk = readPrivateJwkFile(signingPath);
  const hpkePrivateKey = await importHpkePrivateKey(hpkePrivateJwk);
  const signingPrivateKey = await importSigningPrivateKey(signingPrivateJwk);

  const hpkePublicJwk = currentCert.hpkeKey.publicKey;
  const signingKeyId = currentCert.signingKey.keyId;
  const serverKeysResponse = cgServerKeysResponseSchema.parse({
    protocol: CG_MITM_PROTOCOL,
    kind: "server-keys",
    serverId: currentCert.serverId,
    epoch: currentCert.epoch,
    cert: currentCert,
    previousCert,
    trustRoots,
    minSuite: "HPKE-v1-P256-HKDF-SHA256-A256GCM",
    createdAt: new Date().toISOString()
  });

  return {
    enabled: true,
    requireSecure: appConfig.cg.requireSecure,
    serverCertId: currentCert.certId,
    serverEpoch: currentCert.epoch,
    serverId: currentCert.serverId,
    hpkePrivateKey,
    hpkePublicJwk,
    signingPrivateKey,
    signingKeyId,
    serverKeysResponse,
    currentCert,
    previousCert,
    allowedOrigins: currentCert.allowedOrigins,
    padBuckets: parsePadBuckets(appConfig.cg.padBuckets)
  };
}

function resolveKmsProvider(): KmsProvider | null {
  if (appConfig.csRelay.httpNoKms && !appConfig.csRelay.decryptorOnly) {
    return null;
  }
  const relayFile = appConfig.csRelay.masterKeyFile.trim();
  const master =
    (relayFile && existsSync(relayFile)
      ? readFileSync(relayFile, "utf8").trim()
      : "") ||
    appConfig.cg.masterKey.trim() ||
    (appConfig.cg.masterKeyFile.trim() && existsSync(appConfig.cg.masterKeyFile)
      ? readFileSync(appConfig.cg.masterKeyFile, "utf8").trim()
      : "");
  if (master.length >= 16) {
    return new FileMasterKeyProvider(appConfig.csRelay.kmsKeyId, master);
  }
  if (appConfig.csRelay.historyEnabled && appConfig.nodeEnv === "production") {
    throw new Error("cs_relay_master_key_required");
  }
  // Dev/test fallback only when history is off or non-production.
  return new MemoryKmsProvider(appConfig.csRelay.kmsKeyId || "memory-kms-1");
}

async function sleepJitter(ms: number): Promise<void> {
  if (ms <= 0) return;
  const delay = Math.floor(Math.random() * (ms + 1));
  await new Promise((r) => setTimeout(r, delay));
}

export function createCsapiSecure(deps: CsapiSecureDeps) {
  const csapi = createCsapi(deps);
  const cfg = deps.secure;
  const kms = resolveKmsProvider();
  function requireKms(): KmsProvider {
    if (!kms) throw new CgSecureError("kms_unavailable_http_front");
    return kms;
  }
  const deviceStatusCache = new CgDeviceStatusCache(30_000);

  const sessions = new Map<string, SecureSession>();
  const usedEnc = new Set<string>();
  const deviceCerts = new Map<string, CgDeviceCert>();
  const idempotency = new Map<string, CompletedRunLike>();
  // idempotencyKey -> in-flight AbortController, so /cg/v1/cancel and client
  // disconnects can abort the underlying execute().
  const inflight = new Map<string, AbortController>();

  function fail(reason: string): never {
    throw new CgSecureError(reason);
  }

  async function loadDeviceCert(deviceId: string): Promise<{
    cert: CgDeviceCert;
    accountId: string | null;
  }> {
    const cached = deviceCerts.get(deviceId);
    if (cached) {
      const accountId =
        cached.kind === "cg-device-cert/2" ? cached.accountId : null;
      if (appConfig.csRelay.accountBinding && accountId) {
        try {
          const active = await deviceStatusCache.requireActive(deviceId);
          return { cert: active.cert, accountId: active.accountId };
        } catch (error) {
          const reason = error instanceof Error ? error.message : "";
          if (reason === "device_revoked") fail("device_revoked");
          const allowMemory =
            appConfig.csRelay.allowMemoryDevices || appConfig.nodeEnv !== "production";
          if (reason === "device_not_enrolled" && allowMemory) {
            return { cert: cached, accountId };
          }
          if (allowMemory) {
            console.warn("[cg-secure] device status check failed; using memory cert", reason);
            return { cert: cached, accountId };
          }
          fail(reason === "device_not_enrolled" ? "device_not_enrolled" : "device_status_unavailable");
        }
      }
      return { cert: cached, accountId };
    }
    if (appConfig.csRelay.accountBinding) {
      try {
        const active = await deviceStatusCache.requireActive(deviceId);
        deviceCerts.set(deviceId, active.cert);
        return { cert: active.cert, accountId: active.accountId };
      } catch (error) {
        const reason = error instanceof Error ? error.message : "device_not_enrolled";
        if (reason === "device_revoked") fail("device_revoked");
        fail("device_not_enrolled");
      }
    }
    fail("device_not_enrolled");
  }

  async function ensureSession(env: CgExchangeRequest): Promise<SecureSession> {
    const existing = sessions.get(env.sessionId);
    if (existing) return existing;
    if (!env.enc) fail("handshake_missing_enc");

    const encFp = encodeBase64Url(await sha256(decodeBase64Url(env.enc.enc)));
    if (usedEnc.has(encFp)) fail("handshake_enc_replayed");

    const handshakeContext = buildHandshakeContext({
      serverCertId: env.serverCertId,
      epoch: env.epoch,
      deviceId: env.deviceId,
      adapterNonce: env.sessionId,
      minSuite: cfg.serverKeysResponse.minSuite
    });
    if (!isAcceptedServerCert(cfg, env.serverCertId, env.epoch)) {
      fail("server_cert_epoch_rejected");
    }

    let sessionRoot: CryptoKey;
    try {
      sessionRoot = await unwrapRootKey(
        env.enc,
        cfg.hpkePrivateKey,
        cfg.hpkePublicJwk,
        handshakeContext
      );
    } catch {
      fail("handshake_unwrap_failed");
    }

    const session: SecureSession = {
      sessionId: env.sessionId,
      deviceId: env.deviceId,
      accountId: null,
      sessionRoot,
      lastC2sSeq: 0,
      lastS2cSeq: 0,
      createdAt: Date.now()
    };
    usedEnc.add(encFp);
    sessions.set(env.sessionId, session);
    return session;
  }

  function checkC2sSequence(session: SecureSession, sequence: number): void {
    if (sequence <= session.lastC2sSeq) fail("c2s_sequence_replayed");
    session.lastC2sSeq = sequence;
  }

  async function openC2s(
    session: SecureSession,
    env: { sessionId: string; sequence: number; payload: E2eeCiphertext; kind: string }
  ): Promise<unknown> {
    const aad = buildC2sAad({ sessionId: env.sessionId, sequence: env.sequence, kind: env.kind });
    try {
      return await decryptJson(session.sessionRoot, C2S_PURPOSE, aad, env.payload);
    } catch {
      fail("c2s_decrypt_failed");
    }
  }

  async function sealS2c(
    session: SecureSession,
    frameType: string,
    value: unknown
  ): Promise<E2eeCiphertext> {
    const sequence = ++session.lastS2cSeq;
    const aad = buildS2cAad({ sessionId: session.sessionId, sequence, frameType });
    return encryptJson(session.sessionRoot, S2C_PURPOSE, aad, withPad(value as Record<string, unknown>, cfg.padBuckets));
  }

  function beginCgStream(reply: FastifyReply): void {
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });
    reply.hijack();
  }

  // Seal one ciphertext SSE frame and write it as `event: cg / data: <json>`.
  // The cleartext wire frame carries sessionId/sequence/frameType so the Adapter
  // can rebuild the AAD before decrypting; the AEAD binds all three.
  async function writeCgFrame(
    reply: FastifyReply,
    session: SecureSession,
    frameType: CgFrameType,
    data: Record<string, unknown>
  ): Promise<void> {
    const sequence = ++session.lastS2cSeq;
    const aad = buildS2cAad({ sessionId: session.sessionId, sequence, frameType });
    const inner = withPad(
      { kind: "sse-frame-inner", frameType, sequence, data } as Record<string, unknown>,
      cfg.padBuckets
    );
    const payload = await encryptJson(session.sessionRoot, S2C_PURPOSE, aad, inner);
    const frame = {
      protocol: CG_MITM_PROTOCOL,
      kind: "sse-frame",
      sessionId: session.sessionId,
      sequence,
      frameType,
      payload
    };
    reply.raw.write(`event: cg\ndata: ${JSON.stringify(frame)}\n\n`);
  }

  function writeCgHeartbeat(reply: FastifyReply): void {
    reply.raw.write(": keepalive\n\n");
  }

  async function verifyDeviceAuth(
    env: { sessionId: string; deviceId: string; sequence: number; idempotencyKey?: string },
    deviceAuth: { keyId: string; alg: string; value: string },
    session?: SecureSession
  ): Promise<{ accountId: string | null; cert: CgDeviceCert }> {
    const loaded = await loadDeviceCert(env.deviceId);
    const deviceCert = loaded.cert;
    if (deviceAuth.keyId !== deviceCert.signingKey.keyId) fail("device_auth_key_mismatch");
    const pub = await importSigningPublicKey(deviceCert.signingKey.publicKey);
    const transcript = buildCgDeviceAuthTranscript({
      sessionId: env.sessionId,
      deviceId: env.deviceId,
      sequence: env.sequence,
      idempotencyKey: env.idempotencyKey ?? "00000000-0000-0000-0000-000000000000"
    });
    const valid = await verifyValue(transcript, deviceAuth as never, pub);
    if (!valid) fail("device_auth_invalid");
    if (session) session.accountId = loaded.accountId;
    void touchCgDevice(env.deviceId).catch(() => undefined);
    return loaded;
  }

  async function maybePersistExchangeHistory(input: {
    accountId: string | null;
    conversationId: string;
    userText: string;
    assistantText: string;
    idempotencyKey: string;
  }): Promise<void> {
    if (!appConfig.csRelay.historyEnabled || !input.accountId) return;
    try {
      const k = requireKms();
      await ensureAccountKek(k, input.accountId);
      await appendRelayMessage({
        kms: k,
        accountId: input.accountId,
        conversationId: input.conversationId,
        role: "user",
        text: input.userText,
        idempotencyKey: input.idempotencyKey
      });
      await appendRelayMessage({
        kms: k,
        accountId: input.accountId,
        conversationId: input.conversationId,
        role: "assistant",
        text: input.assistantText
      });
    } catch (error) {
      console.warn("[cg-secure] relay history persist failed", error);
    }
  }

  /**
   * Execute after cg-mitm decrypt. When CS_RELAY_RUNNER_REENCRYPT is on, CS
   * re-wraps for an online e2ee runner (queue stores ciphertext only).
   * History conversation ids stay on the plaintext/cs-relay path for sync.
   */
  async function executeAfterDecrypt(
    keyId: string,
    inner: CgExchangeInner,
    signal: AbortSignal
  ): Promise<CompletedRunLike> {
    if (!appConfig.csRelay.runnerReencrypt) {
      return csapi.execute(toExecuteInput(keyId, inner, deps, signal));
    }
    const body = inner.body as Record<string, unknown>;
    const messages = normalizeMessages(body.messages);
    const principalId = await deps.backend.getPrincipalId();
    const workspaceId = await deps.backend.pickWorkspaceId(
      deps.config.defaultWorkspaceId || undefined
    );
    if (!workspaceId) {
      throw new CgSecureError("no_workspace_available");
    }
    const title = (() => {
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      return (lastUser?.text ?? "csapi").slice(0, 80);
    })();
    // Keep a history conversation id separate from the e2ee queue conversation.
    let historyConversationId: string;
    if (inner.sessionKey) {
      const mapKey = `${keyId}:${inner.sessionKey}`;
      const remembered = (csapi as { sessionConversations: Map<string, string> })
        .sessionConversations;
      const existing = remembered.get(mapKey);
      if (existing && (await deps.backend.conversationExists(existing, principalId))) {
        historyConversationId = existing;
      } else {
        historyConversationId = await deps.backend.createConversation({
          principalId,
          workspaceId,
          title
        });
        remembered.set(mapKey, historyConversationId);
      }
    } else {
      historyConversationId = await deps.backend.createConversation({
        principalId,
        workspaceId,
        title
      });
    }
    const system = inner.wire === "anthropic" ? extractSystem(body.system) : "";
    const turns = [
      ...(system
        ? [{ role: "system" as const, content: system }]
        : []),
      ...messages.map((m) => ({
        role: m.role as "user" | "assistant" | "system",
        content: m.text
      }))
    ];
    try {
      const sealed = await executeCsRelayReencrypt({
        principalId,
        workspaceId,
        model:
          typeof body.model === "string" && body.model
            ? body.model
            : deps.config.defaultModel,
        turns,
        csSigningPrivateKey: cfg.signingPrivateKey,
        csSigningKeyId: cfg.signingKeyId,
        allowWrites: deps.config.allowWrites,
        signal,
        timeoutMs: deps.config.runTimeoutMs
      });
      return {
        text: sealed.text,
        inputTokens: sealed.inputTokens,
        outputTokens: sealed.outputTokens,
        runId: sealed.runId,
        conversationId: historyConversationId
      };
    } catch (error) {
      if (error instanceof CsRelayExecuteError) {
        throw new CgSecureError(error.reason);
      }
      throw error;
    }
  }

  return {
    async handleServerKeys(_request: FastifyRequest, reply: FastifyReply) {
      return reply.send(cgServerKeysResponseSchema.parse(cfg.serverKeysResponse));
    },

    async handleEnroll(request: FastifyRequest, reply: FastifyReply) {
      reply.header("cache-control", "no-store");
      let env;
      try {
        env = cgEnrollRequestSchema.parse(request.body);
      } catch {
        return sendCgError(reply, "malformed_envelope");
      }
      if (!isAcceptedServerCert(cfg, env.serverCertId, env.epoch)) {
        return sendCgError(reply, "server_cert_epoch_rejected");
      }

      try {
        const enrollRoot = await unwrapRootKey(
          env.enc,
          cfg.hpkePrivateKey,
          cfg.hpkePublicJwk,
          buildEnrollContext(env)
        );
        const inner = cgEnrollInnerSchema.parse(
          await decryptJson(enrollRoot, ENROLL_PURPOSE, buildEnrollAad(env), env.payload)
        );

        let deviceCert: CgDeviceCert;
        let deviceId: string;
        let accountId: string | null = null;
        let keyIdHint = "unknown";

        if (appConfig.csRelay.accountBinding) {
          const resolved = await resolveAccountAuth({
            ...(inner.accountAuth ? { accountAuth: inner.accountAuth } : {}),
            ...(inner.apiKey ? { apiKey: inner.apiKey } : {}),
            apiKeys: deps.config.apiKeys,
            allowApiKeyTransition: appConfig.csRelay.allowMemoryDevices || appConfig.nodeEnv !== "production"
          });
          accountId = resolved.accountId;
          keyIdHint = resolved.keyIdHint;
          deviceId = crypto.randomUUID();
          deviceCert = await issueCgDeviceCertV2({
            signingPrivateKey: cfg.signingPrivateKey,
            signingKeyId: cfg.signingKeyId,
            accountId: resolved.accountId,
            deviceId,
            epoch: 1,
            authScope: resolved.authScope,
            signingKey: inner.deviceSigningKey,
            encryptionKey: inner.deviceEncryptionKey,
            keyIdHint: resolved.keyIdHint,
            serverCertId: cfg.serverCertId
          });
          deviceCerts.set(deviceId, deviceCert);
          try {
            await upsertCgDevice({
              deviceId,
              accountId: resolved.accountId,
              signingFingerprint: inner.deviceSigningKey.fingerprint,
              encryptionFingerprint: inner.deviceEncryptionKey.fingerprint,
              deviceCert,
              epoch: 1,
              label: inner.label
            });
            if (appConfig.csRelay.historyEnabled) {
              await ensureAccountKek(requireKms(), resolved.accountId);
            }
          } catch (persistError) {
            const allowMemory =
              appConfig.csRelay.allowMemoryDevices || appConfig.nodeEnv !== "production";
            if (!allowMemory) {
              throw persistError instanceof Error
                ? persistError
                : new Error("device_persist_failed");
            }
            console.warn("[cg-secure] cg_devices persist failed; memory-only device (test mode)", persistError);
          }
        } else {
          if (!inner.apiKey) return sendCgError(reply, "enroll_unauthorized");
          const keyId = matchApiKey(inner.apiKey, deps.config.apiKeys);
          if (!keyId) return sendCgError(reply, "enroll_unauthorized");
          keyIdHint = keyId;
          deviceId = crypto.randomUUID();
          deviceCert = await issueCgDeviceCert({
            signingPrivateKey: cfg.signingPrivateKey,
            signingKeyId: cfg.signingKeyId,
            deviceId,
            signingKey: inner.deviceSigningKey,
            encryptionKey: inner.deviceEncryptionKey,
            keyIdHint: keyId,
            serverCertId: cfg.serverCertId
          });
          deviceCerts.set(deviceId, deviceCert);
        }

        await deps.backend.audit({
          eventType: "cg_enroll",
          details: {
            deviceId,
            keyId: keyIdHint,
            accountId,
            authScope: deviceCert.kind === "cg-device-cert/2" ? deviceCert.authScope : "legacy-v1"
          }
        });

        const payload = await encryptJson(enrollRoot, ENROLL_PURPOSE, buildEnrollAad(env), {
          deviceCert
        });
        return reply.send({
          protocol: CG_MITM_PROTOCOL,
          kind: "enroll-response",
          status: "enrolled",
          deviceCert,
          payload,
          createdAt: new Date().toISOString()
        });
      } catch (error) {
        return sendCgError(reply, cgReason(error));
      }
    },

    async handleEnrollChallenge(request: FastifyRequest, reply: FastifyReply) {
      reply.header("cache-control", "no-store");
      const rpId = appConfig.csRelay.webauthnRpId || new URL(appConfig.publicOrigin).hostname;
      const origins = appConfig.csRelay.webauthnOrigins.size
        ? [...appConfig.csRelay.webauthnOrigins]
        : [appConfig.publicOrigin];
      try {
        const body = (request.body ?? {}) as { accountIdHint?: string };
        const challenge = await createCgEnrollChallenge({
          accountIdHint: body.accountIdHint ?? null,
          rpId,
          origins
        });
        return reply.send({
          protocol: CG_MITM_PROTOCOL,
          kind: "enroll-challenge",
          ...challenge
        });
      } catch (error) {
        return sendCgError(reply, cgReason(error));
      }
    },

    async handleExchange(request: FastifyRequest, reply: FastifyReply) {
      let env: CgExchangeRequest;
      try {
        env = cgExchangeRequestSchema.parse(request.body);
      } catch {
        return sendCgError(reply, "malformed_envelope");
      }

      // --- pre-flight: handshake, decrypt, auth (all fail-closed before we
      // commit to a streaming response so errors stay plain JSON) ---
      let session: SecureSession;
      let inner: CgExchangeInner;
      let keyId: string;
      try {
        session = await ensureSession(env);
        checkC2sSequence(session, env.sequence);
        inner = cgExchangeInnerSchema.parse(
          await openC2s(session, { ...env, kind: "exchange-request" })
        );
        const device = await verifyDeviceAuth(env, inner.deviceAuth, session);
        session.accountId = device.accountId;
        // Exchange still requires a valid csapi apiKey (inner ciphertext). Device
        // cert binds accountId for history/sync; apiKey remains the execute ACL.
        const matched = matchApiKey(inner.apiKey, deps.config.apiKeys);
        if (!matched) return sendCgError(reply, "authentication_error");
        keyId = matched;
      } catch (error) {
        return sendCgError(reply, cgReason(error));
      }

      const cached = idempotency.get(env.idempotencyKey);
      const body = inner.body as Record<string, unknown>;
      const wantsStream = body.stream === true;

      const abort = new AbortController();
      inflight.set(env.idempotencyKey, abort);
      const cleanup = () => {
        if (inflight.get(env.idempotencyKey) === abort) inflight.delete(env.idempotencyKey);
      };

      if (!wantsStream) {
        try {
          const result =
            cached ?? (await executeAfterDecrypt(keyId, inner, abort.signal));
          idempotency.set(env.idempotencyKey, result);

          const userText = (() => {
            const messages = normalizeMessages(
              (inner.body as Record<string, unknown>).messages
            );
            const lastUser = [...messages].reverse().find((m) => m.role === "user");
            return lastUser?.text ?? "";
          })();
          await maybePersistExchangeHistory({
            accountId: session.accountId,
            conversationId: result.conversationId,
            userText,
            assistantText: result.text,
            idempotencyKey: env.idempotencyKey
          });
          await sleepJitter(appConfig.csRelay.sendJitterMs);

          const responseBody =
            inner.wire === "anthropic"
              ? buildAnthropicResponse({
                  id: `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
                  model: modelOf(inner),
                  text: result.text,
                  inputTokens: result.inputTokens,
                  outputTokens: result.outputTokens
                })
              : buildOpenAiResponse({
                  id: `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
                  model: modelOf(inner),
                  text: result.text,
                  inputTokens: result.inputTokens,
                  outputTokens: result.outputTokens
                });

          const payload = await sealS2c(session, "done", {
            kind: "response-inner",
            ok: true,
            httpStatus: 200,
            wire: inner.wire,
            body: responseBody
          });
          return reply.send({
            protocol: CG_MITM_PROTOCOL,
            kind: "exchange-response",
            sessionId: session.sessionId,
            sequence: session.lastS2cSeq,
            createdAt: new Date().toISOString(),
            payload
          });
        } catch (error) {
          return sendCgError(reply, cgReason(error));
        } finally {
          cleanup();
        }
      }

      // --- ciphertext SSE: open → delta* → usage → done (or error) ---
      beginCgStream(reply);
      reply.raw.on("close", () => {
        if (!reply.raw.writableFinished) abort.abort();
      });
      const heartbeat = setInterval(() => writeCgHeartbeat(reply), 10_000);
      try {
        const result =
          cached ?? (await executeAfterDecrypt(keyId, inner, abort.signal));
        idempotency.set(env.idempotencyKey, result);
        const userText = (() => {
          const messages = normalizeMessages(
            (inner.body as Record<string, unknown>).messages
          );
          const lastUser = [...messages].reverse().find((m) => m.role === "user");
          return lastUser?.text ?? "";
        })();
        await maybePersistExchangeHistory({
          accountId: session.accountId,
          conversationId: result.conversationId,
          userText,
          assistantText: result.text,
          idempotencyKey: env.idempotencyKey
        });
        await sleepJitter(appConfig.csRelay.sendJitterMs);
        await writeCgFrame(reply, session, "open", {
          id: `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
          model: modelOf(inner),
          inputTokens: result.inputTokens
        });
        for (const chunk of chunkText(result.text)) {
          await writeCgFrame(reply, session, "delta", { text: chunk });
        }
        await writeCgFrame(reply, session, "usage", {
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens
        });
        await writeCgFrame(reply, session, "done", {});
      } catch (error) {
        if (!abort.signal.aborted) {
          try {
            await writeCgFrame(reply, session, "error", { errorKind: cgReason(error) });
          } catch {
            // connection already gone; nothing more to do.
          }
        }
      } finally {
        clearInterval(heartbeat);
        cleanup();
        reply.raw.end();
      }
      return reply;
    },

    async handleCancel(request: FastifyRequest, reply: FastifyReply) {
      reply.header("cache-control", "no-store");
      let env;
      try {
        env = cgCancelRequestSchema.parse(request.body);
      } catch {
        return sendCgError(reply, "malformed_envelope");
      }

      const session = sessions.get(env.sessionId);
      if (!session) return sendCgError(reply, "unknown_session");

      try {
        checkC2sSequence(session, env.sequence);
        const inner = cgCancelInnerSchema.parse(
          await openC2s(session, { ...env, kind: "cancel-request" })
        );
        const controller = inflight.get(inner.idempotencyKey);
        if (controller) controller.abort();
        idempotency.delete(inner.idempotencyKey);
        return reply.send({ ok: true });
      } catch (error) {
        return sendCgError(reply, cgReason(error));
      }
    },

    async handleRevoke(request: FastifyRequest, reply: FastifyReply) {
      reply.header("cache-control", "no-store");
      let env;
      try {
        env = cgRevokeRequestSchema.parse(request.body);
      } catch {
        return sendCgError(reply, "malformed_envelope");
      }
      try {
        const session = await ensureSession(env as unknown as CgExchangeRequest);
        checkC2sSequence(session, env.sequence);
        const inner = cgRevokeInnerSchema.parse(
          await openC2s(session, { ...env, kind: "revoke-request" })
        );
        const loaded = await loadDeviceCert(env.deviceId);
        if (!loaded.accountId) fail("device_not_account_bound");
        const revoked = await revokeCgDevice({
          accountId: loaded.accountId,
          targetDeviceId: inner.targetDeviceId
        });
        if (!revoked) return sendCgError(reply, "revoke_target_not_found", 404);
        deviceCerts.delete(inner.targetDeviceId);
        deviceStatusCache.invalidate(inner.targetDeviceId);
        // Drop any in-memory sessions for the revoked device (short TTL invalidate).
        for (const [sid, s] of sessions) {
          if (s.deviceId === inner.targetDeviceId) sessions.delete(sid);
        }
        if (inner.bumpKekEpoch && appConfig.csRelay.historyEnabled) {
          await bumpAccountKekEpoch(requireKms(), loaded.accountId);
        }
        await deps.backend.audit({
          eventType: "cg_device_revoke",
          details: {
            accountId: loaded.accountId,
            targetDeviceId: inner.targetDeviceId,
            byDeviceId: env.deviceId,
            bumpKekEpoch: inner.bumpKekEpoch
          }
        });
        const payload = await sealS2c(session, "done", {
          kind: "revoke-response",
          ok: true,
          targetDeviceId: inner.targetDeviceId
        });
        return reply.send({
          protocol: CG_MITM_PROTOCOL,
          kind: "revoke-response",
          sessionId: session.sessionId,
          sequence: session.lastS2cSeq,
          createdAt: new Date().toISOString(),
          payload
        });
      } catch (error) {
        const reason = cgReason(error);
        const status = reason === "cross_account_denied" ? 403 : 400;
        return sendCgError(reply, reason, status);
      }
    },

    async handleSync(request: FastifyRequest, reply: FastifyReply) {
      reply.header("cache-control", "no-store");
      if (!appConfig.csRelay.historyEnabled) {
        return sendCgError(reply, "relay_history_disabled", 503);
      }
      let env;
      try {
        env = cgSyncRequestSchema.parse(request.body);
      } catch {
        return sendCgError(reply, "malformed_envelope");
      }
      try {
        const session = await ensureSession(env as unknown as CgExchangeRequest);
        checkC2sSequence(session, env.sequence);
        const inner = cgSyncInnerSchema.parse(
          await openC2s(session, { ...env, kind: "sync-request" })
        );
        const device = await verifyDeviceAuth(
          { ...env, idempotencyKey: "00000000-0000-0000-0000-000000000000" },
          inner.deviceAuth,
          session
        );
        if (!device.accountId) fail("device_not_account_bound");
        const accountId = device.accountId;

        let body: Record<string, unknown>;
        if (inner.op === "conversation-list") {
          const listed = await listRelayConversations({
            accountId,
            limit: inner.limit,
            cursor: inner.cursor ?? null,
            sinceUpdatedAt: inner.sinceUpdatedAt ?? null
          });
          const conversations = [];
          for (const c of listed.conversations) {
            let title: string | null = null;
            if (c.titleCiphertext && c.wrappedDek && c.kekEpoch != null) {
              try {
                const { kek, raw } = await (async () => {
                  const opened = await ensureAccountKek(requireKms(), accountId);
                  return { kek: opened.kek, raw: null as Uint8Array | null };
                })();
                void kek;
                void raw;
                // Title decrypt is best-effort via listRelayMessages path; surface ciphertext meta only if needed.
                title = null;
              } catch {
                title = null;
              }
            }
            conversations.push({
              id: c.id,
              title,
              updatedAt: c.updatedAt,
              lastSequence: c.lastSequence,
              archived: c.archived,
              deleted: c.deleted
            });
          }
          body = { kind: "sync-response", op: inner.op, conversations, nextCursor: listed.nextCursor };
        } else if (inner.op === "messages-page" || inner.op === "delta") {
          if (!inner.conversationId) fail("sync_conversation_required");
          const page = await listRelayMessages({
            kms: requireKms(),
            accountId,
            conversationId: inner.conversationId,
            sinceSequence: inner.sinceSequence ?? 0,
            limit: inner.limit,
            cursor: inner.cursor ?? null
          });
          body = {
            kind: "sync-response",
            op: inner.op,
            conversationId: inner.conversationId,
            messages: page.messages,
            nextCursor: page.nextCursor,
            latestSequence: page.latestSequence
          };
        } else if (inner.op === "archive") {
          if (!inner.conversationId) fail("sync_conversation_required");
          const ok = await archiveRelayConversation({
            accountId,
            conversationId: inner.conversationId
          });
          body = {
            kind: "sync-response",
            op: inner.op,
            conversationId: inner.conversationId,
            ok,
            change: { type: "archive", conversationId: inner.conversationId }
          };
        } else if (inner.op === "delete") {
          if (!inner.conversationId) fail("sync_conversation_required");
          const ok = await softDeleteRelayConversation({
            accountId,
            conversationId: inner.conversationId
          });
          body = {
            kind: "sync-response",
            op: inner.op,
            conversationId: inner.conversationId,
            ok,
            change: { type: "delete", conversationId: inner.conversationId }
          };
        } else {
          fail("sync_op_unsupported");
        }

        await sleepJitter(appConfig.csRelay.sendJitterMs);
        const payload = await sealS2c(session, "done", body);
        return reply.send({
          protocol: CG_MITM_PROTOCOL,
          kind: "sync-response",
          sessionId: session.sessionId,
          sequence: session.lastS2cSeq,
          createdAt: new Date().toISOString(),
          payload
        });
      } catch (error) {
        const reason = cgReason(error);
        const status =
          reason === "cross_account_denied"
            ? 403
            : reason === "sequence_conflict"
              ? 409
              : 400;
        return sendCgError(reply, reason, status);
      }
    },

        async handleSyncStream(request: FastifyRequest, reply: FastifyReply) {
      reply.header("cache-control", "no-store");
      if (!appConfig.csRelay.historyEnabled) {
        return sendCgError(reply, "relay_history_disabled", 503);
      }
      // Query: sessionId + deviceId required; client must have enrolled session.
      const q = request.query as Record<string, string>;
      const sessionId = q.sessionId;
      const deviceId = q.deviceId;
      if (!sessionId || !deviceId) return sendCgError(reply, "sync_stream_params_missing");
      const session = sessions.get(sessionId);
      if (!session || session.deviceId !== deviceId) return sendCgError(reply, "unknown_session");
      let accountId = session.accountId;
      try {
        const loaded = await loadDeviceCert(deviceId);
        accountId = loaded.accountId;
        session.accountId = accountId;
      } catch (error) {
        return sendCgError(reply, cgReason(error));
      }
      if (!accountId) return sendCgError(reply, "device_not_account_bound");

      beginCgStream(reply);
      const heartbeat = setInterval(() => writeCgHeartbeat(reply), 10_000);
      let unsubscribe: (() => void) | null = null;
      const cleanup = () => {
        clearInterval(heartbeat);
        if (unsubscribe) unsubscribe();
      };
      reply.raw.on("close", cleanup);

      try {
        await writeCgFrame(reply, session, "open", {
          kind: "sync-stream-ready",
          accountIdHash: accountId.slice(0, 12)
        });
        unsubscribe = await subscribeSyncAccount(accountId, (notify) => {
          void (async () => {
            try {
              // Fetch delta ciphertext path: decrypt in CS, re-seal to this device session.
              const page = await listRelayMessages({
                kms: requireKms(),
                accountId: accountId!,
                conversationId: notify.conversationId,
                sinceSequence: Math.max(0, notify.sequence - 1),
                limit: 5,
                cursor: null
              });
              const messages = page.messages.filter((m) => m.sequence === notify.sequence);
              await writeCgFrame(reply, session, "delta", {
                kind: "sync-delta",
                conversationId: notify.conversationId,
                sequence: notify.sequence,
                messages
              });
            } catch (error) {
              try {
                await writeCgFrame(reply, session, "error", {
                  errorKind: cgReason(error),
                  conversationId: notify.conversationId,
                  sequence: notify.sequence
                });
              } catch {
                // connection gone
              }
            }
          })();
        });
      } catch (error) {
        cleanup();
        return sendCgError(reply, cgReason(error));
      }
      return reply;
    }
  };
}

export function registerCsapiSecure(app: FastifyInstance, deps: CsapiSecureDeps) {
  const secure = createCsapiSecure(deps);
  app.get("/cg/v1/server-keys", (request, reply) => secure.handleServerKeys(request, reply));
  app.post("/cg/v1/enroll", (request, reply) => secure.handleEnroll(request, reply));
  app.post("/cg/v1/enroll/challenge", (request, reply) => secure.handleEnrollChallenge(request, reply));
  app.post("/cg/v1/exchange", (request, reply) => secure.handleExchange(request, reply));
  app.post("/cg/v1/cancel", (request, reply) => secure.handleCancel(request, reply));
  app.post("/cg/v1/devices/revoke", (request, reply) => secure.handleRevoke(request, reply));
  app.post("/cg/v1/sync", (request, reply) => secure.handleSync(request, reply));
  app.get("/cg/v1/sync/stream", (request, reply) => secure.handleSyncStream(request, reply));
  return secure;
}
