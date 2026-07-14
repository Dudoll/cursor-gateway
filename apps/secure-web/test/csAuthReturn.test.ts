import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCsAuthRedirectUrl,
  parseCsAuthRedirectSearch
} from "@cursor-gateway/e2ee";

test("secure-web CS auth redirect query shape", () => {
  const authId = "22222222-2222-4222-8222-222222222222";
  const challenge = "EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE";
  const state = "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF";
  const url = buildCsAuthRedirectUrl("https://secure.example.test/", {
    authId,
    clientId: "client-from-cs",
    challenge,
    state,
    returnOrigin: "https://cs.example.test",
    signingFingerprint: "sha256:GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG",
    encryptionFingerprint: "sha256:HHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH"
  });
  const parsed = parseCsAuthRedirectSearch(new URL(url).search);
  assert.ok(parsed);
  assert.equal(parsed.authId, authId);
  assert.equal(parsed.clientId, "client-from-cs");
  assert.equal(parsed.returnOrigin, "https://cs.example.test");
});
