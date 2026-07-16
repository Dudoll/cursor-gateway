# 可信 CS 中继双跳应用层加密 + 同账号多设备历史同步

> **状态**：relay-P0 设计冻结（可实施规格）  
> **权威仓**：`/home/dministrator/cursor-e2ee`  
> **协议族**：客户端↔CS 复用 `cg-mitm/1`；历史落库 `cs-relay-v1`；CS→Runner 复用 `cg-e2ee/1` envelope  
> **来源**：agent 20036316 最终设计，落地为正式文档

复用已落地的 `cg-mitm/1`（`apps/server/src/csapi/secure.ts` + `apps/secure-adapter/`）、`packages/e2ee` / `packages/shared`、`cg-e2ee/1` runner processor、CS Web 与 DB。

---

## 0. 结论先行（不可回避的现实）

**纯浏览器网页方案，在"企业可替换 TLS 内容"的威胁模型下，无法自举可信代码。** 理由是硬约束，不是工程取舍：

- 如果企业在终端安装了根 CA 并做透明代理，那么浏览器加载 `https://cs.joelzt.org` 的**首包 HTML/JS 本身**就是被 MITM 解密后再重新加密下发的。攻击者可以在下发前替换 JS、注入公钥、改写内置 pin。
- 一旦 bootstrap 代码可被替换，之后任何 HPKE/证书 pin/SRI/CSP/Service Worker 都失效——因为**校验逻辑和被校验对象由同一个不可信信道下发**（攻击者同时控制"锁"和"钥匙"）。SRI 只能防 CDN 子资源被换，不能防主文档被换;CSP 由被换的响应头声明;SW 由被换的脚本注册。这是"信任锚必须离线到达"的经典结论。

**因此可信代码必须通过一条不被企业 TLS 覆盖的信道到达一次**，内置离线根公钥。落地为二选一（可并存）：

- **方案 A（推荐）签名浏览器扩展**：`apps/browser-extension` 经商店签名 / 组织受控签名渠道分发，`manifest.json` 已固定 `key`（ID `oicmfijjdbjkjhnljcjhnojpeiobhefe`）。扩展代码更新走 Chrome 签名更新渠道，不经企业 TLS 明文替换。扩展内置 Ed25519 根指纹，向页面注入 crypto bridge。
- **方案 B（推荐，CLI/桌面）本机 Secure Adapter**：`apps/secure-adapter` 已实现 loopback facade，浏览器/CLI 指向 `127.0.0.1`;安装器 `scripts/csapi/install-csapi-secure.sh` 离线固定根指纹 + fail-closed。发布物须 minisign/Sigstore/平台签名（P6）。
- **纯网页（PWA）只能有限承诺**：仅当**首次安装发生在可信网络/可信设备**（未被 MITM）时,PWA 缓存 + 固定的根公钥才有意义;此后若企业开始 MITM,已缓存的 SW 可继续用固定根。但**不能承诺**在"从一开始就被 MITM 的环境里首次打开网页"下的安全。这一点必须对用户显式说明,不得夸大。

下文推荐架构以 **方案 A/B 为默认可信客户端**,PWA 作为降级选项并明确标注其边界。

---

## 1. 信任模型与三类明文主体

**本方案不再是端到端加密(E2EE-to-runner)，而是"可信 CS 中继的双跳应用层加密"。** `cs.joelzt.org`(CS app 进程)被显式信任为**可解密节点**。

**允许看到明文的主体(且仅这三类):**
1. **客户端**:方案 A 的扩展/注入页面、方案 B 的本机 Adapter、以及"当前正在显示历史的已授权浏览器"。
2. **cs.joelzt.org 的 CS app 解密进程**(受控 decryptor/worker,见 §10)。
3. **Runner / 上游模型**(仅收到当前任务所需上下文,见 §9)。

**不得看到明文的主体:** 企业网关/代理、Cloudflare 边缘、nginx 反向代理、Postgres、Redis、备份/快照/WAL、日志/telemetry/core dump、CS 主机的 DBA/管理员(只能见 KMS 密文)。

**威胁覆盖:** 被动窃听、企业出口代理、企业根证书/伪证书 TLS 中间人、重放/篡改、跨账号越权读取。

**明确不承诺(与用户一致):**
- 不防终端被 root/EDR/恶意本地进程读取 Adapter 内存或 loopback key(客户端属信任域内)。
- 不防可信 CS app 本身被攻陷(设计前提)。
- 流量特征只能**降低**不能消除:padding+jitter 让长度/时序更难分析,但仍可识别"在与 CS 通信"。

---

## 2. 推荐架构(两项一级能力)

