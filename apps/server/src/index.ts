import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { requireCloudflareUser } from "./auth.js";
import { config } from "./config.js";
import { migrate } from "./db.js";
import { registerRoutes } from "./routes.js";
import { registerTelegram } from "./telegram.js";
import { createDbBackend } from "./csapi/backend.js";
import { isCsapiPath, registerCsapi } from "./csapi/server.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const app = Fastify({
    bodyLimit: 3 * 1024 * 1024,
    logger: {
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "req.headers.cf-access-client-secret",
          "req.headers.cf-access-jwt-assertion",
          "req.body",
          "request.body",
          "body",
          "res.headers.set-cookie"
        ],
        censor: "[REDACTED]"
      }
    }
  });

  await app.register(cors, {
    origin(origin, callback) {
      if (
        !origin ||
        origin === config.publicOrigin ||
        (config.secureClientOrigin && origin === config.secureClientOrigin) ||
        config.e2eeExtensionOrigins.has(origin)
      ) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
    credentials: true
  });

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    reply.header("x-frame-options", "DENY");
    reply.header(
      "content-security-policy",
      "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; " +
        "script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'"
    );
    reply.header(
      "permissions-policy",
      "camera=(), microphone=(), geolocation=(), payment=(), usb=()"
    );
    return payload;
  });

  await migrate();
  await registerRoutes(app);
  await registerTelegram(app);

  // csapi: Anthropic/OpenAI compatible facade (方案 B, plaintext-visible, NOT
  // E2EE). Authenticated by its own API key, independent of Cloudflare Access.
  if (config.csapi.enabled) {
    if (config.csapi.apiKeys.size === 0) {
      app.log.warn("CSAPI_ENABLED is true but CSAPI_API_KEYS is empty; csapi routes will reject all requests");
    }
    const backend = await createDbBackend();
    registerCsapi(app, {
      backend,
      config: {
        enabled: config.csapi.enabled,
        apiKeys: config.csapi.apiKeys,
        defaultModel: config.csapi.defaultModel,
        defaultWorkspaceId: config.csapi.defaultWorkspaceId,
        maxConcurrencyPerKey: config.csapi.maxConcurrencyPerKey,
        runTimeoutMs: config.csapi.runTimeoutMs,
        allowWrites: config.csapi.allowWrites
      }
    });
    app.log.info("csapi facade mounted at /v1/* (plaintext compat, not E2EE)");
  }

  const webDist = join(__dirname, "../../web/dist");
  if (existsSync(webDist)) {
    app.addHook("preHandler", async (request, reply) => {
      if (request.raw.url === "/healthz") {
        return;
      }
      if (request.raw.url?.startsWith("/api/") || request.raw.url?.startsWith("/telegram/")) {
        return;
      }
      // csapi routes authenticate with their own API key, not Cloudflare Access.
      if (isCsapiPath(request.raw.url)) {
        return;
      }
      return requireCloudflareUser(request, reply);
    });

    await app.register(fastifyStatic, {
      root: webDist,
      prefix: "/"
    });
    app.setNotFoundHandler(async (request, reply) => {
      if (request.raw.url?.startsWith("/api/") || request.raw.url?.startsWith("/telegram/")) {
        return reply.code(404).send({ error: "not_found" });
      }
      if (request.raw.url === "/healthz") {
        return reply.code(404).send({ error: "not_found" });
      }
      if (isCsapiPath(request.raw.url)) {
        return reply.code(404).send({ error: "not_found" });
      }
      const authResult = await requireCloudflareUser(request, reply);
      if (reply.sent) return authResult;
      return reply.sendFile("index.html");
    });
  }

  await app.listen({ host: config.host, port: config.port });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
