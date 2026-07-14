export type MailApiProvider = "resend" | "mailgun" | "sendgrid";

export type ApiMailPayload = {
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Stable unique key per pairId (or test id) for provider idempotency. */
  idempotencyKey?: string;
};

export type ApiMailConfig = {
  provider: MailApiProvider;
  apiKey: string;
  /** Mailgun only: e.g. https://api.mailgun.net/v3/mg.example.com */
  mailgunBaseUrl?: string;
  connectTimeoutMs?: number;
  overallTimeoutMs?: number;
};

export type ApiMailResult = {
  provider: MailApiProvider;
  messageId?: string;
};

/**
 * HTTP API senders for common transactional providers.
 * Prefer these when the provider documents API over SMTP (Resend default).
 */
export async function sendApiMail(
  config: ApiMailConfig,
  payload: ApiMailPayload
): Promise<ApiMailResult> {
  switch (config.provider) {
    case "resend":
      return sendResend(config, payload);
    case "mailgun":
      await sendMailgun(config, payload);
      return { provider: "mailgun" };
    case "sendgrid":
      await sendSendgrid(config, payload);
      return { provider: "sendgrid" };
    default: {
      const exhaust: never = config.provider;
      throw new Error(`unsupported_mail_api_provider:${String(exhaust)}`);
    }
  }
}

async function sendResend(
  config: ApiMailConfig,
  payload: ApiMailPayload
): Promise<ApiMailResult> {
  const connectTimeoutMs = config.connectTimeoutMs ?? 10_000;
  const overallTimeoutMs = config.overallTimeoutMs ?? 30_000;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.apiKey}`,
    "Content-Type": "application/json"
  };
  if (payload.idempotencyKey) {
    headers["Idempotency-Key"] = payload.idempotencyKey;
  }

  const response = await fetchWithTimeout(
    "https://api.resend.com/emails",
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        from: payload.from,
        to: [payload.to],
        subject: payload.subject,
        text: payload.text,
        ...(payload.html ? { html: payload.html } : {})
      })
    },
    { connectTimeoutMs, overallTimeoutMs }
  );

  const bodyText = await safeText(response);
  if (!response.ok) {
    throw new Error(`resend_api_failed_${response.status}:${sanitizeProviderBody(bodyText)}`);
  }

  let messageId: string | undefined;
  try {
    const parsed = JSON.parse(bodyText) as { id?: unknown };
    if (typeof parsed.id === "string" && parsed.id.trim()) {
      messageId = parsed.id.trim();
    }
  } catch {
    // Non-JSON success bodies are unusual; still treat as accepted without id.
  }
  return { provider: "resend", ...(messageId ? { messageId } : {}) };
}

async function sendMailgun(config: ApiMailConfig, payload: ApiMailPayload): Promise<void> {
  const base = config.mailgunBaseUrl?.replace(/\/$/, "");
  if (!base) {
    throw new Error("MAILGUN_BASE_URL is required for MAIL_API_PROVIDER=mailgun");
  }
  const form = new URLSearchParams();
  form.set("from", payload.from);
  form.set("to", payload.to);
  form.set("subject", payload.subject);
  form.set("text", payload.text);
  if (payload.html) form.set("html", payload.html);
  const response = await fetchWithTimeout(
    `${base}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`api:${config.apiKey}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: form.toString()
    },
    {
      connectTimeoutMs: config.connectTimeoutMs ?? 10_000,
      overallTimeoutMs: config.overallTimeoutMs ?? 30_000
    }
  );
  if (!response.ok) {
    const body = await safeText(response);
    throw new Error(`mailgun_api_failed_${response.status}:${sanitizeProviderBody(body)}`);
  }
}

async function sendSendgrid(config: ApiMailConfig, payload: ApiMailPayload): Promise<void> {
  const from = splitMailbox(payload.from);
  const content: Array<{ type: string; value: string }> = [
    { type: "text/plain", value: payload.text }
  ];
  if (payload.html) content.push({ type: "text/html", value: payload.html });
  const response = await fetchWithTimeout(
    "https://api.sendgrid.com/v3/mail/send",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        ...(payload.idempotencyKey
          ? { "Idempotency-Key": payload.idempotencyKey }
          : {})
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: payload.to }] }],
        from,
        subject: payload.subject,
        content
      })
    },
    {
      connectTimeoutMs: config.connectTimeoutMs ?? 10_000,
      overallTimeoutMs: config.overallTimeoutMs ?? 30_000
    }
  );
  if (!response.ok) {
    const body = await safeText(response);
    throw new Error(`sendgrid_api_failed_${response.status}:${sanitizeProviderBody(body)}`);
  }
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeouts: { connectTimeoutMs: number; overallTimeoutMs: number }
): Promise<Response> {
  // Node fetch lacks a separate connect timeout; use the tighter of connect/overall.
  const budgetMs = Math.max(
    1_000,
    Math.min(timeouts.connectTimeoutMs, timeouts.overallTimeoutMs)
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("mail_api_timeout");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function splitMailbox(mailbox: string): { email: string; name?: string } {
  const match = /^(.*)<([^>]+)>\s*$/.exec(mailbox.trim());
  if (!match) return { email: mailbox.trim() };
  const name = match[1]!.trim().replace(/^"|"$/g, "");
  const email = match[2]!.trim();
  return name ? { email, name } : { email };
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

export function sanitizeProviderBody(value: string, max = 200): string {
  const cleaned = value
    .replace(/\s+/g, " ")
    .trim()
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/re_[A-Za-z0-9_]+/g, "re_[redacted]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/https?:\/\/\S*#pair=\S+/gi, "[redacted-magic-link]");
  return cleaned.length <= max ? cleaned : `${cleaned.slice(0, max)}…`;
}
