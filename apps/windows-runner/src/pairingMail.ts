import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { config } from "./config.js";
import { sendApiMail } from "./mail/apiProviders.js";
import { sendSmtpMail } from "./mail/smtpClient.js";
import { assertMailAddress, maskEmail, pairingMailIdempotencyKey } from "./mail/mailAddress.js";

export type PairingMailPayload = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  magicLink: string;
  /** When set, used as Resend/SendGrid Idempotency-Key (stable per pairId). */
  pairId?: string;
};

export type PairingMailDelivery = "log" | "smtp" | "api";

export type PairingMailSendResult = {
  delivery: PairingMailDelivery;
  messageId?: string;
};

/**
 * Deliver Secure Web magic-link mail.
 *
 * Modes:
 * - `log`  — write to a local file (dry-run). Never production delivery.
 * - `smtp` — Nodemailer SMTP (Resend/SES/Mailgun/SendGrid SMTP relays, etc.).
 * - `api`  — HTTP API (`MAIL_API_PROVIDER=resend|mailgun|sendgrid`).
 *
 * Live modes (smtp/api) must be fully configured at process start (fail-fast).
 * On send failure the error is thrown. Use `PAIRING_MAIL_ALSO_LOG=true` to mirror
 * successful deliveries into the log file (magic link still appears — keep 0600).
 */
export async function sendPairingEmail(
  payload: PairingMailPayload
): Promise<PairingMailSendResult> {
  const mode = config.pairingMailMode;
  const to = assertMailAddress(payload.to, "recipient");
  const from = assertMailAddress(config.pairingMailFrom, "from");
  assertNoHeaderInjection(payload.subject, "subject");
  const fromHeader = formatFromHeader(from, config.pairingMailFromName);

  if (mode === "api") {
    if (!config.mailApiKey) {
      throw new Error("PAIRING_MAIL_MODE=api requires MAIL_API_KEY");
    }
    const result = await sendApiMail(
      {
        provider: config.mailApiProvider,
        apiKey: config.mailApiKey,
        ...(config.mailgunBaseUrl ? { mailgunBaseUrl: config.mailgunBaseUrl } : {})
      },
      {
        from: fromHeader,
        to,
        subject: payload.subject,
        text: payload.text,
        ...(payload.html ? { html: payload.html } : {}),
        ...(payload.pairId
          ? { idempotencyKey: pairingMailIdempotencyKey(payload.pairId) }
          : {})
      }
    );
    maybeMirrorLog(payload, "api");
    console.log(
      `[pairing-mail] Sent via API provider=${config.mailApiProvider}` +
        ` to=${maskEmail(to)}` +
        (result.messageId ? ` messageId=${result.messageId}` : "")
    );
    return {
      delivery: "api",
      ...(result.messageId ? { messageId: result.messageId } : {})
    };
  }

  if (mode === "smtp") {
    const smtp = resolveSmtpSettings();
    if (!smtp) {
      throw new Error("PAIRING_MAIL_MODE=smtp requires SMTP_HOST (or SMTP_URL)");
    }
    const result = await sendSmtpMail({
      ...smtp,
      from: fromHeader,
      to,
      subject: payload.subject,
      text: payload.text,
      ...(payload.html ? { html: payload.html } : {})
    });
    maybeMirrorLog(payload, "smtp");
    console.log(
      `[pairing-mail] Sent via SMTP host=${smtp.host}:${smtp.port} to=${maskEmail(to)}` +
        (result.messageId ? ` messageId=${result.messageId}` : "")
    );
    return {
      delivery: "smtp",
      ...(result.messageId ? { messageId: result.messageId } : {})
    };
  }

  writeLog(payload);
  return { delivery: "log" };
}

function resolveSmtpSettings():
  | {
      host: string;
      port: number;
      secure?: boolean;
      requireTls?: boolean;
      user?: string;
      pass?: string;
    }
  | undefined {
  if (config.smtpHost) {
    const settings: {
      host: string;
      port: number;
      secure?: boolean;
      requireTls?: boolean;
      user?: string;
      pass?: string;
    } = {
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpSecure,
      requireTls: config.smtpRequireTls
    };
    if (config.smtpUser !== undefined) settings.user = config.smtpUser;
    if (config.smtpPass !== undefined) settings.pass = config.smtpPass;
    return settings;
  }
  if (!config.smtpUrl) return undefined;
  return parseSmtpUrl(config.smtpUrl);
}

