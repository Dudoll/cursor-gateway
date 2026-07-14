import { existsSync, readFileSync } from "node:fs";
import { e2eeTrustRootPublicSchema, type E2eeTrustRootPublic } from "@cursor-gateway/shared";
import { config } from "./config.js";

let cached: { source: string; roots: E2eeTrustRootPublic[] } | undefined;

/**
 * Offline trust roots the Gateway serves to clients via `/api/e2ee-policy` so
 * they can verify Runner identity certificates. The Gateway never signs or
 * issues certs itself — it only relays this public-only material.
 */
export function loadServerTrustRoots(): E2eeTrustRootPublic[] {
  const source = `${config.e2eeTrustRootsJson}|${config.e2eeTrustRootsFile}`;
  if (cached && cached.source === source) return cached.roots;

  let raw: unknown;
  if (config.e2eeTrustRootsJson) {
    try {
      raw = JSON.parse(config.e2eeTrustRootsJson);
    } catch {
      console.warn("[trust-roots] E2EE_TRUST_ROOTS_JSON is not valid JSON; ignoring");
    }
  } else if (config.e2eeTrustRootsFile && existsSync(config.e2eeTrustRootsFile)) {
    try {
      raw = JSON.parse(readFileSync(config.e2eeTrustRootsFile, "utf8"));
    } catch {
      console.warn(`[trust-roots] Failed to parse ${config.e2eeTrustRootsFile}; ignoring`);
    }
  }

  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { trustRoots?: unknown }).trustRoots)
      ? (raw as { trustRoots: unknown[] }).trustRoots
      : [];

  const roots: E2eeTrustRootPublic[] = [];
  for (const item of list) {
    try {
      roots.push(e2eeTrustRootPublicSchema.parse(item));
    } catch {
      console.warn("[trust-roots] Skipping invalid trust root entry");
    }
  }
  cached = { source, roots };
  return roots;
}
