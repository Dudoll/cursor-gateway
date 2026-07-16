import assert from "node:assert/strict";
import test from "node:test";
import { resolveAccountAuth } from "../src/csapi/accountAuth.js";
import { truncateHistoryForRunner } from "../src/csapi/runnerSeal.js";

test("resolveAccountAuth api-key transition scope", () => {
  const keys = new Set(["deadbeefdeadbeefdeadbeefdeadbeef"]);
  const resolved = resolveAccountAuth({
    apiKey: "deadbeefdeadbeefdeadbeefdeadbeef",
    apiKeys: keys
  });
  assert.equal(resolved.authScope, "api-key");
  assert.equal(resolved.accountId.startsWith("apikey:"), true);
});

test("resolveAccountAuth oidc uses sub", () => {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ sub: "user-42", exp: Math.floor(Date.now() / 1000) + 3600 })
  ).toString("base64url");
  const resolved = resolveAccountAuth({
    accountAuth: { kind: "oidc", idToken: `${header}.${payload}.sig` },
    apiKeys: new Set()
  });
  assert.equal(resolved.accountId, "oidc:user-42");
  assert.equal(resolved.authScope, "oidc");
});

test("resolveAccountAuth rejects missing auth", () => {
  assert.throws(() => resolveAccountAuth({ apiKeys: new Set() }), /enroll_unauthorized/);
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
