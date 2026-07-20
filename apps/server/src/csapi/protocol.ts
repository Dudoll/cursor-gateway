// Pure helpers for the csapi compatibility facade (方案 B, plaintext-visible).
//
// These functions have no I/O and no Fastify dependency so they can be unit
// tested without a database or a running server. They translate between the
// Anthropic Messages / OpenAI Chat Completions wire formats and the gateway's
// internal plaintext run model.
import { randomUUID, timingSafeEqual } from "node:crypto";

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/**
 * Extract the presented API key from request headers. Anthropic clients send
 * `x-api-key`; OpenAI clients send `Authorization: Bearer <key>`. We accept
 * either on every endpoint for maximum CLI compatibility.
 */
export function extractApiKey(headers: Record<string, unknown>): string | undefined {
  const header = (name: string): string | undefined => {
    const value = headers[name];
    if (Array.isArray(value)) {
      const first = value[0];
      return typeof first === "string" ? first : undefined;
    }
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

/** Constant-time comparison that tolerates differing lengths. */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    // Still run a comparison against a fixed-length buffer to avoid trivially
    // leaking length via early return timing; the result is discarded.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/** Match a presented key against the allowlist. Returns a stable, non-secret id. */
export function matchApiKey(presented: string | undefined, allowed: Iterable<string>): string | undefined {
  if (!presented) return undefined;
  for (const key of allowed) {
    if (key && timingSafeEqualStr(presented, key)) return apiKeyId(key);
  }
  return undefined;
}

/** A short, non-reversible id for a key, safe to log / use as a map key. */
export function apiKeyId(key: string): string {
  // FNV-1a over the key → 8 hex chars. Not for security, only for bucketing.
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `k_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

// ---------------------------------------------------------------------------
// Message extraction
// ---------------------------------------------------------------------------

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface NormalizedMessage {
  role: ChatRole;
  text: string;
}

/** Flatten a message `content` value (string or content-part array) to text. */
export function extractText(content: unknown): string {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (typeof part === "string") {
        parts.push(part);
        continue;
      }
      if (part && typeof part === "object") {
        const p = part as Record<string, unknown>;
        const type = typeof p.type === "string" ? p.type : "";
        if ((type === "text" || type === "input_text" || type === "output_text") && typeof p.text === "string") {
          parts.push(p.text);
        } else if (type === "image" || type === "image_url" || type === "input_image") {
          parts.push("[image omitted]");
        } else if (typeof p.text === "string") {
          parts.push(p.text);
        }
      }
    }
    return parts.join("");
  }
  return "";
}

/** Normalize an Anthropic top-level `system` field to plain text. */
export function extractSystem(system: unknown): string {
  if (!system) return "";
  return extractText(system);
}

/** Normalize an array of chat messages (OpenAI or Anthropic) to {role,text}. */
export function normalizeMessages(messages: unknown): NormalizedMessage[] {
  if (!Array.isArray(messages)) return [];
  const out: NormalizedMessage[] = [];
  for (const raw of messages) {
    if (!raw || typeof raw !== "object") continue;
    const m = raw as Record<string, unknown>;
    const role = (typeof m.role === "string" ? m.role : "user") as ChatRole;
    out.push({ role, text: extractText(m.content) });
  }
  return out;
}

/** Return the text of the last user message, or undefined if none present. */
export function lastUserText(messages: NormalizedMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message && message.role === "user") return message.text;
  }
  return undefined;
}

function roleLabel(role: ChatRole): string {
  switch (role) {
    case "assistant":
      return "Assistant";
    case "system":
      return "System";
    case "tool":
      return "Tool";
    default:
      return "User";
  }
}

/** Render user/assistant/tool turns into a single transcript string. */
export function renderTranscript(messages: NormalizedMessage[]): string {
  return messages
    .filter((m) => m.role !== "system")
    .map((m) => `${roleLabel(m.role)}: ${m.text}`.trim())
    .filter((line) => line.length > 0)
    .join("\n\n");
}

export const PROMPT_TRUNCATION_MARKER = "[Earlier context truncated by CS Gateway]";

function clipMiddle(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  if (maxChars <= PROMPT_TRUNCATION_MARKER.length + 2) return value.slice(-Math.max(0, maxChars));
  const available = maxChars - PROMPT_TRUNCATION_MARKER.length - 2;
  const head = Math.ceil(available / 2);
  const tail = available - head;
  return `${value.slice(0, head)}\n${PROMPT_TRUNCATION_MARKER}\n${value.slice(-tail)}`;
}

function boundedInitialPrompt(system: string, messages: NormalizedMessage[], maxChars: number): string {
  const transcriptParts = messages
    .filter((message) => message.role !== "system")
    .map((message) => `${roleLabel(message.role)}: ${message.text}`.trim())
    .filter(Boolean);
  const full = [system, transcriptParts.join("\n\n")].filter(Boolean).join("\n\n").trim();
  if (full.length <= maxChars) return full;

  const markerBlock = `\n\n${PROMPT_TRUNCATION_MARKER}\n\n`;
  const systemBudget = Math.min(system.length, Math.floor(maxChars * 0.35));
  const clippedSystem = clipMiddle(system, systemBudget);
  let remaining = maxChars - clippedSystem.length - markerBlock.length;
  const recent: string[] = [];

  for (let index = transcriptParts.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const part = transcriptParts[index]!;
    const separatorSize = recent.length > 0 ? 2 : 0;
    if (part.length + separatorSize <= remaining) {
      recent.unshift(part);
      remaining -= part.length + separatorSize;
      continue;
    }
    const available = remaining - separatorSize;
    if (available > 0) recent.unshift(clipMiddle(part, available));
    break;
  }

  return `${clippedSystem}${markerBlock}${recent.join("\n\n")}`.slice(0, maxChars).trim();
}

/**
 * Build the plaintext prompt sent to the gateway run.
 *
 * - `mode: "stateless"` → embed system + the whole transcript (no gateway-side
 *   history is available for a brand new conversation).
 * - `mode: "session-first"` → embed the initial transcript, then let the
 *   gateway maintain history from subsequent turns.
 * - `mode: "session-continued"` → only the latest user message.
 *
 * Initial/stateless prompts are bounded so a long-lived upstream session
 * cannot repeatedly send an unbounded transcript to the local runner.
 */
export function buildPrompt(input: {
  system: string;
  messages: NormalizedMessage[];
  mode: "stateless" | "session-first" | "session-continued";
  maxChars?: number;
}): string {
  const messageSystem = input.messages
    .filter((message) => message.role === "system" && message.text.trim())
    .map((message) => message.text.trim())
    .join("\n\n");
  const system = [input.system.trim(), messageSystem].filter(Boolean).join("\n\n");
  const maxChars = Math.max(1, input.maxChars ?? Number.MAX_SAFE_INTEGER);
  if (input.mode === "stateless" || input.mode === "session-first") {
    return boundedInitialPrompt(system, input.messages, maxChars);
  }

  const last = lastUserText(input.messages) ?? "";
  return clipMiddle(last.trim(), maxChars);
}

/** Resolve a session key from headers/body, or null for stateless requests. */
export function resolveSessionKey(input: {
  headers: Record<string, unknown>;
  body: Record<string, unknown> | undefined;
}): string | null {
  const headerVal = input.headers["x-session-id"];
  const headerSession = Array.isArray(headerVal) ? headerVal[0] : headerVal;
  if (typeof headerSession === "string" && headerSession.trim()) return headerSession.trim();

  const body = input.body ?? {};
  const candidates = [body.session_id, body.conversation_id];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  const metadata = body.metadata;
  if (metadata && typeof metadata === "object") {
    const userId = (metadata as Record<string, unknown>).user_id;
    if (typeof userId === "string" && userId.trim()) return userId.trim();
  }
  return null;
}

/** Determine whether the client requested SSE streaming. */
export function wantsStream(body: Record<string, unknown> | undefined): boolean {
  return Boolean(body && body.stream === true);
}

// ---------------------------------------------------------------------------
// Token estimation (rough; the runner does not report per-request tokens for
// plaintext runs unless it chooses to, so we estimate for usage fields).
// ---------------------------------------------------------------------------

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

// ---------------------------------------------------------------------------
// Streaming chunking
// ---------------------------------------------------------------------------

/** Split text into chunks of at most `size` characters for simulated streaming. */
export function chunkText(text: string, size = 96): string[] {
  if (!text) return [];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Response builders — Anthropic Messages
// ---------------------------------------------------------------------------

export function anthropicMessageId(): string {
  return `msg_${randomUUID().replace(/-/g, "")}`;
}

export function buildAnthropicResponse(input: {
  id: string;
  model: string;
  text: string;
  inputTokens: number;
  outputTokens: number;
}): Record<string, unknown> {
  return {
    id: input.id,
    type: "message",
    role: "assistant",
    model: input.model,
    content: [{ type: "text", text: input.text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: input.inputTokens, output_tokens: input.outputTokens }
  };
}

export interface SseFrame {
  event?: string;
  data: unknown;
}

/** Serialize an SSE frame to the wire format. `data: [DONE]` uses raw string. */
export function serializeSse(frame: SseFrame): string {
  const dataStr = typeof frame.data === "string" ? frame.data : JSON.stringify(frame.data);
  const lines: string[] = [];
  if (frame.event) lines.push(`event: ${frame.event}`);
  lines.push(`data: ${dataStr}`);
  return `${lines.join("\n")}\n\n`;
}

/** Build the full Anthropic SSE frame sequence for a completed response. */
export function buildAnthropicStreamFrames(input: {
  id: string;
  model: string;
  text: string;
  inputTokens: number;
  outputTokens: number;
}): SseFrame[] {
  const frames: SseFrame[] = [];
  frames.push({
    event: "message_start",
    data: {
      type: "message_start",
      message: {
        id: input.id,
        type: "message",
        role: "assistant",
        model: input.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: input.inputTokens, output_tokens: 0 }
      }
    }
  });
  frames.push({
    event: "content_block_start",
    data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }
  });
  frames.push({ event: "ping", data: { type: "ping" } });
  for (const chunk of chunkText(input.text)) {
    frames.push({
      event: "content_block_delta",
      data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: chunk } }
    });
  }
  frames.push({ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } });
  frames.push({
    event: "message_delta",
    data: {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: input.outputTokens }
    }
  });
  frames.push({ event: "message_stop", data: { type: "message_stop" } });
  return frames;
}

/** Anthropic-style error object (also usable as an SSE `error` event payload). */
export function anthropicError(type: string, message: string): Record<string, unknown> {
  return { type: "error", error: { type, message } };
}

// ---------------------------------------------------------------------------
// Response builders — OpenAI Chat Completions
// ---------------------------------------------------------------------------

export function openaiCompletionId(): string {
  return `chatcmpl-${randomUUID().replace(/-/g, "")}`;
}

export function buildOpenAiResponse(input: {
  id: string;
  model: string;
  text: string;
  inputTokens: number;
  outputTokens: number;
  created?: number;
}): Record<string, unknown> {
  const created = input.created ?? Math.floor(Date.now() / 1000);
  return {
    id: input.id,
    object: "chat.completion",
    created,
    model: input.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: input.text },
        finish_reason: "stop"
      }
    ],
    usage: {
      prompt_tokens: input.inputTokens,
      completion_tokens: input.outputTokens,
      total_tokens: input.inputTokens + input.outputTokens
    }
  };
}

/** Build the OpenAI SSE chunk sequence (excluding the trailing `[DONE]`). */
export function buildOpenAiStreamFrames(input: {
  id: string;
  model: string;
  text: string;
  created?: number;
}): SseFrame[] {
  const created = input.created ?? Math.floor(Date.now() / 1000);
  const base = { id: input.id, object: "chat.completion.chunk", created, model: input.model };
  const frames: SseFrame[] = [];
  frames.push({
    data: { ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }
  });
  for (const chunk of chunkText(input.text)) {
    frames.push({
      data: { ...base, choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }] }
    });
  }
  frames.push({
    data: { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }
  });
  return frames;
}

export const OPENAI_STREAM_DONE: SseFrame = { data: "[DONE]" };

/** OpenAI-style error object. */
export function openaiError(message: string, type: string, code?: string): Record<string, unknown> {
  return { error: { message, type, code: code ?? null, param: null } };
}

// ---------------------------------------------------------------------------
// Models listing (OpenAI shape)
// ---------------------------------------------------------------------------

export function buildModelsResponse(modelIds: string[]): Record<string, unknown> {
  const created = Math.floor(Date.now() / 1000);
  const seen = new Set<string>();
  const data: Array<Record<string, unknown>> = [];
  for (const id of ["auto", ...modelIds]) {
    if (seen.has(id)) continue;
    seen.add(id);
    data.push({ id, object: "model", name: id, created, owned_by: "local-runner" });
  }
  return { object: "list", data };
}
