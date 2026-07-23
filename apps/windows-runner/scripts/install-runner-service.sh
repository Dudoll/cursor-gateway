#!/usr/bin/env bash
# Install the runner as a systemd user service so it starts on boot and
# restarts on failure. For real Linux hosts with systemd.
#
# WSL1 has no systemd: use install-wsl-runner-daemon.ps1 from Windows instead.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
RUNNER_DIR="$ROOT/apps/windows-runner"

NODE="$HOME/.node22/bin/node"
if [ ! -x "$NODE" ]; then
  NODE="$(command -v node || true)"
fi
if [ -z "$NODE" ]; then
  echo "node not found. Run ./apps/windows-runner/scripts/setup-runner.sh first." >&2
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemd (systemctl) not found."
  echo "This is expected on WSL1. Install the Windows boot task instead:"
  echo "  powershell -ExecutionPolicy Bypass -File apps\\windows-runner\\scripts\\install-wsl-runner-daemon.ps1"
  exit 1
fi

if [ ! -f "$RUNNER_DIR/dist/index.js" ]; then
  echo "Runner is not built. Run ./apps/windows-runner/scripts/setup-runner.sh first." >&2
  exit 1
fi

UNIT_DIR="$HOME/.config/systemd/user"
UNIT="$UNIT_DIR/cursor-gateway-runner.service"
mkdir -p "$UNIT_DIR"

cat > "$UNIT" <<EOF
[Unit]
Description=Cursor Gateway Runner
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$RUNNER_DIR
ExecStart=$NODE dist/index.js
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now cursor-gateway-runner.service

# Keep the service running after logout / across reboots.
loginctl enable-linger "$USER" >/dev/null 2>&1 || true

echo "Installed and started systemd user service: cursor-gateway-runner"
echo "  Status:  systemctl --user status cursor-gateway-runner"
echo "  Logs:    journalctl --user -u cursor-gateway-runner -f"
echo "  Stop:    systemctl --user disable --now cursor-gateway-runner"
