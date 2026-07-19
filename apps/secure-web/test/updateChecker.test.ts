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
  schemaVersion: 1,
  version,
  installerAvailable,
  sha256: "a".repeat(64),
  installerUrl: "https://cs.joelzt.org/api/desktop/download",
  publishedAt: "2026-07-19T00:00:00.000Z"
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
        headers: new Headers({ "content-type": "application/json" }),
        text: async () => JSON.stringify({ ...metadata("0.1.7"), sha256: "bad" })
      })
    }),
    /desktop_update_hash_invalid/
  );
});

test("HTML fallback and bad content type get precise errors", async () => {
  await assert.rejects(
    readPublicUpdateMetadata({
      url: "https://secure.joelzt.org/desktop-version.json",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/html" }),
        text: async () => "<!doctype html><title>SPA</title>"
      })
    }),
    /desktop_update_html_fallback/
  );
  await assert.rejects(
    readPublicUpdateMetadata({
      url: "https://example.test/manifest",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/csv" }),
        text: async () => JSON.stringify(metadata("0.1.7"))
      })
    }),
    /desktop_update_content_type_invalid/
  );
});

test("manifest requires hash, schema, and allowlisted installer URL", async () => {
  for (const [change, code] of [
    [{ sha256: "" }, "desktop_update_hash_missing"],
    [{ schemaVersion: 2 }, "desktop_update_schema_unsupported"],
    [{ installerUrl: "https://evil.example/setup.exe" }, "desktop_update_installer_url_invalid"]
  ] as const) {
    await assert.rejects(
      readPublicUpdateMetadata({
        url: "https://example.test/manifest.json",
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          text: async () => JSON.stringify({ ...metadata("0.1.7"), ...change })
        })
      }),
      new RegExp(code)
    );
  }
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

test("cancelled update check stops before creating duplicate requests", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const decision = await checkDesktopUpdate({
    localVersion: "0.1.8",
    signal: controller.signal,
    publicLoader: async () => {
      calls += 1;
      return metadata("0.1.9");
    }
  });
  assert.deepEqual(decision, {
    kind: "failed",
    code: "desktop_update_check_cancelled",
    attempts: 0
  });
  assert.equal(calls, 0);
});
