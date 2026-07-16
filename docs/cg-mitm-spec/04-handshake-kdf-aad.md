# 握手 / 密钥派生 / AAD 绑定 —— purpose 字符串精确定义

> 拟落地：**`packages/e2ee/src/`**（与现有 `requestKeyContext` / `requestPayloadAad` / `deriveContentKey` 并列）。
> 目标：给 `cg-mitm/1` 定义**逐字节确定**的 context / purpose / AAD，使 Adapter 与服务端派生出**完全一致**的
> 密钥与绑定，任何 MITM 篡改路由头 / 降级套件都导致 AEAD 或 HPKE open 失败（fail-closed）。

## 0. 复用的现有原语（签名已核对 `packages/e2ee/src/index.ts`）

- `deriveContentKey(rootKey, purpose)`：HKDF-SHA256，**salt = `E2EE_PROTOCOL`（= `"cg-e2ee/1"`）**，
  **info = utf8(`` `cursor-gateway:${purpose}` ``)** → AES-256-GCM key。`encryptJson` / `decryptJson` 内部调用它。
- `hpkeSeal/open`：HPKE 的 `info = SHA-256(canonicalBytes(context))`，`aad = canonicalBytes(context)`。
- `signValue(value, privKey, keyId)` / `verifyValue(value, sig, pubKey)`：ES256 over `canonicalBytes(value)`。
- `canonicalJson` / `canonicalBytes`：确定性 JSON（键排序、无空格），是所有 context / AAD 的序列化基准。

> **设计决定（复用优先）**：cg-mitm 帧加密**直接复用 `encryptJson`/`decryptJson`**，因此 HKDF salt 固定为
> `"cg-e2ee/1"`（deriveContentKey 内硬编码）。域分离由**唯一的 purpose 字符串**（全部以 `cg-mitm/1:` 前缀）
> 与 **AAD 绑定**保证，已足够。若 P1 想要独立 salt，可另加 `deriveCgMitmKey(root, purpose)`，salt=`"cg-mitm/1"`，
> 但**非必需**，且会偏离「尽量不发明新密码学」。本规格采用复用方案。

## 1. purpose 字符串（唯一、协议前缀、方向隔离）

```ts
export const CG_MITM_PROTOCOL = "cg-mitm/1";

// 会话帧 AEAD（方向隔离 = 不同 purpose ⇒ HKDF 派生不同 key，天然单向）
export const C2S_PURPOSE   = "cg-mitm/1:c2s-frame"; // Adapter → csapi
export const S2C_PURPOSE   = "cg-mitm/1:s2c-frame"; // csapi → Adapter
// enroll 一次性通道（与会话帧隔离）
export const ENROLL_PURPOSE = "cg-mitm/1:enroll";
```

- 最终进入 HKDF 的 `info` 分别是：
  `cursor-gateway:cg-mitm/1:c2s-frame` / `...:s2c-frame` / `...:enroll`。
- **方向隔离**：c2s 与 s2c 用不同 purpose ⇒ 不同 AES key，杜绝反射 / 交叉重放。

## 2. 握手 context（进 HPKE `info` + `aad`）—— `buildHandshakeContext`

Adapter 与服务端必须构造**逐字段相同**的对象；`canonicalJson` 保证序列化一致。

```ts
export function buildHandshakeContext(v: {
  serverCertId: string; epoch: number; deviceId: string; adapterNonce: string; minSuite: string;
}): JsonValue {
  return {
    protocol: "cg-mitm/1",
    purpose: "handshake",
    serverCertId: v.serverCertId,   // 绑定到具体服务端证书（epoch）
    epoch: v.epoch,                 // 防 epoch 回退
    deviceId: v.deviceId,           // 绑定注册设备
    adapterNonce: v.adapterNonce,   // = sessionId（= sha256(enc)），一次性
    minSuite: v.minSuite            // 防套件降级
  };
}
```

- `wrapRootKey(sessionRoot, serverHpkePublic, handshakeContext)` → `enc`。
- `sessionId = base64url(SHA-256(decodeBase64Url(enc.enc)))`（长度 43）。**MITM 改任何一个字段**（epoch/minSuite/
  serverCertId/deviceId）都会使服务端 `unwrapRootKey` 用不同 context → HPKE open 失败 → `handshake_unwrap_failed`。

## 3. 设备认证（首帧，无需长期 key 进 header）

- Adapter 用**设备 ES256 私钥**对**同一个 `handshakeContext`** 签名：
  `deviceAuth = signValue(handshakeContext, deviceSigningPrivateKey, deviceSigningKeyId)`。
- 服务端用 enroll 时存的**设备证书公钥**验签：
  `verifyValue(handshakeContext, deviceAuth, importSigningPublicKey(deviceCert.signingKey.publicKey))`。
- 校验点：`deviceAuth.keyId === deviceCert.signingKey.keyId`（对齐 `verifyCsAuthGrant` 的 keyId 一致性检查）。
- 通过 ⇒ 设备已认证，且**长期 key 从未进 HTTP header**（签名在内层明文 `cgExchangeInner.deviceAuth`）。

## 4. c2s AAD（进 `encryptJson` 的 `additionalData`）—— `buildC2sAad`

