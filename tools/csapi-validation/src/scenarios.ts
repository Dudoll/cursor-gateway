import {
  assertExpectedRouting,
  isCompletionChatId,
  mergeEvidence,
  mergeEvidenceList,
  peakConcurrency,
  probeKeyHash,
  toIso
} from "./evidence.js";
import { mergeAttemptEvidence } from "./http.js";
import {
  ProviderDriftError,
  emptyRunEvidence,
  isTerminalStatus,
  type AttemptResult,
  type ProbeSpec,
  type RunEvidence,
  type RunResult,
  type ScenarioDependencies,
  type ScenarioResult,
  type ValidationConfig,
  type Violation
} from "./types.js";

interface CollectedEvidence {
  evidence: RunEvidence;
  observedRuns: RunEvidence[];
  multiplicity: number;
  lookupFailure: boolean;
}

function safeAttemptFailure(
  startedAt: number,
  endedAt: number,
  failureCode: string
): AttemptResult {
  return {
    disposition: "failed",
    requestStartedAtMs: startedAt,
    requestEndedAtMs: endedAt,
    httpStatus: null,
    applicationStatusCode: null,
    failureCode,
    heartbeatCount: 0,
    evidence: emptyRunEvidence("scenario-error")
  };
}

function driftViolation(
  scenario: string,
  drift: ProviderDriftError
): Violation {
  return {
    scenario,
    code: "PROVIDER_MODEL_DRIFT",
    message: `expected ${drift.expectedProvider}/${drift.expectedModel}; observed ${drift.actualProvider ?? "unknown"}/${drift.actualModel ?? "unknown"}`,
    runId: null
  };
}

function normalizeObserved(evidence: RunEvidence[]): RunEvidence[] {
  const scoped = new Map<string, RunEvidence>();
  let unscoped = emptyRunEvidence("observer-unscoped");
  for (const item of evidence) {
    if (item.runId) {
      scoped.set(
        item.runId,
        scoped.has(item.runId)
          ? mergeEvidence(scoped.get(item.runId)!, item)
          : item
      );
    } else {
      unscoped = mergeEvidence(unscoped, item);
    }
  }
  if (scoped.size === 0) {
    const hasUnscoped =
      unscoped.status !== "unknown" ||
      unscoped.provider !== null ||
      unscoped.model !== null ||
      unscoped.applicationStatusCode !== null;
    return hasUnscoped ? [unscoped] : [];
  }
  return [...scoped.values()].map((item) => mergeEvidence(unscoped, item));
}

async function collectFinalEvidence(
  spec: ProbeSpec,
  attempts: AttemptResult[],
  config: ValidationConfig,
  deps: ScenarioDependencies
): Promise<CollectedEvidence> {
  const fromAttempts = mergeAttemptEvidence(attempts);
  const observer = deps.observer;
  if (!observer) {
    return {
      evidence: fromAttempts,
      observedRuns: fromAttempts.runId ? [fromAttempts] : [],
      multiplicity: fromAttempts.runId ? 1 : 0,
      lookupFailure: false
    };
  }

  const canQueryByKey = observer.canLookupByKey;
  const canQueryByRun = observer.canLookupByRunId && fromAttempts.runId !== null;
  if (!canQueryByKey && !canQueryByRun) {
    return {
      evidence: fromAttempts,
      observedRuns: fromAttempts.runId ? [fromAttempts] : [],
      multiplicity: fromAttempts.runId ? 1 : 0,
      lookupFailure: false
    };
  }

  const deadline = deps.clock.now() + config.finalTimeoutMs;
  const accumulated = new Map<string, RunEvidence>();
  let unscoped = emptyRunEvidence("observer");
  for (;;) {
    let observed: RunEvidence[];
    try {
      observed = canQueryByKey
        ? await observer.lookupByKey(spec.idempotencyKey)
        : await observer.lookupByRunId(fromAttempts.runId!);
    } catch (error) {
      if (error instanceof ProviderDriftError) throw error;
      return {
        evidence: fromAttempts,
        observedRuns: [],
        multiplicity: 0,
        lookupFailure: true
      };
    }

    for (const item of observed) {
      assertExpectedRouting(
        item,
        config.expectedProvider,
        config.expectedModel
      );
      if (item.runId) {
        accumulated.set(
          item.runId,
          accumulated.has(item.runId)
            ? mergeEvidence(accumulated.get(item.runId)!, item)
            : item
        );
      } else {
        unscoped = mergeEvidence(unscoped, item);
      }
    }

    const normalized = normalizeObserved([
      ...accumulated.values(),
      unscoped
    ]);
    if (
      normalized.length > 0 &&
      normalized.every((item) => isTerminalStatus(item.status))
    ) {
      const mergedObserved = mergeEvidenceList(normalized);
      return {
        evidence: mergeEvidence(fromAttempts, mergedObserved),
        observedRuns: normalized,
        multiplicity:
          accumulated.size > 0 ? accumulated.size : normalized.length,
        lookupFailure: false
      };
    }
    if (deps.clock.now() >= deadline) {
      const mergedObserved =
        normalized.length > 0
          ? mergeEvidenceList(normalized)
          : emptyRunEvidence("observer-timeout");
      return {
        evidence: mergeEvidence(fromAttempts, mergedObserved),
        observedRuns: normalized,
        multiplicity:
          accumulated.size > 0 ? accumulated.size : normalized.length,
        lookupFailure: false
      };
    }
    await deps.clock.sleep(config.pollIntervalMs);
  }
}

