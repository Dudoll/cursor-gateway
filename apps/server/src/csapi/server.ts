// csapi compatibility facade route registration (方案 B, plaintext-visible).
//
// Exposes Anthropic Messages + OpenAI Chat Completions compatible endpoints so
// standard CLIs (OpenCode / Claude Code) work with just "API key + base URL".
// This is NOT end-to-end encryption: prompts are plaintext to csapi, the
// gateway queue, the runner and the model. See docs/csapi.md.
import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { CsapiBackend, CsapiRunSnapshot } from "./backend.js";
import {
  KeyConcurrencyLimiter,
  SessionSerializer,
  SessionSerializerAbortError
} from "./concurrency.js";
import {
  OPENAI_STREAM_DONE,
  anthropicError,
  anthropicMessageId,
  apiKeyId,
  assertUniqueApiKeyIds,
  buildAnthropicResponse,
  buildAnthropicStreamFrames,
  buildModelsResponse,
  buildOpenAiResponse,
  buildOpenAiProgressFrame,
  buildOpenAiStreamFrames,
  buildPrompt,
  estimateTokens,
  extractApiKey,
  extractSystem,
  lastUserText,
  matchApiKey,
  normalizeMessages,
  openaiCompletionId,
  openaiError,
  resolveSessionKey,
  serializeSse,
  wantsStream,
  type CsapiErrorDetails,
  type SseFrame
} from "./protocol.js";
import {
  evaluateCsapiRunTimeout,
  isCsapiTimeoutCancelReason,
  providerForModel,
  timeoutDecision
} from "./runTimeouts.js";

export interface CsapiConfig {
  enabled: boolean;
  apiKeys: Set<string>;
  defaultModel: string;
  defaultWorkspaceId: string;
  maxConcurrencyPerKey: number;
  callerWaitTimeoutMs: number;
  queueTimeoutMs: number;
  idleTimeoutMs: number;
  absoluteTimeoutMs: number;
  maxPromptChars?: number;
  allowWrites: boolean;
}

export interface CsapiDeps {
  backend: CsapiBackend;
  config: CsapiConfig;
  /** Poll interval when waiting for a run to finish (ms). */
  pollIntervalMs?: number;
  /** SSE heartbeat interval (ms); injectable for deterministic tests. */
  heartbeatIntervalMs?: number;
  /** Injectable monotonic wall clock and sleeper for fake-clock tests. */
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Injectable interval scheduler for deterministic SSE heartbeat tests. */
  scheduleHeartbeat?: (callback: () => void, intervalMs: number) => unknown;
  cancelHeartbeat?: (handle: unknown) => void;
}

class CsapiError extends Error {
  constructor(
    readonly status: number,
    readonly kind: string,
    message: string,
    readonly applicationStatusCode = "CSAPI_ERROR",
    readonly cancelReason?: string,
    readonly provider?: string,
    readonly model?: string
  ) {
    super(message);
    this.name = "CsapiError";
  }
}

