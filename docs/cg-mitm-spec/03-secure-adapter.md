# Secure Adapter 骨架（规格级伪代码）

> 拟落地：**`apps/secure-adapter/`**（新 workspace，Node ≥22，`type:module`；与 `apps/windows-runner` 同栈）。
> 职责：在本机 loopback 暴露 Anthropic/OpenAI 兼容门面 → 封 `cg-mitm/1` envelope → 经 TLS 送 `/cg/v1/*`
> → 解密 s2c → 本地重放标准流给 CLI。**明文只在本进程内**；**fail-closed，绝不回退明文直连 csapi**。

## 0. 信任锚与配置

```ts
export interface AdapterConfig {
  listenPort: number;             // 127.0.0.1:PORT（CLI 的 base URL）
  loopbackKey: string;            // CLI 填的本地 key（仅本机校验，非 csapi key）
  upstreamUrl: string;            // https://csapi.joelzt.org
  apiKey: string;                 // 真正的 csapi key（进 envelope 内层，绝不进 header）
  pinnedRootFingerprints: string[]; // 离线固定的 Ed25519 根指纹（sha256:...）—— 唯一信任锚
  minSuite: "HPKE-v1-P256-HKDF-SHA256-A256GCM";
  padBuckets: number[];
  statePath: string;              // 密封的设备密钥 + deviceCert 缓存
}
```

> **只固定根指纹，不 pin Cloudflare TLS 证书**。TLS 用系统信任链正常校验（企业 CA 也放行），
> 机密性完全靠应用层 —— 即便企业 CA MITM 解开 TLS，看到的只是绑定服务端 HPKE 公钥的 `cg-mitm/1` 密文。

## 1. 启动流程

```ts
async function main(cfg: AdapterConfig) {
  const device = await loadOrEnrollDevice(cfg);   // §3
  const serverKeys = await fetchAndVerifyServerKeys(cfg); // §2 —— 失败即 fail-closed 退出
  const client = new SecureClient(cfg, device, serverKeys); // 持有握手 / 会话状态
  startLoopbackFacade(cfg, client);               // §4
}
```

## 2. 拉取并验证 server-keys（不 pin TLS，pin 根指纹）

```ts
async function fetchAndVerifyServerKeys(cfg: AdapterConfig): Promise<CgServerKeysResponse> {
  const res = await fetch(`${cfg.upstreamUrl}/cg/v1/server-keys`);        // 普通 TLS
  const parsed = cgServerKeysResponseSchema.parse(await res.json());       // 结构校验
  // 1) 根指纹必须在离线固定集内：
  const root = parsed.trustRoots.find(r => cfg.pinnedRootFingerprints.includes(r.fingerprint));
  if (!root) failClosed("root_fingerprint_not_pinned");
  // 2) 服务端证书由该根签名（Ed25519）+ 有效期 + origin + epoch 校验：
  const ok = await verifyServerCert({                                      // 复用 verifyRunnerIdentityCert 同款逻辑
    cert: parsed.cert, root,
    expected: { serverId: parsed.serverId, origin: cfg.upstreamUrl },
    nowMs: Date.now()
  });
  if (!ok.ok) failClosed(ok.reason);                                       // e.g. cert_expired / trust_root_not_found
  // 3) minSuite 不得低于固定基线（降级保护）：
  if (parsed.minSuite !== cfg.minSuite) failClosed("suite_downgrade");
  return parsed; // 缓存；有效期内自动接受新 epoch 的 HPKE 公钥（rotation 无需重新固定）
}
```

## 3. enroll（首次注册，设备密钥非导出）

```ts
async function loadOrEnrollDevice(cfg: AdapterConfig): Promise<DeviceState> {
  const cached = await readSealedState(cfg.statePath); // 有则直接用
  if (cached?.deviceCert && !isExpired(cached.deviceCert)) return cached;

  const keys = await generateNonExtractableDeviceKeys(); // ↩ 复用（HPKE + ES256，非导出）
  const signingDesc = await createKeyDescriptor(keys.signing.publicKey);      // ↩ 复用
  const encryptionDesc = await createKeyDescriptor(keys.encryption.publicKey); // ↩ 复用

  // 用一次性 enrollRoot HPKE 封给服务端 HPKE 公钥；apiKey 在内层明文里授权一次：
  const enrollRoot = generateRootKeyBytes();          // ↩ 复用（32 字节）
  const enc = await wrapRootKey(enrollRoot, serverHpkePublic, buildEnrollContext(...)); // ↩ 复用
  const payload = await encryptJson(await importRootKey(enrollRoot), ENROLL_PURPOSE, buildEnrollAad(...), {
    protocol: "cg-mitm/1", kind: "enroll-inner", apiKey: cfg.apiKey,
    deviceSigningKey: signingDesc, deviceEncryptionKey: encryptionDesc, label: hostname(), createdAt: now()
  }); // ↩ 复用
  const res = cgEnrollResponseSchema.parse(await postJson(`${cfg.upstreamUrl}/cg/v1/enroll`, { /* enroll-request */ }));
  if (res.status !== "enrolled") failClosed(res.reason ?? "enroll_rejected");
  const deviceCert = /* 从 res.payload 解密得到 */;
  await writeSealedState(cfg.statePath, { keys, deviceCert }); // 密封落盘（对齐 windows-runner e2eeState 密封）
  return { keys, deviceCert };
}
```

