import { createConnection, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";

export type SmtpSendOptions = {
  host: string;
  port: number;
  /** When true, wrap the socket in TLS immediately (typical for port 465). */
  secure?: boolean;
  /** When true (default for non-secure ports), upgrade with STARTTLS after EHLO. */
  requireTls?: boolean;
  user?: string;
  pass?: string;
  from: string;
  to: string;
  subject: string;
  text: string;
  timeoutMs?: number;
};

class SmtpError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly reply?: string
  ) {
    super(message);
    this.name = "SmtpError";
  }
}

/**
 * Minimal SMTP client (EHLO, STARTTLS/TLS, AUTH LOGIN/PLAIN, MAIL/RCPT/DATA).
 * Enough for Resend / SES / Mailgun / SendGrid SMTP relays — no extra deps.
 */
export async function sendSmtpMail(options: SmtpSendOptions): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const secure = options.secure ?? options.port === 465;
  const requireTls = options.requireTls ?? !secure;

  let socket: Socket | TLSSocket = await openSocket({
    host: options.host,
    port: options.port,
    secure,
    timeoutMs
  });

  try {
    await expectReply(socket, timeoutMs, [220]);
    let features = await ehlo(socket, options.host, timeoutMs);

    if (!secure && requireTls) {
      if (!features.has("STARTTLS")) {
        throw new SmtpError("SMTP server does not advertise STARTTLS");
      }
      await command(socket, "STARTTLS", timeoutMs, [220]);
      socket = await upgradeTls(socket, options.host, timeoutMs);
      features = await ehlo(socket, options.host, timeoutMs);
    }

    if (options.user !== undefined && options.pass !== undefined) {
      await authenticate(socket, features, options.user, options.pass, timeoutMs);
    }

    await command(socket, `MAIL FROM:<${extractAddress(options.from)}>`, timeoutMs, [250]);
    await command(socket, `RCPT TO:<${extractAddress(options.to)}>`, timeoutMs, [250, 251]);
    await command(socket, "DATA", timeoutMs, [354]);
    const payload = buildMimeMessage(options);
    await writeRaw(socket, `${payload}\r\n.\r\n`);
    await expectReply(socket, timeoutMs, [250]);
    await command(socket, "QUIT", timeoutMs, [221]).catch(() => undefined);
  } finally {
    socket.destroy();
  }
}

function openSocket(input: {
  host: string;
  port: number;
  secure: boolean;
  timeoutMs: number;
}): Promise<Socket | TLSSocket> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    if (input.secure) {
      const socket = tlsConnect(
        {
          host: input.host,
          port: input.port,
          servername: input.host,
          timeout: input.timeoutMs
        },
        () => {
          socket.off("error", onError);
          resolve(socket);
        }
      );
      socket.once("error", onError);
      return;
    }
    const socket = createConnection(
      { host: input.host, port: input.port, timeout: input.timeoutMs },
      () => {
        socket.off("error", onError);
        resolve(socket);
      }
    );
    socket.once("error", onError);
  });
}

function upgradeTls(
  socket: Socket,
  host: string,
  timeoutMs: number
): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    const tlsSocket = tlsConnect(
      {
        socket,
        host,
        servername: host,
        timeout: timeoutMs
      },
      () => {
        tlsSocket.off("error", onError);
        resolve(tlsSocket);
      }
    );
    tlsSocket.once("error", onError);
  });
}

async function ehlo(
  socket: Socket | TLSSocket,
  host: string,
  timeoutMs: number
): Promise<Set<string>> {
  const reply = await command(socket, `EHLO ${sanitizeEhloHost(host)}`, timeoutMs, [250]);
  const features = new Set<string>();
  for (const line of reply.split(/\r?\n/)) {
    const match = /^250[\s-](.+)$/i.exec(line.trim());
    if (match) features.add(match[1]!.toUpperCase());
  }
  return features;
}

async function authenticate(
  socket: Socket | TLSSocket,
  features: Set<string>,
  user: string,
  pass: string,
  timeoutMs: number
): Promise<void> {
  const authLine = [...features].find((item) => item.startsWith("AUTH "));
  const mechanisms = new Set(
    (authLine ?? "")
      .slice(5)
      .split(/\s+/)
      .map((item) => item.trim().toUpperCase())
      .filter(Boolean)
  );

  if (mechanisms.has("LOGIN") || mechanisms.size === 0) {
    await command(socket, "AUTH LOGIN", timeoutMs, [334]);
    await command(socket, Buffer.from(user, "utf8").toString("base64"), timeoutMs, [334]);
    await command(socket, Buffer.from(pass, "utf8").toString("base64"), timeoutMs, [235]);
    return;
  }

  if (mechanisms.has("PLAIN")) {
    const token = Buffer.from(`\0${user}\0${pass}`, "utf8").toString("base64");
    await command(socket, `AUTH PLAIN ${token}`, timeoutMs, [235]);
    return;
  }

  throw new SmtpError(`Unsupported AUTH mechanisms: ${[...mechanisms].join(",") || "none"}`);
}

function buildMimeMessage(options: SmtpSendOptions): string {
  const date = new Date().toUTCString();
  const encodedSubject = encodeRfc2047(options.subject);
  const lines = [
    `From: ${options.from}`,
    `To: ${options.to}`,
    `Subject: ${encodedSubject}`,
    `Date: ${date}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    options.text.replace(/\r?\n/g, "\r\n")
  ];
  // Dot-stuff lines that begin with '.'
  return lines
    .join("\r\n")
    .split("\r\n")
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join("\r\n");
}

function encodeRfc2047(value: string): string {
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function extractAddress(mailbox: string): string {
  const angle = /<([^>]+)>/.exec(mailbox);
  if (angle) return angle[1]!.trim();
  return mailbox.trim();
}

function sanitizeEhloHost(host: string): string {
  return host.replace(/[^\w.-]/g, "") || "localhost";
}

async function command(
  socket: Socket | TLSSocket,
  line: string,
  timeoutMs: number,
  expected: number[]
): Promise<string> {
  await writeRaw(socket, `${line}\r\n`);
  return expectReply(socket, timeoutMs, expected);
}

function writeRaw(socket: Socket | TLSSocket, data: string): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(data, "utf8", (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function expectReply(
  socket: Socket | TLSSocket,
  timeoutMs: number,
  expected: number[]
): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new SmtpError(`SMTP timeout waiting for ${expected.join("/")}`));
    }, timeoutMs);

    const onData = (chunk: Buffer | string) => {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const parsed = tryParseSmtpReply(buffer);
      if (!parsed) return;
      cleanup();
      if (!expected.includes(parsed.code)) {
        reject(
          new SmtpError(
            `Unexpected SMTP reply ${parsed.code} (wanted ${expected.join("/")})`,
            parsed.code,
            parsed.text
          )
        );
        return;
      }
      resolve(parsed.text);
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
    };

    socket.on("data", onData);
    socket.once("error", onError);
  });
}

function tryParseSmtpReply(buffer: string): { code: number; text: string } | null {
  const lines = buffer.split(/\r?\n/);
  // Need a complete final line: "250 ..." (space) not "250-..."
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const match = /^(\d{3})([\s-])(.*)$/.exec(line);
    if (!match) continue;
    if (match[2] === "-") continue;
    const code = Number(match[1]);
    const text = lines.slice(0, i + 1).join("\n");
    // Ensure we consumed through this line (buffer may have trailing data)
    return { code, text };
  }
  return null;
}

export const __smtpTestUtils = {
  buildMimeMessage,
  encodeRfc2047,
  extractAddress,
  tryParseSmtpReply
};
