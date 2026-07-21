import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnvFile(path: string) {
  if (!existsSync(path)) return;

  const content = readFileSync(path, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const separator = line.indexOf("=");
    if (separator === -1) continue;

    const key = line.slice(0, separator).trim();
    const value = line
      .slice(separator + 1)
      .trim()
      .replace(/^['"]|['"]$/g, "");

    process.env[key] ??= value;
  }
}

for (const candidate of [
  resolve(process.cwd(), ".env"),
  resolve(process.cwd(), ".env.windows"),
  resolve(process.cwd(), "apps/windows-runner/.env"),
  resolve(process.cwd(), "apps/windows-runner/.env.windows"),
  join(__dirname, "../.env"),
  join(__dirname, "../.env.windows")
]) {
  loadEnvFile(candidate);
}

const optionalEnvString = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).optional()
);

const booleanEnv = (defaultValue: boolean) =>
  z.preprocess((value) => {
    if (value === undefined || value === "") return defaultValue;
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
      if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
    }
    return value;
  }, z.boolean());

const envSchema = z.object({
  GATEWAY_URL: z.string().url(),
  RUNNER_ID: z.string().min(1).default("local-runner"),
  RUNNER_SHARED_SECRET: z.string().min(32),
  RUNNER_WORKSPACES: z.string().min(1),
  RUNNER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2000),
  RUNNER_MAX_CONCURRENT_JOBS: z.coerce.number().int().positive().default(6),
  RUNNER_JOB_TIMEOUT_MS: z.coerce.number().int().positive().default(1_800_000),
  RUNNER_CANCEL_GRACE_MS: z.coerce.number().int().positive().default(10_000),
  RUNNER_VERSION: z.string().min(1).default("0.1.0"),
  RUNNER_E2EE_ENABLED: booleanEnv(true),
  RUNNER_LEGACY_ENABLED: booleanEnv(false),
  RUNNER_E2EE_STATE_FILE: optionalEnvString,
  RUNNER_E2EE_ALLOW_INSECURE_DEV_STORAGE: booleanEnv(false),
  // Non-Windows at-rest protection: when set, the runner E2EE state file is
  // sealed with AES-256-GCM using a scrypt-derived key from this master secret
  // (or the contents of RUNNER_E2EE_MASTER_KEY_FILE). This replaces the
  // insecure plaintext dev mode on Linux/WSL. The master secret must be
  // supplied at runtime and kept off the gateway.
  RUNNER_E2EE_MASTER_KEY: optionalEnvString,
  RUNNER_E2EE_MASTER_KEY_FILE: optionalEnvString,
  CURSOR_API_KEY: z.string().min(1),
  DEFAULT_MODEL: z.string().min(1).default("auto"),
  CF_ACCESS_CLIENT_ID: optionalEnvString,
  CF_ACCESS_CLIENT_SECRET: optionalEnvString,
  // Secure-web magic-link pairing
  SECURE_CLIENT_ORIGIN: optionalEnvString,
  PAIRING_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  PAIRING_MAIL_MODE: z.enum(["log", "smtp", "api"]).default("log"),
  // PAIRING_MAIL_TO is ONLY for scripts/e2ee/send-test-pairing-mail.* — never for live pairing.
  PAIRING_MAIL_TO: optionalEnvString,
  PAIRING_MAIL_LOG_FILE: optionalEnvString,
  PAIRING_MAIL_FROM: z.string().min(3).default("no-reply@piallera.com"),
  PAIRING_MAIL_FROM_NAME: z.string().min(1).default("Piallera Secure"),
  PAIRING_MAIL_ALSO_LOG: booleanEnv(false),
  PAIRING_ALLOWED_EMAILS: z.string().default(""),
  // SMTP (generic). Prefer discrete keys; SMTP_URL is also accepted.
  SMTP_URL: optionalEnvString,
  SMTP_HOST: optionalEnvString,
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: optionalEnvString,
  SMTP_PASS: optionalEnvString,
  SMTP_SECURE: booleanEnv(false),
  SMTP_REQUIRE_TLS: booleanEnv(true),
  // HTTP API providers (PAIRING_MAIL_MODE=api)
  MAIL_API_PROVIDER: z.enum(["resend", "mailgun", "sendgrid"]).default("resend"),
  MAIL_API_KEY: optionalEnvString,
  MAILGUN_BASE_URL: optionalEnvString,
  CF_ACCESS_TEAM_DOMAIN: optionalEnvString,
  CF_ACCESS_AUD: optionalEnvString,
  // CS → Secure → CS one-time device auth grants (see docs/cs-secure-redirect-e2ee.md)
  WEB_E2EE_RETURN_ORIGINS: z.string().default(""),
  E2EE_CS_AUTH_GRANT_TTL_SECONDS: z.coerce.number().int().positive().default(120),
  // Offline trust root / Runner identity certificate (see docs/trust-root-rotation.md)
  RUNNER_IDENTITY_CERT_FILE: optionalEnvString,
  E2EE_TRUST_ROOTS_FILE: optionalEnvString,
  // Passkey pairing (WebAuthn)
  RUNNER_WEBAUTHN_ENABLED: booleanEnv(false),
  WEBAUTHN_RP_ID: z.string().min(1).default("secure.joelzt.org"),
  WEBAUTHN_RP_NAME: z.string().min(1).default("Secure Gateway"),
  WEBAUTHN_ORIGINS: z.string().default(""),
  WEBAUTHN_CHALLENGE_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  // Paired-device approval
  DEVICE_APPROVAL_TTL_SECONDS: z.coerce.number().int().positive().default(600),
  // Recovery pairing (local high-entropy code, never sent to Gateway)
  RECOVERY_TTL_SECONDS: z.coerce.number().int().positive().default(1_800),
  // Runner-assisted manual code (RAMC) — primary no-QR/no-email flow. The code
  // is generated live on the Runner and shown on its terminal/TTY only.
  RUNNER_CODE_ENABLED: booleanEnv(false),
  RUNNER_CODE_APPROVAL: z.enum(["auto", "manual"]).default("manual"),
  RUNNER_CODE_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  // When stdout is captured by journald, mirror the code to this 0600 file
  // (shown once then deleted) instead of the persistent structured log.
  RUNNER_CODE_TTY: optionalEnvString,
  // CS relay client (cs-relay) signing public JWK JSON for runner verification
  RUNNER_CS_RELAY_SIGNING_PUBLIC_JWK: optionalEnvString
});

