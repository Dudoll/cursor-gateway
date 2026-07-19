export type PasskeyMode = "registration" | "authentication";

export type PasskeyBridgePayload = {
  mode: PasskeyMode;
  options: Record<string, unknown>;
};

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const MAX_PASSKEY_JSON_BYTES = 256 * 1024;

function jsonClone(value: unknown, code: string): Record<string, unknown> {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error(code);
  }
  if (!serialized || serialized.length > MAX_PASSKEY_JSON_BYTES) {
    throw new Error(code);
  }
  const parsed = JSON.parse(serialized) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(code);
  }
  return parsed as Record<string, unknown>;
}

function requiredBase64Url(value: unknown, code: string): string {
  if (typeof value !== "string" || !BASE64URL.test(value)) throw new Error(code);
  return value;
}

export function encodePasskeyBridgePayload(
  mode: PasskeyMode,
  options: Record<string, unknown>
): PasskeyBridgePayload {
  const cloned = jsonClone(options, "passkey_options_invalid");
  requiredBase64Url(cloned.challenge, "passkey_options_invalid");
  if (mode === "registration") {
    const rp = cloned.rp;
    if (!rp || typeof rp !== "object" || typeof (rp as { id?: unknown }).id !== "string") {
      throw new Error("passkey_rp_id_mismatch");
    }
    const user = cloned.user;
    if (
      !user ||
      typeof user !== "object" ||
      !BASE64URL.test(String((user as { id?: unknown }).id ?? ""))
    ) {
      throw new Error("passkey_options_invalid");
    }
  } else if (typeof cloned.rpId !== "string") {
    throw new Error("passkey_rp_id_mismatch");
  }
  return { mode, options: cloned };
}

export function decodePasskeyBridgeResponse(
  mode: PasskeyMode,
  value: unknown
): Record<string, unknown> {
  const response = jsonClone(value, "passkey_response_invalid");
  requiredBase64Url(response.id, "passkey_response_invalid");
  requiredBase64Url(response.rawId, "passkey_response_invalid");
  if (response.type !== "public-key") throw new Error("passkey_response_invalid");
  if (!response.response || typeof response.response !== "object") {
    throw new Error("passkey_response_invalid");
  }
  const fields = response.response as Record<string, unknown>;
  requiredBase64Url(fields.clientDataJSON, "passkey_response_invalid");
  if (mode === "registration") {
    requiredBase64Url(fields.attestationObject, "passkey_response_invalid");
  } else {
    requiredBase64Url(fields.authenticatorData, "passkey_response_invalid");
    requiredBase64Url(fields.signature, "passkey_response_invalid");
    if (fields.userHandle !== null && fields.userHandle !== undefined) {
      requiredBase64Url(fields.userHandle, "passkey_response_invalid");
    }
  }
  return response;
}
