import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCsAuthRedirectUrl,
  parseCsAuthRedirectSearch
} from "@cursor-gateway/e2ee";
import {
  CS_AUTH_RETURNING_DELAY_MS,
  CS_AUTH_RETURNING_NOTICE,
  CS_AUTH_RETURN_TTL_MS,
  PENDING_CS_AUTH_KEY,
  buildStoredCsAuthReturn,
  captureCsAuthRedirectParams,
  clearPendingCsAuthRedirect,
  delayBeforeCsRedirect,
  formatCsAuthReturnError,
  loadPendingCsAuthRedirect,
  markPendingCsAuthRedirectConsumed,
  parseStoredCsAuthReturn,
  savePendingCsAuthRedirect,
  type CsAuthStorage
} from "../src/csAuthReturn.js";

function memoryStorage(): CsAuthStorage & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    getItem(key) {
      return store.has(key) ? store.get(key)! : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
    }
  };
}

const sampleParams = () => {
  const authId = "22222222-2222-4222-8222-222222222222";
  const challenge = "EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE";
  const state = "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF";
  return {
    authId,
    clientId: "client-from-cs",
    challenge,
    state,
    returnOrigin: "https://cs.example.test",
    signingFingerprint: "sha256:GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG",
    encryptionFingerprint: "sha256:HHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH"
  };
};

test("secure-web CS auth redirect query shape", () => {
  const params = sampleParams();
  const url = buildCsAuthRedirectUrl("https://secure.example.test/", params);
  const parsed = parseCsAuthRedirectSearch(new URL(url).search);
  assert.ok(parsed);
  assert.equal(parsed.authId, params.authId);
  assert.equal(parsed.clientId, "client-from-cs");
  assert.equal(parsed.returnOrigin, "https://cs.example.test");
});

test("persist CS return context to session+local with TTL", () => {
  const session = memoryStorage();
  const local = memoryStorage();
  const params = sampleParams();
  const now = 1_000_000;
  savePendingCsAuthRedirect(params, { now, session, local });

  const loaded = loadPendingCsAuthRedirect({ now, session, local });
  assert.deepEqual(loaded, params);

  // Cross-tab: only localStorage (Gmail opened another tab in same browser).
  const otherTabSession = memoryStorage();
  const fromLocalOnly = loadPendingCsAuthRedirect({
    now,
    session: otherTabSession,
    local
  });
  assert.deepEqual(fromLocalOnly, params);
});

test("expired CS return context is cleared and not returned", () => {
  const session = memoryStorage();
  const local = memoryStorage();
  const params = sampleParams();
  const now = 1_000_000;
  savePendingCsAuthRedirect(params, { now, session, local, ttlMs: 5_000 });

  assert.equal(
    loadPendingCsAuthRedirect({ now: now + 5_001, session, local }),
    null
  );
  assert.equal(session.getItem(PENDING_CS_AUTH_KEY), null);
  assert.equal(local.getItem(PENDING_CS_AUTH_KEY), null);
});

test("consumed CS return context is single-use", () => {
  const session = memoryStorage();
  const local = memoryStorage();
  const params = sampleParams();
  const now = 1_000_000;
  savePendingCsAuthRedirect(params, { now, session, local });
  markPendingCsAuthRedirectConsumed({ now, session, local });
  assert.equal(loadPendingCsAuthRedirect({ now, session, local }), null);
});

test("capture from search persists and load works without URL", () => {
  const session = memoryStorage();
  const local = memoryStorage();
  const params = sampleParams();
  const url = buildCsAuthRedirectUrl("https://secure.example.test/", params);
  const search = new URL(url).search;
  let replaced: string | null = null;

  const captured = captureCsAuthRedirectParams({
    search,
    session,
    local,
    replaceUrl: (next) => {
      replaced = next;
    }
  });
  assert.deepEqual(captured, params);
  assert.equal(replaced, "/");

  // Simulate magic-link tab: no query, fresh sessionStorage, shared localStorage.
  const magicSession = memoryStorage();
  const restored = loadPendingCsAuthRedirect({
    session: magicSession,
    local
  });
  assert.deepEqual(restored, params);
});

test("without return context Secure stays independent (null load)", () => {
  const session = memoryStorage();
  const local = memoryStorage();
  assert.equal(loadPendingCsAuthRedirect({ session, local }), null);
  clearPendingCsAuthRedirect({ session, local });
  assert.equal(loadPendingCsAuthRedirect({ session, local }), null);
});

test("pairing-complete decision: with context must redirect intent", () => {
  const session = memoryStorage();
  const local = memoryStorage();
  const params = sampleParams();
  savePendingCsAuthRedirect(params, { session, local });

  // Mirrors App finishPairingThenMaybeReturnToCs gate.
  const pending = loadPendingCsAuthRedirect({ session, local });
  assert.ok(pending, "valid return context requires CS grant+redirect");
  assert.equal(pending.returnOrigin, "https://cs.example.test");
});

test("pairing-complete decision: without context keep Secure chat", () => {
  const session = memoryStorage();
  const local = memoryStorage();
  const pending = loadPendingCsAuthRedirect({ session, local });
  assert.equal(pending, null, "no context → Secure independent chat");
});

test("parseStoredCsAuthReturn rejects expired and consumed", () => {
  const params = sampleParams();
  const now = 10_000;
  const fresh = buildStoredCsAuthReturn(params, now, CS_AUTH_RETURN_TTL_MS);
  assert.equal(parseStoredCsAuthReturn(JSON.stringify(fresh), now).ok, true);

  const expired = { ...fresh, expiresAt: now - 1 };
  assert.equal(
    parseStoredCsAuthReturn(JSON.stringify(expired), now).reason,
    "expired"
  );

  const consumed = { ...fresh, consumed: true };
  assert.equal(
    parseStoredCsAuthReturn(JSON.stringify(consumed), now).reason,
    "consumed"
  );

  // Legacy bare params still accepted.
  assert.equal(parseStoredCsAuthReturn(JSON.stringify(params), now).ok, true);
});

test("Chinese error messages for missing/expired CS return", () => {
  assert.match(
    formatCsAuthReturnError(new Error("cs_auth_return_context_missing")),
    /缺少 CS 回跳上下文|启用加密/
  );
  assert.match(
    formatCsAuthReturnError(new Error("cs_auth_return_context_expired")),
    /过期|启用加密/
  );
  assert.match(
    formatCsAuthReturnError(new Error("cs_auth_expired")),
    /过期|启用加密/
  );
  assert.match(
    formatCsAuthReturnError(new Error("cs_auth_grant_timeout")),
    /超时|启用加密/
  );
});

test("CS returning notice is Chinese and delay is brief", async () => {
  assert.match(CS_AUTH_RETURNING_NOTICE, /验证完成.*即将跳转回原页面/);
  assert.ok(CS_AUTH_RETURNING_DELAY_MS >= 300);
  assert.ok(CS_AUTH_RETURNING_DELAY_MS <= 800);
  const started = Date.now();
  await delayBeforeCsRedirect(50);
  assert.ok(Date.now() - started >= 45);
});

test("pairing-complete copy: redirect notice only with CS context", () => {
  // Mirrors App finishPairingThenMaybeReturnToCs: no pending → 已配对 only.
  const session = memoryStorage();
  const local = memoryStorage();
  const pending = loadPendingCsAuthRedirect({ session, local });
  assert.equal(pending, null);
  assert.doesNotMatch(CS_AUTH_RETURNING_NOTICE, /已配对/);
});
