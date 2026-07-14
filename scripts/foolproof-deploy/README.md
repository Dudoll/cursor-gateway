# Foolproof deploy wizard

Host-side web wizard that generates gateway secrets and can sync/restart Compose.
See **[`docs/foolproof-deploy.md`](../../docs/foolproof-deploy.md)** for the full
Chinese operator guide (auth, CSRF, rollback, human boundaries).

```bash
./scripts/foolproof-deploy/start.sh
# → http://127.0.0.1:19090/
```

Do not commit `.env`, bootstrap tokens, or one-time runner packs.
