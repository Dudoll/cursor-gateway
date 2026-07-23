import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseConfig } from "../src/config.js";
import { evidenceFromHeaders, extractEvidence } from "../src/evidence.js";
import { CsapiHttpClient, HttpEvidenceObserver } from "../src/http.js";
import {
  buildReport,
  humanSummary,
  reportSecrets,
  serializeReport,
  workspaceFingerprint
} from "../src/report.js";
import {
  runAcceptanceScenarios,
  runLongScenario,
  runObservationScenario
} from "../src/scenarios.js";
import {
  ConfigurationError,
  ProviderDriftError,
  type CommandName,
  type ProbeSpec,
  type ScenarioDependencies,
  type ValidationConfig
} from "../src/types.js";
import { FakeClock, MockCsapiServer } from "./mock-server.js";

const TOOL_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

function configFor(
  command: CommandName,
  baseUrl: string,
  apiKey: string,
  overrides: Partial<ValidationConfig> = {}
): ValidationConfig {
  const auth = {
    header: "authorization",
    scheme: "Bearer",
    secret: apiKey,
    envName: "TEST_API_KEY"
  };
  return {
    command,
    baseUrl: new URL(baseUrl),
    completionUrl: new URL("/v1/chat/completions", baseUrl),
    workspaceId: "workspace-validation",
    requestedModel: "gpt-5.6-sol",
    expectedProvider: "cursor-gateway",
    expectedModel: "gpt-5.6-sol",
    auth,
    observer: {
      byKeyUrlTemplate: `${baseUrl}/observe/by-key/{idempotencyKey}`,
      byRunUrlTemplate: `${baseUrl}/observe/by-run/{runId}`,
      auth,
      requestTimeoutMs: 5_000
    },
    requestTimeoutMs: 5_000,
    finalTimeoutMs: 10_000,
    pollIntervalMs: 10,
    outputPath: "-",
    inputPath: null,
    shortPrompt: "bounded mock validation",
    longPrompt: "synthetic long task with regular activity",
    expectedLongDurationMs: 310_000,
    maxActivityGapMs: 120_000,
    reattachDelayMs: 1,
    observationDurationMs: 100,
    observationIntervalMs: 10,
    ...overrides
  };
}

function dependencies(
  config: ValidationConfig,
  clock = new FakeClock()
): ScenarioDependencies {
  let sequence = 0;
  return {
    client: new CsapiHttpClient(config, clock),
    observer: config.observer
      ? new HttpEvidenceObserver(
          config.observer,
          config.expectedProvider,
          config.expectedModel
        )
      : null,
    clock,
    randomId() {
      sequence += 1;
      return `mock-${sequence}`;
    }
  };
}

function probe(scenario: string, prompt = "mock prompt"): ProbeSpec {
  return {
    scenario,
    slot: 1,
    idempotencyKey: `key-${scenario}`,
    sessionId: `session-${scenario}`,
    prompt
  };
}

async function runCli(
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", ...args],
    {
      cwd: TOOL_ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const code = await new Promise<number | null>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", resolveExit);
  });
  return { code, stdout, stderr };
}

test("workspace fingerprints are stable one-way summaries", () => {
  const workspaceId = "workspace-private-8c126be4-6ab7-4ed4-a713";
  const fingerprint = workspaceFingerprint(workspaceId);

  assert.equal(fingerprint, workspaceFingerprint(workspaceId));
  assert.notEqual(
    fingerprint,
    workspaceFingerprint(`${workspaceId}-different`)
  );
  assert.match(fingerprint, /^sha256:[a-f0-9]{16}$/u);
  assert.equal(fingerprint.includes(workspaceId), false);
});

