import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { requireCloudflareUser } from "./auth.js";
import { config } from "./config.js";
import { migrate } from "./db.js";
import { registerHttpMiddleware } from "./httpMiddleware.js";
import { registerRoutes } from "./routes.js";
import { registerTelegram } from "./telegram.js";
import { createDbBackend } from "./csapi/backend.js";
import { isCsapiPath, registerCsapi } from "./csapi/server.js";
import { loadCgSecureConfig, registerCsapiSecure } from "./csapi/secure.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function requestPath(url: string | undefined) {
  return new URL(url ?? "/", "http://gateway.local").pathname;
}

function isPublicReleaseAsset(url: string | undefined) {
  if (!config.publicReports) return false;
  const path = requestPath(url);
  return (
    path === "/reports" ||
    path.startsWith("/reports/") ||
    path.startsWith("/assets/") ||
    path === "/favicon.ico"
  );
}

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

  await registerHttpMiddleware(app);

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
    const csapiDeps = {
      backend,
      config: {
        enabled: config.csapi.enabled,
        apiKeys: config.csapi.apiKeys,
        defaultModel: config.csapi.defaultModel,
        defaultWorkspaceId: config.csapi.defaultWorkspaceId,
        maxConcurrencyPerKey: config.csapi.maxConcurrencyPerKey,
        runTimeoutMs: config.csapi.runTimeoutMs,
        maxPromptChars: config.csapi.maxPromptChars,
        allowWrites: config.csapi.allowWrites
      }
    };
    if (!config.cg.requireSecure) {
      registerCsapi(app, csapiDeps);
      app.log.info("csapi facade mounted at /v1/* (plaintext compat, not E2EE)");
    } else {
      app.log.info("CG_REQUIRE_SECURE is true; plaintext /v1/* routes are not mounted");
    }
    if (config.cg.secureEnabled) {
      const secureConfig = await loadCgSecureConfig();
      if (secureConfig) {
        registerCsapiSecure(app, { ...csapiDeps, secure: secureConfig });
        app.log.info("cg-mitm secure channel mounted at /cg/v1/*");
      } else {
        app.log.warn("CG_SECURE_ENABLED is true but secure config failed to load; /cg/v1/* not mounted");
      }
    }
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
      if (isCsapiPath(request.raw.url) || isPublicReleaseAsset(request.raw.url)) {
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
      if (isPublicReleaseAsset(request.raw.url)) {
        return reply.sendFile("index.html");
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
