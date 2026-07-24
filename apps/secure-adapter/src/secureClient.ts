// cg-mitm/1 client: pins the offline Ed25519 root, verifies the server identity
// cert, enrolls the device, performs the HPKE handshake, and exchanges ciphertext
// request/response (incl. streaming). Plaintext exists only inside this process.
// Everything is fail-closed: any pin/handshake/decrypt failure throws — we NEVER
// fall back to a plaintext /v1/* request.
import { hostname } from "node:os";
import {
  buildC2sAad,
  buildCgDeviceAuthTranscript,
  buildEnrollAad,
  buildEnrollContext,
  buildHandshakeContext,
  buildS2cAad,
  C2S_PURPOSE,
  createKeyDescriptor,
  decryptJson,
  encodeBase64Url,
  encryptJson,
  ENROLL_PURPOSE,
  generateHpkeKeyPair,
  generateRootKeyBytes,
  generateSigningKeyPair,
  exportPrivateJwk,
  importHpkePrivateKey,
  importRootKey,
  importSigningPrivateKey,
  S2C_PURPOSE,
  signValue,
  verifyCgServerIdentityCert,
  wrapRootKey
} from "@cursor-gateway/e2ee";
import {
  cgDeviceCertSchema,
  cgEnrollResponseSchema,
  cgExchangeResponseSchema,
  cgResponseInnerSchema,
  cgServerKeysResponseSchema,
  cgSseFrameInnerSchema,
  cgSseWireFrameSchema,
  CG_MITM_PROTOCOL,
  type CgFrameType,
  type CgServerKeysResponse,
  type CgWire,
  type E2eeHpkeEnvelope,
  type E2eePublicKey
} from "@cursor-gateway/shared";
import type { AdapterConfig } from "./config.js";
import type { DeviceState, StateStore } from "./state.js";

export class AdapterError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string
  ) {
    super(reason);
    this.name = "AdapterError";
  }
}

/** fail-closed: startup/verification failures. Never fall back to plaintext. */
export class FailClosedError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "FailClosedError";
  }
}

export interface StreamFrame {
  frameType: CgFrameType;
  sequence: number;
  data: Record<string, unknown>;
}

export interface ExchangeRequest {
  wire: CgWire;
  body: Record<string, unknown>;
  sessionKey: string | null;
  idempotencyKey: string;
  signal?: AbortSignal;
}

interface RuntimeDevice {
  deviceId: string;
  signingKeyId: string;
  signingPrivateKey: CryptoKey;
  state: DeviceState;
}

interface Session {
  sessionId: string;
  sessionRoot: CryptoKey;
  c2sSeq: number;
  s2cSeqSeen: number;
  pendingEnc: E2eeHpkeEnvelope | null;
}

type FetchLike = typeof fetch;

const RESET_SESSION_REASONS = new Set([
  "unknown_session",
  "handshake_enc_replayed",
  "handshake_unwrap_failed",
  "c2s_sequence_replayed",
  "c2s_decrypt_failed",
  "server_cert_epoch_rejected"
]);
const REENROLL_REASONS = new Set([
  "device_not_enrolled",
  "device_auth_invalid",
  "device_auth_key_mismatch"
]);

function mapReasonStatus(reason: string): number {
  if (reason === "authentication_error" || reason === "enroll_unauthorized") return 401;
  if (reason === "malformed_envelope") return 400;
  return 502;
}

export class SecureClient {
  private serverKeys!: CgServerKeysResponse;
  private device!: RuntimeDevice;
  private session: Session | null = null;
  private exchangeTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly cfg: AdapterConfig,
    private readonly store: StateStore,
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  /**
   * A cg-mitm session uses one strictly ordered sequence in each direction.
   * Serialize complete exchanges so concurrent callers (for example a CLI's
   * title request and primary completion) cannot receive s2c frames out of
   * order and invalidate each other.
   */
  private async acquireExchange(): Promise<() => void> {
    const previous = this.exchangeTail;
    let release!: () => void;
    this.exchangeTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    return release;
  }

  /** Startup: pin+verify server-keys, then load or enroll the device. */
  async init(): Promise<void> {
    this.serverKeys = await this.fetchAndVerifyServerKeys();
    this.device = await this.loadOrEnrollDevice();
  }

  get deviceId(): string {
    return this.device.deviceId;
  }

  private serverHpkePublic(): E2eePublicKey {
    return this.serverKeys.cert.hpkeKey.publicKey;
  }

  private get serverCertId(): string {
    return this.serverKeys.cert.certId;
  }

  private get epoch(): number {
    return this.serverKeys.epoch;
  }

