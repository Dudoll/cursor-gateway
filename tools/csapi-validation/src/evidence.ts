import { createHash } from "node:crypto";
import {
  ProviderDriftError,
  emptyRunEvidence,
  type CanonicalRunStatus,
  type RunEvidence
} from "./types.js";

const skippedPayloadKeys = new Set([
  "content",
  "text",
  "prompt",
  "response",
  "messages",
  "message",
  "choices",
  "delta",
  "arguments",
  "input",
  "output"
]);

function normalizedKey(key: string): string {
  return key.toLowerCase().replaceAll(/[^a-z0-9]/gu, "");
}

function fields(record: Record<string, unknown>): Map<string, unknown> {
  return new Map(
    Object.entries(record).map(([key, fieldValue]) => [
      normalizedKey(key),
      fieldValue
    ])
  );
}

function stringField(
  available: Map<string, unknown>,
  ...names: string[]
): string | null {
  for (const name of names) {
    const candidate = available.get(normalizedKey(name));
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return null;
}

export function isCompletionChatId(value: string): boolean {
  return /^chatcmpl[-_]/iu.test(value);
}

function runIdentifier(value: string | null): string | null {
  if (!value || isCompletionChatId(value)) return null;
  return value;
}

function nonNegativeInteger(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function integerField(
  available: Map<string, unknown>,
  ...names: string[]
): number | null {
  for (const name of names) {
    const candidate = nonNegativeInteger(
      available.get(normalizedKey(name))
    );
    if (candidate !== null) return candidate;
  }
  return null;
}

export function parseTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 10_000_000_000) return Math.round(value);
    if (value > 1_000_000_000) return Math.round(value * 1_000);
    return null;
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 1_000_000_000) {
    return numeric > 10_000_000_000 ? Math.round(numeric) : Math.round(numeric * 1_000);
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function timestampField(
  available: Map<string, unknown>,
  ...names: string[]
): number | null {
  for (const name of names) {
    const parsed = parseTimestamp(available.get(normalizedKey(name)));
    if (parsed !== null) return parsed;
  }
  return null;
}

export function normalizeStatus(value: unknown): CanonicalRunStatus {
  if (typeof value !== "string") return "unknown";
  switch (normalizedKey(value)) {
    case "queued":
    case "waiting":
    case "waitingapproval":
    case "accepted":
    case "created":
    case "pending":
      return "accepted";
    case "running":
    case "started":
    case "inprogress":
    case "active":
      return "running";
    case "finished":
    case "complete":
    case "completed":
    case "succeeded":
    case "success":
      return "completed";
    case "error":
    case "failed":
    case "failure":
      return "failed";
    case "cancelled":
    case "canceled":
    case "aborted":
      return "cancelled";
    default:
      return "unknown";
  }
}

function eventStatus(value: string | null): CanonicalRunStatus {
  if (!value) return "unknown";
  const tail = value.split(/[.:/]/u).at(-1);
  return normalizeStatus(tail);
}

function statusRank(status: CanonicalRunStatus): number {
  switch (status) {
    case "unknown":
      return 0;
    case "accepted":
      return 1;
    case "running":
      return 2;
    case "completed":
    case "failed":
    case "cancelled":
      return 3;
  }
}

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

export function mergeEvidence(left: RunEvidence, right: RunEvidence): RunEvidence {
  const incomingStatus =
    statusRank(right.status) >= statusRank(left.status) ? right.status : left.status;
  return {
    runId: right.runId ?? left.runId,
    status: incomingStatus,
    acceptedAtMs: right.acceptedAtMs ?? left.acceptedAtMs,
    startedAtMs: right.startedAtMs ?? left.startedAtMs,
    completedAtMs: right.completedAtMs ?? left.completedAtMs,
    lastActivityAtMs: right.lastActivityAtMs ?? left.lastActivityAtMs,
    activityAtMs: uniqueSorted([
      ...left.activityAtMs,
      ...right.activityAtMs,
      ...(right.lastActivityAtMs === null ? [] : [right.lastActivityAtMs])
    ]),
    provider: right.provider ?? left.provider,
    model: right.model ?? left.model,
    cancelReason: right.cancelReason ?? left.cancelReason,
    claimAttempts:
      left.claimAttempts === null
        ? right.claimAttempts
        : right.claimAttempts === null
          ? left.claimAttempts
          : Math.max(left.claimAttempts, right.claimAttempts),
    applicationStatusCode:
      right.applicationStatusCode ?? left.applicationStatusCode,
    sources: [...new Set([...left.sources, ...right.sources])]
  };
}

function candidateFromRecord(
  record: Record<string, unknown>,
  source: string,
  parentKey: string | null,
  inheritedRunId: string | null
): RunEvidence | null {
  const available = fields(record);
  const explicitRunId = runIdentifier(
    stringField(available, "runId", "run_id")
  );
  const nestedRunId =
    parentKey && ["run", "job", "execution"].includes(normalizedKey(parentKey))
      ? runIdentifier(stringField(available, "id"))
      : null;
  const runId = explicitRunId ?? nestedRunId ?? inheritedRunId;
  const provider = stringField(
    available,
    "provider",
    "providerName",
    "billingProvider",
    "billing_provider"
  );
  const model = stringField(available, "model", "modelId", "model_id");
  const cancelReason = stringField(
    available,
    "cancelReason",
    "cancel_reason"
  );
  const claimAttempts = integerField(
    available,
    "claimAttempts",
    "claim_attempts"
  );
  let applicationStatusCode = stringField(
    available,
    "applicationStatusCode",
    "application_status_code",
    "appStatusCode"
  );
  const genericCode = stringField(available, "code");
  if (!applicationStatusCode && genericCode?.toUpperCase().startsWith("CSAPI_")) {
    applicationStatusCode = genericCode;
  }

  const acceptedAtMs = timestampField(
    available,
    "acceptedAt",
    "queuedAt",
    "createdAt"
  );
  const startedAtMs = timestampField(available, "startedAt", "startTime");
  const completedAtMs = timestampField(
    available,
    "completedAt",
    "finishedAt",
    "endedAt",
    "endTime"
  );
  const lastActivityAtMs = timestampField(
    available,
    "lastActivityAt",
    "activityAt",
    "progressAt",
    "lastSeen"
  );
  const eventName = stringField(available, "event", "type", "kind");
  const rawStatus = available.get("status") ?? available.get("state");
  const status =
    normalizeStatus(rawStatus) === "unknown"
      ? eventStatus(eventName)
      : normalizeStatus(rawStatus);

  const eventAt = timestampField(
    available,
    "timestamp",
    "time",
    "at",
    "occurredAt"
  );
  const eventLooksActive =
    eventName !== null &&
    /(activity|heartbeat|lease|progress|working|thinking|tool|responding|started)/iu.test(
      eventName
    );
  const activityAtMs = [
    ...(lastActivityAtMs === null ? [] : [lastActivityAtMs]),
    ...(eventLooksActive && eventAt !== null ? [eventAt] : [])
  ];

  const hasMetadata =
    runId !== null ||
    provider !== null ||
    model !== null ||
    cancelReason !== null ||
    claimAttempts !== null ||
    applicationStatusCode !== null ||
    status !== "unknown" ||
    acceptedAtMs !== null ||
    startedAtMs !== null ||
    completedAtMs !== null ||
    activityAtMs.length > 0;
  if (!hasMetadata) return null;
  return {
    runId,
    status,
    acceptedAtMs,
    startedAtMs,
    completedAtMs,
    lastActivityAtMs,
    activityAtMs,
    provider,
    model,
    cancelReason,
    claimAttempts,
    applicationStatusCode,
    sources: [source]
  };
}

export function extractEvidence(value: unknown, source: string): RunEvidence[] {
  const collected = new Map<string, RunEvidence>();

  const visit = (
    current: unknown,
    parentKey: string | null,
    inheritedRunId: string | null,
    depth: number
  ): void => {
    if (depth > 12 || current === null || typeof current !== "object") return;
    if (Array.isArray(current)) {
      for (const item of current) visit(item, parentKey, inheritedRunId, depth + 1);
      return;
    }

    const record = current as Record<string, unknown>;
    const candidate = candidateFromRecord(
      record,
      source,
      parentKey,
      inheritedRunId
    );
    const nextRunId = candidate?.runId ?? inheritedRunId;
    if (candidate) {
      const key = candidate.runId ?? "__unscoped__";
      collected.set(
        key,
        collected.has(key)
          ? mergeEvidence(collected.get(key)!, candidate)
          : candidate
      );
    }

    for (const [key, child] of Object.entries(record)) {
      if (skippedPayloadKeys.has(normalizedKey(key))) continue;
      visit(child, key, nextRunId, depth + 1);
    }
  };

  visit(value, null, null, 0);
  return [...collected.values()];
}

function firstHeader(headers: Headers, names: string[]): string | null {
  for (const name of names) {
    const found = headers.get(name);
    if (found?.trim()) return found.trim();
  }
  return null;
}

export function evidenceFromHeaders(headers: Headers): RunEvidence {
  const rawStatus = firstHeader(headers, [
    "x-csapi-run-status",
    "x-run-status"
  ]);
  const lastActivityAtMs = parseTimestamp(
    firstHeader(headers, ["x-csapi-last-activity-at", "x-last-activity-at"])
  );
  return {
    runId: runIdentifier(
      firstHeader(headers, ["x-csapi-run-id", "x-run-id"])
    ),
    status: normalizeStatus(rawStatus),
    acceptedAtMs: parseTimestamp(
      firstHeader(headers, [
        "x-csapi-accepted-at",
        "x-csapi-queued-at",
        "x-accepted-at"
      ])
    ),
    startedAtMs: parseTimestamp(
      firstHeader(headers, ["x-csapi-started-at", "x-started-at"])
    ),
    completedAtMs: parseTimestamp(
      firstHeader(headers, [
        "x-csapi-completed-at",
        "x-csapi-finished-at",
        "x-completed-at"
      ])
    ),
    lastActivityAtMs,
    activityAtMs: lastActivityAtMs === null ? [] : [lastActivityAtMs],
    provider: firstHeader(headers, [
      "x-csapi-provider",
      "x-provider",
      "x-billing-provider"
    ]),
    model: firstHeader(headers, ["x-csapi-model", "x-model"]),
    cancelReason: firstHeader(headers, [
      "x-csapi-cancel-reason",
      "x-cancel-reason"
    ]),
    claimAttempts: nonNegativeInteger(
      firstHeader(headers, [
        "x-csapi-claim-attempts",
        "x-claim-attempts"
      ])
    ),
    applicationStatusCode: firstHeader(headers, [
      "x-csapi-application-status-code",
      "x-application-status-code"
    ]),
    sources: ["response-header"]
  };
}

export function canonicalProvider(value: string): string {
  return value.trim().toLowerCase().replaceAll(/[_\s]+/gu, "-");
}

export function canonicalModel(value: string): string {
  return value.trim().toLowerCase();
}

export function assertExpectedRouting(
  evidence: RunEvidence,
  expectedProvider: string,
  expectedModel: string
): void {
  const provider = evidence.provider;
  const model = evidence.model;
  if (
    (provider !== null &&
      canonicalProvider(provider) !== canonicalProvider(expectedProvider)) ||
    (model !== null && canonicalModel(model) !== canonicalModel(expectedModel))
  ) {
    throw new ProviderDriftError(
      provider,
      model,
      expectedProvider,
      expectedModel
    );
  }
}

export function mergeEvidenceList(evidence: RunEvidence[]): RunEvidence {
  return evidence.reduce(
    (merged, item) => mergeEvidence(merged, item),
    emptyRunEvidence("aggregate")
  );
}

export function peakConcurrency(runs: RunEvidence[]): number {
  const points: Array<{ at: number; delta: -1 | 1 }> = [];
  for (const run of runs) {
    if (run.startedAtMs === null || run.completedAtMs === null) continue;
    if (run.completedAtMs < run.startedAtMs) continue;
    points.push({ at: run.startedAtMs, delta: 1 });
    points.push({ at: run.completedAtMs, delta: -1 });
  }
  points.sort((left, right) => left.at - right.at || left.delta - right.delta);
  let active = 0;
  let peak = 0;
  for (const point of points) {
    active += point.delta;
    peak = Math.max(peak, active);
  }
  return peak;
}

export function probeKeyHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function toIso(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}
