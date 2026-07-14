import assert from "node:assert/strict";
import test from "node:test";
import {
  E2EE_LOGOUT_CONFIRM,
  E2EE_LOGOUT_LABEL,
  buildCfAccessLogoutUrl
} from "../src/e2eeLogout.js";

test("secure-web logout copy is Chinese", () => {
  assert.equal(E2EE_LOGOUT_LABEL, "退出加密");
  assert.match(E2EE_LOGOUT_CONFIRM, /重新.*配对|开始配对/);
});

test("secure-web CF Access logout URL builder", () => {
  assert.equal(
    buildCfAccessLogoutUrl("https://team.cloudflareaccess.com", "https://cs.example.com"),
    "https://team.cloudflareaccess.com/cdn-cgi/access/logout?returnTo=https%3A%2F%2Fcs.example.com"
  );
});
