// Loopback Anthropic/OpenAI facade. Standard CLIs point their base URL here with
// a local loopback key; the Adapter re-encodes each call over cg-mitm/1 and
// replays the decrypted response as standard non-stream JSON or SSE. On ANY
// failure it returns a local error — it NEVER falls back to plaintext csapi.
import { timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { CgWire } from "@cursor-gateway/shared";
import type { AdapterConfig } from "./config.js";
import { AdapterError, type SecureClient, type StreamFrame } from "./secureClient.js";

function extractApiKey(headers: Record<string, unknown>): string | undefined {
  const header = (name: string): string | undefined => {
    const value = headers[name];
    if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : undefined;
    return typeof value === "string" ? value : undefined;
  };
  const xApiKey = header("x-api-key");
  if (xApiKey && xApiKey.trim()) return xApiKey.trim();
  const auth = header("authorization");
  if (auth) {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match && match[1]) return match[1].trim();
  }
  return undefined;
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

function resolveSessionKey(headers: Record<string, unknown>, body: Record<string, unknown>): string | null {
  const headerVal = headers["x-session-id"];
  const headerSession = Array.isArray(headerVal) ? headerVal[0] : headerVal;
  if (typeof headerSession === "string" && headerSession.trim()) return headerSession.trim();
  for (const c of [body.session_id, body.conversation_id]) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  return null;
}

function anthropicError(type: string, message: string): Record<string, unknown> {
  return { type: "error", error: { type, message } };
}

function openaiError(message: string, type: string): Record<string, unknown> {
  return { error: { message, type, code: null, param: null } };
}

function errorShape(wire: CgWire, reason: string): Record<string, unknown> {
  return wire === "anthropic" ? anthropicError("api_error", reason) : openaiError(reason, "api_error");
}

function statusOf(error: unknown): number {
  return error instanceof AdapterError ? error.status : 502;
}
function reasonOf(error: unknown): string {
  if (error instanceof AdapterError) return error.reason;
  return error instanceof Error ? error.message : "adapter_error";
}

function sse(reply: FastifyReply, event: string | undefined, data: unknown): void {
  const dataStr = typeof data === "string" ? data : JSON.stringify(data);
  const prefix = event ? `event: ${event}\n` : "";
  reply.raw.write(`${prefix}data: ${dataStr}\n\n`);
}

// --- standard SSE replay from decrypted cg frames --------------------------
function replayFrames(reply: FastifyReply, wire: CgWire, frame: StreamFrame, memo: ReplayMemo): void {
  if (wire === "anthropic") replayAnthropic(reply, frame, memo);
  else replayOpenAi(reply, frame, memo);
}

interface ReplayMemo {
  id: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

function replayAnthropic(reply: FastifyReply, frame: StreamFrame, memo: ReplayMemo): void {
  switch (frame.frameType) {
    case "open": {
      memo.id = String(frame.data.id ?? memo.id);
      memo.model = String(frame.data.model ?? memo.model);
      memo.inputTokens = Number(frame.data.inputTokens ?? 0);
      sse(reply, "message_start", {
        type: "message_start",
        message: {
          id: memo.id,
          type: "message",
          role: "assistant",
          model: memo.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: memo.inputTokens, output_tokens: 0 }
        }
      });
      sse(reply, "content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" }
      });
      sse(reply, "ping", { type: "ping" });
      break;
    }
    case "delta":
      sse(reply, "content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: String(frame.data.text ?? "") }
      });
      break;
    case "usage":
      memo.outputTokens = Number(frame.data.outputTokens ?? memo.outputTokens);
      break;
    case "done":
      sse(reply, "content_block_stop", { type: "content_block_stop", index: 0 });
      sse(reply, "message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: memo.outputTokens }
      });
      sse(reply, "message_stop", { type: "message_stop" });
      break;
    case "error":
      sse(reply, "error", anthropicError("api_error", String(frame.data.errorKind ?? "upstream_error")));
      break;
  }
}

function replayOpenAi(reply: FastifyReply, frame: StreamFrame, memo: ReplayMemo): void {
  const base = () => ({
    id: memo.id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: memo.model
  });
  switch (frame.frameType) {
    case "open":
      memo.id = String(frame.data.id ?? memo.id);
      memo.model = String(frame.data.model ?? memo.model);
      sse(reply, undefined, {
        ...base(),
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }]
      });
      break;
    case "delta":
      sse(reply, undefined, {
        ...base(),
        choices: [{ index: 0, delta: { content: String(frame.data.text ?? "") }, finish_reason: null }]
      });
      break;
    case "usage":
      break;
    case "done":
      sse(reply, undefined, {
        ...base(),
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
      });
      sse(reply, undefined, "[DONE]");
      break;
    case "error":
      sse(reply, undefined, openaiError(String(frame.data.errorKind ?? "upstream_error"), "api_error"));
      break;
  }
}

export function createFacade(cfg: AdapterConfig, client: SecureClient): FastifyInstance {
  const app = Fastify({ bodyLimit: 3 * 1024 * 1024 });

  const authed = (req: FastifyRequest): boolean =>
    timingSafeEqualStr(extractApiKey(req.headers as Record<string, unknown>) ?? "", cfg.loopbackKey);

  const handle = async (req: FastifyRequest, reply: FastifyReply, wire: CgWire) => {
    if (!authed(req)) {
      return reply.code(401).send(errorShape(wire, "invalid local adapter key"));
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const stream = body.stream === true;
    const idempotencyKey = crypto.randomUUID();
    const sessionKey = resolveSessionKey(req.headers as Record<string, unknown>, body);

    if (!stream) {
      try {
        const respBody = await client.exchange({ wire, body, sessionKey, idempotencyKey });
        return reply.send(respBody);
      } catch (error) {
        return reply.code(statusOf(error)).send(errorShape(wire, reasonOf(error)));
      }
    }

    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });
    reply.hijack();
    const abort = new AbortController();
    reply.raw.on("close", () => {
      if (!reply.raw.writableFinished) {
        abort.abort();
        void client.cancel(idempotencyKey);
      }
    });
    const memo: ReplayMemo = { id: `msg_${idempotencyKey.replace(/-/g, "")}`, model: "auto", inputTokens: 0, outputTokens: 0 };
    try {
      for await (const frame of client.exchangeStream({
        wire,
        body,
        sessionKey,
        idempotencyKey,
        signal: abort.signal
      })) {
        replayFrames(reply, wire, frame, memo);
      }
    } catch (error) {
      if (!abort.signal.aborted) {
        if (wire === "anthropic") sse(reply, "error", anthropicError("api_error", reasonOf(error)));
        else sse(reply, undefined, openaiError(reasonOf(error), "api_error"));
      }
    } finally {
      reply.raw.end();
    }
    return reply;
  };

  app.post("/v1/messages", (req, reply) => handle(req, reply, "anthropic"));
  app.post("/v1/chat/completions", (req, reply) => handle(req, reply, "openai"));
  app.get("/v1/models", (req, reply) => {
    if (!authed(req)) return reply.code(401).send(openaiError("invalid local adapter key", "api_error"));
    // The Adapter does not proxy model discovery over the ciphertext channel;
    // advertise "auto" so CLIs that require a models list keep working.
    const created = Math.floor(Date.now() / 1000);
    return reply.send({
      object: "list",
      data: [{ id: "auto", object: "model", name: "auto", created, owned_by: "cg-mitm" }]
    });
  });
  app.get("/health", (_req, reply) =>
    reply.send({ ok: true, mode: "cg-mitm/1", upstream: cfg.upstreamUrl, deviceId: client.deviceId })
  );

  return app;
}
