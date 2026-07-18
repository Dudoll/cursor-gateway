import assert from "node:assert/strict";
import test from "node:test";
import { isNewerDesktopVersion } from "../src/desktopShell.js";

test("isNewerDesktopVersion detects upgrades", () => {
  assert.equal(isNewerDesktopVersion("0.1.1", "0.1.0"), true);
  assert.equal(isNewerDesktopVersion("0.2.0", "0.1.9"), true);
  assert.equal(isNewerDesktopVersion("1.0.0", "0.9.9"), true);
  assert.equal(isNewerDesktopVersion("0.1.0", "0.1.0"), false);
  assert.equal(isNewerDesktopVersion("0.1.0", "0.1.1"), false);
  assert.equal(isNewerDesktopVersion("v0.1.2", "0.1.1"), true);
});
