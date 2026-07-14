import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fingerprint } from "./secrets.mjs";

/**
 * Parse a dotenv-style file into a flat object (last key wins).
 * Does not expand variables.
 * @param {string} text
 */
export function parseEnv(text) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * @param {Record<string, string | undefined | null>} values
 * @param {string} [header]
 */
export function serializeEnv(values, header = "") {
  const lines = [];
  if (header) {
    for (const h of header.split("\n")) lines.push(h.startsWith("#") ? h : `# ${h}`);
    lines.push("");
  }
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null) continue;
    lines.push(`${key}=${String(value)}`);
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Atomically write a file with mode 0600.
 * @param {string} path
 * @param {string} contents
 */
export function writeSecretFile(path, contents) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, contents, { encoding: "utf8", mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

/**
 * @param {string} path
 * @returns {Record<string, string> | null}
 */
export function readEnvFile(path) {
  if (!existsSync(path)) return null;
  return parseEnv(readFileSync(path, "utf8"));
}

/**
 * Build gateway `.env` from example + generated secrets + user overrides.
 * Preserves unknown keys already present when merging into existing.
 *
 * @param {{
 *   examplePath: string,
 *   existingPath: string,
 *   secrets: ReturnType<typeof import("./secrets.mjs").generateDeploySecrets>,
 *   publicOrigin: string,
 *   allowedEmails: string,
 *   e2eeRequiredForWeb?: boolean,
 *   e2eeExtensionOrigins?: string,
 *   force?: boolean,
 *   preserveExistingSecrets?: boolean
 * }} opts
 */
export function buildGatewayEnv(opts) {
  const example = existsSync(opts.examplePath)
    ? parseEnv(readFileSync(opts.examplePath, "utf8"))
    : {};
  const existing = readEnvFile(opts.existingPath) ?? {};
  const secrets = opts.secrets;

  const lookLikePlaceholder = (value) =>
    !value ||
    /replace-with|change-me|example\.com|your-|\.\.\./i.test(value) ||
    value.length < 16;

  const pickSecret = (key, generated) => {
    if (opts.force) return generated;
    if (opts.preserveExistingSecrets !== false && existing[key] && !lookLikePlaceholder(existing[key])) {
      return existing[key];
    }
    return generated;
  };

  const postgresPassword = pickSecret("POSTGRES_PASSWORD", secrets.postgresPassword);
  const jwtSecret = pickSecret("JWT_SECRET", secrets.jwtSecret);
  const runnerSharedSecret = pickSecret("RUNNER_SHARED_SECRET", secrets.runnerSharedSecret);
  const telegramWebhookSecret = pickSecret(
    "TELEGRAM_WEBHOOK_SECRET",
    secrets.telegramWebhookSecret
  );
  const automationSharedSecret = pickSecret(
    "AUTOMATION_SHARED_SECRET",
    secrets.automationSharedSecret
  );

  /** @type {Record<string, string>} */
  const merged = {
    ...example,
    ...existing,
    PUBLIC_ORIGIN: opts.publicOrigin || existing.PUBLIC_ORIGIN || example.PUBLIC_ORIGIN || "",
    NODE_ENV: existing.NODE_ENV || "production",
    SERVER_HOST: existing.SERVER_HOST || "0.0.0.0",
    SERVER_PORT: existing.SERVER_PORT || "8080",
    JWT_SECRET: jwtSecret,
    POSTGRES_USER: existing.POSTGRES_USER || example.POSTGRES_USER || "cursor_gateway",
    POSTGRES_PASSWORD: postgresPassword,
    POSTGRES_DB: existing.POSTGRES_DB || example.POSTGRES_DB || "cursor_gateway",
    DATABASE_URL: `postgres://${existing.POSTGRES_USER || "cursor_gateway"}:${postgresPassword}@postgres:5432/${existing.POSTGRES_DB || "cursor_gateway"}`,
    REDIS_URL: existing.REDIS_URL || "redis://redis:6379",
    ALLOWED_EMAILS: opts.allowedEmails ?? existing.ALLOWED_EMAILS ?? "",
    RUNNER_SHARED_SECRET: runnerSharedSecret,
    AUTOMATION_SHARED_SECRET: automationSharedSecret,
    TELEGRAM_WEBHOOK_SECRET: telegramWebhookSecret,
    E2EE_REQUIRED_FOR_WEB:
      opts.e2eeRequiredForWeb === undefined
        ? existing.E2EE_REQUIRED_FOR_WEB || "false"
        : opts.e2eeRequiredForWeb
          ? "true"
          : "false",
    E2EE_EXTENSION_ORIGINS:
      opts.e2eeExtensionOrigins ?? existing.E2EE_EXTENSION_ORIGINS ?? "",
    RUNNER_MAX_CONCURRENT_JOBS: existing.RUNNER_MAX_CONCURRENT_JOBS || "3",
    RUNNER_REQUIRE_APPROVAL: existing.RUNNER_REQUIRE_APPROVAL || "false",
    WEB_DEFAULT_MODEL: existing.WEB_DEFAULT_MODEL || "auto"
  };

  return {
    values: merged,
    fingerprints: {
      jwtSecret: fingerprint(jwtSecret),
      runnerSharedSecret: fingerprint(runnerSharedSecret),
      postgresPassword: fingerprint(postgresPassword),
      telegramWebhookSecret: fingerprint(telegramWebhookSecret),
      automationSharedSecret: fingerprint(automationSharedSecret),
      e2eeMasterKey: fingerprint(secrets.e2eeMasterKey),
      realityUuid: secrets.reality ? fingerprint(secrets.reality.uuid) : null,
      realityShortId: secrets.reality ? fingerprint(secrets.reality.shortId) : null
    },
    // Full secret material for one-time pack only — never serialize into HTML JSON responses.
    packMaterial: {
      jwtSecret,
      runnerSharedSecret,
      postgresPassword,
      telegramWebhookSecret,
      automationSharedSecret,
      e2eeMasterKey: secrets.e2eeMasterKey,
      reality: secrets.reality
    }
  };
}

/**
 * Runner .env snippet for the one-time download pack.
 * @param {{
 *   gatewayUrl: string,
 *   runnerSharedSecret: string,
 *   runnerId?: string,
 *   workspaces?: string,
 *   e2eeMasterKeyFile?: string,
 *   allowInsecureDevStorage?: boolean
 * }} opts
 */
export function buildRunnerEnvSnippet(opts) {
  /** @type {Record<string, string>} */
  const values = {
    GATEWAY_URL: opts.gatewayUrl,
    RUNNER_SHARED_SECRET: opts.runnerSharedSecret,
    RUNNER_ID: opts.runnerId || "main-runner",
    RUNNER_WORKSPACES: opts.workspaces || "/home/you/projects",
    CURSOR_API_KEY: "",
    DEFAULT_MODEL: "auto",
    RUNNER_POLL_INTERVAL_MS: "2000",
    RUNNER_MAX_CONCURRENT_JOBS: "3",
    RUNNER_E2EE_ENABLED: "true",
    RUNNER_LEGACY_ENABLED: "false",
    RUNNER_E2EE_ALLOW_INSECURE_DEV_STORAGE: opts.allowInsecureDevStorage ? "true" : "false"
  };
  if (opts.e2eeMasterKeyFile) {
    values.RUNNER_E2EE_MASTER_KEY_FILE = opts.e2eeMasterKeyFile;
  }
  return serializeEnv(
    values,
    "Generated by foolproof-deploy — fill CURSOR_API_KEY and RUNNER_WORKSPACES, then delete this copy from downloads."
  );
}
