#!/usr/bin/env bash
# One-shot setup for the Cursor Gateway runner on Linux / WSL.
#
#   git clone <repo> && cd cursor-gateway
#   ./apps/windows-runner/scripts/setup-runner.sh   # 1st run: installs Node, creates .env
#   nano apps/windows-runner/.env                    # fill in your values
#   ./apps/windows-runner/scripts/setup-runner.sh   # 2nd run: installs deps and builds
#
# Idempotent: safe to run repeatedly.
set -euo pipefail

NODE_VERSION="v22.14.0"
NODE_DIR="$HOME/.node22"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
RUNNER_DIR="$ROOT/apps/windows-runner"
ENV_FILE="$RUNNER_DIR/.env"
ENV_EXAMPLE="$RUNNER_DIR/.env.example"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m%s\033[0m\n' "$*"; }

download() {
  # download <url> <dest>
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$2" "$1"
  else
    echo "Neither curl nor wget is available; cannot download Node." >&2
    exit 1
  fi
}

ensure_node() {
  if [ -x "$NODE_DIR/bin/node" ]; then
    return
  fi
  say "Installing Node $NODE_VERSION into $NODE_DIR"
  local arch node_arch tmp
  arch="$(uname -m)"
  case "$arch" in
    x86_64) node_arch="linux-x64" ;;
    aarch64 | arm64) node_arch="linux-arm64" ;;
    *) echo "Unsupported CPU architecture: $arch" >&2; exit 1 ;;
  esac
  tmp="$(mktemp -d)"
  download "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-$node_arch.tar.xz" "$tmp/node.tar.xz"
  mkdir -p "$NODE_DIR"
  tar -xJf "$tmp/node.tar.xz" -C "$NODE_DIR" --strip-components=1
  rm -rf "$tmp"
}

ensure_node
export PATH="$NODE_DIR/bin:$PATH"
say "Using node $(node -v) / npm $(npm -v)"

if [ ! -f "$ENV_FILE" ]; then
  cp "$ENV_EXAMPLE" "$ENV_FILE"
  say "Created $ENV_FILE"
  warn "Edit it and fill in at least these values:"
  warn "  GATEWAY_URL           your gateway URL"
  warn "  RUNNER_SHARED_SECRET  same secret as the server"
  warn "  RUNNER_WORKSPACES     absolute paths to expose (';' separated)"
  warn "  CURSOR_API_KEY        your Cursor API key"
  warn ""
  warn "Then run this script again to install and build."
  exit 0
fi

say "Installing dependencies"
cd "$ROOT"
npm install --no-fund --no-audit

say "Building"
npm run build -w @cursor-gateway/shared
npm run build -w @cursor-gateway/windows-runner

say "Setup complete."
cat <<EOF

Start it now (foreground, Ctrl+C to stop):
  cd "$RUNNER_DIR" && "$NODE_DIR/bin/node" dist/index.js

Keep it running automatically:
  Linux (systemd):   ./apps/windows-runner/scripts/install-runner-service.sh
  WSL on Windows:    run from an elevated PowerShell:
                     powershell -ExecutionPolicy Bypass -File apps\\windows-runner\\scripts\\install-wsl-runner-daemon.ps1
EOF
