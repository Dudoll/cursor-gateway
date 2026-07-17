# cg-mitm/1 — csapi 抗 MITM 应用层信道（规格 / P0 冻结）

> 状态：**P3 已落地**（`apps/secure-adapter/` + `/cg/v1/*` 流式 SSE + 集成测试绿）。
> P0 规格见 `docs/cg-mitm-spec/`；P1–P3 代码已进 `packages/*` / `apps/*`。
> 上游已批准的完整方案见「抗 MITM 完整方案」评审结论（agent `623b1aef`）；本目录把该结论
> 细化为**可直接开工的协议规格 + 伪代码**，并与仓库真实 API 对齐。

---

## 0. 一句话

在现有明文兼容通道 `csapi`（见 `docs/csapi.md` §2）之上，叠加一层**与 TLS 解耦的应用层端到端信道**
`cg-mitm/1`：CLI → 本机 `Secure Adapter`（信任域内）→ `/cg/v1/*` 密文端点（可信解密方）→
现有明文管线 `execute()` → Runner/模型。中间人（企业根证书 / mitmproxy 透明代理）即便解开 TLS，
也只能看到绑定到「它无法伪造的服务端静态公钥」的 `cg-mitm/1` 密文。

## 1. 威胁模型与安全承诺

`csapi.joelzt.org` 被视为**可信解密方**。威胁模型只覆盖**网络路径**：被动窃听、企业出口代理、
企业根证书 / 伪证书 TLS 中间人。

**承诺（网络层）**
- prompt / response / API key **全程密文**；中间人无法读取、篡改（改则 AEAD 失败）、重放（序列号 + 幂等键）。
- 服务端**身份不可冒充**：HPKE 封装绑定服务端静态 HPKE 公钥 + Ed25519 离线根签发的服务端证书链；伪 key 直接 fail-closed。
- **长期凭据不进 HTTP header**：API key 与设备身份签名都在 envelope 内层。
- 服务端**磁盘 / DB 不落明文**、日志 / telemetry / core dump 不含明文。

**不承诺**
- 不防终端被 root / EDR / 恶意本地进程读取 Adapter 内存或本地 loopback key（Adapter 属信任域内）。
- csapi 服务端**可信、能看明文**（设计前提，非 E2EE-to-model）。
- **流量特征只能降低、不能消除**：padding + jitter 让长度 / 时序更难分析，但仍可识别「在与 csapi 通信」。
- 不防 Runner / 上游模型侧可见明文（Runner 在信任域内；server→远程 Runner 的网络明文由第 6 节单独处理）。

## 2. 目标架构

```
标准 CLI (Claude Code / OpenCode)
  │  http://127.0.0.1:PORT   (Anthropic/OpenAI 兼容, 本地 loopback key)
  ▼
Secure Adapter (新增 apps/secure-adapter/)                ← 信任域内，明文只在此进程
  │  · 离线固定 Ed25519 根指纹（不 pin Cloudflare TLS 证书）
  │  · 拉取并验证 /cg/v1/server-keys → 得到服务端 HPKE 公钥
  │  · HPKE 握手封装 32B sessionRoot → 派生 c2s / s2c AEAD 会话密钥
  │  · 把 {CLI body + apiKey + sessionKey + idempotencyKey} 封进 envelope
  ▼  https  (TLS + cg-mitm/1 密文；企业 CA MITM 只见密文)
csapi 新端点 /cg/v1/*  (新增 apps/server/src/csapi/secure.ts)  ← 可信解密方
  │  · 验 pin / 握手 / 序列 / 重放 / 幂等 → 内存内解密
  │  · matchApiKey → 复用现有 execute() / handleAnthropic / handleOpenAi
  │  · 回密文响应 / 密文 SSE
  ▼  加密链路（mTLS + 应用层再加密，见 §6）
Local Runner / Hermes / 模型                               ← 信任域内
```

**关键点**：Adapter ↔ csapi 的机密性完全由应用层保证，与 TLS 无关。TLS（Cloudflare 边缘）仍保留，
但即便被 MITM 解到明文层，看到的也只是 `cg-mitm/1` 密文。

## 3. 密码学复用清单（尽量不发明新密码学）

