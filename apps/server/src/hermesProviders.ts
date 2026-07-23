/**
 * Telegram / Hermes multi-provider session + concurrency controls.
 * Used by VPS Hermes Gateway (csgateway | openai-codex | deepseek).
 * Single shared Hermes process; no per-chat process spawn.
 */

export const HERMES_PROVIDERS = ["csgateway", "openai-codex", "deepseek"] as const;
export type HermesProvider = (typeof HERMES_PROVIDERS)[number];

export const HERMES_MAX_PARALLEL_CHATS = 3;
export const HERMES_MAX_QUEUE = 30;

export type HermesChatSession = {
  chatId: string;
  provider: HermesProvider;
  model: string;
  workspaceId?: string;
  conversationId?: string;
};

export type HermesQueuedRequest = {
  chatId: string;
  requestId: string;
  provider: HermesProvider;
  enqueuedAt: number;
};

export function parseHermesProvider(value: string | undefined): HermesProvider | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  return (HERMES_PROVIDERS as readonly string[]).includes(normalized)
    ? (normalized as HermesProvider)
    : undefined;
}

export class HermesConcurrencyController {
  private readonly activeByChat = new Map<string, string>();
  private readonly queue: HermesQueuedRequest[] = [];
  private readonly seenRequestIds = new Set<string>();

  constructor(
    readonly maxParallel = HERMES_MAX_PARALLEL_CHATS,
    readonly maxQueue = HERMES_MAX_QUEUE
  ) {}

  activeCount() {
    return this.activeByChat.size;
  }

  queueDepth() {
    return this.queue.length;
  }

  isChatActive(chatId: string) {
    return this.activeByChat.has(chatId);
  }

  /**
   * Try to start or enqueue a request.
   * Same chat is serial: if chat already active, new work waits in queue.
   * Distinct chats up to maxParallel run concurrently.
   */
  admit(request: HermesQueuedRequest):
    | { status: "started" }
    | { status: "queued"; position: number }
    | { status: "rejected"; reason: "busy" | "duplicate" | "unknown_provider" } {
    if (!HERMES_PROVIDERS.includes(request.provider)) {
      return { status: "rejected", reason: "unknown_provider" };
    }
    if (this.seenRequestIds.has(request.requestId)) {
      return { status: "rejected", reason: "duplicate" };
    }
    if (this.activeByChat.has(request.chatId) || this.activeByChat.size >= this.maxParallel) {
      if (this.queue.length >= this.maxQueue) {
        return { status: "rejected", reason: "busy" };
      }
      this.queue.push(request);
      this.seenRequestIds.add(request.requestId);
      return { status: "queued", position: this.queue.length };
    }
    this.activeByChat.set(request.chatId, request.requestId);
    this.seenRequestIds.add(request.requestId);
    return { status: "started" };
  }

  complete(chatId: string, requestId: string): HermesQueuedRequest | undefined {
    const current = this.activeByChat.get(chatId);
    if (current !== requestId) return undefined;
    this.activeByChat.delete(chatId);
    return this.dequeueNext();
  }

  cancelQueued(requestId: string): boolean {
    const index = this.queue.findIndex((item) => item.requestId === requestId);
    if (index < 0) return false;
    this.queue.splice(index, 1);
    return true;
  }

  private dequeueNext(): HermesQueuedRequest | undefined {
    while (this.queue.length > 0 && this.activeByChat.size < this.maxParallel) {
      const next = this.queue.shift()!;
      if (this.activeByChat.has(next.chatId)) {
        // Same chat still busy — put back and try later.
        this.queue.unshift(next);
        return undefined;
      }
      this.activeByChat.set(next.chatId, next.requestId);
      return next;
    }
    // Prefer a chat that is not active even if not at front.
    for (let i = 0; i < this.queue.length; i++) {
      const candidate = this.queue[i]!;
      if (this.activeByChat.has(candidate.chatId)) continue;
      if (this.activeByChat.size >= this.maxParallel) break;
      this.queue.splice(i, 1);
      this.activeByChat.set(candidate.chatId, candidate.requestId);
      return candidate;
    }
    return undefined;
  }
}

/** Fail-closed: never auto-fallback across providers. */
export function resolveProviderOrThrow(
  requested: string | undefined,
  sessionProvider: HermesProvider
): HermesProvider {
  if (!requested) return sessionProvider;
  const parsed = parseHermesProvider(requested);
  if (!parsed) {
    throw new Error(`unknown_provider:${requested}`);
  }
  return parsed;
}
