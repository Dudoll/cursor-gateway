import { mkdirSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { config } from "./config.js";

export type PairingMailPayload = {
  to: string;
  subject: string;
  text: string;
  magicLink: string;
};

/**
 * MVP mail delivery.
 * - `log`: write to a local file (NOT production; for dry-run bring-up).
 * - `smtp`: placeholder using raw TCP-less env; currently falls back to log with a warning
 *   until SMTP credentials are configured (see docs/secure-web-e2ee.md).
 */
export async function sendPairingEmail(payload: PairingMailPayload): Promise<"log" | "smtp"> {
  const mode = config.pairingMailMode;
  if (mode === "smtp" && config.smtpUrl) {
    // Intentionally not implementing a full SMTP client in MVP without pulling deps.
    // Operators should configure an external mailer or replace this module.
    console.warn(
      "[pairing-mail] SMTP mode selected but built-in SMTP client is a stub; falling back to log. " +
        "Wire your mailer or use PAIRING_MAIL_MODE=log for dry-run."
    );
  }

  const directory = join(homedir(), ".cursor-gateway");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = config.pairingMailLogFile || join(directory, "pairing-mail.log");
  const entry = [
    `---- ${new Date().toISOString()} ----`,
    `to: ${payload.to}`,
    `subject: ${payload.subject}`,
    `magicLink: ${payload.magicLink}`,
    "",
    payload.text,
    ""
  ].join("\n");
  appendFileSync(path, entry, { mode: 0o600 });
  console.log(`[pairing-mail] Wrote magic link to ${path} (NOT production delivery)`);
  return "log";
}

export function pairingMailLogPath() {
  return (
    config.pairingMailLogFile ||
    join(homedir(), ".cursor-gateway", "pairing-mail.log")
  );
}

// Keep dirname import used for future SMTP attachment paths.
void dirname;
