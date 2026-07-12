# Isolated release report sync

The release service uses its own PostgreSQL and Redis volumes. Shared AI Infra
and AI Agent editions are copied through authenticated automation endpoints;
user accounts, profiles, progress, question threads, and payment entitlements
are never copied.

```bash
python3 integrations/release/sync_reports.py --limit 7
```

The script reads only `AUTOMATION_SHARED_SECRET` from the internal and release
`.env` files and never prints either value. Imports are idempotent by report and
UTC+8 edition date.
