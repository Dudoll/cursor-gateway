# Magic-link 配对邮件投递（piallera.com）

Secure Web / CS 配对依赖 Runner 向运维邮箱投递 **一次性 magic-link**。  
Cloudflare **Email Routing 只能收信、不能主动发信**，因此发信必须走第三方 SMTP/API（Resend / SES / Mailgun / SendGrid 等）。

本仓库实现：

| `PAIRING_MAIL_MODE` | 行为 |
| --- | --- |
| `log`（默认） | 写入 `~/.cursor-gateway/pairing-mail.log`，便于干跑验收；**不是**真实投递。 |
| `smtp` | 通用 SMTP（`SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS` 或 `SMTP_URL`）。 |
| `api` | HTTP API（`MAIL_API_PROVIDER=resend\|mailgun\|sendgrid` + `MAIL_API_KEY`）。 |

发件人默认：`Piallera Secure <no-reply@piallera.com>`。

## 推荐选型：Resend（最快一次做对）

理由：免费额度够用、域名验证流程短、同时提供 **SMTP** 与 **HTTP API**；代码侧两种模式都已接好。  
Amazon SES 送达率也好，但账号/沙箱/区域配置更重；Mailgun/SendGrid 同理可用 SMTP 或 `api`。

### 1. 注册与 API Key（人工）

1. 打开 [https://resend.com](https://resend.com) 注册。
2. **Domains → Add Domain** → 填 `piallera.com`。
3. 按控制台提示复制 **SPF / DKIM（通常是若干 CNAME）**；可选 MX（若只用发信、不收信，Resend 可能不要求 MX）。
4. **API Keys → Create**，权限选 Sending access，保存 `re_...`（只显示一次）。
5. 在 Runner 机器写入（**勿提交 git**）：

**方式 A — HTTP API（推荐）**

```bash
PAIRING_MAIL_MODE=api
MAIL_API_PROVIDER=resend
MAIL_API_KEY=re_xxxxxxxx
PAIRING_MAIL_FROM=no-reply@piallera.com
PAIRING_MAIL_FROM_NAME=Piallera Secure
PAIRING_MAIL_TO=you@example.com
```

**方式 B — SMTP**

```bash
PAIRING_MAIL_MODE=smtp
SMTP_HOST=smtp.resend.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=resend
SMTP_PASS=re_xxxxxxxx
# 或：SMTP_URL=smtps://resend:re_xxxxxxxx@smtp.resend.com:465
PAIRING_MAIL_FROM=no-reply@piallera.com
PAIRING_MAIL_FROM_NAME=Piallera Secure
PAIRING_MAIL_TO=you@example.com
```

可选：`PAIRING_MAIL_ALSO_LOG=true` 在真实投递时仍追加一份到 log（便于对照；文件权限保持 `0600`）。

### 2. 在 Cloudflare（piallera.com）添加 DNS（人工；值以 Resend 控制台为准）

Zone `piallera.com` 当前通常**没有** SPF/DKIM/DMARC（仅可能有 `ai` 等 A 记录）。请按 Resend「Domain」页添加，**不要猜测 DKIM 值**。

模板（名称/类型常见形态；**content 必须以你的 Resend Domain 页为准，勿照抄**）：

| 类型 | 名称（常见） | 内容（形态） | Proxy |
| --- | --- | --- | --- |
| MX | `send`（或控制台指定的发信子域） | Resend 给出的 MX 主机名 + priority | DNS only |
| TXT | `send`（SPF，常在发信子域） | `v=spf1 include:… ~all`（Resend 原文） | DNS only |
| TXT 或 CNAME | `resend._domainkey` | DKIM 公钥或 CNAME 目标（Resend 原文） | DNS only |
| TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:you@example.com` | DNS only |

说明：

- 所有邮件相关记录保持 **DNS only（灰云）**，不要橙云代理。
- 根域若已有 SPF TXT，合并 `include:`，不要新建第二条 `v=spf1`。
- Resend 常把 SPF/MX 放在 `send` 子域而非 apex——以控制台表格为准。
- **Amazon SES** 示例：apex SPF `v=spf1 include:amazonses.com ~all`；DKIM 为 SES 控制台 3 条 CNAME。
- **SendGrid**：SPF `include:sendgrid.net`；DKIM 为 SendGrid CNAME。
- **Mailgun**：按区域 `include:mailgun.org` 等。

验证：Resend 控制台点 **Verify**；或 [dns.email](https://dns.email/)；或：

```bash
dig MX send.piallera.com +short
dig TXT send.piallera.com +short
dig TXT resend._domainkey.piallera.com +short
dig TXT _dmarc.piallera.com +short
```

### 3. 发送测试

在 Runner 目录（已配置 `.env`）：

```bash
# 干跑模板（不需 API key）
PAIRING_MAIL_MODE=log bash scripts/e2ee/send-test-pairing-mail.sh you@example.com

# 真实投递（凭据就绪后）
PAIRING_MAIL_MODE=api bash scripts/e2ee/send-test-pairing-mail.sh you@example.com
# 或
PAIRING_MAIL_MODE=smtp bash scripts/e2ee/send-test-pairing-mail.sh you@example.com
```

成功后检查收件箱（含垃圾箱）。配对验收仍可用 `PAIRING_MAIL_MODE=log` + `scripts/e2ee/read-pairing-mail.sh`。

## Cloudflare Email Routing

Email Routing（`mx` + 转发）**不能**替代发信。若以后要收 `support@piallera.com`，可另开 Routing；与 magic-link 出站无关。

## 环境变量一览（Runner）

| 变量 | 说明 |
| --- | --- |
| `PAIRING_MAIL_MODE` | `log` / `smtp` / `api` |
| `PAIRING_MAIL_TO` | 收件人；亦作 offer `emailHint` |
| `PAIRING_MAIL_FROM` | 默认 `no-reply@piallera.com`（须在已验证域名下） |
| `PAIRING_MAIL_FROM_NAME` | 默认 `Piallera Secure` |
| `PAIRING_MAIL_LOG_FILE` | log 路径 |
| `PAIRING_MAIL_ALSO_LOG` | 真实发送时是否镜像到 log |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | SMTP |
| `SMTP_SECURE` | `true` 用于 465 隐式 TLS |
| `SMTP_REQUIRE_TLS` | 默认 `true`（587 STARTTLS） |
| `SMTP_URL` | `smtps://user:pass@host:465` 备选 |
| `MAIL_API_PROVIDER` | `resend`（默认）/ `mailgun` / `sendgrid` |
| `MAIL_API_KEY` | API 密钥 |
| `MAILGUN_BASE_URL` | Mailgun 用，如 `https://api.mailgun.net/v3/mg.piallera.com` |

## 安全

- API key / SMTP 密码只放 Runner `.env` 或密钥库，**禁止**进 git、截图、聊天粘贴。
- magic-link 出现在邮件与（可选）本地 log；log 文件目录权限 `0700`、文件 `0600`。
- 不要把 `E2EE_REQUIRED_FOR_WEB` 在邮件通路未验收前打开。
