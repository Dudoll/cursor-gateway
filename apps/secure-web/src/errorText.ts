import { GatewayApiError } from "./api.js";

/**
 * Normalize an unknown thrown value into a short, safe error code / message.
 *
 * Tauri's `invoke` rejects with a plain **string** (not an `Error`) whenever a
 * Rust command returns `Err(String)` — this is how every Access-bridge failure
 * (`access_bridge_fetch_timeout`, `access_bridge_bad_payload`, a WebView
 * `fetch` network error, etc.) surfaces on the desktop client. The string
 * branch below is therefore essential: without it those real codes were
 * collapsed into a useless generic `"unknown_error"`, masking the true cause of
 * desktop failures such as "设备批准失败：unknown_error".
 *
 * Codes are safe to display: GatewayApiError codes are validated against a
 * strict allow-list before construction, and bridge strings are short machine
 * codes. We never surface untrusted HTML/error bodies here.
 */
export function errorText(error: unknown): string {
  if (error instanceof GatewayApiError) return error.code;
  if (error instanceof Error) return error.message;
  if (typeof error === "string" && error.trim() !== "") return error.trim();
  return "unknown_error";
}
