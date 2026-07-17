#!/usr/bin/env sh
# =============================================================================
# install-csapi-secure.sh — 抗 MITM「Secure Adapter」懒人一键安装（cg-mitm/1）
# -----------------------------------------------------------------------------
# 与 install-csapi.sh（方案 B，明文兼容通道）不同，本脚本配置的是**方案 A 的
# 客户端**：本机 Secure Adapter。它在本机暴露一个 loopback 的 Anthropic/OpenAI
# 门面，把每次调用重新封装成 cg-mitm/1 **密文**发往 csapi 的 /cg/v1/*。
# 明文只存在于 Adapter 进程内；对网络中间人（企业根证书 / mitmproxy）只见密文。
#
# 安全锚点：本脚本**离线固定（pin）**一个 Ed25519 根指纹（见下方 BUILTIN_PINNED_ROOTS
# 或 scripts/csapi/trust/csapi-trust-root-public.json）。服务端 /cg/v1/server-keys
# 下发的身份证书必须由这个根签发，否则 Adapter fail-closed，绝不回退明文。
#
# 「真·一键」做的事（默认 install / --start）：
#   1) 读取你的**真实 CSAPI key**（仅存本机 0600 配置，永不进 git、永不进 HTTP header）；
#   2) 探测 /cg/v1/server-keys 并核对固定根指纹（防 MITM / 防配错服务端）；
#   3) 若本机**没有仓库源码** → 自动 git clone（公开仓库；可用 --no-clone 关闭）；
#   4) 若依赖没装 → 自动在仓库根 npm install（可用 --no-install 关闭；--build 额外编译 dist）；
#   5) 写本机 Adapter 配置          ~/.cursor-gateway/secure-adapter.env (0600)
#      + 启动器                     ~/.cursor-gateway/start-secure-adapter.sh (0700)；
#   6) 幂等写 shell 配置：把 CLI 的 ANTHROPIC_*/OPENAI_* 指向本机 Adapter（用 loopback key）；
#   7) --start 拉起 Adapter（有 systemd --user 且装了服务则用 systemd，否则 nohup 后台）。
#
# 用法：
#   sh install-csapi-secure.sh                       # 交互式（提示输入真实 key），准备好一切但不启动
#   CSAPI_API_KEY=sk-xxxx sh install-csapi-secure.sh --start   # 非交互 + 立即启动
#   sh install-csapi-secure.sh --start               # 安装后立即后台启动 Adapter
#   sh install-csapi-secure.sh --service             # 安装并注册 systemd --user 开机自启 + 启动
#   sh install-csapi-secure.sh --status              # 查看 Adapter 状态
#   sh install-csapi-secure.sh --stop                # 停止 Adapter
#   sh install-csapi-secure.sh --uninstall           # 移除 rc 块 + 本机配置/启动器 + 服务
#   sh install-csapi-secure.sh --print               # 只打印配置，不写文件/不 clone/不装依赖
#   sh install-csapi-secure.sh --setup               # 只准备仓库（clone + npm install [+ --build]），不写配置
#   sh install-csapi-secure.sh --no-probe            # 跳过 server-keys 探测（高级/预置）
#   sh install-csapi-secure.sh --no-clone            # 找不到仓库也不自动 clone（仅写配置）
#   sh install-csapi-secure.sh --no-install          # 不自动 npm install
#   sh install-csapi-secure.sh --build               # 额外 npm run build 编译 dist（可选）
#   sh install-csapi-secure.sh --yes                 # 自动确认（clone 等无需交互）
#
# 环境变量（可覆盖默认）：
#   CSAPI_API_KEY / CG_ADAPTER_API_KEY / API_KEY   真实 CSAPI key（非交互）
#   CSAPI_BASE_URL (默认 https://csapi.joelzt.org)  上游 csapi
#   CSAPI_REPO_DIR                                  已 clone 的仓库根（优先使用）
#   CSAPI_CLONE_DIR (默认 ~/.cursor-gateway/cursor-gateway)  自动 clone 的目标目录
#   CSAPI_REPO_GIT_URL (默认公开 HTTPS 仓库)         clone 用的 git URL
#   CSAPI_ASSUME_YES=1                               等价 --yes
#   CG_ADAPTER_LISTEN_HOST / CG_ADAPTER_LISTEN_PORT  本机门面监听（默认 127.0.0.1:8788）
#
# 与 install-csapi.sh 的关系：两者写入**不同的**受管块；本脚本的块在 rc 中靠后，
# 因此会覆盖明文安装器的 ANTHROPIC_*/OPENAI_*（后写生效）。二选一即可。
# =============================================================================

set -u

# ---- 内置离线固定根指纹（公开材料；私钥永不进仓库）--------------------------
# 单文件 curl|sh 场景下的信任锚。仓库在场时优先用 trust/csapi-trust-root-public.json。
# 轮换根时：同步更新此常量 + scripts/csapi/trust/csapi-trust-root-public.json。
BUILTIN_PINNED_ROOTS="sha256:E9OuniLwYNCVLPPwbG_aMimeFG3Ly1OFnhDplyQwy9g"

# ---- 可覆盖默认值 ----------------------------------------------------------
CSAPI_BASE_URL="${CSAPI_BASE_URL:-https://csapi.joelzt.org}"
UPSTREAM_URL="${CG_ADAPTER_UPSTREAM_URL:-$CSAPI_BASE_URL}"
UPSTREAM_URL="${UPSTREAM_URL%/}"
LISTEN_HOST="${CG_ADAPTER_LISTEN_HOST:-127.0.0.1}"
LISTEN_PORT="${CG_ADAPTER_LISTEN_PORT:-8788}"

# 公开仓库（curl|sh 场景默认走 HTTPS，无需配 SSH key）。
REPO_GIT_URL="${CSAPI_REPO_GIT_URL:-https://github.com/Dudoll/cursor-gateway.git}"

CFG_DIR="${CSAPI_SECURE_HOME:-$HOME/.cursor-gateway}"
ENV_FILE="$CFG_DIR/secure-adapter.env"
LAUNCHER="$CFG_DIR/start-secure-adapter.sh"
STATE_FILE="$CFG_DIR/cg-mitm-adapter-state.json"
PID_FILE="$CFG_DIR/secure-adapter.pid"
LOG_FILE="$CFG_DIR/secure-adapter.log"
CLONE_DIR="${CSAPI_CLONE_DIR:-$CFG_DIR/cursor-gateway}"

# ---- 托管 Node（缺 node/版本不足时自动下载到用户目录，无需 root）----------
# 目标版本可用 CSAPI_NODE_VERSION 覆盖（如 v22.14.0）；镜像用 CSAPI_NODE_MIRROR 覆盖。
NODE_MIN_MAJOR=22
CSAPI_NODE_VERSION="${CSAPI_NODE_VERSION:-v22.14.0}"
NODE_DIST_MIRROR="${CSAPI_NODE_MIRROR:-https://nodejs.org/dist}"
NODE_HOME="$CFG_DIR/node"            # 托管 node 安装根目录
MANAGED_NODE_BIN="$NODE_HOME/current/bin"  # 稳定软链，写入 PATH

