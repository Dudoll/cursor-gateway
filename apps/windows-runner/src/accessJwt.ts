/**
 * Cloudflare Access JWT verification for runner-side pairing identity checks.
 * MVP: when CF_ACCESS_TEAM_DOMAIN + CF_ACCESS_AUD are unset, verification is skipped
 * (pairing still requires the high-entropy magic-link MAC). When set, validate
 * RS256 via JWKS and require email/aud/iss/exp.
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

function parseJwt(token: string): { header: { kid?: string; alg?: string }; payload: JwtPayload; signingInput: string; signature: Uint8Array } {
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

let cachedKeys: { fetchedAt: number; keys: Jwk[] } | null = null;

async function fetchJwks(teamDomain: string): Promise<Jwk[]> {
  const now = Date.now();
  if (cachedKeys && now - cachedKeys.fetchedAt < 60 * 60_000) return cachedKeys.keys;
  const url = `${teamDomain.replace(/\/$/, "")}/cdn-cgi/access/certs`;
  const response = await fetch(url, { redirect: "manual" });
  if (!response.ok) throw new Error(`jwks_fetch_failed_${response.status}`);
  const body = (await response.json()) as { keys?: Jwk[] };
  const keys = body.keys ?? [];
  cachedKeys = { fetchedAt: now, keys };
  return keys;
}

export type AccessJwtCheck = {
  ok: boolean;
  email?: string;
  sub?: string;
  reason?: string;
};

export async function verifyAccessJwt(input: {
  token: string | null | undefined;
  teamDomain: string | undefined;
  audience: string | undefined;
  allowedEmails: Set<string>;
}): Promise<AccessJwtCheck> {
  if (!input.teamDomain || !input.audience) {
    return { ok: true, reason: "access_jwt_verification_disabled" };
  }
  if (!input.token) {
    return { ok: false, reason: "access_jwt_missing" };
  }
  try {
    const parsed = parseJwt(input.token);
    if (parsed.header.alg !== "RS256") {
      return { ok: false, reason: "access_jwt_alg_unsupported" };
    }
    const keys = await fetchJwks(input.teamDomain);
    const jwk =
      keys.find((key) => key.kid && key.kid === parsed.header.kid) ?? keys[0];
    if (!jwk) return { ok: false, reason: "access_jwt_jwk_missing" };
    const key = await importRsaJwk(jwk);
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      parsed.signature as BufferSource,
      new TextEncoder().encode(parsed.signingInput)
    );
    if (!valid) return { ok: false, reason: "access_jwt_signature_invalid" };

    const now = Math.floor(Date.now() / 1000);
    if (typeof parsed.payload.exp === "number" && parsed.payload.exp < now) {
      return { ok: false, reason: "access_jwt_expired" };
    }
    if (typeof parsed.payload.nbf === "number" && parsed.payload.nbf > now + 60) {
      return { ok: false, reason: "access_jwt_not_yet_valid" };
    }
    if (parsed.payload.iss !== input.teamDomain.replace(/\/$/, "")) {
      // Also accept iss without trailing differences already normalized
      if (parsed.payload.iss !== input.teamDomain) {
        return { ok: false, reason: "access_jwt_iss_mismatch" };
      }
    }
    const aud = parsed.payload.aud;
    const audOk = Array.isArray(aud)
      ? aud.includes(input.audience)
      : aud === input.audience;
    if (!audOk) return { ok: false, reason: "access_jwt_aud_mismatch" };

    const email = parsed.payload.email?.toLowerCase();
    if (!email) return { ok: false, reason: "access_jwt_email_missing" };
    if (input.allowedEmails.size > 0 && !input.allowedEmails.has(email)) {
      return { ok: false, reason: "access_jwt_email_not_allowed" };
    }
    return {
      ok: true,
      email,
      ...(parsed.payload.sub ? { sub: parsed.payload.sub } : {})
    };
  } catch {
    return { ok: false, reason: "access_jwt_verify_failed" };
  }
}
