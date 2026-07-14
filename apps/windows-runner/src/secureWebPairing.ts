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
import { config } from "./config.js";
import { RunnerE2eeState } from "./e2eeState.js";
import { sendPairingEmail } from "./pairingMail.js";
import { verifyAccessJwt } from "./accessJwt.js";

type GatewayFetch = (path: string, init?: RequestInit) => Promise<Response>;

type PendingPairing = {
  token: string;
  offer: E2eePairingOffer;
  start: E2eePairingStart;
  createdAt: string;
};

const pendingByPairId = new Map<string, PendingPairing>();

function pruneExpired() {
  const now = Date.now();
  for (const [pairId, pending] of pendingByPairId) {
    if (Date.parse(pending.offer.expiresAt) <= now) {
      pendingByPairId.delete(pairId);
    }
  }
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
    pairing?: { start: E2eePairingStart; expiresAt: string };
  };
  if (!body.pairing?.start) return;
  const start = body.pairing.start;

  if (
    config.secureClientOrigin &&
    start.secureOrigin !== config.secureClientOrigin
  ) {
    console.warn(`Rejecting pairing ${start.pairId}: secure origin mismatch`);
    return;
  }

  // Optional Access JWT proof may be attached later by an identity bridge.
  // MVP magic-link MAC remains the anti-substitution root.
  const jwtCheck = await verifyAccessJwt({
    token: undefined,
    teamDomain: config.cfAccessTeamDomain,
    audience: config.cfAccessAud,
    allowedEmails: config.pairingAllowedEmails
  });
  if (!jwtCheck.ok) {
    console.warn(`Rejecting pairing ${start.pairId}: ${jwtCheck.reason}`);
    return;
  }

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
    ...(config.pairingMailTo ? { emailHint: config.pairingMailTo } : {})
  });

  pendingByPairId.set(start.pairId, {
    token,
    offer,
    start,
    createdAt: new Date().toISOString()
  });

  const magicLink = `${start.secureOrigin.replace(/\/$/, "")}/#pair=${start.pairId}.${token}`;
  const mailTo = config.pairingMailTo || "operator@example.com";
  await sendPairingEmail({
    to: mailTo,
    subject: "Cursor Gateway Secure: device pairing link",
    magicLink,
    text: [
      "Open this link in the SAME browser where you started pairing.",
      "Do not forward this link. It is single-use and expires soon.",
      "",
      magicLink,
      "",
      `pairId: ${start.pairId}`,
      `runner: ${config.runnerId}`,
      `expires: ${expiresAt}`
    ].join("\n")
  });

  const offerResponse = await input.gatewayFetch("/api/runner/e2ee/v1/pairings/offer", {
    method: "POST",
    body: JSON.stringify({ runnerId: config.runnerId, offer })
  });
  if (!offerResponse.ok) {
    pendingByPairId.delete(start.pairId);
    throw new Error(`pairing_offer_publish_failed_${offerResponse.status}`);
  }
  console.log(`Published pairing offer for ${start.pairId}; magic link mailed/logged`);
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
  const pending = pendingByPairId.get(complete.pairId);
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
    pendingByPairId.delete(complete.pairId);
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
  if (!response.ok) return;
  const body = (await response.json()) as {
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
  return pendingByPairId;
}
