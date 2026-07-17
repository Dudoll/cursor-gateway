# csapi 懒人安装脚本

## Agent 使用方一键安装（方案 A，推荐 · 抗 MITM）

复制下面一行即可。首次运行会自动 clone 到
`~/.cursor-gateway/cursor-gateway`，重复运行会先执行 `git pull --ff-only`，随后自动进入项目安装、按依赖顺序构建、注册自启并验证。首次安装只需输入 API Key（输入不回显）；升级会复用本机 `0600` 配置中已经保存的 Key，不会重复询问。

```bash
curl -fsSL https://raw.githubusercontent.com/Dudoll/cursor-gateway/main/scripts/csapi/install-agent-secure.sh | sh
```

> 缺 `node`（或版本 < 22）时会自动下载官方 Node 到用户目录，无需 root。真实 API Key 不会进入命令行历史。
>
> 高级用法：可通过 `CSAPI_BASE_URL` 指定服务地址，通过 `CSAPI_CLONE_DIR` 指定项目目录。
>
> Windows（PowerShell）：
>
> ```powershell
> $env:CSAPI_API_KEY="sk-xxxx"
> irm https://raw.githubusercontent.com/Dudoll/cursor-gateway/main/scripts/csapi/install-csapi-secure.ps1 | iex
> ```
>
> 或下载后本地执行：`powershell -ExecutionPolicy Bypass -File .\install-csapi-secure.ps1 -Yes`

换门面地址：运行前设 `CSAPI_BASE_URL=https://your-host`（脚本会同步 upstream 与 rc）。

---

一键把「CLI 用的 API 环境」配好，用于 Claude Code（Anthropic 兼容）与 OpenCode / 任意 OpenAI 兼容客户端。

提供**两种**通道，二选一：

- **方案 A（推荐）：抗 MITM 的 Secure Adapter（cg-mitm/1）** —— 明文不出本机、抗中间人（企业根证书 /
  mitmproxy 也读不到 prompt）。用 `install-csapi-secure.sh` / `.ps1`。**详见下面「方案 A」。**
- **方案 B：明文兼容直连** —— 最省事、零依赖单文件，但请求体在门面 / 网关 / Runner / 模型侧**明文可见**。
  用 `install-csapi.sh` / `.ps1`。见后面「方案 B」。

> ⚠️ 只在**信任网络链路**、或只是快速试用时才用方案 B。要抗中间人 / 明文不出本机，请用方案 A。

---

## 文件

| 文件 | 平台 | 说明 |
|------|------|------|
| `install-csapi-secure.sh` | Linux / macOS / WSL / Git-Bash | **方案 A**：抗 MITM Secure Adapter 一键安装器（cg-mitm/1，推荐） |
| `install-csapi-secure.ps1` | Windows PowerShell | 同上，Windows 版 |
| `install-csapi.sh` | Linux / macOS / WSL / Windows Git-Bash | **方案 B**：明文兼容直连（POSIX sh），**可单文件分发** |
| `install-csapi.ps1` | Windows PowerShell | 方案 B，写用户级持久环境变量 |

---

# 方案 A（推荐）：抗 MITM 懒人安装（Secure Adapter）

`install-csapi-secure.sh` 配置的是**方案 A 的客户端**：本机 `Secure Adapter`（`apps/secure-adapter`）。
它在本机暴露 loopback 的 Anthropic/OpenAI 门面，把每次调用重新封装成 **cg-mitm/1 密文**发往 csapi 的
`/cg/v1/*`。明文只存在于 Adapter 进程内；对网络中间人（企业根证书 / mitmproxy 透明代理）只见密文。
真实 key 只留在本机 `~/.cursor-gateway/secure-adapter.env`（0600）与密文 envelope 内，**永不进 git、
永不进 HTTP header**。

它会（**真·一键**，四处拷贝即用）：

