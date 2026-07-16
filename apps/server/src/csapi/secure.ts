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
  cgServerIdentityCertSchema,
  cgServerKeysResponseSchema,
  type CgDeviceCert,
  type CgExchangeInner,
  type CgExchangeRequest,
  type CgServerIdentityCert,
  type CgServerKeysResponse,
  type E2eeCiphertext,
  type E2eePublicKey
} from "@cursor-gateway/shared";
import {
  buildC2sAad,
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
  importHpkePrivateKey,
  importSigningPrivateKey,
  importSigningPublicKey,
  issueCgDeviceCert,
  S2C_PURPOSE,
  unwrapRootKey,
  verifyValue
} from "@cursor-gateway/e2ee";
import { loadCgTrustRoots } from "../cgTrustRoots.js";
import { config as appConfig } from "../config.js";
import type { CsapiDeps } from "./server.js";
import { createCsapi } from "./server.js";
import {
  buildAnthropicResponse,
  buildOpenAiResponse,
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

export function createCsapiSecure(deps: CsapiSecureDeps) {
  const csapi = createCsapi(deps);
  const cfg = deps.secure;

  const sessions = new Map<string, SecureSession>();
  const usedEnc = new Set<string>();
  const deviceCerts = new Map<string, CgDeviceCert>();
  const idempotency = new Map<string, CompletedRunLike>();

  function fail(reason: string): never {
    throw new CgSecureError(reason);
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

  async function verifyDeviceAuth(
    env: CgExchangeRequest,
    inner: CgExchangeInner
  ): Promise<void> {
    const deviceCert = deviceCerts.get(env.deviceId);
    if (!deviceCert) fail("device_not_enrolled");
    const pub = await importSigningPublicKey(deviceCert.signingKey.publicKey);
    const transcript = {
      protocol: CG_MITM_PROTOCOL,
      purpose: "device-auth",
      sessionId: env.sessionId,
      deviceId: env.deviceId,
      sequence: env.sequence,
      idempotencyKey: env.idempotencyKey
    };
    const valid = await verifyValue(transcript, inner.deviceAuth, pub);
    if (!valid) fail("device_auth_invalid");
  }

  return {
    async handleServerKeys(_request: FastifyRequest, reply: FastifyReply) {
      return reply.send(cgServerKeysResponseSchema.parse(cfg.serverKeysResponse));
    },

    async handleEnroll(request: FastifyRequest, reply: FastifyReply) {
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
        const keyId = matchApiKey(inner.apiKey, deps.config.apiKeys);
        if (!keyId) return sendCgError(reply, "enroll_unauthorized");

        const deviceId = crypto.randomUUID();
        const deviceCert = await issueCgDeviceCert({
          signingPrivateKey: cfg.signingPrivateKey,
          signingKeyId: cfg.signingKeyId,
          deviceId,
          signingKey: inner.deviceSigningKey,
          encryptionKey: inner.deviceEncryptionKey,
          keyIdHint: keyId,
          serverCertId: cfg.serverCertId
        });
        deviceCerts.set(deviceId, deviceCert);
        await deps.backend.audit({
          eventType: "cg_enroll",
          details: { deviceId, keyId }
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

    async handleExchange(request: FastifyRequest, reply: FastifyReply) {
      let env: CgExchangeRequest;
      try {
        env = cgExchangeRequestSchema.parse(request.body);
      } catch {
        return sendCgError(reply, "malformed_envelope");
      }

      try {
        const session = await ensureSession(env);
        checkC2sSequence(session, env.sequence);
        const inner = cgExchangeInnerSchema.parse(
          await openC2s(session, { ...env, kind: "exchange-request" })
        );
        await verifyDeviceAuth(env, inner);

        const cached = idempotency.get(env.idempotencyKey);
        const keyId = matchApiKey(inner.apiKey, deps.config.apiKeys);
        if (!keyId) return sendCgError(reply, "authentication_error");

        const body = inner.body as Record<string, unknown>;
        if (body.stream === true) {
          return sendCgError(reply, "stream_not_implemented", 501);
        }

        const result =
          cached ??
          (await csapi.execute(toExecuteInput(keyId, inner, deps)));
        idempotency.set(env.idempotencyKey, result);

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
      }
    },

    async handleCancel(request: FastifyRequest, reply: FastifyReply) {
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
        idempotency.delete(inner.idempotencyKey);
        return reply.send({ ok: true });
      } catch (error) {
        return sendCgError(reply, cgReason(error));
      }
    }
  };
}

export function registerCsapiSecure(app: FastifyInstance, deps: CsapiSecureDeps) {
  const secure = createCsapiSecure(deps);
  app.get("/cg/v1/server-keys", (request, reply) => secure.handleServerKeys(request, reply));
  app.post("/cg/v1/enroll", (request, reply) => secure.handleEnroll(request, reply));
  app.post("/cg/v1/exchange", (request, reply) => secure.handleExchange(request, reply));
  app.post("/cg/v1/cancel", (request, reply) => secure.handleCancel(request, reply));
  return secure;
}