仿照现有 `requestPayloadAad`（`packages/e2ee/src/index.ts`）：把**所有明文路由头**放进 AAD，篡改即解密失败。

```ts
export function buildC2sAad(env: {
  sessionId: string; sequence: number; kind: string; // "exchange-request" | "cancel-request"
}): JsonValue {
  return {
    protocol: "cg-mitm/1",
    direction: "c2s",
    kind: env.kind,
    sessionId: env.sessionId,
    sequence: env.sequence   // 进 AAD ⇒ 跨帧重排/重放被 AEAD 拒绝
  };
}
```

## 5. s2c AAD —— `buildS2cAad`

```ts
export function buildS2cAad(v: {
  sessionId: string; sequence: number; frameType: string; // open|delta|usage|done|error
}): JsonValue {
  return {
    protocol: "cg-mitm/1",
    direction: "s2c",
    sessionId: v.sessionId,
    sequence: v.sequence,
    frameType: v.frameType   // 绑定帧类型，防帧类型混淆
  };
}
```

## 6. enroll context / AAD

```ts
export function buildEnrollContext(env: { serverCertId: string; epoch: number }): JsonValue {
  return { protocol: "cg-mitm/1", purpose: "enroll-handshake",
           serverCertId: env.serverCertId, epoch: env.epoch };
}
export function buildEnrollAad(env: { serverCertId: string; epoch: number }): JsonValue {
  return { protocol: "cg-mitm/1", direction: "enroll", serverCertId: env.serverCertId, epoch: env.epoch };
}
```

## 7. 服务端 / 设备证书签名的规范字段（对齐 `runnerCertTranscript`）

```ts
// 离线根（Ed25519）签名的规范字段（服务端证书）：
export function cgServerCertTranscript(cert: Omit<CgServerIdentityCert, "signature">): JsonValue {
  return {
    protocol: cert.protocol, kind: cert.kind, version: cert.version, certId: cert.certId,
    serverId: cert.serverId, epoch: cert.epoch,
    hpkeFingerprint: cert.hpkeKey.fingerprint, hpkeKeyId: cert.hpkeKey.keyId,
    signingFingerprint: cert.signingKey.fingerprint, signingKeyId: cert.signingKey.keyId,
    allowedOrigins: [...cert.allowedOrigins].sort(),
    issuedAt: cert.issuedAt, expiresAt: cert.expiresAt,
    rootKeyId: cert.rootKeyId, rootFingerprint: cert.rootFingerprint, alg: cert.alg
  };
}
// 服务端 ES256 签名的规范字段（设备证书）：
export function cgDeviceCertTranscript(cert: Omit<CgDeviceCert, "signature">): JsonValue {
  return {
    protocol: cert.protocol, kind: cert.kind, version: cert.version, deviceId: cert.deviceId,
    signingFingerprint: cert.signingKey.fingerprint, signingKeyId: cert.signingKey.keyId,
    encryptionFingerprint: cert.encryptionKey.fingerprint, encryptionKeyId: cert.encryptionKey.keyId,
    keyIdHint: cert.keyIdHint, issuedAt: cert.issuedAt, expiresAt: cert.expiresAt,
    serverCertId: cert.serverCertId
  };
}
```

## 8. Ed25519 根验签（P1，`packages/e2ee`）

```ts
// alg 判别：EdDSA → Node 原生（Node ≥22）；ES256 → 复用 verifyValue。
import { verify as nodeVerify } from "node:crypto";
export async function verifyCgSignature(value: unknown, sig: { alg: "EdDSA"|"ES256"; keyId: string; value: string }, pub: CryptoKey | KeyObject): Promise<boolean> {
  const data = canonicalBytes(value);
  if (sig.alg === "ES256") return verifyValue(value, sig as E2eeSignature, pub as CryptoKey); // ↩ 复用
  // EdDSA：pub 为 Ed25519 KeyObject（从 cgEd25519PublicKey 导入）
  return nodeVerify(null, data, pub as KeyObject, decodeBase64Url(sig.value));
}
```

## 9. 序列 / 重放 / 幂等（跨 Adapter 与服务端一致）

- **序列**：c2s / s2c 各自单调递增，从 1 起；进 AAD。服务端维护 `lastC2sSeq`，Adapter 维护 `lastS2cSeqSeen`；
  `seq ≤ lastSeen` → 拒绝（`*_sequence_replayed`）。
- **握手一次性**：`sessionId = sha256(enc)`；服务端缓存已用 `enc` 指纹，重复握手 → `handshake_enc_replayed`。
- **幂等**：`idempotencyKey`（uuid）→ 服务端 run 缓存，重复投递返回同一结果（resume / 去重），不重复执行。
- **nonce**：沿用 `encryptJson` 的随机 12 字节 nonce（每帧新随机），叠加 AAD 里的 `sequence` 双重防重排。

## 10. 与现有 `cg-e2ee/1` 的关系

- salt 仍为 `"cg-e2ee/1"`（`deriveContentKey` 内），但**所有 purpose 与 context 的 `protocol` 字段均为
  `"cg-mitm/1"`**，且 purpose 前缀 `cg-mitm/1:`，与现有 e2ee 通道（purpose 如 `conversation-root`、
  `adapter…` 未使用）**天然不冲突**。两条通道共用密码学原语，但密钥域完全隔离。
