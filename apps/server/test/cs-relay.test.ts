import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync } from "node:crypto";

process.env.JWT_SECRET ??= "test-jwt-secret-that-is-at-least-32-chars-long";
process.env.DATABASE_URL ??= "postgres://localhost:5432/test";
process.env.RUNNER_SHARED_SECRET ??= "test-runner-shared-secret-min-32-characters";
process.env.CS_RELAY_ALLOW_MEMORY_DEVICES ??= "true";

const { resolveAccountAuth } = await import("../src/csapi/accountAuth.js");
const { truncateHistoryForRunner } = await import("../src/csapi/runnerSeal.js");
const { verifyRs256Jwt } = await import("../src/csapi/jwtVerify.js");

test("resolveAccountAuth api-key transition scope", async () => {
  const keys = new Set(["deadbeefdeadbeefdeadbeefdeadbeef"]);
  const resolved = await resolveAccountAuth({
    apiKey: "deadbeefdeadbeefdeadbeefdeadbeef",
    apiKeys: keys,
    allowApiKeyTransition: true
  });
  assert.equal(resolved.authScope, "api-key");
  assert.equal(resolved.accountId.startsWith("apikey:"), true);
});

test("resolveAccountAuth rejects unsigned oidc without config", async () => {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ sub: "user-42", exp: Math.floor(Date.now() / 1000) + 3600 })
  ).toString("base64url");
  await assert.rejects(
    () =>
      resolveAccountAuth({
        accountAuth: { kind: "oidc", idToken: `${header}.${payload}.sig` },
        apiKeys: new Set()
      }),
    /oidc_verification_not_configured|jwt_/
  );
});

test("resolveAccountAuth rejects missing auth", async () => {
  await assert.rejects(() => resolveAccountAuth({ apiKeys: new Set() }), /enroll_unauthorized/);
});

test("truncateHistoryForRunner respects turn and byte budgets", () => {
  const turns = [
    { role: "user" as const, content: "a".repeat(100) },
    { role: "assistant" as const, content: "b".repeat(100) },
    { role: "user" as const, content: "c".repeat(100) },
    { role: "assistant" as const, content: "d".repeat(100) }
  ];
  const byTurns = truncateHistoryForRunner(turns, 2, 10_000);
  assert.equal(byTurns.length, 2);
  assert.equal(byTurns[0]!.content.startsWith("c"), true);

  const byBytes = truncateHistoryForRunner(turns, 20, 150);
  assert.ok(byBytes.length >= 1);
  assert.ok(byBytes.reduce((n, t) => n + t.content.length, 0) <= 150 + 100);
});

test("verifyRs256Jwt rejects tampered / wrong aud", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" }) as JsonWebKey & { kid?: string };
  jwk.kid = "test-kid";
  jwk.alg = "RS256";
  jwk.use = "sig";

  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "test-kid" })).toString(
    "base64url"
  );
  const payloadObj = {
    sub: "user-1",
    email: "a@example.com",
    iss: "https://idp.example",
    aud: "aud-1",
    exp: Math.floor(Date.now() / 1000) + 600
  };
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString("base64url");
  const signingInput = `${header}.${payload}`;
  const { createSign } = await import("node:crypto");
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(privateKey).toString("base64url");
  const token = `${signingInput}.${signature}`;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ keys: [jwk] }), { status: 200 })) as typeof fetch;
  try {
    const ok = await verifyRs256Jwt({
      token,
      jwksUrl: "https://idp.example/jwks",
      issuer: "https://idp.example",
      audience: "aud-1"
    });
    assert.equal(ok.ok, true);
    if (ok.ok) assert.equal(ok.email, "a@example.com");

    const badAud = await verifyRs256Jwt({
      token,
      jwksUrl: "https://idp.example/jwks",
      issuer: "https://idp.example",
      audience: "other-aud"
    });
    assert.equal(badAud.ok, false);

    const tampered = `${signingInput}.${signature.slice(0, -4)}aaaa`;
    const badSig = await verifyRs256Jwt({
      token: tampered,
      jwksUrl: "https://idp.example/jwks",
      issuer: "https://idp.example",
      audience: "aud-1"
    });
    assert.equal(badSig.ok, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
