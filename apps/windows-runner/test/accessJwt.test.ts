import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync, createSign } from "node:crypto";
import { verifyAccessJwt } from "../src/accessJwt.js";

function b64url(data: Buffer | string): string {
  return Buffer.from(data)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function signJwt(
  privateKeyPem: string,
  header: Record<string, unknown>,
  payload: Record<string, unknown>
): string {
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  return `${signingInput}.${b64url(signer.sign(privateKeyPem))}`;
}

test("verifyAccessJwt accepts valid RS256 token and rejects bad aud/iss/exp/kid", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const jwk = publicKey.export({ format: "jwk" }) as {
    kty: string;
    n?: string;
    e?: string;
  };
  const kid = "test-kid-1";
  const teamDomain = "https://example.cloudflareaccess.com";
  const audience = "aud-test-123";
  const now = Math.floor(Date.now() / 1000);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ keys: [{ ...jwk, kid, alg: "RS256" }] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    })) as typeof fetch;

  try {
    const good = signJwt(
      privatePem,
      { alg: "RS256", kid },
      {
        aud: audience,
        iss: teamDomain,
        email: "user@example.com",
        sub: "sub-1",
        exp: now + 600,
        iat: now,
        nbf: now - 10
      }
    );
    const ok = await verifyAccessJwt({
      token: good,
      teamDomain,
      audience,
      allowedEmails: new Set()
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.email, "user@example.com");

    const badAud = signJwt(
      privatePem,
      { alg: "RS256", kid },
      {
        aud: "wrong",
        iss: teamDomain,
        email: "user@example.com",
        sub: "sub-1",
        exp: now + 600,
        iat: now
      }
    );
    assert.equal(
      (
        await verifyAccessJwt({
          token: badAud,
          teamDomain,
          audience,
          allowedEmails: new Set()
        })
      ).reason,
      "access_jwt_aud_mismatch"
    );

    const badIss = signJwt(
      privatePem,
      { alg: "RS256", kid },
      {
        aud: audience,
        iss: "https://evil.example",
        email: "user@example.com",
        sub: "sub-1",
        exp: now + 600,
        iat: now
      }
    );
    assert.equal(
      (
        await verifyAccessJwt({
          token: badIss,
          teamDomain,
          audience,
          allowedEmails: new Set()
        })
      ).reason,
      "access_jwt_iss_mismatch"
    );

    const expired = signJwt(
      privatePem,
      { alg: "RS256", kid },
      {
        aud: audience,
        iss: teamDomain,
        email: "user@example.com",
        sub: "sub-1",
        exp: now - 10,
        iat: now - 100
      }
    );
    assert.equal(
      (
        await verifyAccessJwt({
          token: expired,
          teamDomain,
          audience,
          allowedEmails: new Set()
        })
      ).reason,
      "access_jwt_expired"
    );

    const wrongKid = signJwt(
      privatePem,
      { alg: "RS256", kid: "other-kid" },
      {
        aud: audience,
        iss: teamDomain,
        email: "user@example.com",
        sub: "sub-1",
        exp: now + 600,
        iat: now
      }
    );
    assert.equal(
      (
        await verifyAccessJwt({
          token: wrongKid,
          teamDomain,
          audience,
          allowedEmails: new Set()
        })
      ).reason,
      "access_jwt_jwk_missing"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
