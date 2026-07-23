import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { requireCloudflareUser } from "./auth.js";
import { config } from "./config.js";
import { expireCsapiRuns, migrate, seedWorkspaces } from "./db.js";
import { registerHttpMiddleware } from "./httpMiddleware.js";
import { registerRoutes } from "./routes.js";
import { registerTelegram } from "./telegram.js";
import { createDbBackend } from "./csapi/backend.js";
import { isCsapiPath, registerCsapi } from "./csapi/server.js";
import { loadCgSecureConfig, registerCsapiSecure } from "./csapi/secure.js";
import { waitForRunUpdate } from "./runWaiter.js";

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
    path === "/interview" ||
    path.startsWith("/interview/") ||
    path.startsWith("/assets/") ||
    path === "/favicon.ico"
  );
}

async function main() {
  const startedAt = Date.now();
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

  // Prefer external migrate one-shot in production; keep inline for compat.
  if (process.env.SKIP_INLINE_MIGRATE !== "1") {
    await migrate();
  }
  await seedWorkspaces();
  await registerRoutes(app);
  await registerTelegram(app);

  // csapi: Anthropic/OpenAI compatible facade (方案 B, plaintext-visible, NOT
  // E2EE). Authenticated by its own API key, independent of Cloudflare Access.
  if (config.csapi.enabled) {
    if (config.csapi.apiKeys.size === 0) {
      app.log.warn("CSAPI_ENABLED is true but CSAPI_API_KEYS is empty; csapi routes will reject all requests");
    }
    const sweepCsapiTimeouts = async () => {
      const expired = await expireCsapiRuns({
        queueTimeoutMs: config.csapi.queueTimeoutMs,
        idleTimeoutMs: config.csapi.idleTimeoutMs,
        absoluteTimeoutMs: config.csapi.absoluteTimeoutMs
      });
      if (expired.queueTimeout + expired.idleTimeout + expired.absoluteTimeout > 0) {
        app.log.warn(
          { event: "csapi.runs.expired", ...expired },
          "expired csapi runs"
        );
      }
    };
    await sweepCsapiTimeouts();
    const timeoutSweep = setInterval(() => {
      void sweepCsapiTimeouts().catch((error: unknown) => {
        app.log.error(
          {
            event: "csapi.timeout_sweep.failed",
            errorKind: error instanceof Error ? error.name : "unknown"
          },
          "csapi timeout sweep failed"
        );
      });
    }, 5_000);
    timeoutSweep.unref();
    app.addHook("onClose", async () => clearInterval(timeoutSweep));

    const backend = await createDbBackend();
    const csapiDeps = {
      backend,
      waitForRunUpdate,
      config: {
        enabled: config.csapi.enabled,
        apiKeys: config.csapi.apiKeys,
        defaultModel: config.csapi.defaultModel,
        defaultWorkspaceId: config.csapi.defaultWorkspaceId,
        maxConcurrencyPerKey: config.csapi.maxConcurrencyPerKey,
        callerWaitTimeoutMs: config.csapi.callerWaitTimeoutMs,
        queueTimeoutMs: config.csapi.queueTimeoutMs,
        idleTimeoutMs: config.csapi.idleTimeoutMs,
        absoluteTimeoutMs: config.csapi.absoluteTimeoutMs,
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

  // Prefer nginx for static UI in production. Keep Fastify static only when WEB_STATIC_ENABLED=1.
  const webStaticEnabled =
    process.env.WEB_STATIC_ENABLED === "1" ||
    (process.env.WEB_STATIC_ENABLED !== "0" && process.env.NODE_ENV !== "production");
  const webDist = join(__dirname, "../../web/dist");
  if (webStaticEnabled && existsSync(webDist)) {
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
  app.log.info(
    { listenMs: Date.now() - startedAt, poolMax: config.dbPoolMax },
    "gateway ready"
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
