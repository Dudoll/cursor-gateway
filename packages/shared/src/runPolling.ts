import type { RunStatus } from "./index.js";

const IN_FLIGHT_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  "queued",
  "running",
  "waiting_approval"
]);

export const RUN_POLL_INTERVAL_MS = 2_000;
export const RUN_POLL_BACKGROUND_INTERVAL_MS = 15_000;
export const RUN_POLL_MAX_RETRY_INTERVAL_MS = 30_000;

export function isRunStatusInFlight(status: RunStatus): boolean {
  return IN_FLIGHT_RUN_STATUSES.has(status);
}

export type RunPollingLoop = {
  /** Start immediately. Calling start while active is a no-op. */
  start: () => void;
  /** Cancel pending work and suppress application of an in-flight result. */
  stop: () => void;
  /** Poll immediately when no request is already in flight. */
  wake: () => void;
  isActive: () => boolean;
};

export type RunPollingLoopOptions<T> = {
  load: () => Promise<T>;
  apply: (snapshot: T) => void;
  statuses: (snapshot: T) => readonly RunStatus[];
  onError?: (error: unknown) => void;
  intervalMs?: number;
  backgroundIntervalMs?: number;
  maxRetryIntervalMs?: number;
  isBackground?: () => boolean;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (handle: unknown) => void;
};

/**
 * Self-scheduling run poller.
 *
 * A request must finish before another can start. Successful terminal snapshots
 * stop the loop; transient failures retry with bounded backoff. stop() invalidates
 * an in-flight generation so a component that unmounts cannot receive late state.
 */
export function createRunPollingLoop<T>(options: RunPollingLoopOptions<T>): RunPollingLoop {
  const intervalMs = options.intervalMs ?? RUN_POLL_INTERVAL_MS;
  const backgroundIntervalMs =
    options.backgroundIntervalMs ?? RUN_POLL_BACKGROUND_INTERVAL_MS;
  const maxRetryIntervalMs =
    options.maxRetryIntervalMs ?? RUN_POLL_MAX_RETRY_INTERVAL_MS;
  const isBackground = options.isBackground ?? (() => false);
  const schedule =
    options.schedule ??
    ((callback: () => void, delayMs: number) => globalThis.setTimeout(callback, delayMs));
  const cancel =
    options.cancel ??
    ((handle: unknown) =>
      globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>));

  let active = false;
  let inFlight = false;
  let wakeRequested = false;
  let timer: unknown | undefined;
  let consecutiveFailures = 0;
  let generation = 0;

  function clearScheduled() {
    if (timer === undefined) return;
    cancel(timer);
    timer = undefined;
  }

  function nextDelay() {
    const base = isBackground() ? backgroundIntervalMs : intervalMs;
    if (consecutiveFailures === 0) return base;
    const multiplier = 2 ** Math.min(consecutiveFailures, 4);
    return Math.min(base * multiplier, maxRetryIntervalMs);
  }

  function scheduleNext(currentGeneration: number) {
    if (!active || generation !== currentGeneration || timer !== undefined) return;
    timer = schedule(() => {
      timer = undefined;
      void poll(currentGeneration);
    }, nextDelay());
  }

  async function poll(currentGeneration: number) {
    if (!active || generation !== currentGeneration) return;
    if (inFlight) {
      wakeRequested = true;
      return;
    }

    inFlight = true;
    try {
      const snapshot = await options.load();
      if (!active || generation !== currentGeneration) return;
      options.apply(snapshot);
      consecutiveFailures = 0;
      if (!options.statuses(snapshot).some(isRunStatusInFlight)) {
        active = false;
        clearScheduled();
        return;
      }
    } catch (error) {
      if (!active || generation !== currentGeneration) return;
      consecutiveFailures += 1;
      options.onError?.(error);
    } finally {
      inFlight = false;
      if (!active) return;
      if (generation !== currentGeneration) {
        if (wakeRequested) {
          wakeRequested = false;
          void poll(generation);
        }
        return;
      }
      if (wakeRequested) {
        wakeRequested = false;
        void poll(currentGeneration);
      } else {
        scheduleNext(currentGeneration);
      }
    }
  }

  return {
    start() {
      if (active) return;
      active = true;
      wakeRequested = false;
      consecutiveFailures = 0;
      generation += 1;
      void poll(generation);
    },
    stop() {
      active = false;
      wakeRequested = false;
      generation += 1;
      clearScheduled();
    },
    wake() {
      if (!active) return;
      clearScheduled();
      if (inFlight) return;
      void poll(generation);
    },
    isActive() {
      return active;
    }
  };
}
