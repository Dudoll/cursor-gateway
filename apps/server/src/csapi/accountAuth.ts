/**
 * Resolve enroll accountAuth → accountId (relay-P1).
 * Full signature verification for CF Access / OIDC; WebAuthn UV+challenge for passkey.
 * Never trusts unsigned JWT claims.
 */
import type { CgAccountAuth, CgDeviceCertV2 } from "@cursor-gateway/shared";
import { config as appConfig } from "../config.js";
import { matchApiKey } from "./protocol.js";
import { verifyCloudflareAccessJwt, verifyOidcIdToken } from "./jwtVerify.js";
import { verifyCgPasskeyAssertion } from "./passkeyEnroll.js";

export type ResolvedAccount = {
  accountId: string;
  authScope: CgDeviceCertV2["authScope"];
  keyIdHint: string;
};

export type AccountAuthContext = {
  apiKeys: Set<string>;
  /** Explicitly allow enrollment with a valid CSAPI key. */
  allowApiKeyEnroll?: boolean;
};

export async function resolveAccountAuth(input: {
  accountAuth?: CgAccountAuth;
  apiKey?: string;
  apiKeys: Set<string>;
  allowApiKeyEnroll?: boolean;
}): Promise<ResolvedAccount> {
  const auth = input.accountAuth;
  const allowApiKey = input.allowApiKeyEnroll === true;

  if (auth?.kind === "api-key" || (!auth && input.apiKey)) {
    if (!allowApiKey) {
      throw new Error("enroll_api_key_disabled_in_production");
    }
    const apiKey = auth?.kind === "api-key" ? auth.apiKey : input.apiKey!;
    const keyId = matchApiKey(apiKey, input.apiKeys);
    if (!keyId) throw new Error("enroll_unauthorized");
    return {
      accountId: `apikey:${keyId}`,
      authScope: "api-key",
      keyIdHint: keyId
    };
  }

  if (auth?.kind === "cf-access") {
    const audience =
      appConfig.csRelay.cfAccessAudience ||
      [...appConfig.allowedCloudflareAud][0] ||
      "";
    const check = await verifyCloudflareAccessJwt({
      token: auth.cfAccessJwt,
      teamDomain: appConfig.cfAccessTeamDomain,
      audience,
      allowedEmails: appConfig.allowedEmails
    });
    if (!check.ok) throw new Error(check.reason);
    const email = check.email!;
    return {
      accountId: `cf:${email}`,
      authScope: "cf-access",
      keyIdHint: `cf:${email.slice(0, 48)}`
    };
  }

  if (auth?.kind === "oidc") {
    const check = await verifyOidcIdToken({
      token: auth.idToken,
      jwksUrl: appConfig.csRelay.oidcJwksUrl,
      issuer: appConfig.csRelay.oidcIssuer,
      audience: appConfig.csRelay.oidcAudience,
      allowedEmails: appConfig.allowedEmails
    });
    if (!check.ok) throw new Error(check.reason);
    return {
      accountId: `oidc:${check.sub}`,
      authScope: "oidc",
      keyIdHint: `oidc:${check.sub.slice(0, 48)}`
    };
  }

  if (auth?.kind === "passkey") {
    if (!auth.challengeId) throw new Error("enroll_passkey_challenge_missing");
    if (!auth.credentialId) throw new Error("enroll_passkey_incomplete");
    if (!auth.assertion || typeof auth.assertion !== "object") {
      throw new Error("enroll_passkey_assertion_missing");
    }
    const verified = await verifyCgPasskeyAssertion({
      challengeId: auth.challengeId,
      credentialId: auth.credentialId,
      assertion: auth.assertion,
      expectedAccountId: auth.accountId || null
    });
    return {
      accountId: verified.accountId,
      authScope: "passkey",
      keyIdHint: `passkey:${auth.credentialId.slice(0, 48)}`
    };
  }

  throw new Error("enroll_unauthorized");
}
