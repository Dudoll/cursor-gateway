# P0 清单 — 可验证的 Hermes 单活冷备

> 状态更新：2026-07-20。代码门禁与现场门禁分开记录；没有命令输出证据的项目
> 不标记为完成。

## P0 最终目标

1. `vps-dmit` 为唯一 PRIMARY writer，`vps-band` 为可恢复的冷备。
2. 共享热状态采用 iCloud hybrid 布局；明文 secret 和 `state.db` 不写入共享树。
3. state.db 与 Gateway PG checkpoint 可校验、失败不覆盖上一可用版本。
4. 非 leader 不能启 writer 或发布 checkpoint。
5. takeover/failback 的关键路径可在无真实 DNS/服务副作用下自动测试。
6. 部署状态可由只读命令重复验收并输出 JSON 证据。

## 阶段、测试与验收标准

| 阶段 | 目标 | 自动测试 | 严格通过条件 |
|------|------|----------|--------------|
| A 配置/领导权 | 配置缺失显式失败；禁止无 force 抢占；非 leader 禁止 writer | `test_common.py`, `test_leader.py`, `test_orchestrator.py` | 所有副作用前拒绝错误角色；epoch 单调递增 |
| B checkpoint | leader-only、原子 manifest、checksum/size、PG retention | `test_state_checkpoint.py`, `test_gateway_checkpoint.py` | round-trip 字节一致；损坏拒绝；失败保留旧 manifest；空 PG dump 不发布 |
| C 交接编排 | 必要恢复失败不启栈；failback 先停写和双 checkpoint，再转移 leader | `test_orchestrator.py` | subprocess 调用顺序精确匹配；任一恢复异常时 `start_stack` 未调用 |
| D hybrid/secrets/DNS | 仅白名单共享；secret 0600；DNS create/update/noop 可预测 | `test_migrate.py`, `test_secrets.py`, `test_dns_cloudflare.py` | 测试只使用临时目录和 mock，不读取真实 token、不访问外网 |
| E metrics | hook 只发 evaluate 请求，streak 仅由 orchestrator 保存 | `test_metrics_hook.py`, vps-metrics tests | unreachable 创建请求，reachable 清除；不存在第二份 streak |
| F 现场验收 | 两机角色、服务、timer、链接、secret、checkpoint 完整性 | `hermes-ha accept-p0 --node dmit|band` | 所有 JSON `checks[].ok=true`，进程退出码 0 |

统一自动化命令：

```bash
./scripts/test-p0.sh
```

## 实现形态

| 层 | 位置 |
|----|------|
| 热状态 | `~/iCloudDrive/hermes-ha/hermes/<shared_dirs/shared_files>` |
| 密钥 | `secrets/*.age`；本机解密至 `~/.config/hermes-ha/runtime/runtime/`，权限 0600 |
| 大目录 | `~/.config/hermes-ha/local_trees/` |
| `state.db` | 本机 `local_trees/state.db` + iCloud generation 分片与原子 manifest |
| Gateway PG | `checkpoints/gateway/`，由 leader timer 发布 |

## 现场验收

以下命令均只读，不启停服务、不切 DNS、不改变 leader：

```bash
# dmit
hermes-ha accept-p0 --node dmit > p0-dmit-evidence.json

# band
hermes-ha accept-p0 --node band > p0-band-evidence.json
```

必须满足：

- dmit：`role_holder=vps-dmit`；所有配置的 stack units 为 `active`。
- band：`role_holder=vps-dmit`；所有 stack units 为 `inactive`；
  `hermes-ha-evaluate.timer` 与
  `hermes-ha-gateway-version-sync.timer` enabled。
- 两机的 gateway/state checkpoint timers 均 enabled；服务使用 `--if-leader`，
  standby 上无副作用，接管后无需重配 timer 即开始发布 checkpoint。
- 两机全部 `shared_dirs` symlink 指向相同 iCloud shared root。
- runtime secret 存在且权限严格为 0600。
- 本机 state.db 大小等于 manifest `raw_size`；共享分片完整解压后的 SHA-256
  与 manifest 一致。
- Gateway dump 存在、非空且大小等于 manifest。

## 当前证据状态

| 门禁 | 状态 | 证据 |
|------|------|------|
| 工作区自动化门禁 | 待本次实现最终运行后填写 | `./scripts/test-p0.sh` |
| dmit 现场只读验收 | 待在目标机运行 | `p0-dmit-evidence.json` |
| band 现场只读验收 | 待在目标机运行 | `p0-band-evidence.json` |

## 不属于 P0 的破坏性演练

- 真实 Cloudflare DNS 实切。
- 主动停止 dmit 后的生产 takeover 演练。
- Windows reverse tunnel 能力对齐。

这些项目属于后续演练阶段；P0 必须先通过上述模拟交接和只读现场门禁。
