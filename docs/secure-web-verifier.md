# Desktop localhost Secure Web verifier (RAMC P3)

Independently attests the **served** Secure Web first-load assets **without
trusting the page JS**. This is one of the two mechanisms (with the trusted PWA
bootstrap, P4) that close the "malicious server serves tampered JS" gap that
RAMC alone cannot close.

## What it does

1. Fetches `<origin>/asset-manifest.json`.
2. Verifies its **offline Ed25519 signature** against a **pinned public key**
   (committed JSON, not the manifest's self-asserted key).
3. Fetches every listed asset and checks its SHA-256 against the manifest.
4. Prints **PASS/FAIL** in the terminal.

Because the verifier does its own fetch + hashing + signature check in a
separate process, a compromised page cannot influence the result.

## Keys

- **Private** Ed25519 key: `*.pem`, chmod `0600`, **never** committed
  (`.gitignore` excludes `*.pem`). Kept offline / on the build host.
- **Public** pinned key: committed JSON at
  `scripts/e2ee/trust/secure-web-asset-manifest-public.json`.

## One-time setup

```bash
cd apps/secure-web
npm run manifest:init          # writes secure-web-asset-manifest.pem (0600) + pinned public JSON
# commit scripts/e2ee/trust/secure-web-asset-manifest-public.json ; keep the .pem offline
```

## Build + sign (release)

```bash
cd apps/secure-web
npm run build
npm run manifest:sign -- --origin https://secure.joelzt.org --version 0.1.1 \
  --private /secure/path/secure-web-asset-manifest.pem
# → apps/secure-web/dist/asset-manifest.json (served at <origin>/asset-manifest.json)
npm run manifest:verify-local   # sanity: signature + local hashes
```

## Verify a live origin (desktop)

```bash
# One-shot CLI (PASS → exit 0, FAIL → exit 1):
cd apps/secure-web
npm run verify:secure-web -- --origin https://secure.joelzt.org

# Loopback service (127.0.0.1 only, host allowlist, NO CORS headers):
tsx ../../scripts/e2ee/verify-secure-web.ts --serve --port 8790 \
  --allow https://secure.joelzt.org
# GET http://127.0.0.1:8790/verify?origin=https://secure.joelzt.org
```

## Hosting caveat (SPA fallback / Cloudflare Pages)

The verifier fetches `<origin>/asset-manifest.json` and each asset as **real
files**. If the origin uses an SPA catch-all (`try_files … /index.html`, or a
Cloudflare Pages/Worker single-page rewrite) that returns `index.html` for
unknown paths, `/asset-manifest.json` and hashed asset paths must be **excluded**
from that rewrite so they resolve to the actual files. On the VPS nginx origin
the files resolve correctly (`200 application/json`). When Secure Web is hosted
on Cloudflare Pages, deploy the built `apps/secure-web/dist` (which now includes
`asset-manifest.json`) via `wrangler pages deploy apps/secure-web/dist` and
ensure `_headers`/routing serve the manifest as a static asset.

## Security properties

- **Loopback bind only** (`127.0.0.1`); not reachable off-host.
- **Host allowlist**: only pre-approved origins may be verified.
- **No CORS headers**: a browser page cannot read the verifier result, so a
  malicious page cannot use it to fake a PASS. The authoritative signal is the
  terminal / JSON output the operator reads directly.
- **No sensitive data**: only public assets + a public signature are handled.
- Independent of the verified page's JavaScript.
