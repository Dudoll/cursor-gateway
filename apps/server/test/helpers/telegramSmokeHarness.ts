/**
 * Deterministic Telegram → Hermes → CSAPI → fake runner harness for CI smoke.
 * No real Bot API, secrets, or production endpoints.
 */
import { createHash, randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from "fastify";
import type { RunStatus } from "@cursor-gateway/shared";
import type { CsapiBackend, CsapiRunHandle, CsapiRunSnapshot } from "../../src/csapi/backend.js";
import { registerCsapi } from "../../src/csapi/server.js";
import {
  providerForModel,
  type CsapiCancelReason
} from "../../src/csapi/runTimeouts.js";

export const SMOKE_API_KEY = "telegram-smoke-csapi-key";
export const TELEGRAM_MESSAGE_LIMIT = 4_096;

export type FakeBotEvent =
  | { kind: "typing"; chatId: string; atMs: number }
  | { kind: "message"; chatId: string; text: string; atMs: number }
  | { kind: "error"; chatId: string; text: string; atMs: number };

/** In-memory Telegram Bot API stand-in. Records outbound visibility only. */
export class FakeTelegramBot {
  readonly events: FakeBotEvent[] = [];
  private clockMs = 0;

  advance(ms: number) {
    this.clockMs += ms;
  }

  now() {
    return this.clockMs;
  }

  async sendChatAction(chatId: string, action: "typing") {
    if (action !== "typing") throw new Error(`unsupported action ${action}`);
    this.events.push({ kind: "typing", chatId, atMs: this.clockMs });
  }

  async sendMessage(chatId: string, text: string) {
    if (text.length > TELEGRAM_MESSAGE_LIMIT) {
      throw new Error(`Telegram message exceeds ${TELEGRAM_MESSAGE_LIMIT} chars`);
    }
    this.events.push({ kind: "message", chatId, text, atMs: this.clockMs });
  }

  async sendUserVisibleError(chatId: string, text: string) {
    this.events.push({ kind: "error", chatId, text, atMs: this.clockMs });
  }

  messagesFor(chatId: string) {
    return this.events.filter(
      (event): event is Extract<FakeBotEvent, { kind: "message" }> =>
        event.kind === "message" && event.chatId === chatId
    );
  }

  typingCount(chatId: string) {
    return this.events.filter((event) => event.kind === "typing" && event.chatId === chatId).length;
  }
}

export class FakeRunnerBackend implements CsapiBackend {
  finishDelayMs = 40;
  unreachable = false;
  busyReject = false;
  private runs = new Map<
    string,
    {
      createdAt: number;
      prompt: string;
      conversationId: string;
      model: string;
      cancelledAt?: number;
      cancelReason?: CsapiCancelReason;
    }
  >();
  private conversations = new Set<string>();
  private idempotencyRuns = new Map<string, string>();
  private sessionConversations = new Map<string, string>();
  createConversationCount = 0;
  createRunCount = 0;
  cancelCount = 0;
  maxSameConversationConcurrent = 0;
  maxDistinctConversationsConcurrent = 0;
  advertisedModels: string[] = ["cursor-fast", "cursor-smart"];
  lastRunModel: string | null = null;
  lastRunPrompt: string | null = null;
  prompts: string[] = [];

  listModelIds() {
    return this.advertisedModels;
  }
  runnersOnline() {
    return this.busyReject || this.unreachable ? 0 : 1;
  }
  modelIsKnown(model: string) {
    return model === "auto" || this.listModelIds().includes(model);
  }
  async pickWorkspaceId(preferred?: string) {
    if (this.unreachable) throw new Error("gateway_unreachable");
    // Mirror “no claimable runner”: CSAPI refuses before createRun.
    if (this.busyReject) return "";
    return preferred || "ws-smoke";
  }
  async getPrincipalId() {
    return "principal-smoke";
  }
  async createConversation() {
    if (this.unreachable) throw new Error("gateway_unreachable");
    const id = randomUUID();
    this.conversations.add(id);
    this.createConversationCount += 1;
    return id;
  }
  async conversationExists(conversationId: string) {
    return this.conversations.has(conversationId);
  }
  async resolveConversation(input: { sessionKey: string }) {
    if (this.unreachable) throw new Error("gateway_unreachable");
    const existing = this.sessionConversations.get(input.sessionKey);
    if (existing) return { conversationId: existing, created: false };
    const conversationId = await this.createConversation();
    this.sessionConversations.set(input.sessionKey, conversationId);
    return { conversationId, created: true };
  }
  async createRun(input: {
    conversationId: string;
    prompt: string;
    model: string;
    idempotencyKey?: string;
  }): Promise<CsapiRunHandle> {
    if (this.unreachable) throw new Error("gateway_unreachable");
    if (this.busyReject) throw new Error("runner_busy");
    if (input.idempotencyKey) {
      const existing = this.idempotencyRuns.get(input.idempotencyKey);
      if (existing) {
        const run = this.runs.get(existing)!;
        return {
          runId: existing,
          conversationId: run.conversationId,
          status: this.statusOf(existing)
        };
      }
    }
    const runId = randomUUID();
    this.runs.set(runId, {
      createdAt: Date.now(),
      prompt: input.prompt,
      conversationId: input.conversationId,
      model: input.model
    });
    this.createRunCount += 1;
    this.lastRunModel = input.model;
    this.lastRunPrompt = input.prompt;
    this.prompts.push(input.prompt);
    if (input.idempotencyKey) this.idempotencyRuns.set(input.idempotencyKey, runId);
    return { runId, conversationId: input.conversationId, status: "queued" as RunStatus };
  }
  private statusOf(runId: string): RunStatus {
    const run = this.runs.get(runId)!;
    if (run.cancelledAt) return "cancelled";
    const elapsed = Date.now() - run.createdAt;
    if (run.prompt.includes("FORCE_ERROR")) return elapsed >= this.finishDelayMs ? "error" : "running";
    return elapsed >= this.finishDelayMs ? "finished" : "running";
  }
  private trackConcurrency() {
    const active: string[] = [];
    for (const [runId, run] of this.runs) {
      const status = this.statusOf(runId);
      if (status === "running" || status === "queued") active.push(run.conversationId);
    }
    const byConv = new Map<string, number>();
    for (const conv of active) byConv.set(conv, (byConv.get(conv) ?? 0) + 1);
    let sameMax = 0;
    for (const count of byConv.values()) sameMax = Math.max(sameMax, count);
    this.maxSameConversationConcurrent = Math.max(this.maxSameConversationConcurrent, sameMax);
    this.maxDistinctConversationsConcurrent = Math.max(
      this.maxDistinctConversationsConcurrent,
      byConv.size
    );
  }
  async getRun(runId: string): Promise<CsapiRunSnapshot | undefined> {
    const run = this.runs.get(runId);
    if (!run) return undefined;
    this.trackConcurrency();
    const status = this.statusOf(runId);
    const lifecycle = {
      queuedAt: new Date(run.createdAt).toISOString(),
      startedAt: new Date(run.createdAt).toISOString(),
      lastActivityAt: new Date(run.createdAt).toISOString(),
      cancelReason: run.cancelReason ?? null,
      model: run.model,
      provider: providerForModel(run.model)
    };
    if (status === "finished") {
      return {
        status,
        response: `echo:${run.prompt}`,
        error: null,
        progress: null,
        inputTokens: 7,
        outputTokens: 5,
        ...lifecycle
      };
    }
    if (status === "error") {
      return {
        status,
        response: null,
        error: "upstream boom",
        progress: null,
        inputTokens: null,
        outputTokens: null,
        ...lifecycle
      };
    }
    if (status === "cancelled") {
      return {
        status,
        response: null,
        error: "cancelled",
        progress: null,
        inputTokens: null,
        outputTokens: null,
        ...lifecycle
      };
    }
    return {
      status,
      response: null,
      error: null,
      progress: "working",
      inputTokens: null,
      outputTokens: null,
      ...lifecycle
    };
  }
  async cancelRun(
    runId: string,
    _principalId: string,
    reason: CsapiCancelReason
  ): Promise<CsapiRunSnapshot | undefined> {
    const run = this.runs.get(runId);
    if (run && !run.cancelledAt) {
      run.cancelledAt = Date.now();
      run.cancelReason = reason;
      this.cancelCount += 1;
    }
    return this.getRun(runId);
  }
  async audit() {
    /* no-op */
  }
}

export type ChatTurn = { role: "system" | "user" | "assistant"; content: string };

/** Simulates Hermes bridging one Telegram chat turn into CSAPI + Telegram outbound. */
export class HermesTelegramBridge {
  readonly histories = new Map<string, ChatTurn[]>();
  readonly activeSessions = new Set<string>();
  maxConcurrentSessions = 6;

  constructor(
    private readonly app: FastifyInstance,
    private readonly bot: FakeTelegramBot,
    private readonly apiKey = SMOKE_API_KEY
  ) {}

  private sessionHeader(chatId: string) {
    return `hermes:telegram:${chatId}`;
  }

  private idempotencyKey(chatId: string, userText: string, model: string) {
    return createHash("sha256")
      .update(["cursor-gateway-v1", chatId, model, userText].join("\0"))
      .digest("hex");
  }

  private splitForTelegram(text: string) {
    const chunks: string[] = [];
    for (let offset = 0; offset < text.length; offset += TELEGRAM_MESSAGE_LIMIT) {
      chunks.push(text.slice(offset, offset + TELEGRAM_MESSAGE_LIMIT));
    }
    return chunks;
  }

  private parseSseFrames(payload: string) {
    return payload
      .split("\n")
      .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
      .map((line) => {
        try {
          return JSON.parse(line.slice(6)) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((frame): frame is Record<string, unknown> => frame !== null);
  }

  private extractStreamText(payload: string) {
    return this.parseSseFrames(payload)
      .flatMap((frame) => (frame.choices as Array<Record<string, unknown>> | undefined) ?? [])
      .map((choice) => (choice.delta as { content?: string } | undefined)?.content ?? "")
      .join("");
  }

  private extractStreamError(payload: string): { message: string; statusCode: number } | null {
    for (const frame of this.parseSseFrames(payload)) {
      const err = frame.error as { message?: string; type?: string } | undefined;
      if (!err?.message) continue;
      const message = err.message;
      if (/timed out/i.test(message)) return { message, statusCode: 504 };
      if (/concurrency|overloaded|rate/i.test(message)) return { message, statusCode: 429 };
      if (/workspace|runner/i.test(message)) return { message, statusCode: 503 };
      return { message, statusCode: 502 };
    }
    return null;
  }

  private mapStatusFromErrorMessage(message: string, fallback: number) {
    if (/timed out/i.test(message)) return 504;
    if (/concurrency|overloaded|rate/i.test(message)) return 429;
    if (/workspace|runner|unreachable/i.test(message)) return 503;
    return fallback;
  }

  async handleUserMessage(input: {
    chatId: string;
    text: string;
    model?: string;
    stream?: boolean;
    forceGatewayDown?: boolean;
  }): Promise<{
    statusCode: number;
    replyTexts: string[];
    response: LightMyRequestResponse | null;
  }> {
    const model = input.model ?? "auto";
    const history = this.histories.get(input.chatId) ?? [
      { role: "system", content: "Telegram Hermes bridge" }
    ];

    if (this.activeSessions.size >= this.maxConcurrentSessions && !this.activeSessions.has(input.chatId)) {
      const msg = "active session limit reached; try again shortly";
      await this.bot.sendUserVisibleError(input.chatId, msg);
      return { statusCode: 429, replyTexts: [msg], response: null };
    }

    this.activeSessions.add(input.chatId);
    await this.bot.sendChatAction(input.chatId, "typing");
    this.bot.advance(2);

    try {
      if (input.forceGatewayDown) {
        const msg = "gateway unreachable";
        await this.bot.sendUserVisibleError(input.chatId, msg);
        return { statusCode: 503, replyTexts: [msg], response: null };
      }

      const messages = [...history, { role: "user" as const, content: input.text }];
      const useStream = input.stream ?? true;
      const response = await this.app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "x-session-id": this.sessionHeader(input.chatId),
          "idempotency-key": this.idempotencyKey(input.chatId, input.text, model)
        },
        payload: {
          model,
          stream: useStream,
          messages
        }
      });

      if (response.statusCode === 429) {
        const msg = "rate limited (429); please retry";
        await this.bot.sendUserVisibleError(input.chatId, msg);
        return { statusCode: 429, replyTexts: [msg], response };
      }
      if (response.statusCode >= 400) {
        const body = (() => {
          try {
            return response.json() as { error?: { message?: string } };
          } catch {
            return {};
          }
        })();
        const msg = body.error?.message ?? `request failed (${response.statusCode})`;
        await this.bot.sendUserVisibleError(input.chatId, msg);
        return {
          statusCode: this.mapStatusFromErrorMessage(msg, response.statusCode),
          replyTexts: [msg],
          response
        };
      }

      // Streaming hijacks with HTTP 200 before execute finishes; errors arrive as SSE frames.
      if (useStream) {
        const streamError = this.extractStreamError(response.payload);
        if (streamError) {
          await this.bot.sendUserVisibleError(input.chatId, streamError.message);
          return { statusCode: streamError.statusCode, replyTexts: [streamError.message], response };
        }
      }

      const text = useStream
        ? this.extractStreamText(response.payload)
        : String(
            ((response.json() as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]
              ?.message?.content) ?? ""
          );

      const chunks = this.splitForTelegram(text);
      for (const chunk of chunks) {
        await this.bot.sendMessage(input.chatId, chunk);
        this.bot.advance(1);
      }

      history.push({ role: "user", content: input.text });
      history.push({ role: "assistant", content: text });
      this.histories.set(input.chatId, history);
      return { statusCode: response.statusCode, replyTexts: chunks, response };
    } finally {
      this.activeSessions.delete(input.chatId);
    }
  }
}

export function buildSmokeStack(options?: {
  maxConc?: number;
  callerWaitTimeoutMs?: number;
  queueTimeoutMs?: number;
  idleTimeoutMs?: number;
  absoluteTimeoutMs?: number;
  finishDelayMs?: number;
  maxPromptChars?: number;
  heartbeatIntervalMs?: number;
  maxConcurrentSessions?: number;
  backend?: FakeRunnerBackend;
}) {
  const backend = options?.backend ?? new FakeRunnerBackend();
  if (options?.finishDelayMs !== undefined) backend.finishDelayMs = options.finishDelayMs;
  const app = Fastify();
  registerCsapi(app, {
    backend,
    config: {
      enabled: true,
      apiKeys: new Set([SMOKE_API_KEY]),
      defaultModel: "auto",
      defaultWorkspaceId: "",
      maxConcurrencyPerKey: options?.maxConc ?? 6,
      callerWaitTimeoutMs: options?.callerWaitTimeoutMs ?? 5_000,
      queueTimeoutMs: options?.queueTimeoutMs ?? 5_000,
      idleTimeoutMs: options?.idleTimeoutMs ?? 5_000,
      absoluteTimeoutMs: options?.absoluteTimeoutMs ?? 10_000,
      maxPromptChars: options?.maxPromptChars ?? 96_000,
      allowWrites: false
    },
    pollIntervalMs: 10,
    heartbeatIntervalMs: options?.heartbeatIntervalMs ?? 10_000
  });
  const bot = new FakeTelegramBot();
  const bridge = new HermesTelegramBridge(app, bot);
  if (options?.maxConcurrentSessions !== undefined) {
    bridge.maxConcurrentSessions = options.maxConcurrentSessions;
  }
  return { app, backend, bot, bridge };
}

export async function closeSmokeStack(app: FastifyInstance) {
  await app.close();
}
