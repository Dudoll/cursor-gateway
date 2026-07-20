import { z } from "zod";

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
  NODE_ENV: z.string().default("development"),
  PUBLIC_ORIGIN: z.string().url().default("https://gateway.example.com"),
  SERVER_HOST: z.string().default("0.0.0.0"),
  SERVER_PORT: z.coerce.number().int().positive().default(8080),
  JWT_SECRET: z.string().min(32),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().optional(),
  ALLOWED_EMAILS: z.string().default(""),
  ALLOWED_CLOUDFLARE_AUD: z.string().default(""),
  TELEGRAM_BOT_TOKEN: z.string().default(""),
  TELEGRAM_WEBHOOK_SECRET: z.string().default(""),
  TELEGRAM_ALLOWED_USER_IDS: z.string().default(""),
  RUNNER_SHARED_SECRET: z.string().min(32),
  AUTOMATION_SHARED_SECRET: z.string().default(""),
  HERMES_RUNNER_SHARED_SECRET: z.string().default(""),
  RUNNER_REQUIRE_APPROVAL: booleanEnv(false),
  RUNNER_MAX_CONCURRENT_JOBS: z.coerce.number().int().positive().default(3),
  RUNNER_STALE_AFTER_SECONDS: z.coerce.number().int().positive().default(900),
  RUNNER_MAX_ATTEMPTS: z.coerce.number().int().positive().max(10).default(3),
  E2EE_REQUIRED_FOR_WEB: booleanEnv(false),
  E2EE_EXTENSION_ORIGINS: z.string().default(""),
  SECURE_CLIENT_ORIGIN: z.string().default(""),
  WEB_E2EE_RETURN_ORIGINS: z.string().default(""),
  E2EE_PAIRING_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  E2EE_CS_AUTH_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  // Offline trust roots for verifying Runner identity certificates (passkey /
  // device-approval / recovery acks and cs-auth grants). Provide either an
  // inline JSON array or a file path; JSON takes precedence when both are set.
  E2EE_TRUST_ROOTS_JSON: z.string().default(""),
  E2EE_TRUST_ROOTS_FILE: z.string().default(""),
  E2EE_PASSKEY_PAIRING_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  E2EE_DEVICE_APPROVAL_TTL_SECONDS: z.coerce.number().int().positive().default(600),
  E2EE_RECOVERY_PAIRING_TTL_SECONDS: z.coerce.number().int().positive().default(1_800),
  // Runner-assisted manual code (RAMC) — primary no-QR/no-email flow. Default
  // off for gray rollout; turn on per-environment. TTL 5m, 3 attempts.
  RUNNER_CODE_PAIRING_ENABLED: booleanEnv(false),
  E2EE_RUNNER_CODE_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  E2EE_RUNNER_CODE_MAX_ATTEMPTS: z.coerce.number().int().positive().max(10).default(3),
  // Optional Cloudflare Access team domain for client logout links, e.g.
  // https://yourteam.cloudflareaccess.com → …/cdn-cgi/access/logout
  CF_ACCESS_TEAM_DOMAIN: z.string().default(""),
  WEB_DEFAULT_MODEL: z.string().default("auto"),
  REPORT_MODEL_ID: z.string().default(""),
  REPORT_WORKSPACE_ID: z.string().default(""),
  // --- csapi (compatibility API facade, 方案 B). Plaintext-visible: NOT E2EE. ---
  // Mount the Anthropic/OpenAI compatible facade under /v1/*. Auth is a
  // csapi-specific API key, fully separate from Cloudflare Access.
  CSAPI_ENABLED: booleanEnv(false),
  CSAPI_API_KEYS: z.string().default(""),
  CSAPI_DEFAULT_MODEL: z.string().default("auto"),
  CSAPI_DEFAULT_WORKSPACE_ID: z.string().default(""),
  CSAPI_MAX_CONCURRENCY_PER_KEY: z.coerce.number().int().positive().default(4),
  CSAPI_RUN_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
  CSAPI_ALLOW_WRITES: booleanEnv(false),
  // --- cg-mitm/1 secure csapi channel (application-layer anti-MITM). ---
  CG_SECURE_ENABLED: booleanEnv(false),
  CG_REQUIRE_SECURE: booleanEnv(false),
  CG_SERVER_CERT_FILE: z.string().default(""),
  CG_SERVER_PREVIOUS_CERT_FILE: z.string().default(""),
  CG_SERVER_HPKE_KEY_FILE: z.string().default(""),
  CG_SERVER_SIGNING_KEY_FILE: z.string().default(""),
  CG_TRUST_ROOTS_JSON: z.string().default(""),
  CG_TRUST_ROOTS_FILE: z.string().default(""),
  CG_MASTER_KEY: z.string().default(""),
  CG_MASTER_KEY_FILE: z.string().default(""),
  CG_PAD_BUCKETS: z.string().default("512,2048,8192,32768,131072"),
  // trusted-CS relay (multi-device history). Default off for gray rollout.
  CS_RELAY_HISTORY_ENABLED: booleanEnv(false),
  CS_RELAY_ACCOUNT_BINDING: booleanEnv(true),
  CS_RELAY_KMS_KEY_ID: z.string().default("file-master-1"),
  CS_RELAY_SEND_JITTER_MS: z.coerce.number().int().nonnegative().default(0),
  CS_RELAY_RUNNER_REENCRYPT: booleanEnv(false),
  CS_RELAY_MAX_HISTORY_TURNS: z.coerce.number().int().positive().default(20),
  CS_RELAY_MAX_HISTORY_BYTES: z.coerce.number().int().positive().default(48_000),
  /** Production: require DB persist for devices (fail-closed). Tests may set false. */
  CS_RELAY_ALLOW_MEMORY_DEVICES: booleanEnv(false),
  CS_RELAY_MASTER_KEY_FILE: z.string().default(""),
  CS_RELAY_CF_ACCESS_AUD: z.string().default(""),
  CS_RELAY_OIDC_JWKS_URL: z.string().default(""),
  CS_RELAY_OIDC_ISSUER: z.string().default(""),
  CS_RELAY_OIDC_AUDIENCE: z.string().default(""),
  CS_RELAY_WEBAUTHN_RP_ID: z.string().default(""),
  CS_RELAY_WEBAUTHN_ORIGINS: z.string().default(""),
  CS_RELAY_DECRYPTOR_ONLY: booleanEnv(false),
  CS_RELAY_HTTP_NO_KMS: booleanEnv(false)
});

