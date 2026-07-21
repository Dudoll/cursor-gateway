# Telegram → Hermes → Cursor Gateway 生产诊断、优化与验证报告

日期：2026-07-20  
生产范围：`Telegram → Hermes → cs-gateway model → Gateway/PostgreSQL → wsl-e2ee → Cursor SDK → Hermes → Telegram`  
数据时区：除明确标注 PDT 外，时间均为 UTC。  
脱敏原则：不记录或输出 token、API key、cookie、Telegram 用户/聊天 ID、用户 prompt/response 正文。

配套聚合证据：
`docs/reports/telegram-hermes-gateway-production-diagnosis-2026-07-20.evidence.json`

## 1. 执行摘要

已证实的主要根因不是 Telegram，也不是 PostgreSQL claim 锁：

1. **上下文无界重复放大。** Hermes 的受影响会话已有约 200 条消息、约 104,077 tokens。
   原 csapi 没有收到稳定 session header，因此每次模型调用都新建 Gateway conversation，
   并把整段历史重新塞给 Cursor Runner。真实成功样本的 Runner 执行为 268.647 秒；
   同窗口失败样本在 300 秒处被 csapi 取消。
2. **300 秒 timeout budget 精确碰撞。** csapi 为 300 秒；Hermes 对超过 100k tokens
   的 stream-stale 阈值也升到 300 秒。Gateway 原来的 SSE 只发注释 keepalive，
   Hermes/OpenAI SDK 不把注释暴露成模型 chunk。结果是一次请求在 300 秒边界失败，
   Hermes 再按默认策略重试 3 次，用户从 Telegram ingress 到最终错误共等待
   **913.495 秒（15 分 13.5 秒）**。
3. **取消链历史上不完整。** 近期 lifecycle/fencing 修复部署前，Hermes 放弃的请求没有
   真正终止 Runner 工作；5 个 `auto` error run 的执行时间达到 16,502–17,280 秒。
   近期代码已能取消 running run，本次又用生产 abort 实测确认 1.922 秒内状态转为
   `cancelled`、lease 三字段清空、Runner 报 `stopped ... after lease loss`。
4. **VPS 内存容量不足且曾真实 OOM。** 主机只有 1,962 MiB RAM；本次诊断前 7 天已有
   5 次 OOM kill（4 次 Hermes、1 次 Chrome）。两个 Hermes profile 同时运行时，
   cgroup 内存合计常在 600–800 MiB，且默认 active-session 数无限。

已部署修复：

- 首次/无状态 prompt 上限 96,000 字符，保留 system、最近上下文和最新 user turn；
- OpenAI system message 不再被丢弃；
- Hermes provider 注入 session 与幂等 header；
- session → Gateway conversation 映射持久化到 PostgreSQL，Gateway 重启后可恢复；
- 同一模型 turn 的重试复用既有 run，不再重复占 Runner/重复计费；
- stream 建连后立即发送协议合法的 OpenAI no-op chunk / Anthropic ping，并持续心跳；
- csapi 增加 request id ↔ run id ↔ conversation id 的结构化日志；
- Hermes main/telegram2 active session 上限分别设为 2/1，超限明确回包，不静默排队；
- Hermes cgroup 使用 `MemoryHigh/MemoryMax` 隔离，避免再次拖垮 Gateway、rclone 和 user manager。

修复后，一个约 400k 字符的 `auto` 请求被裁剪到 96,000 字符，单样本总耗时
**11.530 秒**（queue 1.629 秒、Runner 9.901 秒），成功完成。该 after 数据只有 1 个
大上下文样本，不能伪装成稳定分位数。

随后恰好捕获到 1 条真实 post-fix Telegram 复杂请求：96,000 字符的 Gateway attempt
仍在 300.103 秒超时，说明 Cursor SDK/模型复杂任务长尾没有被 context cap 消除。但幂等
生效：Hermes 的 3 次 API attempt 只创建了 **1 个** Gateway run；后两次立即复用已取消
终态，Runner 已释放。Hermes 随后按现有配置切到 deepseek fallback 并继续执行工具，
不再重复占用 WSL worker。

