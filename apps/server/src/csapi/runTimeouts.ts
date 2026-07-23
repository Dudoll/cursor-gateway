import type { RunStatus } from "@cursor-gateway/shared";

export const CSAPI_DEFAULT_QUEUE_TIMEOUT_MS = 30_000;
export const CSAPI_DEFAULT_IDLE_TIMEOUT_MS = 120_000;
export const CSAPI_DEFAULT_ABSOLUTE_TIMEOUT_MS = 29 * 60_000;
export const CSAPI_CALLER_WAIT_SAFETY_BUFFER_MS = 30_000;
export const CSAPI_DEFAULT_CALLER_WAIT_TIMEOUT_MS =
  CSAPI_DEFAULT_QUEUE_TIMEOUT_MS +
  CSAPI_DEFAULT_ABSOLUTE_TIMEOUT_MS +
  CSAPI_CALLER_WAIT_SAFETY_BUFFER_MS;

export type CsapiTimeoutCancelReason =
  | "queue_timeout"
  | "idle_timeout"
  | "absolute_timeout";

export type CsapiCancelReason =
  | CsapiTimeoutCancelReason
  | "caller_cancelled"
  | "client_aborted"
  | "runner_cancelled";

export interface CsapiRunTimeouts {
  queueTimeoutMs: number;
  idleTimeoutMs: number;
  absoluteTimeoutMs: number;
}

export interface CsapiRunTiming {
  status: RunStatus;
  queuedAt: string;
  startedAt: string | null;
  lastActivityAt: string | null;
}

export function minimumCsapiCallerWaitTimeoutMs(
  timeouts: Pick<CsapiRunTimeouts, "queueTimeoutMs" | "absoluteTimeoutMs">
): number {
  return (
    timeouts.queueTimeoutMs +
    timeouts.absoluteTimeoutMs +
    CSAPI_CALLER_WAIT_SAFETY_BUFFER_MS
  );
}

/**
 * A synchronous CSAPI caller is also the lifecycle watchdog. Its wait budget
 * must cover the maximum queue stint plus the run's absolute lifetime so it
 * cannot detach before returning the real terminal result. Explicitly shorter
 * legacy values are raised to this finite floor; queue/idle/absolute guards
 * still bound the run itself.
 */
export function resolveCsapiCallerWaitTimeoutMs(input: {
  requestedMs: number | undefined;
  queueTimeoutMs: number;
  absoluteTimeoutMs: number;
}): number {
  return Math.max(
    input.requestedMs ?? 0,
    minimumCsapiCallerWaitTimeoutMs(input)
  );
}

export interface CsapiTimeoutDecision {
  reason: CsapiTimeoutCancelReason;
  applicationStatusCode:
    | "CSAPI_QUEUE_TIMEOUT"
    | "CSAPI_IDLE_TIMEOUT"
    | "CSAPI_ABSOLUTE_TIMEOUT";
  message: string;
}

const decisions: Record<CsapiTimeoutCancelReason, CsapiTimeoutDecision> = {
  queue_timeout: {
    reason: "queue_timeout",
    applicationStatusCode: "CSAPI_QUEUE_TIMEOUT",
    message: "run queue timeout"
  },
  idle_timeout: {
    reason: "idle_timeout",
    applicationStatusCode: "CSAPI_IDLE_TIMEOUT",
    message: "run idle timeout"
  },
  absolute_timeout: {
    reason: "absolute_timeout",
    applicationStatusCode: "CSAPI_ABSOLUTE_TIMEOUT",
    message: "run execution deadline exceeded"
  }
};

function epoch(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function isCsapiTimeoutCancelReason(
  reason: string | null | undefined
): reason is CsapiTimeoutCancelReason {
  return (
    reason === "queue_timeout" ||
    reason === "idle_timeout" ||
    reason === "absolute_timeout"
  );
}

export function timeoutDecision(reason: CsapiTimeoutCancelReason): CsapiTimeoutDecision {
  return decisions[reason];
}

/**
 * Evaluate only lifecycle deadlines. A caller's own wait deadline is
 * intentionally separate and must never make a healthy run terminal.
 */
export function evaluateCsapiRunTimeout(
  run: CsapiRunTiming,
  timeouts: CsapiRunTimeouts,
  nowMs = Date.now()
): CsapiTimeoutDecision | undefined {
  const queuedAt = epoch(run.queuedAt);
  const startedAt = epoch(run.startedAt);
  const lastActivityAt = epoch(run.lastActivityAt);

  if (
    startedAt !== undefined &&
    (run.status === "queued" ||
      run.status === "waiting_approval" ||
      run.status === "running") &&
    nowMs - startedAt >= timeouts.absoluteTimeoutMs
  ) {
    return decisions.absolute_timeout;
  }

  if (
    (run.status === "queued" || run.status === "waiting_approval") &&
    queuedAt !== undefined &&
    nowMs - queuedAt >= timeouts.queueTimeoutMs
  ) {
    return decisions.queue_timeout;
  }

  if (run.status !== "running" || startedAt === undefined) return undefined;

  const activityAt = lastActivityAt ?? startedAt;
  if (nowMs - activityAt >= timeouts.idleTimeoutMs) {
    return decisions.idle_timeout;
  }

  return undefined;
}

export type CsapiProvider = "cursor-gateway" | "hermes";

/**
 * Provider evidence describes the selected CSAPI route, not the runner's
 * operating system. A hermes:* rewrite is intentionally visible as drift.
 */
export function providerForModel(model: string): CsapiProvider {
  return model.startsWith("hermes:") ? "hermes" : "cursor-gateway";
}

export function isTerminalRunStatus(status: RunStatus): boolean {
  return (
    status === "finished" ||
    status === "error" ||
    status === "cancelled"
  );
}

export function applicationStatusCodeForRun(
  status: RunStatus,
  cancelReason: string | null
): string | null {
  if (status === "finished") return "CSAPI_COMPLETED";
  if (status === "error") return "CSAPI_RUN_ERROR";
  if (status !== "cancelled") return null;
  if (isCsapiTimeoutCancelReason(cancelReason)) {
    return timeoutDecision(cancelReason).applicationStatusCode;
  }
  return "CSAPI_RUN_CANCELLED";
}