SERVICE_NAME="csapi-secure-adapter"
SERVICE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SERVICE_FILE="$SERVICE_DIR/$SERVICE_NAME.service"

ADAPTER_LOCAL_BASE="http://$LISTEN_HOST:$LISTEN_PORT"

MARK_BEGIN="# >>> csapi secure adapter env (managed by install-csapi-secure.sh) >>>"
MARK_END="# <<< csapi secure adapter env (managed by install-csapi-secure.sh) <<<"
# 明文安装器的标记（用于检测冲突并提示）。
PLAINTEXT_MARK_BEGIN="# >>> csapi env (managed by install-csapi.sh) >>>"

# ---- 小工具 ----------------------------------------------------------------
info()  { printf '\033[1;36m[csapi-secure]\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m[csapi-secure]\033[0m %s\n' "$*" >&2; }
err()   { printf '\033[1;31m[csapi-secure]\033[0m %s\n' "$*" >&2; }
have()  { command -v "$1" >/dev/null 2>&1; }

# ---- 参数解析 --------------------------------------------------------------
MODE="install"     # install | print | uninstall | start | stop | status | service | setup
DO_PROBE=1
DO_CLONE=1
DO_INSTALL=1
DO_BUILD=0
ASSUME_YES="${CSAPI_ASSUME_YES:-0}"
for arg in "$@"; do
  case "$arg" in
    --print) MODE="print" ;;
    --uninstall) MODE="uninstall" ;;
    --start) MODE="start" ;;
    --stop) MODE="stop" ;;
    --status) MODE="status" ;;
    --service) MODE="service" ;;
    --setup) MODE="setup" ;;
    --no-probe) DO_PROBE=0 ;;
    --no-clone) DO_CLONE=0 ;;
    --no-install) DO_INSTALL=0 ;;
    --build) DO_BUILD=1 ;;
    -y|--yes) ASSUME_YES=1 ;;
    -h|--help)
      sed -n '2,60p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "未知参数: $arg（用 --help 查看用法）" >&2; exit 2 ;;
  esac
done

confirm() {
  # confirm "问题" — 返回 0=同意。ASSUME_YES 或无 tty 时默认同意。
  [ "$ASSUME_YES" = "1" ] && return 0
  [ -r /dev/tty ] || return 0
  printf '\033[1;36m[csapi-secure]\033[0m %s [Y/n] ' "$1" > /dev/tty
  IFS= read -r _ans < /dev/tty || _ans=""
  case "$_ans" in n|N|no|NO|No) return 1 ;; *) return 0 ;; esac
}

