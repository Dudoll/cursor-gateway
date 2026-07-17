import {
  E2EE_PROTOCOL,
  E2EE_RUNNER_CODE_PAIRING_KIND,
  e2eeRunnerCodePairingAckSchema,
  e2eeRunnerCodePairingOfferSchema,
  type E2eeRunnerCodePairingOffer,
  type E2eeRunnerPairingBundle
} from "@cursor-gateway/shared";
import {
  generatePairingChallenge,
  importSigningPublicKey,
  macRunnerCodeTranscript,
  normalizeRunnerDeviceCodeInput,
  runnerCodeSas,
  signValue,
  unsignedEnvelope,
  verifyValue
} from "@cursor-gateway/e2ee";
import { GatewayApi } from "./api.js";
import { SecureWebKeyStore } from "./keyStore.js";
import { assertRunnerCertificate, loadTrustRoots } from "./trustRoots.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function uuid(): string {
  return crypto.randomUUID();
}

type StatusResponse = {
  status: string;
  offer: unknown | null;
  ack: unknown | null;
  deviceCert: unknown | null;
  attemptsRemaining: number;
  expiresAt: string;
};

async function pollUntilOffer(api: GatewayApi, enrollId: string): Promise<E2eeRunnerCodePairingOffer> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const status = await api.get<StatusResponse>(`/api/e2ee/v1/runner-code/${enrollId}`);
    if (status.offer) return e2eeRunnerCodePairingOfferSchema.parse(status.offer);
    if (status.status === "expired" || status.status === "rejected" || status.status === "locked") {
      throw new Error(`runner_code_${status.status}`);
    }
    await sleep(2_000);
  }
  throw new Error("runner_code_offer_timeout");
}

/**
 * Step 1: begin an enrollment and wait for the Runner to publish its offer.
 * The Runner shows the one-time code + SAS on its own terminal. Returns the
 * verified offer so the UI can prompt for the code.
 */
export async function startRunnerCodeEnrollment(input: {
  api: GatewayApi;
  keys: SecureWebKeyStore;
  label?: string | null;
  onStatus?: (text: string) => void;
}): Promise<{ enrollId: string; offer: E2eeRunnerCodePairingOffer }> {
  const device = await input.keys.device();
  const trustRoots = await loadTrustRoots(input.api);
  if (trustRoots.length === 0) throw new Error("trust_roots_not_configured");

  const enrollId = uuid();
  const start = {
    protocol: E2EE_PROTOCOL,
    pairingKind: E2EE_RUNNER_CODE_PAIRING_KIND,
    enrollId,
    clientId: device.clientId,
    clientChallenge: generatePairingChallenge(),
    signingKey: device.signingKey,
    encryptionKey: device.encryptionKey,
    ...(input.label ? { label: input.label } : {}),
    secureOrigin: window.location.origin,
    gatewayOrigin: input.api.origin,
    createdAt: new Date().toISOString()
  };

  input.onStatus?.("正在向 Runner 请求设备码…请在 Runner 终端查看一次性码与 6 词 SAS。");
  await input.api.post("/api/e2ee/v1/runner-code/start", { start });

  const offer = await pollUntilOffer(input.api, enrollId);
  if (Date.parse(offer.expiresAt) <= Date.now()) throw new Error("runner_code_expired");
  if (offer.clientId !== device.clientId) throw new Error("runner_code_client_mismatch");
  if (
    offer.clientSigningFingerprint !== device.signingKey.fingerprint ||
    offer.clientEncryptionFingerprint !== device.encryptionKey.fingerprint
  ) {
    throw new Error("runner_code_fingerprint_mismatch");
  }
  if (offer.secureOrigin !== window.location.origin) {
    throw new Error("runner_code_secure_origin_mismatch");
  }
  await assertRunnerCertificate({
    cert: offer.runnerCertificate,
    trustRoots,
    runnerId: offer.runnerId,
    encryptionFingerprint: offer.runnerEncryptionKey.fingerprint,
    signingFingerprint: offer.runnerSigningKey.fingerprint,
    secureOrigin: window.location.origin
  });
  return { enrollId, offer };
}

