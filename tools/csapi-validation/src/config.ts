import { parseArgs } from "node:util";
import {
  ConfigurationError,
  type AuthMaterial,
  type CommandName,
  type ObserverConfig,
  type ValidationConfig
} from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1_000;

const options = {
  "base-url": { type: "string" },
  endpoint: { type: "string" },
  workspace: { type: "string" },
  model: { type: "string" },
  "expected-provider": { type: "string" },
  "expected-model": { type: "string" },
  "api-key-env": { type: "string" },
  "auth-header": { type: "string" },
  "auth-scheme": { type: "string" },
  "observe-by-key-url": { type: "string" },
  "observe-by-run-url": { type: "string" },
  "observer-key-env": { type: "string" },
  "observer-auth-header": { type: "string" },
  "observer-auth-scheme": { type: "string" },
  "request-timeout-ms": { type: "string" },
  "final-timeout-ms": { type: "string" },
  "poll-interval-ms": { type: "string" },
  "json-out": { type: "string" },
  input: { type: "string" },
  "short-prompt-env": { type: "string" },
  "long-prompt-env": { type: "string" },
  "expected-long-duration-ms": { type: "string" },
  "max-activity-gap-ms": { type: "string" },
  "reattach-delay-ms": { type: "string" },
  duration: { type: "string" },
  interval: { type: "string" },
  help: { type: "boolean", short: "h" }
} as const;

type ParsedOptionValue =
  | string
  | boolean
  | (string | boolean)[]
  | undefined;

function value(
  values: Record<string, ParsedOptionValue>,
  name: string,
  env: NodeJS.ProcessEnv,
  envName: string,
  fallback = ""
): string {
  const fromArgs = values[name];
  if (typeof fromArgs === "string") return fromArgs.trim();
  if (Array.isArray(fromArgs)) {
    throw new ConfigurationError("DUPLICATE_ARGUMENT", `${name} may be supplied only once`);
  }
  return (env[envName] ?? fallback).trim();
}

function positiveInt(raw: string, name: string): number {
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ConfigurationError("INVALID_NUMBER", `${name} must be a positive integer`);
  }
  return parsed;
}

export function parseDuration(raw: string, name: string): number {
  const match = /^(\d+)(ms|s|m|h)?$/u.exec(raw.trim());
  if (!match) {
    throw new ConfigurationError("INVALID_DURATION", `${name} must look like 500ms, 30s, 5m, or 24h`);
  }
  const amount = positiveInt(match[1] ?? "", name);
  const multiplier = {
    ms: 1,
    s: 1_000,
    m: 60_000,
    h: 3_600_000
  }[match[2] as "ms" | "s" | "m" | "h" | undefined ?? "ms"];
  return amount * multiplier;
}