# ---- 定位仓库（启动 Adapter 需要）------------------------------------------
detect_repo() {
  # 1) 显式指定
  if [ -n "${CSAPI_REPO_DIR:-}" ] && [ -d "$CSAPI_REPO_DIR/apps/secure-adapter" ]; then
    ( cd "$CSAPI_REPO_DIR" && pwd ); return 0
  fi
  # 2) 从脚本位置推断（scripts/csapi/ → 仓库根）
  _sd=""
  case "$0" in
    */*) _sd="$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd)" ;;
  esac
  if [ -n "$_sd" ] && [ -d "$_sd/../../apps/secure-adapter" ]; then
    ( cd "$_sd/../.." && pwd ); return 0
  fi
  # 3) 当前工作目录
  if [ -d "./apps/secure-adapter" ]; then ( pwd ); return 0; fi
  # 4) 之前自动 clone 的目录
  if [ -d "$CLONE_DIR/apps/secure-adapter" ]; then ( cd "$CLONE_DIR" && pwd ); return 0; fi
  return 1
}
REPO_ROOT="$(detect_repo || true)"

# ---- 自动 clone 仓库（找不到源码时）----------------------------------------
clone_repo() {
  if ! have git; then
    warn "未找到 git，无法自动 clone 仓库。请手动 clone 后设 CSAPI_REPO_DIR=/path/to/repo，或装 git 后重试。"
    return 1
  fi
  if [ -d "$CLONE_DIR/.git" ] || [ -d "$CLONE_DIR/apps/secure-adapter" ]; then
    info "复用已存在的 clone: $CLONE_DIR"
    ( cd "$CLONE_DIR" && pwd ); return 0
  fi
  if ! confirm "本机未找到仓库源码。是否自动 clone $REPO_GIT_URL 到 $CLONE_DIR？"; then
    warn "已跳过 clone。可稍后手动 clone 并设 CSAPI_REPO_DIR，或用 --no-clone 静默此提示。"
    return 1
  fi
  mkdir -p "$(dirname "$CLONE_DIR")" 2>/dev/null || true
  info "clone $REPO_GIT_URL → $CLONE_DIR （首次较慢）..."
  if git clone --depth 1 "$REPO_GIT_URL" "$CLONE_DIR" >&2; then
    ( cd "$CLONE_DIR" && pwd ); return 0
  fi
  # 自愈：清理半残目录后自动再试一次（首包被拦 / 中途断线常见）。
  warn "git clone 失败，清理半残目录后自动重试一次..."
  rm -rf "$CLONE_DIR" 2>/dev/null || true
  if git clone --depth 1 "$REPO_GIT_URL" "$CLONE_DIR" >&2; then
    ( cd "$CLONE_DIR" && pwd ); return 0
  fi
  err "git clone 两次均失败（网络 / 仓库可见性 / 认证）。若仓库私有请配好访问权限，或手动 clone 后设 CSAPI_REPO_DIR。"
  return 1
}

# ---- Node 检测 + 自动下载（缺失/版本不足时装到用户目录）--------------------
# node 是否存在且主版本 >= NODE_MIN_MAJOR。
node_ok() {
  have node || return 1
  _mj="$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))' 2>/dev/null || echo 0)"
  [ "$_mj" -ge "$NODE_MIN_MAJOR" ] 2>/dev/null
}

# 输出 "<os> <arch>"（node dist 命名）；不支持的平台返回非 0。
detect_node_platform() {
  _os=""; _arch=""
  case "$(uname -s 2>/dev/null)" in
    Linux)  _os="linux" ;;
    Darwin) _os="darwin" ;;
    *) return 1 ;;
  esac
  case "$(uname -m 2>/dev/null)" in
    x86_64|amd64)   _arch="x64" ;;
    aarch64|arm64)  _arch="arm64" ;;
    armv7l)         _arch="armv7l" ;;
    ppc64le)        _arch="ppc64le" ;;
    s390x)          _arch="s390x" ;;
    *) return 1 ;;
  esac
  printf '%s %s' "$_os" "$_arch"
}

# 下载并解压官方 Node 二进制 tarball 到 $NODE_HOME，刷新 current 软链。
install_node() {
  _ver="$CSAPI_NODE_VERSION"
  case "$_ver" in v*) ;; *) _ver="v$_ver" ;; esac
  if ! have curl; then
    err "未找到 curl，无法自动下载 Node。请装 curl，或手动安装 node>=$NODE_MIN_MAJOR 后重跑。"
    return 1
  fi
  if ! have tar; then
    err "未找到 tar，无法解压 Node。请装 tar，或手动安装 node>=$NODE_MIN_MAJOR 后重跑。"
    return 1
  fi
  _plat="$(detect_node_platform || true)"
  if [ -z "$_plat" ]; then
    err "不支持的 OS/架构（$(uname -s 2>/dev/null)/$(uname -m 2>/dev/null)），无法自动下载 Node。"
    err "请手动安装 node>=$NODE_MIN_MAJOR：https://nodejs.org/download/"
    return 1
  fi
  # shellcheck disable=SC2086
  set -- $_plat
  _os="$1"; _arch="$2"
  _name="node-$_ver-$_os-$_arch"
  # 用 .tar.gz（tar -z 即可解，免依赖 xz）。
  _url="$NODE_DIST_MIRROR/$_ver/$_name.tar.gz"
  mkdir -p "$NODE_HOME" 2>/dev/null || { err "无法创建 $NODE_HOME"; return 1; }
  _tgz="$NODE_HOME/$_name.tar.gz"
  info "自动下载 Node $_ver（$_os-$_arch）→ $NODE_HOME ..."
  info "  来源: $_url"
  if ! curl -fL --retry 2 --connect-timeout 20 --max-time 300 -o "$_tgz" "$_url" >&2; then
    rm -f "$_tgz" 2>/dev/null || true
    err "下载 Node 失败: $_url"
    err "可换镜像重试: CSAPI_NODE_MIRROR=https://mirrors.tuna.tsinghua.edu.cn/nodejs-release sh $0"
    err "或手动下载对应包后解压到 $NODE_HOME/：https://nodejs.org/dist/$_ver/"
    return 1
  fi
  info "解压 Node ..."
  rm -rf "$NODE_HOME/$_name" 2>/dev/null || true
  if ! tar -xzf "$_tgz" -C "$NODE_HOME" 2>/dev/null; then
    err "解压 Node 失败（tar -xzf $_tgz）。文件可能损坏，请重试或换镜像。"
    rm -f "$_tgz" 2>/dev/null || true
    return 1
  fi
  rm -f "$_tgz" 2>/dev/null || true
  if [ ! -x "$NODE_HOME/$_name/bin/node" ]; then
    err "解压后未找到 node 可执行文件（$NODE_HOME/$_name/bin/node）。"
    return 1
  fi
  # 刷新稳定软链 current → 具体版本目录（PATH 只需固定指向 current/bin）。
  rm -rf "$NODE_HOME/current" 2>/dev/null || true
  ln -s "$_name" "$NODE_HOME/current" 2>/dev/null || ln -s "$NODE_HOME/$_name" "$NODE_HOME/current" 2>/dev/null || true
  [ -x "$MANAGED_NODE_BIN/node" ] || return 1
  return 0
}

# 确保有可用 node：满足则直接用；否则复用已托管的、再不行就下载。成功后把 PATH 导出到当前进程。
ensure_node() {
  if node_ok; then return 0; fi
  # 之前托管安装过 → 加进 PATH 复用。
  if [ -x "$MANAGED_NODE_BIN/node" ]; then
    PATH="$MANAGED_NODE_BIN:$PATH"; export PATH
    if node_ok; then
      info "复用已托管的 Node: $(node -v 2>/dev/null)（$MANAGED_NODE_BIN）"
      return 0
    fi
  fi
  if have node; then
    warn "检测到 node $(node -v 2>/dev/null) 版本低于 $NODE_MIN_MAJOR，自动下载 $CSAPI_NODE_VERSION 到用户目录（无需 root）..."
  else
    warn "未找到 node（Adapter 需 node>=$NODE_MIN_MAJOR），自动下载 $CSAPI_NODE_VERSION 到用户目录 $NODE_HOME（无需 root）..."
  fi
  install_node || return 1
  PATH="$MANAGED_NODE_BIN:$PATH"; export PATH
  if node_ok; then
    info "已安装 Node $(node -v 2>/dev/null) → $MANAGED_NODE_BIN（后续 npm/adapter 均用它）。"
    return 0
  fi
  err "自动安装 Node 后仍不可用（PATH: $MANAGED_NODE_BIN）。请手动安装 node>=$NODE_MIN_MAJOR。"
  return 1
}

# ---- 安装依赖 + 可选编译 ---------------------------------------------------
npm_install_repo() {
  _repo="$1"
  # 缺 node 或版本不足：自动下载目标版本到用户目录（不再直接报错让用户自己装）。
  if ! ensure_node; then
    warn "无法准备可用的 Node（>=$NODE_MIN_MAJOR）；仅写配置不受影响，但 Adapter 需要 node 才能启动。"
    return 1
  fi
  if ! have npm; then
    warn "未找到 npm（通常随 Node 一起提供）。请确认 Node 安装完整后在仓库根执行: npm install"
    return 1
  fi
  if [ -x "$_repo/node_modules/.bin/tsx" ] && [ "$DO_BUILD" -ne 1 ]; then
    info "依赖已就绪（存在 node_modules/.bin/tsx），跳过 npm install。"
  else
    info "在仓库根安装依赖: ( cd $_repo && npm install ) （首次较慢）..."
    if ! ( cd "$_repo" && npm install ) >&2; then
      # 自愈：清理可能损坏的 node_modules 后自动再试一次。
      warn "npm install 失败，清理 node_modules 后自动重试一次..."
      rm -rf "$_repo/node_modules" 2>/dev/null || true
      if ! ( cd "$_repo" && npm install ) >&2; then
        err "npm install 两次均失败。请进入 $_repo 手动排查后重试。"
        return 1
      fi
    fi
  fi
  if [ "$DO_BUILD" -eq 1 ]; then
    info "编译 Secure Adapter dist: npm run build -w @cursor-gateway/secure-adapter ..."
    ( cd "$_repo" && npm run build -w @cursor-gateway/secure-adapter ) >&2 || \
      warn "build 失败（不致命：启动器会回退 tsx 直接跑 TS）。"
  fi
  return 0
}

# ---- 准备仓库：detect → clone → install（幂等，供 install/start/service/setup 复用）----
ensure_repo_ready() {
  if [ -z "$REPO_ROOT" ] && [ "$DO_CLONE" -eq 1 ]; then
    REPO_ROOT="$(clone_repo || true)"
  fi
  if [ -z "$REPO_ROOT" ]; then
    warn "未定位到仓库源码：已完成配置，但启动 Adapter 需要仓库（clone 后设 CSAPI_REPO_DIR）。"
    return 1
  fi
  info "仓库: $REPO_ROOT"
  if [ "$DO_INSTALL" -eq 1 ]; then
    npm_install_repo "$REPO_ROOT" || return 1
  fi
  return 0
}

# ---- 选择要写入的 shell rc 文件 --------------------------------------------
detect_rc() {
  _shell_name="$(basename "${SHELL:-}")"
  case "$_shell_name" in
    zsh)  echo "${ZDOTDIR:-$HOME}/.zshrc" ;;
    bash) echo "$HOME/.bashrc" ;;
    *)
      if [ -f "$HOME/.bashrc" ]; then echo "$HOME/.bashrc"
      elif [ -f "$HOME/.zshrc" ]; then echo "$HOME/.zshrc"
      else echo "$HOME/.profile"
      fi ;;
  esac
}

# ---- 固定根指纹：优先仓库公开文件，回退内置常量 ----------------------------
resolve_pinned_roots() {
  _fp=""
  _pub=""
  if [ -n "$REPO_ROOT" ] && [ -f "$REPO_ROOT/scripts/csapi/trust/csapi-trust-root-public.json" ]; then
    _pub="$REPO_ROOT/scripts/csapi/trust/csapi-trust-root-public.json"
  fi
  if [ -n "$_pub" ] && have node; then
    _fp="$(node -e 'try{const f=require(process.argv[1]);console.log((f.trustRoots||[]).map(r=>r.fingerprint).filter(Boolean).join(","))}catch(e){process.exit(0)}' "$_pub" 2>/dev/null || true)"
  elif [ -n "$_pub" ]; then
    # 无 node：从 JSON 里抠 sha256:... 指纹（每行一个）。
    _fp="$(grep -oE 'sha256:[A-Za-z0-9_-]{43}' "$_pub" 2>/dev/null | sort -u | tr '\n' ',' | sed 's/,$//' || true)"
  fi
  [ -n "$_fp" ] || _fp="$BUILTIN_PINNED_ROOTS"
  printf '%s' "$_fp"
}

# ---- 探测 + 核对固定根 -----------------------------------------------------
# 返回 0=OK；非 0=失败（并已打印友好错误）。
probe_and_verify() {
  _pins="$1"
  if ! have curl; then
    warn "未找到 curl，无法探测 /cg/v1/server-keys；请自行确认服务端安全通道已开启。"
    return 0
  fi
  _url="$UPSTREAM_URL/cg/v1/server-keys"
  info "探测 $_url ..."
  _body="$CFG_DIR/.server-keys.probe.$$"
  mkdir -p "$CFG_DIR" 2>/dev/null || true

  # 短暂网络/5xx 抖动 → 有限重试（最多 3 次，指数退避）。
  # 404/426（服务端未开安全通道）与 200（可核对指纹）不重试：前者不可自愈、后者已成功拿到响应。
  _try=1
  _code=000
  while [ "$_try" -le 3 ]; do
    _code="$(curl -sS -o "$_body" -w '%{http_code}' --max-time 20 "$_url" 2>/dev/null || echo 000)"
    case "$_code" in
      000|5??)
        if [ "$_try" -lt 3 ]; then
          warn "探测 server-keys 暂时失败（HTTP $_code），第 $_try/3 次，$_try s 后重试..."
          sleep "$_try"
        fi
        ;;
      *) break ;;
    esac
    _try=$((_try + 1))
  done

  if [ "$_code" = "404" ] || [ "$_code" = "426" ]; then
    rm -f "$_body"
    err "服务端未开启 cg-mitm 安全通道（/cg/v1/server-keys 返回 HTTP $_code）。"
    err "这是**运维前置**，不是本机问题。请联系 csapi 管理员开启服务端安全通道："
    err "  · 需 CG_SECURE_ENABLED=true 且下发由固定根签发的服务端证书；"
    err "  · 保持 CG_REQUIRE_SECURE=false，让明文 /v1/* 与安全 /cg/v1/* 并行灰度。"
    err "  · 服务端下发的根指纹要与本安装器固定的一致：$_pins"
    err "开启后重跑本脚本即可。（如需先预置配置：加 --no-probe 跳过探测。）"
    return 3
  fi
  if [ "$_code" = "000" ]; then
    rm -f "$_body"
    err "无法连接 $_url（网络不可达 / DNS / 出口被拦）。请检查网络后重试。"
    return 4
  fi
  if [ "$_code" != "200" ]; then
    rm -f "$_body"
    err "/cg/v1/server-keys 返回 HTTP $_code（预期 200）。请联系管理员核实服务端状态。"
    return 5
  fi

  # 200：核对返回的 trustRoots 指纹里，至少有一个是我们固定的。
  _adv=""
  if have node; then
    _adv="$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log((j.trustRoots||[]).map(r=>r.fingerprint).filter(Boolean).join("\n"))}catch(e){}})' < "$_body" 2>/dev/null || true)"
  else
    _adv="$(grep -oE 'sha256:[A-Za-z0-9_-]{43}' "$_body" 2>/dev/null | sort -u || true)"
  fi
  rm -f "$_body"

  if [ -z "$_adv" ]; then
    err "server-keys 未包含任何 trustRoots 指纹，无法核对信任根 → 拒绝配置（fail-closed）。"
    return 6
  fi

  _matched=0
  # $_pins 是逗号分隔；逐个在 advertised 列表里找。
  _old_ifs="$IFS"; IFS=','
  for _p in $_pins; do
    [ -n "$_p" ] || continue
    if printf '%s\n' "$_adv" | grep -qxF "$_p"; then _matched=1; break; fi
  done
  IFS="$_old_ifs"

  if [ "$_matched" -ne 1 ]; then
    err "服务端下发的信任根指纹与本安装器固定的不一致 → 疑似 MITM 或服务端配置了不同的根。"
    err "  固定（期望之一）: $_pins"
    err "  服务端下发:       $(printf '%s' "$_adv" | tr '\n' ' ')"
    err "已拒绝写入任何配置（fail-closed）。请与管理员 out-of-band 核对根指纹。"
    return 7
  fi
  info "server-keys OK：固定根指纹匹配 ✅（anti-MITM 信任锚已核对）。"
  return 0
}

# ---- 生成 loopback key ------------------------------------------------------
gen_loopback_key() {
  if have openssl; then openssl rand -hex 24 2>/dev/null && return 0; fi
  if [ -r /dev/urandom ]; then
    _k="$(head -c 24 /dev/urandom 2>/dev/null | od -An -tx1 2>/dev/null | tr -d ' \n')"
    [ -n "$_k" ] && { printf '%s' "$_k"; return 0; }
  fi
  printf 'loopback-%s-%s' "$(date +%s 2>/dev/null || echo 0)" "$$"
}

# ---- 读取真实 CSAPI key（环境变量 > 交互）---------------------------------
resolve_key() {
  _k="${CSAPI_API_KEY:-${CG_ADAPTER_API_KEY:-${API_KEY:-}}}"
  if [ -n "$_k" ]; then printf '%s' "$_k"; return 0; fi
  if [ -r /dev/tty ]; then
    printf '\033[1;36m[csapi-secure]\033[0m 请输入你的真实 CSAPI API key（输入不显示，仅存本机 0600）: ' > /dev/tty
    _old_stty="$(stty -g 2>/dev/null || true)"
    stty -echo 2>/dev/null || true
    IFS= read -r _k < /dev/tty
    stty "${_old_stty:-echo}" 2>/dev/null || stty echo 2>/dev/null || true
    printf '\n' > /dev/tty
  else
    err "无可用 tty，请改用: CSAPI_API_KEY=xxxx sh install-csapi-secure.sh"
    exit 1
  fi
  printf '%s' "$_k"
}

# ---- 组装 rc 受管块（CLI 指向本机 Adapter）--------------------------------
render_rc_block() {
  _lk="$1"
  printf '%s\n' "$MARK_BEGIN"
  printf '%s\n' "# cg-mitm/1 Secure Adapter：CLI 指向本机 loopback 门面，密文发往 csapi。"
  printf '%s\n' "# 真实 CSAPI key 不在这里（在 $ENV_FILE，0600）；这里用的是本地 loopback key。"
  # 托管 Node（自动下载到用户目录）→ 持久化进 PATH，新终端也能跑 node/npm。
  if [ -x "$MANAGED_NODE_BIN/node" ]; then
    printf '%s\n' "# 托管 Node（缺 node 时自动下载到用户目录）加入 PATH。"
    printf '%s\n' "export PATH=\"$MANAGED_NODE_BIN:\$PATH\""
  fi
  printf '%s\n' "export ANTHROPIC_BASE_URL=\"$ADAPTER_LOCAL_BASE\""
  printf '%s\n' "export ANTHROPIC_API_KEY=\"$_lk\""
  printf '%s\n' "export OPENAI_BASE_URL=\"$ADAPTER_LOCAL_BASE/v1\""
  printf '%s\n' "export OPENAI_API_KEY=\"$_lk\""
  printf '%s\n' "$MARK_END"
}

write_rc_block() {
  _rc="$1"; _lk="$2"
  touch "$_rc" 2>/dev/null || { err "无法写入 $_rc"; exit 1; }
  if grep -qF "$PLAINTEXT_MARK_BEGIN" "$_rc" 2>/dev/null; then
    warn "检测到 install-csapi.sh 的明文受管块；本安全块写在其后会覆盖它（后写生效）。"
    warn "如需彻底清理明文块：sh scripts/csapi/install-csapi.sh --uninstall"
  fi
  _tmp="$(mktemp 2>/dev/null || echo "${_rc}.csapi.tmp.$$")"
  awk -v b="$MARK_BEGIN" -v e="$MARK_END" '
    $0==b {skip=1; next}
    $0==e {skip=0; next}
    skip!=1 {print}
  ' "$_rc" > "$_tmp" 2>/dev/null || { err "处理 $_rc 失败"; rm -f "$_tmp"; exit 1; }
  {
    cat "$_tmp"
    printf '\n'
    render_rc_block "$_lk"
  } > "${_tmp}.2" 2>/dev/null
  mv "${_tmp}.2" "$_rc" 2>/dev/null || { err "写回 $_rc 失败"; rm -f "$_tmp" "${_tmp}.2"; exit 1; }
  rm -f "$_tmp"
  chmod 600 "$_rc" 2>/dev/null || true
}

remove_rc_block() {
  _rc="$1"
  [ -f "$_rc" ] || { info "未找到 $_rc，无需清理。"; return 0; }
  _tmp="$(mktemp 2>/dev/null || echo "${_rc}.csapi.tmp.$$")"
  awk -v b="$MARK_BEGIN" -v e="$MARK_END" '
    $0==b {skip=1; next}
    $0==e {skip=0; next}
    skip!=1 {print}
  ' "$_rc" > "$_tmp" && mv "$_tmp" "$_rc"
  info "已从 $_rc 移除 secure adapter 受管块。"
}

# ---- 写本机 Adapter 配置 env ------------------------------------------------
write_env_file() {
  _key="$1"; _lk="$2"; _pins="$3"
  mkdir -p "$CFG_DIR" 2>/dev/null || { err "无法创建 $CFG_DIR"; exit 1; }
  chmod 700 "$CFG_DIR" 2>/dev/null || true
  umask 077
  cat > "$ENV_FILE" <<EOF
# managed by install-csapi-secure.sh — 含真实 CSAPI key。chmod 600，切勿提交 git。
CG_ADAPTER_UPSTREAM_URL=$UPSTREAM_URL
CG_ADAPTER_LISTEN_HOST=$LISTEN_HOST
CG_ADAPTER_LISTEN_PORT=$LISTEN_PORT
CG_ADAPTER_LOOPBACK_KEY=$_lk
CG_ADAPTER_API_KEY=$_key
CG_ADAPTER_PINNED_ROOTS=$_pins
CG_ADAPTER_STATE_FILE=$STATE_FILE
EOF
  chmod 600 "$ENV_FILE" 2>/dev/null || true
  info "已写本机 Adapter 配置: $ENV_FILE (0600)"
}

# ---- 写启动器 --------------------------------------------------------------
write_launcher() {
  mkdir -p "$CFG_DIR" 2>/dev/null || true
  cat > "$LAUNCHER" <<EOF
#!/usr/bin/env bash
# managed by install-csapi-secure.sh — 加载本机 Adapter 配置并启动 cg-mitm/1 Adapter。
set -euo pipefail
ENV_FILE="$ENV_FILE"
# 安装时已经验证并规范化仓库路径。启动器固定使用该路径，避免 systemd
# 环境中遗留的 CSAPI_REPO_DIR 把有效路径覆盖成 Windows 路径或旧目录。
REPO_ROOT="$REPO_ROOT"
# 托管 Node（缺 node 时由安装器自动下载到用户目录）优先加入 PATH。
MANAGED_NODE_BIN="$MANAGED_NODE_BIN"
if [ -x "\$MANAGED_NODE_BIN/node" ]; then
  PATH="\$MANAGED_NODE_BIN:\$PATH"; export PATH
fi
if [ ! -f "\$ENV_FILE" ]; then
  echo "[secure-adapter] 缺少配置 \$ENV_FILE，请先运行 install-csapi-secure.sh" >&2
  exit 1
fi
if [ -z "\$REPO_ROOT" ] || [ ! -d "\$REPO_ROOT/apps/secure-adapter" ]; then
  echo "[secure-adapter] 找不到仓库（apps/secure-adapter）。请 clone 仓库并设 CSAPI_REPO_DIR=/path/to/repo。" >&2
  exit 1
fi
set -a
# shellcheck disable=SC1090
. "\$ENV_FILE"
set +a
exec "\$REPO_ROOT/scripts/csapi/run-secure-adapter.sh"
EOF
  chmod 700 "$LAUNCHER" 2>/dev/null || true
  info "已写启动器: $LAUNCHER"
}

# ---- systemd --user 自启 ----------------------------------------------------
systemd_user_ok() {
  have systemctl || return 1
  systemctl --user show-environment >/dev/null 2>&1
}

install_service() {
  if ! systemd_user_ok; then
    warn "当前环境没有可用的 systemd --user（可能是容器/无 user D-Bus）。回退到 nohup 后台启动。"
    start_adapter
    return $?
  fi
  [ -f "$LAUNCHER" ] || { err "缺少启动器 $LAUNCHER，请先完成安装。"; return 1; }
  mkdir -p "$SERVICE_DIR" 2>/dev/null || true
  cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=cg-mitm/1 Secure Adapter (anti-MITM csapi client)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$LAUNCHER
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF
  info "已写 systemd --user 单元: $SERVICE_FILE"
  systemctl --user daemon-reload 2>/dev/null || true
  if systemctl --user enable --now "$SERVICE_NAME" 2>/dev/null; then
    info "已注册并启动服务（开机自启）: systemctl --user status $SERVICE_NAME"
    if have loginctl; then
      warn "如希望登出后仍运行，可执行: loginctl enable-linger $USER"
    fi
  else
    err "systemctl --user enable --now 失败。看日志: journalctl --user -u $SERVICE_NAME -e"
    return 1
  fi
}

# ---- 后台启停（nohup 回退路径）--------------------------------------------
adapter_running() {
  [ -f "$PID_FILE" ] || return 1
  _pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  [ -n "$_pid" ] || return 1
  kill -0 "$_pid" 2>/dev/null
}

service_active() {
  systemd_user_ok || return 1
  [ -f "$SERVICE_FILE" ] || return 1
  systemctl --user is-active --quiet "$SERVICE_NAME"
}

start_adapter() {
  # 优先 systemd 服务（已安装）。
  if systemd_user_ok && [ -f "$SERVICE_FILE" ]; then
    systemctl --user start "$SERVICE_NAME" 2>/dev/null && { info "已通过 systemd 启动服务。"; return 0; }
  fi
  [ -f "$LAUNCHER" ] || { err "缺少启动器 $LAUNCHER，请先安装。"; exit 1; }
  if adapter_running; then info "Adapter 已在运行 (pid $(cat "$PID_FILE"))。"; return 0; fi
  info "后台启动 Adapter → 日志 $LOG_FILE"
  # 用 nohup 脱离终端；stdout/stderr 落日志。
  nohup "$LAUNCHER" >> "$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
  sleep 2
  if adapter_running; then
    info "Adapter 启动成功 (pid $(cat "$PID_FILE"))，监听 $ADAPTER_LOCAL_BASE"
  else
    err "Adapter 启动后很快退出（多半是 fail-closed）。看日志: tail -n 50 $LOG_FILE"
    tail -n 20 "$LOG_FILE" 2>/dev/null >&2 || true
    return 1
  fi
}

stop_adapter() {
  if systemd_user_ok && [ -f "$SERVICE_FILE" ]; then
    systemctl --user stop "$SERVICE_NAME" 2>/dev/null || true
    info "已停止 systemd 服务（如在运行）。"
  fi
  if ! adapter_running; then rm -f "$PID_FILE"; return 0; fi
  _pid="$(cat "$PID_FILE")"
  kill "$_pid" 2>/dev/null || true
  sleep 1
  kill -9 "$_pid" 2>/dev/null || true
  rm -f "$PID_FILE"
  info "已停止 Adapter (pid $_pid)。"
}

status_adapter() {
  if service_active; then
    info "Adapter 运行中（systemd --user 服务 $SERVICE_NAME），监听 $ADAPTER_LOCAL_BASE"
  elif adapter_running; then
    info "Adapter 运行中（nohup，pid $(cat "$PID_FILE")），监听 $ADAPTER_LOCAL_BASE"
  else
    info "Adapter 未运行。启动: sh install-csapi-secure.sh --start（或 --service 注册自启）"
  fi
  if have curl; then
    _h="$(curl -fsS --max-time 5 "$ADAPTER_LOCAL_BASE/health" 2>/dev/null || true)"
    [ -n "$_h" ] && info "health: $_h"
  fi
  [ -f "$ENV_FILE" ] && info "配置: $ENV_FILE" || info "尚无配置（未安装）。"
  [ -f "$SERVICE_FILE" ] && info "服务单元: $SERVICE_FILE"
}

remove_service() {
  [ -f "$SERVICE_FILE" ] || return 0
  if systemd_user_ok; then
    systemctl --user disable --now "$SERVICE_NAME" 2>/dev/null || true
  fi
  rm -f "$SERVICE_FILE" 2>/dev/null || true
  systemd_user_ok && systemctl --user daemon-reload 2>/dev/null || true
  info "已移除 systemd --user 服务单元。"
}

# ---- 自愈：健康检查 / 端口探测 / 有限次修复循环 ----------------------------
# 说明：脚本作为子进程运行，无法修改父 shell 的环境变量；但**健康验证不依赖父
# shell**——直接打本机 loopback /health 即可确认 Adapter 真的活着。因此“已验证通过”
# 由脚本自己完成，与当前终端是否已 source rc 无关。

# 直接打 /health，成功时把响应体打到 stdout。
health_body() {
  have curl || return 1
  curl -fsS --max-time 5 "$ADAPTER_LOCAL_BASE/health" 2>/dev/null
}

# /health 是否为健康的 cg-mitm Adapter。
health_ok() {
  _h="$(health_body)" || return 1
  [ -n "$_h" ] || return 1
  case "$_h" in
    *'"ok":true'*|*'"ok": true'*|*cg-mitm*) return 0 ;;
    *) return 1 ;;
  esac
}

# 从 /health 响应提取 upstream 字段（用于核对 BASE_URL 是否一致）。
health_upstream() {
  _h="$(health_body)" || return 1
  [ -n "$_h" ] || return 1
  if have node; then
    printf '%s' "$_h" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);if(j.upstream)console.log(String(j.upstream).replace(/\/$/,""))}catch(e){}})' 2>/dev/null
  else
    printf '%s' "$_h" | grep -oE '"upstream"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n1 | sed 's/.*"\([^"]*\)".*/\1/' | sed 's/\/$//'
  fi
}

