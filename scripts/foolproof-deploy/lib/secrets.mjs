import { createHash, randomBytes, randomUUID } from "node:crypto";

/** @param {number} bytes */
export function randomSecret(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

/** @param {number} bytes */
export function randomHex(bytes = 32) {
  return randomBytes(bytes).toString("hex");
}

/** Short opaque fingerprint — never the secret itself. */
export function fingerprint(value) {
  if (!value || typeof value !== "string") return null;
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12);
}

/** Reality-style shortId: 8 hex chars. */
export function realityShortId() {
  return randomBytes(4).toString("hex");
}

/**
 * Generate all gateway + pairing materials for a fresh install.
 * Private material stays in returned objects; callers must not log full values.
 */
export function generateDeploySecrets(opts = {}) {
  const postgresPassword = randomSecret(24);
  const jwtSecret = randomSecret(32);
  let runnerSharedSecret = randomSecret(32);
  while (runnerSharedSecret === jwtSecret) {
    runnerSharedSecret = randomSecret(32);
  }
  const telegramWebhookSecret = randomSecret(24);
  const automationSharedSecret = randomSecret(32);
  const e2eeMasterKey = randomBytes(32).toString("base64");

  const reality = opts.includeReality
    ? {
        uuid: randomUUID(),
        shortId: realityShortId()
      }
    : null;

  return {
    jwtSecret,
    runnerSharedSecret,
    postgresPassword,
    telegramWebhookSecret,
    automationSharedSecret,
    e2eeMasterKey,
    reality,
    fingerprints: {
      jwtSecret: fingerprint(jwtSecret),
      runnerSharedSecret: fingerprint(runnerSharedSecret),
      postgresPassword: fingerprint(postgresPassword),
      telegramWebhookSecret: fingerprint(telegramWebhookSecret),
      automationSharedSecret: fingerprint(automationSharedSecret),
      e2eeMasterKey: fingerprint(e2eeMasterKey),
      realityUuid: reality ? fingerprint(reality.uuid) : null,
      realityShortId: reality ? fingerprint(reality.shortId) : null
    }
  };
}
