# cg-mitm/1 — Zod schema 草案（规格级伪代码）

> 拟落地：`packages/shared/src/`（P1 与现有 `packages/shared/src/index.ts` 的 `e2ee*` schema 并列导出）。
> 本文件是**规格级伪代码**，字段命名 / 长度上限对齐现有 `e2ee*` schema 风格（`.strict()`、`base64UrlSchema(n).length(n)`、
> `z.string().uuid()`、`z.string().min(1).max(64)` 的时间戳等）。可编译参考见同目录 `cgMitm.draft.ts`。

## 0. 复用与新增边界

- **直接复用**（从 `@cursor-gateway/shared` 导入，不重复定义）：
  `e2eePublicKeySchema`、`e2eeKeyDescriptorSchema`、`e2eeCiphertextSchema`、`e2eeHpkeEnvelopeSchema`、
  `e2eeSignatureSchema`、`e2eeTrustRootPublicSchema`、`e2eeRunnerIdentityCertSchema`。
- **握手用 HPKE 只封 32B 根**：`e2eeHpkeEnvelopeSchema.ciphertext` 上限 = 64 char base64url（= 48 字节 = 32B 根 + 16B GCM tag），
  正好且只够装 32 字节 `sessionRoot`。**请求体不走 HPKE**，走 `e2eeCiphertextSchema`（`ciphertext` 上限 2,000,000 char），
  由 `encryptJson` 分帧加密。这样两种 envelope 都复用现有 schema，无需放宽 HPKE 限制。

```ts
import { z } from "zod";
import {
  e2eeCiphertextSchema,
  e2eeHpkeEnvelopeSchema,
  e2eeKeyDescriptorSchema,
  e2eePublicKeySchema,
  e2eeSignatureSchema
} from "./index.js";

export const CG_MITM_PROTOCOL = "cg-mitm/1" as const;

// 复用现有 base64url 收窄风格（现有 index.ts 内部私有，这里显式重建同款）。
const base64Url = (max: number) => z.string().min(1).max(max).regex(/^[A-Za-z0-9_-]+$/);
const fingerprint = z.string().regex(/^sha256:[A-Za-z0-9_-]{43}$/);
const isoTime = z.string().min(1).max(64);
```

## 1. `alg` 判别字段（离线根用 Ed25519，在线签名用 ES256）

现有 `e2eeTrustRootPublicSchema` / `e2eeRunnerIdentityCertSchema` 的根公钥是 P-256（`e2eePublicKeySchema`）、
签名是 ES256。cg-mitm 要求**离线根用 Ed25519**。为不破坏现有 schema，新增**判别式**类型（P1 可
选择：给现有 schema `.extend({ alg })` 并默认 `"ES256"` 向后兼容，或如下独立定义 v2 根）。

```ts
export const cgSignatureAlgSchema = z.enum(["EdDSA", "ES256"]);

// Ed25519 公钥（OKP）。与现有 P-256 EC 公钥并列，用 alg 区分。
export const cgEd25519PublicKeySchema = z
  .object({
    kty: z.literal("OKP"),
    crv: z.literal("Ed25519"),
    x: base64Url(43).length(43) // 32 字节 base64url
  })
  .strict();

// 离线根（v2，带 alg）。EdDSA → OKP 公钥；ES256 → 复用现有 P-256 EC 公钥。
export const cgTrustRootPublicSchema = z
  .object({
    protocol: z.literal(CG_MITM_PROTOCOL),
    kind: z.literal("cg-trust-root-public/1"),
    alg: cgSignatureAlgSchema,
    keyId: z.string().trim().min(8).max(128),
    fingerprint,
    publicKey: z.union([cgEd25519PublicKeySchema, e2eePublicKeySchema]),
    epoch: z.number().int().nonnegative().max(1_000_000),
    createdAt: isoTime
  })
  .strict();
export type CgTrustRootPublic = z.infer<typeof cgTrustRootPublicSchema>;
```

> 验签落点（`packages/e2ee`，P1）：`alg==="EdDSA"` → Node 原生 `crypto.verify(null, data, edKey, sig)`（Node ≥22）；
> `alg==="ES256"` → 复用现有 `verifyValue`。根私钥永不上线（离线机 / HSM）。

## 2. server-keys 公告 + Ed25519 根签发的服务端证书