```
                         [企业网关 / 伪根 CA / mitmproxy]   ← 只见 cg-mitm/1 密文
                                      │  TLS(被MITM也无所谓)
   设备A(已授权)                       │                              设备B(已授权)
 ┌─────────────────┐                  │                          ┌─────────────────┐
 │ 方案A 扩展 crypto │                  ▼                          │ 方案A 扩展/方案B  │
 │ bridge / 方案B    │        ┌───────────────────────┐           │ Adapter           │
 │ 本机 Adapter      │◀──────▶│  Cloudflare 边缘 (TLS)  │◀────────▶│ (独立 cg-mitm     │
 │ 内置离线Ed25519根 │  应用层 │  nginx (仅密文透传)     │  应用层    │  session)         │
 └────────┬────────┘  密文    └───────────┬───────────┘  密文       └────────┬────────┘
          │ /cg/v1/exchange              │                                  │ /cg/v1/sync
          │ (client→CS 密文, CS 解密)    ▼                                  │
          │                  ┌───────────────────────────────────────────┐ │
          └─────────────────▶│      CS app 解密进程 (可信, 见明文)         │◀┘
                             │  · 验根/证书/握手/序列/重放/幂等/设备认证    │
                             │  · matchAccount+device → 解密内层           │
                             │  · 历史: DEK 加密落库; DEK←账号KEK←KMS主KEK │
                             │  · CS→Runner: 重新封装当前任务上下文        │
                             └───────┬───────────────────────┬───────────┘
              (密文落库, 无明文)      │                       │ mTLS + 应用层再加密
                     ┌───────────────▼──────────┐            ▼
                     │ Postgres/Redis/备份       │   ┌──────────────────┐
                     │ 只存: DEK密文 + 内容密文  │   │ Local Runner /    │
                     │       + 最小元数据        │   │ Hermes → 模型     │
                     └──────────────────────────┘   │ (只收当前上下文)  │
                                                     └──────────────────┘
```

**一级能力 1 —— 可信 CS 中继双跳:** 客户端↔CS 用 `cg-mitm/1` 应用层加密(与 TLS 解耦);CS 解密后,CS→Runner 用 `cg-e2ee/1` runner envelope 再加密(密钥由 CS 产生并封给 runner,而非浏览器直接封 runner)。

**一级能力 2 —— 同账号多设备历史明文:** CS 把会话/消息用**每会话 DEK**加密落库;DEK 由**账号 KEK**包裹;KEK 由 **CS KMS/HSM 主 KEK** 封装。任一台**已授权设备**登录后,CS 从 DB 取密文→KMS 解密→用该设备的 session key 重新加密下发→设备显示明文。设备间**无需共享内容密钥**(CS 可信),但每设备各自固定 server root,企业 MITM 不可读。

---

## 3. 明文可见性矩阵(逐组件)

| 组件 | 见明文? | 看到什么 |
|---|---|---|
| 客户端扩展/Adapter/当前显示历史的授权浏览器 | ✅ 明文 | prompt/response/历史明文/apiKey(仅内层) |
| 企业网关 / 伪根 CA / mitmproxy | ❌ | 仅 `cg-mitm/1` 密文 + TLS 元数据 |
| Cloudflare 边缘 | ❌ | 仅密文 + SNI/时间/大小 |
| nginx 反向代理 | ❌ | 仅密文透传(`/cg/v1/*` 豁免 Access,不解包) |
| **CS app 解密进程(decryptor/worker)** | ✅ 明文 | 处理期内存内明文(用完 zero-fill) |
| CS app 其他进程 | ❌ | 只经受控 IPC 拿密文/元数据 |
| Postgres | ❌ | DEK 密文 + 内容密文 + 最小元数据(accountId/时间/序列/大小桶/模型) |
| Redis(队列/缓存) | ❌ | 只放密文 + jobId/序列;不放明文 |
| 备份 / WAL / 快照 | ❌ | 同 DB,全密文 |
| 日志 / telemetry / core dump | ❌ | 计数/延迟/尺寸桶/结果码;core dump 关闭 |
| Runner | ✅ 明文 | **仅当前任务所需上下文**(非全部历史) |
| 上游模型 | ✅ 明文 | 当前任务 prompt/上下文(Gateway-blind 语义之外的既定前提) |
| CS 主机管理员/DBA | ❌ | 只能见 KMS 密文,无法从 DB 直接读明文 |

---

## 4. 浏览器抗 MITM bootstrap(可落地方案)

### 方案 A（推荐）：签名扩展 + 注入 crypto bridge
- 复用 `apps/browser-extension`;扩展 `background.ts` 内置离线 **Ed25519 根指纹**(与 `scripts/csapi/trust/csapi-trust-root-public.json` 一致,多渠道 out-of-band 核对)。
- 扩展页面(popup/options)或经 content script 注入的 **crypto bridge** 承担所有 `cg-mitm/1` 握手/加解密;`cs.joelzt.org` 页面只做 UI,所有敏感数据经 `window.postMessage`↔扩展受信上下文中转,**明文不落普通页面 DOM 之外的持久层**。
- 不可导出 `CryptoKey`(`generateNonExtractableDeviceKeys`)存扩展 origin IndexedDB。
- 更新走 Chrome Web Store / 企业 Force-install 策略(`ExtensionInstallForcelist`),不经企业 TLS 明文替换。

### 方案 B（推荐,CLI/桌面）：本机 Secure Adapter
- 复用 `apps/secure-adapter`:loopback facade(`facade.ts`)已支持 Anthropic/OpenAI 兼容 + 密文 SSE 重放。浏览器/CLI 把 base URL 指向 `http://127.0.0.1:PORT`。
- 安装器离线固定根指纹、探测核对 `/cg/v1/server-keys`、fail-closed(`install-csapi-secure.sh/.ps1`)。
- P6 叠加 minisign(Ed25519)+ Sigstore cosign + 平台签名(Notarization/Authenticode)+ 两段式验证器。

### 纯网页(PWA)边界(不可承诺项)
- 仅"可信首次安装(未被 MITM)"后有限保护;SW 固定根公钥可在后续 MITM 下继续用。
- **不承诺**:从一开始即被 MITM 环境下的首次打开;企业策略清缓存后的重装。
- UI 必须显式标注"此模式安全性弱于扩展/Adapter",并优先引导 A/B。

