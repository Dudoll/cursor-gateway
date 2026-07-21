# csapi — 兼容 API 门面（方案 B / 兼容优先）

`csapi.joelzt.org` 对外提供 **Anthropic Messages** 与 **OpenAI Chat Completions** 兼容的
HTTP 门面，目的是让标准 CLI（OpenCode / Claude Code 等）只需要「API key + base URL」
即可把请求路由到本网关背后的 Cursor Runner。

本文件是 **P0 书面冻结**：先把安全边界、可见性和范围说清楚，避免任何虚假宣传。

---

## 1. 范围冻结（本阶段权威口径）

- **方案 B（兼容优先）。** 在 `csapi.joelzt.org` 暴露标准兼容端点，安全模型是
  **TLS + API key + 最小日志**。**不是** Gateway-blind 端到端加密（E2EE）。
- **方案 A（本机 Secure Adapter + `cg-mitm/1`）已落地**：客户端一键脚本见 §8.1（**推荐**），
  抗中间人、明文不出本机。代码与文档在边界上保持清晰，不得把方案 B 表述为 E2EE。
- 现有 E2EE 通道（`cs.joelzt.org` Web + 签名扩展 + `/api/e2ee/v1`）不受影响，也不复用
  它的密文保证来给 csapi 背书。

## 2. 安全 / 可见性澄清（必须如实告知用户）

当标准 CLI **只填公网 URL + API key** 时：

- **csapi / Gateway 可见明文。** 请求体、system prompt、对话内容在 csapi 进程与网关侧
  是明文，可被日志、抓包、数据库层面看到（我们做最小化日志，但技术上可见）。
- **Runner / 模型可见明文。** 明文经队列下发到 Local Runner，再交给 Cursor SDK / 模型，
  这一路也都是明文。
- **这不是 E2EE。** 抓包和服务器日志侧「看得到明文」是方案 B 的预期行为，不得写成
  「端到端加密 / Gateway-blind」。
- 想要 Gateway-blind 明文不出本机，走**方案 A**（本机 Secure Adapter，见 §8.1，已可用）。

**OpenCode / Claude Code 的文件读写发生在 CLI 本机**，而不是远程 Runner 工作区：CLI 在
你自己的电脑上读写你的项目文件，只是把「模型补全」这一步通过 csapi 转给远程 Runner/模型。
远程 Runner 的工作区文件系统与 CLI 本机文件系统是两套东西，不要混淆。

## 3. 组件与数据流

```
OpenCode / Claude Code CLI (本机文件读写)
        │  https  (TLS + API key)
        ▼
csapi 门面  (apps/server, /v1/*)         ← 明文可见（方案 B）
        │  明文 run 入队 (PostgreSQL, content_mode=plaintext)
        ▼
Local Runner (wsl-e2ee / local-runner)  ← 明文可见
        │  Cursor SDK local runtime
        ▼
Cursor 模型 / 上游                         ← 明文可见
```

- csapi 复用现有 `apps/server` 的明文队列（`runs` 表，`content_mode='plaintext'`）、
  Runner 领取回路（`/api/runner/jobs/*`）和模型注册表（心跳）。
- 鉴权与 Cloudflare Access 的人机登录**完全分离**：csapi 用自己的 API key，不读取也不依赖
  `cf-access-*` 头。

## 4. 端点