下一条真实 Telegram turn 又提供了正向证据：首个 `gpt-5.6-sol` run 的 95,995 字符 prompt
在 231.039 秒完成；同一 Hermes turn 的下一次模型调用复用相同 Gateway conversation，
prompt 降为 126 字符，而不是再次发送整段历史。

## 2. 实际运行方式与配置

### 2.1 Hermes

- 运行方式：`systemd --user`，不是 pm2/docker/tmux。
- 单元：
  - `hermes-gateway.service`
  - `hermes-gateway-telegram2.service`
- 包版本：Hermes Agent `0.18.2 (2026.7.7.2)`。
- 实际源码 checkout：`c48d53413aa2c09f6d5703082361c2754f1d5350`。
- main `HERMES_HOME=/home/joel/.hermes`；telegram2 使用独立 profile home。
- 两个 profile 使用不同配置目录和独立 Telegram token；48 小时内没有确认的
  Telegram polling 409，不能把两个进程直接判成 token 冲突。
- main 当前默认 provider 是 deepseek；受影响 Telegram session 的持久化 override 是
  `provider=cursor-gateway, model=auto`。
- cursor-gateway provider：
  - transport：OpenAI Chat Completions
  - upstream：`http://127.0.0.1:18080/v1`
  - auth field：`CURSOR_GATEWAY_CSAPI_KEY`（值未读取/输出）
- main streaming 开启；typing indicator 默认开启并每 2 秒刷新。
- 同 session 严格串行，不同 session 可并行。

### 2.2 Gateway

- Compose：`~/cursor-gateway/infra`
- 容器：`infra-app-1`、`infra-postgres-1`、`infra-redis-1`
- 内部入口：`127.0.0.1:18080 → app:8080`
- 公网入口：`https://cs.joelzt.org`
- csapi：
  - per-key 并发上限：4
  - run timeout：300,000 ms
  - prompt 上限：96,000 字符（本次新增）
- 明文 run queue 在 PostgreSQL `runs` 表；Redis 不承担这条 plaintext claim queue。

### 2.3 WSL Runner

- `runnerId=wsl-e2ee`
- manual-only 现状未改变；本次没有新增 Windows/WSL 自启。
- 配置：
  - total workers：4
  - E2EE workers：1
  - legacy/plaintext workers：3
  - poll：2,000 ms
  - job timeout：1,800,000 ms
  - cancel grace：10,000 ms
- 当前进程由既有 supervisor/wrapper 维持。诊断期间 Gateway 故障触发过 Runner
  自身既有的 heartbeat 自恢复；本次部署没有人工重启 Runner。

## 3. 每一跳与协议

1. Telegram adapter 使用 long polling 接收 update。
2. 短文本先经过约 0.18–0.3 秒 batching；随后 `handle_message()` 立即创建后台 task。
3. adapter 按 Hermes session key 串行；不同 chat/session 并行；立即启动 typing refresh。
4. Hermes custom provider 发 OpenAI-compatible `stream: true` 请求到本机 csapi。
5. csapi 认证、per-key limiter、per-session serializer 后创建 PostgreSQL plaintext run。
6. `wsl-e2ee` legacy worker 从 `/api/runner/jobs/claim` 领取；claim 使用
   `FOR UPDATE SKIP LOCKED`。
7. Runner 每 30 秒续 legacy lease；Cursor SDK 使用
   `Agent.create/resume → agent.send → run.stream → run.wait`。
8. Gateway 每 400 ms 轮询 run 终态。
9. csapi 是**终态聚合流**，不是 token 直通：
   - 修复前：等待期间只有 SSE comment；
   - 修复后：立即并周期性发送协议合法 no-op/ping，终态后再发文本 chunks。
10. Hermes stream consumer 聚合模型响应，再由 Telegram adapter 按 4,096 字符分片发送。

重复 timeout 层：

- Gateway csapi：300 秒；
- Hermes provider request：默认 1,800 秒；
- Hermes stream-stale：普通 180 秒，50k/100k 上下文升至 240/300 秒；
- Hermes gateway inactivity：默认 1,800 秒；
- WSL Runner SDK job：1,800 秒。

