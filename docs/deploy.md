# Cursor Gateway 部署说明

本服务把网关 API、Web UI、数据库、Telegram Webhook 部署在 VPS 上；Cursor 读写本地文件只发生在 Windows Runner（通过 Cursor SDK local runtime）。

文档中的 `gateway.example.com` 请全部替换成你自己的域名。

## 1. DNS 与 Cloudflare Access

1. 为你的域名添加经 Cloudflare 代理的 `A` 记录，指向 VPS IP。
2. 为 `https://gateway.example.com` 创建 Cloudflare Access 应用。
3. 在 Access 策略中只允许可访问 UI 的邮箱 / GitHub / Google 身份。
4. 可选：在 `.env` 里设置 `ALLOWED_EMAILS`；留空则信任 Access 已放行的身份。
5. 防止直连源站绕过：使用 Cloudflare Tunnel，或防火墙只放行 Cloudflare IP 到 80/443。

不要把“不起眼的子域名”当成安全边界。

## 2. VPS 安装

### 推荐：傻瓜式网页向导

在仓库根目录启动宿主机向导（默认只监听本机），浏览器完成鉴权后一点「初始化」即可生成全部密钥并写入 `.env`（`0600`）：

```bash
cd /opt/cursor-gateway
./scripts/foolproof-deploy/start.sh
# 打开 http://127.0.0.1:19090/ 或经 Access 保护的 https://gateway.example.com/deploy/
```

说明见 [`foolproof-deploy.md`](foolproof-deploy.md)。然后：

```bash
cd /opt/cursor-gateway/infra
docker compose up -d --build
docker compose logs -f app
```

（向导里也可直接点「同步并重启 compose」。）

### 手工编辑 `.env`

```bash
cd /opt/cursor-gateway
cp .env.example .env
nano .env
```

VPS 必填示例：

```bash
PUBLIC_ORIGIN=https://gateway.example.com
JWT_SECRET=<至少 32 字节随机串>
RUNNER_SHARED_SECRET=<另一段至少 32 字节随机串，且与 JWT_SECRET 不同>
RUNNER_MAX_CONCURRENT_JOBS=3
E2EE_REQUIRED_FOR_WEB=false
E2EE_EXTENSION_ORIGINS=chrome-extension://oicmfijjdbjkjhnljcjhnojpeiobhefe
POSTGRES_USER=cursor_gateway
POSTGRES_PASSWORD=<数据库密码>
POSTGRES_DB=cursor_gateway
DATABASE_URL=postgres://cursor_gateway:<数据库密码>@postgres:5432/cursor_gateway
REDIS_URL=redis://redis:6379
ALLOWED_EMAILS=you@example.com
TELEGRAM_BOT_TOKEN=<可选>
TELEGRAM_WEBHOOK_SECRET=<随机 webhook 路径密钥>
TELEGRAM_ALLOWED_USER_IDS=<Telegram 数字用户 ID，逗号分隔>
```

已登录用户可从网页下载预构建扩展：`GET /api/extension/download`（`cursor-gateway-secure.zip`）。未登录不可下载。
启动：

```bash
cd /opt/cursor-gateway/infra
docker compose up -d --build
docker compose logs -f app
```

服务启动时会自动跑数据库迁移。

## 3. Telegram（可选）

用 BotFather 创建机器人，填入 `TELEGRAM_BOT_TOKEN`，并把允许的用户 ID 写入 `TELEGRAM_ALLOWED_USER_IDS`。

设置 webhook：

```bash
curl "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -d "url=https://gateway.example.com/telegram/webhook/${TELEGRAM_WEBHOOK_SECRET}"
```

支持命令：

```text
/start
/model [modelId]
/workspace [workspaceId]
/chat <prompt>
/status [runId]
/cancel <runId>
```

## 4. Windows Runner

在 Windows 上安装 Node.js 22，克隆本仓库后配置 Runner 环境变量：

```powershell
$env:GATEWAY_URL = "https://gateway.example.com"
$env:CF_ACCESS_CLIENT_ID = "<Cloudflare Access service token client ID>"
$env:CF_ACCESS_CLIENT_SECRET = "<Cloudflare Access service token client secret>"
$env:RUNNER_ID = "windows-main"
$env:RUNNER_SHARED_SECRET = "<与 VPS 相同的 RUNNER_SHARED_SECRET>"
$env:RUNNER_MAX_CONCURRENT_JOBS = "3"
$env:RUNNER_E2EE_ENABLED = "true"
$env:RUNNER_LEGACY_ENABLED = "false"
$env:RUNNER_WORKSPACES = "C:\Workspaces\project1;D:\Workspaces\project2"
$env:CURSOR_API_KEY = "<你的 Cursor API Key>"
$env:DEFAULT_MODEL = "auto"
npm install
npm run build -w @cursor-gateway/shared
npm run build -w @cursor-gateway/e2ee
npm run build -w @cursor-gateway/windows-runner
npm run start -w @cursor-gateway/windows-runner
```

生产环境请用非管理员 Windows 账户运行，并只给该账户允许目录的 NTFS 权限——这是文件访问的硬边界。

`RUNNER_MAX_CONCURRENT_JOBS` 在 VPS 与 Windows Runner 上保持相同正整数（默认 `3`）。不同会话可并行，同一会话内任务仍串行领取。

更简单的启动方式见 `docs/windows-runner.md` 与 `docs/快速开始.md`。

Runner 启动后按 [e2ee.md](e2ee.md) 完成扩展签名分发、双向离线配对和密钥备份。验证 E2EE 后再将 VPS 的 `E2EE_REQUIRED_FOR_WEB` 改为 `true`；不要先开启强制开关。

## 5. 审批与写文件

若写操作需要 Web UI 审批后再被 Runner 领取，在 VPS 设置 `RUNNER_REQUIRE_APPROVAL=true`。

工作区写入有三层控制：

1. Runner 只注册 `RUNNER_WORKSPACES`。
2. Server 拒绝未知 workspace ID。
3. Windows Runner 以受限用户运行，文件系统权限仅限允许根目录。

## 6. 端到端自检

1. 用已放行的 Cloudflare Access 身份打开 `https://gateway.example.com` 完成登录。
2. 打开签名扩展，授权同一 HTTPS origin，并确认 `/api/me` 显示正确身份。
3. 启动并离线配对 Windows Runner，核对两个 fingerprint。
4. 从扩展对测试工作区排队一个只读提示。
5. 确认状态从 `queued` → `running` → `finished`。
6. 在扩展添加一条 E2EE Memory，再排队一次，确认回答用到了 Memory。
7. 用允许的 Telegram 用户发送 `/start` 与 `/chat hello`。

## 7. 备份与日志

定期备份 Postgres：

```bash
docker compose exec postgres pg_dump -U cursor_gateway cursor_gateway > cursor_gateway.sql
```

E2EE 新数据在 dump 中仍是密文，但旧明文、WAL 和迁移前备份不会自动变安全。完成扩展中的旧数据 archive/scrub 后，按保留策略销毁旧 dump、快照与日志。

查看审计日志：

```sql
select created_at, event_type, actor_user_id, details
from audit_logs
order by created_at desc
limit 100;
```
