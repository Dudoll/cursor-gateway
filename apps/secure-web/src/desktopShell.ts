/**
 * Desktop shell helpers (Tauri v2 + WebView2).
 *
 * The bundled Secure Web UI loads from http://tauri.localhost, which is
 * cross-site to the Gateway. Cloudflare Access cookies therefore do not ride
 * along with window.fetch. The shell opens a same-site Access bridge window
 * and proxies API calls through it.
 */

export type DesktopBridgeFetchResult = {
  status: number;
  body: string;
  contentType?: string | null;
  requestId?: string | null;
  opaqueRedirect: boolean;
};

export type DesktopDiagnosticEntry = {
  stage: string;
  operation: string;
  endpoint?: string;
  errorCode: string;
  clientRequestId?: string;
  requestId?: string;
  httpStatus?: number;
  retryAttempt?: number;
};

type TauriGlobal = {
  core?: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
  invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
};

function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const g = window as Window & { __TAURI__?: TauriGlobal; __TAURI_INTERNALS__?: TauriGlobal };
  const invoke =
    g.__TAURI__?.core?.invoke ??
    g.__TAURI__?.invoke ??
    g.__TAURI_INTERNALS__?.invoke;
  if (!invoke) {
    return Promise.reject(new Error("desktop_shell_unavailable"));
  }
  return invoke(cmd, args) as Promise<T>;
}

/** True when running inside the Cursor Gateway Tauri shell. */
export function isDesktopShell(): boolean {
  if (typeof window === "undefined") return false;
  const g = window as Window & { __TAURI__?: unknown; __TAURI_INTERNALS__?: unknown };
  return Boolean(g.__TAURI__ || g.__TAURI_INTERNALS__);
}

/** Service workers break Tauri custom-protocol asset loads (startup 404s). */
export function shouldRegisterServiceWorker(): boolean {
  return typeof navigator !== "undefined" && "serviceWorker" in navigator && !isDesktopShell();
}

export async function desktopAppVersion(): Promise<string> {
  const info = await tauriInvoke<{ version: string }>("desktop_app_version");
  return info.version;
}

export async function desktopLogDiagnostic(entry: DesktopDiagnosticEntry): Promise<void> {
  if (!isDesktopShell()) return;
  await tauriInvoke("desktop_log_diagnostic", { entry });
}

export async function desktopReadDiagnostics(limit = 100): Promise<
  Array<Record<string, unknown>>
> {
  if (!isDesktopShell()) return [];
  return tauriInvoke("desktop_read_diagnostics", { limit });
}

export async function desktopDiagnosticsPath(): Promise<string | null> {
  if (!isDesktopShell()) return null;
  return tauriInvoke<string>("desktop_diagnostics_path");
}

/** Open / reuse the Access bridge window and wait until CF Access has succeeded. */
export async function desktopAccessEnsure(gatewayOrigin: string): Promise<void> {
  await tauriInvoke("desktop_access_ensure", { gatewayOrigin });
}

/** Show the Access bridge window (user-visible login). */
export async function desktopAccessShow(gatewayOrigin: string): Promise<void> {
  await tauriInvoke("desktop_access_show", { gatewayOrigin });
}

export async function desktopBridgeFetch(input: {
  gatewayOrigin: string;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  binary?: boolean;
}): Promise<DesktopBridgeFetchResult> {
  const raw = await tauriInvoke<{
    status: number;
    body: string;
    contentType?: string | null;
    requestId?: string | null;
    opaqueRedirect: boolean;
  }>("desktop_bridge_fetch", {
    request: {
      gatewayOrigin: input.gatewayOrigin,
      path: input.path,
      method: input.method,
      headers: input.headers,
      body: input.body,
      binary: input.binary
    }
  });
  return {
    status: raw.status,
    body: raw.body,
    contentType: raw.contentType ?? null,
    requestId: raw.requestId ?? null,
    opaqueRedirect: raw.opaqueRedirect
  };
}

/**
 * Run WebAuthn inside the trusted HTTPS bridge instead of `tauri.localhost`.
 * WebAuthn requires the calling origin to be the RP ID or its subdomain.
 */
export async function desktopPerformPasskey(input: {
  passkeyOrigin: string;
  mode: "registration" | "authentication";
  options: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  return tauriInvoke<Record<string, unknown>>("desktop_perform_passkey", {
    request: {
      passkeyOrigin: input.passkeyOrigin,
      mode: input.mode,
      options: input.options
    }
  });
}

export async function desktopInstallUpdate(input: {
  gatewayOrigin: string;
  expectedVersion: string;
  expectedSha256: string;
}): Promise<void> {
  await tauriInvoke("desktop_install_update", {
    gatewayOrigin: input.gatewayOrigin,
    expectedVersion: input.expectedVersion,
    expectedSha256: input.expectedSha256
  });
}

/**
 * Decide whether the top-right upgrade icon should show.
 *
 * Requires a working installer on the server (`installerAvailable`) AND a
 * strictly newer remote version than the locally installed shell. Returns the
 * remote version to display when an upgrade is available, otherwise null.
 */
export function desktopUpgradeTarget(input: {
  remoteVersion?: string | null | undefined;
  localVersion: string;
  installerAvailable?: boolean | undefined;
}): string | null {
  const { remoteVersion, localVersion, installerAvailable } = input;
  if (!installerAvailable) return null;
  if (typeof remoteVersion !== "string" || remoteVersion.trim() === "") return null;
  return isNewerDesktopVersion(remoteVersion, localVersion) ? remoteVersion : null;
}

/** Compare dotted semver-like versions; returns true when remote > local. */
export function isNewerDesktopVersion(remote: string, local: string): boolean {
  const parse = (value: string) => {
    const core = value.trim().replace(/^v/i, "").split("-")[0] ?? "0";
    return core.split(".").map((part) => {
      const n = Number.parseInt(part, 10);
      return Number.isFinite(n) ? n : 0;
    });
  };
  const a = parse(remote);
  const b = parse(local);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left > right) return true;
    if (left < right) return false;
  }
  return false;
}