/** Derive the 6-word SAS the operator must compare against the Runner terminal. */
export async function deriveRunnerCodeSas(
  offer: E2eeRunnerCodePairingOffer,
  code: string
): Promise<string[]> {
  return runnerCodeSas(normalizeRunnerDeviceCodeInput(code), offer);
}

/**
 * Step 2: prove knowledge of the typed code (HMAC transcript tag + SAS + client
 * signature), then wait for the Runner's signed ack. Retries against a bad code
 * are surfaced via the thrown reason so the UI can re-prompt.
 */
export async function confirmRunnerCode(input: {
  api: GatewayApi;
  keys: SecureWebKeyStore;
  enrollId: string;
  offer: E2eeRunnerCodePairingOffer;
  code: string;
  onStatus?: (text: string) => void;
}): Promise<{ runnerId: string; bundle: E2eeRunnerPairingBundle }> {
  const device = await input.keys.device();
  const trustRoots = await loadTrustRoots(input.api);
  const code = normalizeRunnerDeviceCodeInput(input.code);

  const transcriptMac = await macRunnerCodeTranscript(code, input.offer);
  const sas = await runnerCodeSas(code, input.offer);
  const createdAt = new Date().toISOString();
  const unsigned = {
    protocol: E2EE_PROTOCOL,
    pairingKind: E2EE_RUNNER_CODE_PAIRING_KIND,
    enrollId: input.enrollId,
    clientId: device.clientId,
    transcriptMac,
    sas,
    createdAt
  };
  const confirm = {
    ...unsigned,
    signature: await signValue(unsigned, device.signingPrivateKey, device.signingKey.keyId)
  };

  input.onStatus?.("正在提交设备码校验…请在 Runner 终端核对 SAS 并批准。");
  await input.api.post(`/api/e2ee/v1/runner-code/${input.enrollId}/confirm`, { confirm });

  const deadline = Date.now() + 180_000;
  let sawConfirm = true;
  while (Date.now() < deadline) {
    const latest = await input.api.get<StatusResponse>(`/api/e2ee/v1/runner-code/${input.enrollId}`);
    if (latest.ack) {
      const ack = e2eeRunnerCodePairingAckSchema.parse(latest.ack);
      if (ack.status !== "paired") {
        throw new Error(`runner_code_${ack.reason ?? "rejected"}`);
      }
      await assertRunnerCertificate({
        cert: ack.runnerCertificate,
        trustRoots,
        runnerId: ack.runnerId,
        encryptionFingerprint: ack.runnerEncryptionKey.fingerprint,
        signingFingerprint: ack.runnerSigningKey.fingerprint,
        secureOrigin: window.location.origin
      });
      const runnerKey = await importSigningPublicKey(ack.runnerSigningKey.publicKey);
      if (!(await verifyValue(unsignedEnvelope(ack), ack.signature, runnerKey))) {
        throw new Error("runner_code_ack_signature_invalid");
      }
      const bundle: E2eeRunnerPairingBundle = {
        protocol: E2EE_PROTOCOL,
        kind: "runner-pairing",
        runnerId: ack.runnerId,
        encryptionKey: ack.runnerEncryptionKey,
        signingKey: ack.runnerSigningKey,
        createdAt: ack.createdAt
      };
      await input.keys.importRunner(bundle);
      await input.keys.markPaired(ack.runnerId);
      return { runnerId: ack.runnerId, bundle };
    }
    if (latest.status === "locked") throw new Error("runner_code_locked");
    if (latest.status === "rejected") throw new Error("runner_code_rejected");
    if (latest.status === "expired") throw new Error("runner_code_expired");
    // A revert to "offered" means the code was wrong and a retry is allowed.
    if (latest.status === "offered" && sawConfirm) {
      throw new Error(`runner_code_code_mismatch_${latest.attemptsRemaining}`);
    }
    if (latest.status === "confirm_submitted") sawConfirm = true;
    await sleep(1_500);
  }
  throw new Error("runner_code_ack_timeout");
}
