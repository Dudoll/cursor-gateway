# Windows Runner 安装

VPS 上只跑网关；真正读写 Windows 本地文件的是本机 Runner。

在 VPS 上通过 SSH 打开 Cursor Desktop，并不会自动让 VPS Agent 访问 `C:\...`。请在拥有目标文件的 Windows 机器上启动本 Runner，以便用 Cursor SDK 的 `local: { cwd }` 访问工作区。

## 启动

在项目根目录打开 PowerShell：

```powershell
.\apps\windows-runner\scripts\start-runner.ps1
```

首次运行会生成：

```text
apps\windows-runner\.env
```

编辑这些值（不要把真实密钥提交到 Git）：

```text
CURSOR_API_KEY=<你的 Cursor API Key>
RUNNER_WORKSPACES=C:\Workspaces\project1;D:\Workspaces\project2
RUNNER_MAX_CONCURRENT_JOBS=3
RUNNER_E2EE_ENABLED=true
RUNNER_LEGACY_ENABLED=false
GATEWAY_URL=https://gateway.example.com
RUNNER_SHARED_SECRET=<与 VPS 相同>
```

然后再次执行：

```powershell
.\apps\windows-runner\scripts\start-runner.ps1
```

## E2EE 离线配对

Runner 首次启动会在当前 Windows 用户下创建 DPAPI 加密状态。停止 Runner 后输出本地 bundle：

```powershell
npm run pair:runner -w @cursor-gateway/windows-runner
```

只把该 bundle 粘贴到受信任的 `Cursor Gateway Secure` 签名扩展，并人工核对 encryption/signing fingerprint。再把扩展显示的 client bundle 导回本机：

```powershell
npm run pair:client -w @cursor-gateway/windows-runner -- <client-bundle>
npm run pair:list -w @cursor-gateway/windows-runner
```

撤销设备：

```powershell
npm run pair:revoke -w @cursor-gateway/windows-runner -- <client-id>
```

默认状态文件为 `%USERPROFILE%\.cursor-gateway\runner-e2ee-state.dat`。不要复制到 VPS，不要开启 `RUNNER_E2EE_ALLOW_INSECURE_DEV_STORAGE`。完整说明见 [e2ee.md](e2ee.md)。

## 保持运行（自恢复）

以管理员 PowerShell 安装计划任务守护进程：

```powershell
.\apps\windows-runner\scripts\install-runner-daemon.ps1
```

会安装两个任务：

| 任务 | 作用 |
| --- | --- |
| `CursorGatewayWindowsRunner` | 开机守护：启动 Runner，退出后重启；网关心跳过期则杀进程 |
| `CursorGatewayWindowsRunnerWatchdog` | 每 2 分钟检查；守护任务挂了或健康过期则拉起 |

恢复层级：

1. **进程内** — 网关请求 30s 超时；心跳独立循环；连续 5 次心跳失败则退出进程
2. **守护监督** — 退出后指数退避重启；`runner-health.json` 超过 180s 无成功心跳则杀进程树
3. **外部看门狗** — 守护本身卡住/消失时重启计划任务并清理孤儿进程
4. **任务计划程序** — PowerShell 本身崩溃时重启守护进程

日志与健康文件：

```text
apps\windows-runner\logs\runner-daemon.log
apps\windows-runner\logs\runner-watchdog.log
apps\windows-runner\logs\runner-health.json
apps\windows-runner\logs\runner-daemon-state.json
```

查看状态：

```powershell
Get-ScheduledTask -TaskName CursorGatewayWindowsRunner, CursorGatewayWindowsRunnerWatchdog
Get-ScheduledTaskInfo -TaskName CursorGatewayWindowsRunner
Get-Content .\apps\windows-runner\logs\runner-health.json
```

强制干净恢复：

```powershell
.\apps\windows-runner\scripts\restart-runner.ps1
```

`SYSTEM` 账户需要对 `RUNNER_WORKSPACES` 中每个路径有 NTFS 权限。请把根目录范围收窄，因为那就是 Runner 的文件系统边界。

`RUNNER_MAX_CONCURRENT_JOBS` 默认 `3`，请与 VPS 保持一致。不同会话可并行；同一会话内任务仍按序领取，以保护 Cursor Agent 状态。

## 在 VPS 上核对

Runner 启动后，Web UI 应显示已注册工作区与模型。也可在 VPS 查看应用日志：

```bash
cd /opt/cursor-gateway
sudo docker compose -f infra/docker-compose.yml logs -f app
```