# 打印一行 health JSON 摘要（尽量用 node 美化，回退原样）。
health_summary() {
  _h="$(health_body)" || return 1
  [ -n "$_h" ] || return 1
  if have node; then
    printf '%s' "$_h" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log(`ok=${j.ok} mode=${j.mode} upstream=${j.upstream} deviceId=${(j.deviceId||"").slice(0,12)}…`)}catch(e){console.log(s.trim())}})' 2>/dev/null || printf '%s' "$_h"
  else
    printf '%s' "$_h"
  fi
}

# 端口是否被占用（任何进程）。
port_busy() {
  _p="$1"
  if have ss;      then ss -ltn 2>/dev/null      | grep -qE "[:.]$_p[[:space:]]" && return 0; return 1; fi
  if have lsof;    then lsof -iTCP:"$_p" -sTCP:LISTEN >/dev/null 2>&1 && return 0; return 1; fi
  if have netstat; then netstat -ltn 2>/dev/null | grep -qE "[:.]$_p[[:space:]]" && return 0; return 1; fi
  # 回退：能连上 /health 也算占用。
  if have curl && curl -fsS --max-time 2 "http://$LISTEN_HOST:$_p/health" >/dev/null 2>&1; then return 0; fi
  return 1
}

# 找一个空闲端口（换端口自愈用）。
find_free_port() {
  for _cand in 8788 8789 8790 8791 8890 9788 18788 28788; do
    [ "$_cand" = "$LISTEN_PORT" ] && continue
    port_busy "$_cand" || { printf '%s' "$_cand"; return 0; }
  done
  return 1
}

