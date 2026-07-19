import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";

process.env.NODE_ENV = "test";
process.env.PUBLIC_ORIGIN = "https://gateway.test";
process.env.JWT_SECRET = "j".repeat(32);
process.env.DATABASE_URL = "postgres://localhost:5432/test";
process.env.RUNNER_SHARED_SECRET = "r".repeat(32);
process.env.SECURE_CLIENT_ORIGIN = "http://tauri.localhost";

const { normalizeClientRequestId, registerHttpMiddleware } = await import(
  "../src/httpMiddleware.js"
);

test("client request IDs are strictly validated", () => {
  assert.equal(
    normalizeClientRequestId("15ceaed3-3c72-4814-a465-a4f061016726"),
    "15ceaed3-3c72-4814-a465-a4f061016726"
  );
  assert.equal(normalizeClientRequestId("CG-safe_123"), "CG-safe_123");
  assert.equal(normalizeClientRequestId("short"), null);
  assert.equal(normalizeClientRequestId("bad id"), null);
  assert.equal(normalizeClientRequestId("bad\nid"), null);
  assert.equal(normalizeClientRequestId("x".repeat(97)), null);
});

test("middleware echoes valid correlation IDs and rejects invalid values", async () => {
  const app = Fastify({ logger: false });
  await registerHttpMiddleware(app);
  app.get("/probe", async () => ({ ok: true }));

  const valid = await app.inject({
    method: "GET",
    url: "/probe",
    headers: {
      origin: "http://tauri.localhost",
      "x-client-request-id": "15ceaed3-3c72-4814-a465-a4f061016726"
    }
  });
  assert.equal(valid.statusCode, 200);
  assert.equal(
    valid.headers["x-client-request-id"],
    "15ceaed3-3c72-4814-a465-a4f061016726"
  );
  assert.ok(valid.headers["x-request-id"]);
  assert.match(
    String(valid.headers["access-control-expose-headers"]),
    /x-client-request-id/
  );

  const invalid = await app.inject({
    method: "GET",
    url: "/probe",
    headers: { "x-client-request-id": "contains spaces" }
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error, "invalid_client_request_id");
  await app.close();
});
