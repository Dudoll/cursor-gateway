# csapi 懒人安装脚本

一键把「CLI 用的 API 环境」配好，指向兼容门面 **`https://csapi.joelzt.org`**。
适用于 Claude Code（Anthropic 兼容）与 OpenCode / 任意 OpenAI 兼容客户端。

> ⚠️ **这是 plaintext 兼容通道（方案 B：TLS + API key），不是端到端加密（E2EE）。**
> 你的请求体 / system prompt / 对话内容在门面、网关、Runner、模型侧都是**明文可见**的
> （我们做最小化日志，但技术上可见）。想要 Gateway-blind、明文不出本机，需走方案 A（后续）。

---

## 文件

| 文件 | 平台 | 说明 |
|------|------|------|
| `install-csapi.sh` | Linux / macOS / WSL / Windows Git-Bash | 主脚本（POSIX sh），**可单文件分发** |
| `install-csapi.ps1` | Windows PowerShell | 写用户级持久环境变量 |

**只发 `install-csapi.sh` 一个文件也能用**，无需仓库其它内容。

## 脚本会配置什么

```
# Claude Code / Anthropic 兼容
ANTHROPIC_BASE_URL = https://csapi.joelzt.org
ANTHROPIC_API_KEY  = <你的 CSAPI key>
# OpenCode / OpenAI 兼容
OPENAI_BASE_URL    = https://csapi.joelzt.org/v1
OPENAI_API_KEY     = <你的 CSAPI key>
```

- **Anthropic 用根 URL**，**OpenAI 用 `/v1`** —— 已按门面约定处理，别手动加错。
- key 由**交互输入**或 **`CSAPI_API_KEY` 环境变量**提供；脚本里**不含任何真实 key**。

---

## 用法（Linux / macOS / WSL / Git-Bash）

```bash
# 1) 交互式（最简单，会提示输入 key，输入不回显）
sh install-csapi.sh

# 2) 用环境变量跳过交互（也接受 API_KEY 别名）
CSAPI_API_KEY=sk-xxxx sh install-csapi.sh

# 3) 只打印 export 语句、不改任何文件
sh install-csapi.sh --print

# 4) 跳过连通性探测
sh install-csapi.sh --no-probe

# 5) 移除本脚本写入的配置
sh install-csapi.sh --uninstall
```

脚本会把一段**带标记注释的受管块**写入你的 `~/.zshrc` 或 `~/.bashrc`（按登录 shell 自动判断）。
**幂等**：重复运行只会更新这段块，不会重复堆叠。生效方式：重开终端，或 `. ~/.bashrc` / `source ~/.zshrc`。

## 用法（Windows PowerShell）

```powershell
# 交互式
powershell -ExecutionPolicy Bypass -File .\install-csapi.ps1

# 用环境变量跳过交互
$env:CSAPI_API_KEY="sk-xxxx"; .\install-csapi.ps1

# 只打印、卸载、跳过探测
.\install-csapi.ps1 -Print
.\install-csapi.ps1 -Uninstall
.\install-csapi.ps1 -NoProbe
```

PowerShell 版写的是**用户级持久环境变量**（`SetEnvironmentVariable(..., 'User')`），
Set 即覆盖，天然不堆叠；当前窗口即时生效，新终端自动带上。

---

## 四处分发的方式

### A. 直接拷贝文件（最稳，推荐）

把 `install-csapi.sh` 拷到目标机器（U 盘 / `scp` / 复制粘贴）后运行：

```bash
scp install-csapi.sh user@host:~/    # 或任意方式拷过去
ssh user@host 'CSAPI_API_KEY=sk-xxxx sh ~/install-csapi.sh'
```

### B. 一行 `curl | sh`（仓库 `Dudoll/cursor-gateway` 目前是公开的）

```bash
# 交互式（会提示输入 key）
curl -fsSL https://raw.githubusercontent.com/Dudoll/cursor-gateway/main/scripts/csapi/install-csapi.sh | sh

# 非交互（用环境变量传 key）
curl -fsSL https://raw.githubusercontent.com/Dudoll/cursor-gateway/main/scripts/csapi/install-csapi.sh | CSAPI_API_KEY=sk-xxxx sh
```

> 说明：
> - `curl | sh` 依赖仓库**公开可读**。若之后仓库转为私有，此法失效，请改用「A. 拷贝文件」。
> - 出于安全习惯，管道执行第三方脚本前最好先 `curl ... -o install-csapi.sh` 下载看一眼再跑。
> - **切勿**把真实生产 key 拼进公开分享的一行命令里（会留在 shell 历史/剪贴板）。优先交互输入。

### C. 内网/离线分发

脚本零依赖（只用到 `sh` + 可选 `curl`）。塞进内部 wiki / 对象存储 / 配置管理下发均可。

---

## 验证连通

脚本默认会探测（可用 `--no-probe` 关闭）：

```bash
curl -sS https://csapi.joelzt.org/health                       # 无需 key
curl -sS -H "Authorization: Bearer $OPENAI_API_KEY" \
     https://csapi.joelzt.org/v1/models                        # 带 key，应 200
```

## 常见问题

- **想换门面地址？** 运行前设 `CSAPI_BASE_URL=https://your-host`，脚本会自动派生 `/v1`。
- **health 失败但变量已写入？** 属正常降级：网络/门面临时不可达不影响写配置，稍后重试探测即可。
- **models 返回 401/403？** key 无效或未授权，核对后重跑。
- **要彻底清理？** 用 `--uninstall`（PowerShell 用 `-Uninstall`）。

更多门面细节（端点、会话语义、安全边界）见仓库 `docs/csapi.md`。
