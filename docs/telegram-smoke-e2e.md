# Telegram → Hermes → Gateway 烟测场景矩阵

日期：2026-07-21  
范围：`Telegram → Hermes → cs-gateway model → Gateway → Runner → Hermes → Telegram`  
配套诊断：[`docs/reports/telegram-hermes-gateway-production-diagnosis-2026-07-20.md`](./reports/telegram-hermes-gateway-production-diagnosis-2026-07-20.md)

## 分层

| 层 | 触发 | 依赖 | 目的 |
|----|------|------|------|
| **CI fake E2E** | PR / push（workflow `ci-telegram-smoke`） | 无 secrets；Fake Bot + Fake Runner + 进程内 CSAPI | 确定性覆盖完整用户场景 |
| **Hermes provider 单测** | 同上 | 仅 Python stdlib | session / idempotency headers |
| **可选真实烟测** | 显式 `TELEGRAM_SMOKE=1` | Bot token + **专用** smoke chat id + CSAPI key | 本地/受控环境验证真实 Bot API；**默认跳过，CI 不跑** |

硬约束：

- 不提交 bot token / API key / `.env`
- 真实烟测只允许发往 `TELEGRAM_SMOKE_CHAT_ID`，禁止扫真实用户
- 不新增 Windows/WSL 自启；不无故重启 runner
- 非 loopback CSAPI 必须再设 `TELEGRAM_SMOKE_ALLOW_PRODUCTION=1`

## 场景矩阵

| ID | 场景 | CI fake | 真实烟测 | 验收标准 |
|----|------|---------|----------|----------|
| S1 | 冷启动 / 首条消息 | ✅ | ✅（cold turn） | typing 先于回包；CSAPI 200；conversation/run 各创建 1 |
| S2 | 同 chat 连续追问 | ✅ | ✅（follow） | 复用同一 conversation；continued prompt 仅为最新 turn |
| S3 | 跨 chat 并行 | ✅ | 可选 | ≥2 个 conversation 并行；不串行阻塞全部 chat |
| S4 | 短问快答 vs 长上下文裁剪 | ✅ | — | 短 prompt 很小；超长历史 ≤ maxPromptChars 且保留最新 turn |
| S5 | 超时后用户可见失败 | ✅ | — | HTTP 504；`cancelCount ≥ 1`；Bot 侧 error 事件 |
| S6 | 取消 / 资源释放 | ✅ | — | 超时取消路径清空在途工作（cancel） |
| S7 | 背压 / 限流 | ✅ | — | 并发超限明确 429 + `Retry-After`；Bot 可见错误，不静默挂起 |
| S8 | 长回复分片 | ✅ | — | 每片 ≤ 4096；拼接无损 |
| S9 | Gateway 不可达 | ✅ | — | 用户可见失败（503 / error 事件） |
| S10 | Runner 忙 / 无 worker | ✅ | — | ≥400 状态；Bot 可见错误 |
| S11 | 无效模型 | ✅ | — | 回退 `auto`；请求成功完成，不挂起 |
| S12 | typing / 首包可见性 | ✅ | ✅（sendChatAction） | 事件序：typing → message |
| S13 | Hermes 会话上限 | ✅ | — | 超限明确 429 文案，不无限排队 |
| S14 | 慢请求心跳 | ✅ | — | stream 含 ≥2 次 `chatcmpl-heartbeat` |

## 如何跑

### CI / 本地 fake（默认）

```bash
# 场景矩阵（Node）
npx tsx --test --test-concurrency=1 apps/server/test/telegram-hermes-smoke.test.ts

# 或根脚本
npm run test:telegram-smoke

# Hermes provider
python3 -m unittest discover integrations/hermes/cursor-gateway -p 'test_*.py'
```

### 可选真实烟测（显式开启）

```bash
export TELEGRAM_SMOKE=1
export TELEGRAM_BOT_TOKEN='...'          # 勿提交
export TELEGRAM_SMOKE_CHAT_ID='...'      # 仅专用测试会话
export TELEGRAM_SMOKE_CSAPI_KEY='...'
# 默认 http://127.0.0.1:18080；若打生产还需：
# export TELEGRAM_SMOKE_ALLOW_PRODUCTION=1

npm run smoke:telegram
```

未设置 `TELEGRAM_SMOKE=1` 时脚本以 `skipped: true` 退出 0，避免误打生产。

### CSAPI 容量烟测（既有）

```bash
npm run smoke:csapi   # 仍须显式 key；非 loopback 需 ALLOW_PRODUCTION
```

## CI 与真实烟测差异

| | CI fake | 真实烟测 |
|--|---------|----------|
| Bot API | 内存 FakeTelegramBot | `api.telegram.org` |
| Runner | FakeRunnerBackend（固定 delay） | 真实 WSL/runner |
| 模型 | stub echo | 真实模型（可能有长尾） |
| Secrets | 无 | GitHub Secrets / 本地 env（不入库） |
| 断言 | 状态码、cancel、分片、429、session | 专用 chat 收到短 token 回包 |
| 默认 | **必跑且必须绿** | **跳过** |

建议的 GitHub Secrets 占位（**只文档，不要把值写进仓库**）：

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_SMOKE_CHAT_ID`
- `TELEGRAM_SMOKE_CSAPI_KEY`

Workflow **不会**自动读取这些 secrets 跑真实烟测，除非单独增加 `workflow_dispatch` 且显式传入 `TELEGRAM_SMOKE=1`（当前未启用，防止误触）。

## 验收标准（合并门槛）

1. `npm run test:telegram-smoke` 全部通过  
2. `python3 -m unittest discover integrations/hermes/cursor-gateway -p 'test_*.py'` 通过  
3. GitHub Actions `ci-telegram-smoke` 在 PR/push 上绿  
4. 真实烟测可选；无 smoke chat 时不算 blocker，但文档路径必须可复制执行  

## 实现位置

- Harness：`apps/server/test/helpers/telegramSmokeHarness.ts`
- 场景测试：`apps/server/test/telegram-hermes-smoke.test.ts`
- 真实烟测：`scripts/diagnostics/telegram-real-smoke.mjs`
- Provider 单测：`integrations/hermes/cursor-gateway/test_provider.py`
- Workflow：`.github/workflows/ci-telegram-smoke.yml`