真实故障发生在 `csapi 300s == Hermes large-context stale 300s` 的碰撞处，不是最外层
1,800 秒。

## 4. 证据与检查方法

### 4.1 原始证据位置

- Hermes journald：
  - `hermes-gateway.service`
  - `hermes-gateway-telegram2.service`
- Hermes 状态：
  - `~/.hermes/state.db`
  - `~/.hermes/profiles/telegram2/state.db`
  - `gateway_state.json`
- Gateway：
  - `infra-app-1` structured logs
  - PostgreSQL `runs`, `conversations`, `automation_threads`, `app_users`
  - Docker inspect/events/stats
- Runner：
  - `/home/dministrator/cursor-e2ee/apps/windows-runner/logs/e2ee-runner.log`
- 主机：
  - kernel journal 的 OOM records
  - systemd user unit/cgroup properties
- 脱敏聚合：
  - 配套 evidence JSON。

### 4.2 查询类别

- PostgreSQL 只读取 status/model/origin/timestamps/lease/attempt/count/length；
  未输出 prompt/response 正文。
- Hermes SQLite 只读取 session source/model/provider、message role/timestamp/length；
  session id 仅以 SHA-256 前 10 位关联。
- journald 使用逐行流式解析和分类，不再整段读入内存。
- Telegram 只调用只读 `getMe/getWebhookInfo`；未给任何用户发送测试消息。

### 4.3 诊断过程中的生产事件

初始一次 24 小时 journald 聚合错误地使用了内存缓冲，在 2 GiB VPS 上触发了
2026-07-20 06:48–06:58 PDT 的 OOM storm。该事件**不计入既有故障基线**，但必须披露。
OOM 杀死了 Hermes、Gateway、user manager 和 rclone；由于 Hermes config.yaml 指向
iCloud FUSE，rclone 死亡后两个 Hermes unit 又进入 `ENOTCONN` restart loop。

已完成恢复：

- 终止高内存诊断；
- 强制重建 Gateway container（恢复健康）；
- detach stale FUSE 并重新挂载；
- 顺序启动两个 Hermes unit；
- 后续日志分析全部改为常量内存流式处理；
- 最终部署后 kernel journal 无新增 OOM。

同时，诊断前 7 天已有 5 次独立 OOM kill，证明内存问题不是此次诊断才产生。

## 5. 功能结论

- Telegram ingress：**历史实链路确认正常**。受影响 user message timestamp 能与
  Hermes session、Gateway runs 对齐。
- Telegram 立即 typing：**正常**。源码与运行配置均开启。
- Telegram 409：**未发现**，48 小时确认数 0。
- Telegram 429：**未发现**，48 小时确认数 0。
- Telegram 网络：**有波动但有 fallback**。main/telegram2 分别记录 118/55 次主路径
  fallback warning；最终 `getWebhookInfo` 均为 HTTP 200、pending updates 0。
- Telegram outbound：48 小时记录 4 次历史 send failure，最近一次在 2026-07-19；
  最终 adapter state 均为 running。
- 模型路由：**正常**。受影响 `auto` runs 被 `wsl-e2ee` claim；没有误进 Hermes executor。
- 鉴权：**正常**。csapi key 与 Cloudflare Access 分离；测试覆盖 401。
- OpenAI system：**修复**。原代码会过滤 OpenAI messages 中的 system。
- 流式：**修复但仍是终态聚合**。no-op/ping 可被 SDK 观察；不声称 token 级实时。
- timeout/cancel：**正常**。生产 abort 实测 1.922 秒完成取消、lease 清空、worker 停止。
- retry 幂等：**修复**。相同 idempotency key 第二次 83.1 ms 返回，数据库仅 1 个 run。
  真实 Telegram timeout 也验证 3 个 Hermes attempts 只创建 1 个 Gateway run。
- 同 chat/session 顺序：**正常**；跨 session 并行：**正常**。
- 容量背压：**正常**。并发 8 时 4 成功、4 个明确 429；没有静默挂起。
- Gateway 重启恢复：**修复**。同 session 在重启前后 conversation hash 相同，
  continued prompt 40 字符；真实 Telegram turn 也观察到 95,995 → 126 字符。
