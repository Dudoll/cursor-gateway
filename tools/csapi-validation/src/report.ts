import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isCompletionChatId } from "./evidence.js";
import type {
  ScenarioResult,
  ValidationConfig,
  ValidationReport
} from "./types.js";

function statusCodeCounts(
  scenarios: ScenarioResult[]
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const scenario of scenarios) {
    for (const run of scenario.runs) {
      const code = run.applicationStatusCode ?? "none";
      counts[code] = (counts[code] ?? 0) + 1;
    }
  }
  return counts;
}

export function workspaceFingerprint(workspaceId: string): string {
  const digest = createHash("sha256")
    .update(workspaceId, "utf8")
    .digest("hex")
    .slice(0, 16);
  return `sha256:${digest}`;
}

export function buildReport(
  config: ValidationConfig,
  scenarios: ScenarioResult[],
  startedAtMs: number,
  finishedAtMs: number
): ValidationReport {
  const violations = scenarios.flatMap((scenario) => scenario.violations);
  const runIds = scenarios
    .flatMap((scenario) => scenario.runs)
    .map((run) => run.runId)
    .filter((runId): runId is string => runId !== null);
  return {
    schemaVersion: "csapi-validation/v1",
    command: config.command,
    passed: scenarios.length > 0 && violations.length === 0,
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: new Date(finishedAtMs).toISOString(),
    target: {
      baseUrl: config.baseUrl.origin,
      workspaceFingerprint: workspaceFingerprint(config.workspaceId),
      requestedModel: config.requestedModel,
      expectedProvider: config.expectedProvider,
      expectedModel: config.expectedModel
    },
    summary: {
      scenarioCount: scenarios.length,
      passedScenarios: scenarios.filter((scenario) => scenario.passed).length,
      accepted: scenarios.reduce(
        (total, scenario) => total + scenario.accepted,
        0
      ),
      started: scenarios.reduce(
        (total, scenario) => total + scenario.started,
        0
      ),
      completed: scenarios.reduce(
        (total, scenario) => total + scenario.completed,
        0
      ),
      maxConcurrency: Math.max(
        0,
        ...scenarios.map((scenario) => scenario.maxConcurrency)
      ),
      uniqueRunIds: new Set(runIds).size,
      applicationStatusCodes: statusCodeCounts(scenarios)
    },
    scenarios,
    violations
  };
}

function redactUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return value;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return value;
  if (!parsed.username && !parsed.password && !parsed.search && !parsed.hash) {
    return value;
  }
  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function redactString(value: string, secrets: string[]): string {
  return secrets.reduce(
    (redacted, secret) =>
      secret ? redacted.replaceAll(secret, "[REDACTED]") : redacted,
    redactUrl(value)
  );
}

const sensitiveReportKeys = new Set([
  "apikey",
  "authorization",
  "chatid",
  "longprompt",
  "prompt",
  "shortprompt",
  "workspace",
  "workspaceid"
]);

function normalizedKey(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9]/gu, "");
}

function redactValue(value: unknown, secrets: string[]): unknown {
  if (typeof value === "string") return redactString(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).flatMap(
        ([key, item]): Array<[string, unknown]> => {
          if (sensitiveReportKeys.has(normalizedKey(key))) {
            return [];
          }
          return [[key, redactValue(item, secrets)]];
        }
      )
    );
  }
  return value;
}

function urlSecrets(raw: string | null): string[] {
  if (!raw) return [];
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return [];
  }
  const queryValues = [...parsed.searchParams.values()];
  return [
    parsed.username,
    parsed.password,
    parsed.search,
    parsed.hash,
    ...queryValues,
    ...queryValues.map((item) => encodeURIComponent(item))
  ].filter(Boolean);
}

export function reportSecrets(config: ValidationConfig): string[] {
  const primaryAuthorization = config.auth.scheme
    ? `${config.auth.scheme} ${config.auth.secret}`
    : config.auth.secret;
  const observerAuthorization = config.observer
    ? config.observer.auth.scheme
      ? `${config.observer.auth.scheme} ${config.observer.auth.secret}`
      : config.observer.auth.secret
    : "";
  return [
    primaryAuthorization,
    observerAuthorization,
    config.auth.secret,
    config.observer?.auth.secret ?? "",
    config.workspaceId,
    config.shortPrompt,
    config.longPrompt ?? "",
    ...urlSecrets(config.completionUrl.toString()),
    ...urlSecrets(config.observer?.byKeyUrlTemplate ?? null),
    ...urlSecrets(config.observer?.byRunUrlTemplate ?? null)
  ].filter(Boolean);
}

export function serializeReport(
  report: ValidationReport,
  secrets: string[]
): string {
  return `${JSON.stringify(redactValue(report, secrets), null, 2)}\n`;
}

export async function writeReport(
  report: ValidationReport,
  outputPath: string,
  secrets: string[]
): Promise<void> {
  const payload = serializeReport(report, secrets);
  if (outputPath === "-") {
    process.stdout.write(payload);
    return;
  }
  const target = resolve(outputPath);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, payload, { encoding: "utf8", mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, target);
  await chmod(target, 0o600);
}

export function humanSummary(report: ValidationReport): string {
  const outcome = report.passed ? "PASS" : "FAIL";
  const failedCodes = [
    ...new Set(report.violations.map((violation) => violation.code))
  ];
  const suffix =
    failedCodes.length > 0 ? `; checks=${failedCodes.join(",")}` : "";
  return (
    `${outcome} ${report.command}: ` +
    `workspace=${report.target.workspaceFingerprint}, ` +
    `accepted=${report.summary.accepted}, started=${report.summary.started}, ` +
    `completed=${report.summary.completed}, maxConcurrency=${report.summary.maxConcurrency}, ` +
    `runs=${report.summary.uniqueRunIds}${suffix}`
  );
}

export async function readRunIds(inputPath: string): Promise<string[]> {
  const raw = await readFile(resolve(inputPath), "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object") throw new Error("INVALID_INPUT_REPORT");
  const scenarios = (parsed as { scenarios?: unknown }).scenarios;
  if (!Array.isArray(scenarios)) throw new Error("INVALID_INPUT_REPORT");
  const runIds = new Set<string>();
  for (const scenario of scenarios) {
    if (!scenario || typeof scenario !== "object") continue;
    const runs = (scenario as { runs?: unknown }).runs;
    if (!Array.isArray(runs)) continue;
    for (const run of runs) {
      if (!run || typeof run !== "object") continue;
      const runId = (run as { runId?: unknown }).runId;
      if (
        typeof runId === "string" &&
        runId &&
        !isCompletionChatId(runId)
      ) {
        runIds.add(runId);
      }
    }
  }
  if (runIds.size === 0) throw new Error("INPUT_REPORT_HAS_NO_RUN_IDS");
  return [...runIds];
}
