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

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const app = Fastify({
    logger: true
  });

  await app.register(cors, {
    origin: config.publicOrigin,
    credentials: true
  });

  await migrate();
  await registerRoutes(app);
  await registerTelegram(app);

  const webDist = join(__dirname, "../../web/dist");
  if (existsSync(webDist)) {
    app.addHook("preHandler", async (request, reply) => {
      if (request.raw.url === "/healthz") {
        return;
      }
      if (request.raw.url?.startsWith("/api/") || request.raw.url?.startsWith("/telegram/")) {
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
