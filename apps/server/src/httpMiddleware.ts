import cors from "@fastify/cors";
import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { config } from "./config.js";
import { shouldPreserveRouteContentSecurityPolicy } from "./desktopPublic.js";

export async function registerHttpMiddleware(app: FastifyInstance): Promise<void> {
  await app.register(cors, {
    origin(origin, callback) {
      if (
        !origin ||
        origin === config.publicOrigin ||
        config.secureClientOrigins.has(origin) ||
        config.e2eeExtensionOrigins.has(origin)
      ) {
        callback(null, true);
        return;
      }
      app.log.warn({ origin, event: "cors.origin_denied" }, "CORS origin denied");
      callback(null, false);
    },
    credentials: true
  });

  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });

  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    reply.header("x-frame-options", "DENY");
    const url = request.raw.url ?? "";
    if (!shouldPreserveRouteContentSecurityPolicy(url)) {
      reply.header(
        "content-security-policy",
        "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; " +
          "script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'"
      );
    }
    reply.header(
      "permissions-policy",
      "camera=(), microphone=(), geolocation=(), payment=(), usb=()"
    );
    if (url.startsWith("/cg/v1/")) {
      reply.header("cache-control", "no-store");
    }
    return payload;
  });

  app.setErrorHandler(async (error, request, reply) => {
    if (reply.sent) return;
    const errorRecord =
      error && typeof error === "object"
        ? (error as { statusCode?: unknown; code?: unknown; name?: unknown })
        : {};
    const clientError =
      error instanceof ZodError ||
      (typeof errorRecord.statusCode === "number" &&
        errorRecord.statusCode >= 400 &&
        errorRecord.statusCode < 500);
    const statusCode = clientError ? 400 : 500;
    const code = clientError ? "invalid_request" : "internal_error";
    request.log.error(
      {
        requestId: request.id,
        path: request.url,
        errorName:
          typeof errorRecord.name === "string"
            ? errorRecord.name.slice(0, 80)
            : "UnknownError",
        errorCode:
          typeof errorRecord.code === "string"
            ? errorRecord.code.slice(0, 80)
            : null
      },
      "request failed"
    );
    return reply.code(statusCode).send({ error: code, requestId: request.id });
  });
}
