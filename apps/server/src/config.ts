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
  E2EE_PAIRING_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  WEB_DEFAULT_MODEL: z.string().default("auto"),
  REPORT_MODEL_ID: z.string().default(""),
  REPORT_WORKSPACE_ID: z.string().default("")
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
  e2eePairingTtlSeconds: parsed.E2EE_PAIRING_TTL_SECONDS,
  webDefaultModel: parsed.WEB_DEFAULT_MODEL,
  reportModelId: parsed.REPORT_MODEL_ID,
  reportWorkspaceId: parsed.REPORT_WORKSPACE_ID
};

export const isProduction = config.nodeEnv === "production";
