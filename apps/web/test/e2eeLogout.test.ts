import assert from "node:assert/strict";
import test from "node:test";
import {
  E2EE_LOGOUT_CONFIRM,
  E2EE_LOGOUT_DONE,
  E2EE_LOGOUT_LABEL,
  buildCfAccessLogoutUrl
} from "../src/e2eeLogout.js";

test("logout copy is Chinese and points at re-pair", () => {
  assert.equal(E2EE_LOGOUT_LABEL, "退出加密");
  assert.match(E2EE_LOGOUT_CONFIRM, /设备密钥|配对/);
  assert.match(E2EE_LOGOUT_CONFIRM, /不会删除服务端/);
  assert.match(E2EE_LOGOUT_DONE, /启用加密|重新配对/);
});

test("buildCfAccessLogoutUrl uses team domain logout path", () => {
  assert.equal(
    buildCfAccessLogoutUrl("https://example.cloudflareaccess.com"),
    "https://example.cloudflareaccess.com/cdn-cgi/access/logout"
  );
  assert.equal(
    buildCfAccessLogoutUrl("example.cloudflareaccess.com", "https://cs.example.com"),
    "https://example.cloudflareaccess.com/cdn-cgi/access/logout?returnTo=https%3A%2F%2Fcs.example.com"
  );
  assert.equal(buildCfAccessLogoutUrl(""), null);
  assert.equal(buildCfAccessLogoutUrl("   "), null);
});
