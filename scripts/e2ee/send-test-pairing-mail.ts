/**
 * Send (or log) one pairing-mail using the same code path as the runner.
 *
 *   npx tsx scripts/e2ee/send-test-pairing-mail.ts [to@example.com]
 *
 * Honors apps/windows-runner/.env. With PAIRING_MAIL_MODE=log this only
 * writes ~/.cursor-gateway/pairing-mail.log (or PAIRING_MAIL_LOG_FILE).
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const runnerRoot = resolve(here, "../../apps/windows-runner");
process.chdir(runnerRoot);

// Ensure config can load .env from the runner package.
process.env.GATEWAY_URL ??= "https://gateway.example.com";
process.env.RUNNER_SHARED_SECRET ??= "0".repeat(32);
process.env.RUNNER_WORKSPACES ??= join(runnerRoot, ".");
process.env.CURSOR_API_KEY ??= "cursor_test_placeholder";

const toArg = process.argv[2];
if (toArg) process.env.PAIRING_MAIL_TO = toArg;

const { config } = await import("../../apps/windows-runner/src/config.js");
const { buildPairingMailContent } = await import(
  "../../apps/windows-runner/src/mail/pairingMailTemplate.js"
);
const { sendPairingEmail, pairingMailLogPath } = await import(
  "../../apps/windows-runner/src/pairingMail.js"
);

const to = config.pairingMailTo;
if (!to) {
  console.error("Set PAIRING_MAIL_TO or pass an email argument.");
  process.exit(1);
}

const expiresAt = new Date(Date.now() + config.pairingTtlSeconds * 1000).toISOString();
const magicLink = `${(config.secureClientOrigin || "https://secure.example.com").replace(/\/$/, "")}/#pair=test-pairId.test-token-not-real`;
const mail = buildPairingMailContent({
  magicLink,
  pairId: "test-pairId",
  runnerId: config.runnerId,
  expiresAt,
  ttlHint: `约 ${Math.max(1, Math.round(config.pairingTtlSeconds / 60))} 分钟`
});

console.log(`mode=${config.pairingMailMode} to=${to[0]}***${to.slice(to.indexOf("@"))}`);
const delivery = await sendPairingEmail({
  to,
  subject: mail.subject,
  magicLink,
  text: mail.text
});
console.log(`delivery=${delivery}`);
if (delivery === "log") {
  console.log(`logFile=${pairingMailLogPath()}`);
}
console.log("ok");
