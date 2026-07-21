# CSAPI / Hermes 黑盒验收工具

这是一个完全隔离、零运行时依赖的 Node.js 22 工具。它只通过 HTTP
调用 CSAPI 和只读观测接口，不读取数据库、不连接 VPS，也不会输出 prompt、
响应正文、API key 或 Authorization。

## 严格证据边界

标准 `/v1/chat/completions` 的 completion ID 不是 Gateway run ID。仅凭 HTTP
200 或 SSE `[DONE]` 也无法证明后端真实达到六并发。因此本工具只接受以下黑盒证据：

- 响应头：`x-csapi-run-id`、生命周期时间、provider/model；
- SSE/JSON 事件中的显式 `runId` 和生命周期元数据；
- 推荐的只读观测 URL（按幂等键或 run ID 查询）。

缺少真实 run ID、`queued/started/finished` 时间或 provider/model 时，严格验收会
退出 1，而不会把 completion ID 或客户端发送时间冒充服务端证据。

## 运行要求

- Node.js 22 及以上；
- 复用仓库现有 `tsx`、TypeScript 和 Node 类型，不新增运行时依赖；
- 从本目录运行：

```bash
cd tools/csapi-validation
PATH="$HOME/.node22/bin:$PATH" npm run check
```

## 秘密与配置

秘密只能从环境变量读取。CLI 故意不提供 `--api-key` 或 token 参数。

必需配置：

- `CSAPI_VALIDATION_API_KEY`：CSAPI 鉴权值；
- `--base-url` 或 `CSAPI_VALIDATION_BASE_URL`；
- `--workspace` 或 `CSAPI_VALIDATION_WORKSPACE`。

原始 workspace ID 只在进程内存中保留，用于请求头和请求体；不会写入 JSON、
stdout、stderr 或错误消息。报告只包含
`target.workspaceFingerprint`，格式为原值 SHA-256 的前 16 位十六进制摘要
（`sha256:<16 hex>`）。该摘要稳定且不能直接恢复原值，但不应被当作抗枚举的秘密。

常用可选配置：

- `--model`：请求模型，默认 `gpt-5.6-sol`；
- `--expected-provider`：默认 `cursor-gateway`；
- `--expected-model`：默认 `gpt-5.6-sol`；
- `--api-key-env`：API key 所在环境变量的名字；
- `--auth-header` / `--auth-scheme`：默认 `authorization` / `Bearer`；
- `--observe-by-key-url`：按幂等键查询，支持 `{idempotencyKey}`；
- `--observe-by-run-url`：按 run ID 查询，支持 `{runId}`；
- `--observer-key-env`：观测接口使用独立秘密时，指定其环境变量名字；
- `--json-out`：JSON 结果路径，默认 `-`（stdout）。文件以 `0600` 原子写入。

短任务 prompt 可通过 `CSAPI_VALIDATION_SHORT_PROMPT` 覆盖。长任务 prompt
必须放在 `CSAPI_VALIDATION_LONG_PROMPT`，不会进入 JSON 或人类摘要。
所有 HTTP URL 都拒绝 `user:password@host` userinfo。completion/观测 URL
可以携带运行所需 query，但报告不会保存 query、fragment 或其中的值；
`target.baseUrl` 只保留不含 credential/query 的 origin。

## 只读观测接口契约

推荐接口：

```text
GET /validation/v1/runs/by-idempotency/{idempotencyKey}
GET /validation/v1/runs/{runId}
```

仓库内 Gateway 已实现上述路径。它们复用 CSAPI API-key 鉴权，并将查询严格
限制到创建 run 的同一 key scope：跨 key 的按幂等键查询返回空数组，按 run
ID 查询返回 404。响应只含生命周期、路由和 claim 元数据，不返回 workspace、
prompt、response、token、Authorization 或任意消息正文。

响应可以是单个 `run`、`runs` 数组或直接数组。字段名支持 camelCase 和
snake_case；最小严格证据示例：

```json
{
  "runs": [
    {
      "runId": "57f88a1a-ec4d-4abc-a921-994dcf071cf5",
      "status": "finished",
      "queuedAt": "2026-07-21T00:00:00.000Z",
      "startedAt": "2026-07-21T00:00:00.200Z",
      "finishedAt": "2026-07-21T00:00:08.000Z",
      "lastActivityAt": "2026-07-21T00:00:07.500Z",
      "terminal": true,
      "cancelReason": null,
      "provider": "cursor-gateway",
      "model": "gpt-5.6-sol",
      "claimAttempts": 1,
      "applicationStatusCode": "CSAPI_COMPLETED",
      "events": [
        {
          "type": "progress",
          "at": "2026-07-21T00:00:04.000Z"
        }
      ]
    }
  ]
}
```

