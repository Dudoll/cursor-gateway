// Concurrency primitives for the csapi facade.
//
//  - SessionSerializer: keyed mutex so requests sharing a session id run
//    strictly one-at-a-time (same-session serial), while different keys run
//    concurrently (cross-session parallel).
//  - KeyConcurrencyLimiter: per-API-key in-flight cap for backpressure (429).

/** Raised when a queued same-session request disconnects before acquiring. */
export class SessionSerializerAbortError extends Error {
  constructor() {
    super("session_wait_aborted");
    this.name = "SessionSerializerAbortError";
  }
}

interface SessionTask {
  fn: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
  started: boolean;
}

/** Runs functions keyed by a string strictly serially; distinct keys run in parallel. */
export class SessionSerializer {
  private queues = new Map<string, SessionTask[]>();
  private active = new Set<string>();
  private pending = new Map<string, number>();

  run<T>(key: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) {
      return Promise.reject(new SessionSerializerAbortError());
    }
    this.pending.set(key, (this.pending.get(key) ?? 0) + 1);

    return new Promise<T>((resolve, reject) => {
      const task: SessionTask = {
        fn,
        resolve: (value) => resolve(value as T),
        reject,
        signal,
        onAbort: undefined,
        started: false
      };

      task.onAbort = () => {
        if (task.started) return;
        const queue = this.queues.get(key);
        const index = queue?.indexOf(task) ?? -1;
        if (queue && index >= 0) queue.splice(index, 1);
        signal?.removeEventListener("abort", task.onAbort!);
        this.finishPending(key);
        task.reject(new SessionSerializerAbortError());
        if (!this.active.has(key)) this.drain(key);
        else if (queue?.length === 0) this.queues.delete(key);
      };
      signal?.addEventListener("abort", task.onAbort, { once: true });

      const queue = this.queues.get(key) ?? [];
      queue.push(task);
      this.queues.set(key, queue);
      if (signal?.aborted) {
        task.onAbort();
        return;
      }
      this.drain(key);
    });
  }

  private drain(key: string): void {
    if (this.active.has(key)) return;
    const queue = this.queues.get(key);
    const task = queue?.shift();
    if (!task) {
      this.queues.delete(key);
      return;
    }
    if (queue?.length === 0) this.queues.delete(key);

    if (task.signal?.aborted) {
      task.signal.removeEventListener("abort", task.onAbort!);
      this.finishPending(key);
      task.reject(new SessionSerializerAbortError());
      this.drain(key);
      return;
    }

    task.started = true;
    task.signal?.removeEventListener("abort", task.onAbort!);
    this.active.add(key);
    void Promise.resolve()
      .then(task.fn)
      .then(task.resolve, task.reject)
      .finally(() => {
        this.active.delete(key);
        this.finishPending(key);
        this.drain(key);
      });
  }

  private finishPending(key: string): void {
    const remaining = (this.pending.get(key) ?? 1) - 1;
    if (remaining <= 0) this.pending.delete(key);
    else this.pending.set(key, remaining);
  }

  /** Number of queued+running tasks for a key (test/introspection helper). */
  depth(key: string): number {
    return this.pending.get(key) ?? 0;
  }
}

/** Tracks in-flight requests per API key and enforces a hard cap. */
export class KeyConcurrencyLimiter {
  private active = new Map<string, number>();

  constructor(private readonly max: number) {}

  /** Try to reserve a slot. Returns false when the key is at capacity. */
  tryAcquire(key: string): boolean {
    const current = this.active.get(key) ?? 0;
    if (current >= this.max) return false;
    this.active.set(key, current + 1);
    return true;
  }

  release(key: string): void {
    const current = this.active.get(key) ?? 0;
    if (current <= 1) this.active.delete(key);
    else this.active.set(key, current - 1);
  }

  count(key: string): number {
    return this.active.get(key) ?? 0;
  }
}
