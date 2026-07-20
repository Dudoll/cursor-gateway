# Hermes Cursor Gateway provider

This Hermes model-provider profile targets the host-local CSAPI endpoint
`http://127.0.0.1:18080/v1`.

Compared with the original profile, it adds:

- `x-session-id` so CSAPI can persist and resume one Gateway conversation per
  Hermes session;
- a deterministic `Idempotency-Key` for one Hermes model turn, so Hermes API
  retries reuse the existing run instead of launching duplicate Cursor jobs.

Install the directory as:

```text
$HERMES_HOME/plugins/model-providers/cursor-gateway/
```

The API key remains in `CURSOR_GATEWAY_CSAPI_KEY`; it is not stored in this
plugin.