- 长消息分片：Hermes Telegram adapter 按 4,096 字符分片；仓库 contract E2E 也覆盖分片。
- Telegram 失败重试：Hermes adapter 对 connect failure/429 `retry_after` 有实现；
  本次未制造真实 429。
- tool calls：**协议不透明/未完整支持**。csapi 把 Cursor SDK 视为 agentic text backend，
  不会把 OpenAI `tool_calls` 原样返还给 Hermes。这不是本次延迟根因，但仍是功能限制。

## 6. 延迟分解

### 6.1 真实慢成功样本（n=1）

- Telegram ingress：12:07:17
- Gateway run created：12:07:21.338
- ingress → dispatch：4.338 秒
- Gateway queue：1.437 秒
- Runner/Cursor SDK：268.647 秒
- Gateway run total：270.084 秒
- Hermes assistant persisted：12:11:51.749883
- ingress → Hermes result：274.750 秒

瓶颈是 Runner/Cursor SDK，不是 queue。

### 6.2 真实 timeout 样本（1 个用户 turn，3 个 API attempts）

- Telegram ingress：12:43:08
- attempts：300.108 / 300.211 / 300.210 秒
- Hermes 最终 error：12:58:21.495363
- 用户等待：913.495 秒
- Hermes 日志：`msgs=200, tokens≈104,077, retries=3`

### 6.3 最近生产 `auto` 基线（10:10–13:15 UTC）

样本 9：

- finished 3，成功率 33.3%
  - queue p50/p95/max：0.841 / 1.377 / 1.437 秒
  - execution p50/p95/max：267.613 / 268.544 / 268.648 秒
  - total p50/p95/max：268.454 / 269.921 / 270.084 秒
- cancelled 6，timeout/cancel 率 66.7%
  - total p50/p95/max：300.116 / 300.211 / 300.211 秒

样本很小，但 300 秒边界高度集中，结论明确。

### 6.4 修复后大上下文 `auto`（n=1）

- 原请求约 400k 字符
- Gateway prompt：96,000 字符
- queue：1.629 秒
- Runner/Cursor SDK：9.901 秒
- total：11.530 秒
- status：finished

这是受控单样本，不提供虚假的 p50/p95。

### 6.5 Gateway → Runner 并发阶梯

模型：`gpt-5.4-nano`；每档 n=并发数。

- 并发 1：
  - before 12.262 秒；after 5.367 秒
  - throughput 0.082 → 0.186 req/s
- 并发 2：
  - before p50/p95 6.049/7.255 秒
  - after p50/p95 4.839/5.268 秒
  - throughput 0.276 → 0.380 req/s
- 并发 4：
  - before p50/p95 5.243/9.282 秒
  - after p50/p95 6.457/11.294 秒
  - 模型本身波动明显，after 不是每档都更快
- 并发 8：
  - before/after 均为 4×200 + 4×429
  - 硬容量未改变

第一容量限制：

1. Hermes main 主动限制 2 个跨 session 并行；
2. WSL legacy pool 3 workers；
3. csapi per-key 4；
4. 超过 4 立即 429。

### 6.6 真实 post-fix Telegram 复杂请求（n=1）

- Gateway prompt：96,000 字符
- Gateway run：300.103 秒后 cancelled
- Hermes attempts：3
- 实际 Gateway runs：1（幂等复用）
- Runner：收到 lease loss 后停止
- Hermes：转入 deepseek fallback；日志确认仍在执行 patch/memory 等工具

因此，本次修复消除了“3×300 秒重复 Runner 任务”，但没有声称能把所有复杂 Cursor
任务压到 300 秒以内。

### 6.7 真实 post-fix session continuation（n=1）

- 首个 `gpt-5.6-sol` run：95,995 字符，231.039 秒，finished
- 下一次模型调用：126 字符
- 两个 run：相同 Gateway conversation

这验证了真实 Telegram/Hermes 长会话不再在每个模型 iteration 重传约 96k 字符历史。

