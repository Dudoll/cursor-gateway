# CS → Secure → CS 设备授权与本页 E2EE（`cg-e2ee/1`）

目标：在 **CS Web**（`apps/web`，如 `https://cs.joelzt.org`）内完成本地设备密钥 + 加密聊天；**私钥永不离开 CS origin**。身份与 Runner 信任通过跳转 **Secure Web** 完成 magic-link 配对后，由 Runner 签发**单次短时**授权包，经 **URL fragment** 返回 CS。

Gateway 只中继密文与公开元数据；不持有设备私钥，也不持久化授权包中的敏感秘密（grant 经 Secure 轮询取回后写入 fragment，consume 后作废）。

## 用户体验（四步）

1. **CS 生成本地不可导出设备密钥**（IndexedDB + WebCrypto，`non-extractable`）。  
2. 未配对时点击「授权本浏览器」→ 跳转 Secure，query 仅带公钥 fingerprint、`challenge`、`state`、`return_origin`、`auth_id`（无私钥）。  
3. Secure 完成（或复用）magic-link 配对后，向 Gateway 标记 `pending_runner`；Runner 认领、登记 CS 公钥、签发授权；Secure 轮询到 grant 后 `location` 回 CS：`#cs_auth=<base64url JSON>`。  
4. CS 校验 Runner 签名与绑定字段 → 钉住 Runner 公钥 → `POST .../consume`（防重放）→ 在 CS 内用 `cg-e2ee/1` 加密聊天；**右上角**出现「本次聊天已加密」徽章（可展开见 `runId` / `content_mode`；徽章本身不是密码学证明）。

`E2EE_REQUIRED_FOR_WEB` **保持 `false`**，直到本流程在生产验收通过。未授权时 CS 仍可明文聊天（顶栏仅安静的「启用加密」，无大块恐吓提示）；开启策略后强制先走本页授权。

## 协议要点

| 项 | 说明 |
| --- | --- |
| `authKind` | `cs-web-device-auth/1` |
| Intent | CS → `POST /api/e2ee/v1/cs-auth/intent`（绑定用户会话、returnOrigin、设备公钥） |
| Request | Secure（已配对）→ `POST /api/e2ee/v1/cs-auth/:authId/request` |
| Claim / Grant | Runner → `/api/runner/e2ee/v1/cs-auth/claim` + `.../grant` |
| Consume | CS 本地验签成功后 → `POST /api/e2ee/v1/cs-auth/:authId/consume`（一次性） |
| 返回通道 | **仅 URL fragment**；私钥不跨域；challenge/state 防 CSRF/重放 |

状态机：`intent_ready` → `pending_runner` → `granted` \| `rejected` → `consumed` \| `expired`。

## 安全一致性（相对 Secure Web）

| 面 | 与 Secure 一致 | 差距 / 注意 |
| --- | --- | --- |
| 数据面 | 同 `cg-e2ee/1`（HPKE 会话根、AEAD、签名、链 digest）；Gateway 盲 | CS 与 Secure 使用**不同** IndexedDB（设备身份独立） |
| 私钥 | 不可导出、不上传 | CS 授权依赖 Secure 已与 Runner 配对（信任桥） |
| 授权 | 短 TTL、绑定 origin/fingerprint/challenge、Runner 签名、consume 防重放 | Grant 在 Gateway DB 短暂可见（公开密钥描述符 + 签名）；真正秘密仍是 Runner 私钥 |
| 身份 | Cloudflare Access cookie（同用户） | CS intent 与 Secure request 必须同一 Access 用户 |

## 环境变量

### Gateway（VPS `.env`）

| 变量 | 说明 |
| --- | --- |
| `WEB_E2EE_RETURN_ORIGINS` | 允许的 CS return origin，逗号分隔。例：`https://cs.joelzt.org`。空=不强制（仅开发）。 |
| `E2EE_CS_AUTH_TTL_SECONDS` | Intent/授权流程 TTL，默认 `300`。 |
| `SECURE_CLIENT_ORIGIN` | Secure PWA origin（既有）。 |
| `CF_ACCESS_TEAM_DOMAIN` | 可选。Access 团队域，供「退出加密」后提供 Access logout 链接。 |
| `E2EE_REQUIRED_FOR_WEB` | **保持 `false`** 直至验收。 |

### Runner

| 变量 | 说明 |
| --- | --- |
| `WEB_E2EE_RETURN_ORIGINS` | 与 Gateway 对齐；拒绝非白名单 `returnOrigin`。 |
| `E2EE_CS_AUTH_GRANT_TTL_SECONDS` | Grant 签名过期上限（秒），默认 `120`；并与 intent 过期取较早者。 |

