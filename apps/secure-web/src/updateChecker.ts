import { desktopUpgradeTarget } from "./desktopShell.js";

export const DESKTOP_UPDATE_METADATA_URL =
  "https://secure.joelzt.org/desktop-version.json";

export type DesktopUpdateMetadata = {
  version: string;
  sha256: string;
  installerAvailable: boolean;
  downloadPath?: string;
};

export type DesktopUpdateDecision =
  | { kind: "available"; metadata: DesktopUpdateMetadata; attempts: number }
  | {
      kind: "hidden";
      reason: "current_or_older" | "installer_unavailable";
      metadata: DesktopUpdateMetadata;
      attempts: number;
    }
  | { kind: "failed"; code: string; attempts: number };

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Pick<Response, "ok" | "status" | "json">>;

function parseMetadata(value: unknown): DesktopUpdateMetadata {
  if (!value || typeof value !== "object") throw new Error("desktop_update_metadata_invalid");
  const input = value as Record<string, unknown>;
  if (
    typeof input.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(input.version)
  ) {
    throw new Error("desktop_update_version_invalid");
  }
  if (typeof input.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(input.sha256)) {
    throw new Error("desktop_update_hash_invalid");
  }
  if (typeof input.installerAvailable !== "boolean") {
    throw new Error("desktop_update_metadata_invalid");
  }
  const metadata: DesktopUpdateMetadata = {
    version: input.version,
    sha256: input.sha256.toLowerCase(),
    installerAvailable: input.installerAvailable
  };
  if (
    typeof input.downloadPath === "string" &&
    input.downloadPath.startsWith("/") &&
    !input.downloadPath.includes("?") &&
    !input.downloadPath.includes("#")
  ) {
    metadata.downloadPath = input.downloadPath;
  }
  return metadata;
}

const wait = (ms: number) => new Promise((resolve) => globalThis.setTimeout(resolve, ms));

export async function readPublicUpdateMetadata(input?: {
  url?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<DesktopUpdateMetadata> {
  const fetchImpl = input?.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), input?.timeoutMs ?? 8_000);
  try {
    const response = await fetchImpl(input?.url ?? DESKTOP_UPDATE_METADATA_URL, {
      cache: "no-store",
      credentials: "omit",
      signal: controller.signal,
      headers: { accept: "application/json" }
    });
    if (!response.ok) {
      throw new Error(
        response.status === 404
          ? "desktop_update_metadata_missing"
          : `desktop_update_metadata_http_${response.status}`
      );
    }
    return parseMetadata(await response.json());
  } catch (error) {
    if (controller.signal.aborted) throw new Error("desktop_update_check_timeout");
    throw error;
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

export async function checkDesktopUpdate(input: {
  localVersion: string;
  publicLoader?: () => Promise<DesktopUpdateMetadata>;
  authenticatedLoader?: () => Promise<unknown>;
  retryDelaysMs?: number[];
  sleep?: (ms: number) => Promise<void>;
}): Promise<DesktopUpdateDecision> {
  const delays = input.retryDelaysMs ?? [0, 2_000, 10_000];
  const sleep = input.sleep ?? wait;
  let lastCode = "desktop_update_check_failed";
  let attempts = 0;

  for (const delay of delays) {
    if (delay > 0) await sleep(delay);
    attempts += 1;
    let metadata: DesktopUpdateMetadata | null = null;
    try {
      metadata = parseMetadata(
        await (input.publicLoader ?? (() => readPublicUpdateMetadata()))()
      );
    } catch (error) {
      lastCode = error instanceof Error ? error.message : "desktop_update_check_failed";
      if (input.authenticatedLoader) {
        try {
          metadata = parseMetadata(await input.authenticatedLoader());
        } catch (fallbackError) {
          lastCode =
            fallbackError instanceof Error
              ? fallbackError.message
              : "desktop_update_check_failed";
        }
      }
    }
    if (!metadata) continue;

    const target = desktopUpgradeTarget({
      remoteVersion: metadata.version,
      localVersion: input.localVersion,
      installerAvailable: metadata.installerAvailable
    });
    if (target) return { kind: "available", metadata, attempts };
    return {
      kind: "hidden",
      reason: metadata.installerAvailable ? "current_or_older" : "installer_unavailable",
      metadata,
      attempts
    };
  }

  return { kind: "failed", code: lastCode, attempts };
}
