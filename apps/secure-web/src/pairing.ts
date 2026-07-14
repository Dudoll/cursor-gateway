import {
  E2EE_PAIRING_KIND,
  E2EE_PROTOCOL,
  e2eePairingAckSchema,
  e2eePairingOfferSchema,
  type E2eePairingOffer,
  type E2eeRunnerPairingBundle
} from "@cursor-gateway/shared";
import {
  generatePairingChallenge,
  importSigningPublicKey,
  macPairingTranscript,
  signValue,
  unsignedEnvelope,
  verifyValue
} from "@cursor-gateway/e2ee";
import { GatewayApi } from "./api.js";
import {
  SecureWebKeyStore,
  clearMagicLinkFragment,
  parseMagicLinkFragment
} from "./keyStore.js";

export type PairingPhase =
  | "idle"
  | "starting"
  | "awaiting_email"
  | "completing"
  | "paired"
  | "rejected"
  | "error";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function startPairing(input: {
  api: GatewayApi;
  keys: SecureWebKeyStore;
}): Promise<{ pairId: string; expiresAt: string }> {
  const device = await input.keys.device();
  const pairId = crypto.randomUUID();
  const clientChallenge = generatePairingChallenge();
  const start = {
    protocol: E2EE_PROTOCOL,
    pairingKind: E2EE_PAIRING_KIND,
    pairId,
    clientId: device.clientId,
    clientChallenge,
    signingKey: device.signingKey,
    encryptionKey: device.encryptionKey,
    secureOrigin: window.location.origin,
    gatewayOrigin: input.api.origin,
    createdAt: new Date().toISOString()
  };
  const response = await input.api.post<{
    pairId: string;
    status: string;
    expiresAt: string;
  }>("/api/e2ee/v1/pairings/start", { start });
  return { pairId: response.pairId, expiresAt: response.expiresAt };
}

export async function pollUntilOffer(
  api: GatewayApi,
  pairId: string,
  options?: { timeoutMs?: number; intervalMs?: number }
): Promise<E2eePairingOffer> {
  const timeoutMs = options?.timeoutMs ?? 180_000;
  const intervalMs = options?.intervalMs ?? 2_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await api.get<{
      pairId: string;
      status: string;
      offer: unknown | null;
      expiresAt: string;
    }>(`/api/e2ee/v1/pairings/${pairId}`);
    if (status.offer) {
      return e2eePairingOfferSchema.parse(status.offer);
    }
    if (status.status === "expired" || status.status === "rejected") {
      throw new Error(`pairing_${status.status}`);
    }
    await sleep(intervalMs);
  }
  throw new Error("pairing_offer_timeout");
}

export async function completePairingFromFragment(input: {
  api: GatewayApi;
  keys: SecureWebKeyStore;
  hash?: string;
}): Promise<{ runnerId: string; bundle: E2eeRunnerPairingBundle }> {
  const parsed = parseMagicLinkFragment(input.hash ?? window.location.hash);
  if (!parsed) throw new Error("magic_link_fragment_missing");

  const status = await input.api.get<{
    pairId: string;
    status: string;
    offer: unknown | null;
    ack: unknown | null;
    expiresAt: string;
  }>(`/api/e2ee/v1/pairings/${parsed.pairId}`);

  if (!status.offer) throw new Error("pairing_offer_not_ready");
  const offer = e2eePairingOfferSchema.parse(status.offer);
  if (Date.parse(offer.expiresAt) <= Date.now()) {
    throw new Error("pairing_expired");
  }

  const device = await input.keys.device();
  if (device.clientId !== offer.clientId) {
    throw new Error("pairing_client_mismatch");
  }
  if (
    offer.clientSigningFingerprint !== device.signingKey.fingerprint ||
    offer.clientEncryptionFingerprint !== device.encryptionKey.fingerprint
  ) {
    throw new Error("pairing_fingerprint_mismatch");
  }
  if (offer.secureOrigin !== window.location.origin) {
    throw new Error("pairing_secure_origin_mismatch");
  }

  const transcriptMac = await macPairingTranscript(parsed.token, offer);
  const createdAt = new Date().toISOString();
  const unsigned = {
    protocol: E2EE_PROTOCOL,
    pairingKind: E2EE_PAIRING_KIND,
    pairId: offer.pairId,
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

  await input.api.post(`/api/e2ee/v1/pairings/${offer.pairId}/complete`, {
    complete
  });

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const latest = await input.api.get<{
      status: string;
      ack: unknown | null;
    }>(`/api/e2ee/v1/pairings/${offer.pairId}`);
    if (latest.ack) {
      const ack = e2eePairingAckSchema.parse(latest.ack);
      const runnerKey = await importSigningPublicKey(ack.runnerSigningKey.publicKey);
      if (!(await verifyValue(unsignedEnvelope(ack), ack.signature, runnerKey))) {
        throw new Error("pairing_ack_signature_invalid");
      }
      if (ack.status !== "paired") {
        throw new Error("pairing_rejected_by_runner");
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
      clearMagicLinkFragment();
      return { runnerId: ack.runnerId, bundle };
    }
    if (latest.status === "rejected" || latest.status === "expired") {
      throw new Error(`pairing_${latest.status}`);
    }
    await sleep(1_500);
  }
  throw new Error("pairing_ack_timeout");
}

export async function tryConsumeMagicLink(input: {
  api: GatewayApi;
  keys: SecureWebKeyStore;
}): Promise<{ runnerId: string } | null> {
  if (!parseMagicLinkFragment(window.location.hash)) return null;
  const result = await completePairingFromFragment(input);
  return { runnerId: result.runnerId };
}
