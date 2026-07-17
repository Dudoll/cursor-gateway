#!/bin/sh
# CS Gateway Agent 使用方一键安装入口。
# 首次自动 clone，重复运行自动更新，然后在仓库内安装 Secure Adapter。
set -eu

REPO_URL="${CSAPI_REPO_GIT_URL:-https://github.com/Dudoll/cursor-gateway.git}"
PROJECT_DIR="${CSAPI_CLONE_DIR:-$HOME/.cursor-gateway/cursor-gateway}"

info() {
  printf '\033[1;36m[csapi-agent]\033[0m %s\n' "$*"
}

fail() {
  printf '\033[1;31m[csapi-agent]\033[0m %s\n' "$*" >&2
  exit 1
}

command -v git >/dev/null 2>&1 ||
  fail "缺少 git。请先安装 git 后重新执行。"

if [ -d "$PROJECT_DIR/.git" ]; then
  info "发现已有项目，正在更新: $PROJECT_DIR"
  git -C "$PROJECT_DIR" pull --ff-only ||
    fail "git pull 失败。请处理项目内的本地改动或网络问题后重试。"
elif [ -e "$PROJECT_DIR" ]; then
  fail "目标路径已存在但不是 Git 仓库: $PROJECT_DIR"
else
  info "首次安装，正在 clone: $REPO_URL"
  mkdir -p "$(dirname "$PROJECT_DIR")"
  git clone --depth 1 "$REPO_URL" "$PROJECT_DIR" ||
    fail "git clone 失败，请检查网络或仓库访问权限。"
fi

[ -f "$PROJECT_DIR/scripts/csapi/install-csapi-secure.sh" ] ||
  fail "项目不完整，缺少 scripts/csapi/install-csapi-secure.sh"
[ -d "$PROJECT_DIR/apps/secure-adapter" ] ||
  fail "项目不完整，缺少 apps/secure-adapter"

# 防止 systemd --user 中遗留的错误路径覆盖本次已验证的项目路径。
if command -v systemctl >/dev/null 2>&1; then
  systemctl --user unset-environment CSAPI_REPO_DIR >/dev/null 2>&1 || true
fi

info "项目已就绪，开始安装加密服务。接下来只需输入 API Key。"
cd "$PROJECT_DIR"
CSAPI_REPO_DIR="$PROJECT_DIR"
export CSAPI_REPO_DIR

exec sh scripts/csapi/install-csapi-secure.sh --service --yes --no-clone --build
