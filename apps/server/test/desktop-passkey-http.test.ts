import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import {
  E2EE_PASSKEY_PAIRING_KIND,
  E2EE_PROTOCOL
} from "@cursor-gateway/shared";
import {
  createKeyDescriptor,
  generateHpkeKeyPair,
  generatePairingChallenge,
  generateSigningKeyPair,
  generateTrustRootKeyPair,
  issueRunnerIdentityCert
} from "@cursor-gateway/e2ee";

const databaseUrl = process.env.TEST_DATABASE_URL;

test(
  "real HTTP: CORS, Access bridge, Passkey endpoints, status and safe errors",
  { skip: !databaseUrl },
  async () => {
    const email = `desktop-passkey-${crypto.randomUUID()}@example.test`;
    process.env.NODE_ENV = "test";
    process.env.PUBLIC_ORIGIN = "https://gateway.test";
    process.env.JWT_SECRET = "j".repeat(32);
    process.env.DATABASE_URL = databaseUrl!;
    process.env.RUNNER_SHARED_SECRET = "r".repeat(32);
    process.env.ALLOWED_EMAILS = email;
    process.env.SECURE_CLIENT_ORIGIN = "https://secure.example.com";

    const [{ registerHttpMiddleware }, { registerRoutes }, db] = await Promise.all([
      import("../src/httpMiddleware.js"),
      import("../src/routes.js"),
      import("../src/db.js")
    ]);
    await db.migrate();

    const app = Fastify({ logger: false });
    await registerHttpMiddleware(app);
    await registerRoutes(app);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const userHeaders = {
      "cf-access-authenticated-user-email": email
    };
    const runnerHeaders = {
      authorization: `Bearer ${"r".repeat(32)}`,
      "content-type": "application/json"
    };
    const pairId = crypto.randomUUID();

    try {
      const allowedPreflight = await fetch(`${address}/api/e2ee-policy`, {
        method: "OPTIONS",
        headers: {
          origin: "https://secure.example.com",
          "access-control-request-method": "GET"
        }
      });
      assert.equal(allowedPreflight.status, 204);
      assert.equal(
        allowedPreflight.headers.get("access-control-allow-origin"),
        "https://secure.example.com"
      );

      const deniedPreflight = await fetch(`${address}/api/e2ee-policy`, {
        method: "OPTIONS",
        headers: {
          origin: "https://evil.example.net",
          "access-control-request-method": "GET"
        }
      });
      assert.equal(deniedPreflight.headers.get("access-control-allow-origin"), null);

      const bridge = await fetch(`${address}/api/desktop/access/bridge`, {
        headers: userHeaders
      });
      assert.equal(bridge.status, 200);
      assert.match(bridge.headers.get("content-type") ?? "", /text\/html/);
      assert.match(bridge.headers.get("content-security-policy") ?? "", /unsafe-inline/);
      assert.match(await bridge.text(), /登录成功/);
      assert.ok(bridge.headers.get("x-request-id"));

      const version = await fetch(`${address}/api/desktop/version`, {
        headers: userHeaders
      });
      assert.equal(version.status, 200);
      const versionBody = (await version.json()) as Record<string, unknown>;
      assert.equal(typeof versionBody.version, "string");
      assert.equal(typeof versionBody.installerAvailable, "boolean");

      const clientSigning = await generateSigningKeyPair();
      const clientEncryption = await generateHpkeKeyPair();
      const clientSigningKey = await createKeyDescriptor(clientSigning.publicKey);
      const clientEncryptionKey = await createKeyDescriptor(clientEncryption.publicKey);
      const start = {
        protocol: E2EE_PROTOCOL,
        pairingKind: E2EE_PASSKEY_PAIRING_KIND,
        pairId,
        clientId: `client-${crypto.randomUUID()}`,
        clientChallenge: generatePairingChallenge(),
        signingKey: clientSigningKey,
        encryptionKey: clientEncryptionKey,
        secureOrigin: "https://secure.example.com",
        gatewayOrigin: "https://gateway.test",
        createdAt: new Date().toISOString()
      };

      const rejectedOrigin = await fetch(`${address}/api/e2ee/v1/passkey/start`, {
        method: "POST",
        headers: { ...userHeaders, "content-type": "application/json" },
        body: JSON.stringify({
          start: { ...start, pairId: crypto.randomUUID(), secureOrigin: "https://evil.example.net" }
        })
      });
      assert.equal(rejectedOrigin.status, 400);
      assert.deepEqual(await rejectedOrigin.json(), { error: "secure_origin_mismatch" });

      const started = await fetch(`${address}/api/e2ee/v1/passkey/start`, {
        method: "POST",
        headers: { ...userHeaders, "content-type": "application/json" },
        body: JSON.stringify({ start })
      });
      assert.equal(started.status, 202);
      assert.equal((await started.json() as { status: string }).status, "pending_start");

      const claimed = await fetch(`${address}/api/runner/e2ee/v1/passkey/claim-start`, {
        method: "POST",
        headers: runnerHeaders,
        body: JSON.stringify({ runnerId: "runner-http-test" })
      });
      assert.equal(claimed.status, 200);
      assert.equal(
        ((await claimed.json()) as { pairing: { pairId: string } }).pairing.pairId,
        pairId
      );

      const root = await generateTrustRootKeyPair(1);
      const runnerSigning = await generateSigningKeyPair();
      const runnerEncryption = await generateHpkeKeyPair();
      const runnerSigningKey = await createKeyDescriptor(runnerSigning.publicKey);
      const runnerEncryptionKey = await createKeyDescriptor(runnerEncryption.publicKey);
      const runnerCertificate = await issueRunnerIdentityCert({
        rootPrivateKey: root.privateKey,
        rootPublic: root.public,
        runnerId: "runner-http-test",
        signingKey: runnerSigningKey,
        encryptionKey: runnerEncryptionKey,
        allowedSecureOrigins: ["https://secure.example.com"],
        allowedRpIds: ["secure.example.com"]
      });
      const now = new Date().toISOString();
      const options = {
        protocol: E2EE_PROTOCOL,
        pairingKind: E2EE_PASSKEY_PAIRING_KIND,
        pairId,
        runnerId: "runner-http-test",
        mode: "registration" as const,
        options: {
          challenge: generatePairingChallenge(),
          rp: { id: "secure.example.com", name: "Secure Gateway" },
          user: {
            id: generatePairingChallenge(),
            name: email,
            displayName: "Integration user"
          },
          pubKeyCredParams: [{ type: "public-key", alg: -7 }]
        },
        runnerEncryptionKey,
        runnerSigningKey,
        runnerCertificate,
        clientId: start.clientId,
        clientChallenge: start.clientChallenge,
        clientSigningFingerprint: clientSigningKey.fingerprint,
        clientEncryptionFingerprint: clientEncryptionKey.fingerprint,
        secureOrigin: start.secureOrigin,
        gatewayOrigin: start.gatewayOrigin,
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
        createdAt: now
      };
      const published = await fetch(`${address}/api/runner/e2ee/v1/passkey/options`, {
        method: "POST",
        headers: runnerHeaders,
        body: JSON.stringify({ runnerId: "runner-http-test", options })
      });
      assert.equal(published.status, 200);

      const status = await fetch(`${address}/api/e2ee/v1/passkey/${pairId}`, {
        headers: userHeaders
      });
      assert.equal(status.status, 200);
      const statusBody = (await status.json()) as {
        status: string;
        options: { secureOrigin: string };
      };
      assert.equal(statusBody.status, "offer_ready");
      assert.equal(statusBody.options.secureOrigin, "https://secure.example.com");

      const malformed = await fetch(`${address}/api/e2ee/v1/passkey/${pairId}/complete`, {
        method: "POST",
        headers: { ...userHeaders, "content-type": "application/json" },
        body: JSON.stringify({ complete: { pairId } })
      });
      assert.equal(malformed.status, 400);
      const malformedBody = (await malformed.json()) as {
        error: string;
        requestId: string;
      };
      assert.equal(malformedBody.error, "invalid_request");
      assert.ok(malformedBody.requestId);

      const complete = {
        protocol: E2EE_PROTOCOL,
        pairingKind: E2EE_PASSKEY_PAIRING_KIND,
        pairId,
        clientId: start.clientId,
        mode: "registration" as const,
        response: {
          id: generatePairingChallenge(),
          rawId: generatePairingChallenge(),
          type: "public-key"
        },
        signature: {
          alg: "ES256" as const,
          keyId: clientSigningKey.keyId,
          value: "s".repeat(86)
        },
        createdAt: new Date().toISOString()
      };
      const completed = await fetch(
        `${address}/api/e2ee/v1/passkey/${pairId}/complete`,
        {
          method: "POST",
          headers: {
            ...userHeaders,
            "content-type": "application/json",
            "cf-access-jwt-assertion": "header.payload.signature"
          },
          body: JSON.stringify({ complete })
        }
      );
      assert.equal(completed.status, 200);
      assert.equal(
        ((await completed.json()) as { status: string }).status,
        "complete_submitted"
      );

      const claimedComplete = await fetch(
        `${address}/api/runner/e2ee/v1/passkey/claim-complete`,
        {
          method: "POST",
          headers: runnerHeaders,
          body: JSON.stringify({ runnerId: "runner-http-test" })
        }
      );
      assert.equal(claimedComplete.status, 200);
      const claimedCompleteBody = (await claimedComplete.json()) as {
        pairing: { pairId: string; accessJwt: string | null };
      };
      assert.equal(claimedCompleteBody.pairing.pairId, pairId);
      assert.equal(claimedCompleteBody.pairing.accessJwt, "header.payload.signature");
    } finally {
      await app.close();
      const user = await db.pool.query("select id from app_users where email = $1", [email]);
      const userId = user.rows[0]?.id;
      await db.pool.query("delete from e2ee_passkey_pairings where pair_id = $1", [pairId]);
      if (userId) {
        await db.pool.query("delete from audit_logs where actor_user_id = $1", [userId]);
        await db.pool.query("delete from app_users where id = $1", [userId]);
      }
      await db.pool.end();
    }
  }
);
