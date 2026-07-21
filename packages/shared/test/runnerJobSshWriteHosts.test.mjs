import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runnerJobSchema } from "../dist/index.js";

const baseJob = {
  runId: "11111111-1111-4111-8111-111111111111",
  conversationId: "22222222-2222-4222-8222-222222222222",
  agentId: null,
  model: "auto",
  prompt: "test",
  workspace: {
    id: "ws-test",
    label: "test",
    path: "/workspace",
    writable: true
  },
  allowWrites: true
};

describe("runner job SSH write hosts", () => {
  it("defaults to no remote write exceptions", () => {
    const parsed = runnerJobSchema.parse(baseJob);
    assert.deepEqual(parsed.sshWriteHosts, []);
  });

  it("accepts explicit SSH aliases", () => {
    const parsed = runnerJobSchema.parse({
      ...baseJob,
      sshWriteHosts: ["vps-dmit", "vps-band"]
    });
    assert.deepEqual(parsed.sshWriteHosts, ["vps-dmit", "vps-band"]);
  });

  it("rejects aliases containing shell syntax", () => {
    assert.throws(() =>
      runnerJobSchema.parse({
        ...baseJob,
        sshWriteHosts: ["vps-dmit;touch /tmp/escaped"]
      })
    );
  });
});