const parsed = envSchema.parse(process.env);
const gatewayUrl = new URL(parsed.GATEWAY_URL);
const localGateway =
  gatewayUrl.hostname === "localhost" ||
  gatewayUrl.hostname === "127.0.0.1" ||
  gatewayUrl.hostname === "[::1]";
if (gatewayUrl.protocol !== "https:" && !(localGateway && gatewayUrl.protocol === "http:")) {
  throw new Error("GATEWAY_URL must use HTTPS (HTTP is allowed only for localhost)");
}

if (Boolean(parsed.CF_ACCESS_CLIENT_ID) !== Boolean(parsed.CF_ACCESS_CLIENT_SECRET)) {
  throw new Error("CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET must be configured together");
}

if (!parsed.RUNNER_E2EE_ENABLED && !parsed.RUNNER_LEGACY_ENABLED) {
  throw new Error("At least one of RUNNER_E2EE_ENABLED or RUNNER_LEGACY_ENABLED must be enabled");
}
if (parsed.RUNNER_WEBAUTHN_ENABLED && (!parsed.CF_ACCESS_TEAM_DOMAIN || !parsed.CF_ACCESS_AUD)) {
  throw new Error(
    "RUNNER_WEBAUTHN_ENABLED=true requires CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD " +
      "(passkey pairing must verify the Secure Web user's Access identity)"
  );
}

function resolveE2eeMasterKey(): string | undefined {
  const inline = parsed.RUNNER_E2EE_MASTER_KEY;
  if (inline !== undefined) {
    if (inline.length < 16) {
      throw new Error("RUNNER_E2EE_MASTER_KEY must be at least 16 characters");
    }
    return inline;
  }
  const filePath = parsed.RUNNER_E2EE_MASTER_KEY_FILE;
  if (!filePath) return undefined;
  const fromFile = readFileSync(filePath, "utf8").trim();
  if (fromFile.length < 16) {
    throw new Error("RUNNER_E2EE_MASTER_KEY must be at least 16 characters");
  }
  return fromFile;
}
const e2eeMasterKey = resolveE2eeMasterKey();