test("completion chat IDs are never promoted to or emitted as run IDs", async () => {
  const chatId = "chatcmpl-sensitive-completion-id";
  const [bodyEvidence] = extractEvidence(
    {
      runId: chatId,
      chatId,
      status: "completed",
      provider: "cursor-gateway",
      model: "gpt-5.6-sol"
    },
    "test"
  );
  const headerEvidence = evidenceFromHeaders(
    new Headers({ "x-csapi-run-id": chatId })
  );

  assert.equal(bodyEvidence?.runId, null);
  assert.equal(headerEvidence.runId, null);

  const config = configFor(
    "observe",
    "http://127.0.0.1:18080",
    "test-api-key"
  );
  const scenario = await runObservationScenario(
    [chatId],
    config,
    dependencies(config)
  );
  const output = serializeReport(
    buildReport(config, [scenario], Date.now(), Date.now()),
    reportSecrets(config)
  );
  assert.equal(scenario.passed, false);
  assert.ok(
    scenario.violations.some(
      (violation) => violation.code === "COMPLETION_ID_FORBIDDEN"
    )
  );
  assert.equal(output.includes(chatId), false);
});

test("successful acceptance proves six concurrent unique runs and one idempotent run", async () => {
  const server = new MockCsapiServer();
  const baseUrl = await server.start();
  try {
    const config = configFor("accept", baseUrl, server.apiKey);
    const scenarios = await runAcceptanceScenarios(
      config,
      dependencies(config)
    );
    const report = buildReport(config, scenarios, Date.now(), Date.now() + 1);

    assert.equal(report.passed, true);
    assert.equal(scenarios.length, 2);
    const concurrency = scenarios[0]!;
    assert.equal(concurrency.accepted, 6);
    assert.equal(concurrency.started, 6);
    assert.equal(concurrency.completed, 6);
    assert.equal(concurrency.maxConcurrency, 6);
    assert.equal(concurrency.metrics.uniqueRunIds, 6);
    assert.equal(concurrency.metrics.duplicateRuns, 0);
    assert.equal(concurrency.metrics.lostRuns, 0);

    const idempotency = scenarios[1]!;
    assert.equal(idempotency.passed, true);
    assert.equal(idempotency.metrics.concurrentRequests, 2);
    assert.equal(idempotency.metrics.singleRun, true);
    const key = server.requests.find(
      (request) => request.scenario === "concurrent-idempotency"
    )!.idempotencyKey;
    assert.equal(server.createCountByKey.get(key), 1);
  } finally {
    await server.close();
  }
});

test("claimAttempts greater than one fails strict acceptance", async () => {
  const server = new MockCsapiServer({ claimAttempts: 2 });
  const baseUrl = await server.start();
  try {
    const config = configFor("accept", baseUrl, server.apiKey);
    const scenarios = await runAcceptanceScenarios(
      config,
      dependencies(config)
    );

    assert.equal(scenarios.some((scenario) => scenario.passed), false);
    assert.ok(
      scenarios
        .flatMap((scenario) => scenario.violations)
        .some((violation) => violation.code === "MULTIPLE_CLAIM_ATTEMPTS")
    );
    assert.ok(
      scenarios
        .flatMap((scenario) => scenario.runs)
        .some((run) => run.claimAttempts === 2)
    );
  } finally {
    await server.close();
  }
});

test("multiple runs for one idempotency key fail strict acceptance", async () => {
  const server = new MockCsapiServer({ duplicateIdempotencyRun: true });
  const baseUrl = await server.start();
  try {
    const config = configFor("accept", baseUrl, server.apiKey);
    const scenarios = await runAcceptanceScenarios(
      config,
      dependencies(config)
    );
    const concurrency = scenarios[0]!;
    const idempotency = scenarios[1]!;

    assert.equal(concurrency.passed, true);
    assert.equal(idempotency.passed, false);
    assert.equal(idempotency.metrics.observedRuns, 2);
    assert.ok(
      idempotency.violations.some(
        (violation) => violation.code === "IDEMPOTENCY_DUPLICATED_RUN"
      )
    );
  } finally {
    await server.close();
  }
});