function runResult(
  slot: number,
  idempotencyKey: string,
  evidence: RunEvidence,
  attempts: AttemptResult[]
): RunResult {
  const queueDelayMs =
    evidence.acceptedAtMs !== null && evidence.startedAtMs !== null
      ? evidence.startedAtMs - evidence.acceptedAtMs
      : null;
  const totalDurationMs =
    evidence.acceptedAtMs !== null && evidence.completedAtMs !== null
      ? evidence.completedAtMs - evidence.acceptedAtMs
      : null;
  return {
    slot,
    probeKeyHash: probeKeyHash(idempotencyKey),
    runId: evidence.runId,
    status: evidence.status,
    acceptedAt: toIso(evidence.acceptedAtMs),
    startedAt: toIso(evidence.startedAtMs),
    completedAt: toIso(evidence.completedAtMs),
    lastActivityAt: toIso(evidence.lastActivityAtMs),
    queueDelayMs,
    totalDurationMs,
    provider: evidence.provider,
    model: evidence.model,
    cancelReason: evidence.cancelReason,
    claimAttempts: evidence.claimAttempts,
    applicationStatusCode:
      evidence.applicationStatusCode ??
      attempts.map((attempt) => attempt.applicationStatusCode).find(Boolean) ??
      null,
    attempts: attempts.map((attempt) => ({
      httpStatus: attempt.httpStatus,
      applicationStatusCode: attempt.applicationStatusCode,
      disposition: attempt.disposition,
      durationMs: Math.max(
        0,
        attempt.requestEndedAtMs - attempt.requestStartedAtMs
      )
    }))
  };
}