Base URL: `https://csapi.joelzt.org`

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/v1/messages` | Anthropic Messages（支持 `stream: true` SSE） |
| POST | `/v1/chat/completions` | OpenAI Chat Completions（支持 `stream: true` SSE） |
| GET  | `/v1/models` | OpenAI 风格模型列表（含 `auto` 与 Runner 注册的模型） |
| GET  | `/health` | csapi 健康 + 在线 Runner / 模型数（无需鉴权） |

鉴权：`Authorization: Bearer <CSAPI_KEY>` 或 `x-api-key: <CSAPI_KEY>`。

### 4.1 会话（session）映射

- 会话标识解析顺序：请求头 `x-session-id` → body `session_id` → body `conversation_id`
  →（Anthropic）`metadata.user_id`。
- **提供会话标识**：持久映射到同一个网关 conversation，实现「同会话串行 + 上下文由网关侧维护」。
  首次请求发送有界的初始 transcript；后续只发送**最新一条 user 消息**作为增量。Gateway
  进程重启后仍从 PostgreSQL 恢复映射。
- **不提供会话标识**：每次请求都是**无状态**，新建 conversation，并把整段 messages（含 system）
  渲染进有长度上限的单条 prompt。
- 客户端可发送 `Idempotency-Key` / `x-idempotency-key`。同一 key 的重试复用既有 run，
  不会重复占用 Runner 或重复计费。

### 4.2 并发语义

- **跨会话并行**：不同 session → 不同 conversation → 天然并行。
- **同会话串行**：同一 session 的请求在 csapi 层用 keyed-mutex 串行，前一次 run 结束前不入队下一条。
- **调用方等待与任务生命周期分离**：调用方等待默认 300 秒；等待到期返回 `504`，但**不会取消仍健康的
  run**。带相同 `Idempotency-Key` 的重试会重新附着同一 active/terminal run，数据库仍只有一条。
- **生命周期超时**：首次或中断恢复后的当前排队周期默认 30 秒；`running` 后 120 秒没有 lease/progress 才判 idle；
  首次启动后约 29 分钟达到绝对上限。持续 lease/progress 的任务可跨过 300 秒等待边界继续执行。
- **取消 / Abort**：明确的客户端断开仍会取消 active run；lease fencing 会让 Runner 中止对应
  SDK run、释放 agent/session/worker。生命周期取消原因持久化为 `queue_timeout`、
  `idle_timeout` 或 `absolute_timeout`。
- **背压**：每个 API key 有并发上限（`CSAPI_MAX_CONCURRENCY_PER_KEY`）；超限返回
  `429` + `Retry-After`。API key 限流与单 Runner 的 PostgreSQL claim 容量默认都为 6；
  claim 使用 runner 级事务锁，避免并发领取穿透上限。

> 注意：本阶段 SSE 为「协议心跳 + 完成后分块下发」，而不是模型 token 级实时流。
> OpenAI/Anthropic 心跳是协议合法的 no-op/ping 帧，可被 SDK 观察到，避免只有 SSE 注释时被
> 客户端误判为 stale；最终文本仍在 run 完成后聚合下发。

## 5. 配置（.env，增量追加 `CSAPI_*`，绝不提交 git）

| 变量 | 默认 | 说明 |
|------|------|------|
| `CSAPI_ENABLED` | `false` | 是否挂载 csapi 路由（配置了 key 时建议 `true`） |
| `CSAPI_API_KEYS` | 空 | 逗号分隔的合法 API key 列表（发行/校验用） |
| `CSAPI_DEFAULT_MODEL` | `auto` | 请求模型未知时回退的模型。注意：`auto` 由 Local Runner 领取；若线上只有 Hermes，会自动改写为第一个 `hermes:*`，也可直接设为 `hermes:default` |
| `CSAPI_DEFAULT_WORKSPACE_ID` | 空 | 默认 workspace；留空则自动取第一个可用 workspace |
| `CSAPI_MAX_CONCURRENCY_PER_KEY` | `6` | 每 key 并发上限；超限 429 |
| `CSAPI_CALLER_WAIT_TIMEOUT_MS` | `300000` | 调用方等待预算；到期不取消健康 run；旧 `CSAPI_RUN_TIMEOUT_MS` 仅作兼容别名 |
| `CSAPI_QUEUE_TIMEOUT_MS` | `30000` | run 当前排队周期（含中断后重排）的上限 |
| `CSAPI_IDLE_TIMEOUT_MS` | `120000` | `running` run 距最后 lease/progress 的无活动上限 |
| `CSAPI_ABSOLUTE_TIMEOUT_MS` | `1740000` | 从首次 `startedAt` 起约 29 分钟的绝对执行上限 |
| `RUNNER_MAX_CONCURRENT_JOBS` | `6` | 整个部署链路的 DB claim 上限；跨 runner identity 且与 E2EE 共用预算 |
| `CSAPI_MAX_PROMPT_CHARS` | `96000` | 首次/无状态 prompt 的字符上限；保留 system 与最近消息 |
| `CSAPI_ALLOW_WRITES` | `false` | 是否允许写文件（默认只读，安全） |

密钥生成建议：`openssl rand -hex 32`。**只写入 `.env`（`0600`），不进 git。**

Runner 侧对应设置 `RUNNER_MAX_CONCURRENT_JOBS=6`。数据库持久化 `queued_at`、
`started_at`、`last_activity_at`、`cancel_reason`；lease 只刷新 `last_activity_at`，不会借用
无关的 `updated_at` 来伪造活动。流式终态错误包含 `applicationStatusCode`、`cancelReason`、
`provider`、`model`，结构化日志同样只记录这些关联元数据，不记录 prompt、token 或 auth。

要让端到端有效并发实际达到 6，本地 WSL Runner 必须是一个包含 6 个 worker
的共享池。服务端 claim 使用部署级 advisory lock，并把所有 runner identity
及 E2EE 的 active run 一并计数，避免双 identity 形成 6+6。Runner heartbeat
必须报告与服务端一致的容量；`/health` 只公开聚合后的 identity 数、总槽数和
有效容量，不公开 runner ID。Hermes profile 若配置了更低的
`gateway.max_concurrent_sessions`，它仍会成为更早的背压点，
应在内存预算允许时调到 6。服务端的两个上限只是硬上限，不会凭空增加外部 worker/session。

## 6. 安全只读验收接口

Gateway 提供：

```text
GET /validation/v1/runs/by-idempotency/{idempotencyKey}
GET /validation/v1/runs/{runId}
```

两者复用 CSAPI API-key 鉴权并按创建 run 的 key scope 隔离。按幂等键查询时，
服务端先使用已认证 key 的非秘密 ID 做 SHA-256 namespace；按 run ID 查询还
要求持久化的 `csapi_key_id` 精确匹配。跨 key 只能得到空结果或 404。

响应设置 `Cache-Control: no-store`，且只返回 `runId`、status、queued/started/
finished/last-activity 时间、terminal、cancel reason、claim attempts 和
provider/model/application status。不会返回 workspace、prompt、response、
progress 文本、token、Authorization 或消息内容。

## 7. 已知取舍 / 非目标（本阶段）

- 非 E2EE：明文对网关/Runner/模型可见（见 §2）。
- SSE 含协议心跳，但最终文本仍为完成后分块，不是 token 级实时（见 §4.2）。
- 工具调用 / function calling / 图片输入未做完整映射（文本为主；图片以占位符处理）。
- 方案 A（本机 Secure Adapter，cg-mitm/1）**已实现**，客户端一键脚本见 §8.1。

## 8. CLI 配置示例

Claude Code / Anthropic 兼容：

```bash
export ANTHROPIC_BASE_URL="https://csapi.joelzt.org"
export ANTHROPIC_API_KEY="<CSAPI_KEY>"
```

OpenCode / OpenAI 兼容：

```bash
export OPENAI_BASE_URL="https://csapi.joelzt.org/v1"
export OPENAI_API_KEY="<CSAPI_KEY>"
```

curl 冒烟：

```bash
# Anthropic Messages（非流式）
curl -sS https://csapi.joelzt.org/v1/messages \
  -H "x-api-key: $CSAPI_KEY" -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"auto","max_tokens":256,"messages":[{"role":"user","content":"ping"}]}'

