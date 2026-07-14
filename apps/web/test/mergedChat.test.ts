import assert from "node:assert/strict";
import test from "node:test";
import {
  HISTORICAL_PLAINTEXT_LABEL,
  buildMergedTimeline,
  mergeConversationLists,
  sortTimelineTurns
} from "../src/mergedChat.js";

test("mergeConversationLists sorts e2ee + plaintext by time", () => {
  const merged = mergeConversationLists({
    plaintext: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        workspaceId: "default",
        title: "Old plain",
        runCount: 2,
        lastRunAt: "2026-01-01T10:00:00.000Z",
        updatedAt: "2026-01-01T10:00:00.000Z",
        createdAt: "2026-01-01T09:00:00.000Z"
      }
    ],
    e2ee: [
      {
        id: "22222222-2222-4222-8222-222222222222",
        workspaceId: "default",
        updatedAt: "2026-01-02T10:00:00.000Z"
      }
    ],
    e2eeTitles: {
      "22222222-2222-4222-8222-222222222222": "Secret chat"
    }
  });
  assert.equal(merged.length, 2);
  assert.equal(merged[0]?.kind, "e2ee");
  assert.equal(merged[0]?.title, "Secret chat");
  assert.equal(merged[1]?.kind, "plaintext");
  assert.equal(merged[1]?.title, "Old plain");
});

test("mergeConversationLists prefers e2ee when id collides", () => {
  const id = "33333333-3333-4333-8333-333333333333";
  const merged = mergeConversationLists({
    plaintext: [
      {
        id,
        workspaceId: "default",
        title: "Plain",
        runCount: 1,
        lastRunAt: null,
        updatedAt: "2026-01-01T00:00:00.000Z",
        createdAt: "2026-01-01T00:00:00.000Z"
      }
    ],
    e2ee: [{ id, workspaceId: "default", updatedAt: "2026-01-03T00:00:00.000Z" }],
    e2eeTitles: { [id]: "Encrypted" }
  });
  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.kind, "e2ee");
  assert.equal(merged[0]?.title, "Encrypted");
});

test("buildMergedTimeline interleaves plaintext and e2ee by createdAt", () => {
  const timeline = buildMergedTimeline({
    plaintextRuns: [
      { id: "p1", createdAt: "2026-01-01T12:00:00.000Z" },
      { id: "p2", createdAt: "2026-01-01T14:00:00.000Z" }
    ],
    e2eeRuns: [
      {
        record: { id: "e1", createdAt: "2026-01-01T13:00:00.000Z" }
      }
    ]
  });
  assert.deepEqual(
    timeline.map((t) => `${t.kind}:${t.id}`),
    ["plaintext:p1", "e2ee:e1", "plaintext:p2"]
  );
});

test("sortTimelineTurns is stable by id", () => {
  const sorted = sortTimelineTurns([
    { id: "b", createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "a", createdAt: "2026-01-01T00:00:00.000Z" }
  ]);
  assert.deepEqual(
    sorted.map((t) => t.id),
    ["a", "b"]
  );
});

test("historical plaintext label is Chinese and low-key", () => {
  assert.equal(HISTORICAL_PLAINTEXT_LABEL, "历史明文");
});
