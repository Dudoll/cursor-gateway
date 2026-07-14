/**
 * In-memory (never persisted) map from passkey pairId -> the raw Cloudflare
 * Access JWT captured at "complete" time, so the Runner can verify the
 * caller's identity when it claims the completed pairing. Never log the JWT
 * or store it in the database — this is the only place it briefly exists
 * server-side.
 *
 * Lifecycle: `put` on complete → `peek` while Runner claims/verifies →
 * `consume` after Runner publishes ack (or TTL expiry). Peek does not delete,
 * so a lost claim response can be retried within TTL.
 */
const TTL_MS = 5 * 60_000;

type Entry = { jwt: string; storedAt: number };

const store = new Map<string, Entry>();

export function putEphemeralAccessJwt(pairId: string, jwt: string): void {
  pruneExpired();
  store.set(pairId, { jwt, storedAt: Date.now() });
}

/** Non-destructive read for Runner claim retries within TTL. */
export function peekEphemeralAccessJwt(pairId: string): string | null {
  pruneExpired();
  const entry = store.get(pairId);
  if (!entry) return null;
  if (Date.now() - entry.storedAt > TTL_MS) {
    store.delete(pairId);
    return null;
  }
  return entry.jwt;
}

/** One-time destructive read (legacy); prefer peek + consume after ack. */
export function takeEphemeralAccessJwt(pairId: string): string | null {
  const jwt = peekEphemeralAccessJwt(pairId);
  store.delete(pairId);
  return jwt;
}

/** Drop the JWT after Runner ack (success or reject). */
export function consumeEphemeralAccessJwt(pairId: string): void {
  store.delete(pairId);
}

function pruneExpired() {
  const now = Date.now();
  for (const [pairId, entry] of store) {
    if (now - entry.storedAt > TTL_MS) store.delete(pairId);
  }
}