/** Parse smtp:// or smtps:// URLs: smtps://user:pass@host:465 */
export function parseSmtpUrl(raw: string): {
  host: string;
  port: number;
  secure?: boolean;
  user?: string;
  pass?: string;
} {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("SMTP_URL is not a valid URL");
  }
  if (url.protocol !== "smtp:" && url.protocol !== "smtps:") {
    throw new Error("SMTP_URL must use smtp:// or smtps://");
  }
  const secure = url.protocol === "smtps:" || url.port === "465";
  const port = url.port ? Number(url.port) : secure ? 465 : 587;
  if (!url.hostname) throw new Error("SMTP_URL is missing host");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("SMTP_URL has invalid port");
  }
  const settings: {
    host: string;
    port: number;
    secure?: boolean;
    user?: string;
    pass?: string;
  } = {
    host: url.hostname,
    port,
    secure
  };
  if (url.username) settings.user = decodeURIComponent(url.username);
  if (url.password) settings.pass = decodeURIComponent(url.password);
  return settings;
}

function formatFromHeader(from: string, fromName?: string): string {
  if (!fromName) return from;
  if (/[\r\n\0]/.test(fromName)) throw new Error("from_name_injection");
  const needsQuote = /[^\w.+ -]/u.test(fromName) || /\s/.test(fromName);
  const name = needsQuote ? `"${fromName.replace(/"/g, '\\"')}"` : fromName;
  return `${name} <${from}>`;
}

function assertNoHeaderInjection(value: string, label: string) {
  if (/[\r\n\0]/.test(value)) throw new Error(`${label}_injection`);
}

function maybeMirrorLog(payload: PairingMailPayload, via: string) {
  if (!config.pairingMailAlsoLog) return;
  writeLog(payload, via);
}

function writeLog(payload: PairingMailPayload, via = "log") {
  const directory = join(homedir(), ".cursor-gateway");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = config.pairingMailLogFile || join(directory, "pairing-mail.log");
  const entry = [
    `---- ${new Date().toISOString()} via=${via} ----`,
    `to: ${payload.to}`,
    `subject: ${payload.subject}`,
    `magicLink: ${payload.magicLink}`,
    "",
    payload.text,
    ""
  ].join("\n");
  appendFileSync(path, entry, { mode: 0o600 });
  console.log(`[pairing-mail] Wrote magic link to ${path} (NOT production delivery)`);
}

export function pairingMailLogPath() {
  return (
    config.pairingMailLogFile ||
    join(homedir(), ".cursor-gateway", "pairing-mail.log")
  );
}

/**
 * Fail-fast validation for live mail modes. Call once at runner startup.
 * Incomplete smtp/api config must not silently degrade to log.
 */
export function assertPairingMailConfigOrThrow(): void {
  const mode = config.pairingMailMode;
  assertMailAddress(config.pairingMailFrom, "from");
  if (config.pairingMailFromName && /[\r\n\0]/.test(config.pairingMailFromName)) {
    throw new Error("PAIRING_MAIL_FROM_NAME contains illegal characters");
  }

  if (mode === "log") {
    console.warn(
      "╔══════════════════════════════════════════════════════════════════╗\n" +
        "║  WARNING: PAIRING_MAIL_MODE=log — pairing mail is NOT delivered  ║\n" +
        "║  Magic links are written to a local log file only (non-prod).    ║\n" +
        "║  Set PAIRING_MAIL_MODE=api (Resend) or smtp for production.      ║\n" +
        "╚══════════════════════════════════════════════════════════════════╝"
    );
    return;
  }

  if (mode === "api") {
    if (!config.mailApiKey) {
      throw new Error(
        "PAIRING_MAIL_MODE=api requires MAIL_API_KEY (fail-fast; will not fall back to log)"
      );
    }
    if (config.mailApiProvider === "mailgun" && !config.mailgunBaseUrl) {
      throw new Error("MAIL_API_PROVIDER=mailgun requires MAILGUN_BASE_URL");
    }
    console.log(
      `[pairing-mail] Live API mode enabled provider=${config.mailApiProvider} from=${maskEmail(config.pairingMailFrom)}`
    );
    return;
  }

  if (mode === "smtp") {
    const smtp = resolveSmtpSettings();
    if (!smtp?.host) {
      throw new Error(
        "PAIRING_MAIL_MODE=smtp requires SMTP_HOST or SMTP_URL (fail-fast; will not fall back to log)"
      );
    }
    if (!Number.isInteger(smtp.port) || smtp.port < 1 || smtp.port > 65535) {
      throw new Error("SMTP_PORT is invalid");
    }
    console.log(
      `[pairing-mail] Live SMTP mode enabled host=${smtp.host}:${smtp.port} from=${maskEmail(config.pairingMailFrom)}`
    );
  }
}
