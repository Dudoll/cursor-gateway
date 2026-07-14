import { createHash } from "node:crypto";

const EMAIL_RE =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

/** Reject CRLF / header injection and enforce a conservative email shape. */
export function assertMailAddress(raw: unknown, label = "email"): string {
  if (typeof raw !== "string") throw new Error(`${label}_missing`);
  const email = raw.trim().toLowerCase();
  if (!email) throw new Error(`${label}_missing`);
  if (email.length > 320) throw new Error(`${label}_invalid`);
  if (/[\r\n\0]/.test(raw) || /[\r\n\0]/.test(email)) throw new Error(`${label}_injection`);
  if (!EMAIL_RE.test(email)) throw new Error(`${label}_invalid`);
  return email;
}

export function assertSmtpPort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("smtp_port_invalid");
  }
  return port;
}

export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const localHint =
    local.length <= 1 ? "*" : `${local[0]}${"*".repeat(Math.min(local.length - 1, 3))}`;
  return `${localHint}@${domain}`;
}

export function emailFingerprint(email: string): string {
  return createHash("sha256").update(`pairing-recipient:${email}`).digest("hex").slice(0, 16);
}

/** Stable Resend Idempotency-Key for a pairId. */
export function pairingMailIdempotencyKey(pairId: string): string {
  return `pairing-mail:${pairId}`;
}
