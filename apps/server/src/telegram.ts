import type { FastifyInstance } from "fastify";
import type { RunRecord } from "@cursor-gateway/shared";
import { Telegraf } from "telegraf";
import { config } from "./config.js";
import { principalFromTelegramUserId } from "./auth.js";
import {
  appendAudit,
  cancelQueuedRun,
  createConversation,
  createRun,
  getLatestConversation,
  getRunForUser,
  getWorkspace,
  listRuns,
  listWorkspaces,
  updateUserDisplayName
} from "./db.js";
import { listModels, modelIsKnown } from "./runnerRegistry.js";

type TelegramSession = {
  model: string;
  workspaceId?: string;
  conversationId?: string;
};

const sessions = new Map<string, TelegramSession>();

function runMetadata(run: RunRecord) {
  const sentAt = new Date(run.createdAt).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour12: false
  });
  const lines = [`Sent: ${sentAt}`];
  if (run.finishedAt) {
    const finishedAt = new Date(run.finishedAt);
    lines.push(
      `Answered: ${finishedAt.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}`,
      `Latency: ${((finishedAt.getTime() - new Date(run.createdAt).getTime()) / 1000).toFixed(1)}s`
    );
  }
  if (run.inputTokens !== null && run.outputTokens !== null) {
    lines.push(
      `Tokens: input ${run.inputTokens}, output ${run.outputTokens}, total ${run.inputTokens + run.outputTokens}`
    );
  } else if (run.finishedAt) {
    lines.push("Tokens: unavailable");
  }
  return lines;
}

function sessionFor(userId: string) {
  const existing = sessions.get(userId);
  if (existing) return existing;
  const next: TelegramSession = { model: "auto" };
  sessions.set(userId, next);
  return next;
}

async function principalForContext(ctxUserId: number | undefined) {
  if (!ctxUserId) return undefined;
  return principalFromTelegramUserId(String(ctxUserId));
}