function lifecycleViolations(
  scenario: string,
  evidence: RunEvidence,
  config: ValidationConfig
): Violation[] {
  const violations: Violation[] = [];
  const add = (code: string, message: string) =>
    violations.push({ scenario, code, message, runId: evidence.runId });
  if (!evidence.runId) add("RUN_ID_MISSING", "real run ID was not observable");
  if (evidence.acceptedAtMs === null) {
    add("ACCEPTED_EVIDENCE_MISSING", "accepted/queued timestamp was not observable");
  }
  if (evidence.startedAtMs === null) {
    add("STARTED_EVIDENCE_MISSING", "started timestamp was not observable");
  }
  if (evidence.completedAtMs === null) {
    add("COMPLETED_EVIDENCE_MISSING", "completed timestamp was not observable");
  }
  if (evidence.status !== "completed") {
    add("RUN_NOT_COMPLETED", `terminal run status is ${evidence.status}`);
  }
  if (evidence.status === "cancelled" && !evidence.cancelReason) {
    add(
      "CANCEL_REASON_MISSING",
      "cancelled run did not expose a cancellation reason"
    );
  }
  if (evidence.claimAttempts !== null && evidence.claimAttempts > 1) {
    add(
      "MULTIPLE_CLAIM_ATTEMPTS",
      `run was claimed ${evidence.claimAttempts} times`
    );
  }
  if (!evidence.provider) {
    add("PROVIDER_EVIDENCE_MISSING", "provider metadata was not observable");
  }
  if (!evidence.model) {
    add("MODEL_EVIDENCE_MISSING", "model metadata was not observable");
  }
  if (evidence.provider || evidence.model) {
    try {
      assertExpectedRouting(
        evidence,
        config.expectedProvider,
        config.expectedModel
      );
    } catch (error) {
      if (error instanceof ProviderDriftError) {
        violations.push(driftViolation(scenario, error));
      }
    }
  }
  if (
    evidence.acceptedAtMs !== null &&
    evidence.startedAtMs !== null &&
    evidence.startedAtMs < evidence.acceptedAtMs
  ) {
    add("INVALID_LIFECYCLE_ORDER", "started timestamp precedes accepted timestamp");
  }
  if (
    evidence.startedAtMs !== null &&
    evidence.completedAtMs !== null &&
    evidence.completedAtMs < evidence.startedAtMs
  ) {
    add("INVALID_LIFECYCLE_ORDER", "completed timestamp precedes started timestamp");
  }
  return violations;
}

function scenarioResult(
  name: string,
  runs: RunResult[],
  evidence: RunEvidence[],
  metrics: Record<string, unknown>,
  violations: Violation[]
): ScenarioResult {
  const accepted = evidence.filter(
    (item) => item.runId !== null && item.acceptedAtMs !== null
  ).length;
  const started = evidence.filter((item) => item.startedAtMs !== null).length;
  const completed = evidence.filter(
    (item) => item.status === "completed" && item.completedAtMs !== null
  ).length;
  const maxConcurrency = peakConcurrency(evidence);
  return {
    name,
    passed: violations.length === 0,
    accepted,
    started,
    completed,
    maxConcurrency,
    runs,
    metrics,
    violations
  };
}

function makeSpec(
  config: ValidationConfig,
  deps: ScenarioDependencies,
  scenario: string,
  slot: number,
  idempotencyKey?: string
): ProbeSpec {
  const marker = deps.randomId();
  return {
    scenario,
    slot,
    idempotencyKey:
      idempotencyKey ?? `csapi-validation-${scenario}-${marker}`,
    sessionId: `csapi-validation-${scenario}-${slot}-${deps.randomId()}`,
    prompt: `${config.shortPrompt}\nValidation marker: ${marker}`
  };
}

async function executeTogether(
  specs: ProbeSpec[],
  deps: ScenarioDependencies
): Promise<{
  attempts: AttemptResult[];
  drift: ProviderDriftError | null;
}> {
  const controller = new AbortController();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const promises = specs.map(async (spec) => {
    await gate;
    try {
      return await deps.client.execute(spec, controller.signal);
    } catch (error) {
      if (error instanceof ProviderDriftError) controller.abort();
      throw error;
    }
  });
  release();
  const settled = await Promise.allSettled(promises);
  let drift: ProviderDriftError | null = null;
  const attempts = settled.map((item) => {
    if (item.status === "fulfilled") return item.value;
    if (item.reason instanceof ProviderDriftError) drift ??= item.reason;
    const now = deps.clock.now();
    return safeAttemptFailure(now, now, "PROVIDER_MODEL_DRIFT");
  });
  return { attempts, drift };
}

