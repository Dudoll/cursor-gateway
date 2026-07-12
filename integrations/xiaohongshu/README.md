# Xiaohongshu interview-post publisher

This integration turns the latest `ai-infra-mianshi` and
`ai-agent-mianshi` editions into **two separate Xiaohongshu post packages**.
Each package contains a caption, metadata, a cover, question cards, and a trend
summary card. Draft creation is idempotent per report run.

## Why manual review is the default

The public Xiaohongshu Ark documentation describes product, inventory, order,
and logistics APIs. It does not document a general creator-note publishing API:

- <https://school.xiaohongshu.com/en/open/index.html>
- <https://school.xiaohongshu.com/en/open/product/summary.html>

Do not reverse-engineer private endpoints or automate consumer login. Keep
`XHS_PUBLISH_MODE=manual` until Xiaohongshu or an authorized partner grants and
documents a publishing interface for the account.

## Workflow

1. Prepare both latest reports:

   ```bash
   curl -X POST \
     -H "Authorization: Bearer $CURSOR_GATEWAY_AUTOMATION_SECRET" \
     "$CURSOR_GATEWAY_INTERNAL_URL/api/automation/social/xiaohongshu/prepare-latest"
   ```

2. An admin reviews each draft through `GET /api/social/publications` and calls
   `POST /api/social/publications/:id/approve`.
3. Export one approved post:

   ```bash
   python -m pip install -r integrations/xiaohongshu/requirements.txt
   python integrations/xiaohongshu/publisher.py --mode manual
   ```

4. Upload `card-*.png` and `caption.md` in the
   Xiaohongshu creator interface. Record the external post id through the
   automation result endpoint if desired.

Manual packages default to `~/.hermes/xhs-outbox/<publication-id>/` with mode
`0700`. Tokens and account cookies are never written into the package.

## Authorized API adapter

When an approved partner endpoint is available, configure secrets only in the
runtime environment:

```bash
XHS_PUBLISH_MODE=official
XHS_OFFICIAL_PUBLISH_URL=https://partner.example.com/publish
XHS_OFFICIAL_ACCESS_TOKEN=...
```

The endpoint receives the publication JSON and must return `{ "post_id": "…" }`.
This isolates platform-specific upload/auth logic from the report pipeline.
