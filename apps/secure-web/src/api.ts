import {
  desktopBridgeFetch,
  isDesktopShell
} from "./desktopShell.js";

const GATEWAY_STORAGE_KEY = "cg-secure-web:gateway-origin";

export class GatewayApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    super(code);
    this.name = "GatewayApiError";
  }
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
    // Same-origin relative fetch when secure-web is reverse-proxied / access-bridged.
    // Cross-origin uses absolute gateway URL with credentials (requires CORS + Access cookie).
    // Desktop shell (tauri.localhost) is cross-site → proxy via Access bridge WebView.
    if (isDesktopShell()) {
      return this.requestViaDesktopBridge<T>(path, init);
    }

    const sameOrigin =
      typeof window !== "undefined" && window.location.origin === this.origin;
    const url = sameOrigin ? path : `${this.origin}${path}`;
    const response = await fetch(url, {
      ...init,
      credentials: "include",
      cache: "no-store",
      redirect: "manual",
      headers: {
        accept: "application/json",
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers ?? {})
      }
    });
    return this.parseJsonResponse<T>(response);
  }

  private async requestViaDesktopBridge<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = {
      accept: "application/json"
    };
    if (init.body) headers["content-type"] = "application/json";
    if (init.headers) {
      const h = new Headers(init.headers);
      h.forEach((value, key) => {
        headers[key] = value;
      });
    }

    let result: Awaited<ReturnType<typeof desktopBridgeFetch>>;
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
        throw new GatewayApiError(401, "cloudflare_login_required");
      }
      // Tauri's `invoke` rejects with a plain string when the Rust bridge
      // returns `Err(String)`. Re-throwing it raw let callers collapse the real
      // Access-bridge code into a generic "unknown_error". Wrap it so the true
      // reason (e.g. access_bridge_fetch_timeout) always survives.
      throw error instanceof Error ? error : new Error(code);
    }

    if (result.opaqueRedirect || result.status === 0) {
      throw new GatewayApiError(401, "cloudflare_login_required");
    }
    if (result.status < 200 || result.status >= 300) {
      let code = `http_${result.status}`;
      try {
        const value = JSON.parse(result.body) as { error?: unknown };
        if (typeof value.error === "string" && /^[a-z0-9_:-]{1,128}$/i.test(value.error)) {
          code = value.error;
        }
      } catch {
        // Never surface untrusted HTML/error bodies.
      }
      throw new GatewayApiError(result.status, code);
    }
    if (result.status === 204 || !result.body) return undefined as T;
    return JSON.parse(result.body) as T;
  }

  private async parseJsonResponse<T>(response: Response): Promise<T> {
    if (response.type === "opaqueredirect" || response.status === 0) {
      throw new GatewayApiError(401, "cloudflare_login_required");
    }
    if (!response.ok) {
      let code = `http_${response.status}`;
      try {
        const value = (await response.json()) as { error?: unknown };
        if (typeof value.error === "string" && /^[a-z0-9_:-]{1,128}$/i.test(value.error)) {
          code = value.error;
        }
      } catch {
        // Never surface untrusted HTML/error bodies.
      }
      throw new GatewayApiError(response.status, code);
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }
}
