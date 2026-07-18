import assert from "node:assert/strict";
import test from "node:test";
import { errorText } from "../src/errorText.js";
import { GatewayApiError } from "../src/api.js";

test("errorText returns the GatewayApiError code", () => {
  assert.equal(errorText(new GatewayApiError(400, "secure_origin_mismatch")), "secure_origin_mismatch");
});

test("errorText returns the message for Error instances", () => {
  assert.equal(errorText(new Error("device_not_paired")), "device_not_paired");
});

test("errorText surfaces raw string errors from the Tauri bridge", () => {
  // Regression: Tauri `invoke` rejects with a plain string on Err(String).
  // Previously these collapsed into "unknown_error", hiding the real cause of
  // "设备批准失败：unknown_error".
  assert.equal(errorText("access_bridge_fetch_timeout"), "access_bridge_fetch_timeout");
  assert.equal(errorText("access_bridge_not_ready"), "access_bridge_not_ready");
  assert.equal(errorText("  cloudflare_login_required  "), "cloudflare_login_required");
});

test("errorText falls back to unknown_error only for truly opaque values", () => {
  assert.equal(errorText(undefined), "unknown_error");
  assert.equal(errorText(null), "unknown_error");
  assert.equal(errorText(""), "unknown_error");
  assert.equal(errorText("   "), "unknown_error");
  assert.equal(errorText({ weird: true }), "unknown_error");
});