class AbortedError extends Error {
  constructor() {
    super("client_aborted");
    this.name = "AbortedError";
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AbortedError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AbortedError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

const RUN_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_IDEMPOTENCY_KEY_CHARS = 512;
const MAX_PROGRESS_EVENT_CHARS = 800;

interface CompletedRun {
  text: string;
  inputTokens: number;
  outputTokens: number;
  runId: string;
  conversationId: string;
}

type CsapiProgressUpdate = {
  kind: NonNullable<CsapiRunSnapshot["progressKind"]>;
  message: string;
};

interface ExecuteInput {
  keyId: string;
  system: string;
  messages: ReturnType<typeof normalizeMessages>;
  requestedModel: string;
  sessionKey: string | null;
  idempotencyKey?: string;
  requestId?: string;
  log?: FastifyRequest["log"];
  signal?: AbortSignal;
}

export function createCsapi(deps: CsapiDeps) {
  const { backend, config } = deps;
  assertUniqueApiKeyIds(config.apiKeys);
  const pollIntervalMs = deps.pollIntervalMs ?? 400;
  const heartbeatIntervalMs = deps.heartbeatIntervalMs ?? 10_000;
  const now = deps.now ?? Date.now;
  const wait = deps.sleep ?? sleep;
  const scheduleHeartbeat =
    deps.scheduleHeartbeat ??
    ((callback: () => void, intervalMs: number) =>
      setInterval(callback, intervalMs));
  const cancelHeartbeat =
    deps.cancelHeartbeat ??
    ((handle: unknown) =>
      clearInterval(handle as ReturnType<typeof setInterval>));
  const serializer = new SessionSerializer();
  const limiter = new KeyConcurrencyLimiter(config.maxConcurrencyPerKey);
  // sessionKey (namespaced by API key) -> conversationId
  const sessionConversations = new Map<string, string>();

  function authenticate(request: FastifyRequest): string {
    const presented = extractApiKey(request.headers as Record<string, unknown>);
    const keyId = matchApiKey(presented, config.apiKeys);
    if (!keyId) {
      throw new CsapiError(401, "authentication_error", "invalid or missing API key");
    }
    return keyId;
  }

  function idempotencyDigest(keyId: string, value: string): string {
    return createHash("sha256")
      .update(keyId)
      .update("\0")
      .update(value)
      .digest("hex");
  }

  function idempotencyKeyFor(request: FastifyRequest, keyId: string): string | undefined {
    const headers = request.headers as Record<string, unknown>;
    const raw = headers["idempotency-key"] ?? headers["x-idempotency-key"];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value !== "string" || !value.trim()) return undefined;
    const normalized = value.trim();
    if (normalized.length > MAX_IDEMPOTENCY_KEY_CHARS) {
      throw new CsapiError(
        400,
        "invalid_request_error",
        "idempotency key is too long",
        "CSAPI_IDEMPOTENCY_KEY_INVALID"
      );
    }
    return idempotencyDigest(keyId, normalized);
  }

  async function resolveConversation(input: {
    keyId: string;
    principalId: string;
    workspaceId: string;
    sessionKey: string | null;
    title: string;
  }): Promise<{ conversationId: string; mode: "stateless" | "session-first" | "session-continued" }> {
    if (!input.sessionKey) {
      const conversationId = await backend.createConversation({
        principalId: input.principalId,
        workspaceId: input.workspaceId,
        title: input.title
      });
      return { conversationId, mode: "stateless" };
    }
    const mapKey = `${input.keyId}:${input.sessionKey}`;
    const remembered = sessionConversations.get(mapKey);
    if (remembered && (await backend.conversationExists(remembered, input.principalId))) {
      return { conversationId: remembered, mode: "session-continued" };
    }
    if (backend.resolveConversation) {
      const resolved = await backend.resolveConversation({
        principalId: input.principalId,
        workspaceId: input.workspaceId,
        sessionKey: mapKey,
        title: input.title
      });
      sessionConversations.set(mapKey, resolved.conversationId);
      return {
        conversationId: resolved.conversationId,
        mode: resolved.created ? "session-first" : "session-continued"
      };
    }
    const conversationId = await backend.createConversation({
      principalId: input.principalId,
      workspaceId: input.workspaceId,
      title: input.title
    });
    sessionConversations.set(mapKey, conversationId);
    return { conversationId, mode: "session-first" };
  }

  function terminalRunError(snapshot: CsapiRunSnapshot): CsapiError {
    const cancelReason = snapshot.cancelReason ?? undefined;
    if (isCsapiTimeoutCancelReason(cancelReason)) {
      const decision = timeoutDecision(cancelReason);
      return new CsapiError(
        504,
        "api_error",
        decision.message,
        decision.applicationStatusCode,
        cancelReason,
        snapshot.provider,
        snapshot.model
      );
    }
    if (snapshot.status === "cancelled") {
      return new CsapiError(
        502,
        "api_error",
        snapshot.error ?? "run cancelled",
        "CSAPI_RUN_CANCELLED",
        cancelReason,
        snapshot.provider,
        snapshot.model
      );
    }
    return new CsapiError(
      502,
      "api_error",
      snapshot.error ?? "run failed",
      "CSAPI_RUN_ERROR",
      undefined,
      snapshot.provider,
      snapshot.model
    );
  }

  async function waitForRun(
    runId: string,
    principalId: string,
    fallbackModel: string,
    signal?: AbortSignal,
    onProgress?: (progress: CsapiProgressUpdate) => void
  ): Promise<CompletedRun> {
    const callerDeadline = now() + config.callerWaitTimeoutMs;
    let lastProgressFingerprint = "";
    try {
      for (;;) {
        if (signal?.aborted) throw new AbortedError();
        const snapshot = await backend.getRun(runId, principalId);
        if (!snapshot) {
          throw new CsapiError(
            502,
            "api_error",
            "run disappeared",
            "CSAPI_RUN_NOT_FOUND",
            undefined,
            providerForModel(fallbackModel),
            fallbackModel
          );
        }
        const progressMessage = snapshot.progress?.trim().slice(0, MAX_PROGRESS_EVENT_CHARS);
        const progressKind = snapshot.progressKind;
        if (
          onProgress &&
          progressMessage &&
          progressKind &&
          progressKind !== "responding"
        ) {
          const fingerprint = `${progressKind}:${progressMessage}`;
          if (fingerprint !== lastProgressFingerprint) {
            lastProgressFingerprint = fingerprint;
            // Progress is observational; a disconnected stream must not turn a
            // successful model run into an API failure.
            try {
              onProgress({ kind: progressKind, message: progressMessage });
            } catch {
              // Ignore stream write failures and keep polling the run.
            }
          }
        }
        if (snapshot.status === "finished") {
          return {
            text: snapshot.response ?? "",
            inputTokens: snapshot.inputTokens ?? 0,
            outputTokens: snapshot.outputTokens ?? 0,
            runId,
            conversationId: ""
          };
        }
        if (snapshot.status === "error" || snapshot.status === "cancelled") {
          throw terminalRunError(snapshot);
        }

        const lifecycleTimeout = evaluateCsapiRunTimeout(
          snapshot,
          {
            queueTimeoutMs: config.queueTimeoutMs,
            idleTimeoutMs: config.idleTimeoutMs,
            absoluteTimeoutMs: config.absoluteTimeoutMs
          },
          now()
        );
        if (lifecycleTimeout) {
          const timeoutMs =
            lifecycleTimeout.reason === "queue_timeout"
              ? config.queueTimeoutMs
              : lifecycleTimeout.reason === "idle_timeout"
                ? config.idleTimeoutMs
                : config.absoluteTimeoutMs;
          const cancelled = await backend.cancelRun(
            runId,
            principalId,
            lifecycleTimeout.reason,
            timeoutMs
          );
          // A result may have committed between the snapshot and conditional
          // cancellation. Re-read on that race instead of returning a false
          // timeout over the real terminal state.
          if (!cancelled) continue;
          throw terminalRunError(cancelled);
        }

        if (now() >= callerDeadline) {
          throw new CsapiError(
            504,
            "api_error",
            "caller wait timeout; run remains active",
            "CSAPI_CALLER_WAIT_TIMEOUT",
            undefined,
            snapshot.provider,
            snapshot.model
          );
        }
        await wait(pollIntervalMs, signal);
      }
    } catch (error) {
      // On client abort (top-of-loop check or an interrupted sleep), best-effort
      // cancel the run so it does not linger queued after the caller left.
      if (error instanceof AbortedError) {
        await backend.cancelRun(runId, principalId, "client_aborted").catch(() => undefined);
      }
      throw error;
    }
  }

  function resolveRoutableModel(requested: string): string {
    const candidate = backend.modelIsKnown(requested) ? requested : config.defaultModel;
    if (candidate !== "auto") return candidate;
    const online = backend.listModelIds();
    const windows = online.filter((id) => !id.startsWith("hermes:"));
    if (windows.length > 0) return "auto";
    const hermesOnline = online.find((id) => id.startsWith("hermes:"));
    if (hermesOnline) return hermesOnline;
    // Heartbeat registry can be empty briefly after a restart while Hermes is
    // already claiming; honour an explicit hermes default so jobs stay claimable.
    if (config.defaultModel.startsWith("hermes:")) return config.defaultModel;
    return "auto";
  }

  /** Core execution: serialize per-session, enqueue a run, wait for completion. */
  async function execute(
    input: ExecuteInput,
    onProgress?: (progress: CsapiProgressUpdate) => void
  ): Promise<CompletedRun> {
    if (!lastUserText(input.messages)) {
      throw new CsapiError(400, "invalid_request_error", "no user message provided");
    }

    const principalId = await backend.getPrincipalId();
    const workspaceId = await backend.pickWorkspaceId(config.defaultWorkspaceId || undefined);
    if (!workspaceId) {
      throw new CsapiError(503, "api_error", "no workspace available (is a runner online?)");
    }
    // "auto" is Windows-runner semantics (claimNextRun: model NOT LIKE hermes:%).
    // When only Hermes is online, rewrite auto → first hermes:* model so jobs
    // are claimable instead of sitting queued until timeout.
    const model = resolveRoutableModel(input.requestedModel);
    const sessionKey = input.sessionKey;

    const perform = async (): Promise<CompletedRun> => {
      const title = lastUserText(input.messages)?.slice(0, 80) ?? "csapi";
      const { conversationId, mode } = await resolveConversation({
        keyId: input.keyId,
        principalId,
        workspaceId,
        sessionKey,
        title
      });
      const prompt = buildPrompt({
        system: input.system,
        messages: input.messages,
        mode,
        maxChars: config.maxPromptChars ?? 96_000
      });
      if (!prompt) {
        throw new CsapiError(400, "invalid_request_error", "empty prompt after rendering");
      }
      const runStartedAt = now();
      const provider = providerForModel(model);
      const handle = await backend.createRun({
        principalId,
        conversationId,
        model,
        workspaceId,
        prompt,
        allowWrites: config.allowWrites,
        keyId: input.keyId,
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {})
      });
      input.log?.info(
        {
          event: "csapi.run.created",
          requestId: input.requestId,
          runId: handle.runId,
          conversationId: handle.conversationId,
          model,
          provider,
          mode,
          initialStatus: handle.status,
          idempotent: Boolean(input.idempotencyKey)
        },
        "csapi run created"
      );
      try {
        const completed = await waitForRun(
          handle.runId,
          principalId,
          model,
          input.signal,
          onProgress
        );
        completed.conversationId = handle.conversationId;
        input.log?.info(
          {
            event: "csapi.run.finished",
            requestId: input.requestId,
            runId: handle.runId,
            provider,
            model,
            durationMs: now() - runStartedAt
          },
          "csapi run finished"
        );
        return completed;
      } catch (error) {
        const normalized = normalizeError(error);
        input.log?.warn(
          {
            event: "csapi.run.failed",
            requestId: input.requestId,
            runId: handle.runId,
            durationMs: now() - runStartedAt,
            errorKind: normalized.kind,
            httpStatusCode: normalized.status,
            applicationStatusCode: normalized.details.applicationStatusCode,
            ...(normalized.details.cancelReason
              ? { cancelReason: normalized.details.cancelReason }
              : {}),
            provider: normalized.details.provider ?? provider,
            model: normalized.details.model ?? model
          },
          "csapi run failed"
        );
        throw error;
      }
    };

    // Same session -> serial; stateless -> unique key so it runs in parallel.
    const serialKey = sessionKey ? `${input.keyId}:${sessionKey}` : `stateless:${cryptoRandom()}`;
    try {
      return await serializer.run(serialKey, perform, input.signal);
    } catch (error) {
      if (error instanceof SessionSerializerAbortError) throw new AbortedError();
      throw error;
    }
  }

