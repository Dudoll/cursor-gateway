# 服务端 `/cg/v1/*` 处理骨架（规格级伪代码）

> 拟落地：**`apps/server/src/csapi/secure.ts`**（与现有 `server.ts` 平级；复用其内部 `execute()` / 并发 /
> `matchApiKey`）。伪代码里所有被 `↩ 复用` 标注的符号都是仓库现有导出，签名已核对。
> 挂载与放行改动落在 `apps/server/src/index.ts` 与 `apps/server/src/csapi/server.ts`（`isCsapiPath`）。

## 0. 依赖与复用点

```ts
// 复用（已存在）：
import { createCsapi, type CsapiDeps } from "./server.js"; // ↩ 复用 execute/serializer/limiter/response builders
import { matchApiKey, buildAnthropicResponse, buildOpenAiResponse,
         buildAnthropicStreamFrames, buildOpenAiStreamFrames } from "./protocol.js"; // ↩ 复用
import { SessionSerializer, KeyConcurrencyLimiter } from "./concurrency.js"; // ↩ 复用（execute 内部已用）
import {
  unwrapRootKey, encryptJson, decryptJson, signValue, verifyValue,
  importSigningPublicKey, importHpkePrivateKey, exportE2eePublicKey,
  canonicalJson, encodeBase64Url, decodeBase64Url
} from "@cursor-gateway/e2ee"; // ↩ 复用
import { loadServerTrustRoots } from "../trustRoots.js"; // ↩ 复用（公钥公开材料）
// 新增（P1 schema，见 01-schema.md）：
import {
  cgExchangeRequestSchema, cgEnrollRequestSchema, cgCancelRequestSchema,
  cgServerKeysResponseSchema, cgExchangeInnerSchema, cgEnrollInnerSchema
} from "@cursor-gateway/shared";
```

## 1. 配置与状态（`CsapiSecureDeps`）

```ts
export interface CsapiSecureConfig {
  enabled: boolean;                 // CG_SECURE_ENABLED
  requireSecure: boolean;           // CG_REQUIRE_SECURE（true → 关闭明文 /v1/*）
  serverCertId: string;             // 当前服务端证书 id
  serverEpoch: number;
  // 服务端静态私钥（HPKE + ES256 签名）从密封存储加载，绝不进日志：
  hpkePrivateKey: CryptoKey;        // importHpkePrivateKey(...)
  hpkePublicJwk: E2eePublicKey;
  signingPrivateKey: CryptoKey;     // ES256, importSigningPrivateKey(...)
  signingKeyId: string;
  serverKeysResponse: CgServerKeysResponse; // 预构造并缓存（含根签发的服务端证书）
  allowedOrigins: string[];
  padBuckets: number[];             // e.g. [512, 2048, 8192, 32768, 131072]
}

export interface CsapiSecureDeps extends CsapiDeps { secure: CsapiSecureConfig; }

// 会话级易失状态（内存；进程重启即失效 → Adapter 重握手）
interface SecureSession {
  sessionId: string;
  deviceId: string;
  sessionRoot: CryptoKey;           // unwrapRootKey 得到的 HKDF key（直接喂 encryptJson/decryptJson）
  lastC2sSeq: number;               // 已见的最大 c2s 序列（重放 / 重排防护）
  lastS2cSeq: number;               // 已发的 s2c 序列
  createdAt: number;
}
```

## 2. 工厂骨架