async function runSixConcurrency(
  config: ValidationConfig,
  deps: ScenarioDependencies
): Promise<ScenarioResult> {
  const name = "six-concurrency";
  const specs = Array.from({ length: 6 }, (_, index) =>
    makeSpec(config, deps, name, index + 1)
  );
  const batch = await executeTogether(specs, deps);
  const violations: Violation[] = [];
  if (batch.drift) {
    violations.push(driftViolation(name, batch.drift));
    const evidence = batch.attempts.map((attempt) => attempt.evidence);
    return scenarioResult(
      name,
      specs.map((spec, index) =>
        runResult(
          spec.slot,
          spec.idempotencyKey,
          evidence[index] ?? emptyRunEvidence(),
          [batch.attempts[index]!]
        )
      ),
      evidence,
      {
        requestedConcurrency: 6,
        abortedImmediatelyOnRoutingDrift: true
      },
      violations
    );
  }

  const collected: CollectedEvidence[] = [];
  for (const [index, spec] of specs.entries()) {
    const attempt = batch.attempts[index]!;
    if (attempt.disposition !== "completed") {
      violations.push({
        scenario: name,
        code: attempt.failureCode ?? "REQUEST_NOT_COMPLETED",
        message: `slot ${spec.slot} request ended as ${attempt.disposition}`,
        runId: attempt.evidence.runId
      });
    }
    try {
      const result = await collectFinalEvidence(
        spec,
        [attempt],
        config,
        deps
      );
      collected.push(result);
      if (result.lookupFailure) {
        violations.push({
          scenario: name,
          code: "OBSERVER_QUERY_FAILED",
          message: `slot ${spec.slot} lifecycle query failed`,
          runId: result.evidence.runId
        });
      }
      if (result.multiplicity !== 1) {
        violations.push({
          scenario: name,
          code: "RUN_MULTIPLICITY",
          message: `slot ${spec.slot} mapped to ${result.multiplicity} runs`,
          runId: result.evidence.runId
        });
      }
      violations.push(...lifecycleViolations(name, result.evidence, config));
    } catch (error) {
      if (error instanceof ProviderDriftError) {
        violations.push(driftViolation(name, error));
        collected.push({
          evidence: attempt.evidence,
          observedRuns: [],
          multiplicity: 0,
          lookupFailure: false
        });
      } else {
        throw error;
      }
    }
  }

  const evidence = collected.map((item) => item.evidence);
  const runIds = evidence
    .map((item) => item.runId)
    .filter((item): item is string => item !== null);
  const uniqueRunIds = new Set(runIds);
  if (runIds.length !== 6 || uniqueRunIds.size !== 6) {
    violations.push({
      scenario: name,
      code: "DUPLICATE_OR_LOST_RUN",
      message: `expected 6 distinct runs; observed ${uniqueRunIds.size}`,
      runId: null
    });
  }
  const peak = peakConcurrency(evidence);
  if (peak !== 6) {
    violations.push({
      scenario: name,
      code: "CONCURRENCY_NOT_SIX",
      message: `expected measured concurrency 6; observed ${peak}`,
      runId: null
    });
  }

  const queueDelays = evidence
    .filter(
      (item) => item.acceptedAtMs !== null && item.startedAtMs !== null
    )
    .map((item) => item.startedAtMs! - item.acceptedAtMs!);
  const durations = evidence
    .filter(
      (item) => item.acceptedAtMs !== null && item.completedAtMs !== null
    )
    .map((item) => item.completedAtMs! - item.acceptedAtMs!);
  return scenarioResult(
    name,
    specs.map((spec, index) =>
      runResult(
        spec.slot,
        spec.idempotencyKey,
        evidence[index] ?? emptyRunEvidence(),
        [batch.attempts[index]!]
      )
    ),
    evidence,
    {
      requestedConcurrency: 6,
      uniqueRunIds: uniqueRunIds.size,
      duplicateRuns: runIds.length - uniqueRunIds.size,
      lostRuns: Math.max(0, 6 - uniqueRunIds.size),
      averageQueueDelayMs:
        queueDelays.length > 0
          ? Math.round(
              queueDelays.reduce((total, item) => total + item, 0) /
                queueDelays.length
            )
          : null,
      maximumTotalDurationMs:
        durations.length > 0 ? Math.max(...durations) : null
    },
    violations
  );
}

