#!/usr/bin/env bash
set -euo pipefail

release_root="${RELEASE_ROOT:-/home/joel/cursor-gateway-release}"
user_units="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

cd "$release_root"

sudo install -o root -g root -m 0644 \
  infra/release/nginx-ai.piallera.com.conf \
  /etc/nginx/conf.d/ai.piallera.com.conf
sudo nginx -t
sudo systemctl reload nginx

install -d -m 0755 "$user_units"
install -m 0644 infra/release/hermes-cursor-runner-release.service \
  "$user_units/hermes-cursor-runner-release.service"
install -m 0644 infra/release/cursor-gateway-release-sync.service \
  "$user_units/cursor-gateway-release-sync.service"
install -m 0644 infra/release/cursor-gateway-release-sync.timer \
  "$user_units/cursor-gateway-release-sync.timer"

systemctl --user daemon-reload
systemctl --user enable --now hermes-cursor-runner-release.service
systemctl --user enable --now cursor-gateway-release-sync.timer
systemctl --user start cursor-gateway-release-sync.service

curl --fail --silent --show-error http://127.0.0.1:18081/healthz
printf '\nRelease activation completed.\n'