```ts
export function createCsapiSecure(deps: CsapiSecureDeps) {
  const csapi = createCsapi(deps);                 // ↩ 复用：拿到内部 execute / limiter / serializer
  const cfg = deps.secure;

  const sessions = new Map<string, SecureSession>();   // sessionId → 会话
  const usedEnc = new Set<string>();                   // 已用 HPKE enc 指纹（握手一次性）
  const deviceCerts = new Map<string, CgDeviceCert>(); // deviceId → 设备证书（P2 内存；P4 落库 content_mode 无关）
  const idempotency = new Map<string, CompletedRunLike>(); // idempotencyKey → 结果（resume/去重；对齐 e2eeProcessor 缓存）

  // ---- 通用：fail-closed 错误（复用 verifyRunnerIdentityCert 的 reason 码风格）----
  function fail(reason: string): never {
    // 只抛安全 reason 码（无秘密）；HTTP 层转成密文错误 or 4xx。
    throw new CgSecureError(reason);
  }

  // ---- 首帧握手：unwrapRootKey + 设备认证 + 序列初始化 ----
  async function ensureSession(env: CgExchangeRequest): Promise<SecureSession> {
    const existing = sessions.get(env.sessionId);
    if (existing) return existing;

    if (!env.enc) fail("handshake_missing_enc");
    const encFp = encodeBase64Url(await sha256(decodeBase64Url(env.enc.enc)));
    if (usedEnc.has(encFp)) fail("handshake_enc_replayed");

    // handshakeContext 必须与 Adapter 完全一致（进 HPKE info/AAD，防降级 / 剥离）：
    const handshakeContext = buildHandshakeContext({           // 见 04-handshake-kdf-aad.md
      serverCertId: env.serverCertId, epoch: env.epoch,
      deviceId: env.deviceId, adapterNonce: env.sessionId, minSuite: cfg.serverKeysResponse.minSuite
    });
    // 只接受当前 / 上一 epoch 的 serverCertId（rotation 重叠窗口）：
    if (!isAcceptedServerCert(cfg, env.serverCertId, env.epoch)) fail("server_cert_epoch_rejected");

    let sessionRoot: CryptoKey;
    try {
      sessionRoot = await unwrapRootKey(env.enc, cfg.hpkePrivateKey, cfg.hpkePublicJwk, handshakeContext); // ↩ 复用
    } catch { fail("handshake_unwrap_failed"); }

    const session: SecureSession = {
      sessionId: env.sessionId, deviceId: env.deviceId, sessionRoot,
      lastC2sSeq: 0, lastS2cSeq: 0, createdAt: Date.now()
    };
    usedEnc.add(encFp);
    sessions.set(env.sessionId, session);
    return session;
  }

  // ---- 序列 / 重放校验 ----
  function checkC2sSequence(session: SecureSession, sequence: number): void {
    if (sequence <= session.lastC2sSeq) fail("c2s_sequence_replayed"); // ≤ lastSeen → 拒绝
    session.lastC2sSeq = sequence;
  }

  // ---- 解密内层 + AAD 绑定 ----
  async function openC2s<T>(session: SecureSession, env: { sessionId: string; sequence: number; payload: E2eeCiphertext; kind: string }): Promise<unknown> {
    const aad = buildC2sAad(env);   // canonical JSON of routing header（见 04）
    try {
      return await decryptJson(session.sessionRoot, C2S_PURPOSE, aad, env.payload); // ↩ 复用（AEAD 失败即抛）
    } catch { fail("c2s_decrypt_failed"); }
  }
  async function sealS2c(session: SecureSession, frameType: string, value: unknown): Promise<E2eeCiphertext> {
    const sequence = ++session.lastS2cSeq;
    const aad = buildS2cAad({ sessionId: session.sessionId, sequence, frameType });
    return encryptJson(session.sessionRoot, S2C_PURPOSE, aad, withPad(value, cfg.padBuckets)); // ↩ 复用
  }

  return {
    // ---------------------------------------------------------------
    // GET /cg/v1/server-keys —— 唯一半明文端点：公钥公开材料，无秘密
    // ---------------------------------------------------------------
    async handleServerKeys(_request, reply) {
      // 预构造并缓存；含 Ed25519 根签发的服务端证书 + trustRoots 公钥。
      return reply.send(cgServerKeysResponseSchema.parse(cfg.serverKeysResponse));
    },

    // ---------------------------------------------------------------
    // POST /cg/v1/enroll —— 首次设备注册（envelope 内一次性 apiKey 授权）
    // ---------------------------------------------------------------
    async handleEnroll(request, reply) {
      const env = cgEnrollRequestSchema.parse(request.body);
      if (!isAcceptedServerCert(cfg, env.serverCertId, env.epoch)) return sendCgError(reply, "server_cert_epoch_rejected");
      // 用临时 enrollRoot 解密内层（与 exchange 同法，但独立 purpose）：
      const enrollRoot = await unwrapRootKey(env.enc, cfg.hpkePrivateKey, cfg.hpkePublicJwk, buildEnrollContext(env)); // ↩ 复用
      const inner = cgEnrollInnerSchema.parse(await decryptJson(enrollRoot, ENROLL_PURPOSE, buildEnrollAad(env), env.payload)); // ↩ 复用

      // 授权：apiKey 必须匹配 csapi 允许集（timing-safe）。
      const keyId = matchApiKey(inner.apiKey, deps.config.apiKeys); // ↩ 复用
      if (!keyId) return sendCgError(reply, "enroll_unauthorized"); // 不泄露原因细节

      const deviceId = crypto.randomUUID();
      const deviceCert = await signDeviceCert({                 // ES256 服务端签名
        deviceId, signingKey: inner.deviceSigningKey, encryptionKey: inner.deviceEncryptionKey,
        keyIdHint: keyId, serverCertId: cfg.serverCertId,
        signingPrivateKey: cfg.signingPrivateKey, signingKeyId: cfg.signingKeyId
      });
      deviceCerts.set(deviceId, deviceCert);
      await deps.backend.audit({ eventType: "cg_enroll", details: { deviceId, keyId } }); // ↩ 复用（no secrets）
      // 推荐把 deviceCert 也密文回传（encryptJson(enrollRoot, ...)）。
      return reply.send({ protocol: "cg-mitm/1", kind: "enroll-response", status: "enrolled",
                          payload: await encryptJson(enrollRoot, ENROLL_PURPOSE, buildEnrollAad(env), { deviceCert }),
                          createdAt: new Date().toISOString() });
    },

    // ---------------------------------------------------------------
    // POST /cg/v1/exchange —— 主通道（非流式 + 密文 SSE）
    // ---------------------------------------------------------------
    async handleExchange(request, reply) {
      let env: CgExchangeRequest;
      try { env = cgExchangeRequestSchema.parse(request.body); }
      catch { return sendCgError(reply, "malformed_envelope"); } // 无 envelope 的裸请求一律拒绝（降级保护）

      let session: SecureSession, inner: CgExchangeInner;
      try {
        session = await ensureSession(env);
        checkC2sSequence(session, env.sequence);
        inner = cgExchangeInnerSchema.parse(await openC2s(session, env));
        await verifyDeviceAuth(session, deviceCerts, env, inner.deviceAuth); // 验设备 ES256 签名（首帧）
      } catch (e) { return sendCgError(reply, cgReason(e)); }       // fail-closed

      // 幂等 / resume：命中则直接回放缓存结果，不重复执行（对齐 e2eeProcessor 缓存语义）。
      const cached = idempotency.get(env.idempotencyKey);

      // matchApiKey → keyId（apiKey 只在内层明文，绝不进 header / 日志）。
      const keyId = matchApiKey(inner.apiKey, deps.config.apiKeys); // ↩ 复用
      if (!keyId) return sendCgError(reply, "authentication_error");

      const stream = inner.body?.stream === true;
      if (!stream) {
        // 非流式：复用现有 execute()（通过把内层 body 归一成 ExecuteInput）。
        const result = cached ?? await runViaExecute(csapi, keyId, inner); // ↩ 复用 execute（并发 / 串行都在其内）
        idempotency.set(env.idempotencyKey, result);
        const body = inner.wire === "anthropic"
          ? buildAnthropicResponse({ ...result, model: modelOf(inner) })   // ↩ 复用
          : buildOpenAiResponse({ ...result, model: modelOf(inner) });     // ↩ 复用
        const payload = await sealS2c(session, "done", { kind: "response-inner", ok: true, httpStatus: 200, wire: inner.wire, body });
        return reply.send({ protocol: "cg-mitm/1", kind: "exchange-response",
                            sessionId: session.sessionId, sequence: session.lastS2cSeq,
                            createdAt: new Date().toISOString(), payload });
      }

      // 流式：密文 SSE。复用 beginStream 语义 + 现有 heartbeat；每帧 sealS2c。
      beginCgStream(reply);
      try {
        const result = cached ?? await runViaExecuteWithHeartbeat(csapi, reply, keyId, inner, session); // ↩ 复用
        idempotency.set(env.idempotencyKey, result);
        // 逐帧密文：open → delta* → usage → done（与 protocol.ts 帧一一映射）
        await writeCgFrame(reply, await sealS2c(session, "open",  { frameType: "open",  sequence: 0, data: { id: result.runId, model: modelOf(inner) } }));
        for (const chunk of chunkText(result.text))                                        // ↩ 复用 chunkText
          await writeCgFrame(reply, await sealS2c(session, "delta", { frameType: "delta", sequence: session.lastS2cSeq, data: { text: chunk } }));
        await writeCgFrame(reply, await sealS2c(session, "usage", { frameType: "usage", sequence: session.lastS2cSeq, data: { inputTokens: result.inputTokens, outputTokens: result.outputTokens } }));
        await writeCgFrame(reply, await sealS2c(session, "done",  { frameType: "done",  sequence: session.lastS2cSeq, data: {} }));
        reply.raw.end();
      } catch (e) {
        // 客户端断连（AbortedError）静默；其余回一条密文 error 帧再关闭。
        if (!isAbort(e)) await writeCgFrame(reply, await sealS2c(session, "error", { frameType: "error", sequence: session.lastS2cSeq, data: { errorKind: cgReason(e) } }));
        reply.raw.end();
      }
      return reply;
    },

    // ---------------------------------------------------------------
    // POST /cg/v1/cancel —— 密文取消（复用现有 abort / cancelRun）
    // ---------------------------------------------------------------
    async handleCancel(request, reply) {
      const env = cgCancelRequestSchema.parse(request.body);
      const session = sessions.get(env.sessionId);
      if (!session) return sendCgError(reply, "unknown_session");
      checkC2sSequence(session, env.sequence);
      const inner = await openC2s(session, env); // { idempotencyKey }
      // 复用现有 abort：对该 idempotencyKey 关联的 run 触发 backend.cancelRun（已被 Runner 领取的不可抢占）。
      cancelByIdempotency(inner.idempotencyKey);   // ↩ 复用 backend.cancelRun / makeAbortSignal 语义
      return reply.send({ ok: true });
    }
  };
}
```

