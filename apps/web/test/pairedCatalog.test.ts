import assert from "node:assert/strict";
import test from "node:test";
import { buildPairedModelCatalog, modelIsAvailable } from "../src/pairedCatalog.js";

test("buildPairedModelCatalog prepends auto and drops default/hermes aliases", () => {
  const catalog = buildPairedModelCatalog([
    { id: "default", displayName: "Auto" },
    { id: "auto", displayName: "Auto" },
    { id: "grok-4.5", displayName: "Cursor Grok 4.5" },
    { id: "hermes:default", displayName: "Hermes" },
    { id: "composer-2.5", displayName: "Composer 2.5" }
  ]);
  assert.deepEqual(
    catalog.map((item) => item.id),
    ["auto", "grok-4.5", "composer-2.5"]
  );
  assert.equal(catalog[0]?.displayName, "Auto");
});

test("buildPairedModelCatalog appends Hermes sidecar models after the paired catalog", () => {
  const catalog = buildPairedModelCatalog(
    [
      { id: "auto", displayName: "Auto" },
      { id: "grok-4.5", displayName: "Cursor Grok 4.5" }
    ],
    [
      { id: "hermes:default", displayName: "Hermes · vps-dmit (default)" },
      { id: "gpt-5.6-sol", displayName: "Not Hermes — ignored" }
    ]
  );
  assert.deepEqual(
    catalog.map((item) => item.id),
    ["auto", "grok-4.5", "hermes:default"]
  );
  assert.equal(
    catalog.find((item) => item.id === "hermes:default")?.displayName,
    "Hermes · vps-dmit (default)"
  );
});

test("buildPairedModelCatalog de-dupes Hermes ids already advertised", () => {
  const catalog = buildPairedModelCatalog(
    [{ id: "auto", displayName: "Auto" }],
    [
      { id: "hermes:default", displayName: "Hermes" },
      { id: "hermes:default", displayName: "Hermes dup" }
    ]
  );
  assert.deepEqual(
    catalog.map((item) => item.id),
    ["auto", "hermes:default"]
  );
});

test("buildPairedModelCatalog still returns Auto when runner catalog is empty", () => {
  assert.deepEqual(buildPairedModelCatalog([]), [{ id: "auto", displayName: "Auto" }]);
});

test("modelIsAvailable checks membership", () => {
  const models = buildPairedModelCatalog([{ id: "gpt-5.6-sol", displayName: "GPT-5.6 Sol" }]);
  assert.equal(modelIsAvailable(models, "auto"), true);
  assert.equal(modelIsAvailable(models, "gpt-5.6-sol"), true);
  assert.equal(modelIsAvailable(models, "missing"), false);
});
