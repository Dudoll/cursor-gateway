#!/usr/bin/env bash
# Read the latest Secure Web magic-link from PAIRING_MAIL_MODE=log output.
# Default log: ~/.cursor-gateway/pairing-mail.log
set -euo pipefail

LOG="${PAIRING_MAIL_LOG_FILE:-${HOME}/.cursor-gateway/pairing-mail.log}"
MODE="${1:-latest}" # latest | watch | path | all-links

if [[ ! -f "$LOG" ]]; then
  echo "pairing-mail log not found: $LOG" >&2
  echo "Start pairing from the Secure Web PWA while the runner uses PAIRING_MAIL_MODE=log." >&2
  exit 1
fi

extract_links() {
  grep -E '^magicLink: ' "$LOG" | sed 's/^magicLink: //'
}

case "$MODE" in
  path)
    printf '%s\n' "$LOG"
    ;;
  all-links)
    extract_links
    ;;
  watch)
    echo "Watching $LOG (Ctrl-C to stop)..." >&2
    tail -n 0 -F "$LOG" | while IFS= read -r line; do
      if [[ "$line" == magicLink:* ]]; then
        link="${line#magicLink: }"
        printf '%s\n' "$link"
      fi
    done
    ;;
  latest|*)
    link="$(extract_links | tail -n 1 || true)"
    if [[ -z "${link:-}" ]]; then
      echo "No magicLink entries in $LOG yet." >&2
      exit 2
    fi
    printf '%s\n' "$link"
    ;;
esac
