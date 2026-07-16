# 强端到端加密（`cg-e2ee/1`）

## 保证范围

安全端点是签名的 `Secure Gateway` 浏览器扩展、跨浏览器 **Secure Web PWA**（`apps/secure-web`，见 [secure-web-e2ee.md](secure-web-e2ee.md)）与 Runner（Windows / Linux / WSL）。Prompt、会话历史、Memory、进度、结果和详细错误在离开端点前加密；Cloudflare、VPS、PostgreSQL、备份和反向代理只处理中继密文。

Runner 会在本机解密，然后调用 Cursor SDK。Cursor 模型服务仍会收到明文，因此本功能是“Gateway-blind E2EE”，不是模型提供商不可见的加密推理。

VPS 仍可看到登录身份、时间、状态、模型、workspace ID、目标 Runner 和密文长度，也能丢弃、延迟或重放网络包。签名、消息链、持久化重放账本和 AEAD 会阻止被篡改或重复的内容被执行，但不能保证可用性。

以下入口不属于 E2EE：

- Telegram
- Reports
- Automation
- 在 VPS 上执行的 Hermes

它们不能加入 E2EE 会话，也不应显示为“安全会话”。

## 部署顺序

1. 部署数据库迁移和 Server，但暂时保留 `E2EE_REQUIRED_FOR_WEB=false`。
2. 在 Runner 宿主机部署新版 Runner，设置：

   ```text
   RUNNER_E2EE_ENABLED=true
   RUNNER_LEGACY_ENABLED=false
   ```

   Linux/WSL 还需配置 `RUNNER_E2EE_MASTER_KEY` 或 `RUNNER_E2EE_MASTER_KEY_FILE`
   （见下文与 `scripts/e2ee/`），不要启用
   `RUNNER_E2EE_ALLOW_INSECURE_DEV_STORAGE`。

3. 生成 Runner 离线配对 bundle：

   ```powershell
   npm run pair:runner -w @cursor-gateway/windows-runner
   ```

4. 构建 `apps/browser-extension`，通过受信任签名渠道发布；或从已登录的 Gateway 下载预构建包（`GET /api/extension/download` → `cursor-gateway-secure.zip`）。开发/旁加载步骤：解压 → `chrome://extensions` → 开发者模式 → 加载已解压的扩展程序。未签名的开发包不应作为长期生产信任根。
5. 将扩展固定 ID 的 origin 写入 VPS（本仓库 `manifest.json` 已内置稳定 `key`，对应 ID 见下文）：

   ```text
   E2EE_EXTENSION_ORIGINS=chrome-extension://oicmfijjdbjkjhnljcjhnojpeiobhefe
   ```

   不要在未备份的情况下清空生产 `.env`；只需追加或更新这一行后重启 app。
6. 在扩展中授权 Gateway HTTPS origin，先打开普通 Gateway 页面完成 Cloudflare Access 登录，再粘贴 Runner bundle 并人工核对两个 fingerprint。
7. 将扩展显示的 client bundle 在 Windows 本地导入：

   ```powershell
   npm run pair:client -w @cursor-gateway/windows-runner -- <client-bundle>
   npm run pair:list -w @cursor-gateway/windows-runner
   ```

8. 完成只读和写批准测试后，在 VPS 设置 `E2EE_REQUIRED_FOR_WEB=true` 并重启 Server。此后普通网页拒绝新的明文 Web chat 和 Memory。

## 环境变量

以下字段与 `apps/server/src/config.ts`、`apps/windows-runner/src/config.ts` 一致（完整示例见 `.env.example` 与 `apps/windows-runner/.env.windows.example`）。

Server（VPS）：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `E2EE_REQUIRED_FOR_WEB` | `true` | 置 `true` 后，普通网页的明文 Web chat / Memory 写入被拒绝（426），CS 登录后自动引导设备授权。回退：改 `false` 并重建。 |
| `E2EE_EXTENSION_ORIGINS` | 空 | 逗号分隔的可信扩展 origin 允许表。本仓库固定旁加载 ID：`chrome-extension://oicmfijjdbjkjhnljcjhnojpeiobhefe`。 |
| `SECURE_CLIENT_ORIGIN` | 空 | 跨浏览器 Secure Web PWA 的 HTTPS origin（CORS + 配对校验）。见 [secure-web-e2ee.md](secure-web-e2ee.md)。 |
| `E2EE_PAIRING_TTL_SECONDS` | `900` | magic-link 配对 TTL。 |
| `RUNNER_SHARED_SECRET` | 必填（≥32） | 只用于 Runner 接口访问控制，**不**参与内容密钥派生。 |

