import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Generic on-disk (0600 JSON) map for short-lived runner-local pending state,
 * keyed by an opaque id (pairId / approvalId / recoveryId). Extracted from the
 * original `PairingPendingStore` so passkey / device-approval / recovery
 * cycles share the same persist-across-restarts + TTL-prune behavior.
 */
export class PendingRecordStore<T> {
  private readonly byId = new Map<string, T>();

  constructor(
    private readonly filePath: string,
    private readonly expiresAtOf: (value: T) => string
  ) {
    this.load();
  }

  get(id: string): T | undefined {
    return this.byId.get(id);
  }

  set(id: string, value: T): void {
    this.byId.set(id, value);
    this.save();
  }

  delete(id: string): void {
    if (!this.byId.delete(id)) return;
    this.save();
  }

  pruneExpired(now = Date.now()): void {
    let changed = false;
    for (const [id, value] of this.byId) {
      if (Date.parse(this.expiresAtOf(value)) <= now) {
        this.byId.delete(id);
        changed = true;
      }
    }
    if (changed) this.save();
  }

  entries(): IterableIterator<[string, T]> {
    return this.byId.entries();
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as {
        records?: Record<string, T>;
      };
      for (const [id, value] of Object.entries(raw.records ?? {})) {
        this.byId.set(id, value);
      }
    } catch {
      console.warn(`[pending-store] failed to load ${this.filePath}; starting empty`);
    }
  }

  private save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const records: Record<string, T> = {};
    for (const [id, value] of this.byId) records[id] = value;
    writeFileSync(this.filePath, JSON.stringify({ records }, null, 2), { mode: 0o600 });
  }
}