`GET /cg/v1/server-keys` 返回服务端证书（结构对齐 `e2eeRunnerIdentityCert`，把 `runnerId` 换成 `serverId`、
`allowedRpIds` 换成 `allowedOrigins`）。**服务端证书由 Ed25519 离线根签名**；服务端**每会话 / key bundle**
的在线签名仍用 ES256。

```ts
// 服务端证书被离线根签名的规范字段（对齐 runnerCertTranscript 风格；见 04-handshake-kdf-aad.md）。
export const cgServerIdentityCertSchema = z
  .object({
    protocol: z.literal(CG_MITM_PROTOCOL),
    kind: z.literal("cg-server-identity-cert/1"),
    version: z.literal(1),
    certId: z.string().uuid(),
    serverId: z.string().trim().min(1).max(128),          // e.g. "csapi.joelzt.org"
    epoch: z.number().int().nonnegative().max(1_000_000),
    hpkeKey: e2eeKeyDescriptorSchema,                      // 服务端静态 HPKE 公钥（握手固定目标）
    signingKey: e2eeKeyDescriptorSchema,                   // 服务端 ES256 在线签名公钥
    allowedOrigins: z.array(z.string().url().max(512)).min(1).max(16),
    issuedAt: isoTime,
    expiresAt: isoTime,
    rootKeyId: z.string().trim().min(8).max(128),
    rootFingerprint: fingerprint,                          // Adapter 离线固定的锚
    alg: cgSignatureAlgSchema,                             // 根签名算法：期望 "EdDSA"
    signature: e2eeSignatureSchema.or(                     // 复用 ES256 结构；EdDSA 用同形状 { alg:"EdDSA", keyId, value }
      z.object({ alg: z.literal("EdDSA"), keyId: z.string().trim().min(8).max(128), value: base64Url(120) }).strict()
    )
  })
  .strict();
export type CgServerIdentityCert = z.infer<typeof cgServerIdentityCertSchema>;

// GET /cg/v1/server-keys 响应
export const cgServerKeysResponseSchema = z
  .object({
    protocol: z.literal(CG_MITM_PROTOCOL),
    kind: z.literal("server-keys"),
    serverId: z.string().trim().min(1).max(128),
    epoch: z.number().int().nonnegative().max(1_000_000),
    cert: cgServerIdentityCertSchema,                      // 当前 epoch 服务端证书
    previousCert: cgServerIdentityCertSchema.nullable(),   // rotation 重叠窗口内的旧 epoch（可空）
    trustRoots: z.array(cgTrustRootPublicSchema).min(1).max(8), // 公钥公开材料（含 Ed25519 根）
    minSuite: z.literal("HPKE-v1-P256-HKDF-SHA256-A256GCM"),    // 降级保护基线
    createdAt: isoTime
  })
  .strict();
export type CgServerKeysResponse = z.infer<typeof cgServerKeysResponseSchema>;
```

## 3. enroll 请求 / 响应 + 设备证书

首次注册：Adapter 生成**非导出**设备密钥（HPKE + ES256，复用 `generateNonExtractableDeviceKeys`），
在 enroll envelope **内层**提交一次 API key 授权；服务端 ES256 签发设备证书 + `deviceId`。

