# 跨浏览器 Secure Web E2EE（`cg-e2ee/1`）

可信客户端是独立部署的 **PWA**（`apps/secure-web`），不是 Gateway 同源页面，也不是 Chrome 扩展。Gateway 只中继密文与公开配对元数据；**256-bit magic-link token 永不进入 Gateway**（仅出现在邮件 URL fragment 与 Runner 本地内存）。

数据面协议与扩展相同：`cg-e2ee/1`（HPKE 会话根、AEAD 载荷、客户端/Runner 签名、会话链 digest）。

## 三步 UX

1. **配置 Gateway origin**  
   在 PWA 填入 Gateway 的 HTTPS 源（例如 `https://cs.joelzt.org`）。若与 Gateway 跨域，需先在该 origin 完成 Cloudflare Access 登录（cookie），以便 `credentials: include` 调用 `/api/e2ee/v1/*`。

2. **开始配对 → 打开邮件 magic link**  
   点击「Start pairing」。Runner 认领 `pending_start`、生成 256-bit token，把  
   `{SECURE_ORIGIN}/#pair={pairId}.{token}`  
   写入邮件（生产）或 `~/.cursor-gateway/pairing-mail.log`（`PAIRING_MAIL_MODE=log` 干跑）。**必须在启动配对的同一浏览器**打开链接；fragment 不会发给服务器。手机上请尽量用同一浏览器打开邮件链接；Gmail App 可能导致额外标签，但若从 CS 跳入，回跳上下文已持久化到 Secure origin 存储。

3. **加密聊天**  
   客户端用 token 对 offer transcript 做 HMAC，提交 `complete`；Runner 校验 MAC + 客户端签名后 ack，并把 Runner 公钥 fingerprint 固定到本地 IndexedDB。之后提交/读取 run 与扩展走同一套 E2EE API。

私密 / 无痕模式会拒绝保存：启动时做非导出 `CryptoKey` 持久化自测，失败则阻断（不写密钥）。

## 安全边界

| 可见方 | 能看到 | 看不到 |
| --- | --- | --- |
| Gateway / CF / VPS / DB | 用户身份、时间、状态、模型、workspaceId、密文长度、公开密钥描述符、配对状态机 | magic-link token、会话根、明文 prompt/结果 |
| Runner | 解密后的 prompt（再交给 Cursor SDK） | —（模型侧仍见明文，属 Gateway-blind E2EE） |
| Secure Web PWA | 本机明文与不可导出设备密钥 | 其他设备的私钥 |

- Gateway **不**验证 magic-link；抗替换根在 Runner 持有的 token + transcript MAC。
- `SECURE_CLIENT_ORIGIN`（Server + Runner）限制 `secureOrigin`，防止恶意 origin 发起配对。
- 可选：Runner 配置 `CF_ACCESS_*` 后校验 Access JWT（MVP 未配则跳过，仍依赖 magic-link）。
- 撤销：用户调用 `POST /api/e2ee/v1/devices/:clientId/revoke`；Runner 轮询 pending-revocations 并清本地配对。

**与扩展的关系**：扩展继续支持离线 JSON bundle 双向配对；Secure Web 走邮件 magic-link。二者共享 `packages/e2ee` / `packages/shared` 与 Gateway `/api/e2ee/v1` 数据面。可并存；打开 `E2EE_REQUIRED_FOR_WEB` 前需确保至少一种可信客户端可用。

## 环境变量

### Gateway（VPS）

| 变量 | 说明 |
| --- | --- |
| `SECURE_CLIENT_ORIGIN` | PWA 的 HTTPS origin（CORS + 配对 `secureOrigin` 校验）。空则不强制（仅开发）。 |
| `E2EE_PAIRING_TTL_SECONDS` | 配对 TTL，默认 `900`。 |
| `E2EE_REQUIRED_FOR_WEB` | **保持 `false`**，直到 Secure Web / 扩展已完成生产配对验收。 |
| `E2EE_EXTENSION_ORIGINS` | 扩展 origin；与 Secure Web 无关，可并存。 |

### Runner

