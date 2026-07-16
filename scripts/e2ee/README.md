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

## Offline trust root / Runner cert / recovery codes (`trust-root-cli.ts`)

Generates and manages the offline P-256 trust root that signs Runner identity
certificates, issues those certificates, and mints local recovery codes.
**Root private key material never touches the Gateway.** Run this on an
operator machine (root generation, cert issuance) or on the Runner host
itself (cert issuance using local state, recovery codes). See
[`docs/trust-root-rotation.md`](../../docs/trust-root-rotation.md) for the
full rotation/migration story.

The root private key and Runner state are both sealed with the same
AES-256-GCM + scrypt scheme as `mk-seal.cjs` / `e2eeState.ts`, using
`RUNNER_E2EE_MASTER_KEY` or `RUNNER_E2EE_MASTER_KEY_FILE` (defaults to
`/dev/shm/cursor-gateway/runner-e2ee-master.key`).

```bash
# 1) Generate (or rotate) the offline trust root — run once, keep the
#    resulting trust-root-private.enc offline (e.g. on a USB stick, not on
#    the Gateway or Runner host).
npx tsx scripts/e2ee/trust-root-cli.ts init-root
#   -> ~/.cursor-gateway/trust-root-private.enc (sealed, 0600)
#   -> ~/.cursor-gateway/trust-root-public.json (public; copy to Gateway
#      E2EE_TRUST_ROOTS_FILE and every Runner's E2EE_TRUST_ROOTS_FILE)

# 2) Issue a Runner identity certificate, reading the Runner's public keys
#    from its sealed state file (run this on the Runner host, or pass
#    --encryption-key-file / --signing-key-file exported elsewhere):
npx tsx scripts/e2ee/trust-root-cli.ts issue-cert \
  --runner-id local-runner \
  --allowed-origins https://secure.joelzt.org \
  --allowed-rp-ids secure.joelzt.org
#   -> ~/.cursor-gateway/runner-identity-cert.json
#      (copy to the Runner host as RUNNER_IDENTITY_CERT_FILE)

# 3) Mint a one-time recovery code for a Runner (secret stays local; only a
#    public "handle" — recoveryId + expiry, no secret — is optionally
#    advertised to the Gateway):
npx tsx scripts/e2ee/trust-root-cli.ts recovery-code \
  --runner-id local-runner \
  --secure-origin https://secure.joelzt.org \
  --gateway-url https://gateway.example.com \
  --runner-shared-secret "$RUNNER_SHARED_SECRET"
```

Equivalent `npm` scripts are available from `apps/windows-runner`:
`npm run trust-root:init`, `npm run trust-root:issue-cert -- --runner-id ...`,
`npm run recovery:code -- --runner-id ...`.
