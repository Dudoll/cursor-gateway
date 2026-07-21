#!/usr/bin/env node
/**
 * Optional real Telegram smoke. Default: skipped / refuse unless explicitly enabled.
 *
 * Required:
 *   TELEGRAM_SMOKE=1
 *   TELEGRAM_BOT_TOKEN
 *   TELEGRAM_SMOKE_CHAT_ID   (dedicated smoke chat only — never a random user)
 *
 * Optional:
 *   TELEGRAM_SMOKE_CSAPI_BASE_URL  (default http://127.0.0.1:18080)
 *   TELEGRAM_SMOKE_CSAPI_KEY
 *   TELEGRAM_SMOKE_MODEL           (default gpt-5.4-nano / auto)
 *   TELEGRAM_SMOKE_ALLOW_PRODUCTION=1  (required if CSAPI host is not loopback)
 *
 * Never prints token values. Does not message anyone outside TELEGRAM_SMOKE_CHAT_ID.
 */
import { createHash, randomUUID } from "node:crypto";

const enabled = process.env.TELEGRAM_SMOKE === "1";
if (!enabled) {
  console.log(
    JSON.stringify({
      skipped: true,
      reason: "TELEGRAM_SMOKE is not 1; refusing real Telegram traffic"
    })
  );
  process.exit(0);
}

const token = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
const chatId = process.env.TELEGRAM_SMOKE_CHAT_ID?.trim() ?? "";
const csapiBase = new URL(
  process.env.TELEGRAM_SMOKE_CSAPI_BASE_URL ?? "http://127.0.0.1:18080"
);
const csapiKey = process.env.TELEGRAM_SMOKE_CSAPI_KEY?.trim() ?? "";
const model = process.env.TELEGRAM_SMOKE_MODEL?.trim() || "auto";
const localHosts = new Set(["127.0.0.1", "localhost", "::1"]);
const production =
  process.env.TELEGRAM_SMOKE_PRODUCTION === "1" || !localHosts.has(csapiBase.hostname);

if (!token) {
  console.error(JSON.stringify({ ok: false, error: "TELEGRAM_BOT_TOKEN is required" }));
  process.exit(1);
}
if (!chatId) {
  console.error(
    JSON.stringify({
      ok: false,
      error: "TELEGRAM_SMOKE_CHAT_ID is required (dedicated smoke chat only)"
    })
  );
  process.exit(1);
}
if (production && process.env.TELEGRAM_SMOKE_ALLOW_PRODUCTION !== "1") {
  console.error(
    JSON.stringify({
      ok: false,
      error:
        "Refusing non-loopback CSAPI. Set TELEGRAM_SMOKE_ALLOW_PRODUCTION=1 explicitly."
    })
  );
  process.exit(1);
}
if (!csapiKey) {
  console.error(JSON.stringify({ ok: false, error: "TELEGRAM_SMOKE_CSAPI_KEY is required" }));
  process.exit(1);
}

const stamp = randomUUID().slice(0, 8);
const expected = `TG-SMOKE-${stamp}`;

async function telegram(method, body) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000)
  });
  const json = await response.json();
  if (!json.ok) {
    throw new Error(`${method} failed: ${json.description ?? response.status}`);
  }
  return json.result;
}

async function csapiChat(prompt, sessionSuffix) {
  const sessionId = `hermes:telegram-smoke:${chatId}:${sessionSuffix}`;
  const idem = createHash("sha256")
    .update(["telegram-real-smoke", sessionId, model, prompt].join("\0"))
    .digest("hex");
  const started = performance.now();
  const response = await fetch(new URL("/v1/chat/completions", csapiBase), {
    method: "POST",
    headers: {
      authorization: `Bearer ${csapiKey}`,
      "content-type": "application/json",
      "x-session-id": sessionId,
      "idempotency-key": idem
    },
    body: JSON.stringify({
      model,
      stream: false,
      max_tokens: 48,
      messages: [
        {
          role: "user",
          content: `Reply with exactly this token and nothing else: ${prompt}`
        }
      ]
    }),
    signal: AbortSignal.timeout(120_000)
  });
  const body = await response.json().catch(() => ({}));
  return {
    status: response.status,
    ms: Number((performance.now() - started).toFixed(1)),
    text: body?.choices?.[0]?.message?.content ?? "",
    error: body?.error?.message
  };
}

const report = {
  phase: "start",
  chatIdConfigured: true,
  csapiHost: csapiBase.hostname,
  production,
  model,
  stamp,
  startedAt: new Date().toISOString()
};
console.log(JSON.stringify(report));

try {
  await telegram("sendChatAction", { chat_id: chatId, action: "typing" });
  const first = await csapiChat(expected, "cold");
  const follow = await csapiChat(`${expected}-follow`, "cold");
  const outbound = await telegram("sendMessage", {
    chat_id: chatId,
    text: [
      `Telegram smoke ${stamp}`,
      `cold status=${first.status} ms=${first.ms}`,
      `follow status=${follow.status} ms=${follow.ms}`,
      first.status === 200 && String(first.text).includes(expected)
        ? "cold: ok"
        : `cold: fail (${first.error ?? "no token"})`,
      follow.status === 200 ? "follow: ok" : `follow: fail (${follow.error ?? follow.status})`
    ].join("\n")
  });

  const ok =
    first.status === 200 &&
    String(first.text).includes(expected) &&
    follow.status === 200 &&
    Boolean(outbound?.message_id);

  console.log(
    JSON.stringify({
      phase: "done",
      ok,
      coldStatus: first.status,
      coldMs: first.ms,
      followStatus: follow.status,
      followMs: follow.ms,
      telegramMessageId: outbound?.message_id ?? null,
      finishedAt: new Date().toISOString()
    })
  );
  process.exit(ok ? 0 : 2);
} catch (error) {
  console.error(
    JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    })
  );
  process.exit(1);
}
