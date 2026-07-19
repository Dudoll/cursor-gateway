import assert from "node:assert/strict";
import test from "node:test";
import {
  decodePasskeyBridgeResponse,
  encodePasskeyBridgePayload
} from "../src/passkeyCodec.js";
import {
  normalizeCeremonyOrigin,
  originCanUseRpId,
  passkeyRpId
} from "../src/passkeyPairing.js";

const b64 = "AQIDBAUGBwgJCgsMDQ4PEA";

test("registration options and result survive the desktop bridge JSON boundary", () => {
  const payload = encodePasskeyBridgePayload("registration", {
    challenge: b64,
    rp: { id: "secure.joelzt.org", name: "Secure Gateway" },
    user: { id: b64, name: "u@example.test", displayName: "User" },
    pubKeyCredParams: [{ alg: -7, type: "public-key" }]
  });
  assert.deepEqual(JSON.parse(JSON.stringify(payload)), payload);
  const response = decodePasskeyBridgeResponse("registration", {
    id: b64,
    rawId: b64,
    type: "public-key",
    response: {
      clientDataJSON: b64,
      attestationObject: b64,
      transports: ["internal"]
    },
    clientExtensionResults: {}
  });
  assert.equal(response.id, b64);
});

test("authentication options and assertion survive the desktop bridge JSON boundary", () => {
  const payload = encodePasskeyBridgePayload("authentication", {
    challenge: b64,
    rpId: "secure.joelzt.org",
    allowCredentials: [{ id: b64, type: "public-key", transports: ["internal"] }]
  });
  assert.equal(payload.options.rpId, "secure.joelzt.org");
  const response = decodePasskeyBridgeResponse("authentication", {
    id: b64,
    rawId: b64,
    type: "public-key",
    response: {
      clientDataJSON: b64,
      authenticatorData: b64,
      signature: b64,
      userHandle: null
    }
  });
  assert.equal(response.type, "public-key");
});

test("malformed options/results fail closed", () => {
  assert.throws(
    () => encodePasskeyBridgePayload("authentication", { challenge: b64 }),
    /passkey_rp_id_mismatch/
  );
  assert.throws(
    () =>
      decodePasskeyBridgeResponse("authentication", {
        id: b64,
        rawId: b64,
        type: "public-key",
        response: { clientDataJSON: b64, signature: b64 }
      }),
    /passkey_response_invalid/
  );
});

test("tauri.localhost cannot assert secure.joelzt.org RP ID", () => {
  assert.equal(originCanUseRpId("http://tauri.localhost", "secure.joelzt.org"), false);
  assert.equal(originCanUseRpId("https://secure.joelzt.org", "secure.joelzt.org"), true);
  assert.equal(originCanUseRpId("https://login.joelzt.org", "joelzt.org"), true);
  assert.throws(() => normalizeCeremonyOrigin("http://tauri.localhost"), /passkey_security_error/);
  assert.equal(
    passkeyRpId({
      mode: "authentication",
      options: { rpId: "secure.joelzt.org" }
    } as never),
    "secure.joelzt.org"
  );
});