# 在脚本自身进程内 export（供自检/子进程用；无法影响父 shell）。
export_current_session() {
  ANTHROPIC_BASE_URL="$ADAPTER_LOCAL_BASE"; export ANTHROPIC_BASE_URL
  ANTHROPIC_API_KEY="$LOOPBACK_KEY";        export ANTHROPIC_API_KEY
  OPENAI_BASE_URL="$ADAPTER_LOCAL_BASE/v1"; export OPENAI_BASE_URL
  OPENAI_API_KEY="$LOOPBACK_KEY";           export OPENAI_API_KEY
}

# upstream / rc 与当前 CSAPI_BASE_URL 不一致时，重写 env + 启动器 + rc 受管块。
sync_upstream_if_needed() {
  _need=0
  if [ -f "$ENV_FILE" ]; then
    _saved="$(grep '^CG_ADAPTER_UPSTREAM_URL=' "$ENV_FILE" 2>/dev/null | head -n1 | cut -d= -f2- | sed 's/\/$//' || true)"
    [ -n "$_saved" ] && [ "$_saved" != "$UPSTREAM_URL" ] && _need=1
  fi
  if [ "$_need" -eq 0 ] && health_ok; then
    _hu="$(health_upstream 2>/dev/null || true)"
    [ -n "$_hu" ] && [ "$_hu" != "$UPSTREAM_URL" ] && _need=1
  fi
  if [ "$_need" -eq 1 ]; then
    warn "检测到 upstream/BASE_URL 不一致（期望 $UPSTREAM_URL），重写 env 与 rc..."
    write_env_file "$KEY" "$LOOPBACK_KEY" "$PINS"
    write_launcher
    RC="$(detect_rc)"
    write_rc_block "$RC" "$LOOPBACK_KEY"
    export_current_session
    return 0
  fi
  return 1
}