export const config = {
  gatewayUrl: gatewayUrl.origin,
  runnerId: parsed.RUNNER_ID,
  sharedSecret: parsed.RUNNER_SHARED_SECRET,
  workspaces: parsed.RUNNER_WORKSPACES.split(";")
    .map((path) => path.trim())
    .filter(Boolean),
  pollIntervalMs: parsed.RUNNER_POLL_INTERVAL_MS,
  maxConcurrentJobs: parsed.RUNNER_MAX_CONCURRENT_JOBS,
  jobTimeoutMs: parsed.RUNNER_JOB_TIMEOUT_MS,
  cancelGraceMs: parsed.RUNNER_CANCEL_GRACE_MS,
  runnerVersion: parsed.RUNNER_VERSION,
  e2eeEnabled: parsed.RUNNER_E2EE_ENABLED,
  legacyEnabled: parsed.RUNNER_LEGACY_ENABLED,
  e2eeStateFile:
    parsed.RUNNER_E2EE_STATE_FILE ??
    join(homedir(), ".cursor-gateway", "runner-e2ee-state.dat"),
  e2eeAllowInsecureDevStorage: parsed.RUNNER_E2EE_ALLOW_INSECURE_DEV_STORAGE,
  e2eeMasterKey,
  cursorApiKey: parsed.CURSOR_API_KEY,
  defaultModel: parsed.DEFAULT_MODEL,
  cloudflareAccessClientId: parsed.CF_ACCESS_CLIENT_ID,
  cloudflareAccessClientSecret: parsed.CF_ACCESS_CLIENT_SECRET,
  // Comma-separated allowlist. First entry stays canonical; every entry is
  // accepted for the secureOrigin embedded in pairing/approval envelopes so the
  // Tauri desktop shell (http://tauri.localhost / tauri://localhost) works
  // alongside the hosted PWA.
  secureClientOrigin: (parsed.SECURE_CLIENT_ORIGIN ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)[0] ?? "",
  secureClientOrigins: new Set(
    (parsed.SECURE_CLIENT_ORIGIN ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  ),
  pairingTtlSeconds: parsed.PAIRING_TTL_SECONDS,
  pairingMailMode: parsed.PAIRING_MAIL_MODE,
  pairingMailTo: parsed.PAIRING_MAIL_TO,
  pairingMailLogFile: parsed.PAIRING_MAIL_LOG_FILE,
  pairingMailFrom: parsed.PAIRING_MAIL_FROM,
  pairingMailFromName: parsed.PAIRING_MAIL_FROM_NAME,
  pairingMailAlsoLog: parsed.PAIRING_MAIL_ALSO_LOG,
  pairingAllowedEmails: new Set(
    parsed.PAIRING_ALLOWED_EMAILS.split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean)
  ),
  smtpUrl: parsed.SMTP_URL,
  smtpHost: parsed.SMTP_HOST,
  smtpPort: parsed.SMTP_PORT,
  smtpUser: parsed.SMTP_USER,
  smtpPass: parsed.SMTP_PASS,
  smtpSecure: parsed.SMTP_SECURE || parsed.SMTP_PORT === 465,
  smtpRequireTls: parsed.SMTP_REQUIRE_TLS,
  mailApiProvider: parsed.MAIL_API_PROVIDER,
  mailApiKey: parsed.MAIL_API_KEY,
  mailgunBaseUrl: parsed.MAILGUN_BASE_URL,
  cfAccessTeamDomain: parsed.CF_ACCESS_TEAM_DOMAIN,
  cfAccessAud: parsed.CF_ACCESS_AUD,
  webE2eeReturnOrigins: parsed.WEB_E2EE_RETURN_ORIGINS.split(",")
    .map((item) => item.trim())
    .filter(Boolean),
  csAuthGrantTtlSeconds: parsed.E2EE_CS_AUTH_GRANT_TTL_SECONDS,
  runnerIdentityCertFile:
    parsed.RUNNER_IDENTITY_CERT_FILE ??
    join(homedir(), ".cursor-gateway", "runner-identity-cert.json"),
  e2eeTrustRootsFile:
    parsed.E2EE_TRUST_ROOTS_FILE ??
    join(homedir(), ".cursor-gateway", "trust-root-public.json"),
  webauthnEnabled: parsed.RUNNER_WEBAUTHN_ENABLED,
  webauthnRpId: parsed.WEBAUTHN_RP_ID,
  webauthnRpName: parsed.WEBAUTHN_RP_NAME,
  webauthnOrigins: parsed.WEBAUTHN_ORIGINS.split(",")
    .map((item) => item.trim())
    .filter(Boolean),
  webauthnChallengeTtlSeconds: parsed.WEBAUTHN_CHALLENGE_TTL_SECONDS,
  deviceApprovalTtlSeconds: parsed.DEVICE_APPROVAL_TTL_SECONDS,
  recoveryTtlSeconds: parsed.RECOVERY_TTL_SECONDS,
  csRelaySigningPublicJwk: parsed.RUNNER_CS_RELAY_SIGNING_PUBLIC_JWK,
  runnerCodeEnabled: parsed.RUNNER_CODE_ENABLED,
  runnerCodeApproval: parsed.RUNNER_CODE_APPROVAL,
  runnerCodeTtlSeconds: parsed.RUNNER_CODE_TTL_SECONDS,
  runnerCodeTty: parsed.RUNNER_CODE_TTY
};

/**
 * True when `origin` is an allowlisted Secure Web origin (or when no allowlist
 * is configured). Mirrors the Gateway's check so pairing/approval envelopes
 * from the desktop shell are not rejected as `secure_origin_mismatch`.
 */
export function isAllowedSecureOrigin(origin: string | undefined | null): boolean {
  if (config.secureClientOrigins.size === 0) return true;
  return !!origin && config.secureClientOrigins.has(origin);
}