  // -- §2 fetch + pin + verify server identity certificate -------------------
  private async fetchAndVerifyServerKeys(): Promise<CgServerKeysResponse> {
    let parsed: CgServerKeysResponse;
    try {
      const res = await this.fetchImpl(`${this.cfg.upstreamUrl}/cg/v1/server-keys`);
      if (!res.ok) throw new FailClosedError(`server_keys_http_${res.status}`);
      parsed = cgServerKeysResponseSchema.parse(await res.json());
    } catch (error) {
      if (error instanceof FailClosedError) throw error;
      throw new FailClosedError("server_keys_fetch_failed");
    }
    // 1) The advertised root MUST be one of our offline-pinned fingerprints.
    const pinnedRoots = parsed.trustRoots.filter((root) =>
      this.cfg.pinnedRootFingerprints.includes(root.fingerprint)
    );
    if (pinnedRoots.length === 0) throw new FailClosedError("root_fingerprint_not_pinned");
    // 2) The server cert must be signed by that root + valid + origin/epoch bound.
    const result = await verifyCgServerIdentityCert({
      cert: parsed.cert,
      trustRoots: pinnedRoots,
      expected: { serverId: parsed.serverId, origin: this.cfg.upstreamUrl },
      nowMs: Date.now()
    });
    if (!result.ok) throw new FailClosedError(result.reason);
    // 3) Suite must not be downgraded below our pinned baseline.
    if (parsed.minSuite !== this.cfg.minSuite) throw new FailClosedError("suite_downgrade");
    return parsed;
  }

  // -- §3 enroll (device keys generated locally, cached sealed) ---------------
  private async loadOrEnrollDevice(): Promise<RuntimeDevice> {
    const cached = this.store.read();
    if (cached && !isExpired(cached.deviceCert.expiresAt)) {
      return {
        deviceId: cached.deviceId,
        signingKeyId: cached.signingKeyId,
        signingPrivateKey: await importSigningPrivateKey(cached.signingPrivateJwk),
        state: cached
      };
    }
    return this.enrollDevice();
  }

  private async enrollDevice(): Promise<RuntimeDevice> {
    const signingPair = await generateSigningKeyPair(true);
    const encryptionPair = await generateHpkeKeyPair();
    const signingDescriptor = await createKeyDescriptor(signingPair.publicKey);
    const encryptionDescriptor = await createKeyDescriptor(encryptionPair.publicKey);

    const enrollRootBytes = generateRootKeyBytes();
    const enrollRoot = await importRootKey(enrollRootBytes);
    const enc = await wrapRootKey(
      enrollRootBytes,
      this.serverHpkePublic(),
      buildEnrollContext({ serverCertId: this.serverCertId, epoch: this.epoch })
    );
    enrollRootBytes.fill(0);

    const enrollAad = buildEnrollAad({ serverCertId: this.serverCertId, epoch: this.epoch });
    const payload = await encryptJson(enrollRoot, ENROLL_PURPOSE, enrollAad, {
      protocol: CG_MITM_PROTOCOL,
      kind: "enroll-inner",
      apiKey: this.cfg.apiKey,
      deviceSigningKey: signingDescriptor,
      deviceEncryptionKey: encryptionDescriptor,
      label: hostname().slice(0, 128),
      createdAt: new Date().toISOString()
    });

    const res = await this.postJson(`${this.cfg.upstreamUrl}/cg/v1/enroll`, {
      protocol: CG_MITM_PROTOCOL,
      kind: "enroll-request",
      serverCertId: this.serverCertId,
      epoch: this.epoch,
      enc,
      payload,
      createdAt: new Date().toISOString()
    });
    if (res && (res as { kind?: string }).kind === "secure-error") {
      throw new FailClosedError((res as { reason: string }).reason);
    }
    const parsed = cgEnrollResponseSchema.parse(res);
    if (parsed.status !== "enrolled" || !parsed.payload) {
      throw new FailClosedError(parsed.reason ?? "enroll_rejected");
    }
    const decrypted = (await decryptJson(enrollRoot, ENROLL_PURPOSE, enrollAad, parsed.payload)) as {
      deviceCert?: unknown;
    };
    const deviceCert = cgDeviceCertSchema.parse(decrypted.deviceCert);

    const signingPrivateJwk = await exportPrivateJwk(signingPair.privateKey);
    const encryptionPrivateJwk = await exportPrivateJwk(encryptionPair.privateKey);
    const state: DeviceState = {
      version: 1,
      deviceId: deviceCert.deviceId,
      signingKeyId: signingDescriptor.keyId,
      signingPrivateJwk,
      signingDescriptor,
      encryptionPrivateJwk,
      encryptionDescriptor,
      deviceCert
    };
    this.store.write(state);
    // Confirm the sealed private key round-trips (and drop the extractable copy).
    return {
      deviceId: deviceCert.deviceId,
      signingKeyId: signingDescriptor.keyId,
      signingPrivateKey: await importSigningPrivateKey(signingPrivateJwk),
      state
    };
  }

