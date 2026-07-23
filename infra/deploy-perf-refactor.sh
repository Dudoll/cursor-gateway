#!/usr/bin/env bash
# Deploy gateway performance refactor to this VPS host.
# Run on the VPS as joel from /home/joel/cursor-gateway (or after rsync).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> patch .env feature flags (non-destructive)"
python3 - <<'PY'
from pathlib import Path
path = Path(".env")
text = path.read_text(encoding="utf-8")
updates = {
    "DB_POOL_MAX": "3",
    "RUNNER_LONG_POLL_MS": "25000",
    "CS_RELAY_RUNNER_REENCRYPT": "true",
    "WEB_STATIC_ENABLED": "0",
}
lines = text.splitlines()
keys_seen = set()
out = []
for line in lines:
    if not line or line.lstrip().startswith("#") or "=" not in line:
        out.append(line)
        continue
    key, _, _ = line.partition("=")
    if key in updates:
        out.append(f"{key}={updates[key]}")
        keys_seen.add(key)
    else:
        out.append(line)
for key, value in updates.items():
    if key not in keys_seen:
        out.append(f"{key}={value}")
path.write_text("\n".join(out) + "\n", encoding="utf-8")
print("updated", ", ".join(sorted(updates)))
PY

echo "==> sync web static + latest releases (disk only)"
sudo mkdir -p /var/www/cursor-gateway-web /var/www/cursor-gateway-releases
if [[ -d apps/web/dist ]]; then
  sudo rsync -a --delete apps/web/dist/ /var/www/cursor-gateway-web/
else
  echo "WARN: apps/web/dist missing; build web first" >&2
fi
# Latest desktop zip + release.json only (no unpacked Electron tree).
if [[ -f artifacts/secure-desktop/release.json ]]; then
  sudo rsync -a artifacts/secure-desktop/release.json /var/www/cursor-gateway-releases/
  zip_name="$(python3 -c 'import json; print(json.load(open("artifacts/secure-desktop/release.json"))["file"])')"
  if [[ -f "artifacts/secure-desktop/$zip_name" ]]; then
    sudo rsync -a "artifacts/secure-desktop/$zip_name" /var/www/cursor-gateway-releases/
  fi
fi
if [[ -f artifacts/cursor-gateway-secure.zip ]]; then
  sudo rsync -a artifacts/cursor-gateway-secure.zip /var/www/cursor-gateway-releases/
fi
sudo chown -R www-data:www-data /var/www/cursor-gateway-web /var/www/cursor-gateway-releases || true

echo "==> install nginx config"
if [[ -f infra/nginx-cs.joelzt.org.conf ]]; then
  sudo cp -a /etc/nginx/conf.d/cs.joelzt.org.conf \
    "/etc/nginx/conf.d/cs.joelzt.org.conf.bak.$(date +%Y%m%dT%H%M%S)" || true
  sudo install -m 0644 infra/nginx-cs.joelzt.org.conf /etc/nginx/conf.d/cs.joelzt.org.conf
  sudo nginx -t
  sudo systemctl reload nginx
fi

echo "==> hermes resource limits (CPUQuota)"
mkdir -p "$HOME/.config/systemd/user/hermes-gateway-telegram2.service.d"
install -m 0644 infra/hermes-gateway-telegram2.resource.conf \
  "$HOME/.config/systemd/user/hermes-gateway-telegram2.service.d/zz-resource-limits.conf"
# Keep existing strict-route drop-in if present.
systemctl --user daemon-reload
systemctl --user restart hermes-gateway-telegram2.service || true

echo "==> docker compose rebuild (no redis by default)"
cd infra
# Stop unused redis if running.
docker compose stop redis 2>/dev/null || true
docker compose rm -f redis 2>/dev/null || true
docker compose up -d --build --force-recreate app postgres
docker compose ps

echo "==> health"
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS http://127.0.0.1:18080/healthz >/dev/null; then
    curl -fsS http://127.0.0.1:18080/healthz
    echo
    break
  fi
  sleep 2
done

echo "==> memory snapshot"
docker stats --no-stream --format '{{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}' || true
systemctl --user show hermes-gateway-telegram2.service -p MemoryCurrent -p MemoryPeak -p CPUQuotaPerSecUSec --no-pager || true
echo "deploy done"
