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
  RUNNER_ID: z.string().min(1).default("windows-main"),
  RUNNER_SHARED_SECRET: z.string().min(32),
  RUNNER_WORKSPACES: z.string().min(1),
  RUNNER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2000),
  RUNNER_MAX_CONCURRENT_JOBS: z.coerce.number().int().positive().default(3),
  RUNNER_VERSION: z.string().min(1).default("0.1.0"),
  RUNNER_E2EE_ENABLED: booleanEnv(true),
  RUNNER_LEGACY_ENABLED: booleanEnv(false),
  RUNNER_E2EE_STATE_FILE: optionalEnvString,
  RUNNER_E2EE_ALLOW_INSECURE_DEV_STORAGE: booleanEnv(false),
  CURSOR_API_KEY: z.string().min(1),
  DEFAULT_MODEL: z.string().min(1).default("auto"),
  CF_ACCESS_CLIENT_ID: optionalEnvString,
  CF_ACCESS_CLIENT_SECRET: optionalEnvString
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

export const config = {
  gatewayUrl: gatewayUrl.origin,
  runnerId: parsed.RUNNER_ID,
  sharedSecret: parsed.RUNNER_SHARED_SECRET,
  workspaces: parsed.RUNNER_WORKSPACES.split(";")
    .map((path) => path.trim())
    .filter(Boolean),
  pollIntervalMs: parsed.RUNNER_POLL_INTERVAL_MS,
  maxConcurrentJobs: parsed.RUNNER_MAX_CONCURRENT_JOBS,
  runnerVersion: parsed.RUNNER_VERSION,
  e2eeEnabled: parsed.RUNNER_E2EE_ENABLED,
  legacyEnabled: parsed.RUNNER_LEGACY_ENABLED,
  e2eeStateFile:
    parsed.RUNNER_E2EE_STATE_FILE ??
    join(homedir(), ".cursor-gateway", "runner-e2ee-state.dat"),
  e2eeAllowInsecureDevStorage: parsed.RUNNER_E2EE_ALLOW_INSECURE_DEV_STORAGE,
  cursorApiKey: parsed.CURSOR_API_KEY,
  defaultModel: parsed.DEFAULT_MODEL,
  cloudflareAccessClientId: parsed.CF_ACCESS_CLIENT_ID,
  cloudflareAccessClientSecret: parsed.CF_ACCESS_CLIENT_SECRET
};
