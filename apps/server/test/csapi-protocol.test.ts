import assert from "node:assert/strict";
import test from "node:test";
import {
  apiKeyId,
  assertUniqueApiKeyIds,
  buildAnthropicResponse,
  buildAnthropicStreamFrames,
  buildModelsResponse,
  buildOpenAiResponse,
  buildOpenAiStreamFrames,
  buildPrompt,
  chunkText,
  extractApiKey,
  extractSystem,
  extractText,
  lastUserText,
  matchApiKey,
  normalizeMessages,
  PROMPT_TRUNCATION_MARKER,
  resolveSessionKey,
  serializeSse,
  timingSafeEqualStr,
  wantsStream
} from "../src/csapi/protocol.js";

test("extractApiKey reads x-api-key and Bearer authorization", () => {
  assert.equal(extractApiKey({ "x-api-key": "abc" }), "abc");
  assert.equal(extractApiKey({ authorization: "Bearer xyz" }), "xyz");
  assert.equal(extractApiKey({ authorization: "bearer  spaced  " }), "spaced");
  assert.equal(extractApiKey({}), undefined);
  assert.equal(extractApiKey({ authorization: "Basic zzz" }), undefined);
});

test("timingSafeEqualStr compares safely and handles length mismatch", () => {
  assert.equal(timingSafeEqualStr("secret", "secret"), true);
  assert.equal(timingSafeEqualStr("secret", "secre"), false);
  assert.equal(timingSafeEqualStr("secret", "SECRET"), false);
});

test("matchApiKey returns a stable non-secret id or undefined", () => {
  const allow = new Set(["k1-super-secret", "k2-other"]);
  const id = matchApiKey("k1-super-secret", allow);
  assert.ok(id && id.startsWith("k_"));
  assert.equal(id, apiKeyId("k1-super-secret"));
  assert.notEqual(id, apiKeyId("k2-other"));
  // Known legacy FNV-1a collision: configuration must fail closed.
  assert.equal(
    apiKeyId("vsKR5K1ThKuf4UY6r4fr"),
    apiKeyId("NrGsVZVBNbgPGroQVqAQ")
  );
  assert.throws(
    () =>
      assertUniqueApiKeyIds([
        "vsKR5K1ThKuf4UY6r4fr",
        "NrGsVZVBNbgPGroQVqAQ"
      ]),
    /colliding key identifiers/
  );
  assert.doesNotThrow(() => assertUniqueApiKeyIds(allow));
  assert.equal(matchApiKey("nope", allow), undefined);
  assert.equal(matchApiKey(undefined, allow), undefined);
  assert.equal(id?.includes("secret"), false);
});

test("extractText flattens strings, content-part arrays, and images", () => {
  assert.equal(extractText("hello"), "hello");
  assert.equal(extractText([{ type: "text", text: "a" }, { type: "text", text: "b" }]), "ab");
  assert.equal(extractText([{ type: "image", source: {} }, { type: "text", text: "x" }]), "[image omitted]x");
  assert.equal(extractText(null), "");
});

test("extractSystem handles string and block array", () => {
  assert.equal(extractSystem("be nice"), "be nice");
  assert.equal(extractSystem([{ type: "text", text: "sys" }]), "sys");
  assert.equal(extractSystem(undefined), "");
});

test("normalizeMessages + lastUserText", () => {
  const messages = normalizeMessages([
    { role: "user", content: "hi" },
    { role: "assistant", content: [{ type: "text", text: "hey" }] },
    { role: "user", content: "again" }
  ]);
  assert.equal(messages.length, 3);
  assert.equal(lastUserText(messages), "again");
  assert.equal(lastUserText(normalizeMessages([{ role: "assistant", content: "x" }])), undefined);
});

test("buildPrompt honors stateless / session-first / session-continued", () => {
  const messages = normalizeMessages([
    { role: "user", content: "first" },
    { role: "assistant", content: "reply" },
    { role: "user", content: "second" }
  ]);
  const stateless = buildPrompt({ system: "SYS", messages, mode: "stateless" });
  assert.ok(stateless.includes("SYS"));
  assert.ok(stateless.includes("first"));
  assert.ok(stateless.includes("second"));

  const first = buildPrompt({ system: "SYS", messages, mode: "session-first" });
  assert.ok(first.includes("SYS"));
  assert.ok(first.includes("second"));
  assert.ok(first.includes("first"));

  const cont = buildPrompt({ system: "SYS", messages, mode: "session-continued" });
  assert.equal(cont, "second");
});

