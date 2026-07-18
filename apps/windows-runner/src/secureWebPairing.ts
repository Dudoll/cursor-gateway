import {
  E2EE_PROTOCOL,
  type E2eeClientPairingBundle,
  type E2eePairingAck,
  type E2eePairingComplete,
  type E2eePairingOffer,
  type E2eePairingStart
} from "@cursor-gateway/shared";
import {
  buildPairingOffer,
  generateMagicLinkToken,
  generatePairingChallenge,
  importSigningPublicKey,
  macPairingTranscript,
  signValue,
  verifyPairingTranscriptMac,
  verifyValue
} from "@cursor-gateway/e2ee";
import { join } from "node:path";
import { homedir } from "node:os";
import { config, isAllowedSecureOrigin } from "./config.js";
import { RunnerE2eeState } from "./e2eeState.js";
import { sendPairingEmail } from "./pairingMail.js";
import { buildPairingMailContent } from "./mail/pairingMailTemplate.js";
import { assertMailAddress, emailFingerprint, maskEmail } from "./mail/mailAddress.js";
import { PairingPendingStore } from "./pairingPendingStore.js";
type GatewayFetch = (path: string, init?: RequestInit) => Promise<Response>;

const pendingStore = new PairingPendingStore(
  join(
    homedir(),
    ".cursor-gateway",
    `pairing-pending-${config.runnerId.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`
  )
);

function pruneExpired() {
  pendingStore.pruneExpired();
}

export async function processSecureWebPairingCycle(input: {
  state: RunnerE2eeState;
  gatewayFetch: GatewayFetch;
}) {
  pruneExpired();
  await claimAndOffer(input);
  await claimAndComplete(input);
  await syncRevocations(input);
}

async function claimAndOffer(input: {
  state: RunnerE2eeState;
  gatewayFetch: GatewayFetch;
}) {
  const response = await input.gatewayFetch("/api/runner/e2ee/v1/pairings/claim-start", {
    method: "POST",
    body: JSON.stringify({ runnerId: config.runnerId })
  });
  if (response.status === 204) return;
  if (!response.ok) {
    throw new Error(`pairing_claim_start_failed_${response.status}`);
  }
  const body = (await response.json()) as {
    pairing?: {
      start: E2eePairingStart;
      expiresAt: string;
      recipientEmail?: string;
    };
  };
  if (!body.pairing?.start) return;
  const start = body.pairing.start;

  let recipientEmail: string;
  try {
    recipientEmail = assertMailAddress(body.pairing.recipientEmail, "recipient");
  } catch (error) {
    console.warn(
      `Rejecting pairing ${start.pairId}: trusted recipient missing/invalid (${error instanceof Error ? error.message : "unknown"})`
    );
    return;
  }

  if (!isAllowedSecureOrigin(start.secureOrigin)) {
    console.warn(`Rejecting pairing ${start.pairId}: secure origin mismatch`);
    return;
  }

  // Magic-link identity is bound by Gateway's Access-authenticated recipient
  // email + high-entropy MAC. Access JWT verification is required for the
  // Passkey path (see webauthnPairing.ts), not for this mail fallback.

  // Reuse the same token/offer across mail + offer publish retries (never regenerate
  // after mailSent). PAIRING_MAIL_TO / browser-supplied emails are never used here.
  let pending = pendingStore.get(start.pairId);
  if (!pending) {
    const token = generateMagicLinkToken();
    const runnerChallenge = generatePairingChallenge();
    const expiresAt = new Date(
      Date.now() + config.pairingTtlSeconds * 1000
    ).toISOString();
    const offer = buildPairingOffer({
      start,
      runnerId: config.runnerId,
      runnerChallenge,
      runnerEncryptionKey: input.state.encryptionKey,
      runnerSigningKey: input.state.signingKey,
      expiresAt,
      emailHint: maskEmail(recipientEmail)
    });
    pending = {
      token,
      offer,
      start,
      recipientEmail,
      mailSent: false,
      createdAt: new Date().toISOString()
    };
    pendingStore.set(start.pairId, pending);
  } else if (pending.recipientEmail !== recipientEmail) {
    console.warn(
      `Rejecting pairing ${start.pairId}: recipient fingerprint mismatch fp=${emailFingerprint(recipientEmail)}`
    );
    pendingStore.delete(start.pairId);
    return;
  }

  if (!pending.mailSent) {
    const magicLink = `${start.secureOrigin.replace(/\/$/, "")}/#pair=${start.pairId}.${pending.token}`;
    const ttlMinutes = Math.max(1, Math.round(config.pairingTtlSeconds / 60));
    const mail = buildPairingMailContent({
      magicLink,
      pairId: start.pairId,
      runnerId: config.runnerId,
      expiresAt: pending.offer.expiresAt,
      ttlHint: `约 ${ttlMinutes} 分钟`
    });
    await sendPairingEmail({
      to: pending.recipientEmail,
      subject: mail.subject,
      magicLink,
      text: mail.text,
      html: mail.html,
      pairId: start.pairId
    });
    pending = { ...pending, mailSent: true };
    pendingStore.set(start.pairId, pending);
  }

  const offerResponse = await input.gatewayFetch("/api/runner/e2ee/v1/pairings/offer", {
    method: "POST",
    body: JSON.stringify({ runnerId: config.runnerId, offer: pending.offer })
  });
  if (!offerResponse.ok) {
    // Keep pending (mailSent) so the next loop retries offer publish without re-mailing.
    throw new Error(`pairing_offer_publish_failed_${offerResponse.status}`);
  }
  console.log(
    `Published pairing offer for ${start.pairId}; magic link mailed (recipient_fp=${emailFingerprint(pending.recipientEmail)})`
  );
}

