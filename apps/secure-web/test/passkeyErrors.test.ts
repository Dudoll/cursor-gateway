import assert from "node:assert/strict";
import test from "node:test";
import { classifyWebauthnError, formatPasskeyError } from "../src/passkeyErrors.js";

test("NotAllowedError is not always labeled user_cancelled", () => {
  assert.equal(
    classifyWebauthnError(Object.assign(new Error("The operation either timed out or was not allowed."), { name: "NotAllowedError" })),
    "passkey_not_allowed_or_timeout"
  );
  assert.equal(
    classifyWebauthnError(Object.assign(new Error("The request has been cancelled by the user."), { name: "NotAllowedError" })),
    "passkey_user_cancelled"
  );
  assert.equal(
    classifyWebauthnError(Object.assign(new Error("Not allowed."), { name: "NotAllowedError" })),
    "passkey_not_allowed"
  );
});

test("formatPasskeyError returns actionable Chinese copy", () => {
  const text = formatPasskeyError(new Error("passkey_not_allowed_or_timeout"));
  assert.match(text, /Windows Hello/);
  assert.doesNotMatch(text, /passkey_user_cancelled/);
  assert.match(formatPasskeyError(new Error("passkey_rejected_by_runner")), /Runner/);
});
