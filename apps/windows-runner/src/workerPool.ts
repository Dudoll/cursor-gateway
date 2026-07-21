export type WorkerQueue = "e2ee" | "legacy";

export class SinglePermit {
  private busy = false;

  tryAcquire(): (() => void) | undefined {
    if (this.busy) return undefined;
    this.busy = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.busy = false;
    };
  }
}

/**
 * Order queues for one shared worker slot. Alternating the first queue avoids
 * starving encrypted work while allowing all slots to serve legacy CSAPI work
 * whenever the encrypted queue is empty.
 */
export function workerQueueOrder(input: {
  workerId: number;
  iteration: number;
  e2eeEnabled: boolean;
  legacyEnabled: boolean;
}): WorkerQueue[] {
  const enabled: WorkerQueue[] = [];
  if (input.e2eeEnabled) enabled.push("e2ee");
  if (input.legacyEnabled) enabled.push("legacy");
  if (enabled.length < 2) return enabled;
  return (input.workerId + input.iteration) % 2 === 0
    ? ["e2ee", "legacy"]
    : ["legacy", "e2ee"];
}