```ts
// enroll 内层明文（走 encryptJson 到临时握手根，或直接 HPKE 封给服务端 HPKE 公钥；见 §5 说明）。
export const cgEnrollInnerSchema = z
  .object({
    protocol: z.literal(CG_MITM_PROTOCOL),
    kind: z.literal("enroll-inner"),
    apiKey: z.string().min(1).max(512),                 // 一次性授权注册，绝不进 header
    deviceSigningKey: e2eeKeyDescriptorSchema,          // 设备 ES256 公钥（长期）
    deviceEncryptionKey: e2eeKeyDescriptorSchema,       // 设备 HPKE 公钥（长期）
    label: z.string().trim().min(1).max(128).nullable(),
    createdAt: isoTime
  })
  .strict();

// enroll 请求外层（明文路由头进 AAD；enc 封握手根，payload 为上面的内层明文）。
export const cgEnrollRequestSchema = z
  .object({
    protocol: z.literal(CG_MITM_PROTOCOL),
    kind: z.literal("enroll-request"),
    serverCertId: z.string().uuid(),
    epoch: z.number().int().nonnegative().max(1_000_000),
    enc: e2eeHpkeEnvelopeSchema,                         // HPKE 封 32B enrollRoot
    payload: e2eeCiphertextSchema,                       // encryptJson(enrollRoot, purpose, aad, cgEnrollInner)
    createdAt: isoTime
  })
  .strict();
export type CgEnrollRequest = z.infer<typeof cgEnrollRequestSchema>;

// 设备证书（ES256 服务端签名，非离线根；对齐 e2eeRunnerIdentityCert 风格）。
export const cgDeviceCertSchema = z
  .object({
    protocol: z.literal(CG_MITM_PROTOCOL),
    kind: z.literal("cg-device-cert/1"),
    version: z.literal(1),
    deviceId: z.string().uuid(),
    signingKey: e2eeKeyDescriptorSchema,                // = enroll 提交的设备签名公钥
    encryptionKey: e2eeKeyDescriptorSchema,             // = enroll 提交的设备 HPKE 公钥
    keyIdHint: z.string().trim().min(1).max(128),       // 授权此设备的 apiKeyId（非秘密 bucket id, 见 protocol.ts apiKeyId）
    issuedAt: isoTime,
    expiresAt: isoTime,
    serverCertId: z.string().uuid(),                    // 签发时的服务端证书
    signature: e2eeSignatureSchema                      // ES256 服务端签名
  })
  .strict();
export type CgDeviceCert = z.infer<typeof cgDeviceCertSchema>;

export const cgEnrollResponseSchema = z
  .object({
    protocol: z.literal(CG_MITM_PROTOCOL),
    kind: z.literal("enroll-response"),
    status: z.enum(["enrolled", "rejected"]),
    reason: z.string().trim().regex(/^[a-z][a-z0-9_]{1,127}$/).optional(), // 安全 reject 码（无秘密）
    deviceCert: cgDeviceCertSchema.optional(),
    payload: e2eeCiphertextSchema.optional(),           // 若把 deviceCert 也密文回传（推荐）
    createdAt: isoTime
  })
  .strict();
export type CgEnrollResponse = z.infer<typeof cgEnrollResponseSchema>;
```

## 4. exchange 请求 envelope + 内层明文

```ts
export const cgWireSchema = z.enum(["anthropic", "openai"]);
export const cgFrameTypeSchema = z.enum(["open", "delta", "usage", "done", "error"]);

// 外层：明文路由头（进 AAD，被完整性保护），仅 enc 在首帧出现。
export const cgExchangeRequestSchema = z
  .object({
    protocol: z.literal(CG_MITM_PROTOCOL),
    kind: z.literal("exchange-request"),
    sessionId: base64Url(43).length(43),                // = sha256(enc) base64url（见 04 §握手）
    deviceId: z.string().uuid(),
    serverCertId: z.string().uuid(),
    epoch: z.number().int().nonnegative().max(1_000_000),
    enc: e2eeHpkeEnvelopeSchema.optional(),             // 仅首帧：HPKE 封 32B sessionRoot
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), // c2s 单调递增，从 1 起
    idempotencyKey: z.string().uuid(),                  // resume / 去重
    createdAt: isoTime,
    payload: e2eeCiphertextSchema                        // encryptJson(sessionRoot, C2S_PURPOSE, aad, cgExchangeInner)
  })
  .strict();
export type CgExchangeRequest = z.infer<typeof cgExchangeRequestSchema>;

// 内层明文（payload 解密后）：所有敏感数据都在这里。
export const cgExchangeInnerSchema = z
  .object({
    protocol: z.literal(CG_MITM_PROTOCOL),
    kind: z.literal("exchange-inner"),
    apiKey: z.string().min(1).max(512),                 // csapi key，绝不进 header
    wire: cgWireSchema,                                 // 决定复用 handleAnthropic / handleOpenAi
    body: z.record(z.string(), z.unknown()),            // 原样 CLI 请求体（messages/system/model/stream…）
    sessionKey: z.string().trim().min(1).max(256).nullable(), // 映射 csapi 会话（x-session-id 语义）
    clientAbortable: z.boolean().default(true),
    deviceAuth: e2eeSignatureSchema,                    // 设备 ES256 对 handshakeContext 的签名（首帧认证；见 04）
    pad: z.string().max(200_000).optional()             // 随机填充到固定桶（仅降低流量分析）
  })
  .strict();
export type CgExchangeInner = z.infer<typeof cgExchangeInnerSchema>;
```

