export type CommandName = "accept" | "long" | "observe";

export type CanonicalRunStatus =
  | "unknown"
  | "accepted"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type AttemptDisposition = "completed" | "detached" | "failed" | "aborted";

export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface AuthMaterial {
  header: string;
  scheme: string;
  secret: string;
  envName: string;
}

export interface ObserverConfig {
  byKeyUrlTemplate: string | null;
  byRunUrlTemplate: string | null;
  auth: AuthMaterial;
  requestTimeoutMs: number;
}

export interface ValidationConfig {
  command: CommandName;
  baseUrl: URL;
  completionUrl: URL;
  /** Raw workspace ID. Runtime-only: use for requests and never report it. */
  workspaceId: string;
  requestedModel: string;
  expectedProvider: string;
  expectedModel: string;
  auth: AuthMaterial;
  observer: ObserverConfig | null;
  requestTimeoutMs: number;
  finalTimeoutMs: number;
  pollIntervalMs: number;
  outputPath: string;
  inputPath: string | null;
  shortPrompt: string;
  longPrompt: string | null;
  expectedLongDurationMs: number;
  maxActivityGapMs: number;
  reattachDelayMs: number;
  observationDurationMs: number;
  observationIntervalMs: number;
}

export interface RunEvidence {
  runId: string | null;
  status: CanonicalRunStatus;
  acceptedAtMs: number | null;
  startedAtMs: number | null;
  completedAtMs: number | null;
  lastActivityAtMs: number | null;
  activityAtMs: number[];
  provider: string | null;
  model: string | null;
  cancelReason: string | null;
  claimAttempts: number | null;
  applicationStatusCode: string | null;
  sources: string[];
}

export interface AttemptResult {
  disposition: AttemptDisposition;
  requestStartedAtMs: number;
  requestEndedAtMs: number;
  httpStatus: number | null;
  applicationStatusCode: string | null;
  failureCode: string | null;
  heartbeatCount: number;
  evidence: RunEvidence;
}

export interface ProbeSpec {
  scenario: string;
  slot: number;
  idempotencyKey: string;
  sessionId: string;
  prompt: string;
}

export interface ProbeClient {
  execute(spec: ProbeSpec, signal?: AbortSignal): Promise<AttemptResult>;
}

export interface EvidenceObserver {
  readonly canLookupByKey: boolean;
  readonly canLookupByRunId: boolean;
  lookupByKey(idempotencyKey: string, signal?: AbortSignal): Promise<RunEvidence[]>;
  lookupByRunId(runId: string, signal?: AbortSignal): Promise<RunEvidence[]>;
}

export interface AttemptSummary {
  httpStatus: number | null;
  applicationStatusCode: string | null;
  disposition: AttemptDisposition;
  durationMs: number;
}

export interface RunResult {
  slot: number;
  probeKeyHash: string;
  runId: string | null;
  status: CanonicalRunStatus;
  acceptedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  lastActivityAt: string | null;
  queueDelayMs: number | null;
  totalDurationMs: number | null;
  provider: string | null;
  model: string | null;
  cancelReason: string | null;
  claimAttempts: number | null;
  applicationStatusCode: string | null;
  attempts: AttemptSummary[];
}

export interface Violation {
  scenario: string;
  code: string;
  message: string;
  runId: string | null;
}

export interface ScenarioResult {
  name: string;
  passed: boolean;
  accepted: number;
  started: number;
  completed: number;
  maxConcurrency: number;
  runs: RunResult[];
  metrics: Record<string, unknown>;
  violations: Violation[];
}

export interface ReportSummary {
  scenarioCount: number;
  passedScenarios: number;
  accepted: number;
  started: number;
  completed: number;
  maxConcurrency: number;
  uniqueRunIds: number;
  applicationStatusCodes: Record<string, number>;
}

export interface ValidationReport {
  schemaVersion: "csapi-validation/v1";
  command: CommandName;
  passed: boolean;
  startedAt: string;
  finishedAt: string;
  target: {
    baseUrl: string;
    workspaceFingerprint: string;
    requestedModel: string;
    expectedProvider: string;
    expectedModel: string;
  };
  summary: ReportSummary;
  scenarios: ScenarioResult[];
  violations: Violation[];
}

export interface ScenarioDependencies {
  client: ProbeClient;
  observer: EvidenceObserver | null;
  clock: Clock;
  randomId(): string;
}

export class ConfigurationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export class ProviderDriftError extends Error {
  constructor(
    readonly actualProvider: string | null,
    readonly actualModel: string | null,
    readonly expectedProvider: string,
    readonly expectedModel: string
  ) {
    super("provider/model drift detected");
    this.name = "ProviderDriftError";
  }
}

export function emptyRunEvidence(source = "none"): RunEvidence {
  return {
    runId: null,
    status: "unknown",
    acceptedAtMs: null,
    startedAtMs: null,
    completedAtMs: null,
    lastActivityAtMs: null,
    activityAtMs: [],
    provider: null,
    model: null,
    cancelReason: null,
    claimAttempts: null,
    applicationStatusCode: null,
    sources: [source]
  };
}

export function isTerminalStatus(status: CanonicalRunStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}
