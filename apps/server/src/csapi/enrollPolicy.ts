/**
 * Production opt-in for first-device enrollment with a valid CSAPI key.
 * Kept separate from CS_RELAY_ALLOW_MEMORY_DEVICES so enabling enrollment
 * never relaxes database persistence or permits an in-memory device fallback.
 */
export function apiKeyEnrollEnabled(value = process.env.CG_ALLOW_API_KEY_ENROLL): boolean {
  return typeof value === "string" && ["1", "true", "yes", "on"].includes(value.toLowerCase());
}