  function beginStream(reply: FastifyReply): void {
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });
    reply.hijack();
  }

  function writeFrame(reply: FastifyReply, frame: SseFrame): void {
    reply.raw.write(serializeSse(frame));
  }

  function writeHeartbeat(
    reply: FastifyReply,
    wire: "anthropic" | "openai",
    model: string
  ): void {
    if (wire === "anthropic") {
      writeFrame(reply, { event: "ping", data: { type: "ping" } });
      return;
    }
    writeFrame(reply, {
      data: {
        id: "chatcmpl-heartbeat",
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: {}, finish_reason: null }]
      }
    });
  }

  /**
   * Run `execute` while emitting protocol-valid no-op frames. SSE comments keep
   * the socket open, but OpenAI clients intentionally hide comments from their
   * stream iterator and can still declare the model stream stale.
   */
  async function executeWithHeartbeat(
    reply: FastifyReply,
    input: ExecuteInput,
    wire: "anthropic" | "openai",
    model: string,
    onProgress?: (progress: CsapiProgressUpdate) => void
  ): Promise<CompletedRun> {
    writeHeartbeat(reply, wire, model);
    const heartbeat = scheduleHeartbeat(
      () => writeHeartbeat(reply, wire, model),
      heartbeatIntervalMs
    );
    try {
      return await execute(input, onProgress);
    } finally {
      cancelHeartbeat(heartbeat);
    }
  }

  function acquireOrThrow(keyId: string): void {
    if (!limiter.tryAcquire(keyId)) {
      throw new CsapiError(429, "overloaded_error", "per-key concurrency limit reached");
    }
  }

  function makeAbortSignal(_request: FastifyRequest, reply: FastifyReply): AbortController {
    const controller = new AbortController();
    // Detect a client disconnect via the RESPONSE stream closing before it has
    // finished. Listening on the request stream is wrong: its "close" fires as
    // soon as the request body is fully received, i.e. before we reply.
    reply.raw.on("close", () => {
      if (!reply.raw.writableFinished) controller.abort();
    });
    return controller;
  }

  return {
    serializer,
    limiter,
    execute,
    sessionConversations,

    async handleAnthropicMessages(request: FastifyRequest, reply: FastifyReply) {
      let keyId: string | undefined;
      let idempotencyKey: string | undefined;
      try {
        keyId = authenticate(request);
        acquireOrThrow(keyId);
        idempotencyKey = idempotencyKeyFor(request, keyId);
      } catch (error) {
        if (keyId && error instanceof CsapiError && error.status !== 429) limiter.release(keyId);
        return sendAnthropicError(reply, error);
      }
      const body = (request.body ?? {}) as Record<string, unknown>;
      const stream = wantsStream(body);
      const controller = makeAbortSignal(request, reply);
      const input: ExecuteInput = {
        keyId,
        system: extractSystem(body.system),
        messages: normalizeMessages(body.messages),
        requestedModel: typeof body.model === "string" ? body.model : config.defaultModel,
        sessionKey: resolveSessionKey({ headers: request.headers as Record<string, unknown>, body }),
        ...(idempotencyKey ? { idempotencyKey } : {}),
        requestId: String(request.id),
        log: request.log,
        signal: controller.signal
      };
      const responseModel = typeof body.model === "string" && body.model ? body.model : config.defaultModel;

      if (!stream) {
        try {
          const result = await execute(input);
          const id = anthropicMessageId();
          return reply.send(
            buildAnthropicResponse({
              id,
              model: responseModel,
              text: result.text,
              inputTokens: result.inputTokens || estimateTokens(input.messages.map((m) => m.text).join(" ")),
              outputTokens: result.outputTokens || estimateTokens(result.text)
            })
          );
        } catch (error) {
          return sendAnthropicError(reply, error);
        } finally {
          limiter.release(keyId);
        }
      }

      beginStream(reply);
      try {
        const result = await executeWithHeartbeat(reply, input, "anthropic", responseModel);
        const frames = buildAnthropicStreamFrames({
          id: anthropicMessageId(),
          model: responseModel,
          text: result.text,
          inputTokens: result.inputTokens || estimateTokens(input.messages.map((m) => m.text).join(" ")),
          outputTokens: result.outputTokens || estimateTokens(result.text)
        });
        for (const frame of frames) writeFrame(reply, frame);
        reply.raw.end();
      } catch (error) {
        if (!(error instanceof AbortedError)) {
          const { kind, message, details } = normalizeError(error);
          writeFrame(reply, {
            event: "error",
            data: anthropicError(kind, message, details)
          });
        }
        reply.raw.end();
      } finally {
        limiter.release(keyId);
      }
      return reply;
    },

    async handleOpenAiChatCompletions(request: FastifyRequest, reply: FastifyReply) {
      let keyId: string | undefined;
      let idempotencyKey: string | undefined;
      try {
        keyId = authenticate(request);
        acquireOrThrow(keyId);
        idempotencyKey = idempotencyKeyFor(request, keyId);
      } catch (error) {
        if (keyId && error instanceof CsapiError && error.status !== 429) limiter.release(keyId);
        return sendOpenAiError(reply, error);
      }
      const body = (request.body ?? {}) as Record<string, unknown>;
      const stream = wantsStream(body);
      const controller = makeAbortSignal(request, reply);
      // OpenAI carries system as a message; Anthropic uses a top-level field.
      const input: ExecuteInput = {
        keyId,
        system: "",
        messages: normalizeMessages(body.messages),
        requestedModel: typeof body.model === "string" ? body.model : config.defaultModel,
        sessionKey: resolveSessionKey({ headers: request.headers as Record<string, unknown>, body }),
        ...(idempotencyKey ? { idempotencyKey } : {}),
        requestId: String(request.id),
        log: request.log,
        signal: controller.signal
      };
      const responseModel = typeof body.model === "string" && body.model ? body.model : config.defaultModel;

      if (!stream) {
        try {
          const result = await execute(input);
          return reply.send(
            buildOpenAiResponse({
              id: openaiCompletionId(),
              model: responseModel,
              text: result.text,
              inputTokens: result.inputTokens || estimateTokens(input.messages.map((m) => m.text).join(" ")),
              outputTokens: result.outputTokens || estimateTokens(result.text)
            })
          );
        } catch (error) {
          return sendOpenAiError(reply, error);
        } finally {
          limiter.release(keyId);
        }
      }

      beginStream(reply);
      try {
        const streamId = openaiCompletionId();
        let progressRoleSent = false;
        const onProgress = (progress: CsapiProgressUpdate) => {
          if (reply.raw.writableEnded || reply.raw.destroyed) return;
          writeFrame(
            reply,
            buildOpenAiProgressFrame({
              id: streamId,
              model: responseModel,
              text: progress.message,
              includeRole: !progressRoleSent
            })
          );
          progressRoleSent = true;
        };
        const result = await executeWithHeartbeat(
          reply,
          input,
          "openai",
          responseModel,
          onProgress
        );
        const frames = buildOpenAiStreamFrames({
          id: streamId,
          includeRole: !progressRoleSent,
          model: responseModel,
          text: result.text
        });
        for (const frame of frames) writeFrame(reply, frame);
        writeFrame(reply, OPENAI_STREAM_DONE);
        reply.raw.end();
      } catch (error) {
        if (!(error instanceof AbortedError)) {
          const { message, kind, details } = normalizeError(error);
          writeFrame(reply, {
            data: openaiError(message, kind, undefined, details)
          });
        }
        reply.raw.end();
      } finally {
        limiter.release(keyId);
      }
      return reply;
    },

    async handleModels(request: FastifyRequest, reply: FastifyReply) {
      try {
        authenticate(request);
      } catch (error) {
        return sendOpenAiError(reply, error);
      }
      return reply.send(buildModelsResponse(backend.listModelIds()));
    },

    async handleObserveByIdempotency(
      request: FastifyRequest,
      reply: FastifyReply
    ) {
      try {
        const keyId = authenticate(request);
        const raw = (
          request.params as { idempotencyKey?: unknown } | undefined
        )?.idempotencyKey;
        if (
          typeof raw !== "string" ||
          !raw.trim() ||
          raw.trim().length > MAX_IDEMPOTENCY_KEY_CHARS
        ) {
          throw new CsapiError(
            400,
            "invalid_request_error",
            "invalid idempotency key",
            "CSAPI_IDEMPOTENCY_KEY_INVALID"
          );
        }
        const principalId = await backend.getPrincipalId();
        const runs = await backend.observeByIdempotencyKey(
          idempotencyDigest(keyId, raw.trim()),
          principalId,
          keyId
        );
        return reply
          .header("cache-control", "no-store")
          .send({ runs });
      } catch (error) {
        return sendOpenAiError(reply, error);
      }
    },

    async handleObserveByRunId(
      request: FastifyRequest,
      reply: FastifyReply
    ) {
      try {
        const keyId = authenticate(request);
        const runId = (
          request.params as { runId?: unknown } | undefined
        )?.runId;
        if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId)) {
          throw new CsapiError(
            400,
            "invalid_request_error",
            "invalid run id",
            "CSAPI_RUN_ID_INVALID"
          );
        }
        const principalId = await backend.getPrincipalId();
        const run = await backend.observeByRunId(
          runId,
          principalId,
          keyId
        );
        if (!run) {
          throw new CsapiError(
            404,
            "invalid_request_error",
            "run not found",
            "CSAPI_RUN_NOT_FOUND"
          );
        }
        return reply
          .header("cache-control", "no-store")
          .send({ run });
      } catch (error) {
        return sendOpenAiError(reply, error);
      }
    },

    async handleHealth(_request: FastifyRequest, reply: FastifyReply) {
      const runnersOnline = backend.runnersOnline();
      const capacity = backend.capacitySummary?.() ?? {
        runnerIdentities: runnersOnline,
        totalRunnerSlots: runnersOnline * config.maxConcurrencyPerKey
      };
      return reply.send({
        ok: true,
        service: "csapi",
        mode: "plaintext-compat-b",
        e2ee: false,
        runnersOnline,
        models: ["auto", ...backend.listModelIds()],
        capacity: {
          maxConcurrencyPerKey: config.maxConcurrencyPerKey,
          runnerIdentities: capacity.runnerIdentities,
          totalRunnerSlots: capacity.totalRunnerSlots,
          effectiveTotal: Math.min(
            config.maxConcurrencyPerKey,
            capacity.totalRunnerSlots
          )
        }
      });
    }
  };

  function normalizeError(error: unknown): {
    status: number;
    kind: string;
    message: string;
    details: CsapiErrorDetails;
  } {
    if (error instanceof CsapiError) {
      return {
        status: error.status,
        kind: error.kind,
        message: error.message,
        details: {
          applicationStatusCode: error.applicationStatusCode,
          ...(error.cancelReason ? { cancelReason: error.cancelReason } : {}),
          ...(error.provider ? { provider: error.provider } : {}),
          ...(error.model ? { model: error.model } : {})
        }
      };
    }
    return {
      status: 500,
      kind: "api_error",
      message: "internal error",
      details: { applicationStatusCode: "CSAPI_INTERNAL_ERROR" }
    };
  }

  function sendAnthropicError(reply: FastifyReply, error: unknown) {
    const { status, kind, message, details } = normalizeError(error);
    return reply.code(status).send(anthropicError(kind, message, details));
  }

  function sendOpenAiError(reply: FastifyReply, error: unknown) {
    const { status, kind, message, details } = normalizeError(error);
    if (status === 429) reply.header("retry-after", "1");
    return reply.code(status).send(openaiError(message, kind, undefined, details));
  }
}