  // -- §5 handshake + framing -------------------------------------------------
  private handshakeContext(sessionId: string) {
    return buildHandshakeContext({
      serverCertId: this.serverCertId,
      epoch: this.epoch,
      deviceId: this.device.deviceId,
      adapterNonce: sessionId,
      minSuite: this.cfg.minSuite
    });
  }

  private async ensureSession(): Promise<Session> {
    if (this.session) return this.session;
    const rootBytes = generateRootKeyBytes();
    // sessionId is a one-time random nonce bound into the handshake AAD; it need
    // not equal sha256(enc) (the server treats it as an opaque nonce).
    const sessionId = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    const enc = await wrapRootKey(rootBytes, this.serverHpkePublic(), this.handshakeContext(sessionId));
    const sessionRoot = await importRootKey(rootBytes);
    rootBytes.fill(0);
    this.session = { sessionId, sessionRoot, c2sSeq: 0, s2cSeqSeen: 0, pendingEnc: enc };
    return this.session;
  }

  private checkS2c(session: Session, sequence: number): void {
    if (sequence <= session.s2cSeqSeen) throw new FailClosedError("s2c_sequence_replayed");
    session.s2cSeqSeen = sequence;
  }

  private async buildExchangeEnv(req: ExchangeRequest): Promise<{
    session: Session;
    env: Record<string, unknown>;
  }> {
    const session = await this.ensureSession();
    const sequence = ++session.c2sSeq;
    const deviceAuth = await signValue(
      buildCgDeviceAuthTranscript({
        sessionId: session.sessionId,
        deviceId: this.device.deviceId,
        sequence,
        idempotencyKey: req.idempotencyKey
      }),
      this.device.signingPrivateKey,
      this.device.signingKeyId
    );
    const inner = {
      protocol: CG_MITM_PROTOCOL,
      kind: "exchange-inner",
      apiKey: this.cfg.apiKey,
      wire: req.wire,
      body: req.body,
      sessionKey: req.sessionKey,
      clientAbortable: true,
      deviceAuth
    };
    const aad = buildC2sAad({ sessionId: session.sessionId, sequence, kind: "exchange-request" });
    const payload = await encryptJson(session.sessionRoot, C2S_PURPOSE, aad, inner);
    const env: Record<string, unknown> = {
      protocol: CG_MITM_PROTOCOL,
      kind: "exchange-request",
      sessionId: session.sessionId,
      deviceId: this.device.deviceId,
      serverCertId: this.serverCertId,
      epoch: this.epoch,
      sequence,
      idempotencyKey: req.idempotencyKey,
      createdAt: new Date().toISOString(),
      payload
    };
    if (sequence === 1 && session.pendingEnc) env.enc = session.pendingEnc;
    return { session, env };
  }

  /** Recover from a session/enrollment reset by re-doing the failing op once. */
  private async recover(reason: string): Promise<boolean> {
    if (REENROLL_REASONS.has(reason)) {
      this.session = null;
      this.device = await this.enrollDevice();
      return true;
    }
    if (RESET_SESSION_REASONS.has(reason)) {
      if (reason === "server_cert_epoch_rejected") {
        this.serverKeys = await this.fetchAndVerifyServerKeys();
      }
      this.session = null;
      return true;
    }
    return false;
  }

  // -- non-streaming exchange -> standard Anthropic/OpenAI response body ------
  async exchange(req: ExchangeRequest): Promise<Record<string, unknown>> {
    const release = await this.acquireExchange();
    try {
      try {
        return await this.exchangeOnce(req);
      } catch (error) {
        if (error instanceof AdapterError && (await this.recover(error.reason))) {
          return this.exchangeOnce(req);
        }
        throw error;
      }
    } finally {
      release();
    }
  }