async function runConcurrentIdempotency(
  config: ValidationConfig,
  deps: ScenarioDependencies
): Promise<ScenarioResult> {
  const name = "concurrent-idempotency";
  const idempotencyKey = `csapi-validation-idempotency-${deps.randomId()}`;
  const first = makeSpec(config, deps, name, 1, idempotencyKey);
  const second = {
    ...makeSpec(config, deps, name, 2, idempotencyKey),
    prompt: first.prompt
  };
  const specs = [first, second];
  const batch = await executeTogether(specs, deps);
  const violations: Violation[] = [];
  if (batch.drift) violations.push(driftViolation(name, batch.drift));
  if (!batch.attempts.some((attempt) => attempt.disposition === "completed")) {
    violations.push({
      scenario: name,
      code: "NO_COMPLETED_ATTACHMENT",
      message: "neither concurrent request attached through completion",
      runId: null
    });
  }
  for (const attempt of batch.attempts) {
    if (attempt.disposition === "failed" || attempt.disposition === "aborted") {
      violations.push({
        scenario: name,
        code: attempt.failureCode ?? "IDEMPOTENT_REQUEST_FAILED",
        message: `concurrent idempotent request ended as ${attempt.disposition}`,
        runId: attempt.evidence.runId
      });
    }
  }

  let collected: CollectedEvidence;
  try {
    collected = await collectFinalEvidence(
      first,
      batch.attempts,
      config,
      deps
    );
  } catch (error) {
    if (!(error instanceof ProviderDriftError)) throw error;
    violations.push(driftViolation(name, error));
    collected = {
      evidence: mergeAttemptEvidence(batch.attempts),
      observedRuns: [],
      multiplicity: 0,
      lookupFailure: false
    };
  }
  if (collected.lookupFailure) {
    violations.push({
      scenario: name,
      code: "OBSERVER_QUERY_FAILED",
      message: "idempotency lifecycle query failed",
      runId: collected.evidence.runId
    });
  }
  if (collected.multiplicity !== 1) {
    violations.push({
      scenario: name,
      code: "IDEMPOTENCY_DUPLICATED_RUN",
      message: `one idempotency key mapped to ${collected.multiplicity} runs`,
      runId: collected.evidence.runId
    });
  }
  const attemptRunIds = new Set(
    batch.attempts
      .map((attempt) => attempt.evidence.runId)
      .filter((item): item is string => item !== null)
  );
  if (
    attemptRunIds.size > 1 ||
    (collected.evidence.runId !== null &&
      [...attemptRunIds].some((id) => id !== collected.evidence.runId))
  ) {
    violations.push({
      scenario: name,
      code: "IDEMPOTENCY_RUN_ID_MISMATCH",
      message: "concurrent attachments reported different run IDs",
      runId: collected.evidence.runId
    });
  }
  violations.push(
    ...lifecycleViolations(name, collected.evidence, config)
  );
  return scenarioResult(
    name,
    [
      runResult(
        1,
        idempotencyKey,
        collected.evidence,
        batch.attempts
      )
    ],
    [collected.evidence],
    {
      concurrentRequests: 2,
      observedRuns: collected.multiplicity,
      singleRun: collected.multiplicity === 1,
      allRequestsStartedBeforeCompletion:
        collected.evidence.completedAtMs !== null &&
        batch.attempts.every(
          (attempt) =>
            attempt.requestStartedAtMs < collected.evidence.completedAtMs!
        )
    },
    violations
  );
}

export async function runAcceptanceScenarios(
  config: ValidationConfig,
  deps: ScenarioDependencies
): Promise<ScenarioResult[]> {
  const six = await runSixConcurrency(config, deps);
  if (
    six.violations.some(
      (item) => item.code === "PROVIDER_MODEL_DRIFT"
    )
  ) {
    return [six];
  }
  const idempotency = await runConcurrentIdempotency(config, deps);
  return [six, idempotency];
}

