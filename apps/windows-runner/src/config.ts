import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
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

const envSchema = z.object({
  GATEWAY_URL: z.string().url(),
  RUNNER_ID: z.string().min(1).default("windows-main"),
  RUNNER_SHARED_SECRET: z.string().min(32),
  RUNNER_WORKSPACES: z.string().min(1),
  RUNNER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2000),
  RUNNER_MAX_CONCURRENT_JOBS: z.coerce.number().int().positive().default(3),
  CURSOR_API_KEY: z.string().min(1),
  DEFAULT_MODEL: z.string().min(1).default("auto"),
  CF_ACCESS_CLIENT_ID: optionalEnvString,
  CF_ACCESS_CLIENT_SECRET: optionalEnvString
});

const parsed = envSchema.parse(process.env);

if (Boolean(parsed.CF_ACCESS_CLIENT_ID) !== Boolean(parsed.CF_ACCESS_CLIENT_SECRET)) {
  throw new Error("CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET must be configured together");
}

export const config = {
  gatewayUrl: parsed.GATEWAY_URL.replace(/\/$/, ""),
  runnerId: parsed.RUNNER_ID,
  sharedSecret: parsed.RUNNER_SHARED_SECRET,
  workspaces: parsed.RUNNER_WORKSPACES.split(";")
    .map((path) => path.trim())
    .filter(Boolean),
  pollIntervalMs: parsed.RUNNER_POLL_INTERVAL_MS,
  maxConcurrentJobs: parsed.RUNNER_MAX_CONCURRENT_JOBS,
  cursorApiKey: parsed.CURSOR_API_KEY,
  defaultModel: parsed.DEFAULT_MODEL,
  cloudflareAccessClientId: parsed.CF_ACCESS_CLIENT_ID,
  cloudflareAccessClientSecret: parsed.CF_ACCESS_CLIENT_SECRET
};