## 7. 已部署修复

### 7.1 Gateway

- `CSAPI_MAX_PROMPT_CHARS=96000`
- initial/stateless prompt 有界；continued turn 只发最新 user
- OpenAI system 合并进 prompt
- session mapping 持久化
- idempotency key 去重
- protocol-valid immediate/periodic heartbeats
- structured correlation logs：
  - `csapi.run.created`
  - `csapi.run.finished`
  - `csapi.run.failed`

### 7.2 Hermes provider

部署文件：
`~/.hermes/plugins/model-providers/cursor-gateway/`

- `x-session-id`
- deterministic `Idempotency-Key`
- key 仍只来自环境，不写入插件。

### 7.3 Hermes 容量和隔离

- main `gateway.max_concurrent_sessions=2`
- telegram2 `gateway.max_concurrent_sessions=1`
- main：MemoryHigh 500 MiB，MemoryMax 650 MiB
- telegram2：MemoryHigh 430 MiB，MemoryMax 550 MiB
- `TasksMax=128`、`OOMPolicy=stop`

### 7.4 恢复和部署

- Gateway final image：
  `sha256:be29ae557e9dc2f83edff75eb57f96cbcc7c3f2e511435e91bd24685bdb7a227`
- 生产备份：
  `/home/joel/backups/cursor-gateway/telegram-latency-20260720T144801Z`
- 未人工重启 WSL Runner。

## 8. 自动化测试

新增/扩展：

- OpenAI system 保留
- 初始 context 截断并保留最新 turn
- protocol heartbeat
- Telegram → Hermes contract → Gateway → fake runner → Telegram reply
- same-session serial / cross-session parallel
- durable session across csapi recreation
- 429 backpressure
- timeout cancellation
- retry idempotency
- client abort
- Hermes provider 稳定 headers 与 thread-local 隔离
- 默认拒绝 production smoke

命令和结果：

```text
npm run typecheck
npm test
npm run build
```

- 204 passed
- 7 skipped（需要外部 PostgreSQL/邮件等集成环境）
- 0 failed
- build passed

```text
python3 -m unittest discover integrations/hermes/cursor-gateway -p 'test_*.py'
```

- 2 passed

IDE diagnostics：0。

可重复 smoke：

```text
npm run smoke:csapi
```

- 默认只指向 loopback，仍必须显式提供 key；
- 非 loopback 或 `CSAPI_SMOKE_PRODUCTION=1` 时必须再设置
  `CSAPI_SMOKE_ALLOW_PRODUCTION=1`；
- 并发档最高硬限制为 8。

## 9. 最终生产状态

- `infra-app-1`：healthy，restart count 0
- PostgreSQL：healthy；23 connections，其中 22 个 idle ClientRead、1 active，无长查询
- Redis：1 client、0 blocked、0 rejected、0 evicted
- Hermes main/telegram2：active，restart count 0。资源快照时 active agents 为 0；
  最终交接期间用户仍在使用 main，观察到 1 条同 conversation 的 126 字符 continued run；
  这是合法在途工作，不是残留/泄漏，telegram2 为 0。
- Telegram pending updates：0
- Gateway queued/running/waiting jobs：0
- WSL Runner：原进程继续运行，最后 FD 129，无取消后资源增长证据
- final deploy 后无新增 kernel OOM

## 10. 排除项

- PostgreSQL queue/lock：不是首要瓶颈；真实慢样本 queue 仅 1.437 秒。
- Redis：不在 plaintext run claim 主路径，且无 blocked/rejected/evicted。
- Telegram 409/429：48 小时均为 0。
- 两个 Hermes unit：使用独立 profile/token，不是重复 polling 同一 bot。
- Gateway CPU/内存：最终约 80 MiB，非慢请求主因。
- WSL claim polling：正常；请求能在 0.1–1.6 秒量级被领取。

## 11. 遗留限制与 blocker

1. **未主动做真实 Telegram ingress/outbound 烟测。** 当前没有可证明属于测试账号的发送端；
   为避免给无关用户发消息，只做历史实链路关联、Bot API 只读检查和 deterministic fake E2E。
