#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed. Install Docker Engine and the Compose plugin first." >&2
  echo "Ubuntu quick install:" >&2
  echo "  sudo apt-get update" >&2
  echo "  sudo apt-get install -y ca-certificates curl gnupg" >&2
  echo "  sudo install -m 0755 -d /etc/apt/keyrings" >&2
  echo "  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg" >&2
  echo "  sudo chmod a+r /etc/apt/keyrings/docker.gpg" >&2
  echo "  . /etc/os-release" >&2
  echo "  echo \"deb [arch=\$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \$VERSION_CODENAME stable\" | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null" >&2
  echo "  sudo apt-get update" >&2
  echo "  sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin" >&2
  exit 1
fi

docker compose up -d --build app postgres redis
docker compose ps
