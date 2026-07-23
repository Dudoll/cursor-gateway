import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = mkdtempSync(join(tmpdir(), "cursor-gateway-pairing-retry-"));
process.env.GATEWAY_URL = "https://gateway.test";
process.env.RUNNER_ID = "runner-retry-test";
process.env.RUNNER_SHARED_SECRET = "x".repeat(32);
process.env.RUNNER_WORKSPACES = root;
process.env.CURSOR_API_KEY = "cursor-test";
process.env.RUNNER_E2EE_ALLOW_INSECURE_DEV_STORAGE = "true";
process.env.RUNNER_E2EE_STATE_FILE = join(root, "runner-state.dat");
delete process.env.RUNNER_E2EE_MASTER_KEY;
delete process.env.RUNNER_E2EE_MASTER_KEY_FILE;
process.env.PAIRING_MAIL_MODE = "log";
process.env.PAIRING_MAIL_LOG_FILE = join(root, "pairing-mail.log");
process.env.PAIRING_MAIL_FROM = "no-reply@piallera.com";
process.env.SECURE_CLIENT_ORIGIN = "https://secure.example.com";
// Ensure PAIRING_MAIL_TO cannot leak into live pairing even if set.
process.env.PAIRING_MAIL_TO = "should-never-receive@example.com";

function sampleStart(pairId: string) {
  return {
    protocol: "cg-e2ee/1" as const,
    pairingKind: "secure-web-magic-link/1" as const,
    pairId,
    clientId: "client-retry-test",
    clientChallenge: "C".repeat(43),
    signingKey: {
      keyId: "signing-key-1",
      fingerprint: `sha256:${"A".repeat(43)}`,
      publicKey: { kty: "EC" as const, crv: "P-256" as const, x: "x".repeat(43), y: "y".repeat(43) }
    },
    encryptionKey: {
      keyId: "encrypt-key-1",
      fingerprint: `sha256:${"B".repeat(43)}`,
      publicKey: { kty: "EC" as const, crv: "P-256" as const, x: "u".repeat(43), y: "v".repeat(43) }
    },
    secureOrigin: "https://secure.example.com",
    gatewayOrigin: "https://gateway.example.com",
    createdAt: new Date().toISOString()
  };
}

test("offer publish failure does not resend mail; token reused on retry", async () => {
  const pairId = "22222222-2222-2222-2222-222222222222";
  const trusted = "access-user@example.com";
  const start = sampleStart(pairId);

  let claimCount = 0;
  let offerAttempts = 0;
  let mailLogWrites = 0;
  const tokensSeen: string[] = [];

  const { RunnerE2eeState } = await import("../src/e2eeState.js");
  const { processSecureWebPairingCycle, __testPendingPairings } = await import(
    "../src/secureWebPairing.js"
  );
  const { pairingMailLogPath } = await import("../src/pairingMail.js");

  // Clear any leftover pending from prior runs for this runner id.
  const store = __testPendingPairings();
  store.delete(pairId);

  const state = await RunnerE2eeState.loadOrCreate();
  const logPath = pairingMailLogPath();

  const gatewayFetch = async (path: string, init?: RequestInit) => {
    if (path.endsWith("/pairings/claim-start")) {
      claimCount += 1;
      return new Response(
        JSON.stringify({
          pairing: {
            pairId,
            status: "pending_start",
            start,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            recipientEmail: trusted
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (path.endsWith("/pairings/offer")) {
      offerAttempts += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        offer?: { pairId: string };
      };
      assert.equal(body.offer?.pairId, pairId);
      const pending = store.get(pairId);
      assert.ok(pending);
      tokensSeen.push(pending.token);
      if (offerAttempts === 1) {
        return new Response(JSON.stringify({ error: "temporary" }), { status: 503 });
      }
      return new Response(JSON.stringify({ status: "offer_ready" }), { status: 200 });
    }
    if (path.includes("claim-complete")) {
      return new Response(null, { status: 204 });
    }
    if (path.includes("pending-revocations")) {
      return new Response(JSON.stringify({ revocations: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
  };

  // First cycle: mail sent, offer fails.
  await assert.rejects(
    () => processSecureWebPairingCycle({ state, gatewayFetch }),
    /pairing_offer_publish_failed_503/
  );
  const afterFail = store.get(pairId);
  assert.ok(afterFail);
  assert.equal(afterFail.mailSent, true);
  assert.equal(afterFail.recipientEmail, trusted);
  assert.notEqual(afterFail.recipientEmail, process.env.PAIRING_MAIL_TO);

  const { readFileSync, existsSync } = await import("node:fs");
  assert.equal(existsSync(logPath), true);
  const log1 = readFileSync(logPath, "utf8");
  mailLogWrites = (log1.match(/---- /g) ?? []).length;
  assert.equal(mailLogWrites, 1);
  assert.match(log1, new RegExp(trusted.replace(".", "\\.")));
  assert.doesNotMatch(log1, /should-never-receive@example\.com/);

  // Second cycle: no new mail; same token; offer succeeds.
  await processSecureWebPairingCycle({ state, gatewayFetch });
  const log2 = readFileSync(logPath, "utf8");
  assert.equal((log2.match(/---- /g) ?? []).length, 1);
  assert.equal(tokensSeen.length, 2);
  assert.equal(tokensSeen[0], tokensSeen[1]);
  assert.equal(offerAttempts, 2);
  assert.ok(claimCount >= 2);

  // Cleanup pending file under homedir for this test runner id.
  store.delete(pairId);
  try {
    rmSync(join(homedir(), ".cursor-gateway", "pairing-pending-runner-retry-test.json"), {
      force: true
    });
  } catch {
    // ignore
  }
});

test("missing recipientEmail from claim-start is rejected without mailing", async () => {
  const pairId = "33333333-3333-3333-3333-333333333333";
  const { RunnerE2eeState } = await import("../src/e2eeState.js");
  const { processSecureWebPairingCycle, __testPendingPairings } = await import(
    "../src/secureWebPairing.js"
  );
  const { pairingMailLogPath } = await import("../src/pairingMail.js");
  const { readFileSync, existsSync } = await import("node:fs");

  __testPendingPairings().delete(pairId);
  const state = await RunnerE2eeState.loadOrCreate();
  const before = existsSync(pairingMailLogPath())
    ? readFileSync(pairingMailLogPath(), "utf8")
    : "";

  await processSecureWebPairingCycle({
    state,
    gatewayFetch: async (path) => {
      if (path.endsWith("/pairings/claim-start")) {
        return new Response(
          JSON.stringify({
            pairing: {
              pairId,
              status: "pending_start",
              start: sampleStart(pairId),
              expiresAt: new Date(Date.now() + 60_000).toISOString()
              // recipientEmail intentionally omitted
            }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (path.includes("pending-revocations")) {
        return new Response(JSON.stringify({ revocations: [] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response(null, { status: 204 });
    }
  });

  const after = existsSync(pairingMailLogPath())
    ? readFileSync(pairingMailLogPath(), "utf8")
    : "";
  assert.equal(after, before);
  assert.equal(__testPendingPairings().get(pairId), undefined);
});
