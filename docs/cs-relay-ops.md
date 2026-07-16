# 运维：可信 CS 中继（cs-relay）灰度开关

权威规格：[`trusted-cs-relay.md`](./trusted-cs-relay.md)。

## Feature flags（默认关闭历史，账号绑定默认开）

| 变量 | 默认 | 作用 |
|---|---|---|
| `CG_SECURE_ENABLED` | false | 挂载 `/cg/v1/*` |
| `CG_REQUIRE_SECURE` | false | 关闭明文 `/v1/*`（**不要**在灰度未验证前打开） |
| `CS_RELAY_ACCOUNT_BINDING` | true | enroll 签发 `cg-device-cert/2` + 写 `cg_devices` |
| `CS_RELAY_HISTORY_ENABLED` | false | exchange 后 DEK 密文落库 + `/cg/v1/sync` |
| `CS_RELAY_RUNNER_REENCRYPT` | false | CS→Runner taskRoot 再封装（应用层主路径） |
| `CS_RELAY_SEND_JITTER_MS` | 0 | 发送 jitter（仅降低特征） |
| `CS_RELAY_KMS_KEY_ID` | file-master-1 | KMS 引用 id |
| `CG_MASTER_KEY` / `CG_MASTER_KEY_FILE` | — | 主 KEK（生产优先外部 KMS；文件 provider 仅现网验证） |

## 灰度顺序

1. 备份 Postgres；确认 `migrate()` 含 `cg_devices` / `account_keks` / `cs_relay_messages`。
2. 开 `CG_SECURE_ENABLED`（已有生产路径）。
3. 确认 enroll 返回 `cg-device-cert/2`，`cg_devices` 有行。
4. 内部账号开 `CS_RELAY_HISTORY_ENABLED` + 配置 `CG_MASTER_KEY`（≥16 字符）。
5. 验证 `/cg/v1/sync`、两设备同账号、跨账号 403、revoke。
6. 开 `CS_RELAY_RUNNER_REENCRYPT`（远程 Runner mTLS 若无法自动签发则保持 loopback，记录 blocker）。
7. **最后**再考虑 `CG_REQUIRE_SECURE`。

## 回滚

- 关 `CS_RELAY_HISTORY_ENABLED` / `CG_REQUIRE_SECURE` 即可回旧路径。
- `cs_relay_messages` 独立表，不影响 `e2ee-v1`。
- 旧 browser→runner `e2ee-v1` 会话保留只读/导出，不自动迁移。

## 明文隔离验收（运维）

```bash
# DB 不应出现 prompt 明文（用已知 canary 字符串替换）
psql "$DATABASE_URL" -c "select count(*) from cs_relay_messages where content_ciphertext::text ilike '%CANARY%';"
# 日志无 body
# core dump: ulimit -c 0 / 容器 LimitCORE=0
```
