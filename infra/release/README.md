# ai.piallera.com release deployment

This stack is deliberately separate from `cs.joelzt.org`:

- app port: `127.0.0.1:18081`
- Compose project: `cursor-gateway-release`
- dedicated PostgreSQL volume and Redis container
- public, read-only report pages when `PUBLIC_REPORTS=true`
- private interview/profile/question APIs still require Cloudflare Access
- report sync copies only shared editions, never users or entitlements

The Cloudflare Access application audience must replace the temporary
`ALLOWED_CLOUDFLARE_AUD` value in the release `.env` before private login is
enabled.

`bootstrap-release.sh` generates fresh release-only secrets and copies only the
static administrator email allowlist from the internal environment. It never
copies the internal database, payment records, or user state.
