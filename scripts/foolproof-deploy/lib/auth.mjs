import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, chmodSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fingerprint } from "./secrets.mjs";

/**
 * @param {string} tokenPath
 */
export function ensureBootstrapToken(tokenPath) {
  mkdirSync(dirname(tokenPath), { recursive: true, mode: 0o700 });
  if (existsSync(tokenPath)) {
    const token = readFileSync(tokenPath, "utf8").trim();
    if (token.length >= 32) {
      return { token, created: false, fingerprint: fingerprint(token) };
    }
  }
  const token = randomBytes(32).toString("base64url");
  writeFileSync(tokenPath, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(tokenPath, 0o600);
  return { token, created: true, fingerprint: fingerprint(token) };
}

/**
 * @param {string} a
 * @param {string} b
 */
function safeEqual(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * @param {import("node:http").IncomingMessage} req
 */
function headerValue(req, name) {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Parse Cookie header into a map.
 * @param {string | undefined} header
 */
export function parseCookies(header) {
  /** @type {Record<string, string>} */
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    out[key] = decodeURIComponent(value);
  }
  return out;
}

/**
 * @param {string} secret
 * @param {Record<string, unknown>} payload
 * @param {number} ttlSec
 */
export function signSession(secret, payload, ttlSec = 8 * 3600) {
  const body = {
    ...payload,
    exp: Math.floor(Date.now() / 1000) + ttlSec
  };
  const data = Buffer.from(JSON.stringify(body)).toString("base64url");
  const sig = createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${sig}`;
}

/**
 * @param {string} secret
 * @param {string | undefined} token
 */
export function verifySession(secret, token) {
  if (!token || !token.includes(".")) return null;
  const [data, sig] = token.split(".");
  const expected = createHmac("sha256", secret).update(data).digest("base64url");
  if (!safeEqual(sig, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
    if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

/**
 * Auth for deploy wizard:
 * 1) Session cookie established after bootstrap token login, OR
 * 2) Cloudflare Access identity headers (when allowedEmails configured / any CF email if empty allow-all).
 *
 * @param {{
 *   req: import("node:http").IncomingMessage,
 *   bootstrapToken: string,
 *   sessionSecret: string,
 *   allowedEmails: Set<string>,
 *   trustCloudflareAccess: boolean
 * }} opts
 */
export function authenticate(opts) {
  const cookies = parseCookies(headerValue(opts.req, "cookie"));
  const session = verifySession(opts.sessionSecret, cookies.deploy_session);
  if (session?.auth === "bootstrap" || session?.auth === "cloudflare") {
    return {
      ok: true,
      method: session.auth,
      email: typeof session.email === "string" ? session.email : null,
      csrf: cookies.deploy_csrf || null
    };
  }

  const auth = headerValue(opts.req, "authorization");
  if (auth?.startsWith("Bearer ") && safeEqual(auth.slice(7), opts.bootstrapToken)) {
    return { ok: true, method: "bootstrap-bearer", email: null, csrf: cookies.deploy_csrf || null };
  }

  if (opts.trustCloudflareAccess) {
    const email = headerValue(opts.req, "cf-access-authenticated-user-email")?.toLowerCase();
    if (email) {
      if (opts.allowedEmails.size === 0 || opts.allowedEmails.has(email)) {
        return { ok: true, method: "cloudflare", email, csrf: cookies.deploy_csrf || null };
      }
      return { ok: false, error: "email_not_allowed" };
    }
  }

  return { ok: false, error: "unauthorized" };
}

/**
 * Double-submit CSRF: cookie `deploy_csrf` must match header `x-csrf-token`.
 * @param {import("node:http").IncomingMessage} req
 * @param {string | null | undefined} csrfCookie
 */
export function requireCsrf(req, csrfCookie) {
  const header = headerValue(req, "x-csrf-token");
  if (!csrfCookie || !header || !safeEqual(csrfCookie, header)) {
    return false;
  }
  return true;
}

export function newCsrfToken() {
  return randomBytes(24).toString("base64url");
}
