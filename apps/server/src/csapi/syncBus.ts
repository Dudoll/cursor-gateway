/**
 * Redis pub/sub for cs-relay sync stream (payload: account/conversation/sequence only).
 */
import { Redis } from "ioredis";
import { config } from "../config.js";

const CHANNEL = "cs-relay:sync";

export type SyncNotifyPayload = {
  accountId: string;
  conversationId: string;
  sequence: number;
};

let publisher: Redis | null = null;
let publisherConnect: Promise<void> | null = null;
const subscriberByAccount = new Map<string, Set<(payload: SyncNotifyPayload) => void>>();

function redisEnabled(): boolean {
  return Boolean(config.redisUrl?.trim());
}

function getPublisher(): Redis | null {
  if (!redisEnabled()) return null;
  if (!publisher) {
    publisher = new Redis(config.redisUrl!, { maxRetriesPerRequest: 1, lazyConnect: true });
  }
  return publisher;
}

let subscriber: Redis | null = null;

async function ensureSubscriber(): Promise<void> {
  if (!redisEnabled() || subscriber) return;
  subscriber = new Redis(config.redisUrl!, { maxRetriesPerRequest: 1, lazyConnect: true });
  await subscriber.connect();
  await subscriber.subscribe(CHANNEL);
  subscriber.on("message", (_channel, message) => {
    try {
      const payload = JSON.parse(message) as SyncNotifyPayload;
      if (!payload.accountId || !payload.conversationId) return;
      // Never accept content fields — strip if present.
      const safe: SyncNotifyPayload = {
        accountId: String(payload.accountId),
        conversationId: String(payload.conversationId),
        sequence: Number(payload.sequence) || 0
      };
      const listeners = subscriberByAccount.get(safe.accountId);
      if (!listeners) return;
      for (const listener of listeners) listener(safe);
    } catch {
      // ignore malformed
    }
  });
}

export async function publishSyncNotify(payload: SyncNotifyPayload): Promise<void> {
  const pub = getPublisher();
  if (!pub) return;
  const safe = {
    accountId: payload.accountId,
    conversationId: payload.conversationId,
    sequence: payload.sequence
  };
  try {
    if (pub.status === "wait" || pub.status === "end") {
      // Serialize connects so concurrent publishes never hit
      // "Redis is already connecting/connected".
      if (!publisherConnect) {
        publisherConnect = pub.connect().finally(() => {
          publisherConnect = null;
        });
      }
      await publisherConnect;
    } else if (pub.status !== "ready") {
      await new Promise<void>((resolve) => pub.once("ready", () => resolve()));
    }
    await pub.publish(CHANNEL, JSON.stringify(safe));
  } catch (error) {
    console.warn("[cs-relay-sync] publish failed", error);
  }
}

export async function subscribeSyncAccount(
  accountId: string,
  listener: (payload: SyncNotifyPayload) => void
): Promise<() => void> {
  await ensureSubscriber();
  let set = subscriberByAccount.get(accountId);
  if (!set) {
    set = new Set();
    subscriberByAccount.set(accountId, set);
  }
  set.add(listener);
  return () => {
    set!.delete(listener);
    if (set!.size === 0) subscriberByAccount.delete(accountId);
  };
}

/** Close pub/sub sockets so short-lived scripts / tests can exit cleanly. */
export async function closeSyncBus(): Promise<void> {
  const closers: Promise<unknown>[] = [];
  if (publisher) {
    const pub = publisher;
    closers.push(pub.quit().catch(() => pub.disconnect()));
    publisher = null;
  }
  if (subscriber) {
    const sub = subscriber;
    closers.push(sub.quit().catch(() => sub.disconnect()));
    subscriber = null;
  }
  subscriberByAccount.clear();
  await Promise.allSettled(closers);
}
