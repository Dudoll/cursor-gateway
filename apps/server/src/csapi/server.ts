// csapi compatibility facade route registration (方案 B, plaintext-visible).
//
// Exposes Anthropic Messages + OpenAI Chat Completions compatible endpoints so
// standard CLIs (OpenCode / Claude Code) work with just "API key + base URL".
// This is NOT end-to-end encryption: prompts are plaintext to csapi, the
// gateway queue, the runner and the model. See docs/csapi.md.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { CsapiBackend } from "./backend.js";
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
  buildAnthropicResponse,
  buildAnthropicStreamFrames,
  buildModelsResponse,
  buildOpenAiResponse,
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
  type SseFrame
} from "./protocol.js";

export interface CsapiConfig {
  enabled: boolean;
  apiKeys: Set<string>;
  defaultModel: string;
  defaultWorkspaceId: string;
  maxConcurrencyPerKey: number;
  runTimeoutMs: number;
  allowWrites: boolean;
}

export interface CsapiDeps {
  backend: CsapiBackend;
  config: CsapiConfig;
  /** Poll interval when waiting for a run to finish (ms). */
  pollIntervalMs?: number;
}

class CsapiError extends Error {
  constructor(
    readonly status: number,
    readonly kind: string,
    message: string
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

interface CompletedRun {
  text: string;
  inputTokens: number;
  outputTokens: number;
  runId: string;
  conversationId: string;
}

interface ExecuteInput {
  keyId: string;
  system: string;
  messages: ReturnType<typeof normalizeMessages>;
  requestedModel: string;
  sessionKey: string | null;
  signal?: AbortSignal;
}

export function createCsapi(deps: CsapiDeps) {
  const { backend, config } = deps;
  const pollIntervalMs = deps.pollIntervalMs ?? 400;
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
    const conversationId = await backend.createConversation({
      principalId: input.principalId,
      workspaceId: input.workspaceId,
      title: input.title
    });
    sessionConversations.set(mapKey, conversationId);
    return { conversationId, mode: "session-first" };
  }

  async function waitForRun(runId: string, principalId: string, signal?: AbortSignal): Promise<CompletedRun> {
    const deadline = Date.now() + config.runTimeoutMs;
    try {
      for (;;) {
        if (signal?.aborted) throw new AbortedError();
        const snapshot = await backend.getRun(runId, principalId);
        if (!snapshot) {
          throw new CsapiError(502, "api_error", "run disappeared");
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
          throw new CsapiError(502, "api_error", snapshot.error ?? `run ${snapshot.status}`);
        }
        if (Date.now() > deadline) {
          await backend.cancelRun(runId, principalId).catch(() => undefined);
          throw new CsapiError(504, "api_error", "run timed out");
        }
        await sleep(pollIntervalMs, signal);
      }
    } catch (error) {
      // On client abort (top-of-loop check or an interrupted sleep), best-effort
      // cancel the run so it does not linger queued after the caller left.
      if (error instanceof AbortedError) {
        await backend.cancelRun(runId, principalId).catch(() => undefined);
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
  async function execute(input: ExecuteInput): Promise<CompletedRun> {
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
      const prompt = buildPrompt({ system: input.system, messages: input.messages, mode });
      if (!prompt) {
        throw new CsapiError(400, "invalid_request_error", "empty prompt after rendering");
      }
      const handle = await backend.createRun({
        principalId,
        conversationId,
        model,
        workspaceId,
        prompt,
        allowWrites: config.allowWrites
      });
      const completed = await waitForRun(handle.runId, principalId, input.signal);
      completed.conversationId = conversationId;
      return completed;
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

  function writeHeartbeat(reply: FastifyReply): void {
    reply.raw.write(": keepalive\n\n");
  }

  /** Run `execute` while emitting SSE heartbeats to keep the connection warm. */
  async function executeWithHeartbeat(
    reply: FastifyReply,
    input: ExecuteInput
  ): Promise<CompletedRun> {
    const heartbeat = setInterval(() => writeHeartbeat(reply), 10_000);
    try {
      return await execute(input);
    } finally {
      clearInterval(heartbeat);
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
      try {
        keyId = authenticate(request);
        acquireOrThrow(keyId);
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
        const result = await executeWithHeartbeat(reply, input);
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
          const { kind, message } = normalizeError(error);
          writeFrame(reply, { event: "error", data: anthropicError(kind, message) });
        }
        reply.raw.end();
      } finally {
        limiter.release(keyId);
      }
      return reply;
    },

    async handleOpenAiChatCompletions(request: FastifyRequest, reply: FastifyReply) {
      let keyId: string | undefined;
      try {
        keyId = authenticate(request);
        acquireOrThrow(keyId);
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
        const result = await executeWithHeartbeat(reply, input);
        const frames = buildOpenAiStreamFrames({
          id: openaiCompletionId(),
          model: responseModel,
          text: result.text
        });
        for (const frame of frames) writeFrame(reply, frame);
        writeFrame(reply, OPENAI_STREAM_DONE);
        reply.raw.end();
      } catch (error) {
        if (!(error instanceof AbortedError)) {
          const { message, kind } = normalizeError(error);
          writeFrame(reply, { data: openaiError(message, kind) });
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

    async handleHealth(_request: FastifyRequest, reply: FastifyReply) {
      return reply.send({
        ok: true,
        service: "csapi",
        mode: "plaintext-compat-b",
        e2ee: false,
        runnersOnline: backend.runnersOnline(),
        models: ["auto", ...backend.listModelIds()]
      });
    }
  };

  function normalizeError(error: unknown): { status: number; kind: string; message: string } {
    if (error instanceof CsapiError) {
      return { status: error.status, kind: error.kind, message: error.message };
    }
    return { status: 500, kind: "api_error", message: "internal error" };
  }

  function sendAnthropicError(reply: FastifyReply, error: unknown) {
    const { status, kind, message } = normalizeError(error);
    return reply.code(status).send(anthropicError(kind, message));
  }

  function sendOpenAiError(reply: FastifyReply, error: unknown) {
    const { status, kind, message } = normalizeError(error);
    if (status === 429) reply.header("retry-after", "1");
    return reply.code(status).send(openaiError(message, kind));
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
  app.get("/health", (request, reply) => csapi.handleHealth(request, reply));

  return csapi;
}

/** Path predicate used by index.ts to exempt csapi routes from Access auth. */
export function isCsapiPath(url: string | undefined): boolean {
  if (!url) return false;
  const path = url.split("?")[0];
  return (
    path === "/health" ||
    path === "/v1/models" ||
    path === "/v1/messages" ||
    path === "/v1/chat/completions" ||
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