| 变量 | 说明 |
| --- | --- |
| `SECURE_CLIENT_ORIGIN` | 与 PWA origin 一致时才认领配对。 |
| `PAIRING_TTL_SECONDS` | offer 过期时间，默认 `900`。 |
| `PAIRING_MAIL_MODE` | `log`（干跑写文件）、`smtp`（Nodemailer）、`api`（Resend HTTP 等）。详见 [pairing-mail.md](./pairing-mail.md)。 |
| `PAIRING_MAIL_TO` | **仅** `send-test-pairing-mail` 测试脚本；真实配对收件人来自 Server `recipientEmail`（CF Access）。 |
| `PAIRING_MAIL_FROM` / `PAIRING_MAIL_FROM_NAME` | 默认 `no-reply@piallera.com` / `Piallera Secure`。 |
| `PAIRING_MAIL_LOG_FILE` | 可选；默认 `~/.cursor-gateway/pairing-mail.log`。 |
| `PAIRING_ALLOWED_EMAILS` | Access JWT 邮箱白名单（启用 JWT 时）。 |
| `SMTP_*` / `SMTP_URL` | `smtp` 模式凭据（Nodemailer）。 |
| `MAIL_API_PROVIDER` / `MAIL_API_KEY` | `api` 模式；默认 provider=`resend`。 |
| `CF_ACCESS_TEAM_DOMAIN` / `CF_ACCESS_AUD` | 可选 JWT 校验。 |

## 独立 Cloudflare 静态部署

PWA **不要**塞进 Gateway Docker 镜像。推荐 Cloudflare Pages / 任意静态托管：

```bash
npm run build -w @cursor-gateway/secure-web
# 产物在 apps/secure-web/dist
npx wrangler pages deploy apps/secure-web/dist --project-name=cursor-gateway-secure
```

当前生产回退（zone token 无 Pages 权限时）：把 `dist/` 同步到 VPS `/var/www/cursor-gateway-secure`，用 `infra/nginx-secure.joelzt.org.conf` + Cloudflare 代理 DNS（`secure.joelzt.org`）。HTTPS 由 Cloudflare 终止。

部署后：

1. 记下 PWA HTTPS origin（例如 `https://secure.joelzt.org` 或 `https://cursor-gateway-secure.pages.dev`）。
2. VPS `.env` 追加 `SECURE_CLIENT_ORIGIN=<该 HTTPS origin>`（**保留**现有密钥与 `E2EE_REQUIRED_FOR_WEB=false`），重建 app。
3. Runner `.env` 同步 `SECURE_CLIENT_ORIGIN`，并设 `PAIRING_MAIL_MODE=log`（干跑）或按 [pairing-mail.md](./pairing-mail.md) 配置 `smtp`/`api` 真实投递。
4. 若 Gateway 前有 Cloudflare Access：在 Access 应用上开启 **Options Preflight Bypass**，否则跨域 PWA 的 CORS 预检会被 Access 拦成 403。
5. 若无 Cloudflare Pages 权限：用上述 nginx 静态站或任意 HTTPS 托管；文档级步骤相同。

CORS：Gateway 仅当 `Origin === SECURE_CLIENT_ORIGIN`（或扩展 allowlist / 同源）时允许带 cookie 的跨域请求。

## 干跑配对（开发）

1. Gateway 与 Runner 已起，且 Runner `PAIRING_MAIL_MODE=log`。
2. 打开生产 PWA（`https://secure.joelzt.org`）或本地 `npm run dev -w @cursor-gateway/secure-web`（默认 `http://127.0.0.1:5174`，API 代理到 `8080`）。  
   若 Gateway 强制校验 `SECURE_CLIENT_ORIGIN`，开发期可临时设为 `http://127.0.0.1:5174`，或用 HTTPS 隧道。
3. Start pairing → 读取 magic link：
   ```bash
   bash scripts/e2ee/read-pairing-mail.sh          # 打印最新 magicLink
   bash scripts/e2ee/read-pairing-mail.sh watch    # 等待下一条
   ```
   默认日志：`~/.cursor-gateway/pairing-mail.log`。把链接粘到**同一浏览器**地址栏。
4. 单元级 crypto 干跑：`npm run test -w @cursor-gateway/e2ee`（含 magic-link MAC）与 `npm run test -w @cursor-gateway/secure-web`。

## 明确不做（MVP）

- 依赖 Cloudflare Email Routing 发信（Routing **只能收信**；出站请用 Resend/SES 等，见 [pairing-mail.md](./pairing-mail.md)）。
- 把 PWA 打进 Gateway 容器。
- 私密模式持久化密钥。
- 跨设备自动同步私钥（仅 Runner 侧未来可用 key-grant 重包会话根）。
