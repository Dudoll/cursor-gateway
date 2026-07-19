import assert from "node:assert/strict";
import test from "node:test";
import {
  checkDesktopUpdate,
  readPublicUpdateMetadata,
  type DesktopUpdateMetadata
} from "../src/updateChecker.js";

const metadata = (
  version: string,
  installerAvailable = true
): DesktopUpdateMetadata => ({
  version,
  installerAvailable,
  sha256: "a".repeat(64),
  downloadPath: "/api/desktop/download"
});

test("update visibility matrix covers newer, same, older, and missing installer", async () => {
  const cases = [
    { remote: "0.1.7", available: true, expected: "available" },
    { remote: "0.1.6", available: true, expected: "hidden" },
    { remote: "0.1.5", available: true, expected: "hidden" },
    { remote: "0.1.7", available: false, expected: "hidden" }
  ] as const;
  for (const item of cases) {
    const decision = await checkDesktopUpdate({
      localVersion: "0.1.6",
      publicLoader: async () => metadata(item.remote, item.available),
      retryDelaysMs: [0]
    });
    assert.equal(decision.kind, item.expected, `${item.remote}/${item.available}`);
    if (decision.kind === "hidden" && !item.available) {
      assert.equal(decision.reason, "installer_unavailable");
    }
  }
});

test("temporary metadata failure retries and later reveals upgrade", async () => {
  let calls = 0;
  const sleeps: number[] = [];
  const decision = await checkDesktopUpdate({
    localVersion: "0.1.6",
    publicLoader: async () => {
      calls += 1;
      if (calls < 3) throw new Error("network_unreachable");
      return metadata("0.1.7");
    },
    retryDelaysMs: [0, 20, 50],
    sleep: async (ms) => {
      sleeps.push(ms);
    }
  });
  assert.equal(decision.kind, "available");
  assert.equal(decision.attempts, 3);
  assert.deepEqual(sleeps, [20, 50]);
});

test("authenticated fallback recovers immediately after Access becomes ready", async () => {
  let privateCalls = 0;
  const decision = await checkDesktopUpdate({
    localVersion: "0.1.6",
    publicLoader: async () => {
      throw new Error("network_unreachable");
    },
    authenticatedLoader: async () => {
      privateCalls += 1;
      return metadata("0.1.7");
    },
    retryDelaysMs: [0]
  });
  assert.equal(decision.kind, "available");
  assert.equal(privateCalls, 1);
});

test("invalid or unavailable metadata never displays an upgrade", async () => {
  const invalidHash = await checkDesktopUpdate({
    localVersion: "0.1.6",
    publicLoader: async () => ({
      ...metadata("0.1.7"),
      sha256: "not-a-hash"
    }),
    retryDelaysMs: [0]
  });
  assert.deepEqual(invalidHash, {
    kind: "failed",
    code: "desktop_update_hash_invalid",
    attempts: 1
  });

  await assert.rejects(
    readPublicUpdateMetadata({
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ ...metadata("0.1.7"), sha256: "bad" })
      })
    }),
    /desktop_update_hash_invalid/
  );
});

test("all retry attempts failing returns a stable diagnostic code", async () => {
  const decision = await checkDesktopUpdate({
    localVersion: "0.1.6",
    publicLoader: async () => {
      throw new Error("desktop_update_check_timeout");
    },
    retryDelaysMs: [0, 1],
    sleep: async () => {}
  });
  assert.deepEqual(decision, {
    kind: "failed",
    code: "desktop_update_check_timeout",
    attempts: 2
  });
});
