# Cursor Gateway

Run Cursor agents against files on your own machine, controlled through a small
web/Telegram gateway. Two pieces:

- **Server** — a small API + web dashboard you host once (Docker). It queues
  requests and shows results. It never touches your files.
- **Runner** — runs on the machine that holds your code. It pulls jobs from the
  server and executes Cursor agents locally. Runs on Linux and WSL.

```
You (web / Telegram)  ->  Server (VPS, Docker)  ->  Runner (your machine)  ->  your files
```

## Quick start: the runner (foolproof)

On the machine that has your code (Linux or WSL). You need your gateway URL, the
server's shared secret, and a Cursor API key.

```bash
git clone https://github.com/Dudoll/cursor-gateway.git
cd cursor-gateway

# 1) First run: installs Node 22 locally and creates the config file.
./apps/windows-runner/scripts/setup-runner.sh

# 2) Fill in your values (URL, secret, workspaces, API key).
nano apps/windows-runner/.env

# 3) Run it again: installs dependencies and builds.
./apps/windows-runner/scripts/setup-runner.sh
```

That's it. To keep it running in the background:

```bash
# Linux with systemd:
./apps/windows-runner/scripts/install-runner-service.sh

# WSL on Windows (run in an elevated PowerShell):
powershell -ExecutionPolicy Bypass -File apps\windows-runner\scripts\install-wsl-runner-daemon.ps1
```

Details and troubleshooting: [`docs/windows-runner.md`](docs/windows-runner.md).

## Quick start: the server

Host once on a VPS with Docker:

```bash
git clone https://github.com/Dudoll/cursor-gateway.git
cd cursor-gateway
cp .env.example .env
nano .env                       # set secrets, domain, allowed users
cd infra && docker compose up -d --build
```

Full deployment (DNS, Cloudflare Access, Telegram, backups):
[`docs/deploy.md`](docs/deploy.md).

## Repository layout

- `apps/server` — API, auth, Telegram webhook, job queue, audit log, memory.
- `apps/web` — React dashboard (model/workspace selection, history, approvals).
- `apps/windows-runner` — the runner (Linux/WSL/Windows) that executes agents.
- `packages/shared` — shared schemas and TypeScript types.
- `infra` — Docker Compose and reverse-proxy config for the server.

## Local development

```bash
npm install
npm run build
npm run dev:server   # API
npm run dev:web      # dashboard
npm run dev:runner   # runner
```
