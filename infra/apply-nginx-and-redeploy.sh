#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

install -m 0644 nginx-gateway.conf /etc/nginx/conf.d/cursor-gateway.conf
nginx -t
systemctl reload nginx

docker compose up -d --build --force-recreate app postgres redis
docker compose ps

curl -fsS http://127.0.0.1:18080/healthz
echo
echo "Gateway is available behind the local nginx proxy (see nginx-gateway.conf)."
