import {
  E2EE_PROTOCOL,
  E2EE_RECOVERY_PAIRING_KIND,
  e2eeRecoveryPairingAckSchema,
  e2eeRecoveryPairingOfferSchema,
  type E2eeRecoveryPairingOffer,
  type E2eeRunnerPairingBundle
} from "@cursor-gateway/shared";
import {
  generatePairingChallenge,
  importSigningPublicKey,
  macRecoveryTranscript,
  normalizeRecoverySecretInput,
  signValue,
  unsignedEnvelope,
  verifyValue
} from "@cursor-gateway/e2ee";
import { GatewayApi } from "./api.js";
import { SecureWebKeyStore } from "./keyStore.js";
import { assertRunnerCertificate, loadTrustRoots } from "./trustRoots.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Parse a Runner-generated recovery URL. Secret MUST stay in the fragment so
 * it never hits Gateway access logs. Supported forms:
 *   https://secure…/#recover=<recoveryId>.<secret>
 *   https://secure…/#recovery=<recoveryId>.<secret>
 */
export function parseRecoveryFragment(hash = window.location.hash): {
  recoveryId: string;
  secret: string;
} | null {
  const match = hash.match(/[#&]recover(?:y)?=([^&]+)/i);
  if (!match?.[1]) return null;
  const decoded = decodeURIComponent(match[1]);
  const dot = decoded.indexOf(".");
  if (dot <= 0) return null;
  const recoveryId = decoded.slice(0, dot);
  const secret = decoded.slice(dot + 1);
  if (!/^[0-9a-f-]{36}$/i.test(recoveryId) || secret.length < 16) return null;
  return { recoveryId, secret };
}

export function clearRecoveryFragment() {
  if (!/#.*recover(?:y)?=/i.test(window.location.hash)) return;
  const url = new URL(window.location.href);
  url.hash = "";
  history.replaceState(null, "", `${url.pathname}${url.search}`);
}

async function pollUntilOffer(
  api: GatewayApi,
  pairId: string
): Promise<E2eeRecoveryPairingOffer> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const status = await api.get<{
      status: string;
      offer: unknown | null;
    }>(`/api/e2ee/v1/recovery/${pairId}`);
    if (status.offer) return e2eeRecoveryPairingOfferSchema.parse(status.offer);
    if (status.status === "expired" || status.status === "rejected") {
      throw new Error(`recovery_${status.status}`);
    }
    await sleep(2_000);
  }
  throw new Error("recovery_offer_timeout");
}

/**
 * Recovery path: high-entropy secret generated on the Runner (QR / Crockford
 * code). Gateway never sees the secret — only recoveryId + public envelopes.
 * Client MACs the offer transcript with HKDF-HMAC derived from the secret.
 */
export async function pairWithRecovery(input: {
  api: GatewayApi;
  keys: SecureWebKeyStore;
  recoveryId: string;
  /** base64url secret OR Crockford-grouped display form */
  secret: string;
  onStatus?: (text: string) => void;
}): Promise<{ runnerId: string; bundle: E2eeRunnerPairingBundle }> {
  const device = await input.keys.device();
  const trustRoots = await loadTrustRoots(input.api);
  if (trustRoots.length === 0) throw new Error("trust_roots_not_configured");

  const macSecret = normalizeRecoverySecretInput(input.secret);

  const handle = await input.api.get<{ recoveryId: string; expiresAt: string }>(
    `/api/e2ee/v1/recovery/handles/${input.recoveryId}`
  );
  if (Date.parse(handle.expiresAt) <= Date.now()) {
    throw new Error("recovery_handle_expired");
  }

  const pairId = input.recoveryId;
  const clientChallenge = generatePairingChallenge();
  const start = {
    protocol: E2EE_PROTOCOL,
    pairingKind: E2EE_RECOVERY_PAIRING_KIND,
    pairId,
    clientId: device.clientId,
    clientChallenge,
    signingKey: device.signingKey,
    encryptionKey: device.encryptionKey,
    secureOrigin: window.location.origin,
    gatewayOrigin: input.api.origin,
    createdAt: new Date().toISOString()
  };

  input.onStatus?.("正在请求恢复码配对…");
  await input.api.post("/api/e2ee/v1/recovery/start", { start });

  const offer = await pollUntilOffer(input.api, pairId);
  if (Date.parse(offer.expiresAt) <= Date.now()) throw new Error("recovery_expired");
  if (offer.clientId !== device.clientId) throw new Error("recovery_client_mismatch");
  if (
    offer.clientSigningFingerprint !== device.signingKey.fingerprint ||
    offer.clientEncryptionFingerprint !== device.encryptionKey.fingerprint
  ) {
    throw new Error("recovery_fingerprint_mismatch");
  }
  if (offer.secureOrigin !== window.location.origin) {
    throw new Error("recovery_secure_origin_mismatch");
  }

  await assertRunnerCertificate({
    cert: offer.runnerCertificate,
    trustRoots,
    runnerId: offer.runnerId,
    encryptionFingerprint: offer.runnerEncryptionKey.fingerprint,
    signingFingerprint: offer.runnerSigningKey.fingerprint,
    secureOrigin: window.location.origin
  });

  const transcriptMac = await macRecoveryTranscript(macSecret, offer);
  const createdAt = new Date().toISOString();
  const unsigned = {
    protocol: E2EE_PROTOCOL,
    pairingKind: E2EE_RECOVERY_PAIRING_KIND,
    pairId,
    clientId: device.clientId,
    transcriptMac,
    createdAt
  };
  const complete = {
    ...unsigned,
    signature: await signValue(
      unsigned,
      device.signingPrivateKey,
      device.signingKey.keyId
    )
  };

  input.onStatus?.("正在验证恢复码…");
  await input.api.post(`/api/e2ee/v1/recovery/${pairId}/complete`, { complete });

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const latest = await input.api.get<{ status: string; ack: unknown | null }>(
      `/api/e2ee/v1/recovery/${pairId}`
    );
    if (latest.ack) {
      const ack = e2eeRecoveryPairingAckSchema.parse(latest.ack);
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
        throw new Error("recovery_ack_signature_invalid");
      }
      if (ack.status !== "paired") throw new Error("recovery_rejected_by_runner");
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
      clearRecoveryFragment();
      return { runnerId: ack.runnerId, bundle };
    }
    if (latest.status === "rejected" || latest.status === "expired") {
      throw new Error(`recovery_${latest.status}`);
    }
    await sleep(1_500);
  }
  throw new Error("recovery_ack_timeout");
}
