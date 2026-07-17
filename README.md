# CS Gateway

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

Details and troubleshooting: [`docs/runner.md`](docs/runner.md).

## Quick start: the server

Host once on a VPS with Docker. **Recommended:** use the foolproof web wizard so you never hand-edit secrets:

```bash
git clone https://github.com/Dudoll/cursor-gateway.git
cd cursor-gateway
./scripts/foolproof-deploy/start.sh
# open http://127.0.0.1:19090/ → authenticate → Initialize (uncheck dry-run) → optional Sync
```

Manual path (same end state):

```bash
git clone https://github.com/Dudoll/cursor-gateway.git
cd cursor-gateway
cp .env.example .env
nano .env                       # set secrets, domain, allowed users
cd infra && docker compose up -d --build
```

Wizard details (bootstrap token, CSRF, rollback, human boundaries):
[`docs/foolproof-deploy.md`](docs/foolproof-deploy.md).

Full deployment (DNS, Cloudflare Access, Telegram, backups):
[`docs/deploy.md`](docs/deploy.md).

## End-to-end encryption (optional)

For a Gateway-blind path where the VPS, Cloudflare, Postgres, and backups only
relay ciphertext, use the signed **Secure Gateway** browser extension
(`apps/browser-extension`) and/or the cross-browser **Secure Web PWA**
(`apps/secure-web`, magic-link pairing — see
[`docs/secure-web-e2ee.md`](docs/secure-web-e2ee.md)) with an E2EE-capable
runner. Prompts, history, Memory, progress, and results are encrypted on the
endpoints; the runner decrypts locally before calling the Cursor SDK.

### Device verification (no QR, no email) — recommended order

The Secure Web PWA verifies a new device against a Runner + Cloudflare Access
account. Recommended order (each fallback stays fully supported):

1. **Runner device code (RAMC)** — *primary, no QR / no email.* The Runner
   shows a one-time high-entropy code + a 6-word SAS on its own terminal; you
   type the code into the browser and compare the SAS. See
   [`docs/runner-manual-code-pairing.md`](docs/runner-manual-code-pairing.md).
   Enable with `RUNNER_CODE_PAIRING_ENABLED=true` (server) and
   `RUNNER_CODE_ENABLED=true` (runner).
2. **Already-authorized device approval** — an existing paired device signs off.
3. **Passkey** (WebAuthn / Windows Hello / Face ID).
4. **Recovery code** (high-entropy, Runner-generated).
5. **Email magic-link** / **QR** (fallback for environments without a Runner
   terminal at hand).

First-install integrity (mobile PWA) is anchored by a **trust-root SAS** you
compare out-of-band, and optionally by the **desktop localhost verifier**
([`docs/secure-web-verifier.md`](docs/secure-web-verifier.md)) which attests the
served assets independently of the page JS. RAMC alone does not attest first-load
JS — that requires the trusted PWA bootstrap or the localhost verifier.

Setup order, server/runner environment variables (`E2EE_REQUIRED_FOR_WEB`,
`E2EE_EXTENSION_ORIGINS`, `SECURE_CLIENT_ORIGIN`, `RUNNER_E2EE_ENABLED`, …),
offline / magic-link pairing, key rotation/revocation, the extension build +
`SHA256SUMS` check, authenticated download of the prebuilt zip
(`GET /api/extension/download`), and the security boundary are documented in
[`docs/e2ee.md`](docs/e2ee.md). Telegram, Reports, Automation, and Hermes are
**not** E2EE.

## Repository layout

- `apps/server` — API, auth, Telegram webhook, job queue, audit log, memory,
  and the `cg-e2ee/1` ciphertext relay routes.
- `apps/web` — React dashboard (model/workspace selection, history, approvals).
- `apps/browser-extension` — signed, trusted MV3 E2EE web client.
- `apps/secure-web` — cross-browser E2EE PWA (Cloudflare Pages / static HTTPS).
- `apps/windows-runner` — the runner (Linux/WSL/Windows) that executes agents.
- `packages/shared` — shared schemas and TypeScript types.
- `packages/e2ee` — the `cg-e2ee/1` crypto protocol shared by clients and runner.
- `infra` — Docker Compose and reverse-proxy config for the server.

## Local development

```bash
npm install
npm run build
npm run dev:server      # API
npm run dev:web         # dashboard
npm run dev:extension   # browser extension (E2EE client)
npm run dev:secure-web  # cross-browser E2EE PWA
npm run dev:runner      # runner
```

## Security notes

1. Copy `.env.example` → `.env`, then fill real values; **never commit `.env`**.
   The runner's `apps/windows-runner/.env` must not be committed either.
2. `RUNNER_SHARED_SECRET` must match on the server and runner and be long (≥32).
3. Protect the web UI with Cloudflare Access (or an equivalent identity layer);
   the runner endpoints authenticate with the shared secret.
4. For production Web→Runner chat, set `E2EE_REQUIRED_FOR_WEB=true` and enter
   sensitive content only in the signed extension. The runner still hands
   plaintext to the Cursor model service after local decryption; E2EE protects
   the Gateway/VPS relay, not the model provider.