function safeUrl(raw: string, base: URL | undefined, name: string): URL {
  let parsed: URL;
  try {
    parsed = base ? new URL(raw, base) : new URL(raw);
  } catch {
    throw new ConfigurationError("INVALID_URL", `${name} is not a valid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ConfigurationError("INVALID_URL", `${name} must use http or https`);
  }
  if (parsed.username || parsed.password) {
    throw new ConfigurationError("URL_CREDENTIALS_FORBIDDEN", `${name} must not contain credentials`);
  }
  return parsed;
}

function templateUrl(raw: string, base: URL, placeholder: "idempotencyKey" | "runId"): string {
  const marker = placeholder === "idempotencyKey" ? "__CSAPI_KEY__" : "__CSAPI_RUN__";
  const candidate = raw.replaceAll(`{${placeholder}}`, marker);
  const parsed = safeUrl(candidate, base, `observer ${placeholder} URL`);
  return parsed.toString().replaceAll(marker, `{${placeholder}}`);
}

function authMaterial(
  env: NodeJS.ProcessEnv,
  envName: string,
  header: string,
  scheme: string
): AuthMaterial {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(envName)) {
    throw new ConfigurationError("INVALID_SECRET_ENV", "secret environment variable name is invalid");
  }
  const secret = env[envName] ?? "";
  if (!secret) {
    throw new ConfigurationError(
      "MISSING_SECRET",
      "required secret environment variable is unset"
    );
  }
  if (!header || /[\r\n]/u.test(header) || /[\r\n]/u.test(scheme)) {
    throw new ConfigurationError("INVALID_AUTH", "authentication header or scheme is invalid");
  }
  return { header, scheme, secret, envName };
}

export function parseConfig(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env
): ValidationConfig | { help: true } {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      options,
      allowPositionals: true,
      strict: true
    });
  } catch {
    throw new ConfigurationError("INVALID_ARGUMENT", "invalid command-line arguments; use --help");
  }

  if (parsed.values.help) return { help: true };
  const command = parsed.positionals[0] as CommandName | undefined;
  if (
    !command ||
    !["accept", "long", "observe"].includes(command) ||
    parsed.positionals.length !== 1
  ) {
    throw new ConfigurationError("INVALID_COMMAND", "command must be accept, long, or observe");
  }

  const baseRaw = value(
    parsed.values,
    "base-url",
    env,
    "CSAPI_VALIDATION_BASE_URL"
  );
  if (!baseRaw) {
    throw new ConfigurationError(
      "MISSING_BASE_URL",
      "--base-url or CSAPI_VALIDATION_BASE_URL is required"
    );
  }
  const baseUrl = safeUrl(baseRaw, undefined, "base URL");
  if (baseUrl.search || baseUrl.hash) {
    throw new ConfigurationError("INVALID_BASE_URL", "base URL must not contain a query or fragment");
  }

  const endpoint = value(
    parsed.values,
    "endpoint",
    env,
    "CSAPI_VALIDATION_ENDPOINT",
    "/v1/chat/completions"
  );
  const completionUrl = safeUrl(endpoint, baseUrl, "completion endpoint");
  const workspaceId = value(
    parsed.values,
    "workspace",
    env,
    "CSAPI_VALIDATION_WORKSPACE"
  );
  if (!workspaceId) {
    throw new ConfigurationError(
      "MISSING_WORKSPACE",
      "--workspace or CSAPI_VALIDATION_WORKSPACE is required"
    );
  }

  const requestedModel = value(
    parsed.values,
    "model",
    env,
    "CSAPI_VALIDATION_MODEL",
    "gpt-5.6-sol"
  );
  const expectedProvider = value(
    parsed.values,
    "expected-provider",
    env,
    "CSAPI_VALIDATION_EXPECTED_PROVIDER",
    "cursor-gateway"
  );
  const expectedModel = value(
    parsed.values,
    "expected-model",
    env,
    "CSAPI_VALIDATION_EXPECTED_MODEL",
    "gpt-5.6-sol"
  );
  if (!requestedModel || !expectedProvider || !expectedModel) {
    throw new ConfigurationError("MISSING_ROUTING_TARGET", "model and expected routing values are required");
  }

  const apiKeyEnv = value(
    parsed.values,
    "api-key-env",
    env,
    "CSAPI_VALIDATION_API_KEY_ENV",
    "CSAPI_VALIDATION_API_KEY"
  );
  const auth = authMaterial(
    env,
    apiKeyEnv,
    value(
      parsed.values,
      "auth-header",
      env,
      "CSAPI_VALIDATION_AUTH_HEADER",
      "authorization"
    ),
    value(
      parsed.values,
      "auth-scheme",
      env,
      "CSAPI_VALIDATION_AUTH_SCHEME",
      "Bearer"
    )
  );

  const requestTimeoutMs = positiveInt(
    value(
      parsed.values,
      "request-timeout-ms",
      env,
      "CSAPI_VALIDATION_REQUEST_TIMEOUT_MS",
      "360000"
    ),
    "request timeout"
  );
  const finalTimeoutMs = positiveInt(
    value(
      parsed.values,
      "final-timeout-ms",
      env,
      "CSAPI_VALIDATION_FINAL_TIMEOUT_MS",
      command === "long" ? "1800000" : "600000"
    ),
    "final timeout"
  );
  const pollIntervalMs = positiveInt(
    value(
      parsed.values,
      "poll-interval-ms",
      env,
      "CSAPI_VALIDATION_POLL_INTERVAL_MS",
      "10000"
    ),
    "poll interval"
  );

  const byKeyRaw = value(
    parsed.values,
    "observe-by-key-url",
    env,
    "CSAPI_VALIDATION_OBSERVE_BY_KEY_URL"
  );
  const byRunRaw = value(
    parsed.values,
    "observe-by-run-url",
    env,
    "CSAPI_VALIDATION_OBSERVE_BY_RUN_URL"
  );
  let observer: ObserverConfig | null = null;
  if (byKeyRaw || byRunRaw) {
    const observerKeyEnv = value(
      parsed.values,
      "observer-key-env",
      env,
      "CSAPI_VALIDATION_OBSERVER_KEY_ENV",
      apiKeyEnv
    );
    observer = {
      byKeyUrlTemplate: byKeyRaw
        ? templateUrl(byKeyRaw, baseUrl, "idempotencyKey")
        : null,
      byRunUrlTemplate: byRunRaw ? templateUrl(byRunRaw, baseUrl, "runId") : null,
      auth: authMaterial(
        env,
        observerKeyEnv,
        value(
          parsed.values,
          "observer-auth-header",
          env,
          "CSAPI_VALIDATION_OBSERVER_AUTH_HEADER",
          auth.header
        ),
        value(
          parsed.values,
          "observer-auth-scheme",
          env,
          "CSAPI_VALIDATION_OBSERVER_AUTH_SCHEME",
          auth.scheme
        )
      ),
      requestTimeoutMs: Math.min(requestTimeoutMs, 30_000)
    };
  }

  const shortPromptEnv = value(
    parsed.values,
    "short-prompt-env",
    env,
    "CSAPI_VALIDATION_SHORT_PROMPT_ENV",
    "CSAPI_VALIDATION_SHORT_PROMPT"
  );
  const shortPrompt =
    env[shortPromptEnv] ??
    "Perform a bounded validation task and return the supplied validation marker.";
  const longPromptEnv = value(
    parsed.values,
    "long-prompt-env",
    env,
    "CSAPI_VALIDATION_LONG_PROMPT_ENV",
    "CSAPI_VALIDATION_LONG_PROMPT"
  );
  const longPrompt = env[longPromptEnv] ?? null;
  if (command === "long" && !longPrompt) {
    throw new ConfigurationError(
      "MISSING_LONG_PROMPT",
      "long-task prompt environment variable is unset"
    );
  }

  const expectedLongDurationMs = positiveInt(
    value(
      parsed.values,
      "expected-long-duration-ms",
      env,
      "CSAPI_VALIDATION_EXPECTED_LONG_DURATION_MS",
      "310000"
    ),
    "expected long duration"
  );
  if (command === "long" && expectedLongDurationMs <= 300_000) {
    throw new ConfigurationError(
      "LONG_DURATION_TOO_SHORT",
      "expected long duration must exceed 300000 ms"
    );
  }

  const observationDurationMs = parseDuration(
    value(parsed.values, "duration", env, "CSAPI_VALIDATION_OBSERVE_DURATION", "24h"),
    "observation duration"
  );
  if (observationDurationMs > DAY_MS) {
    throw new ConfigurationError(
      "OBSERVATION_TOO_LONG",
      "observation duration is bounded to 24 hours"
    );
  }

  return {
    command,
    baseUrl,
    completionUrl,
    workspaceId,
    requestedModel,
    expectedProvider,
    expectedModel,
    auth,
    observer,
    requestTimeoutMs,
    finalTimeoutMs,
    pollIntervalMs,
    outputPath: value(parsed.values, "json-out", env, "CSAPI_VALIDATION_JSON_OUT", "-"),
    inputPath: value(parsed.values, "input", env, "CSAPI_VALIDATION_INPUT") || null,
    shortPrompt,
    longPrompt,
    expectedLongDurationMs,
    maxActivityGapMs: positiveInt(
      value(
        parsed.values,
        "max-activity-gap-ms",
        env,
        "CSAPI_VALIDATION_MAX_ACTIVITY_GAP_MS",
        "120000"
      ),
      "max activity gap"
    ),
    reattachDelayMs: positiveInt(
      value(
        parsed.values,
        "reattach-delay-ms",
        env,
        "CSAPI_VALIDATION_REATTACH_DELAY_MS",
        "1000"
      ),
      "reattach delay"
    ),
    observationDurationMs,
    observationIntervalMs: parseDuration(
      value(parsed.values, "interval", env, "CSAPI_VALIDATION_OBSERVE_INTERVAL", "60s"),
      "observation interval"
    )
  };
}

export function usage(): string {
  return [
    "Usage: tsx src/cli.ts <accept|long|observe> [options]",
    "",
    "Required: --base-url URL, --workspace ID, and CSAPI_VALIDATION_API_KEY.",
    "Secrets are accepted only through environment variables; no secret CLI flag exists.",
    "The raw workspace ID is request-only; reports contain a SHA-256 fingerprint.",
    "Strict lifecycle proof: configure --observe-by-key-url with {idempotencyKey}.",
    "24h follow-up: observe --input result.json --observe-by-run-url '/.../{runId}'.",
    "Use README.md for the complete contract and examples."
  ].join("\n");
}

export function reportBaseUrl(url: URL): string {
  return `${url.origin}${url.pathname}`.replace(/\/+$/u, "");
}
