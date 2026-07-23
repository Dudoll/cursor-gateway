import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  E2EE_PROTOCOL,
  E2EE_RECOVERY_PAIRING_KIND,
  type E2eeClientPairingBundle,
  type E2eeRecoveryPairingAck,
  type E2eeRecoveryPairingOffer,
  type E2eeRecoveryPairingStart
} from "@cursor-gateway/shared";
import {
  generatePairingChallenge,
  importSigningPublicKey,
  macRecoveryTranscript,
  signValue,
  verifyRecoveryTranscriptMac,
  verifyValue
} from "@cursor-gateway/e2ee";
import { config } from "./config.js";
import { RunnerE2eeState } from "./e2eeState.js";
import { getRunnerCertificate } from "./runnerCert.js";

type GatewayFetch = (path: string, init?: RequestInit) => Promise<Response>;

/**
 * Recovery codes are created offline by `scripts/e2ee/trust-root-cli.ts recovery-code`
 * (or manually) into this file. The secret NEVER leaves this machine / the
 * printed URL — it is not sent to the Gateway. Only the recoveryId (used as
 * the pairing `pairId`) and public offer material cross the wire.
 */
const recoveryCodeFileSchema = z
  .object({
    version: z.literal(1),
    codes: z.record(
      z.string().uuid(),
      z.object({
        secret: z.string().min(1),
        runnerId: z.string().min(1),
        createdAt: z.string().min(1),
        expiresAt: z.string().min(1),
        usedAt: z.string().min(1).nullable().default(null)
      })
    )
  })
  .strict();

type RecoveryCodeFile = z.infer<typeof recoveryCodeFileSchema>;

function recoveryCodeFilePath(): string {
  return join(
    homedir(),
    ".cursor-gateway",
    `recovery-pending-${config.runnerId.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`
  );
}

function loadRecoveryCodes(): RecoveryCodeFile {
  const path = recoveryCodeFilePath();
  if (!existsSync(path)) return { version: 1, codes: {} };
  try {
    return recoveryCodeFileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    console.warn("[recovery] failed to parse recovery code file; treating as empty");
    return { version: 1, codes: {} };
  }
}

function saveRecoveryCodes(file: RecoveryCodeFile): void {
  const path = recoveryCodeFilePath();
  mkdirSync(join(homedir(), ".cursor-gateway"), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(file, null, 2), { mode: 0o600 });
  renameSync(temporaryPath, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best-effort.
  }
}

/** In-memory only — offers never need to survive a Runner restart. */
const pendingOffers = new Map<string, E2eeRecoveryPairingOffer>();

export async function processRecoveryPairingCycle(input: {
  state: RunnerE2eeState;
  gatewayFetch: GatewayFetch;
}) {
  pruneExpiredOffers();
  await claimAndPublishOffer(input);
  await claimAndVerifyComplete(input);
}

function pruneExpiredOffers() {
  const now = Date.now();
  for (const [pairId, offer] of pendingOffers) {
    if (Date.parse(offer.expiresAt) <= now) pendingOffers.delete(pairId);
  }
}

async function claimAndPublishOffer(input: {
  state: RunnerE2eeState;
  gatewayFetch: GatewayFetch;
}) {
  const response = await input.gatewayFetch("/api/runner/e2ee/v1/recovery/claim-start", {
    method: "POST",
    body: JSON.stringify({ runnerId: config.runnerId })
  });
  if (response.status === 204) return;
  if (!response.ok) throw new Error(`recovery_claim_start_failed_${response.status}`);
  const body = (await response.json()) as {
    pairing?: { pairId: string; start: E2eeRecoveryPairingStart; expiresAt: string };
  };
  if (!body.pairing?.start) return;
  const { pairId, start } = body.pairing;

  if (pendingOffers.has(pairId)) return; // Already published; wait for completion.

  const codes = loadRecoveryCodes();
  const code = codes.codes[pairId];
  if (!code || code.usedAt || Date.parse(code.expiresAt) <= Date.now()) {
    // No matching local secret for this recoveryId on this Runner — leave it
    // for another Runner (or let it expire); we cannot build an offer.
    return;
  }
  if (
    config.secureClientOrigins.size > 0 &&
    !config.secureClientOrigins.has(start.secureOrigin)
  ) {
    console.warn(`Rejecting recovery pairing ${pairId}: secure origin mismatch`);
    return;
  }

  const cert = await getRunnerCertificate(input.state);
  if (!cert) {
    console.warn(`Cannot publish recovery offer for ${pairId}: no valid Runner identity certificate`);
    return;
  }

  const expiresAt = new Date(
    Math.min(Date.parse(code.expiresAt), Date.now() + config.recoveryTtlSeconds * 1000)
  ).toISOString();
  const offer: E2eeRecoveryPairingOffer = {
    protocol: E2EE_PROTOCOL,
    pairingKind: E2EE_RECOVERY_PAIRING_KIND,
    pairId,
    runnerId: config.runnerId,
    runnerChallenge: generatePairingChallenge(),
    runnerEncryptionKey: input.state.encryptionKey,
    runnerSigningKey: input.state.signingKey,
    runnerCertificate: cert,
    clientId: start.clientId,
    clientChallenge: start.clientChallenge,
    clientSigningFingerprint: start.signingKey.fingerprint,
    clientEncryptionFingerprint: start.encryptionKey.fingerprint,
    secureOrigin: start.secureOrigin,
    gatewayOrigin: start.gatewayOrigin,
    expiresAt,
    createdAt: new Date().toISOString()
  };
  pendingOffers.set(pairId, offer);

  const offerResponse = await input.gatewayFetch("/api/runner/e2ee/v1/recovery/offer", {
    method: "POST",
    body: JSON.stringify({ runnerId: config.runnerId, offer })
  });
  if (!offerResponse.ok) throw new Error(`recovery_offer_publish_failed_${offerResponse.status}`);
  console.log(`Published recovery offer for ${pairId}`);
}