export async function registerTelegram(app: FastifyInstance) {
  if (!config.telegramBotToken) {
    app.log.warn("TELEGRAM_BOT_TOKEN is not configured; Telegram integration is disabled");
    return;
  }
  if (!config.telegramWebhookSecret) {
    throw new Error("TELEGRAM_WEBHOOK_SECRET is required when TELEGRAM_BOT_TOKEN is configured");
  }

  const bot = new Telegraf(config.telegramBotToken);

  bot.start(async (ctx) => {
    const principal = await principalForContext(ctx.from?.id);
    if (!principal) return ctx.reply("Access denied.");
    await ctx.reply(
      [
        "CS Gateway is ready.",
        "Commands:",
        "/model [modelId]",
        "/workspace [workspaceId]",
        "/name <display name>",
        "/new",
        "/chat <prompt>",
        "/status [runId]",
        "/cancel <runId>"
      ].join("\n")
    );
  });

  bot.command("model", async (ctx) => {
    const principal = await principalForContext(ctx.from?.id);
    if (!principal) return ctx.reply("Access denied.");

    const requested = ctx.message.text.replace(/^\/model(@\w+)?\s*/, "").trim();
    const session = sessionFor(principal.telegramUserId!);

    if (!requested) {
      const models = [{ id: "auto", displayName: "Auto" }, ...listModels()];
      return ctx.reply(`Current model: ${session.model}\nAvailable:\n${models.map((m) => `- ${m.id}`).join("\n")}`);
    }

    if (!modelIsKnown(requested)) return ctx.reply("That model is not currently available.");
    session.model = requested;
    return ctx.reply(`Model set to ${requested}`);
  });

  bot.command("workspace", async (ctx) => {
    const principal = await principalForContext(ctx.from?.id);
    if (!principal) return ctx.reply("Access denied.");

    const requested = ctx.message.text.replace(/^\/workspace(@\w+)?\s*/, "").trim();
    const session = sessionFor(principal.telegramUserId!);

    if (!requested) {
      const workspaces = await listWorkspaces();
      return ctx.reply(
        `Current workspace: ${session.workspaceId ?? "not set"}\nAvailable:\n${workspaces
          .map((workspace) => `- ${workspace.id}: ${workspace.label}`)
          .join("\n")}`
      );
    }

    const workspace = await getWorkspace(requested);
    if (!workspace) return ctx.reply("That workspace is not allowed or has not been registered.");
    session.workspaceId = workspace.id;
    delete session.conversationId;
    return ctx.reply(`Workspace set to ${workspace.label}`);
  });

  bot.command("name", async (ctx) => {
    const principal = await principalForContext(ctx.from?.id);
    if (!principal) return ctx.reply("Access denied.");

    const displayName = ctx.message.text.replace(/^\/name(@\w+)?\s*/, "").trim();
    if (!displayName || displayName.length > 100) return ctx.reply("Usage: /name <display name> (maximum 100 characters)");

    await updateUserDisplayName(principal.id, displayName);
    await appendAudit({
      actorUserId: principal.id,
      eventType: "profile.updated",
      details: { displayName, origin: "telegram" }
    });
    return ctx.reply(`I will remember you as ${displayName}.`);
  });

  bot.command("new", async (ctx) => {
    const principal = await principalForContext(ctx.from?.id);
    if (!principal) return ctx.reply("Access denied.");

    const session = sessionFor(principal.telegramUserId!);
    const workspaceId = session.workspaceId ?? (await listWorkspaces())[0]?.id;
    if (!workspaceId) return ctx.reply("No workspace has been registered by the Windows runner yet.");
    const conversation = await createConversation({
      userId: principal.id,
      workspaceId,
      title: "Telegram conversation"
    });
    session.workspaceId = workspaceId;
    session.conversationId = conversation.id;
    return ctx.reply("Started a new conversation.");
  });

  bot.command("chat", async (ctx) => {
    const principal = await principalForContext(ctx.from?.id);
    if (!principal) return ctx.reply("Access denied.");

    const prompt = ctx.message.text.replace(/^\/chat(@\w+)?\s*/, "").trim();
    if (!prompt) return ctx.reply("Usage: /chat <prompt>");

    const session = sessionFor(principal.telegramUserId!);
    const workspaceId = session.workspaceId ?? (await listWorkspaces())[0]?.id;
    if (!workspaceId) return ctx.reply("No workspace has been registered by the Windows runner yet.");

    const workspace = await getWorkspace(workspaceId);
    if (!workspace) return ctx.reply("Selected workspace is no longer available.");

    let conversation = session.conversationId
      ? { id: session.conversationId }
      : await getLatestConversation(principal.id, workspaceId);
    if (!conversation) {
      conversation = await createConversation({
        userId: principal.id,
        workspaceId,
        title: prompt.slice(0, 80)
      });
    }
    session.workspaceId = workspaceId;
    session.conversationId = conversation.id;

    const run = await createRun({
      conversationId: conversation.id,
      userId: principal.id,
      origin: "telegram",
      status: "queued",
      model: session.model,
      workspaceId,
      prompt,
      allowWrites: workspace.writable,
      memoryEnabled: true
    });

    await appendAudit({
      actorUserId: principal.id,
      eventType: "telegram.run.created",
      details: { runId: run.id, model: run.model, workspaceId }
    });

    return ctx.reply(`Queued run ${run.id}. Use /status ${run.id} to check it.`);
  });

  bot.command("status", async (ctx) => {
    const principal = await principalForContext(ctx.from?.id);
    if (!principal) return ctx.reply("Access denied.");

    const runId = ctx.message.text.replace(/^\/status(@\w+)?\s*/, "").trim();
    if (runId) {
      const run = await getRunForUser(runId, principal.id);
      if (!run) return ctx.reply("Run not found.");
      return ctx.reply(
        [
          `Status: ${run.status}`,
          ...runMetadata(run),
          run.response ? `Response:\n${run.response}` : "",
          run.error ? `Error:\n${run.error}` : ""
        ].filter(Boolean).join("\n")
      );
    }

    const runs = await listRuns(principal.id);
    return ctx.reply(runs.slice(0, 5).map((run) => `${run.id} ${run.status} ${run.model}`).join("\n") || "No runs yet.");
  });

  bot.command("cancel", async (ctx) => {
    const principal = await principalForContext(ctx.from?.id);
    if (!principal) return ctx.reply("Access denied.");

    const runId = ctx.message.text.replace(/^\/cancel(@\w+)?\s*/, "").trim();
    if (!runId) return ctx.reply("Usage: /cancel <runId>");

    const run = await cancelQueuedRun(runId, principal.id);
    if (!run) return ctx.reply("Run could not be cancelled. It may already be running or finished.");
    await appendAudit({
      actorUserId: principal.id,
      eventType: "telegram.run.cancelled",
      details: { runId }
    });
    return ctx.reply(`Cancelled ${run.id}.`);
  });

  app.post(`/telegram/webhook/${config.telegramWebhookSecret}`, async (request, reply) => {
    await bot.handleUpdate(request.body as Parameters<typeof bot.handleUpdate>[0]);
    return reply.code(204).send();
  });
}
