# Magic-link 配对邮件投递（piallera.com）

Secure Web / CS 配对由 Runner 向 **Cloudflare Access 登录用户** 投递一次性 magic-link。  
收件人只来自 Server `claim-start` 响应中的 `recipientEmail`（`e2ee_pairings.user_id` → `app_users.email`），**绝不是** `PAIRING_MAIL_TO`，也不是浏览器自报邮箱。

Cloudflare **Email Routing 只能收信、不能主动发信**，因此出站必须走第三方 SMTP/API（推荐 Resend HTTP API）。Cloudflare Email Service 不在本仓库范围。

| `PAIRING_MAIL_MODE` | 行为 |
| --- | --- |
| `log`（默认；须显式或默认） | 写入 `~/.cursor-gateway/pairing-mail.log`，**不是**真实投递；启动时打印醒目非生产告警。 |
| `smtp` | Nodemailer 通用 SMTP（465 隐式 TLS / 587 STARTTLS）。配置不全则 **启动 fail-fast**，不会降级到 log。 |
| `api` | HTTP API（`MAIL_API_PROVIDER=resend\|mailgun\|sendgrid` + `MAIL_API_KEY`）。配置不全则启动 fail-fast。 |

发件人默认：`Piallera Secure <no-reply@piallera.com>`。

## 推荐选型：Resend HTTP API（生产主通道）

### 1. 注册与 API Key（人工）

1. 打开 [https://resend.com](https://resend.com) 注册。
2. **Domains → Add Domain** → `piallera.com`（只需启用 sending）。
3. 按控制台复制 SPF / DKIM /（如需要）MX；**不要猜测 DKIM 值**。
4. **API Keys → Create**，Sending access，限制域名 `piallera.com`，保存 `re_...`（只显示一次）。
5. 写入 **Runner 实际生效的 gitignored 文件**（WSL E2EE Runner：`apps/windows-runner/.env`；由 `env -i` + 该文件驱动）。**不要**把 key 发到聊天或提交 git。

**生产（有 key 后）**

```bash
PAIRING_MAIL_MODE=api
MAIL_API_PROVIDER=resend
MAIL_API_KEY=re_xxxxxxxx
PAIRING_MAIL_FROM=no-reply@piallera.com
PAIRING_MAIL_FROM_NAME=Piallera Secure
PAIRING_MAIL_ALSO_LOG=false
```

当前无 key 时保持：

```bash
PAIRING_MAIL_MODE=log
```

**SMTP 备选（Nodemailer）**

```bash
PAIRING_MAIL_MODE=smtp
SMTP_HOST=smtp.resend.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=resend
SMTP_PASS=re_xxxxxxxx
PAIRING_MAIL_FROM=no-reply@piallera.com
PAIRING_MAIL_FROM_NAME=Piallera Secure
```

### 2. Cloudflare DNS（人工；值以 Resend Domain 页为准）

全部 **DNS only（灰云）**：

| 类型 | 名称（常见） | 内容（形态） |
| --- | --- | --- |
| MX | `send` | Resend 给出的 MX，priority 10 |
| TXT | `send` | `v=spf1 include:amazonses.com ~all`（以控制台为准） |
| TXT | `resend._domainkey` | Resend 生成的 `p=...` 公钥 |
| TXT | `_dmarc` | `v=DMARC1; p=none;` |

### 3. 发送测试

`PAIRING_MAIL_TO` **仅**用于独立测试脚本，不参与真实配对：

```bash
# 干跑（无需 API key）
PAIRING_MAIL_MODE=log bash scripts/e2ee/send-test-pairing-mail.sh you@example.com

# 真实投递（key 就绪后）
PAIRING_MAIL_MODE=api bash scripts/e2ee/send-test-pairing-mail.sh you@example.com
```

真实配对验收：用 Cloudflare Access 账号在 Secure Web 发起配对，确认收件箱收到完整 magic link，并在同一浏览器完成。

## 重试与幂等

- 同一 `pairId`：邮件发送重试与 offer 发布重试复用同一 token/offer（Runner 持久化 `~/.cursor-gateway/pairing-pending-<runnerId>.json`）。
- 邮件成功后即使 offer 发布失败也 **不会** 重复发信。
- Resend 请求带稳定 `Idempotency-Key: pairing-mail:<pairId>`。

## Cloudflare Email Routing

Email Routing（MX + 转发）**不能**替代发信。与 magic-link 出站无关。

## 环境变量一览（Runner）

| 变量 | 说明 |
| --- | --- |
| `PAIRING_MAIL_MODE` | `log` / `smtp` / `api` |
| `PAIRING_MAIL_TO` | **仅** `send-test-pairing-mail` 脚本；真实配对忽略 |
| `PAIRING_MAIL_FROM` | 默认 `no-reply@piallera.com` |
| `PAIRING_MAIL_FROM_NAME` | 默认 `Piallera Secure` |
| `PAIRING_MAIL_LOG_FILE` | log 路径 |
| `PAIRING_MAIL_ALSO_LOG` | 真实发送时是否镜像到 log |
| `SMTP_*` / `SMTP_URL` | Nodemailer SMTP |
| `MAIL_API_PROVIDER` | `resend`（默认）/ `mailgun` / `sendgrid` |
| `MAIL_API_KEY` | API 密钥 |
| `MAILGUN_BASE_URL` | Mailgun 用 |

## 安全

- 收件人仅来自 Server 已认证 Access 用户；普通日志只打掩码或邮箱指纹，不打完整地址、magic link、Authorization、邮件正文。
- API key / SMTP 密码只放 Runner gitignored `.env`，禁止进镜像（见根 `.dockerignore`）、git、聊天。
- 不要把 `E2EE_REQUIRED_FOR_WEB` 在邮件通路未验收前打开。
