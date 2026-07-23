/**
 * In-process waiters for long-poll claim endpoints (single-instance deploy).
 * Persistent state remains in PostgreSQL; this only wakes idle pollers.
 */

type Waiter = {
  resolve: (outcome: "notified" | "timeout" | "aborted") => void;
  timer: ReturnType<typeof setTimeout>;
};

const plaintextWaiters = new Set<Waiter>();
let plaintextQueueVersion = 0;
const e2eeWaitersByRunner = new Map<string, Set<Waiter>>();
const pairingWaitersByRunner = new Map<string, Set<Waiter>>();
const runWaitersById = new Map<string, Set<Waiter>>();

function wakeSet(set: Set<Waiter> | undefined) {
  if (!set || set.size === 0) return;
  for (const waiter of [...set]) {
    clearTimeout(waiter.timer);
    set.delete(waiter);
    waiter.resolve("notified");
  }
}

export function notifyPlaintextJobQueued() {
  plaintextQueueVersion += 1;
  wakeSet(plaintextWaiters);
}

export function getPlaintextQueueVersion() {
  return plaintextQueueVersion;
}

export function notifyE2eeJobQueued(runnerId: string) {
  wakeSet(e2eeWaitersByRunner.get(runnerId));
}

export function notifyPairingQueued(runnerId: string) {
  wakeSet(pairingWaitersByRunner.get(runnerId));
}

/** Wake CSAPI callers when a run's progress or terminal state changes. */
export function notifyRunUpdated(runId: string) {
  wakeSet(runWaitersById.get(runId));
}

async function waitOn(
  set: Set<Waiter>,
  timeoutMs: number,
  signal?: AbortSignal,
  ready?: () => boolean
): Promise<"timeout" | "notified" | "aborted"> {
  if (signal?.aborted) return "aborted";
  return await new Promise((resolve) => {
    const waiter: Waiter = {
      resolve: () => undefined,
      timer: undefined as unknown as ReturnType<typeof setTimeout>
    };
    let settled = false;
    const onAbort = () => finish("aborted");
    const finish = (outcome: "notified" | "timeout" | "aborted") => {
      if (settled) return;
      settled = true;
      clearTimeout(waiter.timer);
      set.delete(waiter);
      signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    waiter.resolve = finish;
    waiter.timer = setTimeout(() => finish("timeout"), Math.max(0, timeoutMs));
    set.add(waiter);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) finish("aborted");
    else if (ready?.()) finish("notified");
  });
}

export async function waitForPlaintextJob(
  timeoutMs: number,
  signal?: AbortSignal,
  observedQueueVersion?: number
) {
  return waitOn(
    plaintextWaiters,
    timeoutMs,
    signal,
    observedQueueVersion === undefined
      ? undefined
      : () => plaintextQueueVersion !== observedQueueVersion
  );
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

export async function waitForRunUpdate(
  runId: string,
  timeoutMs: number,
  signal?: AbortSignal
) {
  let set = runWaitersById.get(runId);
  if (!set) {
    set = new Set();
    runWaitersById.set(runId, set);
  }
  const outcome = await waitOn(set, timeoutMs, signal);
  if (set.size === 0) runWaitersById.delete(runId);
  return outcome;
}
