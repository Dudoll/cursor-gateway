import { trustRootSas } from "@cursor-gateway/e2ee";
import type { GatewayApi } from "./api.js";
import { loadTrustRoots } from "./trustRoots.js";

const ACK_KEY = "cg-secure-root-sas-ack";

export type RootSasEntry = { fingerprint: string; words: string[] };

/**
 * Compute the 6-word root SAS for every trust root the client is pinned to /
 * served. The user compares one of these against the Runner terminal (or an
 * already-authorized device) on first install (RAMC P4). Deterministic and
 * secret-free — this only proves *which offline root* the page uses.
 */
export async function computeRootSas(api: GatewayApi): Promise<RootSasEntry[]> {
  const roots = await loadTrustRoots(api);
  const sorted = [...roots].sort((a, b) => (a.fingerprint < b.fingerprint ? -1 : 1));
  const out: RootSasEntry[] = [];
  for (const root of sorted) {
    out.push({ fingerprint: root.fingerprint, words: await trustRootSas(root.fingerprint) });
  }
  return out;
}

export function isRootSasAcked(fingerprint: string): boolean {
  try {
    return localStorage.getItem(ACK_KEY) === fingerprint;
  } catch {
    return false;
  }
}

export function ackRootSas(fingerprint: string): void {
  try {
    localStorage.setItem(ACK_KEY, fingerprint);
  } catch {
    // Persistence is best-effort; verification still gates the current session.
  }
}

export function normalizeSasInput(raw: string): string[] {
  return raw
    .trim()
    .toLowerCase()
    .split(/[\s,]+/)
    .filter(Boolean);
}

/** Return the matching entry when the typed SAS equals any pinned root SAS. */
export function matchRootSas(entries: RootSasEntry[], typed: string[]): RootSasEntry | null {
  if (typed.length !== 6) return null;
  for (const entry of entries) {
    if (entry.words.every((w, i) => w.toLowerCase() === (typed[i] ?? "").toLowerCase())) {
      return entry;
    }
  }
  return null;
}
