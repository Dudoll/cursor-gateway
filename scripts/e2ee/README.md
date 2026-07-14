# Linux/WSL E2EE ops helpers

Operator scripts for **gateway-blind** E2EE on Linux/WSL when Windows DPAPI is
unavailable. They seal the runner master key with a passphrase (scrypt →
AES-256-GCM), keep the usable key only in tmpfs, and optionally wrap the runner
process.

Copy or symlink these into `$HOME/.cursor-gateway` if you prefer that layout, or
run them in place from the repo. Secrets stay **out** of git: never commit
`*.enc`, `*.dat` E2EE state, client state JSON, or `.env`.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `CURSOR_GATEWAY_HOME` | `$HOME/.cursor-gateway` | Sealed key + status files |
| `CURSOR_GATEWAY_REPO` | repo root (from script path) | Runner checkout |
| `E2EE_MASTER_KEY_FILE` | `/dev/shm/cursor-gateway/runner-e2ee-master.key` | Live master key (tmpfs) |
| `E2EE_MASTER_KEY_ENC` | `$CURSOR_GATEWAY_HOME/runner-e2ee-master.enc` | Passphrase-sealed blob |
| `E2EE_MASTER_PASSPHRASE` | (prompt) | Seal/unseal passphrase; never write to disk |
| `NODE_BIN` | `$(command -v node)` | Node 22+ binary |
| `CLIENT_SSH_HOST` | `gateway-vps` | SSH Host alias for tunnel / client |

Runner `.env` should point at the tmpfs key:

```ini
RUNNER_E2EE_MASTER_KEY_FILE=/dev/shm/cursor-gateway/runner-e2ee-master.key
```

## Typical flow

```bash
# 1) Put a fresh random master key into tmpfs (once), then seal it
mkdir -p /dev/shm/cursor-gateway
openssl rand -base64 32 > /dev/shm/cursor-gateway/runner-e2ee-master.key
chmod 600 /dev/shm/cursor-gateway/runner-e2ee-master.key
bash scripts/e2ee/seal-master-key.sh

# 2) After reboot: unseal + start wrapper
bash scripts/e2ee/e2ee-up.sh
```

Headless client (stands in for the signed extension during bring-up):

```bash
export CLIENT_SSH_HOST=your-ssh-host-alias
node scripts/e2ee/e2ee-client.mjs bundle
```
