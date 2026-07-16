// Secure Adapter configuration. The Adapter is the only trust-domain process
// that ever sees plaintext: it exposes a loopback Anthropic/OpenAI facade for
// standard CLIs and speaks the cg-mitm/1 ciphertext channel to /cg/v1/*.
//
// The ONLY trust anchor is the offline Ed25519 root fingerprint(s) pinned here;
// TLS is validated with the system trust store (enterprise CAs allowed) — the
// confidentiality guarantee is application-layer, not TLS.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CG_MITM_HPKE_SUITE } from "@cursor-gateway/shared";

export interface AdapterConfig {
  listenHost: string;
  listenPort: number;
  /** Local key the CLI presents to the loopback facade (NOT the csapi key). */
  loopbackKey: string;
  /** Base URL of the csapi server exposing /cg/v1/* (no trailing slash). */
  upstreamUrl: string;
  /** The real csapi API key; only ever travels inside the ciphertext envelope. */
  apiKey: string;
  /** Offline-pinned Ed25519 root fingerprints (sha256:...). The sole trust anchor. */
  pinnedRootFingerprints: string[];
  minSuite: typeof CG_MITM_HPKE_SUITE;
  padBuckets: number[];
  /** Where the sealed/plaintext device keys + deviceCert are cached. */
  statePath: string;
  /** Optional master key to seal the state file at rest. */
  masterKey?: string;
}

export class AdapterConfigError extends Error {}

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

function requireEnv(name: string): string {
  const value = env(name);
  if (!value) throw new AdapterConfigError(`missing_required_env:${name}`);
  return value;
}

function parsePadBuckets(value: string | undefined): number[] {
  const buckets = (value ?? "")
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  return buckets.length > 0 ? buckets : [512, 2048, 8192, 32768, 131072];
}

function loadPinnedRoots(): string[] {
  const inline = env("CG_ADAPTER_PINNED_ROOTS");
  const fromFile = env("CG_ADAPTER_PINNED_ROOTS_FILE");
  const raw: string[] = [];
  if (inline) raw.push(...inline.split(","));
  if (fromFile && existsSync(fromFile)) {
    // Accept either a bare newline/comma list or the cg-trust-root-public.json
    // shape ({ trustRoots: [{ fingerprint }] }).
    const text = readFileSync(fromFile, "utf8").trim();
    if (text.startsWith("{") || text.startsWith("[")) {
      try {
        const parsed = JSON.parse(text) as unknown;
        const list = Array.isArray(parsed)
          ? parsed
          : (parsed as { trustRoots?: unknown[] }).trustRoots ?? [];
        for (const item of list) {
          if (item && typeof item === "object" && typeof (item as { fingerprint?: unknown }).fingerprint === "string") {
            raw.push((item as { fingerprint: string }).fingerprint);
          } else if (typeof item === "string") {
            raw.push(item);
          }
        }
      } catch {
        throw new AdapterConfigError("invalid_pinned_roots_file_json");
      }
    } else {
      raw.push(...text.split(/[\n,]/));
    }
  }
  const fingerprints = raw
    .map((item) => item.trim())
    .filter((item) => /^sha256:[A-Za-z0-9_-]{43}$/.test(item));
  if (fingerprints.length === 0) {
    throw new AdapterConfigError("no_pinned_root_fingerprints");
  }
  return [...new Set(fingerprints)];
}

function resolveMasterKey(): string | undefined {
  const inline = env("CG_ADAPTER_MASTER_KEY");
  if (inline && inline.length >= 16) return inline;
  const filePath = env("CG_ADAPTER_MASTER_KEY_FILE");
  if (filePath && existsSync(filePath)) {
    const fromFile = readFileSync(filePath, "utf8").trim();
    if (fromFile.length >= 16) return fromFile;
  }
  return undefined;
}

export function loadAdapterConfig(): AdapterConfig {
  const upstreamUrl = requireEnv("CG_ADAPTER_UPSTREAM_URL").replace(/\/$/, "");
  const masterKey = resolveMasterKey();
  return {
    listenHost: env("CG_ADAPTER_LISTEN_HOST") ?? "127.0.0.1",
    listenPort: Number(env("CG_ADAPTER_LISTEN_PORT") ?? "8788"),
    loopbackKey: requireEnv("CG_ADAPTER_LOOPBACK_KEY"),
    upstreamUrl,
    apiKey: requireEnv("CG_ADAPTER_API_KEY"),
    pinnedRootFingerprints: loadPinnedRoots(),
    minSuite: CG_MITM_HPKE_SUITE,
    padBuckets: parsePadBuckets(env("CG_ADAPTER_PAD_BUCKETS")),
    statePath:
      env("CG_ADAPTER_STATE_FILE") ??
      join(homedir(), ".cursor-gateway", "cg-mitm-adapter-state.json"),
    ...(masterKey ? { masterKey } : {})
  };
}