test("CLI emits JSON on stdout, a short summary on stderr, and CI exit code zero", async () => {
  const server = new MockCsapiServer();
  const baseUrl = await server.start();
  const workspaceId = "workspace-sensitive-success-4f2c7a";
  try {
    const result = await runCli(
      [
        "accept",
        "--base-url",
        baseUrl,
        "--workspace",
        workspaceId,
        "--observe-by-key-url",
        `${baseUrl}/observe/by-key/{idempotencyKey}`,
        "--observe-by-run-url",
        `${baseUrl}/observe/by-run/{runId}`,
        "--json-out",
        "-"
      ],
      { CSAPI_VALIDATION_API_KEY: server.apiKey }
    );
    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(result.stdout) as {
      passed: boolean;
      summary: { maxConcurrency: number };
      target: { workspaceFingerprint: string };
    };
    assert.equal(report.passed, true);
    assert.equal(report.summary.maxConcurrency, 6);
    assert.equal(
      report.target.workspaceFingerprint,
      workspaceFingerprint(workspaceId)
    );
    assert.match(result.stderr, /^PASS accept:/u);
    assert.doesNotMatch(result.stdout, new RegExp(server.apiKey, "u"));
    assert.doesNotMatch(result.stderr, new RegExp(server.apiKey, "u"));
    assert.doesNotMatch(result.stdout, new RegExp(workspaceId, "u"));
    assert.doesNotMatch(result.stderr, new RegExp(workspaceId, "u"));
    assert.doesNotMatch(result.stdout, new RegExp(server.chatId, "u"));
    assert.doesNotMatch(result.stderr, new RegExp(server.chatId, "u"));
  } finally {
    await server.close();
  }
});

test("failed CLI output omits workspace, URL query secrets, prompts, auth, and chat IDs", async () => {
  const server = new MockCsapiServer({ terminalStatus: "cancelled" });
  const baseUrl = await server.start();
  const workspaceId = "workspace-sensitive-failure-90f13c";
  const querySecret = "query-secret-55be17";
  const prompt = "prompt-sensitive-failure-b3c9e1";
  try {
    const result = await runCli(
      [
        "accept",
        "--base-url",
        baseUrl,
        "--endpoint",
        `/v1/chat/completions?access_token=${querySecret}`,
        "--workspace",
        workspaceId,
        "--observe-by-key-url",
        `${baseUrl}/observe/by-key/{idempotencyKey}?token=${querySecret}`,
        "--observe-by-run-url",
        `${baseUrl}/observe/by-run/{runId}?token=${querySecret}`,
        "--json-out",
        "-"
      ],
      {
        CSAPI_VALIDATION_API_KEY: server.apiKey,
        CSAPI_VALIDATION_SHORT_PROMPT: prompt
      }
    );

    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /^FAIL accept:/u);
    const report = JSON.parse(result.stdout) as {
      target: { workspaceFingerprint: string };
    };
    assert.equal(
      report.target.workspaceFingerprint,
      workspaceFingerprint(workspaceId)
    );
    for (const secret of [
      workspaceId,
      querySecret,
      prompt,
      server.apiKey,
      `Bearer ${server.apiKey}`,
      server.chatId
    ]) {
      assert.equal(result.stdout.includes(secret), false);
      assert.equal(result.stderr.includes(secret), false);
    }
  } finally {
    await server.close();
  }
});

test("authentication secret is accepted from env but not a CLI value", () => {
  const env = {
    CSAPI_VALIDATION_API_KEY: "env-only-secret",
    CSAPI_VALIDATION_BASE_URL: "http://127.0.0.1:18080",
    CSAPI_VALIDATION_WORKSPACE: "workspace-validation"
  };
  const parsed = parseConfig(["accept"], env);
  assert.ok(!("help" in parsed));
  assert.equal(parsed.auth.secret, "env-only-secret");
  assert.throws(
    () =>
      parseConfig(
        [
          "accept",
          "--base-url",
          "http://127.0.0.1:18080",
          "--workspace",
          "workspace-validation",
          "--api-key",
          "forbidden-cli-secret"
        ],
        env
      ),
    (error: unknown) =>
      error instanceof ConfigurationError &&
      error.code === "INVALID_ARGUMENT"
  );
});

