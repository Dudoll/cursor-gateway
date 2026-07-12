# Interview content and paid workspace architecture

## Product surface

- `/reports/ai-infra-mianshi` — shared daily AI Infra interview edition.
- `/reports/ai-agent-mianshi` — shared daily AI Agent edition, prioritizing Java transitions.
- `/interview` — paid, per-user training workspace with profile, progress,
  recommendations, and a private AI coach thread.
- `/interview/activate?token=...` — one-time paid-access activation.

Daily editions are shared editorial content. Every report follow-up question,
profile, progress record, and coach run is stored and queried with the signed-in
`user_id`. The report API never reads another user's question thread.

## Payment-to-access flow

1. A payment provider verifies a successful payment server-side.
2. The payment webhook calls:

   ```http
   POST /api/automation/interview-entitlements
   Authorization: Bearer <automation secret>
   Content-Type: application/json

   {
     "email": "buyer@example.com",
     "plan": "pro",
     "paymentProvider": "your-provider",
     "paymentReference": "provider-transaction-id",
     "expiresAt": null,
     "activationTtlHours": 48
   }
   ```

3. The response contains a one-time `activationUrl`. Send it only to the paid
   email through the payment provider or transactional email service.
4. Cloudflare Access authenticates the mailbox. The application additionally
   requires the signed-in email to match the entitlement email.
5. Activation stores the `app_users.id` on the entitlement and erases the token
   hash. Raw activation tokens are never stored in PostgreSQL or logs.

Static `ALLOWED_EMAILS` continue to act as administrator accounts. Paid emails
can authenticate only while their pending activation or active entitlement is
valid.

## Tenant isolation rules

- `interview_profiles.user_id` is the primary key.
- `interview_question_progress` has a composite primary key starting with
  `user_id`.
- Personalized coach runs use an automation thread whose uniqueness key is
  `(user_id, thread_key)`.
- Shared report editions use only the `automation` service principal.
- Report Q&A creates and reads threads under the current web principal, never
  under the shared service principal.
- Every mutation writes an audit event without storing payment secrets or raw
  activation tokens.

## Xiaohongshu funnel

`POST /api/automation/social/xiaohongshu/prepare-latest` creates two idempotent
drafts: one AI Infra post and one AI Agent post. The draft includes a caption,
landing URL, hashtags, and card specifications. An administrator reviews and
approves drafts before a worker can claim them.

The safe default is manual export. See
[`integrations/xiaohongshu/README.md`](../integrations/xiaohongshu/README.md).
The adapter intentionally avoids undocumented private APIs and consumer-login
automation. An authorized publishing endpoint can be configured later without
changing the report or approval pipeline.

## Recommended production follow-ups

1. Connect a real payment webhook and transactional email provider.
2. Configure a Cloudflare Access policy that permits paid-email OTP while the
   application remains the source of truth for entitlement checks.
3. Add rate limits and per-plan usage quotas to `/api/interview/questions`.
4. Add payment refund/revocation webhooks that set entitlements to `revoked`.
5. After Xiaohongshu grants documented publishing access, implement its upload
   contract behind the existing official adapter environment variables.
