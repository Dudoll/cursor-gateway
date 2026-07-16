/**
 * Resolve enroll accountAuth → accountId (relay-P1).
 * Prefer OIDC / CF Access / Passkey; api-key remains transition-scoped.
 */
import type { CgAccountAuth, CgDeviceCertV2 } from "@cursor-gateway/shared";
import { matchApiKey } from "./protocol.js";

export type ResolvedAccount = {
  accountId: string;
  authScope: CgDeviceCertV2["authScope"];
  keyIdHint: string;
};

function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length < 2) throw new Error("enroll_token_malformed");
  const json = Buffer.from(parts[1]!, "base64url").toString("utf8");
  const payload = JSON.parse(json) as Record<string, unknown>;
  if (typeof payload.exp === "number" && payload.exp * 1000 < Date.now() - 60_000) {
    throw new Error("enroll_token_expired");
  }
  return payload;
}

export function resolveAccountAuth(input: {
  accountAuth?: CgAccountAuth;
  apiKey?: string;
  apiKeys: Set<string>;
}): ResolvedAccount {
  const auth = input.accountAuth;
  if (auth?.kind === "api-key" || (!auth && input.apiKey)) {
    const apiKey = auth?.kind === "api-key" ? auth.apiKey : input.apiKey!;
    const keyId = matchApiKey(apiKey, input.apiKeys);
    if (!keyId) throw new Error("enroll_unauthorized");
    return {
      accountId: `apikey:${keyId}`,
      authScope: "api-key",
      keyIdHint: keyId
    };
  }
  if (auth?.kind === "oidc") {
    const payload = decodeJwtPayload(auth.idToken);
    const sub = typeof payload.sub === "string" ? payload.sub.trim() : "";
    if (!sub) throw new Error("enroll_oidc_sub_missing");
    return {
      accountId: `oidc:${sub}`,
      authScope: "oidc",
      keyIdHint: `oidc:${sub.slice(0, 48)}`
    };
  }
  if (auth?.kind === "cf-access") {
    const payload = decodeJwtPayload(auth.cfAccessJwt);
    const email =
      (typeof payload.email === "string" && payload.email) ||
      (typeof payload.sub === "string" && payload.sub) ||
      "";
    if (!email) throw new Error("enroll_cf_access_identity_missing");
    return {
      accountId: `cf:${email.toLowerCase()}`,
      authScope: "cf-access",
      keyIdHint: `cf:${email.toLowerCase().slice(0, 48)}`
    };
  }
  if (auth?.kind === "passkey") {
    if (!auth.accountId || !auth.credentialId) throw new Error("enroll_passkey_incomplete");
    // Full WebAuthn verification is delegated to existing passkeyPairing flows;
    // enroll accepts a bound accountId + credentialId assertion shape.
    if (!auth.assertion || typeof auth.assertion !== "object") {
      throw new Error("enroll_passkey_assertion_missing");
    }
    return {
      accountId: auth.accountId,
      authScope: "passkey",
      keyIdHint: `passkey:${auth.credentialId.slice(0, 48)}`
    };
  }
  throw new Error("enroll_unauthorized");
}
