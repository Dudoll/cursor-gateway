# Cursor Gateway

受控网关：在 VPS 上提供 Web / Telegram 入口，在 Windows 本机通过 Runner 执行 Cursor 本地 Agent。

> 仓库内**不含**真实 token、密码、Cookie、邮箱白名单。所有密钥只放在本地 `.env`（已被 `.gitignore` 忽略）。

## 组件

- `apps/server`：VPS API、Cloudflare Access 鉴权、Telegram、Runner 队列、审计、Memory
- `apps/web`：受保护的 React 控制台
- `apps/windows-runner`：仅出站的 Windows Worker，在白名单工作区跑 Cursor SDK
- `packages/shared`：共享类型与 schema
- `infra`：Docker Compose 与反代示例

## 最快上手

请直接看：**[docs/快速开始.md](docs/快速开始.md)**（中文、按步骤填空即可）。

进阶说明：

- [docs/deploy.md](docs/deploy.md) — VPS / Cloudflare / Telegram
- [docs/windows-runner.md](docs/windows-runner.md) — Windows Runner 与守护进程
- [infra/reverse-proxy.md](infra/reverse-proxy.md) — 接到已有 Nginx / Caddy

## 本地开发命令

```bash
npm install
npm run build
npm run dev:server
npm run dev:web
npm run dev:runner
```

## 安全提醒

1. 复制 `.env.example` → `.env`，再填真实值；**永远不要提交 `.env`**。
2. Windows Runner 的 `apps/windows-runner/.env` 同样不要提交。
3. `RUNNER_SHARED_SECRET` 必须在 VPS 与 Windows 上一致，且足够长（≥32）。
4. 用 Cloudflare Access（或等价身份层）保护 Web UI；Runner 接口用共享密钥鉴权。