async function observeOnce(
  spec: ProbeSpec,
  config: ValidationConfig,
  deps: ScenarioDependencies
): Promise<RunEvidence[]> {
  if (!deps.observer?.canLookupByKey) return [];
  const observed = normalizeObserved(
    await deps.observer.lookupByKey(spec.idempotencyKey)
  );
  for (const item of observed) {
    assertExpectedRouting(
      item,
      config.expectedProvider,
      config.expectedModel
    );
  }
  return observed;
}

async function executeTrackedAttempt(
  spec: ProbeSpec,
  config: ValidationConfig,
  deps: ScenarioDependencies
): Promise<{
  attempt: AttemptResult;
  observed: RunEvidence[];
  observerFailures: number;
}> {
  const controller = new AbortController();
  let settled = false;
  let settle!: () => void;
  const settledPromise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const requestPromise = deps.client.execute(spec, controller.signal).finally(() => {
    settled = true;
    settle();
  });
  const observed: RunEvidence[] = [];
  let observerFailures = 0;
  let drift: ProviderDriftError | null = null;

  const monitor = async () => {
    if (!deps.observer?.canLookupByKey) return;
    while (!settled) {
      try {
        observed.push(
          ...normalizeObserved(
            await deps.observer.lookupByKey(
              spec.idempotencyKey,
              controller.signal
            )
          )
        );
      } catch (error) {
        if (error instanceof ProviderDriftError) {
          drift = error;
          controller.abort();
          return;
        }
        observerFailures += 1;
      }
      if (settled) return;
      const tickController = new AbortController();
      const next = await Promise.race([
        settledPromise.then(() => "settled" as const),
        deps.clock
          .sleep(config.pollIntervalMs, tickController.signal)
          .then(() => "tick" as const)
          .catch(() => "settled" as const)
      ]);
      if (next === "settled") {
        tickController.abort();
        return;
      }
    }
  };

  const monitorPromise = monitor();
  const attempt = await requestPromise;
  await monitorPromise;
  if (drift) throw drift;
  return { attempt, observed, observerFailures };
}

function activityMetrics(
  evidence: RunEvidence
): { samples: number; spanMs: number | null; maximumGapMs: number | null } {
  const points = [
    ...(evidence.startedAtMs === null ? [] : [evidence.startedAtMs]),
    ...evidence.activityAtMs
  ]
    .filter((item, index, all) => all.indexOf(item) === index)
    .sort((left, right) => left - right);
  if (points.length < 2) {
    return { samples: points.length, spanMs: null, maximumGapMs: null };
  }
  const gaps = points.slice(1).map((item, index) => item - points[index]!);
  return {
    samples: points.length,
    spanMs: points.at(-1)! - points[0]!,
    maximumGapMs: Math.max(...gaps)
  };
}

