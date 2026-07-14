import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServer, type Socket } from "node:net";

const root = mkdtempSync(join(tmpdir(), "cursor-gateway-mail-test-"));
process.env.GATEWAY_URL = "https://gateway.test";
process.env.RUNNER_ID = "runner-test";
process.env.RUNNER_SHARED_SECRET = "x".repeat(32);
process.env.RUNNER_WORKSPACES = root;
process.env.CURSOR_API_KEY = "cursor-test";
process.env.RUNNER_E2EE_ALLOW_INSECURE_DEV_STORAGE = "true";
process.env.RUNNER_E2EE_STATE_FILE = join(root, "runner-state.dat");
process.env.RUNNER_E2EE_MASTER_KEY_FILE = "";
delete process.env.RUNNER_E2EE_MASTER_KEY;
process.env.PAIRING_MAIL_MODE = "log";
process.env.PAIRING_MAIL_LOG_FILE = join(root, "pairing-mail.log");
process.env.PAIRING_MAIL_FROM = "no-reply@piallera.com";
process.env.PAIRING_MAIL_FROM_NAME = "Piallera Secure";

test("pairing mail template is Chinese and includes magic link + safety tips", async () => {
  const { buildPairingMailContent } = await import("../src/mail/pairingMailTemplate.js");
  const content = buildPairingMailContent({
    magicLink: "https://secure.example.com/#pair=abc.TOKEN",
    pairId: "abc",
    runnerId: "runner-test",
    expiresAt: "2026-07-14T10:00:00.000Z",
    ttlHint: "约 15 分钟"
  });
  assert.match(content.subject, /配对|Piallera/);
  assert.match(content.text, /同一浏览器/);
  assert.match(content.text, /一次性/);
  assert.match(content.text, /勿转发|请勿转发/);
  assert.match(content.text, /https:\/\/secure\.example\.com\/#pair=abc\.TOKEN/);
  assert.match(content.text, /约 15 分钟/);
  assert.match(content.text, /abc/);
});

test("parseSmtpUrl handles smtps credentials", async () => {
  const { parseSmtpUrl } = await import("../src/pairingMail.js");
  const parsed = parseSmtpUrl("smtps://resend:re_test%2Bkey@smtp.resend.com:465");
  assert.equal(parsed.host, "smtp.resend.com");
  assert.equal(parsed.port, 465);
  assert.equal(parsed.secure, true);
  assert.equal(parsed.user, "resend");
  assert.equal(parsed.pass, "re_test+key");
});

test("log mode writes magic link without secrets in console path", async () => {
  const { sendPairingEmail } = await import("../src/pairingMail.js");
  const result = await sendPairingEmail({
    to: "ops@example.com",
    subject: "test",
    magicLink: "https://secure.example.com/#pair=x.y",
    text: "body with https://secure.example.com/#pair=x.y"
  });
  assert.equal(result, "log");
  const logPath = process.env.PAIRING_MAIL_LOG_FILE!;
  assert.equal(existsSync(logPath), true);
  const body = readFileSync(logPath, "utf8");
  assert.match(body, /magicLink: https:\/\/secure\.example\.com\/#pair=x\.y/);
  assert.match(body, /ops@example.com/);
});

test("smtp client speaks AUTH LOGIN against a fake server", async () => {
  const { sendSmtpMail } = await import("../src/mail/smtpClient.js");

  const server = createServer((socket: Socket) => {
    let stage = 0;
    let buffer = "";
    socket.write("220 localhost ESMTP test\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (stage === 0 && /^EHLO /i.test(line)) {
          socket.write("250-localhost\r\n250-AUTH LOGIN PLAIN\r\n250 OK\r\n");
          stage = 1;
        } else if (stage === 1 && line === "AUTH LOGIN") {
          socket.write("334 VXNlcm5hbWU6\r\n");
          stage = 2;
        } else if (stage === 2) {
          socket.write("334 UGFzc3dvcmQ6\r\n");
          stage = 3;
        } else if (stage === 3) {
          socket.write("235 OK\r\n");
          stage = 4;
        } else if (stage === 4 && /^MAIL FROM:/i.test(line)) {
          socket.write("250 OK\r\n");
          stage = 5;
        } else if (stage === 5 && /^RCPT TO:/i.test(line)) {
          socket.write("250 OK\r\n");
          stage = 6;
        } else if (stage === 6 && line === "DATA") {
          socket.write("354 Go\r\n");
          stage = 7;
        } else if (stage === 7 && line === ".") {
          socket.write("250 Queued\r\n");
          stage = 8;
        } else if (stage === 8 && line === "QUIT") {
          socket.write("221 Bye\r\n");
          socket.end();
        }
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  try {
    await sendSmtpMail({
      host: "127.0.0.1",
      port: address.port,
      secure: false,
      requireTls: false,
      user: "resend",
      pass: "re_test",
      from: "Piallera Secure <no-reply@piallera.com>",
      to: "ops@example.com",
      subject: "【测试】配对",
      text: "hello\nhttps://secure.example.com/#pair=a.b",
      timeoutMs: 5000
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});

test("smtp MIME encodes non-ASCII subject", async () => {
  const { __smtpTestUtils } = await import("../src/mail/smtpClient.js");
  const mime = __smtpTestUtils.buildMimeMessage({
    host: "x",
    port: 25,
    from: "no-reply@piallera.com",
    to: "a@b.c",
    subject: "【Piallera】配对",
    text: "body"
  });
  assert.match(mime, /Subject: =\?UTF-8\?B\?/);
  assert.match(mime, /Content-Type: text\/plain; charset="UTF-8"/);
});
