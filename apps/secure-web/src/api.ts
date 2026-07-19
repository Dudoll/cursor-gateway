import {
  desktopBridgeFetch,
  desktopLogDiagnostic,
  isDesktopShell
} from "./desktopShell.js";

const GATEWAY_STORAGE_KEY = "cg-secure-web:gateway-origin";

export class GatewayApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly endpoint: string | null = null,
    readonly requestId: string | null = null
  ) {
    super(code);
    this.name = "GatewayApiError";
  }
}

const API_TIMEOUT_MS = 30_000;

function requestId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `cg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function safeRequestId(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,96}$/.test(value) ? value : null;
}

function logDesktopGatewayRequest(input: {
  operation: string;
  endpoint: string;
  errorCode: string;
  clientRequestId: string;
  requestId?: string | null;
  httpStatus?: number;
}) {
  void desktopLogDiagnostic({
    stage: "gateway-request",
    operation: input.operation,
    endpoint: input.endpoint,
    errorCode: input.errorCode,
    clientRequestId: input.clientRequestId,
    ...(input.requestId ? { requestId: input.requestId } : {}),
    ...(input.httpStatus !== undefined ? { httpStatus: input.httpStatus } : {})
  }).catch(() => {
    // Request diagnostics are best-effort.
  });
}

export function normalizeGatewayOrigin(value: string) {
  const url = new URL(value.trim());
  const isLocal =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(isLocal && url.protocol === "http:")) {
    throw new Error("Gateway must use HTTPS (HTTP is allowed only for localhost)");
  }
  if (url.username || url.password) throw new Error("Gateway URL cannot contain credentials");
  return url.origin;
}

export function savedGatewayOrigin() {
  return localStorage.getItem(GATEWAY_STORAGE_KEY) ?? "";
}

export function saveGatewayOrigin(value: string) {
  const origin = normalizeGatewayOrigin(value);
  localStorage.setItem(GATEWAY_STORAGE_KEY, origin);
  return origin;
}

export class GatewayApi {
  readonly origin: string;

  constructor(origin: string) {
    this.origin = normalizeGatewayOrigin(origin);
  }

  async get<T>(path: string): Promise<T> {
    return this.request<T>(path);
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, {
      method: "POST",
      body: JSON.stringify(body)
    });
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!path.startsWith("/")) throw new Error("gateway_path_must_be_absolute");
    // Same-origin relative fetch when secure-web is reverse-proxied / access-bridged.
    // Cross-origin uses absolute gateway URL with credentials (requires CORS + Access cookie).
    // Desktop shell (tauri.localhost) is cross-site → proxy via Access bridge WebView.
    if (isDesktopShell()) {
      return this.requestViaDesktopBridge<T>(path, init);
    }

    const sameOrigin =
      typeof window !== "undefined" && window.location.origin === this.origin;
    const url = sameOrigin ? path : `${this.origin}${path}`;
    const correlationId = requestId();
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort(), API_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        ...init,
        credentials: "include",
        cache: "no-store",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          accept: "application/json",
          "x-client-request-id": correlationId,
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...(init.headers ?? {})
        }
      });
      return await this.parseJsonResponse<T>(response, path, correlationId);
    } catch (error) {
      if (error instanceof GatewayApiError) throw error;
      if (controller.signal.aborted) {
        throw new GatewayApiError(0, "request_timeout", path, correlationId);
      }
      if (error instanceof TypeError) {
        throw new GatewayApiError(0, "network_unreachable", path, correlationId);
      }
      throw error;
    } finally {
      globalThis.clearTimeout(timeout);
    }
  }

  private async requestViaDesktopBridge<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = {
      accept: "application/json",
      "x-client-request-id": requestId()
    };
    if (init.body) headers["content-type"] = "application/json";
    if (init.headers) {
      const h = new Headers(init.headers);
      h.forEach((value, key) => {
        headers[key] = value;
      });
    }

    let result: Awaited<ReturnType<typeof desktopBridgeFetch>>;
    const operation = (init.method ?? "GET").toUpperCase();
    const endpoint = `${this.origin}${path}`;
    const clientRequestId = headers["x-client-request-id"]!;
    try {
      const bridgeInput: {
        gatewayOrigin: string;
        path: string;
        method?: string;
        headers?: Record<string, string>;
        body?: string;
      } = {
        gatewayOrigin: this.origin,
        path,
        method: init.method ?? "GET",
        headers
      };
      if (typeof init.body === "string") bridgeInput.body = init.body;
      result = await desktopBridgeFetch(bridgeInput);
    } catch (error) {
      const code = error instanceof Error ? error.message : String(error);
      if (code.includes("cloudflare_login_required")) {
        logDesktopGatewayRequest({
          operation,
          endpoint,
          errorCode: "cloudflare_login_required",
          clientRequestId,
          httpStatus: 401
        });
        throw new GatewayApiError(401, "cloudflare_login_required", path, headers["x-client-request-id"] ?? null);
      }
      // Tauri's `invoke` rejects with a plain string when the Rust bridge
      // returns `Err(String)`. Re-throwing it raw let callers collapse the real
      // Access-bridge code into a generic "unknown_error". Wrap it so the true
      // reason (e.g. access_bridge_fetch_timeout) always survives.
      const stable =
        code.includes("Failed to fetch") || code.includes("NetworkError")
          ? "network_unreachable"
          : code.split(":")[0] || "access_bridge_error";
      logDesktopGatewayRequest({
        operation,
        endpoint,
        errorCode: stable,
        clientRequestId
      });
      throw new GatewayApiError(
        0,
        stable,
        path,
        headers["x-client-request-id"] ?? null
      );
    }

    if (result.opaqueRedirect || result.status === 0) {
      logDesktopGatewayRequest({
        operation,
        endpoint,
        errorCode: "cloudflare_login_required",
        clientRequestId,
        ...(result.requestId ? { requestId: result.requestId } : {}),
        httpStatus: 401
      });
      throw new GatewayApiError(
        401,
        "cloudflare_login_required",
        path,
        result.requestId ?? headers["x-client-request-id"] ?? null
      );
    }
    if (result.status < 200 || result.status >= 300) {
      let code = `http_${result.status}`;
      let bodyRequestId: string | null = null;
      try {
        const value = JSON.parse(result.body) as { error?: unknown; requestId?: unknown };
        if (typeof value.error === "string" && /^[a-z0-9_:-]{1,128}$/i.test(value.error)) {
          code = value.error;
        }
        bodyRequestId = safeRequestId(value.requestId);
      } catch {
        // Never surface untrusted HTML/error bodies.
      }
      const responseRequestId = bodyRequestId ?? result.requestId;
      logDesktopGatewayRequest({
        operation,
        endpoint,
        errorCode: code,
        clientRequestId,
        ...(responseRequestId ? { requestId: responseRequestId } : {}),
        httpStatus: result.status
      });
      throw new GatewayApiError(
        result.status,
        code,
        path,
        bodyRequestId ?? result.requestId ?? headers["x-client-request-id"] ?? null
      );
    }
    logDesktopGatewayRequest({
      operation,
      endpoint,
      errorCode: "request_ok",
      clientRequestId,
      ...(result.requestId ? { requestId: result.requestId } : {}),
      httpStatus: result.status
    });
    if (result.status === 204 || !result.body) return undefined as T;
    try {
      return JSON.parse(result.body) as T;
    } catch {
      throw new GatewayApiError(
        result.status,
        "invalid_json_response",
        path,
        result.requestId ?? headers["x-client-request-id"] ?? null
      );
    }
  }

  private async parseJsonResponse<T>(
    response: Response,
    path: string,
    fallbackRequestId: string
  ): Promise<T> {
    const headerRequestId = safeRequestId(response.headers.get("x-request-id"));
    if (response.type === "opaqueredirect" || response.status === 0) {
      throw new GatewayApiError(
        401,
        "cloudflare_login_required",
        path,
        headerRequestId ?? fallbackRequestId
      );
    }
    if (!response.ok) {
      let code = `http_${response.status}`;
      let bodyRequestId: string | null = null;
      try {
        const value = (await response.json()) as { error?: unknown; requestId?: unknown };
        if (typeof value.error === "string" && /^[a-z0-9_:-]{1,128}$/i.test(value.error)) {
          code = value.error;
        }
        bodyRequestId = safeRequestId(value.requestId);
      } catch {
        // Never surface untrusted HTML/error bodies.
      }
      throw new GatewayApiError(
        response.status,
        code,
        path,
        bodyRequestId ?? headerRequestId ?? fallbackRequestId
      );
    }
    if (response.status === 204) return undefined as T;
    try {
      return (await response.json()) as T;
    } catch {
      throw new GatewayApiError(
        response.status,
        "invalid_json_response",
        path,
        headerRequestId ?? fallbackRequestId
      );
    }
  }
}
