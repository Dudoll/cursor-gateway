/**
 * Optional account-bound cg-device-cert/2 issuance for RAMC pairings.
 *
 * After a Runner-assisted manual code enrollment reaches `paired`, and when the
 * cg-mitm secure server config is present, the Gateway signs a
 * `cg-device-cert/2` binding accountId + deviceId + epoch to the browser's
 * device keys and upserts it into `cg_devices`. The browser retrieves it via
 * the cg-mitm ciphertext channel. When cg-mitm is disabled this is a no-op —
 * the E2EE device row (written unconditionally on pairing) is sufficient for
 * RAMC to function.
 */
import { randomUUID } from "node:crypto";
import { issueCgDeviceCertV2 } from "@cursor-gateway/e2ee";
import type { CgDeviceCert, E2eeKeyDescriptor } from "@cursor-gateway/shared";
import { loadCgSecureConfig } from "./csapi/secure.js";
import { upsertCgDevice } from "./cgDevicesDb.js";

export async function maybeIssueRunnerCodeDeviceCert(input: {
  accountId: string;
  signingKey: E2eeKeyDescriptor;
  encryptionKey: E2eeKeyDescriptor;
  label: string | null;
}): Promise<CgDeviceCert | null> {
  let secure;
  try {
    secure = await loadCgSecureConfig();
  } catch (error) {
    console.warn(
      "[ramc-cert] failed to load cg secure config; skipping cert issuance:",
      error instanceof Error ? error.message : "unknown"
    );
    return null;
  }
  if (!secure) return null;

  const deviceId = randomUUID();
  const epoch = 1;
  const deviceCert = await issueCgDeviceCertV2({
    signingPrivateKey: secure.signingPrivateKey,
    signingKeyId: secure.signingKeyId,
    accountId: input.accountId,
    deviceId,
    epoch,
    authScope: "cf-access",
    signingKey: input.signingKey,
    encryptionKey: input.encryptionKey,
    keyIdHint: input.signingKey.keyId,
    serverCertId: secure.serverCertId
  });

  await upsertCgDevice({
    deviceId,
    accountId: input.accountId,
    signingFingerprint: input.signingKey.fingerprint,
    encryptionFingerprint: input.encryptionKey.fingerprint,
    deviceCert,
    epoch,
    label: input.label ?? "secure-web-runner-code"
  });

  return deviceCert;
}
