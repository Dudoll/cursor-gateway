# Hermes HA — vps-dmit ↔ vps-band

完整栈备区：自动接管、手动确认回切（含 DNS）、Hermes 工作树常驻 iCloud、密钥 age 加密共享。

## Canonical source

此目录 `infra/hermes-ha/` 是唯一可发布源码。`$HOME/hermes-ha` 只是
`install-local.sh` 生成的安装副本，不是开发工作树，也不得反向同步回 Git。
发布必须来自干净的 merge commit 或带
`HERMES_HA_SOURCE_COMMIT`/`HERMES_HA_SOURCE_SHA256` 的已校验 release
artifact；安装器会拒绝 dirty Git 源和无法归属到 commit 的裸目录，并在安装
目录写入不含秘密的 `.install-source.json`。

## 约定（已拍板）

| 项 | 值 |
|----|----|
| 接管范围 | 完整栈（Hermes + Cursor Gateway） |
| 触发 | 自动接管；回切需 `hermes-ha failback --confirm`（含 DNS） |
| Hermes 状态 | **混合**：`~/.hermes` 仍为本机目录；热状态目录/文件 symlink → `iCloudDrive/hermes-ha/hermes/`（rclone FUSE 无法在挂载内建 symlink） |
| 密钥 | **B**：`secrets/*.age` 进 iCloud；本机 `age` 解密到 `~/.config/hermes-ha/runtime/`，再 symlink 进 Hermes home |
| Gateway PG | 仍 5min dump → `checkpoints/gateway/`（不进 iCloud 跑库） |

## 六槽执行拓扑

实际 Cursor 执行器是本地 `runnerId=wsl-e2ee`，不是 VPS 上的
`hermes-cursor-runner*`。单进程使用 6 个共享 worker 槽；每槽在 E2EE 与
legacy/CSAPI 两条队列之间轮询，空闲队列的额度可被另一条队列借用，但同一
时刻总执行数仍不超过 6；E2EE 另有单许可保护，保持原来最多 1 个加密任务
的安全边界。Gateway 的 CSAPI per-key 阈值也必须为 6。

VPS HA 只管理两个 Hermes messaging gateway 与 checkpoint/report timer。
旧 system-level Hermes Cursor runner 使用过期 secret、持续 401，不能算作
容量；确认 `wsl-e2ee` 心跳和六槽均健康后应停用，避免重复领取或虚假容量。

低成本验收会用 main key 发 6 个请求、telegram2 的独立 key 发第 7 个请求；
只输出状态码、耗时、数据库峰值以及“六个 running 时至少一个 queued”的
布尔证据，不输出 key 或回复：

```bash
python3 ~/hermes-ha/scripts/csapi-capacity-smoke.py --slots 6
```

## Checkpoint 新鲜度

Gateway PG timer 使用固定 `OnCalendar`，一次 dump 失败不会让后续调度消失。
oneshot 设 4 分钟运行上限和 256 MiB 内存上限。独立 watchdog 每分钟检查
manifest、dump 大小及年龄；默认超过 600 秒告警，恢复后发送恢复通知。

## 目录

```text
~/iCloudDrive/hermes-ha/
  leader.json
  hermes/                 # 原 ~/.hermes（无明文 .env/auth.json）
  secrets/
    env.age
    auth.json.age
    age.recipients        # 两机公钥
  checkpoints/gateway/
```

## CLI

```bash
hermes-ha status
hermes-ha migrate ensure-layout|sync|cutover
hermes-ha secrets init-keys|seal|apply
hermes-ha takeover [--force] [--skip-dns]
hermes-ha failback --confirm
hermes-ha dns show|to-band|to-dmit [--dry-run]
hermes-ha evaluate          # band：metrics / timer
hermes-ha checkpoint-watchdog
hermes-ha accept-p0 --node dmit|band
```

## P0 落地顺序

见 [P0_CHECKLIST.md](./P0_CHECKLIST.md)。

## 安装

```bash
# 从仓库根目录的干净 merge commit：
./infra/hermes-ha/scripts/install-local.sh "$PWD/infra/hermes-ha"

# 或从已校验的 release artifact：
HERMES_HA_SOURCE_COMMIT="$merge_commit" \
HERMES_HA_SOURCE_SHA256="$recorded_ha_tree_sha256" \
  ./infra/hermes-ha/scripts/install-local.sh "$PWD/infra/hermes-ha"

export PATH="$HOME/.local/bin:$PATH"
```

## 单活规则

只有 `leader.json` 持有者可启 Hermes gateway / runners，也只有 leader
可以发布共享 checkpoint。必要 checkpoint 恢复失败时，编排器不会启动 writer。
禁止双机同时写 `hermes/`（iCloud 最终一致，双写会坏 SQLite / 出冲突副本）。

## iCloud 体积限制

Apple iCloud 经 rclone 上传单文件约有 **~100–200MB** 上限（413），且大批小文件极慢。

因此默认用 **`shared_dirs` / `shared_files` 白名单** 同步热状态
（sessions/cron/memories/gateway_state/report_* 等）；`local_trees` 中的
`hermes-agent/`、`bin/`、`lsp/`、`skills/` 等留本机。`state.db` 通过独立分片
checkpoint 交接。

| 内容 | 通道 |
|------|------|
| 热状态 / 配置 | iCloud `hermes-ha/hermes/`（白名单） |
| `.env` / `auth.json` | iCloud `secrets/*.age`（age） |
| `state.db` | iCloud `checkpoints/hermes-state/`（分片 gzip） |
| Gateway PG | iCloud `checkpoints/gateway/` |
| `hermes-agent` 源码 | `hermes-ha sync-agent-code <peer>`（SSH，不经 iCloud） |

Cutover 前务必等白名单 sync 完成；勿在全速 `profiles/**` 同步中途 cutover。

## 测试与验收

```bash
# 无外网、无真实 systemd/DNS 副作用的自动化门禁
./scripts/test-p0.sh

# 部署后只读验收；会输出逐项 JSON 证据
hermes-ha accept-p0 --node dmit
hermes-ha accept-p0 --node band
```

自动化门禁覆盖领导权抢占、非 leader writer 拒绝、takeover/failback 顺序、
checkpoint 原子发布与逐字节恢复、DNS mock、age runtime 权限、hybrid 链接以及
vps-metrics hook。现场验收不会启停服务、切换 DNS 或修改 leader。