export async function runLongScenario(
  config: ValidationConfig,
  deps: ScenarioDependencies
): Promise<ScenarioResult> {
  const name = "long-active-reattach";
  const spec = makeSpec(config, deps, name, 1);
  spec.prompt = `${config.longPrompt ?? ""}\nValidation marker: ${deps.randomId()}`;
  const attempts: AttemptResult[] = [];
  const timeline: RunEvidence[] = [];
  const violations: Violation[] = [];
  let observerFailures = 0;

  let first: AttemptResult;
  try {
    const tracked = await executeTrackedAttempt(spec, config, deps);
    first = tracked.attempt;
    timeline.push(...tracked.observed);
    observerFailures += tracked.observerFailures;
  } catch (error) {
    if (!(error instanceof ProviderDriftError)) throw error;
    violations.push(driftViolation(name, error));
    first = safeAttemptFailure(
      deps.clock.now(),
      deps.clock.now(),
      "PROVIDER_MODEL_DRIFT"
    );
  }
  attempts.push(first);

  let activeBeforeRetry = false;
  if (first.disposition === "detached") {
    try {
      const observed = await observeOnce(spec, config, deps);
      timeline.push(...observed);
      activeBeforeRetry = observed.some(
        (item) => item.status === "accepted" || item.status === "running"
      );
    } catch (error) {
      if (error instanceof ProviderDriftError) {
        violations.push(driftViolation(name, error));
      } else {
        violations.push({
          scenario: name,
          code: "OBSERVER_QUERY_FAILED",
          message: "active-run query failed before reattachment",
          runId: first.evidence.runId
        });
      }
    }
    await deps.clock.sleep(config.reattachDelayMs);
    try {
      const tracked = await executeTrackedAttempt(spec, config, deps);
      attempts.push(tracked.attempt);
      timeline.push(...tracked.observed);
      observerFailures += tracked.observerFailures;
    } catch (error) {
      if (!(error instanceof ProviderDriftError)) throw error;
      violations.push(driftViolation(name, error));
      attempts.push(
        safeAttemptFailure(
          deps.clock.now(),
          deps.clock.now(),
          "PROVIDER_MODEL_DRIFT"
        )
      );
    }
  } else {
    violations.push({
      scenario: name,
      code: "CALLER_TIMEOUT_NOT_OBSERVED",
      message: `expected a detachable caller timeout; first request was ${first.disposition}`,
      runId: first.evidence.runId
    });
  }

  if (
    first.disposition === "detached" &&
    first.applicationStatusCode !== "CSAPI_CALLER_WAIT_TIMEOUT" &&
    first.failureCode !== "CLIENT_WAIT_TIMEOUT"
  ) {
    violations.push({
      scenario: name,
      code: "UNSAFE_TIMEOUT_CLASSIFICATION",
      message: "detached request did not carry the caller-wait timeout code",
      runId: first.evidence.runId
    });
  }
  if (!activeBeforeRetry) {
    violations.push({
      scenario: name,
      code: "ACTIVE_REATTACH_NOT_PROVEN",
      message: "an active run was not observed before retrying the same idempotency key",
      runId: first.evidence.runId
    });
  }
  if (
    attempts.slice(1).some(
      (attempt) =>
        attempt.disposition === "failed" || attempt.disposition === "aborted"
    )
  ) {
    violations.push({
      scenario: name,
      code: "REATTACH_REQUEST_FAILED",
      message: "reattachment request failed",
      runId: null
    });
  }

  let collected: CollectedEvidence;
  try {
    collected = await collectFinalEvidence(spec, attempts, config, deps);
  } catch (error) {
    if (!(error instanceof ProviderDriftError)) throw error;
    violations.push(driftViolation(name, error));
    collected = {
      evidence: mergeAttemptEvidence(attempts),
      observedRuns: [],
      multiplicity: 0,
      lookupFailure: false
    };
  }
  let evidence = collected.evidence;
  if (timeline.length > 0) {
    evidence = mergeEvidence(evidence, mergeEvidenceList(timeline));
  }
  if (collected.lookupFailure) {
    violations.push({
      scenario: name,
      code: "OBSERVER_QUERY_FAILED",
      message: "final long-run query failed",
      runId: evidence.runId
    });
  }
  if (collected.multiplicity !== 1) {
    violations.push({
      scenario: name,
      code: "IDEMPOTENCY_DUPLICATED_RUN",
      message: `long-task retries mapped to ${collected.multiplicity} runs`,
      runId: evidence.runId
    });
  }
  violations.push(...lifecycleViolations(name, evidence, config));

  const durationMs =
    evidence.startedAtMs !== null && evidence.completedAtMs !== null
      ? evidence.completedAtMs - evidence.startedAtMs
      : null;
  if (durationMs === null || durationMs < config.expectedLongDurationMs) {
    violations.push({
      scenario: name,
      code: "LONG_DURATION_NOT_PROVEN",
      message: `expected at least ${config.expectedLongDurationMs} ms of execution`,
      runId: evidence.runId
    });
  }
  const activity = activityMetrics(evidence);
  if (
    activity.samples < 3 ||
    activity.spanMs === null ||
    activity.spanMs <= 300_000
  ) {
    violations.push({
      scenario: name,
      code: "CONTINUOUS_ACTIVITY_NOT_PROVEN",
      message: "activity evidence did not span more than 300 seconds",
      runId: evidence.runId
    });
  }
  if (
    activity.maximumGapMs === null ||
    activity.maximumGapMs > config.maxActivityGapMs
  ) {
    violations.push({
      scenario: name,
      code: "ACTIVITY_GAP_TOO_LARGE",
      message: `maximum observed activity gap exceeded ${config.maxActivityGapMs} ms`,
      runId: evidence.runId
    });
  }

  return scenarioResult(
    name,
    [runResult(1, spec.idempotencyKey, evidence, attempts)],
    [evidence],
    {
      firstAttemptDetached: first.disposition === "detached",
      firstApplicationStatusCode: first.applicationStatusCode,
      reattachAttempts: Math.max(0, attempts.length - 1),
      activeBeforeRetry,
      observedRuns: collected.multiplicity,
      executionDurationMs: durationMs,
      activitySamples: activity.samples,
      activitySpanMs: activity.spanMs,
      maximumActivityGapMs: activity.maximumGapMs,
      transientObserverFailures: observerFailures
    },
    violations
  );
}