| 能力 | 直接复用 | 出处 |
|---|---|---|
| HPKE seal/open（握手封装 32B 会话根） | `wrapRootKey` / `unwrapRootKey` / `hpkeSeal` / `hpkeOpen` | `packages/e2ee/src/index.ts` |
| 会话内容 AEAD（每帧 AES-256-GCM + HKDF 派生 + canonical AAD） | `encryptJson` / `decryptJson` | `packages/e2ee/src/index.ts` |
| 规范化 JSON / base64url / 指纹 | `canonicalJson` / `encodeBase64Url` / `createKeyDescriptor` | 同上 |
| 在线签名（服务端 key bundle、每会话、设备认证） | ES256 `signValue` / `verifyValue` | 同上 |
| 离线根 + 身份证书 + epoch rotation | `generateTrustRootKeyPair` / `issueRunnerIdentityCert` / `verifyRunnerIdentityCert` | 同上 |
| 证书链下发 / 加载 | `loadServerTrustRoots` | `apps/server/src/trustRoots.ts` |
| 根签发 CLI | 扩展 `scripts/e2ee/trust-root-cli.ts`（新增 `issue-server-cert`） | — |
| 复用明文执行 / 并发 / 鉴权 | `execute` / `SessionSerializer` / `KeyConcurrencyLimiter` / `matchApiKey` | `apps/server/src/csapi/{server,concurrency,protocol}.ts` |

**需新增的密码学面（P1）**
1. **Ed25519 离线根**（用户硬性要求）：给 `e2eeTrustRootPublicSchema` / 证书 schema 增加 `alg` 判别字段
   （`"EdDSA" | "ES256"`），根验签走 Node ≥22 原生 `crypto`（`package.json` engines 已是 `>=22`）。
   在线 / 每会话签名沿用 ES256（WebCrypto 原生、快）。
2. **`cg-mitm/1` envelope schema**：现有 `e2eeHpkeEnvelopeSchema` 的 `ciphertext` 上限只有 64 char（正好
   容纳 32B 根 + 16B tag）——因此**握手仍用 HPKE 只封装 32 字节 sessionRoot**，**请求体走 `encryptJson`
   分帧**（`e2eeCiphertextSchema.ciphertext` 上限 2,000,000 char，配合 Fastify `bodyLimit` 3MB）。两者都复用
   现有 schema，无需放宽 HPKE 限制。