Runner：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `RUNNER_E2EE_ENABLED` | `true` | 启用 E2EE claim / 解密 / 加密回传。 |
| `RUNNER_LEGACY_ENABLED` | `false` | 是否继续领取旧明文任务；全量切换 E2EE 后置 `false`。 |
| `RUNNER_ID` | `local-runner` | Runner 标识；主密钥轮换时使用新的 `RUNNER_ID` 作为新安全 epoch。 |
| `RUNNER_WORKSPACES` | 必填 | 本地 workspace 白名单，`;` 分隔的绝对路径；心跳只上报派生的 workspace ID 与可写策略，不上报绝对路径。 |
| `RUNNER_E2EE_STATE_FILE` | `~/.cursor-gateway/runner-e2ee-state.dat` | 密钥 / 配对 / 重放状态文件路径（Windows 上由 DPAPI 保护）。 |
| `RUNNER_E2EE_MASTER_KEY` / `RUNNER_E2EE_MASTER_KEY_FILE` | 空 | Linux/WSL：用 scrypt→AES-GCM 封存 state；推荐把可用主密钥放在 tmpfs，口令封存见 `scripts/e2ee/`。 |
| `RUNNER_E2EE_ALLOW_INSECURE_DEV_STORAGE` | `false` | 仅限一次性非 Windows 开发测试；生产必须为 `false`。 |

## 密钥

- Runner 的 HPKE 与签名私钥、配对客户端、Cursor Agent 映射和重放状态保存在本地 `runner-e2ee-state.dat`：Windows 用当前用户 DPAPI；Linux/WSL 用 `RUNNER_E2EE_MASTER_KEY(_FILE)`（可用主密钥宜放 `/dev/shm`，持久盘只存口令密封的 `*.enc`）。
- 扩展的不可导出 `CryptoKey` 保存在扩展 origin 的 IndexedDB。
- 清除浏览器扩展数据会导致历史不可解密。配对完成后应立即用至少 12 字符的高强度口令导出加密备份。
- VPS 上的 `RUNNER_SHARED_SECRET` 只负责接口访问控制，不能派生内容密钥。
- 不要把 state 文件、主密钥、`*.enc`、client 私钥或 CF token 提交到仓库 / 复制到 VPS。

撤销浏览器设备：

```powershell
npm run pair:revoke -w @cursor-gateway/windows-runner -- <client-id>
```

Runner 主密钥轮换使用新的 `RUNNER_ID` 和新的 state 文件作为新安全 epoch。停止旧 Runner、生成并离线固定新 bundle，然后只在新 Runner 上创建新会话；保留旧 fingerprint 才能验证旧历史。不要原地覆盖 state 文件。

## 旧明文迁移

扩展的“Archive & scrub legacy plaintext”会：

1. 从旧 API 读取当前用户的明文会话与 Memory；
2. 用扩展 vault key 保存本地加密 archive，并立即做解密校验；
3. 将旧 Memory 复制为 E2EE Memory；
4. 请求 Server 将在线明文字段改为 `scrubbed` 并置空；
5. 自动下载包含 archive 的口令加密备份。

迁移前必须确保没有 queued/running 旧任务。该操作无法撤销 VPS 已经见过的数据，也无法擦除 PostgreSQL WAL、旧 dump、快照、日志或第三方副本；这些数据必须按保留策略单独销毁。

## 运维要求

- Gateway 与 Runner 必须使用 HTTPS；仅 localhost 开发允许 HTTP。
- 不要记录请求/响应 body、密钥、DPAPI 明文、Cursor SDK 原始对象或 Windows 路径。
- E2EE API 响应使用 `Cache-Control: no-store`。
- Runner 心跳只上传 workspace ID、标签和可写策略，不上传绝对路径。
- 每次写操作都需要扩展生成、与 request digest 绑定的第二份签名批准；Runner 最终以本地 NTFS 权限和 workspace 策略为准。
- 扩展发布包必须由浏览器商店或组织控制的签名更新渠道提供。由 VPS 提供的普通网页不能替代可信扩展。
- Gateway 镜像在构建时会打包 `artifacts/cursor-gateway-secure.zip`；已登录用户可通过 `GET /api/extension/download` 下载（未登录返回 401/403）。zip 只含扩展静态资源，不含 pairing 私钥或 Runner 密钥。

## 扩展固定 ID（`manifest.json` 的 `key`）

Chrome 根据 manifest 中的公钥 `key`（SPKI DER 的 base64）派生稳定的扩展 ID。本仓库已写入固定公钥，旁加载后 ID 为：

```text
oicmfijjdbjkjhnljcjhnojpeiobhefe
```

对应：

```text
E2EE_EXTENSION_ORIGINS=chrome-extension://oicmfijjdbjkjhnljcjhnojpeiobhefe
```

若需自行轮换（会改变 ID，并要求更新 VPS `E2EE_EXTENSION_ORIGINS`）：

```bash
openssl genrsa 2048 | openssl pkcs8 -topk8 -nocrypt -out extension.pem
openssl rsa -in extension.pem -pubout -outform DER | openssl base64 -A
# 将输出写入 apps/browser-extension/public/manifest.json 的 "key"
# 私钥 extension.pem 仅用于将来打包 .crx；不要提交到 git，也不要打进 zip
rm -f extension.pem
```

从公钥计算 ID（与 Chrome 一致）：对 SPKI DER 做 SHA-256，取前 16 字节，每半字节映射到 `a`–`p`。

## Web 安装三步（旁加载 zip）

1. 登录 Gateway 后点击「下载扩展」，得到 `cursor-gateway-secure.zip` 并解压。
2. 打开 `chrome://extensions`，启用「开发者模式」。
3. 「加载已解压的扩展程序」→ 选择解压目录。
