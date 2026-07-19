import { desktopUpgradeTarget } from "./desktopShell.js";
import { abortableSleep } from "./accessRetry.js";

export const DESKTOP_UPDATE_METADATA_URL =
  "https://raw.githubusercontent.com/Dudoll/cursor-gateway/main/apps/secure-web/public/desktop-version.json";

export type DesktopUpdateMetadata = {
  schemaVersion: 1;
  version: string;
  sha256: string;
  installerAvailable: boolean;
  installerUrl: string;
  publishedAt: string;
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
) => Promise<Pick<Response, "ok" | "status" | "headers" | "text">>;

export function parseDesktopUpdateMetadata(value: unknown): DesktopUpdateMetadata {
  if (!value || typeof value !== "object") throw new Error("desktop_update_metadata_invalid");
  const input = value as Record<string, unknown>;
  if (input.schemaVersion !== 1) {
    throw new Error("desktop_update_schema_unsupported");
  }
  if (
    typeof input.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(input.version)
  ) {
    throw new Error("desktop_update_version_invalid");
  }
  if (input.sha256 === undefined || input.sha256 === null || input.sha256 === "") {
    throw new Error("desktop_update_hash_missing");
  }
  if (typeof input.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(input.sha256)) {
    throw new Error("desktop_update_hash_invalid");
  }
  if (typeof input.installerAvailable !== "boolean") {
    throw new Error("desktop_update_metadata_invalid");
  }
  const metadata: DesktopUpdateMetadata = {
    schemaVersion: 1,
    version: input.version,
    sha256: input.sha256.toLowerCase(),
    installerAvailable: input.installerAvailable,
    installerUrl: "",
    publishedAt: ""
  };
  if (typeof input.installerUrl !== "string") {
    throw new Error("desktop_update_installer_url_missing");
  }
  let installerUrl: URL;
  try {
    installerUrl = new URL(input.installerUrl);
  } catch {
    throw new Error("desktop_update_installer_url_invalid");
  }
  if (
    installerUrl.protocol !== "https:" ||
    installerUrl.hostname !== "cs.joelzt.org" ||
    installerUrl.pathname !== "/api/desktop/download" ||
    installerUrl.username ||
    installerUrl.password ||
    installerUrl.search ||
    installerUrl.hash
  ) {
    throw new Error("desktop_update_installer_url_invalid");
  }
  if (
    typeof input.publishedAt !== "string" ||
    !Number.isFinite(Date.parse(input.publishedAt))
  ) {
    throw new Error("desktop_update_published_at_invalid");
  }
  metadata.installerUrl = installerUrl.toString();
  metadata.publishedAt = input.publishedAt;
  return metadata;
}

export async function readPublicUpdateMetadata(input?: {
  url?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<DesktopUpdateMetadata> {
  const fetchImpl = input?.fetchImpl ?? fetch;
  const controller = new AbortController();
  const source = new URL(input?.url ?? DESKTOP_UPDATE_METADATA_URL);
  if (!input?.url) {
    source.searchParams.set("v", String(Math.floor(Date.now() / 300_000)));
  }
  const abortFromParent = () => controller.abort();
  input?.signal?.addEventListener("abort", abortFromParent, { once: true });
  const timeout = globalThis.setTimeout(() => controller.abort(), input?.timeoutMs ?? 8_000);
  try {
    const response = await fetchImpl(source, {
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
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    const body = await response.text();
    if (/^\s*</.test(body)) throw new Error("desktop_update_html_fallback");
    const allowedContentType =
      contentType.includes("application/json") ||
      (source.hostname === "raw.githubusercontent.com" && contentType.includes("text/plain"));
    if (!allowedContentType) throw new Error("desktop_update_content_type_invalid");
    let decoded: unknown;
    try {
      decoded = JSON.parse(body);
    } catch {
      throw new Error("desktop_update_json_invalid");
    }
    return parseDesktopUpdateMetadata(decoded);
  } catch (error) {
    if (input?.signal?.aborted) throw new Error("desktop_update_check_cancelled");
    if (controller.signal.aborted) throw new Error("desktop_update_check_timeout");
    throw error;
  } finally {
    globalThis.clearTimeout(timeout);
    input?.signal?.removeEventListener("abort", abortFromParent);
  }
}

export async function checkDesktopUpdate(input: {
  localVersion: string;
  publicLoader?: () => Promise<DesktopUpdateMetadata>;
  authenticatedLoader?: () => Promise<unknown>;
  retryDelaysMs?: number[];
  signal?: AbortSignal;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  onAttempt?: (event: { attempt: number; code: string | null }) => void;
}): Promise<DesktopUpdateDecision> {
  const delays = input.retryDelaysMs ?? [0, 2_000, 10_000];
  const sleep = input.sleep ?? abortableSleep;
  let lastCode = "desktop_update_check_failed";
  let attempts = 0;

  for (const delay of delays) {
    if (input.signal?.aborted) {
      return { kind: "failed", code: "desktop_update_check_cancelled", attempts };
    }
    if (delay > 0) await sleep(delay, input.signal);
    attempts += 1;
    let metadata: DesktopUpdateMetadata | null = null;
    try {
      metadata = parseDesktopUpdateMetadata(
        await (
          input.publicLoader ??
          (() =>
            readPublicUpdateMetadata({
              ...(input.signal ? { signal: input.signal } : {})
            }))
        )()
      );
    } catch (error) {
      lastCode = error instanceof Error ? error.message : "desktop_update_check_failed";
      if (input.authenticatedLoader) {
        try {
          metadata = parseDesktopUpdateMetadata(await input.authenticatedLoader());
        } catch (fallbackError) {
          lastCode =
            fallbackError instanceof Error
              ? fallbackError.message
              : "desktop_update_check_failed";
        }
      }
    }
    input.onAttempt?.({ attempt: attempts, code: metadata ? null : lastCode });
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
