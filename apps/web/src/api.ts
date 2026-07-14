export class GatewayApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    super(code);
    this.name = "GatewayApiError";
  }
}

/**
 * Same-origin Gateway client for CS web (cs.joelzt.org proxies /api to Gateway).
 * Cross-origin Secure Web uses its own api.ts with an explicit gateway origin.
 */
export class GatewayApi {
  readonly origin: string;

  constructor(origin = typeof window !== "undefined" ? window.location.origin : "") {
    this.origin = origin.replace(/\/$/, "");
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
    const response = await fetch(path, {
      ...init,
      credentials: "include",
      cache: "no-store",
      redirect: "manual",
      headers: {
        accept: "application/json",
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init?.headers ?? {})
      }
    });
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