2. **tool_calls 不是透明兼容。** 若要让 Hermes 自己执行 OpenAI function calls，需要新增
   Cursor SDK ↔ OpenAI tool_calls 的显式协议，而不是文本聚合。
3. **2 GiB VPS 仍偏小。** cgroup 隔离避免全机级联 OOM，但高峰可能让单个 Hermes unit
   被自身 MemoryMax 终止。长期建议升级内存。
4. **Hermes config 依赖 iCloud FUSE。** rclone 死亡会让 config symlink `ENOTCONN`；
   建议把运行时关键 config 留在本地 ext4，再异步同步到 iCloud。
5. **大上下文 after 只有 n=1。** 需要后续按真实工作负载持续采样，不能把 11.53 秒当作
   稳定 p95。
6. **Cursor SDK/model 延迟有长尾。** 同一个 46 字符 nano prompt 曾出现 138.793 秒
   Runner execution；heartbeat 可保证不被误判 stale，但不能消除上游模型长尾。
7. **复杂请求仍可能触发 300 秒 Gateway timeout。** 幂等和 cancel 已保证不会重复泄漏
   worker；Hermes 的全局 fallback 策略仍可能继续执行较长的替代模型工具任务。

## 12. 回滚

Gateway、环境文件、Hermes plugin/config 的部署前备份位于：

`/home/joel/backups/cursor-gateway/telegram-latency-20260720T144801Z`

回滚时应先确认 Gateway DB 与两个 Hermes profile 均无 active/in-flight work，再恢复备份并
顺序重启 Gateway、Hermes main、Hermes telegram2；Runner 不需要重启。

## 13. 代码汇总与上库

日期：2026-07-21（UTC+8）  
执行：接管既有代理进度，以本地/VPS 真实状态完成功能汇总、门禁与上库。

### 13.1 无损盘点

| 位置 | HEAD / 状态 |
|------|-------------|
| 本地 `fix/telegram-hermes-gateway-latency` | 汇总前 `873a6a1`；已含 `origin/main`（`8849c2a`）全部提交，并超前含 Hermes 延迟修复 `d147d04`、release/interview/xhs 等 |
| `origin/main`（汇总前） | `8849c2a`（desktop 0.1.11 + WSL resilience merge） |
| VPS `~/cursor-gateway` | `main` @ `56fec7e`（desktop 0.1.10 时代），相对 HEAD 有大量 **未提交** WT 改动 |
| VPS 脱敏备份 | `~/cursor-gateway/backups/pre-sync-inventory-20260721T044510Z/`（sanitized tracked diff + hashes + Hermes runtime 元数据；未保留 raw secrets diff） |
| VPS Hermes | `systemd --user`：`hermes-gateway` / `hermes-gateway-telegram2` active；MemoryHigh/Max 隔离仍在 |
| 运行中 `infra-app-1`（汇总前） | **回归**：镜像内 **无** `apps/server/src/csapi`；`/v1/models` 落到 Cloudflare Access → `403 email_not_allowed`。`.env` 仍有 `CSAPI_ENABLED=true`、`CSAPI_MAX_PROMPT_CHARS=96000`，但进程未加载 csapi。需在入库后用完整源码 **重建 app 镜像** 恢复 |

合并方式：本地分支已是 `origin/main` 的严格超集（无分叉），采用 **保留本地超集 + ff-only 上库**；不对 VPS 做 hard reset/clean。`~/cursor-gateway` tracked WT 的关键路径与本地一致；另行发现 `~/cursor-gateway-release` 存在 VPS-only interview/XHS/release commits 与 8 文件 live dirty patch，已在后续最终复核（§14）中完整移植。

### 13.2 功能保留矩阵