1. **离线固定（pin）Ed25519 根指纹**：内置常量 + 优先读取 `trust/csapi-trust-root-public.json`（**仅公钥**）。
2. **探测并核对** `/cg/v1/server-keys`：服务端下发的身份证书必须由该固定根签发；指纹不匹配即 fail-closed。
3. **自动备好运行时**：缺 `node`（或 < 22）时**自动下载官方 Node 二进制到用户目录**（`~/.cursor-gateway/node/`，
   无需 root，`CSAPI_NODE_VERSION` / `CSAPI_NODE_MIRROR` 可覆盖）并持久化进 PATH；找不到 `apps/secure-adapter`
   源码时，`git clone` 公开仓库到 `~/.cursor-gateway/cursor-gateway`（`--no-clone` 关闭、`--yes` 免确认）；缺依赖时在仓库根
   `npm install`（`--no-install` 关闭；`--build` 额外编译 dist）。已有本地仓库自动复用，或 `CSAPI_REPO_DIR=/path` 指定。
4. 写本机配置 `~/.cursor-gateway/secure-adapter.env`（0600，含**真实 key**）+ 启动器 `start-secure-adapter.sh`。
5. **幂等**写 shell 受管块：把 CLI 的 `ANTHROPIC_*/OPENAI_*` 指向本机 Adapter（用本地 loopback key，非真实 key）。
6. **收尾自动完成**：启动 Adapter → curl `/health` 验证 → 失败则有限次自愈（重启、重装依赖、编译 dist、清端口、
   修正 BASE_URL/rc）。成功打印「**已验证通过**」+ health 摘要；不再只提示「下一步」。

```bash
# 交互式（提示输入真实 key；会自动 clone/装依赖/启动/验证）
sh install-csapi-secure.sh
# 真·一键：非交互 + 自动确认 clone（默认即启动并验证）
CSAPI_API_KEY=sk-xxxx sh install-csapi-secure.sh --yes
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

Windows：`powershell -ExecutionPolicy Bypass -File .\install-csapi-secure.ps1`（`-Service /
-Setup / -Print / -Uninstall / -Status / -Stop / -NoProbe / -NoClone / -NoInstall / -Build / -Yes`）。
Windows `-Service` 注册「登录自启」计划任务。默认安装即启动并 `/health` 验证（与 `.sh` 对齐）。

## curl|sh 分发（方案 A）

安全版支持 `curl|sh` 真·一键：脚本探测核对根指纹后，会**自动 `git clone` 公开仓库 + `npm install`**，
再写配置、拉起 Adapter 并自检 `/health`。示例（自动确认 clone、非交互传 key）：

```bash
curl -fsSL https://raw.githubusercontent.com/Dudoll/cursor-gateway/main/scripts/csapi/install-csapi-secure.sh \
  | CSAPI_API_KEY=sk-xxxx sh -s -- --yes
```

- 已在本机 clone 过仓库、想跳过自动 clone，就在仓库目录内直接跑本脚本，或设 `CSAPI_REPO_DIR=/path/to/repo`。
  需要 git；`node≥22` 缺失时脚本会**自动下载到用户目录**（可 `CSAPI_NODE_VERSION` / `CSAPI_NODE_MIRROR` 覆盖）。
- 指纹为**离线信任锚**：即便首包被企业 CA 篡改，指纹不匹配也会 fail-closed（并可多渠道 out-of-band 核对
  `sha256:E9OuniLwYNCVLPPwbG_aMimeFG3Ly1OFnhDplyQwy9g`）。

## 生产运维前置（方案 A 必须先开）

安装器生效的前提是 csapi 服务端已开启安全通道，否则 `/cg/v1/server-keys` 为 404、脚本会**友好报错并说明前置**：

1. 离线机器用 Ed25519 根签发服务端身份证书（`allowedOrigins` 含生产域名）：
   `scripts/csapi/dev-cg-mitm-setup.sh https://csapi.joelzt.org`
2. 把打印的 `CG_*` 写入 csapi 的 `.env` 并重启，务必开启 `CG_SECURE_ENABLED=true` +
   `CG_SERVER_CERT_FILE / CG_SERVER_HPKE_KEY_FILE / CG_SERVER_SIGNING_KEY_FILE / CG_TRUST_ROOTS_FILE`，
   并保持 `CG_REQUIRE_SECURE=false`（明文 `/v1/*` 与安全 `/cg/v1/*` 并行灰度）。

