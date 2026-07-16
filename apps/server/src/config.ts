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
  CSAPI_ALLOW_WRITES: booleanEnv(false)
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
  e2eeRequiredForWeb: parsed.E2EE_REQUIRED_FOR_WEB,
  e2eeExtensionOrigins: new Set(splitCsv(parsed.E2EE_EXTENSION_ORIGINS)),
  secureClientOrigin: parsed.SECURE_CLIENT_ORIGIN.trim(),
  webE2eeReturnOrigins: new Set(splitCsv(parsed.WEB_E2EE_RETURN_ORIGINS)),
  e2eePairingTtlSeconds: parsed.E2EE_PAIRING_TTL_SECONDS,
  e2eeCsAuthTtlSeconds: parsed.E2EE_CS_AUTH_TTL_SECONDS,
  e2eeTrustRootsJson: parsed.E2EE_TRUST_ROOTS_JSON.trim(),
  e2eeTrustRootsFile: parsed.E2EE_TRUST_ROOTS_FILE.trim(),
  e2eePasskeyPairingTtlSeconds: parsed.E2EE_PASSKEY_PAIRING_TTL_SECONDS,
  e2eeDeviceApprovalTtlSeconds: parsed.E2EE_DEVICE_APPROVAL_TTL_SECONDS,
  e2eeRecoveryPairingTtlSeconds: parsed.E2EE_RECOVERY_PAIRING_TTL_SECONDS,
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
  }
};

export const isProduction = config.nodeEnv === "production";