## 4. loopback 门面（CLI 侧完全无感）

```ts
function startLoopbackFacade(cfg: AdapterConfig, client: SecureClient) {
  const app = Fastify();
  const auth = (req) => timingSafeEqualStr(extractApiKey(req.headers) ?? "", cfg.loopbackKey); // ↩ 复用 extractApiKey

  app.post("/v1/messages",        (req, reply) => handle(req, reply, "anthropic"));
  app.post("/v1/chat/completions",(req, reply) => handle(req, reply, "openai"));
  app.get("/v1/models",           (req, reply) => reply.send(cachedModels));  // 可缓存/透传
  app.get("/health",              (_r, reply) => reply.send({ ok: true, mode: "cg-mitm/1" }));

  async function handle(req, reply, wire: "anthropic"|"openai") {
    if (!auth(req)) return reply.code(401).send(errShape(wire, "invalid local key"));
    const stream = req.body?.stream === true;
    const idempotencyKey = crypto.randomUUID();
    const sessionKey = resolveSessionKey({ headers: req.headers, body: req.body }); // ↩ 复用（x-session-id 语义）
    try {
      if (!stream) {
        const inner = await client.exchange({ wire, body: req.body, sessionKey, idempotencyKey });
        return reply.send(inner.body); // 已是标准 Anthropic/OpenAI 响应形状
      }
      beginSse(reply);
      // CLI 断连 → abort → 发 /cg/v1/cancel
      const abort = new AbortController();
      reply.raw.on("close", () => { if (!reply.raw.writableFinished) { abort.abort(); void client.cancel(sessionKey, idempotencyKey); } });
      for await (const frame of client.exchangeStream({ wire, body: req.body, sessionKey, idempotencyKey, signal: abort.signal })) {
        // frame 已解密为标准 SSE 帧（用 buildAnthropic/ OpenAiStreamFrames 形状本地重放）
        reply.raw.write(serializeSse(frame)); // ↩ 复用 serializeSse
      }
      reply.raw.end();
    } catch (e) {
      // fail-closed：本地报错，绝不回退明文直连 csapi。
      if (stream) { writeSse(reply, errFrame(wire, e)); reply.raw.end(); }
      else reply.code(statusOf(e)).send(errShape(wire, reasonOf(e)));
    }
  }
}
```

## 5. `SecureClient`：握手 / 封包 / 解包 / 序列