## 3. `runViaExecute`：把内层 body 归一到现有 `execute()`

```ts
// execute() 的入参是 ExecuteInput { keyId, system, messages, requestedModel, sessionKey, signal }。
// 内层 body 是原样 CLI 请求体，用现有 protocol.ts 归一化函数复用：
function toExecuteInput(keyId: string, inner: CgExchangeInner, signal?: AbortSignal): ExecuteInput {
  const body = inner.body as Record<string, unknown>;
  return {
    keyId,
    system: inner.wire === "anthropic" ? extractSystem(body.system) : "", // ↩ 复用 extractSystem
    messages: normalizeMessages(body.messages),                            // ↩ 复用 normalizeMessages
    requestedModel: typeof body.model === "string" ? body.model : deps.config.defaultModel,
    sessionKey: inner.sessionKey,   // 直接用内层 sessionKey（不再读 header）
    ...(signal ? { signal } : {})
  };
}
// runViaExecute 就是 csapi.execute(toExecuteInput(...))。并发（同 session 串行 / 跨 session 并行 / 每 key 429）
// 全部由 execute 内部的 SessionSerializer + KeyConcurrencyLimiter 保证 —— 无需在 secure 层重复实现。
```

## 4. 挂载与放行（`apps/server/src/index.ts` + `server.ts`）

