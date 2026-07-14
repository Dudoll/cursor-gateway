export type MailApiProvider = "resend" | "mailgun" | "sendgrid";

export type ApiMailPayload = {
  from: string;
  to: string;
  subject: string;
  text: string;
};

export type ApiMailConfig = {
  provider: MailApiProvider;
  apiKey: string;
  /** Mailgun only: e.g. https://api.mailgun.net/v3/mg.example.com */
  mailgunBaseUrl?: string;
};

/**
 * HTTP API senders for common transactional providers.
 * Prefer these when the provider documents API over SMTP (Resend default).
 */
export async function sendApiMail(
  config: ApiMailConfig,
  payload: ApiMailPayload
): Promise<void> {
  switch (config.provider) {
    case "resend":
      await sendResend(config.apiKey, payload);
      return;
    case "mailgun":
      await sendMailgun(config, payload);
      return;
    case "sendgrid":
      await sendSendgrid(config.apiKey, payload);
      return;
    default: {
      const exhaust: never = config.provider;
      throw new Error(`unsupported_mail_api_provider:${String(exhaust)}`);
    }
  }
}

async function sendResend(apiKey: string, payload: ApiMailPayload): Promise<void> {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: payload.from,
      to: [payload.to],
      subject: payload.subject,
      text: payload.text
    })
  });
  if (!response.ok) {
    const body = await safeText(response);
    throw new Error(`resend_api_failed_${response.status}:${truncate(body)}`);
  }
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
  const response = await fetch(`${base}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`api:${config.apiKey}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: form.toString()
  });
  if (!response.ok) {
    const body = await safeText(response);
    throw new Error(`mailgun_api_failed_${response.status}:${truncate(body)}`);
  }
}

async function sendSendgrid(apiKey: string, payload: ApiMailPayload): Promise<void> {
  const from = splitMailbox(payload.from);
  const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: payload.to }] }],
      from,
      subject: payload.subject,
      content: [{ type: "text/plain", value: payload.text }]
    })
  });
  if (!response.ok) {
    const body = await safeText(response);
    throw new Error(`sendgrid_api_failed_${response.status}:${truncate(body)}`);
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

function truncate(value: string, max = 200): string {
  const cleaned = value.replace(/\s+/g, " ").trim();
  // Never echo apparent secrets back into logs.
  const redacted = cleaned.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
  return redacted.length <= max ? redacted : `${redacted.slice(0, max)}…`;
}
