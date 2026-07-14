import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { E2eePairingOffer, E2eePairingStart } from "@cursor-gateway/shared";

export type PendingPairing = {
  token: string;
  offer: E2eePairingOffer;
  start: E2eePairingStart;
  recipientEmail: string;
  /** True after a successful sendPairingEmail (any mode including log). */
  mailSent: boolean;
  createdAt: string;
};

/**
 * Persist in-flight pairing state so mail/offer retries reuse the same token/offer
 * across poll loops and runner restarts (without re-sending mail once mailSent).
 */
export class PairingPendingStore {
  private readonly byPairId = new Map<string, PendingPairing>();

  constructor(private readonly filePath: string) {
    this.load();
  }

  get(pairId: string): PendingPairing | undefined {
    return this.byPairId.get(pairId);
  }

  set(pairId: string, pending: PendingPairing): void {
    this.byPairId.set(pairId, pending);
    this.save();
  }

  delete(pairId: string): void {
    if (!this.byPairId.delete(pairId)) return;
    this.save();
  }

  pruneExpired(now = Date.now()): void {
    let changed = false;
    for (const [pairId, pending] of this.byPairId) {
      if (Date.parse(pending.offer.expiresAt) <= now) {
        this.byPairId.delete(pairId);
        changed = true;
      }
    }
    if (changed) this.save();
  }

  /** Test helper */
  entries(): IterableIterator<[string, PendingPairing]> {
    return this.byPairId.entries();
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as {
        pairings?: Record<string, PendingPairing>;
      };
      for (const [pairId, pending] of Object.entries(raw.pairings ?? {})) {
        if (pending?.token && pending?.offer && pending?.start && pending?.recipientEmail) {
          this.byPairId.set(pairId, pending);
        }
      }
    } catch {
      console.warn("[pairing] failed to load pending pairing store; starting empty");
    }
  }

  private save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const pairings: Record<string, PendingPairing> = {};
    for (const [pairId, pending] of this.byPairId) {
      pairings[pairId] = pending;
    }
    writeFileSync(this.filePath, JSON.stringify({ pairings }, null, 2), { mode: 0o600 });
  }
}
