/**
 * Cloudflare Access / OIDC JWT verification for cg-mitm enroll (relay-P1).
 * Ported from apps/windows-runner/src/accessJwt.ts — full RS256 + JWKS + aud/iss/exp.
 * Never trust unsigned claims.
 */
type Jwk = {
  kid?: string;
  kty: string;
  n?: string;
  e?: string;
  alg?: string;
};

type JwtPayload = {
  aud?: string | string[];
  email?: string;
  iss?: string;
  exp?: number;
  nbf?: number;
  iat?: number;
  sub?: string;
};

function decodeSegment(segment: string): Uint8Array {
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/").padEnd(
    Math.ceil(segment.length / 4) * 4,
    "="
  );
  return new Uint8Array(Buffer.from(padded, "base64"));
}

function parseJwt(token: string): {
  header: { kid?: string; alg?: string };
  payload: JwtPayload;
  signingInput: string;
  signature: Uint8Array;
} {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("invalid_jwt_format");
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];
  const header = JSON.parse(Buffer.from(decodeSegment(headerB64)).toString("utf8")) as {
    kid?: string;
    alg?: string;
  };
  const payload = JSON.parse(Buffer.from(decodeSegment(payloadB64)).toString("utf8")) as JwtPayload;
  return {
    header,
    payload,
    signingInput: `${headerB64}.${payloadB64}`,
    signature: decodeSegment(signatureB64)
  };
}

async function importRsaJwk(jwk: Jwk): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    jwk as JsonWebKey,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
}

const jwksCache = new Map<string, { fetchedAt: number; keys: Jwk[] }>();

async function fetchJwks(jwksUrl: string): Promise<Jwk[]> {
  const now = Date.now();
  const hit = jwksCache.get(jwksUrl);
  if (hit && now - hit.fetchedAt < 60 * 60_000) return hit.keys;
  const response = await fetch(jwksUrl, { redirect: "manual" });
  if (!response.ok) throw new Error(`jwks_fetch_failed_${response.status}`);
  const body = (await response.json()) as { keys?: Jwk[] };
  const keys = body.keys ?? [];
  jwksCache.set(jwksUrl, { fetchedAt: now, keys });
  return keys;
}

export type JwtVerifyResult =
  | { ok: true; email?: string; sub: string }
  | { ok: false; reason: string };

/** Verify RS256 JWT against JWKS with mandatory aud/iss/exp. */
export async function verifyRs256Jwt(input: {
  token: string;
  jwksUrl: string;
  issuer: string;
  audience: string;
  allowedEmails?: Set<string>;
  requireEmail?: boolean;
}): Promise<JwtVerifyResult> {
  try {
    const parsed = parseJwt(input.token);
    if (parsed.header.alg !== "RS256") return { ok: false, reason: "jwt_alg_unsupported" };
    if (!parsed.header.kid) return { ok: false, reason: "jwt_kid_missing" };
    const keys = await fetchJwks(input.jwksUrl);
    const jwk = keys.find((key) => key.kid === parsed.header.kid);
    if (!jwk) return { ok: false, reason: "jwt_jwk_missing" };
    const key = await importRsaJwk(jwk);
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      parsed.signature as BufferSource,
      new TextEncoder().encode(parsed.signingInput)
    );
    if (!valid) return { ok: false, reason: "jwt_signature_invalid" };

    const now = Math.floor(Date.now() / 1000);
    if (typeof parsed.payload.exp !== "number") return { ok: false, reason: "jwt_exp_missing" };
    if (parsed.payload.exp < now) return { ok: false, reason: "jwt_expired" };
    if (typeof parsed.payload.nbf === "number" && parsed.payload.nbf > now + 60) {
      return { ok: false, reason: "jwt_not_yet_valid" };
    }
    if (typeof parsed.payload.iat === "number" && parsed.payload.iat > now + 60) {
      return { ok: false, reason: "jwt_iat_in_future" };
    }
    if (!parsed.payload.sub || typeof parsed.payload.sub !== "string") {
      return { ok: false, reason: "jwt_sub_missing" };
    }
    const expectedIss = input.issuer.replace(/\/$/, "");
    if (parsed.payload.iss !== expectedIss && parsed.payload.iss !== input.issuer) {
      return { ok: false, reason: "jwt_iss_mismatch" };
    }
    const aud = parsed.payload.aud;
    const audOk = Array.isArray(aud)
      ? aud.includes(input.audience)
      : aud === input.audience;
    if (!audOk) return { ok: false, reason: "jwt_aud_mismatch" };

    const email = parsed.payload.email?.toLowerCase();
    if (input.requireEmail !== false && !email) {
      return { ok: false, reason: "jwt_email_missing" };
    }
    if (email && input.allowedEmails && input.allowedEmails.size > 0 && !input.allowedEmails.has(email)) {
      return { ok: false, reason: "jwt_email_not_allowed" };
    }
    return { ok: true, ...(email ? { email } : {}), sub: parsed.payload.sub };
  } catch {
    return { ok: false, reason: "jwt_verify_failed" };
  }
}

/** Cloudflare Access JWT (team domain JWKS). Fail-closed when team/aud unset. */
export async function verifyCloudflareAccessJwt(input: {
  token: string;
  teamDomain: string;
  audience: string;
  allowedEmails?: Set<string>;
}): Promise<JwtVerifyResult> {
  if (!input.teamDomain.trim() || !input.audience.trim()) {
    return { ok: false, reason: "cf_access_verification_not_configured" };
  }
  const team = input.teamDomain.replace(/\/$/, "");
  return verifyRs256Jwt({
    token: input.token,
    jwksUrl: `${team}/cdn-cgi/access/certs`,
    issuer: team,
    audience: input.audience,
    ...(input.allowedEmails ? { allowedEmails: input.allowedEmails } : {}),
    requireEmail: true
  });
}

/** Generic OIDC id_token verification. Fail-closed when jwks/iss/aud unset. */
export async function verifyOidcIdToken(input: {
  token: string;
  jwksUrl: string;
  issuer: string;
  audience: string;
  allowedEmails?: Set<string>;
}): Promise<JwtVerifyResult> {
  if (!input.jwksUrl.trim() || !input.issuer.trim() || !input.audience.trim()) {
    return { ok: false, reason: "oidc_verification_not_configured" };
  }
  return verifyRs256Jwt({
    token: input.token,
    jwksUrl: input.jwksUrl,
    issuer: input.issuer,
    audience: input.audience,
    ...(input.allowedEmails ? { allowedEmails: input.allowedEmails } : {}),
    requireEmail: false
  });
}
