#!/usr/bin/env sh
# =============================================================================
# install-csapi.sh — csapi 懒人一键安装脚本（可单文件四处分发）
# -----------------------------------------------------------------------------
# 作用：在任意机器上快速把「CLI 用的 API 环境」配好，指向兼容门面
#       https://csapi.joelzt.org （方案 B：TLS + API key 明文兼容通道）。
#
# 会为你写好两套环境变量：
#   - Claude Code / Anthropic 兼容:
#       ANTHROPIC_BASE_URL = https://csapi.joelzt.org
#       ANTHROPIC_API_KEY  = <你的 CSAPI key>
#   - OpenCode / OpenAI 兼容:
#       OPENAI_BASE_URL    = https://csapi.joelzt.org/v1
#       OPENAI_API_KEY     = <你的 CSAPI key>
#
# ⚠️ 安全边界（务必知悉）：
#   这是 **plaintext 兼容通道，不是端到端加密（E2EE）**。
#   你的请求体 / system prompt / 对话内容在门面、网关、Runner、模型侧都是明文可见的
#   （我们做最小化日志，但技术上可见）。想要 Gateway-blind 明文不出本机需走方案 A。
#
# 用法：
#   1) 交互式（推荐）:      sh install-csapi.sh
#   2) 环境变量跳过交互:    CSAPI_API_KEY=sk-xxxx sh install-csapi.sh
#      （也接受 API_KEY 作为别名）
#   3) 只打印 export，不改文件:  sh install-csapi.sh --print
#   4) 跳过连通性探测:      sh install-csapi.sh --no-probe
#   5) 移除本脚本写入的配置:  sh install-csapi.sh --uninstall
#
# 兼容：Linux / macOS / WSL / Windows Git-Bash（POSIX sh / bash / zsh）。
# 幂等：重复运行只会「更新」标记块，不会重复堆叠。
# 本脚本不含任何真实生产 key；key 由交互输入或环境变量提供。
# =============================================================================

set -u

# ---- 可覆盖的默认值 --------------------------------------------------------
CSAPI_BASE_URL="${CSAPI_BASE_URL:-https://csapi.joelzt.org}"
# ANTHROPIC 用根 URL，OPENAI 用 /v1（见 docs/csapi.md §7）
ANTHROPIC_BASE_URL_VAL="$CSAPI_BASE_URL"
OPENAI_BASE_URL_VAL="${CSAPI_BASE_URL%/}/v1"

MARK_BEGIN="# >>> csapi env (managed by install-csapi.sh) >>>"
MARK_END="# <<< csapi env (managed by install-csapi.sh) <<<"

# ---- 参数解析 --------------------------------------------------------------
MODE="install"     # install | print | uninstall
DO_PROBE=1
for arg in "$@"; do
  case "$arg" in
    --print) MODE="print" ;;
    --uninstall) MODE="uninstall" ;;
    --no-probe) DO_PROBE=0 ;;
    -h|--help)
      sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "未知参数: $arg（用 --help 查看用法）" >&2; exit 2 ;;
  esac
done

# ---- 小工具 ----------------------------------------------------------------
info()  { printf '\033[1;36m[csapi]\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m[csapi]\033[0m %s\n' "$*" >&2; }
err()   { printf '\033[1;31m[csapi]\033[0m %s\n' "$*" >&2; }

have() { command -v "$1" >/dev/null 2>&1; }

# ---- 选择要写入的 shell rc 文件 --------------------------------------------
# 逻辑：优先按当前登录 shell 猜测；zsh -> ~/.zshrc，其它 -> ~/.bashrc。
detect_rc() {
  _shell_name="$(basename "${SHELL:-}")"
  case "$_shell_name" in
    zsh)  echo "${ZDOTDIR:-$HOME}/.zshrc" ;;
    bash) echo "$HOME/.bashrc" ;;
    *)
      # 回退：哪个存在用哪个，都没有就用 ~/.profile
      if [ -f "$HOME/.bashrc" ]; then echo "$HOME/.bashrc"
      elif [ -f "$HOME/.zshrc" ]; then echo "$HOME/.zshrc"
      else echo "$HOME/.profile"
      fi ;;
  esac
}

# ---- 组装受管块内容（值已就绪时调用） -------------------------------------
render_block() {
  # $1 = key
  _k="$1"
  cat <<EOF
$MARK_BEGIN
# csapi 是 plaintext 兼容通道（方案 B），不是端到端加密（E2EE）。
# Claude Code / Anthropic 兼容
export ANTHROPIC_BASE_URL="$ANTHROPIC_BASE_URL_VAL"
export ANTHROPIC_API_KEY="$_k"
# OpenCode / OpenAI 兼容
export OPENAI_BASE_URL="$OPENAI_BASE_URL_VAL"
export OPENAI_API_KEY="$_k"
$MARK_END
EOF
}

