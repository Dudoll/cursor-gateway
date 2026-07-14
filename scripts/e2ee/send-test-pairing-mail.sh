#!/usr/bin/env bash
# Dry-run / live test for Secure Web pairing mail.
#
# Usage:
#   bash scripts/e2ee/send-test-pairing-mail.sh
#   bash scripts/e2ee/send-test-pairing-mail.sh you@example.com
#
# Loads apps/windows-runner/.env (if present). Default mode is whatever
# PAIRING_MAIL_MODE is set to; override with PAIRING_MAIL_MODE=log for dry-run.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TO="${1:-${PAIRING_MAIL_TO:-}}"
cd "$ROOT"
exec npx tsx scripts/e2ee/send-test-pairing-mail.ts ${TO:+"$TO"}
