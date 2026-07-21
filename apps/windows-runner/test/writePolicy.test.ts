import assert from "node:assert/strict";
import test from "node:test";
import { buildWritePolicy } from "../src/writePolicy.js";

test("keeps read-only jobs read-only even when hosts are present", () => {
  const policy = buildWritePolicy({
    allowWrites: false,
    sshWriteHosts: ["vps-dmit", "vps-band"]
  });
  assert.match(policy, /Do not modify files/);
  assert.doesNotMatch(policy, /vps-dmit/);
});

test("allows any local path and external SSH for ordinary write jobs", () => {
  const policy = buildWritePolicy({ allowWrites: true, sshWriteHosts: [] });
  assert.match(policy, /any path on this machine/);
  assert.match(policy, /SSH-family tools/);
  assert.match(policy, /external hosts/);
  assert.doesNotMatch(policy, /only inside the configured workspace/);
  assert.doesNotMatch(policy, /Preconfigured SSH aliases/);
});

test("mentions preconfigured SSH aliases when provided", () => {
  const policy = buildWritePolicy({
    allowWrites: true,
    sshWriteHosts: ["vps-dmit", "vps-band"]
  });
  assert.match(policy, /any path on this machine/);
  assert.match(policy, /SSH-family tools/);
  assert.match(policy, /Preconfigured SSH aliases/);
  assert.match(policy, /vps-dmit, vps-band/);
});

test("deduplicates aliases in the rendered policy", () => {
  const policy = buildWritePolicy({
    allowWrites: true,
    sshWriteHosts: ["vps-dmit", "vps-dmit"]
  });
  assert.equal(policy.match(/vps-dmit/g)?.length, 1);
});