## 5. 密文响应 envelope + 密文 SSE 帧

```ts
// 非流式响应外层。
export const cgExchangeResponseSchema = z
  .object({
    protocol: z.literal(CG_MITM_PROTOCOL),
    kind: z.literal("exchange-response"),
    sessionId: base64Url(43).length(43),
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), // s2c 单调递增
    createdAt: isoTime,
    payload: e2eeCiphertextSchema                        // encryptJson(sessionRoot, S2C_PURPOSE, aad, cgResponseInner)
  })
  .strict();

// 非流式响应内层明文（Adapter 侧解密后重建标准 Anthropic/OpenAI 响应）。
export const cgResponseInnerSchema = z
  .object({
    kind: z.literal("response-inner"),
    ok: z.boolean(),
    httpStatus: z.number().int().min(100).max(599),      // 复用 csapi 错误状态码语义（429/4xx/5xx）
    wire: cgWireSchema,
    body: z.record(z.string(), z.unknown()).nullable(),  // 标准响应体（buildAnthropicResponse/buildOpenAiResponse 形状）
    errorKind: z.string().trim().max(64).optional(),
    pad: z.string().max(200_000).optional()
  })
  .strict();

// 密文 SSE 帧：每个 SSE `data:` 行 = 一条 base64url 的 s2c AEAD record。
// wire 格式：  event: cg\n  data: <base64url(E2eeCiphertext-as-json)>\n\n
// 帧内层明文（frameType 决定 CLI 侧重放为哪种标准 SSE 帧）。
export const cgSseFrameInnerSchema = z
  .object({
    kind: z.literal("sse-frame-inner"),
    frameType: cgFrameTypeSchema,                        // open | delta | usage | done | error
    sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    // frameType==="delta"  → { text }
    // frameType==="usage"  → { inputTokens, outputTokens }
    // frameType==="error"  → { errorKind, message? }
    // frameType==="open"   → { id, model }
    // frameType==="done"   → {}
    data: z.record(z.string(), z.unknown()),
    pad: z.string().max(65_536).optional()
  })
  .strict();
export type CgSseFrameInner = z.infer<typeof cgSseFrameInnerSchema>;
```

> **为何这样切分**：`open/delta/usage/done/error` 直接一一映射到 `protocol.ts` 现有帧构造器
> （`buildAnthropicStreamFrames` 的 `message_start`/`content_block_delta`/`message_delta`/`message_stop`
> 与 `buildOpenAiStreamFrames` 的 chunk / `[DONE]`）。Adapter 逐帧解密后本地重放，CLI 完全无感。

## 6. cancel envelope

```ts
export const cgCancelRequestSchema = z
  .object({
    protocol: z.literal(CG_MITM_PROTOCOL),
    kind: z.literal("cancel-request"),
    sessionId: base64Url(43).length(43),
    deviceId: z.string().uuid(),
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    createdAt: isoTime,
    payload: e2eeCiphertextSchema                        // encryptJson(sessionRoot, C2S_PURPOSE, aad, { idempotencyKey })
  })
  .strict();
export type CgCancelRequest = z.infer<typeof cgCancelRequestSchema>;

export const cgCancelInnerSchema = z
  .object({
    kind: z.literal("cancel-inner"),
    idempotencyKey: z.string().uuid()
  })
  .strict();
```

## 7. 请求体 body 包装（HTTP 层）

```ts
// POST /cg/v1/exchange 的 HTTP body 就是 cgExchangeRequestSchema（.strict() 解析）。
// POST /cg/v1/enroll   → cgEnrollRequestSchema
// POST /cg/v1/cancel   → cgCancelRequestSchema
// GET  /cg/v1/server-keys → 200 cgServerKeysResponseSchema（唯一半明文端点：公钥公开材料，无秘密）
```

## 8. 落地注意（P1）

- 所有新 schema 一律 `.strict()`，拒绝未知字段（对齐现有 e2ee schema）。
- 时间戳字段统一 `isoTime`（`min(1).max(64)`）。
- `base64Url(n).length(n)` 精确长度：`sessionId`/fingerprint = 43（32 字节 SHA-256）。
- Ed25519 签名 base64url 长度 ≈ 86（64 字节）；这里给 `value: base64Url(120)` 留裕度，P1 收窄到精确 `.length(86)`。
- 新增导出**不改动**现有 `e2ee*` 导出，纯增量。