信任根说明见 `trust/README.md`；协议与威胁模型见 `docs/cg-mitm.md`。

---

# 方案 B：明文兼容直连（install-csapi.sh）

> ⚠️ **这是 plaintext 兼容通道（TLS + API key），不是端到端加密（E2EE）。**
> 你的请求体 / system prompt / 对话内容在门面、网关、Runner、模型侧都是**明文可见**的
> （我们做最小化日志，但技术上可见）。想要 Gateway-blind、明文不出本机，请用上面的**方案 A**。

**只发 `install-csapi.sh` 一个文件也能用**，无需仓库其它内容。它把 CLI 环境直接指向门面
`https://csapi.joelzt.org`。

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

## 四处分发的方式（方案 B）

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

## 验证连通（方案 B）

脚本默认会探测（可用 `--no-probe` 关闭）：

```bash
curl -sS https://csapi.joelzt.org/health                       # 无需 key
curl -sS -H "Authorization: Bearer $OPENAI_API_KEY" \
     https://csapi.joelzt.org/v1/models                        # 带 key，应 200
```

---

## 方案 A vs 方案 B 对比

| 维度 | `install-csapi-secure.sh`（方案 A，推荐） | `install-csapi.sh`（方案 B） |
|------|--------------------------------------------|------------------------------|
| 通道 | cg-mitm/1 **应用层密文**，抗 MITM | TLS + API key **明文兼容** |
| CLI 指向 | 本机 `http://127.0.0.1:8788`（Adapter） | `https://csapi.joelzt.org` 直连 |
| 真实 key 位置 | 只在 `~/.cursor-gateway/secure-adapter.env`(0600) + 密文 envelope | 写进 shell rc（明文可见） |
| 中间人可见 | 仅 cg-mitm/1 密文 | prompt/response 明文 |
| 依赖 | 需仓库源码 + `npm install`（node≥22）跑 Adapter（脚本会**自动装 node + clone + install**） | 零依赖，**单文件可分发** |
| 收尾 | 自动启动 + `/health` 验证 + 有限次自愈 | 写配置 + 探测门面连通 |
| 受管块 | `csapi secure adapter env`（在 rc 靠后，覆盖前者） | `csapi env` |

二选一即可。两个受管块互不干扰；**同装时安全块靠后生效**（方案 A 覆盖方案 B），因此可以先用方案 B
试通、再叠加方案 A 升级到抗 MITM。

## 常见问题

- **想换门面地址？** 运行前设 `CSAPI_BASE_URL=https://your-host`，脚本会自动派生 `/v1` 并同步 upstream/rc。
- **本机没装 node / 版本太旧？** 方案 A 脚本会**自动下载官方 Node 到用户目录**（无需 root/管理员）：
  Linux/macOS/WSL 装到 `~/.cursor-gateway/node/`、Windows 装到 `%USERPROFILE%\.cursor-gateway\node\`，并持久化进 PATH。
  想固定版本/换镜像：`CSAPI_NODE_VERSION=v22.14.0`、`CSAPI_NODE_MIRROR=https://mirrors.tuna.tsinghua.edu.cn/nodejs-release`。
  下载失败会给出手动链接 `https://nodejs.org/dist/<版本>/`。
- **方案 A 探测报 404/426？** 服务端尚未开启安全通道，见上面「生产运维前置」；或先用方案 B 试用。
- **方案 A 已验证通过？** 终端会打印 health 摘要；新终端自动带上 CLI 变量，当前终端可 `. ~/.bashrc`。
- **方案 B health 失败但变量已写入？** 属正常降级：网络/门面临时不可达不影响写配置，稍后重试探测即可。
- **models 返回 401/403？** key 无效或未授权，核对后重跑。
- **要彻底清理？** 用 `--uninstall`（PowerShell 用 `-Uninstall`）。

更多门面细节（端点、会话语义、安全边界）见仓库 `docs/csapi.md`；抗 MITM 协议与威胁模型见 `docs/cg-mitm.md`。