test("URL userinfo is rejected for every request URL", () => {
  const env = {
    CSAPI_VALIDATION_API_KEY: "env-only-secret",
    CSAPI_VALIDATION_BASE_URL: "http://127.0.0.1:18080",
    CSAPI_VALIDATION_WORKSPACE: "workspace-validation"
  };
  const cases = [
    [
      "--base-url",
      "http://url-user:url-password@127.0.0.1:18080"
    ],
    [
      "--endpoint",
      "http://url-user:url-password@127.0.0.1:18080/v1/chat/completions"
    ],
    [
      "--observe-by-key-url",
      "http://url-user:url-password@127.0.0.1:18080/observe/{idempotencyKey}"
    ],
    [
      "--observe-by-run-url",
      "http://url-user:url-password@127.0.0.1:18080/observe/{runId}"
    ]
  ];

  for (const args of cases) {
    assert.throws(
      () => parseConfig(["accept", ...args], env),
      (error: unknown) =>
        error instanceof ConfigurationError &&
        error.code === "URL_CREDENTIALS_FORBIDDEN"
    );
  }
});

test("configuration errors do not echo workspace or URL credentials", async () => {
  const workspaceId = "workspace-config-error-sensitive-6c01";
  const urlPassword = "url-password-sensitive-a214";
  const apiKey = "api-key-config-error-sensitive-0e99";
  const result = await runCli(
    [
      "accept",
      "--base-url",
      `http://url-user:${urlPassword}@127.0.0.1:18080`,
      "--workspace",
      workspaceId
    ],
    { CSAPI_VALIDATION_API_KEY: apiKey }
  );

  assert.equal(result.code, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^CONFIG URL_CREDENTIALS_FORBIDDEN:/u);
  for (const secret of [workspaceId, urlPassword, apiKey]) {
    assert.equal(result.stderr.includes(secret), false);
  }
});

test("late configuration errors do not echo workspace-shaped env names", async () => {
  const workspaceId = "WORKSPACE_CONFIG_ERROR_SENSITIVE_6C01";
  const apiKey = "api-key-late-config-error-sensitive-7fa1";
  const common = [
    "--base-url",
    "http://127.0.0.1:18080",
    "--workspace",
    workspaceId
  ];
  const missingSecret = await runCli(
    ["accept", ...common, "--api-key-env", workspaceId],
    { [workspaceId]: "" }
  );
  const missingPrompt = await runCli(
    ["long", ...common, "--long-prompt-env", workspaceId],
    {
      CSAPI_VALIDATION_API_KEY: apiKey,
      [workspaceId]: ""
    }
  );

  assert.equal(missingSecret.code, 2);
  assert.match(missingSecret.stderr, /^CONFIG MISSING_SECRET:/u);
  assert.equal(missingPrompt.code, 2);
  assert.match(missingPrompt.stderr, /^CONFIG MISSING_LONG_PROMPT:/u);
  for (const result of [missingSecret, missingPrompt]) {
    assert.equal(result.stdout.includes(workspaceId), false);
    assert.equal(result.stderr.includes(workspaceId), false);
    assert.equal(result.stderr.includes(apiKey), false);
  }
});

test("502 and lifecycle 504 are failures with application status codes", async (t) => {
  const server = new MockCsapiServer();
  const baseUrl = await server.start();
  try {
    const config = configFor("accept", baseUrl, server.apiKey);
    const client = new CsapiHttpClient(config, new FakeClock());
    await t.test("internal 502", async () => {
      const result = await client.execute(probe("internal-502"));
      assert.equal(result.disposition, "failed");
      assert.equal(result.httpStatus, 502);
      assert.equal(result.applicationStatusCode, "CSAPI_RUN_ERROR");
    });
    await t.test("lifecycle 504", async () => {
      const result = await client.execute(probe("internal-504"));
      assert.equal(result.disposition, "failed");
      assert.equal(result.httpStatus, 504);
      assert.equal(result.applicationStatusCode, "CSAPI_IDLE_TIMEOUT");
    });
  } finally {
    await server.close();
  }
});