# 换端口自愈：更新全局 + 重写 env / 启动器 / rc 受管块。
switch_port() {
  _newport="$1"
  warn "端口 $LISTEN_PORT 仍被占用，切换到空闲端口 $_newport 并同步更新配置。"
  LISTEN_PORT="$_newport"
  ADAPTER_LOCAL_BASE="http://$LISTEN_HOST:$LISTEN_PORT"
  write_env_file "$KEY" "$LOOPBACK_KEY" "$PINS"
  write_launcher
  RC="$(detect_rc)"
  write_rc_block "$RC" "$LOOPBACK_KEY"
  export_current_session
}

# 收尾自愈：确保 Adapter 起来且 /health 通过；失败则在有限次内自动修复。
# 依赖主流程已设的全局：KEY / LOOPBACK_KEY / PINS / REPO_ROOT。返回 0=健康。
verify_and_heal() {
  if ! have curl; then
    warn "未找到 curl，无法自检 /health；跳过自愈（请自行 curl $ADAPTER_LOCAL_BASE/health 验证）。"
    start_adapter || true
    return 0
  fi

  _max=3
  _i=1
  while [ "$_i" -le "$_max" ]; do
    info "自检 [$_i/$_max]：GET $ADAPTER_LOCAL_BASE/health ..."
    if health_ok; then return 0; fi

    warn "health 未通过，进入自动修复（第 $_i/$_max 次）..."

    # 1) 缺仓库源码 → 自动 clone + 装依赖。
    if [ -z "$REPO_ROOT" ] || [ ! -d "$REPO_ROOT/apps/secure-adapter" ]; then
      warn "缺少仓库源码（apps/secure-adapter），自动准备（clone + install）..."
      ensure_repo_ready || true
    fi

    # 2) node_modules/tsx 缺失 → 自动重装依赖。
    if [ -n "$REPO_ROOT" ] && [ ! -x "$REPO_ROOT/node_modules/.bin/tsx" ] && ! have tsx; then
      warn "缺少 node_modules/tsx，自动重装依赖..."
      npm_install_repo "$REPO_ROOT" || true
    fi

    # 2b) upstream/BASE_URL 与 env 或运行中 Adapter 不一致 → 重写配置。
    sync_upstream_if_needed || true

    # 2c) 第 2 轮起尝试编译 dist（tsx 启动失败时常见）。
    if [ "$_i" -ge 2 ] && [ -n "$REPO_ROOT" ]; then
      warn "尝试编译 Secure Adapter dist（自愈 build）..."
      DO_BUILD=1 npm_install_repo "$REPO_ROOT" || true
    fi

    # 3) 端口占用但不是健康 Adapter → 停旧；仍占用则换端口。
    if port_busy "$LISTEN_PORT" && ! health_ok; then
      warn "端口 $LISTEN_PORT 被占用但不是健康的 Adapter，尝试停旧进程..."
      stop_adapter 2>/dev/null || true
      sleep 1
      if port_busy "$LISTEN_PORT"; then
        _np="$(find_free_port || true)"
        [ -n "$_np" ] && switch_port "$_np"
      fi
    fi

    # 4) (重)启动 Adapter。
    if adapter_running || service_active; then
      info "重启现有 Adapter..."
      stop_adapter 2>/dev/null || true
      sleep 1
    fi
    start_adapter || true

    # 5) 就绪轮询（最多 ~12s）。
    _w=0
    while [ "$_w" -lt 12 ]; do
      health_ok && break
      sleep 1
      _w=$((_w + 1))
    done
    health_ok && return 0

    _i=$((_i + 1))
  done
  return 1
}

