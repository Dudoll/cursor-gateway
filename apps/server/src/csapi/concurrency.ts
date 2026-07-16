// Concurrency primitives for the csapi facade.
//
//  - SessionSerializer: keyed mutex so requests sharing a session id run
//    strictly one-at-a-time (same-session serial), while different keys run
//    concurrently (cross-session parallel).
//  - KeyConcurrencyLimiter: per-API-key in-flight cap for backpressure (429).

/** Runs functions keyed by a string strictly serially; distinct keys run in parallel. */
export class SessionSerializer {
  private tail = new Map<string, Promise<void>>();
  private pending = new Map<string, number>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tail.get(key) ?? Promise.resolve();
    this.pending.set(key, (this.pending.get(key) ?? 0) + 1);

    // Run `fn` after the previous holder settles, regardless of its outcome.
    const result = prev.then(fn, fn);
    const settled = result.then(
      () => undefined,
      () => undefined
    );
    this.tail.set(key, settled);

    void settled.then(() => {
      const remaining = (this.pending.get(key) ?? 1) - 1;
      if (remaining <= 0) {
        this.pending.delete(key);
        if (this.tail.get(key) === settled) this.tail.delete(key);
      } else {
        this.pending.set(key, remaining);
      }
    });

    return result;
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