test("caller 504 detaches, reattaches one active run, and proves over 300 seconds", async () => {
  const server = new MockCsapiServer();
  const baseUrl = await server.start();
  const wallStarted = performance.now();
  try {
    const config = configFor("long", baseUrl, server.apiKey);
    const scenario = await runLongScenario(config, dependencies(config));
    assert.equal(scenario.passed, true);
    assert.equal(scenario.metrics.firstAttemptDetached, true);
    assert.equal(
      scenario.metrics.firstApplicationStatusCode,
      "CSAPI_CALLER_WAIT_TIMEOUT"
    );
    assert.equal(scenario.metrics.activeBeforeRetry, true);
    assert.equal(scenario.metrics.observedRuns, 1);
    assert.ok(Number(scenario.metrics.executionDurationMs) > 300_000);
    assert.ok(Number(scenario.metrics.activitySpanMs) > 300_000);
    assert.ok(Number(scenario.metrics.maximumActivityGapMs) <= 120_000);
    const key = server.requests.find(
      (request) => request.scenario === "long-active-reattach"
    )!.idempotencyKey;
    assert.equal(server.createCountByKey.get(key), 1);
    assert.equal(
      server.requests.filter(
        (request) => request.scenario === "long-active-reattach"
      ).length,
      2
    );
    assert.ok(
      performance.now() - wallStarted < 2_000,
      "fake-clock long test must not wait 300 seconds"
    );
  } finally {
    await server.close();
  }
});

test("long request can complete directly after 300 seconds without caller detachment", async () => {
  const server = new MockCsapiServer({ longCompletesDirectly: true });
  const baseUrl = await server.start();
  const wallStarted = performance.now();
  try {
    const config = configFor("long", baseUrl, server.apiKey);
    const scenario = await runLongScenario(config, dependencies(config));
    assert.equal(scenario.passed, true);
    assert.equal(scenario.metrics.firstAttemptDetached, false);
    assert.equal(scenario.metrics.reattachAttempts, 0);
    assert.equal(scenario.metrics.activeBeforeRetry, false);
    assert.equal(scenario.metrics.observedRuns, 1);
    assert.ok(Number(scenario.metrics.executionDurationMs) > 300_000);
    assert.ok(Number(scenario.metrics.activitySpanMs) > 300_000);
    const requests = server.requests.filter(
      (request) => request.scenario === "long-active-reattach"
    );
    assert.equal(requests.length, 1);
    assert.equal(server.createCountByKey.get(requests[0]!.idempotencyKey), 1);
    assert.ok(
      performance.now() - wallStarted < 2_000,
      "fake-clock direct completion test must not wait 300 seconds"
    );
  } finally {
    await server.close();
  }
});

test("observation mode stops at its configured bound", async () => {
  const server = new MockCsapiServer();
  const baseUrl = await server.start();
  try {
    const config = configFor("observe", baseUrl, server.apiKey, {
      observationDurationMs: 100,
      observationIntervalMs: 10
    });
    const deps = dependencies(config);
    const attempt = await deps.client.execute(probe("success"));
    assert.ok(attempt.evidence.runId);
    const scenario = await runObservationScenario(
      [attempt.evidence.runId],
      config,
      deps
    );
    assert.equal(scenario.passed, true);
    assert.equal(scenario.metrics.boundedDurationMs, 100);
    assert.equal(scenario.metrics.samples, 11);
  } finally {
    await server.close();
  }
});

test("observation records cancellation terminal evidence and fails strictly", async () => {
  const cancelReason = "cancelled-by-validation-tool";
  const server = new MockCsapiServer({
    terminalStatus: "cancelled",
    cancelReason
  });
  const baseUrl = await server.start();
  try {
    const config = configFor("observe", baseUrl, server.apiKey, {
      observationDurationMs: 20,
      observationIntervalMs: 10
    });
    const deps = dependencies(config);
    const attempt = await deps.client.execute(probe("success"));
    assert.ok(attempt.evidence.runId);
    const scenario = await runObservationScenario(
      [attempt.evidence.runId],
      config,
      deps
    );

    assert.equal(scenario.passed, false);
    assert.equal(scenario.runs[0]?.status, "cancelled");
    assert.equal(scenario.runs[0]?.cancelReason, cancelReason);
    assert.ok(
      scenario.violations.some(
        (violation) => violation.code === "RUN_NOT_COMPLETED"
      )
    );
    assert.equal(
      scenario.violations.some(
        (violation) => violation.code === "CANCEL_REASON_MISSING"
      ),
      false
    );
  } finally {
    await server.close();
  }
});