function cryptoRandom(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/**
 * Register csapi routes on an existing Fastify instance. Paths live under
 * `/v1/*` plus `/health`, and are exempt from the Cloudflare Access gate in
 * index.ts (they use the csapi API key instead).
 */
export function registerCsapi(app: FastifyInstance, deps: CsapiDeps) {
  const csapi = createCsapi(deps);

  // 429 responses need Retry-After even on the Anthropic path.
  app.post("/v1/messages", async (request, reply) => {
    const result = await csapi.handleAnthropicMessages(request, reply);
    if (reply.statusCode === 429) reply.header("retry-after", "1");
    return result;
  });
  app.post("/v1/chat/completions", (request, reply) => csapi.handleOpenAiChatCompletions(request, reply));
  app.get("/v1/models", (request, reply) => csapi.handleModels(request, reply));
  app.get(
    "/validation/v1/runs/by-idempotency/:idempotencyKey",
    (request, reply) =>
      csapi.handleObserveByIdempotency(request, reply)
  );
  app.get(
    "/validation/v1/runs/:runId",
    (request, reply) => csapi.handleObserveByRunId(request, reply)
  );
  app.get("/health", (request, reply) => csapi.handleHealth(request, reply));

  return csapi;
}

/** Path predicate used by index.ts to exempt csapi routes from Access auth. */
export function isCsapiPath(url: string | undefined): boolean {
  if (!url) return false;
  const path = url.split("?")[0] ?? "";
  return (
    path === "/health" ||
    path === "/v1/models" ||
    path === "/v1/messages" ||
    path === "/v1/chat/completions" ||
    path.startsWith("/validation/v1/runs/by-idempotency/") ||
    path.startsWith("/validation/v1/runs/") ||
    path === "/cg/v1/server-keys" ||
    path === "/cg/v1/enroll" ||
    path === "/cg/v1/enroll/challenge" ||
    path === "/cg/v1/exchange" ||
    path === "/cg/v1/cancel" ||
    path === "/cg/v1/devices/revoke" ||
    path === "/cg/v1/sync" ||
    path === "/cg/v1/sync/stream"
  );
}