## 部署与托管差距

- **协议实现不依赖 Cloudflare Pages token**：本地/CI `npm run build -w @cursor-gateway/secure-web` + `apps/web` 即可。  
- **当前生产回退**：Secure 静态同步到 VPS `/var/www/cursor-gateway-secure`（见 `docs/secure-web-e2ee.md` + `infra/nginx-secure.joelzt.org.conf`）。  
- **理想迁移**：Cloudflare Pages 部署 `apps/secure-web/dist`；缺 Pages 权限时继续 VPS 静态，不阻塞本协议上线。  
- 部署 Gateway 时 **保留 VPS `.env` 密钥**，仅追加/更新 `WEB_E2EE_RETURN_ORIGINS` 等项后 `git pull` + rebuild。

## 干跑 / 测试

```bash
npm run test -w @cursor-gateway/e2ee          # 含 cs-auth grant / redirect
npm run test -w @cursor-gateway/secure-web
npm run test -w @cursor-gateway/web           # 含 e2eeStatusUi 文案/证据标签
npm run typecheck
```

手工：CS「启用加密」→ Secure 配对（`PAIRING_MAIL_MODE=log` + `scripts/e2ee/read-pairing-mail.sh`）→ 自动回 CS fragment → 右上角出现「本次聊天已加密」→ 加密发送。反复测配对时：点开「本次聊天已加密」徽章，在展开面板里点「退出加密并重新配对」（确认后清 IndexedDB / 待授权状态，可选退出 CF Access），徽章回到未授权后再点「启用加密」即可从头走一遍。

## 如何验证真加密

UI 右上角「本次聊天已加密」徽章**只是状态提示**，不是密码学证明。点开徽章可看到 `content_mode` / 最近 `runId`（发送成功后），同样不能单独当作证明。请按下面三步自证。

### 1. 浏览器 Network：路径与 body 无明文

1. 打开 DevTools → Network，过滤 `e2ee`。  
2. 发送一条加密消息后，应看到 `POST /api/e2ee/v1/runs`（**不是**明文 `POST /api/runs`）。  
3. 请求 JSON 含 `request.payload.ciphertext` 等信封字段；**不应**出现明文 `prompt` 字符串。  
4. 对比：未启用加密时走 `/api/runs`，body 里有明文 `prompt`。

### 2. VPS 审计日志 + DB

加密 run 创建成功时 Gateway 写审计事件 `e2ee.run.created`（details 含 `runId`、`ciphertextBytes` 等，**无明文**）。

```sql
-- 审计：最近 E2EE run
select created_at, event_type, details
from audit_logs
where event_type = 'e2ee.run.created'
order by created_at desc
limit 20;

-- DB：content_mode=e2ee-v1，prompt/response 必须为 NULL
select id, content_mode, protocol_version, prompt, response,
       (request_envelope is not null) as has_envelope,
       length(request_envelope::text) as envelope_chars
from runs
where content_mode = 'e2ee-v1'
order by created_at desc
limit 20;
```

期望：`content_mode = 'e2ee-v1'`，`prompt` / `response` 为 `NULL`，`request_envelope` 有密文信封。明文模式 `content_mode = 'plaintext'` 且 `prompt` 非空。

在 VPS 上也可：

```bash
docker compose exec postgres psql -U cursor_gateway -d cursor_gateway -c \
  "select id, content_mode, prompt is null as prompt_null, response is null as response_null from runs where content_mode='e2ee-v1' order by created_at desc limit 5;"
```

### 3. 对比明文模式

| 检查项 | 加密（本页已授权） | 明文（未启用加密） |
| --- | --- | --- |
| UI | 右上角「本次聊天已加密」；徽章可展开见 runId | 无加密徽章；顶栏「启用加密」可选 |
| Network | `POST /api/e2ee/v1/runs`，body 为密文信封 | `POST /api/runs`，body 含明文 prompt |
| DB `runs.content_mode` | `e2ee-v1` | `plaintext` |
| DB `prompt` / `response` | `NULL` | 有明文 |
| 审计 | `e2ee.run.created` | 普通 run 审计（非 e2ee 事件） |

若 Network 仍是 `/api/runs` 或 DB 里 `prompt` 非空，则**不是**本页 E2EE，即便某处文案写了「加密」。

## 明确不做（本 MVP）

- 把 CS 私钥导出到 Secure 或其它域。  
- 经 query/body 回传 grant（必须 fragment）。  
- 因缺少 CF Pages token 而跳过协议实现。  
- 默认打开 `E2EE_REQUIRED_FOR_WEB`。
