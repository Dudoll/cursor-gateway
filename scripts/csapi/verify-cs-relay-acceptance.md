# cs-relay 验收清单（自动化 + 手工）

扩展现有 `verify-cg-mitm.ts`（A1–A6 / B1–B4）后，按 [`docs/trusted-cs-relay.md`](../../docs/trusted-cs-relay.md) §13 执行：

## 自动化（CI / 本地）

```bash
npm run test -w @cursor-gateway/e2ee
npm run test -w @cursor-gateway/server
# 有 Postgres 时：
TEST_DATABASE_URL=postgres://... npm run test -w @cursor-gateway/server -- test/cs-relay-db.test.ts
tsx scripts/csapi/verify-cg-mitm.ts
```

## 手工 / 抓包

| ID | 检查 |
|----|------|
| A1 | mitmproxy 下 exchange/sync 仅见 A256GCM 密文 |
| M1–M7 | 2–3 设备同账号；跨账号 403；revoke；离线 since；并发 conflict |
| C1–C2 | DB/log 无 prompt；core dump 关闭 |
| R2 | Runner 仅当前任务上下文（`truncateHistoryForRunner`） |
| D1 | 伪根/伪签名安装 fail-closed |

## 外部 blocker 记录

- 远程 Runner **mTLS 自动签发**：若环境无 CA 自动化，应用层 envelope 主路径仍可用；mTLS 为纵深。
- 商店扩展签名：见 `docs/signed-release.md`。