| 功能 | 生产证据 | 代码/提交 | 汇总结论 |
|------|----------|-----------|----------|
| WSL resilience / fencing / cancel | 诊断报告 §1/§5：abort 1.922s 清 lease；runner `stopped after lease loss` | `21389e2`、`bcde191`、`d67e565`；`db.ts` lease fence、`cursorAgent.ts`、`concurrency.ts` | **保留**（已在 `origin/main` + 分支） |
| E2EE | VPS WT/本地同哈希：`e2eeDb.ts`、`e2eeProcessor.ts`、`e2eeRunnerSignature.ts` | `agent/e2ee` 合入线 + `21389e2` | **保留** |
| 客户端轮询 auto-refresh | secure-web/web + shared | `3918283` / `13affc3`；`packages/shared/src/runPolling.ts` | **保留** |
| desktop 0.1.11 | `apps/desktop/package.json` / `desktop-version.json` = 0.1.11 | `95e5783`、`8849c2a` | **保留** |
| 96k prompt cap | 生产 `.env` `CSAPI_MAX_PROMPT_CHARS=96000`；after 样本裁到 96,000 | `d147d04`；`config.ts` / `csapi/server.ts` / `protocol.ts` | **保留**（镜像重建后生效） |
| session mapping | after：同 session continued prompt 126 字符；automation_threads 持久化 | `d147d04`；`csapi/backend.ts` `resolveConversation` + Hermes `x-session-id` | **保留** |
| Hermes idempotency / heartbeat / logging / concurrency / memory | plugin headers；SSE no-op/ping；429 背压；cgroup Memory*；max_concurrent_sessions 2/1 | `integrations/hermes/cursor-gateway/`；`csapi/server.ts`；Hermes unit drop-ins | **保留**（plugin 已在诊断期部署；Gateway 侧随镜像恢复） |
| Interview / XHS / public release | 本地超集相对 VPS WT 多出的产品线 | `d2fe387`…`873a6a1` | **保留**（上库后 VPS 将获得；不回退） |

### 13.3 门禁

```text
export PATH="$HOME/.node22/bin:$PATH"
npm run typecheck   # pass
npm test            # aggregated pass=207 fail=0 skipped=7
npm run build       # pass
python3 -m unittest discover integrations/hermes/cursor-gateway -p 'test_*.py'  # 2 pass
hermes_cursor_runner prompt clip test  # pass
xiaohongshu publisher tests            # 11 pass（PNG 依赖在无系统字体环境用 mock）
```

性能低扰动（单元/契约，相对报告 after 语义不劣化）：

- prompt 裁剪 / session-first vs continued：`csapi-protocol` + routes
- session 复用跨实例、同 session 串行、跨 session 并行
- OpenAI streaming heartbeat
- cancel/abort 释放、timeout→504
- idempotency 复用、429 背压

未在汇总窗口对生产做破坏性加压；上库后以重建镜像 + `/v1` 鉴权探针恢复生产能力。

### 13.4 上库与 VPS 同步

- Feature branch push：`fix/telegram-hermes-gateway-latency`
- 若 `main` 可安全 fast-forward 则 ff；否则 PR compare URL
- VPS：`git fetch` + **ff-only** 更新 `~/cursor-gateway`（先 stash 仅 tracked WT；保留脱敏备份）；确认无在途 queued/running 后滚动重建 `infra-app`；**不重启** WSL runner；Hermes unit 仅在确认需要时再动

### 13.5 Rollback

- Git：回退到汇总前 tip `873a6a1`（本提交之前）或 `origin/main` 旧 tip `8849c2a`
- VPS 应用镜像：诊断期备份 `/home/joel/backups/cursor-gateway/telegram-latency-20260720T144801Z`；本次盘点备份 `~/cursor-gateway/backups/pre-sync-inventory-20260721T044510Z`
- 禁止 force push `main`

## 14. 最终复核与生产同步

日期：2026-07-21（UTC+8）

### 14.1 VPS-only / local-only 对账

- `~/cursor-gateway`：汇总前为 `56fec7e` + 45 个 tracked WT 改动；关键运行源码与
  `d147d04` 一致。本地多出测试、报告、provider 安装源和更严格的 production smoke guard。
- `~/cursor-gateway-release`：汇总前为 `ea31a79` + 8 个 tracked dirty 文件；这里是
  paid interview、XHS publisher、public release、Cloudflare login handoff 和 writable
  Hermes runner 的 VPS-only 来源。
