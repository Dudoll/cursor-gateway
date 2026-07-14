/**
 * Trusted pairing recipient helpers.
 * Recipient must come from Cloudflare Access–bound app_users.email only.
 */
import { createHash } from "node:crypto";

const EMAIL_RE =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

/** Reject CRLF / header injection and enforce a conservative email shape. */
export function assertTrustedRecipientEmail(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new Error("recipient_email_missing");
  }
  const email = raw.trim().toLowerCase();
  if (!email) throw new Error("recipient_email_missing");
  if (email.length > 320) throw new Error("recipient_email_invalid");
  if (/[\r\n\0]/.test(email)) throw new Error("recipient_email_injection");
  if (!EMAIL_RE.test(email)) throw new Error("recipient_email_invalid");
  return email;
}

/** Stable irreversible fingerprint for logs/audit (never the raw address). */
export function recipientEmailFingerprint(email: string): string {
  return createHash("sha256").update(`pairing-recipient:${email}`).digest("hex").slice(0, 16);
}

/** Mask for optional emailHint on offers (not a secret, but avoid full address). */
export function maskEmailHint(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const localHint =
    local.length <= 1 ? "*" : `${local[0]}${"*".repeat(Math.min(local.length - 1, 3))}`;
  return `${localHint}@${domain}`;
}