## 4. 端点与开关

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/cg/v1/server-keys` | 返回**签名的服务端密钥公告**：HPKE 公钥 + ES256 服务端签名公钥 + **Ed25519 根签发的服务端证书**（epoch / 有效期 / allowedOrigins）。Adapter 用离线固定的根指纹验证，实现 rotation 而无需重新固定。 |
| POST | `/cg/v1/enroll` | 首次设备注册：Adapter 提交设备公钥（HPKE + 签名）；服务端签发**设备证书**并绑定 `deviceId`。API key 在此请求 envelope 内提交一次授权注册。 |
| POST | `/cg/v1/exchange` | 主通道。请求体 = 一个 `cg-mitm/1` 请求 envelope；非流式返回密文响应 envelope，`stream:true` 返回**密文 SSE**。 |
| POST | `/cg/v1/cancel` | 携带 `sessionId` + `idempotencyKey` 的密文取消。 |
| GET | `/health` | 保留现有明文健康检查（不含敏感信息）。 |

- `isCsapiPath()`（`apps/server/src/csapi/server.ts`）需扩展放行 `/cg/v1/*`，使其继续豁免 Cloudflare Access。
- 环境开关：`CG_SECURE_ENABLED`（挂载 `/cg/v1/*`，默认关）、`CG_REQUIRE_SECURE`（收敛后关闭明文 `/v1/*`）、
  `CG_ALLOW_API_KEY_ENROLL`（生产环境显式允许有效 CSAPI Key 完成首次设备注册，默认关；不放宽设备数据库持久化）。

## 5. 规格拆分文件（本目录）

| 文件 | 内容 | 拟落地位置 |
|---|---|---|
| [`cg-mitm-spec/01-schema.md`](./cg-mitm-spec/01-schema.md) | `cg-mitm/1` Zod schema 草案（server-keys / enroll / exchange / cancel / SSE 帧 / 内层明文 / `alg` 判别） | `packages/shared/src/` |
| [`cg-mitm-spec/02-server-secure.md`](./cg-mitm-spec/02-server-secure.md) | 服务端 `/cg/v1/*` 处理骨架（handshake→派生→验签→解密→`execute()`→回密文） | `apps/server/src/csapi/secure.ts` |
| [`cg-mitm-spec/03-secure-adapter.md`](./cg-mitm-spec/03-secure-adapter.md) | Secure Adapter 骨架（loopback facade / pin / enroll / handshake / SSE 重放 / cancel / resume / fail-closed） | `apps/secure-adapter/` |
| [`cg-mitm-spec/04-handshake-kdf-aad.md`](./cg-mitm-spec/04-handshake-kdf-aad.md) | 握手 / 密钥派生 / AAD 绑定的 **purpose 字符串精确定义** | `packages/e2ee/src/` |
| [`cg-mitm-spec/cgMitm.draft.ts`](./cg-mitm-spec/cgMitm.draft.ts) | 可编译风格的 zod / 类型草案（**故意放在 docs 外部于所有 workspace `src/`，不进 `typecheck`/`build`**；P1 直接搬进 `packages/shared/src/cgMitm.ts`） | 参考实现 |

## 6. server → Runner / 模型链路（不留网络明文）

现状：csapi 明文 run 入 `runs`（`content_mode='plaintext'`），Hermes Runner 明文轮询 claim；
Windows Runner 已是 E2EE 密文中继（`apps/windows-runner/src/e2eeProcessor.ts`）。最小改法：

1. **Runner 与 server 同机 / loopback**：链路不出网卡，无需改动（推荐部署形态）。
2. **远程 Runner（跨网络）——必做**：
   - **mTLS**：server↔Runner 双向 TLS，**客户端证书指纹固定**，复用 `runnerIdentityCert` 作 Runner 身份锚。
   - **应用层再加密（纵深）**：server 把明文 run 用 `encryptJson` + `wrapRootKey` 封给 Runner 的 HPKE 公钥
     （Runner 侧解密逻辑已存在于 `e2eeProcessor.ts`，把 csapi 明文 run 转成 `E2eeRunnerJob` 形态即可复用）。
   - Hermes（Python）Runner：claim/result/progress 强制 mTLS + server pin。
   - 落地建议：P3 先上 mTLS + pin，P4 视需要叠加再加密。

## 7. 落盘 / 日志 / telemetry / core dump

- **DB 只存密文**：为 csapi secure run 增加 `content_mode='ciphertext-mitm'`；`prompt`/`response` 落库前用
  at-rest key 加密或直接存 s2c 密文；明文只在处理内存内存在，用完 `zero-fill`（对齐 `unwrapRootKey` 的 `raw.fill(0)`）。
- **日志**：现有 Fastify logger 已 redact `req.body`/`authorization`/`cookie`（`apps/server/src/index.ts`）。补充：
  `/cg/v1/*` 一律不记录 payload / 内层明文 / apiKey；只记 `sessionId`/`deviceId`/序列/大小/耗时/结果码。
- **telemetry**：只上报计数 / 延迟 / 尺寸桶，禁止 prompt/response 内容或可反推的哈希。
- **core dump**：容器 / 服务设 `RLIMIT_CORE=0`、`ulimit -c 0`、systemd 加固。

## 8. 安全 bootstrap（curl|sh 会被 MITM）

现状 `scripts/csapi/install-csapi.sh` 是 `curl -fsSL … | sh`，首包可被企业 CA 篡改。多层方案：
1. **签名发布物**：release 用 **minisign（Ed25519）** + **Sigstore cosign**（npm provenance / GitHub OIDC）；
   macOS Notarization、Windows Authenticode。
2. **离线固定发布公钥指纹**：内嵌在 README / 文档多渠道 / 首屏打印，供 out-of-band 核对。
3. **两段式安装**：极小验证器只负责「下载 + 验签」完整安装器，验签失败即中止；安装器再离线固定 Ed25519 根指纹。
4. **优先包管理器**：Homebrew tap / npm(provenance) / winget。
5. **失败即停**：任何签名 / 指纹校验失败 → 不写任何配置、不安装、明确报错。

## 9. 迁移与 fail-closed

- **阶段共存**：保留明文 `/v1/*` 与新 `/cg/v1/*` 并行；Adapter 用户走安全通道，存量用户不中断。
- **Adapter fail-closed 矩阵**：服务端证书验签失败 / 根指纹不匹配 / epoch 回退 / 握手失败 / 序列异常 /
  降级检测 → **对 CLI 返回本地错误，绝不回退明文直连 csapi**。
- **回退明文的唯一路径**是用户显式卸载 Adapter 并手动改 base URL（有明确告警）。
- 收敛后 `CG_REQUIRE_SECURE=true` 关闭明文 `/v1/*`（返回 `426 Upgrade Required`）。

## 10. 验收矩阵（摘要，完整见评审结论 §十）

| # | 场景 | 期望 |
|---|---|---|
| A1 | mitmproxy 企业 CA 透明代理 Adapter↔csapi | 抓包只见 `cg-mitm/1` 密文；无明文；请求成功 |
| A2 | 篡改任一密文帧 / AAD 头 | AEAD 解密失败 → fail-closed，run 不执行 |
| A3 | 重放旧 `/cg/v1/exchange` | 序列 ≤ lastSeen 或幂等命中 → 拒绝重复执行 |
| A4 | 伪服务端（自签 HPKE key，非根签发） | pin / 证书验签失败 → Adapter 拒绝、不发数据 |
| A5 | 降级：改 `minSuite` / 剥 envelope / 引导明文 `/v1/*` | 握手 AAD 校验失败 / Adapter 拒绝明文路径 |
| A6 | header 泄露检查 | 请求 header 无 apiKey、无长期 key，仅 sessionId/deviceId |
| B1–B7 | 非流式 / 流式 / 同 session 串行 / 跨 session 并行 / 429 / 断连取消 / idempotency 续跑 | 与直连一致，语义正确 |
| C1–C3 | server↔远程 Runner 抓包 / DB 落库 / 日志审计 | 密文；无明文 prompt/response/apiKey；core dump 关闭 |
| D1–D2 | bootstrap 篡改 / 伪 minisign 公钥 | 验签 / 指纹不匹配中止安装 |
| E1 | padding / jitter | 长度落桶、时序抖动（仅记录降低程度，不承诺不可识别） |

### P3 自动化验收（`apps/secure-adapter/test/adapter.test.ts`，2026-07-16）

| # | 场景 | 结果 |
|---|---|---|
| A1 | 抓取上行 exchange 请求 header + body | header 无 apiKey/长期 key；body `payload.alg=A256GCM` 密文，无明文 prompt/apiKey |
| A2 | 篡改 exchange ciphertext | `c2s_decrypt_failed` |
| A3 | 重放同一 exchange envelope | `c2s_sequence_replayed` |
| A4 | 伪造 server-keys（攻击者根冒充受害者指纹） | `FailClosedError` 启动拒绝 |
| A5 | 未 pin 的根指纹 | `root_fingerprint_not_pinned` |
| A6 | 上行 header 泄露检查 | 无 `x-api-key`/`authorization`；仅密文 envelope |
| B1 | Anthropic 非流式 exchange | 标准 `message` 形状 |
| B2 | OpenAI 非流式 exchange | 标准 `chat.completion` 形状 |
| B3 | 流式 ciphertext SSE → 标准 Anthropic SSE 重放 | `open`→`delta*`→`usage`→`done` |
| B4 | loopback facade 端到端（含 401 本地 key） | HTTP 200 + SSE 帧正确 |
| — | 错误 API key enroll | `enroll_unauthorized` |

一次性可跑验收（用真实文件加载器 `loadCgSecureConfig` + 内存假 Runner，无需 DB/模型）：

```
scripts/csapi/dev-cg-mitm-setup.sh http://127.0.0.1:18080   # 生成 dev 信任材料（一次）
tsx scripts/csapi/verify-cg-mitm.ts                          # E1/A1/A4/A6/B/401 全 PASS
```

本地/VPS 真实端到端：`dev-cg-mitm-setup.sh` 生成材料 → 按其打印的 `CG_*` 增量加入 server 环境并重启（**不开
`CG_REQUIRE_SECURE`**，保留明文 `/v1/*` 对照）→ `scripts/csapi/run-secure-adapter.sh` 启 Adapter →
CLI 设 `ANTHROPIC_BASE_URL=http://127.0.0.1:8788` + loopback key 打一轮真实 Hermes/auto run。

### 懒人安装（Secure Adapter 一键脚本）

客户端不想手动导出一堆 `CG_ADAPTER_*`？用 `scripts/csapi/install-csapi-secure.sh`（Windows：
`install-csapi-secure.ps1`）**真·一键**：**离线固定根指纹 → 探测并核对 `/cg/v1/server-keys` →
（缺仓库自动 `git clone` + 缺依赖自动 `npm install`）→ 写本机 0600 配置 + 启动器 → 幂等把 CLI 的
`ANTHROPIC_*/OPENAI_*` 指向本机 Adapter → `--start` 拉起 / `--service` 注册开机自启**。真实 key 只留本机与
密文 envelope，永不进 git / HTTP header。四处拷贝即用，典型：

```
CSAPI_API_KEY=sk-xxxx sh scripts/csapi/install-csapi-secure.sh --start --yes    # 一键装好并启动
CSAPI_API_KEY=sk-xxxx sh scripts/csapi/install-csapi-secure.sh --service --yes  # 顺带开机自启 (systemd --user)
```

- 服务端**未开** `CG_SECURE_ENABLED`（`/cg/v1/server-keys` 为 404/426）→ 脚本**友好报错**并打印运维前置，不写坏配置。
- 服务端下发的根指纹与固定指纹**不一致** → 疑似 MITM，拒绝写任何配置（fail-closed）。
- 内置固定指纹与 `scripts/csapi/trust/csapi-trust-root-public.json`（**仅公钥**）一致，可多渠道 out-of-band 核对：
  `sha256:E9OuniLwYNCVLPPwbG_aMimeFG3Ly1OFnhDplyQwy9g`。
- 与明文 `install-csapi.sh` 写不同受管块；安全块在 rc 靠后、覆盖明文块（后写生效）。用法/分发/对比见
  `scripts/csapi/README.md`。这是第 8 节「安全 bootstrap」在 P5 前的**过渡实现**：指纹离线固定 + fail-closed，
  尚未叠加 minisign/Sigstore 两段式验签。

## 11. 实施阶段（P0–P5）

| 阶段 | 内容 | 工作日 | 回滚 |
|---|---|---|---|
| **P0 冻结** | 威胁模型 + `cg-mitm/1` 规格 + schema 评审（**本目录**） | 2 | 无（纯文档） |
| **P1 密码学面** | `packages/shared` 加 `cg-mitm/1` schema + `alg` 判别；`packages/e2ee` 加 Ed25519 根验签 + 新 purpose 派生；扩展 `trust-root-cli` 签发服务端证书 | 4 | 纯新增导出，删除即回滚 |
| **P2 服务端 `/cg/v1/*`** | 新 `apps/server/src/csapi/secure.ts`；接入 `execute()`；`isCsapiPath` 放行；`CG_SECURE_ENABLED` 默认关 | 5 | 关 `CG_SECURE_ENABLED` |
| **P3 Adapter + Runner mTLS** | 新 `apps/secure-adapter`（**已落地**）；远程 Runner mTLS + 证书固定（**待 P3 后半**） | 6 | 卸载 Adapter 回明文；mTLS 开关 |
| **P4 落盘 / 日志 / 再加密 / padding** | DB 密文 + at-rest key；日志 / telemetry / core dump 加固；Runner 再加密；padding+jitter | 4 | 各项独立开关 |
| **P5 安全 bootstrap + 收敛** | minisign/Sigstore/平台签名 + 两段式安装器；灰度后开 `CG_REQUIRE_SECURE` | 4 | 保留明文端点、延后 REQUIRE |

合计约 **25 个工作日**。P0–P3 交付即实现「网络层抗 MITM 主链路」。

## 12. 关键仓库落点索引

- 密码学复用：`packages/e2ee/src/index.ts`
- 类型 / schema：`packages/shared/src/index.ts`（P1 新增 `cg-mitm/1` envelope、`alg` 判别）
- csapi 门面：`apps/server/src/csapi/{server,protocol,concurrency,backend}.ts`
- 挂载与放行：`apps/server/src/index.ts`（`isCsapiPath`、日志 redact）、`apps/server/src/config.ts`（`CG_*` 开关）
- 根 / 证书：`apps/server/src/trustRoots.ts`、`scripts/e2ee/trust-root-cli.ts`、`docs/trust-root-rotation.md`
- server→Runner 密文参照：`apps/windows-runner/src/e2eeProcessor.ts`；Hermes：`apps/hermes-runner/hermes_cursor_runner.py`
- 新增：`apps/secure-adapter/`、`apps/server/src/csapi/secure.ts`
