# Offline trust root & Runner identity certificates

## Why

Passkey / device-approval / recovery pairing and CS→Secure→CS grants must not
trust raw Runner public keys relayed by the Gateway alone. An offline **trust
root** (P-256/ES256, same family as `cg-e2ee/1`) signs short-lived **Runner
identity certificates** that bind:

- `runnerId`
- encryption + signing key fingerprints
- allowed Secure Web origins
- allowed WebAuthn `rpId`s
- expiry / epoch

Clients verify the certificate against a **pre-provisioned root public key**
before accepting a pin or `cs_auth` grant. The root **private** key never
touches the Gateway, repo, env files, or logs.

## Roles

| Material | Where | Git? |
| --- | --- | --- |
| Root private JWK (sealed) | `~/.cursor-gateway/trust-root-private.enc` (0600) | Never |
| Root public JSON | `~/.cursor-gateway/trust-root-public.json` + Gateway `E2EE_TRUST_ROOTS_*` + optional client pin | Public OK |
| Runner identity cert | `~/.cursor-gateway/runner-identity-cert.json` (`RUNNER_IDENTITY_CERT_FILE`) | Public OK |

Sealing reuses the WSL master-key scheme (`RUNNER_E2EE_MASTER_KEY` /
`seal-master-key.sh`).

## Issue (operator machine / Runner host)

```bash
# 1) Create root (once)
npx tsx scripts/e2ee/trust-root-cli.ts init-root --epoch 1

# 2) Issue a Runner cert (needs unsealed master key + runner E2EE state)
npx tsx scripts/e2ee/trust-root-cli.ts issue-cert \
  --runner-id wsl-e2ee \
  --allowed-origins https://secure.joelzt.org \
  --allowed-rp-ids secure.joelzt.org \
  --validity-days 365

# 3) Deploy public root to Gateway (.env or file mount)
#    E2EE_TRUST_ROOTS_FILE=/path/to/trust-root-public.json
#    (or E2EE_TRUST_ROOTS_JSON='{"trustRoots":[...]}')

# 4) Restart Runner so it loads RUNNER_IDENTITY_CERT_FILE
```

## Rotation

1. `init-root --epoch N+1` → keep **both** public roots in Gateway policy and
   client pins during overlap.
2. Re-issue Runner certs with the new root.
3. After all Runners + clients accept epoch N+1, remove epoch N public root.
4. Destroy / archive the old sealed private key offline.

## Recovery codes

```bash
npx tsx scripts/e2ee/trust-root-cli.ts recovery-code \
  --runner-id wsl-e2ee \
  --secure-origin https://secure.joelzt.org \
  --gateway-url https://cs.joelzt.org \
  --runner-shared-secret "$RUNNER_SHARED_SECRET"
```

Prints a QR (`#recover=<id>.<secret>`), Crockford display code, and writes the
secret **only** to `~/.cursor-gateway/recovery-pending-<runnerId>.json` (0600).
Gateway receives `{recoveryId, expiresAt}` only.

## Honest trust boundary (Secure Web hosting)

Today Secure Web static assets are served by **VPS nginx**. A compromised VPS
can replace JS even if the trust root is embedded in that bundle. That is still
stronger than trusting unsigned Runner keys, but **not** a fully independent
client trust root.

For independent trust: host Secure Web on **Cloudflare Pages** (immutable
deploy + Access). This environment currently has no Cloudflare Pages API token;
operators must provision Pages separately and point `secure.joelzt.org` at it.

CS Web (served from the Gateway app container) can embed `PINNED_TRUST_ROOTS`
in `apps/web/src/trustRoots.ts` after each root ceremony.
