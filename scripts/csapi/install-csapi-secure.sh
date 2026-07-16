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
# 本脚本会：
#   1) 读取你的**真实 CSAPI key**（仅存本机 0600 配置，永不进 git、永不进 HTTP header）；
#   2) 探测 /cg/v1/server-keys 并核对固定根指纹（防 MITM / 防配错服务端）；
#   3) 写本机 Adapter 配置          ~/.cursor-gateway/secure-adapter.env (0600)
#      + 启动器                     ~/.cursor-gateway/start-secure-adapter.sh (0700)；
#   4) 幂等写 shell 配置：把 CLI 的 ANTHROPIC_*/OPENAI_* 指向本机 Adapter（用 loopback key）。
#
# 用法：
#   sh install-csapi-secure.sh                       # 交互式（提示输入真实 key）
#   CSAPI_API_KEY=sk-xxxx sh install-csapi-secure.sh # 非交互
#   sh install-csapi-secure.sh --print               # 只打印配置，不写文件
#   sh install-csapi-secure.sh --start               # 安装后立即后台启动 Adapter
#   sh install-csapi-secure.sh --status              # 查看 Adapter 状态
#   sh install-csapi-secure.sh --stop                # 停止后台 Adapter
#   sh install-csapi-secure.sh --uninstall           # 移除 rc 块 + 本机配置/启动器
#   sh install-csapi-secure.sh --no-probe            # 跳过 server-keys 探测（高级/预置）
#
# 与 install-csapi.sh 的关系：两者写入**不同的**受管块；本脚本的块在 rc 中靠后，
# 因此会覆盖明文安装器的 ANTHROPIC_*/OPENAI_*（后写生效）。二选一即可。
#
# 前置：Secure Adapter 需要仓库源码（apps/secure-adapter + 已装依赖，node>=22）。
#   纯 curl|sh 单文件只能完成「配置 + 探测」，启动 Adapter 仍需 clone 仓库并 npm install。
#   仓库路径自动从脚本位置推断；也可用 CSAPI_REPO_DIR=/path/to/repo 显式指定。
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

CFG_DIR="${CSAPI_SECURE_HOME:-$HOME/.cursor-gateway}"
ENV_FILE="$CFG_DIR/secure-adapter.env"
LAUNCHER="$CFG_DIR/start-secure-adapter.sh"
STATE_FILE="$CFG_DIR/cg-mitm-adapter-state.json"
PID_FILE="$CFG_DIR/secure-adapter.pid"
LOG_FILE="$CFG_DIR/secure-adapter.log"

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
MODE="install"     # install | print | uninstall | start | stop | status
DO_PROBE=1
for arg in "$@"; do
  case "$arg" in
    --print) MODE="print" ;;
    --uninstall) MODE="uninstall" ;;
    --start) MODE="start" ;;
    --stop) MODE="stop" ;;
    --status) MODE="status" ;;
    --no-probe) DO_PROBE=0 ;;
    -h|--help)
      sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "未知参数: $arg（用 --help 查看用法）" >&2; exit 2 ;;
  esac
done

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
  return 1
}
REPO_ROOT="$(detect_repo || true)"

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
  _code="$(curl -sS -o "$_body" -w '%{http_code}' --max-time 20 "$_url" 2>/dev/null || echo 000)"

  if [ "$_code" = "404" ] || [ "$_code" = "426" ]; then
    rm -f "$_body"
    err "服务端未开启 cg-mitm 安全通道（/cg/v1/server-keys 返回 HTTP $_code）。"
    err "这是**运维前置**，不是本机问题。请让 csapi 管理员在 VPS 上完成："
    err "  1) 离线机器用 Ed25519 根签发服务端身份证书（allowedOrigins 含 $UPSTREAM_URL）："
    err "       scripts/csapi/dev-cg-mitm-setup.sh $UPSTREAM_URL"
    err "  2) 把打印的 CG_* 写入 csapi 的 .env 并重启，且必须开启："
    err "       CG_SECURE_ENABLED=true"
    err "       CG_SERVER_CERT_FILE / CG_SERVER_HPKE_KEY_FILE / CG_SERVER_SIGNING_KEY_FILE / CG_TRUST_ROOTS_FILE"
    err "     （保持 CG_REQUIRE_SECURE=false，让明文 /v1/* 与安全 /cg/v1/* 并行灰度）"
    err "  3) 该根的公钥要与本安装器固定的指纹一致：$_pins"
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
  cat <<EOF
$MARK_BEGIN
# cg-mitm/1 Secure Adapter：CLI 指向本机 loopback 门面，密文发往 csapi。
# 真实 CSAPI key 不在这里（在 $ENV_FILE，0600）；这里用的是本地 loopback key。
export ANTHROPIC_BASE_URL="$ADAPTER_LOCAL_BASE"
export ANTHROPIC_API_KEY="$_lk"
export OPENAI_BASE_URL="$ADAPTER_LOCAL_BASE/v1"
export OPENAI_API_KEY="$_lk"
$MARK_END
EOF
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
REPO_ROOT="\${CSAPI_REPO_DIR:-$REPO_ROOT}"
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

