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
| `install-csapi-secure.sh` | Linux / macOS / WSL / Git-Bash | **抗 MITM** Secure Adapter 懒人安装器（方案 A，cg-mitm/1） |
| `install-csapi-secure.ps1` | Windows PowerShell | 同上，Windows 版 |

**只发 `install-csapi.sh` 一个文件也能用**，无需仓库其它内容。

> 想要**抗中间人 / 明文不出本机**？看下面「抗 MITM 懒人安装」。它固定离线根指纹、把调用封成密文发往
> `/cg/v1/*`，真实 key 永不进 git / HTTP header；fail-closed，绝不回退明文。

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

---

## 抗 MITM 懒人安装（Secure Adapter，方案 A）

`install-csapi-secure.sh` 配置的是**方案 A 的客户端**：本机 `Secure Adapter`（`apps/secure-adapter`）。
它在本机暴露 loopback 的 Anthropic/OpenAI 门面，把每次调用重新封装成 **cg-mitm/1 密文**发往 csapi 的
`/cg/v1/*`。明文只存在于 Adapter 进程内；对网络中间人（企业根证书 / mitmproxy 透明代理）只见密文。

它会（**真·一键**，四处拷贝即用）：

1. **离线固定（pin）Ed25519 根指纹**：内置常量 + 优先读取 `trust/csapi-trust-root-public.json`（**仅公钥**）。
2. **探测并核对** `/cg/v1/server-keys`：服务端下发的身份证书必须由该固定根签发；指纹不匹配即 fail-closed。
3. **自动备好仓库**：找不到 `apps/secure-adapter` 源码时，`git clone` 公开仓库到
   `~/.cursor-gateway/cursor-gateway`（`--no-clone` 关闭、`--yes` 免确认）；缺依赖时在仓库根 `npm install`
   （`--no-install` 关闭；`--build` 额外编译 dist）。已有本地仓库自动复用，或 `CSAPI_REPO_DIR=/path` 指定。
4. 写本机配置 `~/.cursor-gateway/secure-adapter.env`（0600，含**真实 key**）+ 启动器 `start-secure-adapter.sh`。
5. **幂等**写 shell 受管块：把 CLI 的 `ANTHROPIC_*/OPENAI_*` 指向本机 Adapter（用本地 loopback key，非真实 key）。
6. `--start` 拉起 Adapter；`--service` 注册 `systemd --user` 开机自启（无 systemd 回退 nohup）。

```bash
# 交互式（提示输入真实 key；会自动 clone/装依赖）
sh install-csapi-secure.sh
# 真·一键：非交互 + 自动确认 clone + 立即后台启动
CSAPI_API_KEY=sk-xxxx sh install-csapi-secure.sh --start --yes
# 注册开机自启（systemd --user）
CSAPI_API_KEY=sk-xxxx sh install-csapi-secure.sh --service --yes
# 只准备仓库（clone + npm install [+ --build]），不写配置
sh install-csapi-secure.sh --setup
# 只打印 / 卸载 / 状态 / 停止 / 跳过探测 / 不 clone / 不装依赖
sh install-csapi-secure.sh --print
sh install-csapi-secure.sh --uninstall
sh install-csapi-secure.sh --status
sh install-csapi-secure.sh --stop
sh install-csapi-secure.sh --no-probe
sh install-csapi-secure.sh --no-clone --no-install
```

Windows：`powershell -ExecutionPolicy Bypass -File .\install-csapi-secure.ps1`（`-Start / -Service /
-Setup / -Print / -Uninstall / -Status / -Stop / -NoProbe / -NoClone / -NoInstall / -Build / -Yes`）。
Windows `-Service` 注册「登录自启」计划任务。

### 与明文 `install-csapi.sh` 的关系

| 维度 | `install-csapi.sh`（方案 B） | `install-csapi-secure.sh`（方案 A） |
|------|------------------------------|--------------------------------------|
| 通道 | TLS + API key **明文兼容** | cg-mitm/1 **应用层密文**，抗 MITM |
| CLI 指向 | `https://csapi.joelzt.org` 直连 | 本机 `http://127.0.0.1:8788`（Adapter） |
| 真实 key 位置 | 写进 shell rc（明文可见） | 只在 `~/.cursor-gateway/secure-adapter.env`(0600) + 密文 envelope |
| 依赖 | 零依赖，**单文件可分发** | 需仓库源码 + `npm install`（node≥22）跑 Adapter（脚本会**自动 clone + install**） |
| 中间人可见 | prompt/response 明文 | 仅 cg-mitm/1 密文 |
| 受管块 | `csapi env` | `csapi secure adapter env`（在 rc 靠后，覆盖前者） |

二选一即可。两个受管块互不干扰；同装时安全块靠后生效。

### curl|sh 分发说明

- 明文 `install-csapi.sh` 真·单文件：`curl -fsSL <raw-url>/scripts/csapi/install-csapi.sh | sh` 即完事。
- 安全版也支持 `curl|sh` 真·一键：脚本探测核对根指纹后，会**自动 `git clone` 公开仓库 + `npm install`**，
  再写配置并（`--start`）拉起 Adapter。示例（自动确认 clone、非交互传 key）：

  ```bash
  curl -fsSL https://raw.githubusercontent.com/Dudoll/cursor-gateway/main/scripts/csapi/install-csapi-secure.sh \
    | CSAPI_API_KEY=sk-xxxx sh -s -- --start --yes
  ```

  已在本机 clone 过仓库、想跳过自动 clone，就在仓库目录内直接跑本脚本，或设
  `CSAPI_REPO_DIR=/path/to/repo`。需要 node≥22 + git。
- 指纹为**离线信任锚**：即便首包被企业 CA 篡改，指纹不匹配也会 fail-closed（并可多渠道 out-of-band 核对
  `sha256:E9OuniLwYNCVLPPwbG_aMimeFG3Ly1OFnhDplyQwy9g`）。

### 生产运维前置（必须先开）

安装器生效的前提是 csapi 服务端已开启安全通道，否则 `/cg/v1/server-keys` 为 404、脚本会**友好报错并说明前置**：

1. 离线机器用 Ed25519 根签发服务端身份证书（`allowedOrigins` 含生产域名）：
   `scripts/csapi/dev-cg-mitm-setup.sh https://csapi.joelzt.org`
2. 把打印的 `CG_*` 写入 csapi 的 `.env` 并重启，务必开启 `CG_SECURE_ENABLED=true` +
   `CG_SERVER_CERT_FILE / CG_SERVER_HPKE_KEY_FILE / CG_SERVER_SIGNING_KEY_FILE / CG_TRUST_ROOTS_FILE`，
   并保持 `CG_REQUIRE_SECURE=false`（明文 `/v1/*` 与安全 `/cg/v1/*` 并行灰度）。

信任根说明见 `trust/README.md`；协议与威胁模型见 `docs/cg-mitm.md`。