```ts
class SecureClient {
  private session?: { sessionId: string; sessionRoot: CryptoKey; c2sSeq: number; s2cSeqSeen: number };

  // 首次调用建会话：生成 sessionRoot → HPKE 封 → 首帧带 enc。
  private async ensureSession(): Promise<Session> {
    if (this.session) return this.session;
    const rootBytes = generateRootKeyBytes();                          // ↩ 复用（32 字节）
    const enc = await wrapRootKey(rootBytes, this.serverHpkePublic, this.handshakeContext()); // ↩ 复用
    const sessionId = encodeBase64Url(await sha256(decodeBase64Url(enc.enc))); // = sha256(enc)
    const sessionRoot = await importRootKey(rootBytes);                // ↩ 复用（HKDF key）
    rootBytes.fill(0);
    this.session = { sessionId, sessionRoot, c2sSeq: 0, s2cSeqSeen: 0 };
    this.pendingEnc = enc; // 只在首帧发送
    return this.session;
  }

  private handshakeContext() { // 必须与服务端逐字节一致（进 HPKE info/AAD）
    return { protocol: "cg-mitm/1", purpose: "handshake",
             serverCertId: this.serverKeys.cert.certId, epoch: this.serverKeys.epoch,
             deviceId: this.device.deviceId, adapterNonce: /* = sessionId */, minSuite: this.cfg.minSuite };
  }

  async exchange(req): Promise<CgResponseInner> {
    const s = await this.ensureSession();
    const sequence = ++s.c2sSeq;
    const inner = {
      protocol: "cg-mitm/1", kind: "exchange-inner", apiKey: this.cfg.apiKey,
      wire: req.wire, body: req.body, sessionKey: req.sessionKey, clientAbortable: true,
      deviceAuth: await signValue(this.handshakeContext(), this.device.keys.signing.privateKey, this.device.signingKeyId), // ↩ 复用
      pad: padTo(this.cfg.padBuckets, req)
    };
    const aad = buildC2sAad({ sessionId: s.sessionId, sequence, kind: "exchange-request" });
    const payload = await encryptJson(s.sessionRoot, C2S_PURPOSE, aad, inner); // ↩ 复用
    const env = { protocol: "cg-mitm/1", kind: "exchange-request", sessionId: s.sessionId,
                  deviceId: this.device.deviceId, serverCertId: this.serverKeys.cert.certId,
                  epoch: this.serverKeys.epoch, ...(sequence === 1 ? { enc: this.pendingEnc } : {}),
                  sequence, idempotencyKey: req.idempotencyKey, createdAt: now(), payload };
    const res = cgExchangeResponseSchema.parse(await postJson(`${this.cfg.upstreamUrl}/cg/v1/exchange`, env));
    this.checkS2c(s, res.sequence);
    const respInner = cgResponseInnerSchema.parse(await decryptJson(s.sessionRoot, S2C_PURPOSE, buildS2cAad({ sessionId: s.sessionId, sequence: res.sequence, frameType: "done" }), res.payload)); // ↩ 复用
    if (!respInner.ok) throw new AdapterError(respInner.httpStatus, respInner.errorKind);
    return respInner;
  }

  async *exchangeStream(req): Asyncgenerator<StandardSseFrame> {
    // 同 exchange 建包，但 stream:true；对响应 SSE 逐行解密：
    const s = await this.ensureSession();
    const resp = await fetchSse(`${this.cfg.upstreamUrl}/cg/v1/exchange`, buildEnv(...));
    for await (const line of readSseLines(resp)) {                 // event: cg / data: <base64url(E2eeCiphertext)>
      if (line.isComment) continue;                                // ": keepalive" 心跳
      const frameInner = cgSseFrameInnerSchema.parse(await decryptJson(s.sessionRoot, S2C_PURPOSE, buildS2cAad({ sessionId: s.sessionId, sequence: line.seq, frameType: line.frameType }), line.ciphertext)); // ↩ 复用
      this.checkS2c(s, frameInner.sequence);
      // 映射回标准 SSE 帧（复用 protocol.ts 帧形），逐一 yield：
      yield* replayFrame(req.wire, frameInner); // open→message_start / delta→content_block_delta / usage→message_delta / done→message_stop|[DONE] / error→error
    }
  }

  async cancel(sessionKey, idempotencyKey) {
    const s = this.session; if (!s) return;
    const sequence = ++s.c2sSeq;
    const payload = await encryptJson(s.sessionRoot, C2S_PURPOSE, buildC2sAad({ sessionId: s.sessionId, sequence, kind: "cancel-request" }), { kind: "cancel-inner", idempotencyKey });
    await postJson(`${this.cfg.upstreamUrl}/cg/v1/cancel`, { protocol: "cg-mitm/1", kind: "cancel-request", sessionId: s.sessionId, deviceId: this.device.deviceId, sequence, createdAt: now(), payload });
  }

  private checkS2c(s, seq: number) { if (seq <= s.s2cSeqSeen) failClosed("s2c_sequence_replayed"); s.s2cSeqSeen = seq; }
}
```

## 6. resume（断线续跑）

```ts
// Adapter 断线重连后，对同一 CLI 请求用【同一 idempotencyKey】重发 /cg/v1/exchange：
// 服务端命中 idempotency 缓存 → 返回已完成结果或继续等待，不重复执行（对齐 e2eeProcessor 缓存语义）。
// sessionRoot 若因服务端重启失效（unknown_session）→ 重新握手（新 enc），但 idempotencyKey 不变以复用结果。
```

## 7. fail-closed 矩阵（对 CLI 表现）

| 触发 | Adapter 行为 |
|---|---|
| 根指纹不在固定集 / 服务端证书验签失败 / epoch 回退 | 启动即退出（不监听）或该请求本地 5xx；**不发任何明文** |
| `minSuite` 降级 / 剥 envelope 引导 | `suite_downgrade` 本地报错 |
| c2s/s2c 序列异常、AEAD 解密失败 | 本地报错，中止该请求 |
| 网络失败 / csapi 5xx | 本地报错；**不回退明文直连 csapi** |
| CLI 断连 | abort + `/cg/v1/cancel` |

## 8. 安装器（P5）

- 安装器把 **Ed25519 根指纹**离线写进 `AdapterConfig.pinnedRootFingerprints` + 配置 CLI base URL 为 `http://127.0.0.1:PORT`。
- 发布物 minisign/Sigstore 签名 + 两段式验签安装（见 `docs/cg-mitm.md` §8）。