# ============================ 主流程 =======================================
info "cg-mitm/1 Secure Adapter 安装器"
info "上游 csapi: $UPSTREAM_URL   本机 Adapter: $ADAPTER_LOCAL_BASE"

case "$MODE" in
  status) status_adapter; exit 0 ;;
  stop)   stop_adapter; exit 0 ;;
  uninstall)
    RC="$(detect_rc)"
    remove_rc_block "$RC"
    remove_service
    stop_adapter 2>/dev/null || true
    rm -f "$ENV_FILE" "$LAUNCHER" "$PID_FILE" 2>/dev/null || true
    info "已移除配置/启动器/服务（保留 $STATE_FILE 设备状态；如需清理请手动删除）。"
    info "自动 clone 的仓库 $CLONE_DIR 未删除（如需清理请手动 rm -rf）。"
    info "完成。请重开终端或: unset ANTHROPIC_BASE_URL ANTHROPIC_API_KEY OPENAI_BASE_URL OPENAI_API_KEY"
    exit 0 ;;
  setup)
    # 只准备仓库（clone + npm install [+ build]），不写配置。
    if ensure_repo_ready; then
      info "仓库已就绪 ✅  可继续: sh install-csapi-secure.sh --start"
      exit 0
    fi
    exit 1 ;;
