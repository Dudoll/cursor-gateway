# 傻瓜式部署向导（Foolproof Deploy）

用户只需打开网页完成鉴权；随机密钥、UUID、短 ID、E2EE 主密钥材料等由系统自动生成并写入 `0600` 文件。页面**不回显完整私钥**，只显示指纹，并提供**一次性** Runner 配置包下载。

## 为什么是宿主机进程？

部署要写仓库根目录 `.env`、执行 `git` 与 `docker compose`。这些动作放在 app 容器内既不安全也难回滚。向导跑在 **VPS / 本机宿主机**，默认只监听 `127.0.0.1:19090`；需要公网入口时用 Nginx/Caddy 反代到该端口，并挂上 Cloudflare Access。

## 三步使用

### 1. 启动向导

```bash
cd /path/to/cursor-gateway
./scripts/foolproof-deploy/start.sh
```

控制台会打印监听地址，以及 bootstrap token 文件路径（**不会**打印 token 全文）：

```text
~/.cursor-gateway/deploy-bootstrap.token
```

本机打开：

```text
http://127.0.0.1:19090/
```

或经反代（示例）：

```text
https://gateway.example.com/deploy/
```

Nginx 片段示例（仅 loopback 上游；务必继续用 Cloudflare Access 保护）：

```nginx
location /deploy/ {
  proxy_pass http://127.0.0.1:19090/;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
}
```

### 2. 鉴权

- **已接 Cloudflare Access**：用已放行身份打开页面即可（需转发 `Cf-Access-Authenticated-User-Email`）。若配置了 `ALLOWED_EMAILS`，仍会校验邮箱。
- **首次 / 直连**：在主机执行 `cat ~/.cursor-gateway/deploy-bootstrap.token`，把 token 粘贴进网页一次。

### 3. 点「部署 / 初始化」

默认勾选 **Dry-run**。确认无误后取消 Dry-run 再点一次，系统会：

| 自动完成 | 说明 |
| --- | --- |
| `JWT_SECRET` / `RUNNER_SHARED_SECRET` / `POSTGRES_PASSWORD` / webhook 与 automation 密钥 | 写入仓库 `.env`（`0600`） |
| `DATABASE_URL` | 按密码自动拼接 |
| E2EE 主密钥 | 优先写入 `/dev/shm/cursor-gateway/runner-e2ee-master.key` |
| Reality UUID / shortId | 仅在勾选高级选项时生成，进入一次性下载包 |
| 一次性 Runner pack | 下载后即失效；含 runner `.env` 草稿，**不含**页面明文私钥列表 |

然后可选「同步并重启 compose」：`git fetch` + `merge --ff-only` + `docker compose up -d --build`。同步按钮默认先 dry-run；真正执行需确认。

## 环境变量（向导进程）

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `DEPLOY_WIZARD_HOST` | `127.0.0.1` | 绑定地址 |
| `DEPLOY_WIZARD_PORT` | `19090` | 端口 |
| `CURSOR_GATEWAY_HOME` | `~/.cursor-gateway` | bootstrap token 等状态目录 |
| `DEPLOY_TRUST_CF_ACCESS` | 开 | 设为 `0` 则忽略 CF 头，只认 bootstrap |
| `DEPLOY_COOKIE_SECURE` | 关 | 反代 HTTPS 时设 `1` |
| `ALLOWED_EMAILS` | 读现有 `.env` | CF 邮箱允许列表 |

## 安全

- 所有变更 API 需要登录会话 + **CSRF**（`x-csrf-token` 双提交）。
- 未登录访问 `/api/deploy/status`、`initialize`、`sync` 返回 `401`。
- 私钥不进 git、不进公开日志、不进 HTML；API 只返回 SHA-256 指纹前 12 位。
- 下载包内存存放，约 10 分钟过期，下载一次即删。
- 生产请保持向导仅 loopback + Access；用完可停掉进程。

## 仍需人工的边界

1. Cloudflare DNS / Access 策略与证书。
2. Runner 上的 `CURSOR_API_KEY` 与真实工作区路径。
3. **Linux/WSL 主密钥口令解封**：重启后须在 Runner 机运行 `scripts/e2ee/unseal-master-key.sh` 或 `e2ee-up.sh`。网页不能代你保管口令。「开发态自动注入」仅用于无 tmpfs 的一次性试验，有风险。
4. 签名浏览器扩展分发与离线配对指纹人工核对（见 `docs/e2ee.md`）。

## 回滚

1. **配置**：若覆盖前有备份，恢复 `.env` 后 `docker compose up -d`。向导在已有强密钥时默认拒绝覆盖，除非勾选「强制重新生成」。
2. **代码**：`git checkout <previous-sha>`，再 `cd infra && docker compose up -d --build`。
3. **向导本身**：停止 Node 进程即可；不影响已在跑的 gateway 容器。

## API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/deploy/healthz` | 探活（无鉴权） |
| GET | `/api/deploy/status` | 状态 / 指纹（需鉴权） |
| POST | `/api/deploy/login` | bootstrap token → 会话 |
| POST | `/api/deploy/initialize` | 生成密钥（支持 `dryRun`） |
| POST | `/api/deploy/sync` | git + compose（默认 dry-run，`apply:true` 才执行） |
| GET | `/api/deploy/download/:token` | 一次性 pack |

反代保留 `/deploy` 前缀时，静态页与 API 会自动适配。
