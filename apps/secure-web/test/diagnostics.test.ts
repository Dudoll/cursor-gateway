import assert from "node:assert/strict";
import test from "node:test";
import { GatewayApiError } from "../src/api.js";
import {
  diagnosticClipboardText,
  normalizeFailure
} from "../src/diagnostics.js";

const context = {
  stage: "passkey" as const,
  operation: "完成 Passkey 验证",
  endpoint: "/api/e2ee/v1/passkey/123/complete?token=must-not-leak"
};

test("Gateway errors preserve safe request id, stage, and endpoint without query data", () => {
  const value = normalizeFailure(
    new GatewayApiError(
      401,
      "cloudflare_login_required",
      "/api/e2ee/v1/passkey/123/complete",
      "req-safe-42"
    ),
    context
  );
  assert.equal(value.diagnosticId, "req-safe-42");
  assert.equal(value.operation, "完成 Passkey 验证");
  assert.equal(value.endpoint, "/api/e2ee/v1/passkey/123/complete");
  assert.doesNotMatch(JSON.stringify(value), /must-not-leak/);
  assert.match(value.nextStep, /登录/);
});

test("network, Access, origin, RP ID, cancellation, Runner, timeout, 4xx and 5xx map distinctly", () => {
  const cases: Array<[unknown, RegExp]> = [
    [new TypeError("Failed to fetch"), /网络|连接/],
    [new Error("cloudflare_login_required"), /登录/],
    [new Error("secure_origin_mismatch"), /地址/],
    [new Error("passkey_rp_id_mismatch"), /Passkey/],
    [new Error("passkey_user_cancelled"), /取消/],
    [new Error("runner_offline"), /离线/],
    [new Error("request_timeout"), /超时/],
    [new GatewayApiError(409, "pairing_status_invalid"), /请求/],
    [new GatewayApiError(503, "http_503"), /服务/]
  ];
  const titles = new Set<string>();
  for (const [error, pattern] of cases) {
    const value = normalizeFailure(error, context);
    assert.match(`${value.title}${value.message}${value.possibleCause}`, pattern);
    assert.ok(value.nextStep.length > 0);
    assert.notEqual(value.code, "unknown_error");
    titles.add(value.title);
  }
  assert.ok(titles.size >= 7);
});

test("opaque errors become actionable diagnostics instead of unknown_error", () => {
  const value = normalizeFailure({ unexpected: true }, context);
  assert.equal(value.code, "internal_client_error");
  assert.match(value.title, /客户端/);
  assert.match(value.nextStep, /诊断编号/);
  const copied = diagnosticClipboardText(value);
  assert.match(copied, /失败环节: 完成 Passkey 验证/);
  assert.doesNotMatch(copied, /token=/);
});

test("cross-origin fetch failures are not falsely asserted to be CORS", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  try {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location: { href: "http://tauri.localhost/", origin: "http://tauri.localhost" } }
    });
    const value = normalizeFailure(new TypeError("Failed to fetch"), {
      stage: "update-check",
      operation: "检查新版本",
      endpoint:
        "https://raw.githubusercontent.com/Dudoll/cursor-gateway/main/apps/secure-web/public/desktop-version.json"
    });
    assert.equal(value.code, "network_or_cors");
    assert.notEqual(value.code, "cors_origin_blocked");
  } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("upgrade and device-code branches remain concrete and actionable", () => {
  const cases = [
    "desktop_installer_unavailable",
    "desktop_update_hash_mismatch",
    "desktop_download_invalid_executable",
    "desktop_installer_spawn:access denied",
    "runner_code_code_mismatch_2",
    "runner_code_locked",
    "recovery_code_missing"
  ];
  for (const code of cases) {
    const value = normalizeFailure(new Error(code), {
      stage: code.startsWith("desktop_") ? "update-download" : "pairing-submit",
      operation: code.startsWith("desktop_") ? "安装更新" : "验证设备",
      endpoint: code.startsWith("desktop_")
        ? "/api/desktop/download"
        : "/api/e2ee/v1/runner-code/confirm"
    });
    assert.notEqual(value.title, "客户端未能完成操作", code);
    assert.ok(value.possibleCause.length > 0, code);
    assert.ok(value.nextStep.length > 0, code);
    assert.ok(value.diagnosticId.startsWith("CG-"), code);
  }
});
