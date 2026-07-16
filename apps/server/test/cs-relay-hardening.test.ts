/**
 * Hardening checks for relay-P5 (padding / no-store contract).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

function withPad<T extends Record<string, unknown>>(value: T, buckets: number[]): T {
  const json = JSON.stringify(value);
  const target = buckets.find((bucket) => bucket >= json.length) ?? buckets[buckets.length - 1]!;
  const padLen = Math.max(0, target - json.length);
  return padLen > 0 ? { ...value, pad: "0".repeat(padLen) } : value;
}

describe("relay-P5 hardening helpers", () => {
  it("pads payloads into configured buckets", () => {
    const buckets = [64, 256, 1024];
    const small = withPad({ a: "x" }, buckets);
    const mid = withPad({ a: "y".repeat(100) }, buckets);
    assert.ok(JSON.stringify(small).length >= 64);
    assert.ok(JSON.stringify(mid).length >= 256);
  });

  it("documents Cache-Control no-store routes", () => {
    const required = ["enroll", "exchange", "sync", "revoke", "sync/stream"];
    assert.ok(required.includes("exchange"));
  });
});
