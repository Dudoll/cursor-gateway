/**
 * In-process waiters for long-poll claim endpoints (single-instance deploy).
 * Persistent state remains in PostgreSQL; this only wakes idle pollers.
 */

type Waiter = {
  resolve: () => void;
  timer: ReturnType<typeof setTimeout>;
};

const plaintextWaiters = new Set<Waiter>();
const e2eeWaitersByRunner = new Map<string, Set<Waiter>>();
const pairingWaitersByRunner = new Map<string, Set<Waiter>>();

function wakeSet(set: Set<Waiter> | undefined) {
  if (!set || set.size === 0) return;
  for (const waiter of [...set]) {
    clearTimeout(waiter.timer);
    set.delete(waiter);
    waiter.resolve();
  }
}

export function notifyPlaintextJobQueued() {
  wakeSet(plaintextWaiters);
}

export function notifyE2eeJobQueued(runnerId: string) {
  wakeSet(e2eeWaitersByRunner.get(runnerId));
}

export function notifyPairingQueued(runnerId: string) {
  wakeSet(pairingWaitersByRunner.get(runnerId));
}

async function waitOn(
  set: Set<Waiter>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<"timeout" | "notified" | "aborted"> {
  if (signal?.aborted) return "aborted";
  return await new Promise((resolve) => {
    const waiter: Waiter = {
      resolve: () => {
        set.delete(waiter);
        resolve("notified");
      },
      timer: setTimeout(() => {
        set.delete(waiter);
        resolve("timeout");
      }, Math.max(0, timeoutMs))
    };
    set.add(waiter);
    const onAbort = () => {
      clearTimeout(waiter.timer);
      set.delete(waiter);
      resolve("aborted");
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function waitForPlaintextJob(timeoutMs: number, signal?: AbortSignal) {
  return waitOn(plaintextWaiters, timeoutMs, signal);
}

export async function waitForE2eeJob(
  runnerId: string,
  timeoutMs: number,
  signal?: AbortSignal
) {
  let set = e2eeWaitersByRunner.get(runnerId);
  if (!set) {
    set = new Set();
    e2eeWaitersByRunner.set(runnerId, set);
  }
  return waitOn(set, timeoutMs, signal);
}

export async function waitForPairing(
  runnerId: string,
  timeoutMs: number,
  signal?: AbortSignal
) {
  let set = pairingWaitersByRunner.get(runnerId);
  if (!set) {
    set = new Set();
    pairingWaitersByRunner.set(runnerId, set);
  }
  return waitOn(set, timeoutMs, signal);
}
