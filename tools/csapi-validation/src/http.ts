import {
  assertExpectedRouting,
  evidenceFromHeaders,
  extractEvidence,
  mergeEvidence,
  mergeEvidenceList,
  probeKeyHash
} from "./evidence.js";
import {
  ProviderDriftError,
  emptyRunEvidence,
  type AttemptDisposition,
  type AttemptResult,
  type AuthMaterial,
  type Clock,
  type EvidenceObserver,
  type ObserverConfig,
  type ProbeClient,
  type ProbeSpec,
  type RunEvidence,
  type ValidationConfig
} from "./types.js";

const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_SSE_LINE_BYTES = 1024 * 1024;

function authValue(auth: AuthMaterial): string {
  return auth.scheme ? `${auth.scheme} ${auth.secret}` : auth.secret;
}

function abortSignals(
  timeoutMs: number,
  parent: AbortSignal | undefined
): { signal: AbortSignal; cancel(): void; timedOut(): boolean } {
  const controller = new AbortController();
  let didTimeOut = false;
  const timer = setTimeout(() => {
    didTimeOut = true;
    controller.abort();
  }, timeoutMs);
  const onParentAbort = () => controller.abort();
  parent?.addEventListener("abort", onParentAbort, { once: true });
  return {
    signal: controller.signal,
    cancel() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParentAbort);
    },
    timedOut() {
      return didTimeOut;
    }
  };
}

async function readJsonLimited(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  let size = 0;
  let body = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_JSON_BYTES) throw new Error("RESPONSE_TOO_LARGE");
    body += decoder.decode(value, { stream: true });
  }
  body += decoder.decode();
  if (!body.trim()) return null;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error("INVALID_JSON");
  }
}

interface ParsedBody {
  evidence: RunEvidence;
  heartbeatCount: number;
  sawDone: boolean;
  multipleRunIds: boolean;
}

function evidenceAccumulator(
  expectedProvider: string,
  expectedModel: string
): {
  add(value: unknown, source: string): void;
  result(): { evidence: RunEvidence; multipleRunIds: boolean };
} {
  let merged = emptyRunEvidence("response");
  const runIds = new Set<string>();
  return {
    add(value, source) {
      const extracted = extractEvidence(value, source);
      for (const item of extracted) {
        assertExpectedRouting(item, expectedProvider, expectedModel);
        if (item.runId) runIds.add(item.runId);
        merged = mergeEvidence(merged, item);
      }
    },
    result() {
      return { evidence: merged, multipleRunIds: runIds.size > 1 };
    }
  };
}

async function parseSse(
  response: Response,
  expectedProvider: string,
  expectedModel: string
): Promise<ParsedBody> {
  const accumulator = evidenceAccumulator(expectedProvider, expectedModel);
  const reader = response.body?.getReader();
  if (!reader) {
    const result = accumulator.result();
    return { ...result, heartbeatCount: 0, sawDone: false };
  }

  const decoder = new TextDecoder();
  let buffered = "";
  let eventName = "";
  let dataLines: string[] = [];
  let heartbeatCount = 0;
  let sawDone = false;

  const flush = () => {
    if (dataLines.length === 0) {
      eventName = "";
      return;
    }
    const data = dataLines.join("\n");
    dataLines = [];
    if (data === "[DONE]") {
      sawDone = true;
      eventName = "";
      return;
    }
    try {
      const parsed = JSON.parse(data) as unknown;
      if (
        eventName === "ping" ||
        (parsed !== null &&
          typeof parsed === "object" &&
          (parsed as Record<string, unknown>).id === "chatcmpl-heartbeat")
      ) {
        heartbeatCount += 1;
      }
      accumulator.add(parsed, eventName ? `sse:${eventName}` : "sse:data");
    } catch {
      // Non-JSON data may be assistant output. It is intentionally discarded.
    }
    eventName = "";
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    if (Buffer.byteLength(buffered) > MAX_SSE_LINE_BYTES) {
      throw new Error("SSE_LINE_TOO_LARGE");
    }
    let newline = buffered.indexOf("\n");
    while (newline >= 0) {
      let line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line) {
        flush();
      } else if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
      newline = buffered.indexOf("\n");
    }
  }
  buffered += decoder.decode();
  if (buffered) {
    if (buffered.startsWith("data:")) dataLines.push(buffered.slice(5).trimStart());
  }
  flush();
  const result = accumulator.result();
  return { ...result, heartbeatCount, sawDone };
}

async function parseResponseBody(
  response: Response,
  expectedProvider: string,
  expectedModel: string
): Promise<ParsedBody> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("text/event-stream")) {
    return parseSse(response, expectedProvider, expectedModel);
  }
  const parsed = await readJsonLimited(response);
  const accumulator = evidenceAccumulator(expectedProvider, expectedModel);
  accumulator.add(parsed, "response-json");
  const result = accumulator.result();
  return {
    ...result,
    heartbeatCount: 0,
    sawDone: response.ok
  };
}

function disposition(
  httpStatus: number,
  applicationStatusCode: string | null,
  sawDone: boolean
): AttemptDisposition {
  if (applicationStatusCode === "CSAPI_CALLER_WAIT_TIMEOUT") return "detached";
  if (httpStatus === 504 && applicationStatusCode === null) return "failed";
  if (httpStatus < 200 || httpStatus >= 300) return "failed";
  if (
    applicationStatusCode &&
    applicationStatusCode !== "CSAPI_OK" &&
    applicationStatusCode !== "CSAPI_COMPLETED"
  ) {
    return "failed";
  }
  return sawDone ? "completed" : "failed";
}

