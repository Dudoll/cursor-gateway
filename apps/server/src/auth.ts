import type { FastifyReply, FastifyRequest } from "fastify";
import type { Principal, Role } from "@cursor-gateway/shared";
import { config } from "./config.js";
import { appendAudit, findUserByTelegramId, upsertServicePrincipal, upsertUser } from "./db.js";

declare module "fastify" {
  interface FastifyRequest {
    principal?: Principal;
  }
}

function headerValue(request: FastifyRequest, name: string) {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function cloudflareAudiences(request: FastifyRequest) {
  const assertion = headerValue(request, "cf-access-jwt-assertion");
  const payloadSegment = assertion?.split(".")[1];
  if (!payloadSegment) return [];

  try {
    const payload = JSON.parse(Buffer.from(payloadSegment, "base64url").toString("utf8")) as { aud?: unknown };
    if (typeof payload.aud === "string") return [payload.aud];
    if (Array.isArray(payload.aud)) return payload.aud.filter((aud): aud is string => typeof aud === "string");
  } catch {
    // Invalid assertions are rejected below when an audience allowlist is configured.
  }
  return [];
}

export async function requireCloudflareUser(request: FastifyRequest, reply: FastifyReply) {
  const email = headerValue(request, "cf-access-authenticated-user-email")?.toLowerCase();
  const audiences = cloudflareAudiences(request);

  if (!email || (config.allowedEmails.size > 0 && !config.allowedEmails.has(email))) {
    await appendAudit({
      eventType: "auth.web.denied",
      details: { email: email ?? null, path: request.url }
    });
    return reply.code(403).send({ error: "email_not_allowed" });
  }

  if (
    config.allowedCloudflareAud.size > 0 &&
    !audiences.some((audience) => config.allowedCloudflareAud.has(audience))
  ) {
    await appendAudit({
      eventType: "auth.cloudflare_aud.denied",
      details: { email, audiences, path: request.url }
    });
    return reply.code(403).send({ error: "cloudflare_audience_not_allowed" });
  }

  const user = await upsertUser({ email, role: "admin" });
  request.principal = {
    id: user.id,
    email,
    displayName: user.display_name ?? undefined,
    role: user.role
  };
}

export async function requireRunner(request: FastifyRequest, reply: FastifyReply) {
  const auth = headerValue(request, "authorization");
  const expected = `Bearer ${config.runnerSharedSecret}`;
  if (auth !== expected) {
    await appendAudit({
      eventType: "auth.runner.denied",
      details: { path: request.url }
    });
    return reply.code(401).send({ error: "runner_not_authorized" });
  }
}

export async function requireAutomation(request: FastifyRequest, reply: FastifyReply) {
  const auth = headerValue(request, "authorization");
  if (config.automationSharedSecret.length < 32 || auth !== `Bearer ${config.automationSharedSecret}`) {
    await appendAudit({
      eventType: "auth.automation.denied",
      details: { path: request.url }
    });
    return reply.code(401).send({ error: "automation_not_authorized" });
  }

  const service = await upsertServicePrincipal("automation", "operator");
  request.principal = { id: service.id, role: service.role };
}

export async function requireHermesRunner(request: FastifyRequest, reply: FastifyReply) {
  const auth = headerValue(request, "authorization");
  if (
    config.hermesRunnerSharedSecret.length < 32 ||
    auth !== `Bearer ${config.hermesRunnerSharedSecret}`
  ) {
    await appendAudit({
      eventType: "auth.hermes_runner.denied",
      details: { path: request.url }
    });
    return reply.code(401).send({ error: "hermes_runner_not_authorized" });
  }
}

export async function principalFromTelegramUserId(telegramUserId: string): Promise<Principal | undefined> {
  if (!config.telegramAllowedUserIds.has(telegramUserId)) {
    await appendAudit({
      eventType: "auth.telegram.denied",
      details: { telegramUserId }
    });
    return undefined;
  }

  const user =
    (await findUserByTelegramId(telegramUserId)) ??
    (await upsertUser({ telegramUserId, role: "operator" }));

  return {
    id: user.id,
    email: user.email ?? undefined,
    telegramUserId,
    displayName: user.display_name ?? undefined,
    role: user.role
  };
}

export function requireRole(principal: Principal, roles: Role[]) {
  return roles.includes(principal.role);
}