接口即使返回 `prompt`、`response` 或 message/content，工具也会丢弃这些字段。
长任务需要可重复查询的 `lastActivityAt`，或返回不超过
`--max-activity-gap-ms` 的活动事件。

可选的 `claimAttempts`（也接受 `claim_attempts` 或
`x-csapi-claim-attempts`）一旦大于 1，严格验收立即失败。若观测接口不暴露该
字段，黑盒工具无法证明服务端内部是否发生过不可见的重复 claim；无论该字段
是否存在，同一幂等键返回多个 run 都会严格失败。`cancelled`/`canceled` 是
轮询终态，但不是成功终态；工具会保留 `cancelReason` 证据并以
`RUN_NOT_COMPLETED` 失败，缺少原因还会产生 `CANCEL_REASON_MISSING`。

## 命令

### 六并发与并发幂等

`accept` 同时发出恰好 6 个不同会话/幂等键的任务，验证：

- 6 个 accepted、started、completed；
- 真实生命周期区间的峰值并发恰好为 6；
- 6 个唯一 run ID，无重复、无丢失；
- 每个 run 的排队延迟、总时长、HTTP 状态和应用状态码；
- 两个并发请求使用同一幂等键时只产生一个 run。

```bash
PATH="$HOME/.node22/bin:$PATH" npm run accept -- \
  --base-url "https://csapi.example.internal" \
  --workspace "workspace-id" \
  --observe-by-key-url "/validation/v1/runs/by-idempotency/{idempotencyKey}" \
  --observe-by-run-url "/validation/v1/runs/{runId}" \
  --json-out "./acceptance.json"
```

### 超过 300 秒的活动任务与重新附着

`long` 要求 `CSAPI_VALIDATION_LONG_PROMPT` 描述一个预计超过 300 秒、持续提交
进度/lease 的合成任务。`CSAPI_CALLER_WAIT_TIMEOUT` 被视为“调用方已脱离”，
不是任务失败；工具随后用同一幂等键重新附着并查询最终状态。只有
queue/idle/absolute timeout、502、取消或最终非 completed 才失败。

```bash
PATH="$HOME/.node22/bin:$PATH" npm run long -- \
  --base-url "https://csapi.example.internal" \
  --workspace "workspace-id" \
  --observe-by-key-url "/validation/v1/runs/by-idempotency/{idempotencyKey}" \
  --observe-by-run-url "/validation/v1/runs/{runId}" \
  --expected-long-duration-ms 310000 \
  --json-out "./long-acceptance.json"
```

### 有界 24 小时观测

`observe` 从已有结果读取 run ID，按只读接口复查终态和路由。默认持续 24
小时，`--duration` 最大只能是 `24h`，因此不会无限运行。

```bash
PATH="$HOME/.node22/bin:$PATH" npm run observe -- \
  --base-url "https://csapi.example.internal" \
  --workspace "workspace-id" \
  --input "./acceptance.json" \
  --observe-by-run-url "/validation/v1/runs/{runId}" \
  --duration 24h \
  --interval 60s \
  --json-out "./observation-24h.json"
```

## 路由漂移

工具检查响应头、JSON、SSE 和观测事件中的 provider/model。任何
`DeepSeek` 或其他非 `cursor-gateway` provider，以及任何非
`gpt-5.6-sol` model，都会立即中止同批请求并失败。provider/model
缺失同样不能通过严格验收。

## 输出与退出码

- stdout：机器可读 JSON（`--json-out -` 时）；
- stderr：单行摘要，不含响应正文；
- `0`：全部断言通过；
- `1`：验收断言失败；
- `2`：配置或用法错误；
- `3`：未预期的工具/传输错误。

JSON 的 `runs[]` 包含 run ID、accepted/started/completed 时间、排队延迟、
总时长、provider/model、claim attempts、应用状态码和每次附着的 HTTP 状态。
`target.workspaceFingerprint` 和幂等键都只保存 SHA-256 短摘要，不保存原值。
completion/chat ID、prompt、响应正文、Authorization 和 API key 不进入结果。

## 本地测试

```bash
PATH="$HOME/.node22/bin:$PATH" npm run format
PATH="$HOME/.node22/bin:$PATH" npm run lint
PATH="$HOME/.node22/bin:$PATH" npm run typecheck
PATH="$HOME/.node22/bin:$PATH" npm test
```

测试使用本地 mock HTTP server 和 fake clock，覆盖成功、六并发、并发幂等、
重复 claim、同幂等键多个 run、取消终态、502、生命周期 504、调用方 504 后
重附着、provider 漂移，以及 workspace/URL/auth/prompt/chat ID 不泄露。
“超过 300 秒”仅使用虚拟时间，测试不会真实等待。