export async function runObservationScenario(
  runIds: string[],
  config: ValidationConfig,
  deps: ScenarioDependencies
): Promise<ScenarioResult> {
  const name = "bounded-observation";
  const violations: Violation[] = [];
  const safeRunIds = runIds.filter((runId) => !isCompletionChatId(runId));
  const rejectedCompletionIds = runIds.length - safeRunIds.length;
  if (rejectedCompletionIds > 0) {
    violations.push({
      scenario: name,
      code: "COMPLETION_ID_FORBIDDEN",
      message: "completion/chat IDs cannot be used as Gateway run IDs",
      runId: null
    });
  }
  if (safeRunIds.length === 0) {
    return scenarioResult(
      name,
      [],
      [],
      { samples: 0, requestedRuns: 0, rejectedCompletionIds },
      violations
    );
  }
  if (!deps.observer?.canLookupByRunId) {
    violations.push({
      scenario: name,
      code: "RUN_QUERY_NOT_CONFIGURED",
      message: "observe-by-run URL is required for bounded observation",
      runId: null
    });
    return scenarioResult(name, [], [], { samples: 0 }, violations);
  }
  const deadline = deps.clock.now() + config.observationDurationMs;
  const latest = new Map<string, RunEvidence>();
  const queryFailures = new Set<string>();
  let samples = 0;
  for (;;) {
    for (const runId of safeRunIds) {
      try {
        const observed = normalizeObserved(
          await deps.observer.lookupByRunId(runId)
        );
        const match = observed.find((item) => item.runId === runId);
        if (!match) continue;
        latest.set(
          runId,
          latest.has(runId)
            ? mergeEvidence(latest.get(runId)!, match)
            : match
        );
      } catch (error) {
        if (error instanceof ProviderDriftError) {
          violations.push(driftViolation(name, error));
          return scenarioResult(
            name,
            [],
            [...latest.values()],
            { samples },
            violations
          );
        }
        queryFailures.add(runId);
      }
    }
    samples += 1;
    if (deps.clock.now() >= deadline) break;
    await deps.clock.sleep(
      Math.min(
        config.observationIntervalMs,
        Math.max(1, deadline - deps.clock.now())
      )
    );
  }

  const evidence = [...latest.values()];
  for (const runId of safeRunIds) {
    if (!latest.has(runId)) {
      violations.push({
        scenario: name,
        code: queryFailures.has(runId)
          ? "OBSERVER_QUERY_FAILED"
          : "RUN_NOT_FOUND",
        message: queryFailures.has(runId)
          ? "bounded observation query failed"
          : "observation query did not return the requested run",
        runId
      });
      continue;
    }
    const item = latest.get(runId)!;
    violations.push(...lifecycleViolations(name, item, config));
  }
  return scenarioResult(
    name,
    evidence.map((item, index) =>
      runResult(index + 1, `observed-${item.runId ?? index}`, item, [])
    ),
    evidence,
    {
      boundedDurationMs: config.observationDurationMs,
      intervalMs: config.observationIntervalMs,
      samples,
      requestedRuns: safeRunIds.length,
      rejectedCompletionIds,
      observedRuns: latest.size
    },
    violations
  );
}