# ---- 幂等写入：删旧块 + 追加新块 -------------------------------------------
write_block() {
  # $1 = rc file, $2 = key
  _rc="$1"; _key="$2"
  touch "$_rc" 2>/dev/null || { err "无法写入 $_rc"; exit 1; }

  # 用 awk 剥离已存在的受管块（幂等核心）
  _tmp="$(mktemp 2>/dev/null || echo "${_rc}.csapi.tmp.$$")"
  awk -v b="$MARK_BEGIN" -v e="$MARK_END" '
    $0==b {skip=1; next}
    $0==e {skip=0; next}
    skip!=1 {print}
  ' "$_rc" > "$_tmp" 2>/dev/null || { err "处理 $_rc 失败"; rm -f "$_tmp"; exit 1; }

  # 去掉尾部多余空行，再追加新块
  {
    cat "$_tmp"
    printf '\n'
    render_block "$_key"
  } > "${_tmp}.2" 2>/dev/null

  mv "${_tmp}.2" "$_rc" 2>/dev/null || { err "写回 $_rc 失败"; rm -f "$_tmp" "${_tmp}.2"; exit 1; }
  rm -f "$_tmp"
  chmod 600 "$_rc" 2>/dev/null || true
}

remove_block() {
  _rc="$1"
  [ -f "$_rc" ] || { info "未找到 $_rc，无需清理"; return 0; }
  _tmp="$(mktemp 2>/dev/null || echo "${_rc}.csapi.tmp.$$")"
  awk -v b="$MARK_BEGIN" -v e="$MARK_END" '
    $0==b {skip=1; next}
    $0==e {skip=0; next}
    skip!=1 {print}
  ' "$_rc" > "$_tmp" && mv "$_tmp" "$_rc"
  info "已从 $_rc 移除 csapi 受管块。"
}

# ---- 读取 key（环境变量 > 交互）-------------------------------------------
resolve_key() {
  _k="${CSAPI_API_KEY:-${API_KEY:-}}"
  if [ -n "$_k" ]; then
    printf '%s' "$_k"
    return 0
  fi
  # 交互输入（隐藏回显）；从 /dev/tty 读，兼容 curl|bash 管道场景
  if [ -r /dev/tty ]; then
    printf '\033[1;36m[csapi]\033[0m 请输入你的 CSAPI API key（输入不显示）: ' > /dev/tty
    _old_stty="$(stty -g 2>/dev/null || true)"
    stty -echo 2>/dev/null || true
    IFS= read -r _k < /dev/tty
    stty "${_old_stty:-echo}" 2>/dev/null || stty echo 2>/dev/null || true
    printf '\n' > /dev/tty
  else
    err "无可用 tty，请改用: CSAPI_API_KEY=xxxx sh install-csapi.sh"
    exit 1
  fi
  printf '%s' "$_k"
}

# ---- 连通性探测 ------------------------------------------------------------
probe() {
  _key="$1"
  have curl || { warn "未找到 curl，跳过连通性探测。"; return 0; }

  info "探测 $CSAPI_BASE_URL/health ..."
  if _out="$(curl -fsS --max-time 15 "$CSAPI_BASE_URL/health" 2>/dev/null)"; then
    info "health OK: $_out"
  else
    warn "health 探测失败（网络/门面可能不可达），环境变量仍已写入。"
  fi

  if [ -n "$_key" ]; then
    info "探测 $OPENAI_BASE_URL_VAL/models（带 key）..."
    _code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 \
      -H "Authorization: Bearer $_key" "$OPENAI_BASE_URL_VAL/models" 2>/dev/null || echo 000)"
    case "$_code" in
      200) info "models OK（鉴权通过，HTTP 200）。" ;;
      401|403) warn "models 返回 $_code：key 可能无效或未授权，请核对。" ;;
      000) warn "models 探测无响应（网络问题），环境变量仍已写入。" ;;
      *) warn "models 返回 HTTP $_code。" ;;
    esac
  fi
}

# ============================ 主流程 =======================================
info "csapi 门面: $CSAPI_BASE_URL"
info "⚠️  这是 plaintext 兼容通道（方案 B），不是端到端加密（E2EE）。"

if [ "$MODE" = "uninstall" ]; then
  RC="$(detect_rc)"
  remove_block "$RC"
  info "完成。请重开终端或运行:  unset ANTHROPIC_BASE_URL ANTHROPIC_API_KEY OPENAI_BASE_URL OPENAI_API_KEY"
  exit 0
fi

KEY="$(resolve_key)"
if [ -z "$KEY" ]; then
  err "未提供 API key，已取消。"
  exit 1
fi

if [ "$MODE" = "print" ]; then
  info "以下 export 语句可直接粘贴到当前终端（未写入任何文件）:"
  echo
  render_block "$KEY" | grep -v '^#'
  echo
  [ "$DO_PROBE" -eq 1 ] && probe "$KEY"
  exit 0
fi

RC="$(detect_rc)"
info "写入 shell 配置: $RC"
write_block "$RC" "$KEY"
info "已写入受管块（幂等：重复运行只更新，不堆叠）。"

[ "$DO_PROBE" -eq 1 ] && probe "$KEY"

echo
info "生效方式（任选其一）:"
info "  1) 重开一个终端"
info "  2) 运行:  . \"$RC\"    （bash/zsh 也可用 source）"
echo
info "验证:  echo \$ANTHROPIC_BASE_URL  与  echo \$OPENAI_BASE_URL"
info "冒烟:  curl -sS \"$CSAPI_BASE_URL/health\""
info "完成 ✅  Claude Code 用 ANTHROPIC_*，OpenCode/OpenAI 客户端用 OPENAI_*。"