# OpenAI Chat Completions（流式）
curl -sS https://csapi.joelzt.org/v1/chat/completions \
  -H "authorization: Bearer $CSAPI_KEY" -H "content-type: application/json" \
  -d '{"model":"auto","stream":true,"messages":[{"role":"user","content":"ping"}]}'
```

## 8.1 抗 MITM 懒人安装（Secure Adapter，方案 A，推荐）

**一键（复制即用）**：自动探测根指纹 → clone → npm install → 写配置 → 启动 Adapter → curl `/health` 验证。

```bash
curl -fsSL https://raw.githubusercontent.com/Dudoll/cursor-gateway/main/scripts/csapi/install-csapi-secure.sh \
  | CSAPI_API_KEY=sk-xxxx sh -s -- --yes
```

想要**明文不出本机、抗中间人**（企业根证书 / mitmproxy 也读不到 prompt）？用
`scripts/csapi/install-csapi-secure.sh`（Windows：`install-csapi-secure.ps1`）一键配好本机
`Secure Adapter`（cg-mitm/1）。它在本机暴露 loopback 门面，把每次调用重新封装成**密文**发往
`/cg/v1/*`；真实 key 只留在本机 `~/.cursor-gateway/secure-adapter.env`（0600）与密文 envelope 内，
**永不进 git、永不进 HTTP header**。

```bash
# 交互式（提示输入真实 key；探测 /cg/v1/server-keys 并核对固定根指纹；
#          没有仓库会提示自动 clone，缺依赖会自动 npm install，默认即启动并验证）
sh scripts/csapi/install-csapi-secure.sh
# 非交互 + 自动确认 clone（真·一键，默认启动并 /health 验证）
CSAPI_API_KEY=sk-xxxx sh scripts/csapi/install-csapi-secure.sh --yes
# 注册 systemd --user 开机自启（Linux）
CSAPI_API_KEY=sk-xxxx sh scripts/csapi/install-csapi-secure.sh --service --yes
# 只准备仓库（clone + npm install，可加 --build 编译 dist），不写配置
sh scripts/csapi/install-csapi-secure.sh --setup
# 只打印 / 卸载 / 查看状态 / 停止 / 跳过探测 / 不自动 clone / 不装依赖
sh scripts/csapi/install-csapi-secure.sh --print
sh scripts/csapi/install-csapi-secure.sh --uninstall
sh scripts/csapi/install-csapi-secure.sh --status
sh scripts/csapi/install-csapi-secure.sh --stop
sh scripts/csapi/install-csapi-secure.sh --no-probe
sh scripts/csapi/install-csapi-secure.sh --no-clone --no-install
```

Windows：`powershell -ExecutionPolicy Bypass -File .\install-csapi-secure.ps1`
（`-Service / -Setup / -Print / -Uninstall / -Status / -Stop / -NoProbe / -NoClone / -NoInstall / -Build / -Yes`）。

- **信任锚**：脚本离线固定（pin）Ed25519 根指纹（内置常量 + `scripts/csapi/trust/csapi-trust-root-public.json`，
  **仅公钥**）。服务端下发的身份证书必须由该根签发，否则 **fail-closed，绝不回退明文**。
- **fail-closed 探测**：探到 `/cg/v1/server-keys` 为 `404/426` → 说明服务端尚未开启安全通道，脚本**友好报错**
  并打印运维前置（见下）；探到根指纹不匹配 → 疑似 MITM，拒绝写任何配置。
- **与 §8.2 明文安装器的关系**：两者写**不同的**受管块；本脚本的块在 rc 中靠后，会覆盖明文安装器的
  `ANTHROPIC_*/OPENAI_*`（后写生效）。二选一即可：要抗 MITM 用本脚本，要最省事的明文兼容用 §8.2。
- **真·一键收尾**：启动 Adapter 需仓库源码（`apps/secure-adapter`，node≥22）。脚本会**自动**：找不到仓库时
  `git clone` 公开仓库到 `~/.cursor-gateway/cursor-gateway`（`--no-clone` 关闭、`--yes` 免确认）、缺依赖时
  在仓库根 `npm install`（`--no-install` 关闭），然后**自动启动并 curl `/health` 验证**；失败则有限次自愈
  （重启 Adapter、重装依赖、编译 dist、清端口、修正 BASE_URL/rc）。成功打印「已验证通过」+ health 摘要。
- **自启**：`--service`（Linux）注册 `systemd --user` 单元开机自启；无 systemd 时回退 nohup 后台。
  Windows `-Service` 注册登录计划任务。

### 生产运维前置（必须先开）

`install-csapi-secure.sh` 生效的前提是 csapi 服务端已开启 cg-mitm 安全通道。运维需（离线机器签根、
在线机器只放公钥/证书）：

```bash
# 1) 生成 dev/离线信任材料 + root 签发的服务端证书（allowedOrigins 含生产域名）
scripts/csapi/dev-cg-mitm-setup.sh https://csapi.joelzt.org
# 2) 把打印的 CG_* 增量写入 csapi 的 .env 并重启，务必：
#    CG_SECURE_ENABLED=true
#    CG_SERVER_CERT_FILE / CG_SERVER_HPKE_KEY_FILE / CG_SERVER_SIGNING_KEY_FILE / CG_TRUST_ROOTS_FILE
#    保持 CG_REQUIRE_SECURE=false（让明文 /v1/* 与安全 /cg/v1/* 并行灰度）
```

未开启前，`/cg/v1/server-keys` 为 404，安装器只会**报错并说明前置**，不写坏配置。协议与威胁模型详见
`docs/cg-mitm.md`。

## 8.2 明文兼容懒人安装（install-csapi.sh，方案 B）

> ⚠️ 这是 **plaintext 兼容通道（TLS + API key），非 E2EE**：prompt/response 在门面 / 网关 / Runner /
> 模型侧明文可见。只在信任链路或快速试用时用；要抗中间人请用上面 §8.1 的方案 A。

不想手动 export、也不需要抗 MITM？用 `scripts/csapi/install-csapi.sh`（POSIX，单文件可分发）一键配好
Claude Code / OpenCode 的环境变量（直连门面），并自动探测连通性：

```bash
# 交互式（提示输入 key，输入不回显）
sh scripts/csapi/install-csapi.sh
# 或非交互（环境变量传 key）
CSAPI_API_KEY=sk-xxxx sh scripts/csapi/install-csapi.sh
```

- 幂等：用标记注释块写入 `~/.bashrc` / `~/.zshrc`，重复运行只更新不堆叠。
- Windows 用 `scripts/csapi/install-csapi.ps1`（用户级环境变量）。
- 仓库公开时也可 `curl -fsSL <raw-url>/scripts/csapi/install-csapi.sh | sh`。
- 零依赖单文件，脚本不含任何真实 key。

用法与分发方式、方案 A vs 方案 B 对比详见 `scripts/csapi/README.md`。

## 9. 验收 checklist

> 实测结果在交付汇报里逐项勾选；日志/抓包侧会看到明文（符合方案 B，不得写 E2EE）。

- [ ] 鉴权失败（缺 key / 错误 key）→ `401`
- [ ] `GET /health` 返回 csapi 状态与在线 Runner/模型数
- [ ] `GET /v1/models` 返回 `auto` + 已注册模型
- [ ] Anthropic `POST /v1/messages` 非流式返回标准结构
- [ ] Anthropic `POST /v1/messages` `stream:true` 返回合法 SSE 事件序列
- [ ] OpenAI `POST /v1/chat/completions` 非流式返回标准结构
- [ ] OpenAI `POST /v1/chat/completions` `stream:true` 返回合法 SSE + `[DONE]`
- [ ] 会话隔离：不同 session 互不串扰
- [ ] 同会话串行：同 session 的两个请求不重叠
- [ ] 跨会话并行：不同 session 的请求可并行
- [ ] 取消：客户端断开时 `queued` run 被取消
- [ ] 等待超时：健康 run 不取消；同幂等 key 重试附着同一 run
- [ ] 生命周期：30s queue、120s idle、29m absolute；持续活动可跨 300s
- [ ] 背压：超过每 key 并发上限返回 `429 + Retry-After`
- [ ] 单元 + 集成测试全绿（`npm run test -w @cursor-gateway/server`）
