import nodemailer from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js";

export type SmtpSendOptions = {
  host: string;
  port: number;
  /** When true, wrap the socket in TLS immediately (typical for port 465). */
  secure?: boolean;
  /** When true (default for non-secure ports), require STARTTLS upgrade. */
  requireTls?: boolean;
  user?: string;
  pass?: string;
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Socket connect timeout (ms). */
  connectionTimeoutMs?: number;
  /** Overall SMTP conversation timeout (ms). */
  socketTimeoutMs?: number;
  /** Greeting wait timeout (ms). */
  greetingTimeoutMs?: number;
};

export type SmtpSendResult = {
  messageId?: string;
  accepted: string[];
};

/**
 * Production SMTP via Nodemailer (465 implicit TLS / 587 STARTTLS).
 * Do not reintroduce a hand-rolled SMTP wire protocol for live delivery.
 */
export async function sendSmtpMail(options: SmtpSendOptions): Promise<SmtpSendResult> {
  const secure = options.secure ?? options.port === 465;
  const requireTls = options.requireTls ?? !secure;
  const connectionTimeout = options.connectionTimeoutMs ?? 15_000;
  const socketTimeout = options.socketTimeoutMs ?? 30_000;
  const greetingTimeout = options.greetingTimeoutMs ?? 15_000;

  const transportOptions: SMTPTransport.Options = {
    host: options.host,
    port: options.port,
    secure,
    requireTLS: requireTls,
    connectionTimeout,
    greetingTimeout,
    socketTimeout,
    tls: {
      // Keep defaults; do not disable cert verification.
      minVersion: "TLSv1.2"
    }
  };
  if (options.user !== undefined) {
    transportOptions.auth = {
      user: options.user,
      pass: options.pass ?? ""
    };
  }

  const transporter = nodemailer.createTransport(transportOptions);
  try {
    const info = await transporter.sendMail({
      from: options.from,
      to: options.to,
      subject: options.subject,
      text: options.text,
      ...(options.html ? { html: options.html } : {})
    });
    return {
      ...(typeof info.messageId === "string" ? { messageId: info.messageId } : {}),
      accepted: (info.accepted ?? []).map(String)
    };
  } catch (error) {
    throw sanitizeSmtpError(error);
  } finally {
    transporter.close();
  }
}

/** Build Nodemailer options for tests / diagnostics (no secrets logged). */
export function buildNodemailerTransportOptions(options: SmtpSendOptions): SMTPTransport.Options {
  const secure = options.secure ?? options.port === 465;
  const requireTls = options.requireTls ?? !secure;
  const out: SMTPTransport.Options = {
    host: options.host,
    port: options.port,
    secure,
    requireTLS: requireTls,
    connectionTimeout: options.connectionTimeoutMs ?? 15_000,
    greetingTimeout: options.greetingTimeoutMs ?? 15_000,
    socketTimeout: options.socketTimeoutMs ?? 30_000
  };
  if (options.user !== undefined) {
    out.auth = { user: options.user, pass: options.pass ?? "" };
  }
  return out;
}

function sanitizeSmtpError(error: unknown): Error {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "smtp_send_failed";
  const cleaned = message
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/pass(?:word)?[=:]\s*\S+/gi, "pass=[redacted]")
    .replace(/AUTH\s+\S+/gi, "AUTH [redacted]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]");
  return new Error(`smtp_send_failed:${cleaned.slice(0, 200)}`);
}