esac

# print 模式先解析 pins（可能需要仓库里的 trust 文件，但不 clone/装依赖）。
if [ "$MODE" = "print" ]; then
  PINS="$(resolve_pinned_roots)"
  info "固定根指纹: $PINS"
  [ -n "$REPO_ROOT" ] && info "仓库: $REPO_ROOT" || warn "未定位到仓库源码（--print 不会 clone）。"
  LOOPBACK_KEY="${CG_ADAPTER_LOOPBACK_KEY:-}"
  if [ -z "$LOOPBACK_KEY" ] && [ -f "$ENV_FILE" ]; then
    LOOPBACK_KEY="$(grep '^CG_ADAPTER_LOOPBACK_KEY=' "$ENV_FILE" 2>/dev/null | head -n1 | cut -d= -f2- || true)"
  fi
  [ -n "$LOOPBACK_KEY" ] || LOOPBACK_KEY="$(gen_loopback_key)"
  info "以下为将写入的配置（--print：未写任何文件）:"
  echo
  echo "# ~/.cursor-gateway/secure-adapter.env"
  echo "CG_ADAPTER_UPSTREAM_URL=$UPSTREAM_URL"
  echo "CG_ADAPTER_LISTEN_HOST=$LISTEN_HOST"
  echo "CG_ADAPTER_LISTEN_PORT=$LISTEN_PORT"
  echo "CG_ADAPTER_LOOPBACK_KEY=$LOOPBACK_KEY"
  echo "CG_ADAPTER_API_KEY=<你的真实 CSAPI key>"
  echo "CG_ADAPTER_PINNED_ROOTS=$PINS"
  echo "CG_ADAPTER_STATE_FILE=$STATE_FILE"
  echo
  echo "# shell rc 受管块（CLI 指向本机 Adapter）"
  render_rc_block "$LOOPBACK_KEY" | grep -v '^#'
  echo
  exit 0
fi

# --- install / start / service 共同前置 ---
# 1) 先探测核对（fail-closed / 友好报错）：服务端没开安全通道就不必 clone/装依赖，快速失败。
#    pins 用本地仓库公开文件（若已在仓库内）或内置常量作信任锚，两者指纹一致。
PINS="$(resolve_pinned_roots)"
info "固定根指纹: $PINS"

if [ "$DO_PROBE" -eq 1 ]; then
  if ! probe_and_verify "$PINS"; then
    exit 3
  fi
else
  warn "已跳过 server-keys 探测（--no-probe）：未核对服务端安全通道与根指纹。"
fi

# 2) 探测通过后再准备仓库（clone + install），启动即可用。
ensure_repo_ready || true
# 仓库可能是刚 clone 的：用仓库内公开文件复核一次 pins（与内置一致）。
PINS="$(resolve_pinned_roots)"

LOOPBACK_KEY="${CG_ADAPTER_LOOPBACK_KEY:-}"
# 复用已有 loopback key（幂等：重复安装不换 key，避免旧终端失效）。
if [ -z "$LOOPBACK_KEY" ] && [ -f "$ENV_FILE" ]; then
  LOOPBACK_KEY="$(grep '^CG_ADAPTER_LOOPBACK_KEY=' "$ENV_FILE" 2>/dev/null | head -n1 | cut -d= -f2- || true)"
fi
[ -n "$LOOPBACK_KEY" ] || LOOPBACK_KEY="$(gen_loopback_key)"

KEY="$(resolve_key)"
[ -n "$KEY" ] || { err "未提供 API key，已取消。"; exit 1; }

write_env_file "$KEY" "$LOOPBACK_KEY" "$PINS"
write_launcher

RC="$(detect_rc)"
info "写入 shell 配置: $RC"
write_rc_block "$RC" "$LOOPBACK_KEY"
info "已写受管块（幂等：重复运行只更新，不堆叠）。"

# ---- 收尾：不只打印“下一步”，而是自己拉起 + 自检 + 自愈 --------------------
# 无论 install / start / service，都在脚本内 export（自检用）、确保 Adapter 起来、
# 打 /health 验证；失败进入有限次修复循环（clone/装依赖/停旧/换端口/重启）。
export_current_session

# --service：先注册自启（内部会启动，或无 systemd 时回退 nohup）。
[ "$MODE" = "service" ] && { install_service || true; }

if verify_and_heal; then
  echo
  info "已验证通过 ✅  本机 Adapter /health 正常，监听 $ADAPTER_LOCAL_BASE"
  info "health: $(health_summary)"
  info "CLI 变量：新终端自动生效；当前交互式终端如需立即生效: . \"$RC\""
  info "安全：真实 key 只在 $ENV_FILE(0600) 与密文 envelope 内；中间人只见 cg-mitm/1 密文。fail-closed，绝不回退明文。"
  exit 0
fi

# 到这里：已自动修复 3 次仍未通过 /health → 给出最可能的“真·不可自愈”原因（需人工）。
echo
err "已自动修复 3 次仍无法让 Adapter 通过 /health。最可能的原因（需人工处理）："
if ! node_ok; then
  err "  · 未获得可用 node（>=$NODE_MIN_MAJOR）：自动下载 $CSAPI_NODE_VERSION 失败（网络/镜像/平台不支持）。"
  err "    可换镜像重试：CSAPI_NODE_MIRROR=https://mirrors.tuna.tsinghua.edu.cn/nodejs-release sh $0"
  err "    或手动装 node>=$NODE_MIN_MAJOR 后重跑；也可把官方包解压到 $NODE_HOME/ 再重跑。"
elif [ -z "$REPO_ROOT" ] || [ ! -d "$REPO_ROOT/apps/secure-adapter" ]; then
  err "  · 未能获取仓库源码（clone 失败或被 --no-clone 关闭）。装好 git+网络、或设 CSAPI_REPO_DIR 后重跑。"
else
  err "  · Adapter 启动后 fail-closed（多为服务端未开安全通道 / 证书 / 根指纹问题）。日志尾部："
  tail -n 20 "$LOG_FILE" 2>/dev/null | sed 's/^/      /' >&2 || true
  err "  · 亦可先用方案 B（明文兼容）临时试用：sh scripts/csapi/install-csapi.sh"
fi
exit 1
