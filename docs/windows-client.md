# Windows 加密对话客户端（桌面 App）

面向终端用户的 **Windows 桌面客户端**：一个 Tauri v2 + WebView2 外壳，把 Secure Web 的
端到端加密（E2EE）对话 UI **打包进安装包、从本地加载**。可从网关右上角「**下载 Windows
客户端**」直接获取安装包。

> 这是 **桌面 App**，不是浏览器扩展，也不是纯网页 PWA。三者区别见文末。

## 为什么要它（抗首载 MITM）

纯网页 / PWA 无法承诺「从一开始就被企业 TLS MITM」环境下首次加载的 JS 未被篡改。桌面壳把
UI 资源随安装包一次性下发、之后从本地 `http://tauri.localhost` 协议加载，不在每次启动时从
网络拉首屏 JS，因此比浏览器标签更抗首载中间人。加密、配对、RAMC、Passkey 等逻辑全部复用
`apps/secure-web` 的构建产物，**零重写**，在 WebView2 里原样运行。

安全路径优先级参见 [`快速开始.md`](./快速开始.md) 与 [`secure-web-verifier.md`](./secure-web-verifier.md)。

## 结构

```
apps/desktop/
  package.json            # @cursor-gateway/desktop（tauri CLI）
  app-icon.png            # 1024² 源图标（scripts/gen-icon.mjs 生成，已提交）
  scripts/gen-icon.mjs    # 纯 Node，无图像依赖，生成源图标
  src-tauri/
    tauri.conf.json       # frontendDist -> ../../secure-web/dist（复用产物）
    Cargo.toml build.rs
    src/main.rs src/lib.rs
    capabilities/default.json
```

- `frontendDist` 指向 `apps/secure-web/dist`：**直接复用** Secure Web 的构建产物。
- CSP 仅放行连接 `https://secure.joelzt.org` / `https://cs.joelzt.org`（及 `*.joelzt.org`）。

## 如何构建（在 Windows / WSL 之外的原生 Windows，或 CI）

> Linux/WSL 构建机 **无法交叉编译** Windows 目标（缺 Rust/MSVC/WebView2）。请在一台
> **原生 Windows** 机器或用随附的 GitHub Actions 出包。

一次性环境（Windows）：

1. [Node.js 22+](https://nodejs.org/)
2. [Rust（stable, MSVC toolchain）](https://rustup.rs/) — `x86_64-pc-windows-msvc`
3. WebView2 Runtime（Win11 自带；Win10 用 Evergreen 安装器）
4. NSIS 由 Tauri 自动下载；MSI 需要 WiX（可选）

一键出包（在仓库根）：

```powershell
npm install
npm run build -w @cursor-gateway/secure-web   # 先构建被打包的前端产物
npm run build -w @cursor-gateway/desktop       # = build:frontend + icon + tauri build（NSIS）
```

产物：`apps/desktop/src-tauri/target/release/bundle/nsis/*-setup.exe`。
仅要 NSIS：`npm run build:nsis -w @cursor-gateway/desktop`。可选 MSI：`... -- build --bundles msi`。

### 用 CI 出包（推荐，无需本地 Windows）

工作流 [`.github/workflows/desktop-windows.yml`](../.github/workflows/desktop-windows.yml) 在
`windows-latest` 上构建，产出 `cursor-gateway-desktop-setup.exe` + `SHA256SUMS`：

- 手动触发：Actions → **desktop-windows** → Run（可勾选 `with_msi`）。
- 打 tag 触发并附加到 Release：`git tag desktop-v0.1.0 && git push origin desktop-v0.1.0`。

下载 workflow artifact 或 Release 资产，得到 `cursor-gateway-desktop-setup.exe`。

## 发布 / 让网关可下载

服务端已提供 `GET /api/desktop/download`（Cloudflare Access 鉴权 + 审计 + attachment），
读取 `artifacts/cursor-gateway-desktop-setup.exe`，**缺产物时返回 404**（`desktop_installer_unavailable`）。

把出好的安装包放到网关的 `artifacts/`：

```bash
# 在 VPS 仓库根
mkdir -p artifacts
cp /path/to/cursor-gateway-desktop-setup.exe artifacts/cursor-gateway-desktop-setup.exe
# 若走 Docker：把该文件挂载/复制进容器的 /app/artifacts/ 后重启 app
```

之后网关右上角「下载 Windows 客户端」即可下载（同源 `/api/desktop/download`，带 Access cookie）。

## 签名与校验

沿用 `signed-release` 模式，私钥 **不进 git**：

```bash
# 生成 SHA256SUMS + 分离式 Ed25519 签名（minisign 优先，Node crypto 兜底）
scripts/desktop/sign-desktop-release.sh artifacts/desktop/cursor-gateway-desktop-setup.exe
# 公钥提交到 scripts/csapi/trust/desktop-ed25519.pub.pem（或 desktop-minisign.pub）
```

用户侧校验：

```powershell
# 对照 SHA256SUMS
Get-FileHash .\cursor-gateway-desktop-setup.exe -Algorithm SHA256
```

> **未完成项**：Windows 代码签名证书（Authenticode）尚未接入。没有商业签名证书时，
> 首次运行会出现 SmartScreen 提示；请先用 SHA256/Ed25519 校验完整性。购得 EV/OV 证书后，
> 在 `tauri.conf.json` 的 `bundle.windows` 配置 `certificateThumbprint` 或在 CI 用 signtool。

## 如何安装 / 验证

1. 从网关右上角「下载 Windows 客户端」下载 `cursor-gateway-desktop-setup.exe`。
2. 用上面的命令核对 SHA256（可选核对 Ed25519 签名）。
3. 双击安装（当前为 `currentUser` 模式，无需管理员）。
4. 启动「Cursor Gateway」，按 Secure Web 既有流程完成设备验证（RAMC / Passkey 等）并配对 Runner。
5. 选工作区、发一条只读消息，状态变为 `finished` 即打通。

> 首次登录仍走 Cloudflare Access（若站点由 Access 保护）：在窗口内完成一次登录即可。

## 与「扩展 / PWA」的区别

| | Windows 桌面客户端（本文） | 浏览器扩展（旧方案 A） | 纯网页 / PWA |
| --- | --- | --- | --- |
| 载体 | 独立 `.exe`（Tauri + WebView2） | Chrome 扩展 | 浏览器标签 |
| 首屏 UI 来源 | 安装包内本地资源 | 扩展包内 | 每次网络拉取 |
| 抗首载 MITM | 强（本地资源） | 强（扩展包 + 固定 ID） | 弱（不承诺） |
| 下载入口 | `/api/desktop/download` | `/api/extension/download`（不再推广） | 直接访问网页 |
| 现状 | MVP，本文即落地 | 保留但不推广 | 仅作备选 |
