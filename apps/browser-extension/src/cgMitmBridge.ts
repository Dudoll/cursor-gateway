/**
 * Minimal cg-mitm crypto bridge for the signed browser extension (relay-P6).
 *
 * Pages on cs.joelzt.org must NOT hold long-term keys. The extension background
 * owns Ed25519 root fingerprints + device keys; the page talks via postMessage.
 *
 * This module is the in-extension API surface. Wire it from background.ts /
 * content-script in a follow-up once Force-install / store signing is available.
 *
 * Bootstrap honesty: pure web pages under enterprise TLS MITM cannot trust
 * first-load JS. Prefer this extension or the localhost Secure Adapter.
 */
import type { CgTrustRootPublic } from "@cursor-gateway/shared";

export type CgMitmBridgeRequest =
  | { type: "cg.ping" }
  | { type: "cg.getTrustRoots" }
  | { type: "cg.enrollStatus" }
  | { type: "cg.exchange"; wire: "anthropic" | "openai"; body: Record<string, unknown> }
  | { type: "cg.sync"; op: string; conversationId?: string; sinceSequence?: number };

export type CgMitmBridgeResponse =
  | { ok: true; type: string; data?: unknown }
  | { ok: false; type: string; reason: string };

/** Built-in offline roots (filled at pack time from scripts/csapi/trust/). */
let pinnedRoots: CgTrustRootPublic[] = [];

export function setPinnedTrustRoots(roots: CgTrustRootPublic[]): void {
  pinnedRoots = roots;
}

export function getPinnedTrustRoots(): CgTrustRootPublic[] {
  return pinnedRoots.slice();
}

/**
 * Handle a page→extension bridge request. Crypto operations should call into
 * the same helpers used by apps/secure-adapter (enroll/exchange/sync).
 * Currently returns structured stubs so the message protocol can be integration-tested.
 */
export async function handleCgMitmBridge(
  request: CgMitmBridgeRequest
): Promise<CgMitmBridgeResponse> {
  switch (request.type) {
    case "cg.ping":
      return { ok: true, type: request.type, data: { protocol: "cg-mitm/1", bridge: "v0" } };
    case "cg.getTrustRoots":
      return { ok: true, type: request.type, data: { trustRoots: getPinnedTrustRoots() } };
    case "cg.enrollStatus":
      return {
        ok: true,
        type: request.type,
        data: { enrolled: false, note: "wire_secure_adapter_client_next" }
      };
    case "cg.exchange":
    case "cg.sync":
      return {
        ok: false,
        type: request.type,
        reason: "bridge_not_wired_use_secure_adapter"
      };
    default:
      return { ok: false, type: "unknown", reason: "bridge_unknown_request" };
  }
}
