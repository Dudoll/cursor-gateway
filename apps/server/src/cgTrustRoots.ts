import { existsSync, readFileSync } from "node:fs";
import { cgTrustRootPublicSchema, type CgTrustRootPublic } from "@cursor-gateway/shared";
import { config } from "./config.js";

let cached: { source: string; roots: CgTrustRootPublic[] } | undefined;

/**
 * Offline Ed25519 trust roots for verifying cg-mitm server identity certificates.
 * Public-only material — never contains private keys.
 */
export function loadCgTrustRoots(): CgTrustRootPublic[] {
  const source = `${config.cg.trustRootsJson}|${config.cg.trustRootsFile}`;
  if (cached && cached.source === source) return cached.roots;

  let raw: unknown;
  if (config.cg.trustRootsJson) {
    try {
      raw = JSON.parse(config.cg.trustRootsJson);
    } catch {
      console.warn("[cg-trust-roots] CG_TRUST_ROOTS_JSON is not valid JSON; ignoring");
    }
  } else if (config.cg.trustRootsFile && existsSync(config.cg.trustRootsFile)) {
    try {
      raw = JSON.parse(readFileSync(config.cg.trustRootsFile, "utf8"));
    } catch {
      console.warn(`[cg-trust-roots] Failed to parse ${config.cg.trustRootsFile}; ignoring`);
    }
  }

  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { trustRoots?: unknown }).trustRoots)
      ? (raw as { trustRoots: unknown[] }).trustRoots
      : [];

  const roots: CgTrustRootPublic[] = [];
  for (const item of list) {
    try {
      roots.push(cgTrustRootPublicSchema.parse(item));
    } catch {
      console.warn("[cg-trust-roots] Skipping invalid trust root entry");
    }
  }
  cached = { source, roots };
  return roots;
}
