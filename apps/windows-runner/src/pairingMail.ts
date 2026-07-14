import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { config } from "./config.js";
import { sendApiMail } from "./mail/apiProviders.js";
import { sendSmtpMail } from "./mail/smtpClient.js";

export type PairingMailPayload = {
  to: string;
  subject: string;
  text: string;
  magicLink: string;
};

export type PairingMailDelivery = "log" | "smtp" | "api";

/**
 * Deliver Secure Web magic-link mail.
 *
 * Modes:
 * - `log`  — write to a local file (dry-run / fallback). Never production delivery.
 * - `smtp` — generic SMTP (Resend/SES/Mailgun/SendGrid SMTP relays, etc.).
 * - `api`  — HTTP API (`MAIL_API_PROVIDER=resend|mailgun|sendgrid`).
 *
 * On smtp/api failure the error is thrown (caller should not publish a broken offer
 * without knowing delivery failed). Use `PAIRING_MAIL_ALSO_LOG=true` to mirror
 * successful deliveries into the log file for ops debugging (magic link still
 * appears in the log — keep file perms 0600).
 */
export async function sendPairingEmail(
  payload: PairingMailPayload
): Promise<PairingMailDelivery> {
  const mode = config.pairingMailMode;
  const fromHeader = formatFromHeader(config.pairingMailFrom, config.pairingMailFromName);

  if (mode === "api") {
    if (!config.mailApiKey) {
      throw new Error("PAIRING_MAIL_MODE=api requires MAIL_API_KEY");
    }
    await sendApiMail(
      {
        provider: config.mailApiProvider,
        apiKey: config.mailApiKey,
        ...(config.mailgunBaseUrl ? { mailgunBaseUrl: config.mailgunBaseUrl } : {})
      },
      {
        from: fromHeader,
        to: payload.to,
        subject: payload.subject,
        text: payload.text
      }
    );
    maybeMirrorLog(payload, "api");
    console.log(`[pairing-mail] Sent via API provider=${config.mailApiProvider} to=${redactEmail(payload.to)}`);
    return "api";
  }

  if (mode === "smtp") {
    const smtp = resolveSmtpSettings();
    if (!smtp) {
      console.warn(
        "[pairing-mail] SMTP mode selected but SMTP_HOST (or SMTP_URL) is not configured; falling back to log."
      );
      writeLog(payload);
      return "log";
    }
    await sendSmtpMail({
      ...smtp,
      from: fromHeader,
      to: payload.to,
      subject: payload.subject,
      text: payload.text
    });
    maybeMirrorLog(payload, "smtp");
    console.log(
      `[pairing-mail] Sent via SMTP host=${smtp.host}:${smtp.port} to=${redactEmail(payload.to)}`
    );
    return "smtp";
  }

  writeLog(payload);
  return "log";
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
  // Quote display name if it contains non-atom characters.
  const needsQuote = /[^\w.+ -]/u.test(fromName) || /\s/.test(fromName);
  const name = needsQuote ? `"${fromName.replace(/"/g, '\\"')}"` : fromName;
  return `${name} <${from}>`;
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

function redactEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 1) return "***";
  return `${email[0]}***${email.slice(at)}`;
}
