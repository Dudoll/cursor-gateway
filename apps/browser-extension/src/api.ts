const GATEWAY_STORAGE_KEY = "cursor-gateway-secure:gateway-origin";

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

export async function requestGatewayPermission(origin: string) {
  const normalized = normalizeGatewayOrigin(origin);
  const pattern = `${normalized}/*`;
  if (await chrome.permissions.contains({ origins: [pattern] })) return true;
  return chrome.permissions.request({ origins: [pattern] });
}

export async function openGatewayLogin(origin: string) {
  await chrome.tabs.create({ url: `${normalizeGatewayOrigin(origin)}/` });
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
    const response = await fetch(`${this.origin}${path}`, {
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
        // Never surface an untrusted HTML/error body inside the trusted extension.
      }
      throw new GatewayApiError(response.status, code);
    }
    return response.json() as Promise<T>;
  }
}