# ---- 后台启停 --------------------------------------------------------------
adapter_running() {
  [ -f "$PID_FILE" ] || return 1
  _pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  [ -n "$_pid" ] || return 1
  kill -0 "$_pid" 2>/dev/null
}

start_adapter() {
  [ -f "$LAUNCHER" ] || { err "缺少启动器 $LAUNCHER，请先安装（不带 --start）。"; exit 1; }
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
  if ! adapter_running; then info "Adapter 未在运行。"; rm -f "$PID_FILE"; return 0; fi
  _pid="$(cat "$PID_FILE")"
  kill "$_pid" 2>/dev/null || true
  sleep 1
  kill -9 "$_pid" 2>/dev/null || true
  rm -f "$PID_FILE"
  info "已停止 Adapter (pid $_pid)。"
}

status_adapter() {
  if adapter_running; then
    info "Adapter 运行中 (pid $(cat "$PID_FILE"))，监听 $ADAPTER_LOCAL_BASE"
    if have curl; then
      _h="$(curl -fsS --max-time 5 "$ADAPTER_LOCAL_BASE/health" 2>/dev/null || true)"
      [ -n "$_h" ] && info "health: $_h"
    fi
  else
    info "Adapter 未运行。启动: sh install-csapi-secure.sh --start（或直接跑 $LAUNCHER）"
  fi
  [ -f "$ENV_FILE" ] && info "配置: $ENV_FILE" || info "尚无配置（未安装）。"
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
    stop_adapter 2>/dev/null || true
    rm -f "$ENV_FILE" "$LAUNCHER" "$PID_FILE" 2>/dev/null || true
    info "已移除配置/启动器（保留 $STATE_FILE 设备状态；如需清理请手动删除）。"
    info "完成。请重开终端或: unset ANTHROPIC_BASE_URL ANTHROPIC_API_KEY OPENAI_BASE_URL OPENAI_API_KEY"
    exit 0 ;;
esac

PINS="$(resolve_pinned_roots)"
info "固定根指纹: $PINS"
[ -n "$REPO_ROOT" ] && info "仓库: $REPO_ROOT" || warn "未定位到仓库源码：可完成配置，但启动 Adapter 需 clone 仓库并 npm install（或设 CSAPI_REPO_DIR）。"

# 探测（除非 --no-probe）。失败即中止，不写任何配置（fail-closed / 友好报错）。
if [ "$DO_PROBE" -eq 1 ]; then
  if ! probe_and_verify "$PINS"; then
    exit 3
  fi
else
  warn "已跳过 server-keys 探测（--no-probe）：未核对服务端安全通道与根指纹。"
fi

LOOPBACK_KEY="${CG_ADAPTER_LOOPBACK_KEY:-}"
# 复用已有 loopback key（幂等：重复安装不换 key，避免旧终端失效）。
if [ -z "$LOOPBACK_KEY" ] && [ -f "$ENV_FILE" ]; then
  LOOPBACK_KEY="$(grep '^CG_ADAPTER_LOOPBACK_KEY=' "$ENV_FILE" 2>/dev/null | head -n1 | cut -d= -f2- || true)"
fi
[ -n "$LOOPBACK_KEY" ] || LOOPBACK_KEY="$(gen_loopback_key)"

if [ "$MODE" = "print" ]; then
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

KEY="$(resolve_key)"
[ -n "$KEY" ] || { err "未提供 API key，已取消。"; exit 1; }

write_env_file "$KEY" "$LOOPBACK_KEY" "$PINS"
write_launcher

RC="$(detect_rc)"
info "写入 shell 配置: $RC"
write_rc_block "$RC" "$LOOPBACK_KEY"
info "已写受管块（幂等：重复运行只更新，不堆叠）。"

if [ "$MODE" = "start" ]; then
  start_adapter || true
fi

echo
info "下一步："
if [ -z "$REPO_ROOT" ]; then
  info "  0) 本机启动 Adapter 需仓库源码：clone 仓库 → npm install → 设 CSAPI_REPO_DIR 后重跑或直接："
  info "     CSAPI_REPO_DIR=/path/to/repo $LAUNCHER"
else
  info "  0) 确保依赖已装一次:  ( cd \"$REPO_ROOT\" && npm install )"
fi
info "  1) 启动本机 Adapter:  sh install-csapi-secure.sh --start   （或直接: $LAUNCHER）"
info "  2) 让 CLI 变量生效:   重开终端，或 . \"$RC\""
info "  3) 验证:  echo \$ANTHROPIC_BASE_URL  应为 $ADAPTER_LOCAL_BASE"
info "           curl -sS $ADAPTER_LOCAL_BASE/health"
echo
info "安全：真实 key 只在 $ENV_FILE(0600) 与密文 envelope 内；网络中间人只见 cg-mitm/1 密文。"
info "完成 ✅  这是抗 MITM 的方案 A（Adapter），fail-closed，绝不回退明文。"