const splitCsv = (value: string) =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

const parsed = envSchema.parse(process.env);

export const config = {
  nodeEnv: parsed.NODE_ENV,
  publicOrigin: parsed.PUBLIC_ORIGIN,
  host: parsed.SERVER_HOST,
  port: parsed.SERVER_PORT,
  jwtSecret: parsed.JWT_SECRET,
  databaseUrl: parsed.DATABASE_URL,
  redisUrl: parsed.REDIS_URL,
  allowedEmails: new Set(splitCsv(parsed.ALLOWED_EMAILS).map((email) => email.toLowerCase())),
  allowedCloudflareAud: new Set(splitCsv(parsed.ALLOWED_CLOUDFLARE_AUD)),
  telegramBotToken: parsed.TELEGRAM_BOT_TOKEN,
  telegramWebhookSecret: parsed.TELEGRAM_WEBHOOK_SECRET,
  telegramAllowedUserIds: new Set(splitCsv(parsed.TELEGRAM_ALLOWED_USER_IDS)),
  runnerSharedSecret: parsed.RUNNER_SHARED_SECRET,
  automationSharedSecret: parsed.AUTOMATION_SHARED_SECRET,
  hermesRunnerSharedSecret: parsed.HERMES_RUNNER_SHARED_SECRET,
  runnerRequireApproval: parsed.RUNNER_REQUIRE_APPROVAL,
  runnerMaxConcurrentJobs: parsed.RUNNER_MAX_CONCURRENT_JOBS,
  runnerStaleAfterSeconds: parsed.RUNNER_STALE_AFTER_SECONDS,
  runnerMaxAttempts: parsed.RUNNER_MAX_ATTEMPTS,
  e2eeRequiredForWeb: parsed.E2EE_REQUIRED_FOR_WEB,
  e2eeExtensionOrigins: new Set(splitCsv(parsed.E2EE_EXTENSION_ORIGINS)),
  // SECURE_CLIENT_ORIGIN accepts a comma-separated allowlist so the same
  // Secure Web bundle can run from more than one origin (e.g. the hosted PWA
  // at https://secure.joelzt.org AND the Tauri desktop shell, which serves the
  // bundled assets from http://tauri.localhost on Windows / tauri://localhost
  // on macOS+Linux). The first entry stays the canonical origin advertised to
  // clients; every entry is honoured for CORS and secureOrigin checks.
  secureClientOrigin: splitCsv(parsed.SECURE_CLIENT_ORIGIN)[0] ?? "",
  secureClientOrigins: new Set(splitCsv(parsed.SECURE_CLIENT_ORIGIN)),
  webE2eeReturnOrigins: new Set(splitCsv(parsed.WEB_E2EE_RETURN_ORIGINS)),
  e2eePairingTtlSeconds: parsed.E2EE_PAIRING_TTL_SECONDS,
  e2eeCsAuthTtlSeconds: parsed.E2EE_CS_AUTH_TTL_SECONDS,
  e2eeTrustRootsJson: parsed.E2EE_TRUST_ROOTS_JSON.trim(),
  e2eeTrustRootsFile: parsed.E2EE_TRUST_ROOTS_FILE.trim(),
  e2eePasskeyPairingTtlSeconds: parsed.E2EE_PASSKEY_PAIRING_TTL_SECONDS,
  e2eeDeviceApprovalTtlSeconds: parsed.E2EE_DEVICE_APPROVAL_TTL_SECONDS,
  e2eeRecoveryPairingTtlSeconds: parsed.E2EE_RECOVERY_PAIRING_TTL_SECONDS,
  runnerCodePairingEnabled: parsed.RUNNER_CODE_PAIRING_ENABLED,
  e2eeRunnerCodeTtlSeconds: parsed.E2EE_RUNNER_CODE_TTL_SECONDS,
  e2eeRunnerCodeMaxAttempts: parsed.E2EE_RUNNER_CODE_MAX_ATTEMPTS,
  cfAccessTeamDomain: parsed.CF_ACCESS_TEAM_DOMAIN.trim().replace(/\/$/, ""),
  webDefaultModel: parsed.WEB_DEFAULT_MODEL,
  reportModelId: parsed.REPORT_MODEL_ID,
  reportWorkspaceId: parsed.REPORT_WORKSPACE_ID,
  csapi: {
    enabled: parsed.CSAPI_ENABLED,
    apiKeys: new Set(splitCsv(parsed.CSAPI_API_KEYS)),
    defaultModel: parsed.CSAPI_DEFAULT_MODEL.trim() || "auto",
    defaultWorkspaceId: parsed.CSAPI_DEFAULT_WORKSPACE_ID.trim(),
    maxConcurrencyPerKey: parsed.CSAPI_MAX_CONCURRENCY_PER_KEY,
    runTimeoutMs: parsed.CSAPI_RUN_TIMEOUT_MS,
    allowWrites: parsed.CSAPI_ALLOW_WRITES
  },
  cg: {
    secureEnabled: parsed.CG_SECURE_ENABLED,
    requireSecure: parsed.CG_REQUIRE_SECURE,
    serverCertFile: parsed.CG_SERVER_CERT_FILE.trim(),
    previousServerCertFile: parsed.CG_SERVER_PREVIOUS_CERT_FILE.trim(),
    serverHpkeKeyFile: parsed.CG_SERVER_HPKE_KEY_FILE.trim(),
    serverSigningKeyFile: parsed.CG_SERVER_SIGNING_KEY_FILE.trim(),
    trustRootsJson: parsed.CG_TRUST_ROOTS_JSON.trim(),
    trustRootsFile: parsed.CG_TRUST_ROOTS_FILE.trim(),
    masterKey: parsed.CG_MASTER_KEY.trim(),
    masterKeyFile: parsed.CG_MASTER_KEY_FILE.trim(),
    padBuckets: parsed.CG_PAD_BUCKETS.trim()
  },
  csRelay: {
    historyEnabled: parsed.CS_RELAY_HISTORY_ENABLED,
    accountBinding: parsed.CS_RELAY_ACCOUNT_BINDING,
    kmsKeyId: parsed.CS_RELAY_KMS_KEY_ID.trim() || "file-master-1",
    sendJitterMs: parsed.CS_RELAY_SEND_JITTER_MS,
    runnerReencrypt: parsed.CS_RELAY_RUNNER_REENCRYPT,
    maxHistoryTurns: parsed.CS_RELAY_MAX_HISTORY_TURNS,
    maxHistoryBytes: parsed.CS_RELAY_MAX_HISTORY_BYTES,
    allowMemoryDevices: parsed.CS_RELAY_ALLOW_MEMORY_DEVICES,
    masterKeyFile: parsed.CS_RELAY_MASTER_KEY_FILE.trim(),
    cfAccessAudience: parsed.CS_RELAY_CF_ACCESS_AUD.trim(),
    oidcJwksUrl: parsed.CS_RELAY_OIDC_JWKS_URL.trim(),
    oidcIssuer: parsed.CS_RELAY_OIDC_ISSUER.trim(),
    oidcAudience: parsed.CS_RELAY_OIDC_AUDIENCE.trim(),
    webauthnRpId: parsed.CS_RELAY_WEBAUTHN_RP_ID.trim(),
    webauthnOrigins: new Set(splitCsv(parsed.CS_RELAY_WEBAUTHN_ORIGINS)),
    decryptorOnly: parsed.CS_RELAY_DECRYPTOR_ONLY,
    httpNoKms: parsed.CS_RELAY_HTTP_NO_KMS
  }
};

export const isProduction = config.nodeEnv === "production";

/**
 * True when `origin` is an allowlisted Secure Web origin. Used for both CORS
 * and for validating the `secureOrigin` field embedded in E2EE pairing /
 * approval envelopes. When no allowlist is configured, every origin passes so
 * local/dev deployments are not blocked.
 */
export function isAllowedSecureOrigin(origin: string | undefined | null): boolean {
  if (config.secureClientOrigins.size === 0) return true;
  return !!origin && config.secureClientOrigins.has(origin);
}