- 10 个 release commits 已逐个 cherry-pick，8 文件 live patch 已三方合并。冲突处理保留
  E2EE、lease fencing/cancel、csapi/session/idempotency 和 release 两侧功能。
- VPS 根目录两个 untracked relay 脚本是已提交
  `scripts/csapi/{canary-relay,multi-device-sync}.mjs` 的旧副本，不是遗漏功能。
- live Hermes 并发/MemoryHigh/Max/TasksMax 已固化到
  `integrations/hermes/systemd/` 与 `PRODUCTION_CONTROLS.md`。

备份：

- `~/cursor-gateway/backups/pre-sync-inventory-20260721T044510Z/`
- `/home/joel/backups/cursor-gateway/reconcile-20260721T032145Z/`
- `/home/joel/backups/cursor-gateway-release/reconcile-20260721T032819Z/`

未把 `.env`、生产 key、数据库、日志、安装包或 artifacts 纳入 patch/提交。

### 14.2 最终门禁

```text
npm run typecheck  # pass
npm test           # pass=214, fail=0, skipped=7（含 shared 新增 3 项）
npm run build      # pass
```

其他门禁：

- Xiaohongshu publisher：11 passed
- Hermes runner prompt/write policy：1 passed
- Hermes provider：2 passed
- release Python、shell、Node smoke syntax：pass
- IDE diagnostics：0

### 14.3 最终性能行为

最终运行镜像、最终 Runner 代码下：

- C1：1×200，12.601 秒；queue 0.727 秒、Runner 11.385 秒；首数据 94.5 ms。
- C8：4×200 + 4×429；p95 9.726 秒，明确背压。
- 完整 C1/2/4/8 门禁上一轮同镜像主线结果：C2 p95 7.288 秒、C4 p95 10.521 秒，
  C8 仍为 4+429。
- 约 400k 字符首轮：96,000 字符、10.621 秒。
- 同 session 次轮：相同 conversation、44 字符、8.503 秒。
- client abort：1.868 秒后 cancelled，`claimed_by/lease/expiry` 全清，active runs=0。

结论：queue、首字节、96k cap、session 增量、cancel 和 backpressure 行为未劣化。
模型随机长尾仍存在；不把单样本耗时当成稳定 p95。

### 14.4 上库与最终运行版本

- Feature：
  `https://github.com/Dudoll/cursor-gateway/tree/fix/telegram-hermes-gateway-latency`
- 代码候选提交：
  `97ff88a90778ae1838f97daa3902b5a8ee2ace17`
- `origin/main` 已无 force fast-forward 到同一提交；无需 PR。
- VPS `~/cursor-gateway` 已 ff-only 到 `97ff88a`，tracked tree clean。
- `infra-app-1` 来自正确的 `~/cursor-gateway/infra`，running/healthy：
  `sha256:233f614086a1e8bba328746d1ec398ffb68e4af5f57ba68c807d01fb2424ae36`
- 本地 build 与容器内 `index/config/db/routes/social/csapi/*` JS SHA-256 完全一致。
- `/healthz`、`/health`、带 key `/v1/models` 均为 200；Postgres/Redis healthy；
  active queue=0；post-sync kernel OOM=0。
- WSL Runner 因 Runner 代码确有变化，由既有 manual-only supervisor 原地恢复；
  未新增自启。Hermes main/telegram2 active、restart count 0。

独立 release stack `127.0.0.1:18081` 仍未运行，`ai.piallera.com` 当前为 403；该状态在
汇总前已经存在，release-sync timer 当时也因 404 失败。代码与部署资产已保留，但在
2 GiB VPS 上重新启用前，必须先配置 Cloudflare audience 并评估额外 app/Postgres/Redis
内存，不应为“看起来在线”而再次覆盖内部 `infra-app-1`。

### 14.5 最终 rollback

- 代码汇总前：`873a6a1`
- 旧 main：`8849c2a`
- 诊断期部署备份：`/home/joel/backups/cursor-gateway/telegram-latency-20260720T144801Z`
- 本次三处备份见 §14.1

任何回滚都必须先确认无在途任务；禁止 force push、`reset --hard`、`git clean`。