async function claimAndComplete(input: {
  state: RunnerE2eeState;
  gatewayFetch: GatewayFetch;
}) {
  const response = await input.gatewayFetch(
    "/api/runner/e2ee/v1/pairings/claim-complete",
    {
      method: "POST",
      body: JSON.stringify({ runnerId: config.runnerId })
    }
  );
  if (response.status === 204) return;
  if (!response.ok) {
    throw new Error(`pairing_claim_complete_failed_${response.status}`);
  }
  const body = (await response.json()) as {
    pairing?: {
      pairId: string;
      start: E2eePairingStart;
      offer: E2eePairingOffer;
      complete: E2eePairingComplete;
    };
  };
  if (!body.pairing?.complete || !body.pairing.offer) return;

  const { start, offer, complete } = body.pairing;
  const pending = pendingStore.get(complete.pairId);
  let status: "paired" | "rejected" = "rejected";

  try {
    if (!pending) throw new Error("pairing_token_missing");
    if (Date.parse(offer.expiresAt) <= Date.now()) {
      throw new Error("pairing_expired");
    }
    if (
      pending.offer.runnerChallenge !== offer.runnerChallenge ||
      pending.offer.clientChallenge !== offer.clientChallenge
    ) {
      throw new Error("pairing_challenge_mismatch");
    }

    const macOk = await verifyPairingTranscriptMac(
      pending.token,
      offer,
      complete.transcriptMac
    );
    if (!macOk) throw new Error("pairing_mac_invalid");

    // Defense in depth: also recompute expected MAC
    const expected = await macPairingTranscript(pending.token, offer);
    if (expected !== complete.transcriptMac) throw new Error("pairing_mac_mismatch");

    const clientPublic = await importSigningPublicKey(start.signingKey.publicKey);
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
      !(await verifyValue(unsigned, complete.signature, clientPublic))
    ) {
      throw new Error("pairing_client_signature_invalid");
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
    status = "paired";
    console.log(`Paired secure-web client ${start.clientId}`);
  } catch (error) {
    console.warn(
      `Pairing ${complete.pairId} rejected:`,
      error instanceof Error ? error.message : "unknown"
    );
    status = "rejected";
  } finally {
    pendingStore.delete(complete.pairId);
  }

  const unsignedAck = {
    protocol: E2EE_PROTOCOL,
    pairingKind: "secure-web-magic-link/1" as const,
    pairId: complete.pairId,
    clientId: complete.clientId,
    runnerId: config.runnerId,
    status,
    runnerEncryptionKey: input.state.encryptionKey,
    runnerSigningKey: input.state.signingKey,
    createdAt: new Date().toISOString()
  };
  const ack: E2eePairingAck = {
    ...unsignedAck,
    signature: await signValue(
      unsignedAck,
      input.state.signingPrivateKey,
      input.state.signingKey.keyId
    )
  };

  const ackResponse = await input.gatewayFetch("/api/runner/e2ee/v1/pairings/ack", {
    method: "POST",
    body: JSON.stringify({ runnerId: config.runnerId, ack })
  });
  if (!ackResponse.ok) {
    throw new Error(`pairing_ack_failed_${ackResponse.status}`);
  }
}

async function syncRevocations(input: {
  state: RunnerE2eeState;
  gatewayFetch: GatewayFetch;
}) {
  const response = await input.gatewayFetch(
    `/api/runner/e2ee/v1/devices/pending-revocations?runnerId=${encodeURIComponent(config.runnerId)}`
  );
  if (!response.ok || response.status === 204) return;
  const raw = await response.text();
  if (!raw.trim()) return;
  const body = JSON.parse(raw) as {
    revocations?: Array<{ clientId: string }>;
  };
  for (const item of body.revocations ?? []) {
    await input.state.revokeClient(item.clientId);
    await input.gatewayFetch(
      `/api/runner/e2ee/v1/devices/${encodeURIComponent(item.clientId)}/revoked`,
      {
        method: "POST",
        body: JSON.stringify({ runnerId: config.runnerId })
      }
    );
    console.log(`Revoked client ${item.clientId} from runner state`);
  }
}

/** Expose for tests / dry-run helpers. */
export function __testPendingPairings() {
  return pendingStore;
}