export class RealClock implements Clock {
  now(): number {
    return Date.now();
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("ABORTED"));
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error("ABORTED"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

export class CsapiHttpClient implements ProbeClient {
  constructor(
    private readonly config: ValidationConfig,
    private readonly clock: Clock
  ) {}

  async execute(spec: ProbeSpec, parentSignal?: AbortSignal): Promise<AttemptResult> {
    const requestStartedAtMs = this.clock.now();
    const abort = abortSignals(this.config.requestTimeoutMs, parentSignal);
    try {
      const headers = new Headers({
        accept: "text/event-stream, application/json",
        "content-type": "application/json",
        "idempotency-key": spec.idempotencyKey,
        "x-session-id": spec.sessionId,
        "x-workspace-id": this.config.workspaceId,
        "x-csapi-validation-scenario": spec.scenario,
        "x-csapi-validation-probe": probeKeyHash(spec.idempotencyKey)
      });
      headers.set(this.config.auth.header, authValue(this.config.auth));
      const response = await fetch(this.config.completionUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: this.config.requestedModel,
          stream: true,
          max_tokens: 64,
          messages: [{ role: "user", content: spec.prompt }],
          metadata: {
            workspace_id: this.config.workspaceId,
            validation_scenario: spec.scenario,
            validation_slot: spec.slot
          }
        }),
        signal: abort.signal
      });

      let headerEvidence = evidenceFromHeaders(response.headers);
      assertExpectedRouting(
        headerEvidence,
        this.config.expectedProvider,
        this.config.expectedModel
      );
      const body = await parseResponseBody(
        response,
        this.config.expectedProvider,
        this.config.expectedModel
      );
      headerEvidence = mergeEvidence(headerEvidence, body.evidence);
      const applicationStatusCode =
        headerEvidence.applicationStatusCode ?? body.evidence.applicationStatusCode;
      return {
        disposition: body.multipleRunIds
          ? "failed"
          : disposition(response.status, applicationStatusCode, body.sawDone),
        requestStartedAtMs,
        requestEndedAtMs: this.clock.now(),
        httpStatus: response.status,
        applicationStatusCode,
        failureCode: body.multipleRunIds ? "MULTIPLE_RUN_IDS" : null,
        heartbeatCount: body.heartbeatCount,
        evidence: headerEvidence
      };
    } catch (error) {
      if (error instanceof ProviderDriftError) {
        throw error;
      }
      const parentAborted = parentSignal?.aborted ?? false;
      return {
        disposition: parentAborted
          ? "aborted"
          : abort.timedOut()
            ? "detached"
            : "failed",
        requestStartedAtMs,
        requestEndedAtMs: this.clock.now(),
        httpStatus: null,
        applicationStatusCode: null,
        failureCode: parentAborted
          ? "PEER_ABORTED"
          : abort.timedOut()
            ? "CLIENT_WAIT_TIMEOUT"
            : "NETWORK_OR_PROTOCOL_ERROR",
        heartbeatCount: 0,
        evidence: emptyRunEvidence("transport-error")
      };
    } finally {
      abort.cancel();
    }
  }
}

function templateRequestUrl(
  template: string,
  placeholder: "idempotencyKey" | "runId",
  rawValue: string
): URL {
  const token = `{${placeholder}}`;
  if (template.includes(token)) {
    return new URL(template.replaceAll(token, encodeURIComponent(rawValue)));
  }
  const url = new URL(template);
  url.searchParams.set(placeholder, rawValue);
  return url;
}

export class HttpEvidenceObserver implements EvidenceObserver {
  readonly canLookupByKey: boolean;
  readonly canLookupByRunId: boolean;

  constructor(
    private readonly config: ObserverConfig,
    private readonly expectedProvider: string,
    private readonly expectedModel: string
  ) {
    this.canLookupByKey = config.byKeyUrlTemplate !== null;
    this.canLookupByRunId = config.byRunUrlTemplate !== null;
  }

  lookupByKey(
    idempotencyKey: string,
    signal?: AbortSignal
  ): Promise<RunEvidence[]> {
    if (!this.config.byKeyUrlTemplate) return Promise.resolve([]);
    return this.query(
      templateRequestUrl(
        this.config.byKeyUrlTemplate,
        "idempotencyKey",
        idempotencyKey
      ),
      signal
    );
  }

  lookupByRunId(runId: string, signal?: AbortSignal): Promise<RunEvidence[]> {
    if (!this.config.byRunUrlTemplate) return Promise.resolve([]);
    return this.query(
      templateRequestUrl(this.config.byRunUrlTemplate, "runId", runId),
      signal
    );
  }

  private async query(url: URL, parentSignal?: AbortSignal): Promise<RunEvidence[]> {
    const abort = abortSignals(this.config.requestTimeoutMs, parentSignal);
    try {
      const headers = new Headers({ accept: "application/json" });
      headers.set(this.config.auth.header, authValue(this.config.auth));
      const response = await fetch(url, { headers, signal: abort.signal });
      if (response.status === 404) return [];
      if (!response.ok) throw new Error(`OBSERVER_HTTP_${response.status}`);
      const value = await readJsonLimited(response);
      const evidence = extractEvidence(value, "observer");
      for (const item of evidence) {
        assertExpectedRouting(item, this.expectedProvider, this.expectedModel);
      }
      return evidence;
    } finally {
      abort.cancel();
    }
  }
}

export function mergeAttemptEvidence(attempts: AttemptResult[]): RunEvidence {
  return mergeEvidenceList(attempts.map((attempt) => attempt.evidence));
}
