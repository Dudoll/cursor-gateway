# csapi — 兼容 API 门面（方案 B / 兼容优先）

`csapi.joelzt.org` 对外提供 **Anthropic Messages** 与 **OpenAI Chat Completions** 兼容的
HTTP 门面，目的是让标准 CLI（OpenCode / Claude Code 等）只需要「API key + base URL」
即可把请求路由到本网关背后的 Cursor Runner。

本文件是 **P0 书面冻结**：先把安全边界、可见性和范围说清楚，避免任何虚假宣传。

---

## 1. 范围冻结（本阶段权威口径）

- **主推方案 B（兼容优先）。** 在 `csapi.joelzt.org` 暴露标准兼容端点，安全模型是
  **TLS + API key + 最小日志**。**不是** Gateway-blind 端到端加密（E2EE）。
- **方案 A（localhost sidecar + `cg-e2ee/1`）为后续可选项**，本阶段不实现。代码与文档
  在边界上保持清晰，不得把方案 B 表述为 E2EE。
- 现有 E2EE 通道（`cs.joelzt.org` Web + 签名扩展 + `/api/e2ee/v1`）不受影响，也不复用
  它的密文保证来给 csapi 背书。

## 2. 安全 / 可见性澄清（必须如实告知用户）

当标准 CLI **只填公网 URL + API key** 时：

- **csapi / Gateway 可见明文。** 请求体、system prompt、对话内容在 csapi 进程与网关侧
  是明文，可被日志、抓包、数据库层面看到（我们做最小化日志，但技术上可见）。
- **Runner / 模型可见明文。** 明文经队列下发到 Windows Runner，再交给 Cursor SDK / 模型，
  这一路也都是明文。
- **这不是 E2EE。** 抓包和服务器日志侧「看得到明文」是方案 B 的预期行为，不得写成
  「端到端加密 / Gateway-blind」。
- 想要 Gateway-blind 明文不出本机，必须走**方案 A**（localhost sidecar，后续实现）。

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
Windows Runner (wsl-e2ee / windows-main)  ← 明文可见
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
- **提供会话标识**：映射到同一个网关 conversation，实现「同会话串行 + 上下文由网关侧维护」。
  同一会话内只发送**最新一条 user 消息**作为增量（网关按 conversation 维护历史与 agent 续接）。
- **不提供会话标识**：每次请求都是**无状态**，新建 conversation，并把整段 messages（含 system）
  渲染进单条 prompt 以保留上下文。

### 4.2 并发语义

- **跨会话并行**：不同 session → 不同 conversation → 天然并行。
- **同会话串行**：同一 session 的请求在 csapi 层用 keyed-mutex 串行，前一次 run 结束前不入队下一条。
- **取消 / Abort**：客户端断开连接时，csapi 取消仍在 `queued/waiting_approval` 的 run（best-effort）；
  已被 Runner 领取（`running`）的 run 无法被抢占，csapi 会停止等待并释放槽位（如实记录此限制）。
- **背压**：每个 API key 有并发上限（`CSAPI_MAX_CONCURRENCY_PER_KEY`）；超限返回
  `429` + `Retry-After`。

> 注意：本阶段 SSE 为「完成后分块下发」（run 结束后把整段文本切片成多个 delta 帧），
> 而不是模型 token 级实时流。CLI 侧能正确解析 SSE；这是方案 B 的已知取舍，见 §6。

## 5. 配置（.env，增量追加 `CSAPI_*`，绝不提交 git）

| 变量 | 默认 | 说明 |
|------|------|------|
| `CSAPI_ENABLED` | `false` | 是否挂载 csapi 路由（配置了 key 时建议 `true`） |
| `CSAPI_API_KEYS` | 空 | 逗号分隔的合法 API key 列表（发行/校验用） |
| `CSAPI_DEFAULT_MODEL` | `auto` | 请求模型未知时回退的模型。注意：`auto` 由 Windows Runner 领取；若线上只有 Hermes，会自动改写为第一个 `hermes:*`，也可直接设为 `hermes:default` |
| `CSAPI_DEFAULT_WORKSPACE_ID` | 空 | 默认 workspace；留空则自动取第一个可用 workspace |
| `CSAPI_MAX_CONCURRENCY_PER_KEY` | `4` | 每 key 并发上限；超限 429 |
| `CSAPI_RUN_TIMEOUT_MS` | `300000` | 单次 run 等待超时（毫秒） |
| `CSAPI_ALLOW_WRITES` | `false` | 是否允许写文件（默认只读，安全） |

密钥生成建议：`openssl rand -hex 32`。**只写入 `.env`（`0600`），不进 git。**

## 6. 已知取舍 / 非目标（本阶段）

- 非 E2EE：明文对网关/Runner/模型可见（见 §2）。
- SSE 为完成后分块，不是 token 级实时（见 §4.2）。
- 已 `running` 的 run 不可被真正抢占取消。
- 工具调用 / function calling / 图片输入未做完整映射（文本为主；图片以占位符处理）。
- 方案 A（localhost sidecar）未实现。

## 7. CLI 配置示例

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

## 8. 验收 checklist

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
- [ ] 背压：超过每 key 并发上限返回 `429 + Retry-After`
- [ ] 单元 + 集成测试全绿（`npm run test -w @cursor-gateway/server`）
