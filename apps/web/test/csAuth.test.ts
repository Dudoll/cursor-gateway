import assert from "node:assert/strict";
import test from "node:test";
import {
  clearPendingCsAuth,
  loadPendingCsAuth,
  savePendingCsAuth,
  type PendingCsAuth
} from "../src/csAuth.js";

test("pending CS auth session round-trip", () => {
  const pending: PendingCsAuth = {
    authId: "33333333-3333-4333-8333-333333333333",
    clientId: "cs-client-1",
    challenge: "IIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII",
    state: "JJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ",
    returnOrigin: "https://cs.example.test",
    gatewayOrigin: "https://cs.example.test",
    signingFingerprint: "sha256:KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK",
    encryptionFingerprint: "sha256:LLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLL",
    secureOrigin: "https://secure.example.test",
    createdAt: new Date().toISOString()
  };
  if (typeof sessionStorage === "undefined") {
    // Node test runner without DOM: helpers still export.
    assert.equal(typeof savePendingCsAuth, "function");
    return;
  }
  savePendingCsAuth(pending);
  assert.deepEqual(loadPendingCsAuth(), pending);
  clearPendingCsAuth();
  assert.equal(loadPendingCsAuth(), null);
});