test("buildPrompt preserves OpenAI system messages", () => {
  const prompt = buildPrompt({
    system: "",
    messages: normalizeMessages([
      { role: "system", content: "SYSTEM-INSTRUCTION" },
      { role: "user", content: "question" }
    ]),
    mode: "stateless"
  });
  assert.match(prompt, /SYSTEM-INSTRUCTION/);
  assert.match(prompt, /User: question/);
});

test("buildPrompt bounds large context while preserving the latest turn", () => {
  const messages = normalizeMessages([
    { role: "user", content: `old-${"x".repeat(4_000)}` },
    { role: "assistant", content: `reply-${"y".repeat(4_000)}` },
    { role: "user", content: "LATEST-USER-TURN" }
  ]);
  const prompt = buildPrompt({
    system: `SYSTEM-${"s".repeat(2_000)}`,
    messages,
    mode: "session-first",
    maxChars: 1_024
  });
  assert.ok(prompt.length <= 1_024);
  assert.match(prompt, new RegExp(PROMPT_TRUNCATION_MARKER));
  assert.match(prompt, /LATEST-USER-TURN/);
});

test("resolveSessionKey resolves from header/body/metadata", () => {
  assert.equal(resolveSessionKey({ headers: { "x-session-id": "h1" }, body: {} }), "h1");
  assert.equal(resolveSessionKey({ headers: {}, body: { session_id: "s1" } }), "s1");
  assert.equal(resolveSessionKey({ headers: {}, body: { conversation_id: "c1" } }), "c1");
  assert.equal(resolveSessionKey({ headers: {}, body: { metadata: { user_id: "u1" } } }), "u1");
  assert.equal(resolveSessionKey({ headers: {}, body: {} }), null);
});

test("wantsStream detects streaming flag", () => {
  assert.equal(wantsStream({ stream: true }), true);
  assert.equal(wantsStream({ stream: false }), false);
  assert.equal(wantsStream({}), false);
  assert.equal(wantsStream(undefined), false);
});

test("chunkText splits and preserves content", () => {
  const chunks = chunkText("abcdefgh", 3);
  assert.deepEqual(chunks, ["abc", "def", "gh"]);
  assert.equal(chunks.join(""), "abcdefgh");
  assert.deepEqual(chunkText("", 3), []);
});

test("serializeSse formats event + data and [DONE]", () => {
  assert.equal(serializeSse({ event: "ping", data: { type: "ping" } }), 'event: ping\ndata: {"type":"ping"}\n\n');
  assert.equal(serializeSse({ data: "[DONE]" }), "data: [DONE]\n\n");
});

test("buildAnthropicResponse shape", () => {
  const res = buildAnthropicResponse({ id: "msg_1", model: "auto", text: "hi", inputTokens: 3, outputTokens: 2 });
  assert.equal(res.type, "message");
  assert.equal(res.role, "assistant");
  assert.deepEqual(res.content, [{ type: "text", text: "hi" }]);
  assert.deepEqual(res.usage, { input_tokens: 3, output_tokens: 2 });
});

test("buildAnthropicStreamFrames produces a valid event order", () => {
  const frames = buildAnthropicStreamFrames({ id: "msg_1", model: "auto", text: "hello world", inputTokens: 1, outputTokens: 2 });
  const events = frames.map((f) => f.event);
  assert.equal(events[0], "message_start");
  assert.ok(events.includes("content_block_start"));
  assert.ok(events.includes("content_block_delta"));
  assert.ok(events.includes("content_block_stop"));
  assert.ok(events.includes("message_delta"));
  assert.equal(events.at(-1), "message_stop");
});

test("buildOpenAiResponse + stream frames shape", () => {
  const res = buildOpenAiResponse({ id: "c1", model: "auto", text: "hi", inputTokens: 2, outputTokens: 1 });
  assert.equal(res.object, "chat.completion");
  const choices = res.choices as Array<Record<string, unknown>>;
  assert.equal((choices[0].message as Record<string, unknown>).content, "hi");

  const frames = buildOpenAiStreamFrames({ id: "c1", model: "auto", text: "hi there" });
  const first = frames[0].data as Record<string, unknown>;
  assert.equal(first.object, "chat.completion.chunk");
  const lastChoices = (frames.at(-1)!.data as Record<string, unknown>).choices as Array<Record<string, unknown>>;
  assert.equal(lastChoices[0].finish_reason, "stop");
});

test("buildModelsResponse always includes auto and dedupes", () => {
  const res = buildModelsResponse(["auto", "cursor-fast", "cursor-fast"]);
  const data = res.data as Array<Record<string, unknown>>;
  const ids = data.map((m) => m.id);
  assert.deepEqual(ids, ["auto", "cursor-fast"]);
  assert.equal(res.object, "list");
});