async function claimAndVerifyComplete(input: {
  state: RunnerE2eeState;
  gatewayFetch: GatewayFetch;
}) {
  const response = await input.gatewayFetch("/api/runner/e2ee/v1/recovery/claim-complete", {
    method: "POST",
    body: JSON.stringify({ runnerId: config.runnerId })
  });
  if (response.status === 204) return;
  if (!response.ok) throw new Error(`recovery_claim_complete_failed_${response.status}`);
  const body = (await response.json()) as {
    pairing?: {
      pairId: string;
      start: E2eeRecoveryPairingStart;
      offer: E2eeRecoveryPairingOffer;
      complete: {
        protocol: string;
        pairingKind: string;
        pairId: string;
        clientId: string;
        transcriptMac: string;
        signature: { alg: "ES256"; keyId: string; value: string };
        createdAt: string;
      };
    };
  };
  if (!body.pairing?.complete) return;
  const { pairId, start, offer, complete } = body.pairing;
  let status: "paired" | "rejected" = "rejected";

  try {
    const pendingOffer = pendingOffers.get(pairId);
    if (!pendingOffer) throw new Error("recovery_offer_missing");
    if (pendingOffer.runnerChallenge !== offer.runnerChallenge) {
      throw new Error("recovery_offer_challenge_mismatch");
    }
    if (Date.parse(offer.expiresAt) <= Date.now()) throw new Error("recovery_expired");

    const codes = loadRecoveryCodes();
    const code = codes.codes[pairId];
    if (!code || code.usedAt) throw new Error("recovery_code_already_used_or_missing");
    if (Date.parse(code.expiresAt) <= Date.now()) throw new Error("recovery_code_expired");

    const macOk = await verifyRecoveryTranscriptMac(code.secret, offer, complete.transcriptMac);
    if (!macOk) throw new Error("recovery_mac_invalid");

    const clientPublicKey = await importSigningPublicKey(start.signingKey.publicKey);
    const unsigned = {
      protocol: complete.protocol,
      pairingKind: complete.pairingKind,
      pairId: complete.pairId,
      clientId: complete.clientId,
      transcriptMac: complete.transcriptMac,
      createdAt: complete.createdAt
    };
    if (
      complete.signature.keyId !== start.signingKey.keyId ||
      !(await verifyValue(unsigned, complete.signature, clientPublicKey))
    ) {
      throw new Error("recovery_client_signature_invalid");
    }

    const bundle: E2eeClientPairingBundle = {
      protocol: E2EE_PROTOCOL,
      kind: "client-pairing",
      clientId: start.clientId,
      signingKey: start.signingKey,
      encryptionKey: start.encryptionKey,
      createdAt: new Date().toISOString()
    };
    await input.state.pairClient(bundle);

    // Single-use: mark the code consumed only on a *successful* pairing.
    codes.codes[pairId] = { ...code, usedAt: new Date().toISOString() };
    saveRecoveryCodes(codes);

    status = "paired";
    console.log(`Paired secure-web client ${start.clientId} via recovery code ${pairId}`);
  } catch (error) {
    console.warn(
      `Recovery pairing ${pairId} rejected:`,
      error instanceof Error ? error.message : "unknown"
    );
    status = "rejected";
  } finally {
    pendingOffers.delete(pairId);
  }

  const cert = await getRunnerCertificate(input.state);
  if (!cert) {
    console.warn(`Cannot publish recovery ack for ${pairId}: no valid Runner identity certificate`);
    return;
  }
  const unsignedAck = {
    protocol: E2EE_PROTOCOL,
    pairingKind: E2EE_RECOVERY_PAIRING_KIND as typeof E2EE_RECOVERY_PAIRING_KIND,
    pairId,
    clientId: start.clientId,
    runnerId: config.runnerId,
    status,
    runnerEncryptionKey: input.state.encryptionKey,
    runnerSigningKey: input.state.signingKey,
    runnerCertificate: cert,
    createdAt: new Date().toISOString()
  };
  const ack: E2eeRecoveryPairingAck = {
    ...unsignedAck,
    signature: await signValue(unsignedAck, input.state.signingPrivateKey, input.state.signingKey.keyId)
  };
  const ackResponse = await input.gatewayFetch("/api/runner/e2ee/v1/recovery/ack", {
    method: "POST",
    body: JSON.stringify({ runnerId: config.runnerId, ack })
  });
  if (!ackResponse.ok) throw new Error(`recovery_ack_failed_${ackResponse.status}`);
}

/** Expose for tests / dry-run helpers. */
export function __testRecoveryCodeFilePath() {
  return recoveryCodeFilePath();
}