---

## 5. 客户端 → CS 协议(复用 `cg-mitm/1`,扩展账号绑定)

复用现有 `packages/shared/src/cgMitm.ts` 全部 schema 与 `apps/server/src/csapi/secure.ts` 处理骨架。**唯一协议增量**:enroll/exchange 绑定 `accountId`,并新增同步内层类型(§8)。

### 5.1 端点
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/cg/v1/server-keys` | 已实现。签名的服务端密钥公告:HPKE 公钥 + ES256 签名公钥 + Ed25519 根签发的服务端证书 + trustRoots + `minSuite`。客户端离线固定根指纹验证。 |
| POST | `/cg/v1/enroll` | **改**:内层增加账号身份证明(见 5.3);签发**账号绑定设备证书** `cg-device-cert/2`。 |
| POST | `/cg/v1/exchange` | 已实现。主通道:非流式密文响应 / `stream:true` 密文 SSE。 |
| POST | `/cg/v1/cancel` | 已实现。密文取消。 |
| POST | `/cg/v1/sync` | **新增**:密文历史同步(list/pagination/since cursor/incremental)。内层类型见 §8.2。 |
| GET | `/cg/v1/sync/stream` | **新增**:密文增量同步流(SSE),按 session key 加密。 |

`isCsapiPath()` 追加放行 `/cg/v1/sync`、`/cg/v1/sync/stream`(继续豁免 Cloudflare Access)。

### 5.2 握手/密钥派生/AAD(已冻结,复用 §04-handshake)
- **握手**:客户端 `wrapRootKey(sessionRoot, serverHpkePublic, handshakeContext)` → `enc`;`sessionId = base64url(SHA256(enc.enc))`。`handshakeContext` 绑定 `serverCertId/epoch/deviceId/adapterNonce/minSuite`——MITM 改任一字段 → `unwrapRootKey` 用不同 context → HPKE open 失败 → `handshake_unwrap_failed`(fail-closed)。
- **方向隔离**:`C2S_PURPOSE="cg-mitm/1:c2s-frame"` / `S2C_PURPOSE="cg-mitm/1:s2c-frame"` / `ENROLL_PURPOSE`;不同 purpose → HKDF 派生不同 AES key。
- **AAD**:`buildC2sAad{protocol,direction,kind,sessionId,sequence}` / `buildS2cAad{...,frameType}`——所有明文路由头进 AAD,篡改即 AEAD 失败。
- **设备认证**:`buildCgDeviceAuthTranscript{sessionId,deviceId,sequence,idempotencyKey}` 用设备 ES256 私钥签名,放内层 `deviceAuth`;长期 apiKey/身份**从不进 HTTP header**。

### 5.3 enroll 账号绑定(协议增量)
`cgEnrollInner` 增字段(新增 `cg-device-cert/2`):
```
cgEnrollInnerSchema.v2 = {
  protocol:"cg-mitm/1", kind:"enroll-inner",
  accountAuth: {                         // 三选一账号身份证明(见 §6.2)
    kind:"oidc"|"passkey"|"cf-access",
    idToken?:string,                     // OIDC id_token(内层,不进 header)
    passkeyAssertion?:{...},             // WebAuthn assertion(UV required)
    cfAccessJwt?:string                  // CF Access JWT(内层)
  },
  apiKey?:string,                        // 兼容旧 CLI(过渡期);账号模式下可省
  deviceSigningKey: KeyDescriptor,
  deviceEncryptionKey: KeyDescriptor,
  label:string|null, createdAt
}
cgDeviceCertSchema.v2 = { ...v1,
  accountId:string,                      // ★ 账号绑定
  deviceId:uuid, keyIdHint,              // keyIdHint 可继续携带 apiKey 匹配
  epoch:number,                          // 设备证书 epoch(撤销/轮换)
  signature: ES256(server) }