```ts
// server.ts：扩展 isCsapiPath 放行 /cg/v1/*（继续豁免 Cloudflare Access）
export function isCsapiPath(url?: string): boolean {
  if (!url) return false;
  const path = url.split("?")[0];
  return path === "/health" || path === "/v1/models" || path === "/v1/messages" ||
         path === "/v1/chat/completions" ||
         path === "/cg/v1/server-keys" || path === "/cg/v1/enroll" ||
         path === "/cg/v1/exchange" || path === "/cg/v1/cancel"; // 新增
}

// index.ts：CG_SECURE_ENABLED 时注册 secure 路由；CG_REQUIRE_SECURE 时不再注册明文 /v1/*。
if (config.cg.secureEnabled) {
  const secure = createCsapiSecure({ backend, config: csapiConfig, secure: secureConfig });
  app.get("/cg/v1/server-keys", (req, reply) => secure.handleServerKeys(req, reply));
  app.post("/cg/v1/enroll",     (req, reply) => secure.handleEnroll(req, reply));
  app.post("/cg/v1/exchange",   (req, reply) => secure.handleExchange(req, reply));
  app.post("/cg/v1/cancel",     (req, reply) => secure.handleCancel(req, reply));
  if (config.cg.requireSecure) {/* 跳过 registerCsapi 的明文 /v1/* 或让其返回 426 */}
}
```

## 5. 配置项（`apps/server/src/config.ts`，P2 新增）

```ts
CG_SECURE_ENABLED: booleanEnv(false),
CG_REQUIRE_SECURE: booleanEnv(false),
CG_SERVER_CERT_FILE: z.string().default(""),        // Ed25519 根签发的服务端证书
CG_SERVER_HPKE_KEY_FILE: z.string().default(""),    // 密封的服务端 HPKE 私钥
CG_SERVER_SIGNING_KEY_FILE: z.string().default(""), // 密封的服务端 ES256 私钥
CG_PAD_BUCKETS: z.string().default("512,2048,8192,32768,131072"),
```

## 6. fail-closed / 日志约束

- 任一步失败 → `CgSecureError(reason)`，HTTP 层转成 4xx 或密文 error 帧；**绝不**回退明文、**绝不**回显秘密。
- reason 码沿用 `verifyRunnerIdentityCert` 风格：`server_cert_epoch_rejected`、`handshake_unwrap_failed`、
  `c2s_sequence_replayed`、`c2s_decrypt_failed`、`device_auth_invalid`、`authentication_error`、`malformed_envelope`。
- `/cg/v1/*` 一律不记录 payload / 内层明文 / apiKey；只记 `sessionId`/`deviceId`/序列/尺寸桶/耗时/结果码。
  现有 logger 已 redact `req.body`（`index.ts`），无需回退该保护。