  private async exchangeOnce(req: ExchangeRequest): Promise<Record<string, unknown>> {
    const { session, env } = await this.buildExchangeEnv(req);
    const res = await this.postJson(`${this.cfg.upstreamUrl}/cg/v1/exchange`, env, req.signal);
    if (res && (res as { kind?: string }).kind === "secure-error") {
      const reason = (res as { reason: string }).reason;
      throw new AdapterError(mapReasonStatus(reason), reason);
    }
    const parsed = cgExchangeResponseSchema.parse(res);
    this.checkS2c(session, parsed.sequence);
    const respInner = cgResponseInnerSchema.parse(
      await decryptJson(
        session.sessionRoot,
        S2C_PURPOSE,
        buildS2cAad({ sessionId: session.sessionId, sequence: parsed.sequence, frameType: "done" }),
        parsed.payload
      )
    );
    if (!respInner.ok || !respInner.body) {
      throw new AdapterError(respInner.httpStatus, respInner.errorKind ?? "upstream_error");
    }
    return respInner.body;
  }

  // -- streaming exchange -> decrypted cg frames ------------------------------
  async *exchangeStream(req: ExchangeRequest): AsyncGenerator<StreamFrame> {
    const release = await this.acquireExchange();
    try {
      let attempt = await this.openStream(req);
      if (attempt.retryReason && (await this.recover(attempt.retryReason))) {
        attempt = await this.openStream(req);
      }
      if (attempt.retryReason) {
        throw new AdapterError(mapReasonStatus(attempt.retryReason), attempt.retryReason);
      }
      const { session, body } = attempt;
      for await (const evt of readSse(body!)) {
        if (evt.comment) continue;
        if (!evt.data) continue;
        const wireFrame = cgSseWireFrameSchema.parse(JSON.parse(evt.data));
        this.checkS2c(session!, wireFrame.sequence);
        const inner = cgSseFrameInnerSchema.parse(
          await decryptJson(
            session!.sessionRoot,
            S2C_PURPOSE,
            buildS2cAad({
              sessionId: session!.sessionId,
              sequence: wireFrame.sequence,
              frameType: wireFrame.frameType
            }),
            wireFrame.payload
          )
        );
        yield { frameType: inner.frameType, sequence: inner.sequence, data: inner.data };
      }
    } finally {
      release();
    }
  }

  private async openStream(req: ExchangeRequest): Promise<{
    session: Session | null;
    body: ReadableStream<Uint8Array> | null;
    retryReason: string | null;
  }> {
    const { session, env } = await this.buildExchangeEnv(req);
    const res = await this.fetchImpl(`${this.cfg.upstreamUrl}/cg/v1/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(env),
      ...(req.signal ? { signal: req.signal } : {})
    });
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) {
      return { session, body: res.body, retryReason: null };
    }
    // Non-stream response = an error envelope (fail-closed before hijack).
    let reason = `unexpected_status_${res.status}`;
    try {
      const json = (await res.json()) as { kind?: string; reason?: string };
      if (json.kind === "secure-error" && json.reason) reason = json.reason;
    } catch {
      // keep the status-derived reason
    }
    return { session: null, body: null, retryReason: reason };
  }

  // -- §6 cancel --------------------------------------------------------------
  async cancel(idempotencyKey: string): Promise<void> {
    const session = this.session;
    if (!session) return;
    const sequence = ++session.c2sSeq;
    const aad = buildC2sAad({ sessionId: session.sessionId, sequence, kind: "cancel-request" });
    const payload = await encryptJson(session.sessionRoot, C2S_PURPOSE, aad, {
      kind: "cancel-inner",
      idempotencyKey
    });
    try {
      await this.postJson(`${this.cfg.upstreamUrl}/cg/v1/cancel`, {
        protocol: CG_MITM_PROTOCOL,
        kind: "cancel-request",
        sessionId: session.sessionId,
        deviceId: this.device.deviceId,
        sequence,
        createdAt: new Date().toISOString(),
        payload
      });
    } catch {
      // best-effort cancel
    }
  }

  private async postJson(url: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {})
    });
    try {
      return await res.json();
    } catch {
      throw new AdapterError(502, `bad_upstream_json_${res.status}`);
    }
  }
}

function isExpired(expiresAt: string): boolean {
  const ts = Date.parse(expiresAt);
  return Number.isNaN(ts) || ts <= Date.now() + 60_000;
}

interface SseEvent {
  event?: string;
  data?: string;
  comment: boolean;
}

/** Minimal SSE line reader over a fetch ReadableStream. */
async function* readSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        yield parseSseBlock(block);
      }
    }
    if (buffer.trim()) yield parseSseBlock(buffer);
  } finally {
    reader.releaseLock();
  }
}

function parseSseBlock(block: string): SseEvent {
  const out: SseEvent = { comment: false };
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) {
      out.comment = true;
      continue;
    }
    if (line.startsWith("event:")) out.event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
  }
  if (dataLines.length > 0) out.data = dataLines.join("\n");
  return out;
}
