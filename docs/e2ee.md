# 强端到端加密（`cg-e2ee/1`）

## 保证范围

安全端点是签名的 `Cursor Gateway Secure` 浏览器扩展与 Windows Runner。Prompt、会话历史、Memory、进度、结果和详细错误在离开端点前加密；Cloudflare、VPS、PostgreSQL、备份和反向代理只处理中继密文。

Runner 会在 Windows 本地解密，然后调用 Cursor SDK。Cursor 模型服务仍会收到明文，因此本功能是“Gateway-blind E2EE”，不是模型提供商不可见的加密推理。

VPS 仍可看到登录身份、时间、状态、模型、workspace ID、目标 Runner 和密文长度，也能丢弃、延迟或重放网络包。签名、消息链、持久化重放账本和 AEAD 会阻止被篡改或重复的内容被执行，但不能保证可用性。

以下入口不属于 E2EE：

- Telegram
- Reports
- Automation
- 在 VPS 上执行的 Hermes

它们不能加入 E2EE 会话，也不应显示为“安全会话”。

## 部署顺序

1. 部署数据库迁移和 Server，但暂时保留 `E2EE_REQUIRED_FOR_WEB=false`。
2. 在 Windows 部署新版 Runner，设置：

   ```text
   RUNNER_E2EE_ENABLED=true
   RUNNER_LEGACY_ENABLED=false
   ```

3. 生成 Runner 离线配对 bundle：

   ```powershell
   npm run pair:runner -w @cursor-gateway/windows-runner
   ```

4. 构建 `apps/browser-extension`，通过受信任签名渠道发布。开发时可在浏览器扩展管理页加载 `apps/browser-extension/dist`；未签名的开发包不应作为生产信任根。
5. 将扩展固定 ID 的 origin 写入 VPS：

   ```text
   E2EE_EXTENSION_ORIGINS=chrome-extension://<extension-id>
   ```

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
| `E2EE_REQUIRED_FOR_WEB` | `false` | 置 `true` 后，普通网页的明文 Web chat / Memory 写入被拒绝，只接受签名扩展的 E2EE 会话。分发扩展前保持 `false`。 |
| `E2EE_EXTENSION_ORIGINS` | 空 | 逗号分隔的可信扩展 origin 允许表，例如 `chrome-extension://<extension-id>`。 |
| `RUNNER_SHARED_SECRET` | 必填（≥32） | 只用于 Runner 接口访问控制，**不**参与内容密钥派生。 |

Runner（Windows）：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `RUNNER_E2EE_ENABLED` | `true` | 启用 E2EE claim / 解密 / 加密回传。 |
| `RUNNER_LEGACY_ENABLED` | `false` | 是否继续领取旧明文任务；全量切换 E2EE 后置 `false`。 |
| `RUNNER_ID` | `windows-main` | Runner 标识；主密钥轮换时使用新的 `RUNNER_ID` 作为新安全 epoch。 |
| `RUNNER_WORKSPACES` | 必填 | 本地 workspace 白名单，`;` 分隔的绝对路径；心跳只上报派生的 workspace ID 与可写策略，不上报绝对路径。 |
| `RUNNER_E2EE_STATE_FILE` | `%USERPROFILE%\.cursor-gateway\runner-e2ee-state.dat` | DPAPI 保护的密钥 / 配对 / 重放状态文件路径。 |
| `RUNNER_E2EE_ALLOW_INSECURE_DEV_STORAGE` | `false` | 仅限一次性非 Windows 开发测试；生产必须为 `false`。 |

## 密钥

- Runner 的 HPKE 与签名私钥、配对客户端、Cursor Agent 映射和重放状态保存在 `%USERPROFILE%\.cursor-gateway\runner-e2ee-state.dat`，由当前 Windows 用户的 DPAPI 保护。
- 扩展的不可导出 `CryptoKey` 保存在扩展 origin 的 IndexedDB。
- 清除浏览器扩展数据会导致历史不可解密。配对完成后应立即用至少 12 字符的高强度口令导出加密备份。
- VPS 上的 `RUNNER_SHARED_SECRET` 只负责接口访问控制，不能派生内容密钥。

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