test("provider drift fails immediately", async () => {
  const server = new MockCsapiServer();
  const baseUrl = await server.start();
  try {
    const config = configFor("accept", baseUrl, server.apiKey);
    const client = new CsapiHttpClient(config, new FakeClock());
    await assert.rejects(
      client.execute(probe("provider-drift")),
      (error: unknown) =>
        error instanceof ProviderDriftError &&
        error.actualProvider === "DeepSeek" &&
        error.actualModel === "deepseek-chat"
    );
    assert.equal(
      server.requests.filter(
        (request) => request.scenario === "provider-drift"
      ).length,
      1
    );
  } finally {
    await server.close();
  }
});

test("reports and summaries redact all configured and URL-borne sensitive values", async () => {
  const server = new MockCsapiServer();
  const baseUrl = await server.start();
  const sensitivePrompt = "PROMPT-SENSITIVE-7d84b6f9";
  const workspaceId = "WORKSPACE-SENSITIVE-4ab0d837";
  const querySecret = "QUERY-SENSITIVE-a71c3e";
  const urlUser = "URL-USER-SENSITIVE";
  const urlPassword = "URL-PASSWORD-SENSITIVE";
  try {
    const config = configFor("accept", baseUrl, server.apiKey, {
      workspaceId,
      shortPrompt: sensitivePrompt,
      completionUrl: new URL(
        `/v1/chat/completions?access_token=${querySecret}`,
        baseUrl
      )
    });
    config.observer = {
      ...config.observer!,
      byKeyUrlTemplate:
        `${baseUrl}/observe/by-key/{idempotencyKey}?token=${querySecret}`,
      byRunUrlTemplate:
        `${baseUrl}/observe/by-run/{runId}?token=${querySecret}`
    };
    const scenarios = await runAcceptanceScenarios(
      config,
      dependencies(config)
    );
    const report = buildReport(config, scenarios, Date.now(), Date.now() + 1);
    report.scenarios[0]!.metrics.diagnosticUrl =
      `https://${urlUser}:${urlPassword}@example.invalid/path?token=${querySecret}`;
    report.scenarios[0]!.metrics.authorization = `Bearer ${server.apiKey}`;
    report.scenarios[0]!.metrics.chatId = server.chatId;
    report.scenarios[0]!.metrics.workspaceId = workspaceId;
    const output = [
      serializeReport(report, reportSecrets(config)),
      humanSummary(report)
    ].join("\n");

    assert.ok(
      server.requests.some((request) => request.prompt.includes(sensitivePrompt)),
      "the mock should receive the secret-bearing prompt"
    );
    assert.ok(
      server.requests.every((request) =>
        request.authorization.includes(server.apiKey)
      ),
      "the mock should receive authentication"
    );
    assert.doesNotMatch(output, new RegExp(server.apiKey, "u"));
    assert.doesNotMatch(output, new RegExp(sensitivePrompt, "u"));
    assert.doesNotMatch(output, new RegExp(workspaceId, "u"));
    assert.doesNotMatch(output, new RegExp(querySecret, "u"));
    assert.doesNotMatch(output, new RegExp(urlUser, "u"));
    assert.doesNotMatch(output, new RegExp(urlPassword, "u"));
    assert.doesNotMatch(output, new RegExp(server.chatId, "u"));
    assert.match(output, new RegExp(workspaceFingerprint(workspaceId), "u"));
    assert.doesNotMatch(output, /mock output intentionally discarded/u);
    assert.doesNotMatch(output, /Authorization: Bearer/iu);
  } finally {
    await server.close();
  }
});