```
CS 侧:验证 `accountAuth`(OIDC 验签/aud/exp;passkey 验 UV+rpId+challenge;CF Access 验 JWT)→ 得 `accountId` → 持久化设备证书(见 §6.3,**修复当前 `deviceCerts` 仅在内存的缺陷**)→ 密文回传 `deviceCert`。

### 5.4 exchange(已实现,语义不变)
- 非流式:`ensureSession → checkC2sSequence → openC2s → verifyDeviceAuth → matchAccount(内层身份/keyId)→ execute()`;`sealS2c("done", response-inner)`。
- 流式:密文 SSE `open→delta*→usage→done|error`;10s 心跳;`reply.raw.on("close")` → abort + cancel。
- **exchange 后新增副作用**:CS 把本轮 prompt+response 作为历史用 DEK 加密落库(§7、§8),写入 `sequence` 单调递增,幂等键去重。

### 5.5 序列/重放/幂等/padding/rotation/fail-closed/downgrade(全部已实现,继续沿用)
- **序列**:c2s/s2c 各自单调递增进 AAD;`seq ≤ lastSeen` → `c2s_sequence_replayed`。
- **握手一次性**:`usedEnc` 缓存 enc 指纹 → `handshake_enc_replayed`。
- **幂等**:`idempotencyKey`(uuid)→ run 结果缓存;重复投递返回同结果(resume/去重),不重复执行。**改**:幂等表由内存升级为 Redis(密文)+ DB `runs.idempotency_key` 唯一索引(已存在 `runs_user_idempotency_active_unique`),支持跨进程/重启。
- **padding**:`withPad` 按 `CG_PAD_BUCKETS`(默认 `512,2048,8192,32768,131072`)补齐;P4 叠加发送 jitter。
- **key rotation**:`isAcceptedServerCert` 接受 current/previous 两 epoch 重叠窗口;客户端离线根不变,证书轮换无需重固定。设备证书 epoch 独立,撤销/轮换见 §6。
- **fail-closed**:任一步失败抛 `CgSecureError(reason)`,转 4xx/密文 error 帧;**绝不回退明文**;客户端 Adapter/扩展**绝不**回退明文直连。
- **downgrade protection**:裸请求(无 envelope)→ `malformed_envelope` 拒绝;`minSuite` 进握手 AAD;`CG_REQUIRE_SECURE=true` 时明文 `/v1/*` 返回 `426`。

---

## 6. 同账号多设备授权(一级能力)

### 6.1 标识模型
- `accountId`:账号主键(来自 OIDC sub / CF Access identity / passkey 绑定的用户)。历史与所有资源按 `accountId` 隔离。
- `deviceId`:每台已授权设备(扩展实例 / Adapter 实例 / 浏览器)一个,绑定其不可导出设备签名+HPKE 密钥。
- 一个 `accountId` 可有多个 `deviceId`(N 设备);历史属于 `accountId`,任一未撤销设备可读。

### 6.2 登录/身份来源(与现有配对通道对齐)
| 优先级 | 通道 | 复用现有 |
|---|---|---|
| 主 | **Passkey / WebAuthn(UV required)** | `apps/secure-web/src/passkeyPairing.ts`、`e2ee_passkey_pairings` 表、CF Access 身份 |
| 主 | **OIDC / CF Access** | `apps/server/src/auth.ts`、`ephemeralAccessJwt.ts`、`CF_ACCESS_*` |
| 备 | **已授权设备批准** | `signDeviceApprovalDecision`/`verifyDeviceApprovalDecision`、`deviceApprovalDb.ts`:新设备 pending,已授权设备签 transcript |
| 再备 | **恢复码** | `generateRecoverySecret`/`recoveryPairingTranscript`、`recoveryPairingDb.ts` |

### 6.3 设备 enrollment / 证书 / 撤销 / 丢失设备(新增 DB 表)
```
create table cg_devices (
  device_id uuid primary key,
  account_id text not null,
  signing_fingerprint text not null,
  encryption_fingerprint text not null,
  device_cert jsonb not null,            -- cg-device-cert/2(密文非必须:仅公钥材料)
  epoch int not null default 1,
  label text,
  status text not null default 'active', -- active|revoked
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  revoked_at timestamptz
);
create index cg_devices_account_idx on cg_devices(account_id) where status='active';
```
- **enrollment**:§5.3 流程;首台设备用 Passkey/OIDC 直接授权;后续设备可用 Passkey 或"已授权设备批准"。
- **设备证书**:`cg-device-cert/2` 由 CS ES256 私钥签发,绑定 `accountId+deviceId+epoch`。exchange/sync 每次 `verifyDeviceAuth` 时校验 `cg_devices.status='active'` 且 epoch 未回退。
- **撤销**:`POST /cg/v1/devices/:deviceId/revoke`(经已授权设备的 session,密文)→ `status='revoked'`;撤销后该设备的 `verifyDeviceAuth` 直接 `device_revoked` fail-closed → **旧设备无法再同步新内容**。已建立的 in-memory session 也需在下一帧校验 `status`(每帧查缓存,TTL≤30s)。
- **丢失设备**:用户在任一授权设备一键"撤销其他所有设备";可选**账号级 epoch bump**(见 §6.4)使被盗设备即使持有旧 DEK 缓存也无法读**新**会话。

### 6.4 权限与密钥语义(关键)
- CS 可信 ⇒ **设备间无需共享内容密钥**;每设备只需自己的 session key(临时)。历史内容密钥(DEK)只在 CS 内解密。
- 每设备**各自固定 server Ed25519 根** ⇒ 企业 MITM 对任何设备都不可读。
- **账户授权 = 设备证书(active)+ 账号 session**:两者缺一 → 拒绝。跨账号请求(设备证书 accountId ≠ 目标资源 accountId)→ `403 cross_account_denied`。
- **撤销/丢失后前向保护**:撤销设备后,对**新会话**分配的 DEK 用**新账号 KEK epoch** 包裹;被撤销设备即便缓存过旧 DEK,也读不到新会话(旧会话历史本就已在其本地显示过,无法追溯撤销)。

---

## 7. 历史存储(DB 不见明文;每会话 DEK + 账号 KEK + KMS 主 KEK)

### 7.1 三层密钥
```
CS 主 KEK (KMS/HSM)                       ← 不出 KMS/HSM;CS app 只调 wrap/unwrap
  └─ wrap →  账号 KEK (per-account, per-epoch)   ← 存 account_keks.wrapped_kek
                └─ wrap → 会话 DEK (per-conversation)   ← 存 conversations.wrapped_dek
                              └─ AES-256-GCM → conversation/messages 密文
```
- **主 KEK**:推荐真实 KMS/HSM(AWS KMS / GCP KMS / Vault Transit / PKCS#11 HSM),`Encrypt/Decrypt` 只在 CS decryptor 进程调用。过渡期可用现有 `resolveMasterKey`(scrypt N=16384 → AES-256-GCM 封存文件,`MASTER_MAGIC="CG-E2EE-SCRYPT-AESGCM-v1"`),但**生产建议升级 KMS/HSM**并注明。
- **账号 KEK**:32B 随机;由主 KEK 包裹存 `account_keks`;支持 epoch(撤销/丢失设备时 bump)。
- **会话 DEK**:`generateRootKeyBytes()`(32B);`importRootKey` 后直接喂 `encryptJson/decryptJson`;由当前账号 KEK 用 AES-256-GCM 包裹存 `conversations.wrapped_dek`。

### 7.2 落库封装(复用 `encryptJson`/`decryptJson`)
- 内容加密:`encryptJson(dek, "cs-relay/1:conversation-message", messageAad, {role,text,...})` → `E2eeCiphertext`(A256GCM)。
- DEK 包裹:`sealDek(accountKek, dek)` = AES-256-GCM(随机 nonce);`openDek(accountKek, wrapped)`。
- 只用 CS 侧对称封装,不需 HPKE(全服务端)。

### 7.3 DB schema(新增/改)
```
-- 新增
create table account_keks (
  account_id text not null,
  epoch int not null default 1,
  wrapped_kek jsonb not null,            -- 主KEK包裹的账号KEK密文(+KMS keyId)
  kms_key_id text,                       -- KMS/HSM 主KEK引用
  created_at timestamptz not null default now(),
  primary key(account_id, epoch)
);

-- conversations 改: 新 content_mode
alter table conversations add column if not exists account_id text;
alter table conversations add column if not exists wrapped_dek jsonb;   -- 账号KEK包裹的DEK
alter table conversations add column if not exists kek_epoch int;
-- content_mode 增加 'cs-relay-v1'; 该模式下 plaintext 列须为空(约束同 e2ee-v1)

create table cs_relay_messages (
  id uuid primary key,
  conversation_id uuid not null references conversations(id) on delete cascade,
  account_id text not null,
  sequence bigint not null,              -- 会话内单调递增(顺序/冲突)
  role text not null,                    -- user|assistant
  content_ciphertext jsonb not null,     -- encryptJson(dek, ...) 密文
  content_mode text not null default 'cs-relay-v1',
  idempotency_key uuid,                  -- 幂等/去重
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index cs_relay_msg_seq_uniq on cs_relay_messages(conversation_id, sequence) where deleted_at is null;
create unique index cs_relay_msg_idem_uniq on cs_relay_messages(account_id, idempotency_key) where idempotency_key is not null;
create index cs_relay_msg_sync_idx on cs_relay_messages(account_id, conversation_id, sequence);
```
- **DB/Redis/备份只存**:`wrapped_kek`/`wrapped_dek`/`content_ciphertext` + 最小元数据(`account_id`/`sequence`/时间/大小/模型);**永不存明文**。沿用现有 `content_mode <> ...` 空列约束风格加 `cs-relay-v1`。

---

## 8. 跨设备读取/同步流程 + 同步 API

### 8.1 端到端流程
```
设备A产生消息:
  A → (cg-mitm/1 c2s 密文) → CS
  CS 解密内层 → execute()/Runner(见§9) → 得 assistant 回复(明文,内存内)
  CS: 取账号KEK(openDek via KMS) → 生成/取会话DEK → encryptJson(dek, msg) → 落 cs_relay_messages
                                                        ↑ DB 只见密文
设备B读取(独立设备,独立 cg-mitm session):
  B → enroll(账号绑定) → 建立 session(自己的 sessionRoot)
  B → /cg/v1/sync {list | messages page | since cursor} (c2s 密文)
  CS: 校验 device active + accountId 匹配 → 从 DB 取 content_ciphertext
      → openDek(KMS→accountKek→dek) → decryptJson(dek) 得明文(内存内)
      → sealS2c(B.sessionRoot, 明文) 重新加密 → 下发
  B: 用自己的 session key 解密 → 显示明文
  (明文只存在于 B 当前显示上下文 + CS decryptor 内存;DB/网络全程密文)
```

### 8.2 同步 API(`/cg/v1/sync`,内层密文类型)
```
sync-inner(请求, 走 c2s AEAD):
  { kind:"sync-request",
    op:"conversation-list" | "messages-page" | "delta",
    conversationId?:string,
    sinceSequence?:number,               -- since cursor(增量)
    sinceUpdatedAt?:string,              -- list 增量游标
    limit?:number(<=200), cursor?:string -- 分页(keyset, base64url)
  }
sync-response(响应, 走 s2c AEAD, 每帧密文):
  op="conversation-list":
    { conversations:[{id,title(明文,已解密),updatedAt,lastSequence,archived,deleted}], nextCursor }
  op="messages-page":
    { conversationId, messages:[{sequence,role,content,createdAt}], nextCursor, latestSequence }
  op="delta":
    { changes:[{type:"upsert"|"delete"|"archive", conversationId, sequence, ...}], newCursor }
```
- **conversation list**:keyset 分页(`updated_at desc, id`),`nextCursor` = base64url(游标);标题在 CS 内用 DEK 解密后明文回传(密文信道内)。
- **message pagination**:按 `sequence` keyset,`limit≤200`,`nextCursor`。
- **since cursor**:`sinceSequence`/`sinceUpdatedAt` 只回增量。
- **删除/归档**:`op:"delete"|"archive"` 软删(`deleted_at`/`archived` 标志);增量同步下发 tombstone。删除是账号级、跨设备一致。

### 8.3 增量同步(WebSocket/SSE)
- `GET /cg/v1/sync/stream`:密文 SSE(复用 `beginCgStream`+心跳);CS 在会话有新消息时推 `delta` 密文帧(每帧 `sealS2c`,`frameType` 进 AAD,`sequence` 单调递增防重排)。
- 触发:CS 内 pub/sub(Redis pub/sub,payload 只含 `accountId+conversationId+sequence`,**不含明文**);订阅端按 accountId 过滤。
- 断线重连:客户端带 `sinceSequence`/`cursor` 重连 → CS 补齐缺口(离线补齐)。

### 8.4 幂等/顺序/冲突
- **顺序**:`cs_relay_messages.sequence` 会话内单调递增(`cs_relay_msg_seq_uniq` 唯一);读取按 sequence 排序。
- **幂等**:写入带 `idempotency_key`;`cs_relay_msg_idem_uniq` 唯一索引 → 重投递不重复落库。
- **冲突**:两设备并发向同一会话追加 → CS 以到达顺序分配 `sequence`(服务端单点定序,无需 CRDT);若客户端乐观 `expectedSequence` 不匹配 → 返回 `sequence_conflict` + 最新 `latestSequence`,客户端重取增量后重试。这是"last-writer-appends"语义,适合聊天流。

---

## 9. CS → Runner 链路(CS 重新封装,不留网络明文)

### 9.1 密钥归属变更(与旧 web E2EE 的核心区别)
- **旧 `cg-e2ee/1`**:浏览器生成会话根,`wrapRootKey` 直接封给 **runner 的 HPKE 公钥**;Gateway 全程盲。
- **新模型**:**CS 产生 runner 会话密钥并封给 runner**(不是浏览器封 runner)。CS 解密客户端明文后,把**当前任务所需上下文**(非全部历史)组装为 `E2eeRunnerJob`,`wrapRootKey(taskRoot, runnerEncryptionKey, requestKeyContext(...))` + `encryptJson(taskRoot, "cs-to-runner:run-request", aad, payload)` → 复用 `apps/windows-runner/src/e2eeProcessor.ts` 现有解密逻辑。

### 9.2 上下文最小化(用户要求)
- Runner 不持有全部历史;CS 用类 `truncateHistory`(见 `secureClient.ts`:最近 20 轮、≤48KB)裁剪,仅封当前任务上下文 + memory 子集。
- 每任务独立 `taskRoot`(一次性),用完 zero-fill。

### 9.3 远程 Runner 传输(即使 TLS 被 MITM 仍密文)
- **同机/loopback Runner**:链路不出网卡,无需额外处理(推荐部署形态)。
- **远程 Runner(必做纵深)**:
  - **mTLS**:CS↔Runner 双向 TLS,**客户端证书指纹固定**,以 `runnerIdentityCert`(`issueRunnerIdentityCert`/`verifyRunnerIdentityCert`,Ed25519/ES256 根签发)作 Runner 身份锚。
  - **应用层再加密**:即使 TLS 被 MITM,payload 仍是 `cg-e2ee/1` runner envelope 密文(HPKE + AEAD),MITM 只见密文。
  - **双向签名**:CS 对 job 签名、Runner 对 result/progress 签名(复用 `signValue`/`verifyValue` + `runnerCertTranscript`)。
  - **epoch rotation**:`RUNNER_ID`/epoch 轮换(见 `docs/e2ee.md`、`trust-root-rotation.md`);current/previous 重叠窗口。
- **Hermes(Python)Runner**:claim/result/progress 强制 mTLS + server pin。
- 中间 DB/Redis 队列(`runs` 表 `request_envelope`/`result_envelope`)只存**密文 envelope**(已有 `content_mode='e2ee-v1'` 与索引 `runs_e2ee_target_queue_idx`);新增 `content_mode='cs-relay-v1'` 时队列同样只存密文。

---

## 10. CS 进程隔离与数据落盘

- **decryptor/worker 隔离**:只有专用 decryptor 进程(或独立 worker,最小权限)持有 KMS 解密句柄与 session `sessionRoot`;HTTP 前端进程只搬密文 + 元数据,经受控 IPC(unix socket,只传密文/密钥引用)与 decryptor 交互。KMS 凭据只注入 decryptor。
- **DB 只存密文**:`cs-relay-v1` 下 `prompt`/`response`/明文列强制为空(DB 约束,风格同 `conversations_e2ee_plaintext_empty`)。
- **日志**:`/cg/v1/*` 一律不记 payload/内层明文/apiKey/身份 token;沿用现有 Fastify redact(`req.body`/`authorization`/`cookie`);只记 `sessionId`/`deviceId`/`accountId`(可选 hash)/序列/尺寸桶/耗时/结果码。
- **telemetry**:只上报计数/延迟/尺寸桶;禁止 prompt/response 内容或可反推哈希。
- **core dump 关闭**:容器/服务 `RLIMIT_CORE=0`、`ulimit -c 0`、systemd 加固(`LimitCORE=0`)。
- **短生命周期内存**:明文与派生密钥用完 `fill(0)`(对齐 `unwrapRootKey` 的 `raw.fill(0)`);session TTL,进程重启即失效 → 客户端重握手。
- **队列不含明文**:Redis 只放密文 + jobId/序列/accountId;pub/sub payload 无明文。
- **响应** `Cache-Control: no-store`。

---

## 11. 审计与隔离

- **跨账号严格隔离**:所有查询强制 `where account_id = <session.accountId>`;设备证书 accountId 与目标资源 accountId 必须一致,否则 `403`。DB 层可加 RLS(Postgres Row-Level Security)按 `account_id` 兜底。
- **最小元数据**:审计只记事件类型/accountId/deviceId/时间/结果码(复用 `audit_logs` 表、`deps.backend.audit`,如现有 `cg_enroll`);**不记内容/密钥/token**。
- **管理员不可见明文**:DBA/运维只见 KMS 密文;解密需 decryptor 进程 + KMS 授权,且 KMS 侧对 `Decrypt` 调用独立审计(谁/何时/哪个 account KEK)。
- **导出/恢复/备份**:
  - 备份 = DB 密文备份 + KMS 密钥材料(KMS 侧独立托管/HSM 备份);二者分离存储,单独泄露任一方都不足以解密。
  - 用户导出:经已授权设备的 session,CS 解密后以密文流下发,客户端本地解密导出(明文只在客户端);服务端不产明文导出文件。
  - 恢复:账号 KEK 丢失 = 该账号历史不可恢复(设计上 CS 主 KEK 由 KMS 托管,常规不丢);提供 KMS 多区域/HSM 冗余。

---

## 12. 从现有 web E2EE(`cg-e2ee/1` browser→runner 直达)迁移

**现状**:`apps/web`/`apps/secure-web` 浏览器持会话根,直接封给 runner,经 `/api/e2ee/v1/*` 中继密文;Gateway 全程盲;跨设备读历史需同一设备密钥(达不到"任意授权设备读明文")。

**目标**:`browser → CS secure envelope(/cg/v1) → CS decrypt → cs_relay 历史(DEK) + runner envelope(§9)`。

**迁移策略(兼容/灰度/回滚):**
1. **并存期**:保留 `/api/e2ee/v1/*`(旧 `content_mode='e2ee-v1'`)与新 `/cg/v1/*`(`cs-relay-v1`)。新账号/新会话默认走 `cs-relay-v1`;旧会话继续 `e2ee-v1` 只读可解密(需旧设备密钥)。
2. **开关**:`CG_SECURE_ENABLED`(挂 `/cg/v1/*`)、`CS_RELAY_HISTORY_ENABLED`(启用 `cs_relay_messages` 落库)、`CG_REQUIRE_SECURE`(收敛后关明文 `/v1/*`)。默认全关,灰度逐步开。
3. **灰度**:先内部账号 → 小流量 → 全量;监控 fail-closed 率、解密失败率、同步延迟。
4. **旧数据**:`e2ee-v1` 历史 CS 无法解密(设计如此),不迁移;提供客户端侧"归档旧明文"(复用扩展现有 "Archive & scrub legacy plaintext")或让旧会话自然沉降。**不承诺**擦除 VPS 已见过/WAL/备份中的旧数据。
5. **回滚**:关 `CS_RELAY_HISTORY_ENABLED`/`CG_REQUIRE_SECURE` 即回旧路径;`cs_relay_messages` 独立表,回滚不影响 `e2ee-v1`。
6. **旧 `cg-e2ee/1` 直达路径何时关**:全量切换 + 稳定运行 ≥2 周 + 无回滚需求后,`/api/e2ee/v1/runs` 写入置 `426`,保留只读解密端点一个保留期(如 90 天)供旧设备导出,到期下线。

---

## 13. 验收矩阵

| # | 场景 | 期望 |
|---|---|---|
| **抗 MITM(客户端↔CS)** ||
| A1 | mitmproxy 企业 CA 透明代理抓 exchange/sync | 只见 `cg-mitm/1` 密文;header 无 apiKey/身份 token;`payload.alg=A256GCM` |
| A2 | 篡改任一密文帧/AAD | `c2s_decrypt_failed`/`handshake_unwrap_failed`,run 不执行 |
| A3 | 重放旧 exchange/sync envelope | `c2s_sequence_replayed` / 幂等命中不重复执行 |
| A4 | 伪服务端(自签 HPKE,非根签发) | 客户端 pin/证书验签失败,拒绝、不发数据 |
| A5 | 降级:剥 envelope / 引导明文 `/v1/*` / 改 minSuite | `malformed_envelope` / 握手 AAD 失败;客户端不回退明文 |
| A6 | 替换网页 JS(方案 A/B) | 扩展/Adapter 内置离线根不受被 MITM 的页面影响;纯网页明确标注边界 |
| **多设备历史** ||
| M1 | 同账号 2–3 设备(扩展+Adapter+浏览器)读同一历史 | 全部得到一致明文;顺序按 sequence |
| M2 | 设备 A 发消息 → 设备 B 增量同步 | B 收到 delta 密文帧,解密显示明文,sequence 连续 |
| M3 | 不同账号请求他人会话 | `403 cross_account_denied` |
| M4 | 撤销设备 C 后 C 再同步新内容 | `device_revoked` fail-closed;C 无法取新会话 |
| M5 | 丢失设备 → 账号 KEK epoch bump | 被撤销设备读不到新会话(前向保护) |
| M6 | B 离线一段时间后重连带 sinceSequence | 补齐缺口,无重复无丢失 |
| M7 | A、B 并发追加同一会话 | 服务端定序;`sequence_conflict` 时重取增量后成功 |
| **落盘/隔离** ||
| C1 | grep Postgres/Redis/备份/WAL 找明文 prompt/response/apiKey | 无明文;只有 DEK/内容密文 + 最小元数据 |
| C2 | grep 日志/telemetry;检查 core dump | 无明文;core dump 关闭 |
| C3 | DBA 直连 DB 尝试读会话 | 只见密文;需 decryptor+KMS 才能解 |
| C4 | KMS Decrypt 审计 | 每次账号 KEK 解密有独立审计记录 |
| **CS→Runner** ||
| R1 | CS↔远程 Runner 抓包 | mTLS + 应用层密文;无明文 |
| R2 | Runner 收到的上下文 | 仅当前任务上下文(裁剪),非全部历史 |
| R3 | 伪 Runner / 错 epoch | 证书/pin 校验失败,拒绝 |
| **通用** ||
| B1–B4 | 非流式/流式/同 session 串行/跨 session 并行/429/断连 cancel/幂等 resume | 语义正确,与直连一致 |
| E1 | padding/jitter | 长度落桶、时序抖动(仅记录降低程度,不承诺不可识别) |
| D1–D2 | bootstrap 篡改 / 伪签名公钥(P6) | 验签/指纹不匹配中止安装 |

**自动化**:扩展 `apps/secure-adapter/test/adapter.test.ts` 现有 A1–A6/B1–B4 绿;新增 `M*`/`C*`/`R2` 用内存假 Runner + 假 KMS + 内存 PG 跑;`scripts/csapi/verify-cg-mitm.ts` 扩展多设备与同步用例。

---

## 14. 阶段计划(P0–P6)

| 阶段 | 内容 | 工作日 | 回滚 |
|---|---|---|---|
| **P0 冻结** | 本规格 + schema(`cg-device-cert/2`、`sync-inner`、`cs_relay_messages`、`account_keks`)评审 | 2 | 纯文档 |
| **P1 账号绑定 enroll** | `packages/shared` 加 v2 device cert + accountAuth;CS `handleEnroll` 验 OIDC/Passkey/CF Access → accountId;**持久化 `cg_devices`**(修复内存缺陷);撤销端点 | 4 | 关账号模式回 apiKey enroll |
| **P2 历史存储(DEK/KEK/KMS)** | `account_keks`/`conversations.wrapped_dek`/`cs_relay_messages` 迁移;`sealDek/openDek`;KMS/HSM 集成(过渡期 scrypt 封存);exchange 后落库 | 6 | 关 `CS_RELAY_HISTORY_ENABLED` |
| **P3 同步 API** | `/cg/v1/sync`(list/page/since)、`/cg/v1/sync/stream` 增量;keyset 分页;幂等/顺序/冲突;`isCsapiPath` 放行 | 5 | 端点开关 |
| **P4 CS→Runner 再封装 + 上下文最小化** | CS 产 taskRoot 封 runner(复用 `e2eeProcessor`);裁剪上下文;远程 Runner mTLS + 证书固定 + epoch | 5 | loopback 部署 / mTLS 开关 |
| **P5 进程隔离 + 落盘/日志/padding** | decryptor/worker 隔离 + IPC;DB 空列约束;日志/telemetry/core dump 加固;padding+jitter;Redis 无明文 | 5 | 各项独立开关 |
| **P6 安全 bootstrap + 收敛** | 扩展签名分发/Force-install;Adapter minisign+Sigstore+平台签名+两段式;灰度后开 `CG_REQUIRE_SECURE`;旧 `cg-e2ee/1` 直达路径按保留期下线 | 4 | 保留明文/旧端点、延后 REQUIRE |

**合计约 34 人日。** 推荐先做顺序:**P0 → P1(账号+设备持久化,当前最大缺口)→ P2(历史 DEK/KMS)→ P3(同步)**,即先交付"可信 CS 中继双跳 + 多设备历史"主链路,P4–P6 补远程 Runner 纵深、隔离加固与 bootstrap 收敛。

---

## 15. 安全承诺 / 非承诺(最终)

**承诺:**
- 客户端↔CS、CS↔远程 Runner 全程应用层密文,**即使企业 TLS 被 MITM 亦不可读/篡改(AEAD)/重放(序列+幂等)**。
- 明文仅存在于三类主体:客户端(扩展/Adapter/当前显示历史的授权浏览器)、CS decryptor 进程、Runner/模型。
- Cloudflare/nginx/Postgres/Redis/备份/日志/telemetry/core dump **不得见明文**;管理员/DBA 只见 KMS 密文。
- 同账号多设备可读历史明文;跨账号 403;撤销/丢失设备后旧设备读不到新内容(前向保护)。
- 服务端身份不可冒充(离线 Ed25519 根 + 证书链);长期凭据/身份 token 不进 HTTP header。

**非承诺:**
- 不防终端被 root/EDR/恶意本地进程读取客户端内存或 loopback key(客户端属信任域内)。
- 不防可信 CS app 本身被攻陷(设计前提;CS 可解密)。
- 上游模型见明文(既定前提,非 model-blind 推理)。
- 流量特征**只能降低不能消除**(padding/jitter 减小可分析性,仍可识别"在与 CS 通信")。
- 纯网页 PWA 在"从一开始即被 MITM"的首次安装场景下**不提供**可信 bootstrap 保证——必须用签名扩展(方案 A)或本机 Secure Adapter(方案 B)。
- 撤销无法追溯已在旧设备本地显示过的历史;WAL/旧备份/已见数据需按保留策略单独销毁。
