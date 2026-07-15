import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
  type WebAuthnCredential
} from "@simplewebauthn/server";
import {
  E2EE_PASSKEY_PAIRING_KIND,
  E2EE_PROTOCOL,
  type E2eeClientPairingBundle,
  type E2eePasskeyCredentialPublic,
  type E2eePasskeyPairingAck,
  type E2eePasskeyPairingOptions,
  type E2eePasskeyPairingStart
} from "@cursor-gateway/shared";
import {
  decodeBase64Url,
  encodeBase64Url,
  importSigningPublicKey,
  signValue,
  verifyValue
} from "@cursor-gateway/e2ee";
import { config } from "./config.js";
import { RunnerE2eeState } from "./e2eeState.js";
import { PasskeyStore } from "./passkeyStore.js";
import { getRunnerCertificate } from "./runnerCert.js";
import { assertMailAddress, emailFingerprint } from "./mail/mailAddress.js";
import { verifyAccessJwt } from "./accessJwt.js";
import { PendingRecordStore } from "./pendingRecordStore.js";

type GatewayFetch = (path: string, init?: RequestInit) => Promise<Response>;

type PendingWebauthnChallenge = {
  mode: "registration" | "authentication";
  challenge: string;
  email: string;
  start: E2eePasskeyPairingStart;
  /** Credentials offered for `allowCredentials` at authentication time. */
  candidateCredentials: E2eePasskeyCredentialPublic[];
  expiresAt: string;
  createdAt: string;
};

const passkeyStore = new PasskeyStore(
  join(homedir(), ".cursor-gateway", `passkeys-${config.runnerId.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`)
);

const pendingStore = new PendingRecordStore<PendingWebauthnChallenge>(
  join(
    homedir(),
    ".cursor-gateway",
    `webauthn-pending-${config.runnerId.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`
  ),
  (value) => value.expiresAt
);

function toWebAuthnCredential(credential: E2eePasskeyCredentialPublic): WebAuthnCredential {
  return {
    id: credential.credentialId,
    publicKey: decodeBase64Url(credential.publicKey).slice(),
    counter: credential.counter,
    ...(credential.transports
      ? { transports: credential.transports as AuthenticatorTransportFuture[] }
      : {})
  };
}

/** Prefer platform transports so Windows Hello / Touch ID is offered first. */
function preferPlatformTransports(
  transports: AuthenticatorTransportFuture[]
): AuthenticatorTransportFuture[] {
  const platform = transports.filter((t) => t === "internal");
  if (platform.length > 0) return platform;
  return transports;
}

/** Map thrown errors to stable reject codes safe for the Secure UI (no secrets). */
function passkeyRejectReason(error: unknown): string {
  const message = error instanceof Error ? error.message : "passkey_rejected";
  const normalized = message.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  if (/^[a-z][a-z0-9_]{1,127}$/.test(normalized)) return normalized;
  return "passkey_rejected";
}

export async function processWebauthnPairingCycle(input: {
  state: RunnerE2eeState;
  gatewayFetch: GatewayFetch;
}) {
  if (!config.webauthnEnabled) return;
  pendingStore.pruneExpired();
  await claimAndPublishOptions(input);
  await claimAndVerifyComplete(input);
}

async function claimAndPublishOptions(input: {
  state: RunnerE2eeState;
  gatewayFetch: GatewayFetch;
}) {
  const response = await input.gatewayFetch("/api/runner/e2ee/v1/passkey/claim-start", {
    method: "POST",
    body: JSON.stringify({ runnerId: config.runnerId })
  });
  if (response.status === 204) return;
  if (!response.ok) throw new Error(`passkey_claim_start_failed_${response.status}`);
  const body = (await response.json()) as {
    pairing?: {
      pairId: string;
      start: E2eePasskeyPairingStart;
      expiresAt: string;
      recipientEmail?: string;
    };
  };
  if (!body.pairing?.start) return;
  const { pairId, start } = body.pairing;

  let email: string;
  try {
    email = assertMailAddress(body.pairing.recipientEmail, "recipient");
  } catch (error) {
    console.warn(
      `Rejecting passkey pairing ${pairId}: trusted recipient missing/invalid (${error instanceof Error ? error.message : "unknown"})`
    );
    return;
  }

  if (config.webauthnOrigins.length > 0 && !config.webauthnOrigins.includes(start.secureOrigin)) {
    console.warn(`Rejecting passkey pairing ${pairId}: secure origin not allowed`);
    return;
  }

  const cert = await getRunnerCertificate(input.state);
  if (!cert) {
    console.warn(
      `Cannot publish passkey options for ${pairId}: no valid Runner identity certificate configured`
    );
    return;
  }

  if (pendingStore.get(pairId)) {
    // Already published for this pairId; wait for client to complete.
    return;
  }

  const existing = passkeyStore.credentialsForEmail(email);
  const active = existing.filter((credential) => !credential.revokedAt);
  const mode: "registration" | "authentication" = active.length > 0 ? "authentication" : "registration";

  // Prefer platform authenticators (Windows Hello / Face ID / fingerprint).
  // Avoid forcing cross-platform security keys or hybrid-only UI, which commonly
  // surfaces as NotAllowedError on Windows when the user expects a PIN prompt.
  const optionsJson =
    mode === "registration"
      ? await generateRegistrationOptions({
          rpName: config.webauthnRpName,
          rpID: config.webauthnRpId,
          userName: email,
          userID: createHash("sha256").update(`passkey-user:${email}`).digest(),
          userDisplayName: email,
          attestationType: "none",
          timeout: 120_000,
          preferredAuthenticatorType: "localDevice",
          excludeCredentials: existing.map((credential) => ({
            id: credential.credentialId,
            ...(credential.transports
              ? { transports: credential.transports as never }
              : {})
          })),
          authenticatorSelection: {
            authenticatorAttachment: "platform",
            // "preferred" is more compatible with Windows Hello than "required".
            residentKey: "preferred",
            userVerification: "required"
          }
        })
      : await generateAuthenticationOptions({
          rpID: config.webauthnRpId,
          userVerification: "required",
          timeout: 120_000,
          allowCredentials: active.map((credential) => ({
            id: credential.credentialId,
            // Prefer internal (platform) over hybrid so Chrome/Edge opens
            // Windows Hello instead of a phone QR / security-key picker.
            ...(credential.transports
              ? {
                  transports: preferPlatformTransports(
                    credential.transports as AuthenticatorTransportFuture[]
                  )
                }
              : { transports: ["internal"] as AuthenticatorTransportFuture[] })
          }))
        });

  const expiresAt = new Date(Date.now() + config.webauthnChallengeTtlSeconds * 1000).toISOString();
  const pending: PendingWebauthnChallenge = {
    mode,
    challenge: optionsJson.challenge,
    email,
    start,
    candidateCredentials: active,
    expiresAt,
    createdAt: new Date().toISOString()
  };

  const options: E2eePasskeyPairingOptions = {
    protocol: E2EE_PROTOCOL,
    pairingKind: E2EE_PASSKEY_PAIRING_KIND,
    pairId,
    runnerId: config.runnerId,
    mode,
    options: optionsJson as unknown as Record<string, unknown>,
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

  const publishResponse = await input.gatewayFetch("/api/runner/e2ee/v1/passkey/options", {
    method: "POST",
    body: JSON.stringify({ runnerId: config.runnerId, options })
  });
  if (!publishResponse.ok) {
    throw new Error(`passkey_options_publish_failed_${publishResponse.status}`);
  }
  // Persist challenge only after Gateway accepted options (avoids stalling on publish failure).
  pendingStore.set(pairId, pending);
  console.log(
    `Published passkey ${mode} options for ${pairId} (recipient_fp=${emailFingerprint(email)})`
  );
}

async function claimAndVerifyComplete(input: {
  state: RunnerE2eeState;
  gatewayFetch: GatewayFetch;
}) {
  const response = await input.gatewayFetch("/api/runner/e2ee/v1/passkey/claim-complete", {
    method: "POST",
    body: JSON.stringify({ runnerId: config.runnerId })
  });
  if (response.status === 204) return;
  if (!response.ok) throw new Error(`passkey_claim_complete_failed_${response.status}`);
  const body = (await response.json()) as {
    pairing?: {
      pairId: string;
      start: E2eePasskeyPairingStart;
      options: E2eePasskeyPairingOptions;
      complete: {
        protocol: string;
        pairingKind: string;
        pairId: string;
        clientId: string;
        mode: "registration" | "authentication";
        response: Record<string, unknown>;
        signature: { alg: "ES256"; keyId: string; value: string };
        createdAt: string;
      };
      expiresAt: string;
      accessJwt: string | null;
    };
  };
  if (!body.pairing?.complete) return;
  const { pairId, start, complete, accessJwt } = body.pairing;

  const pending = pendingStore.get(pairId);
  let status: "paired" | "rejected" = "rejected";
  let rejectReason: string | undefined;

  try {
    if (!pending) throw new Error("passkey_pending_missing");
    if (Date.parse(pending.expiresAt) <= Date.now()) throw new Error("passkey_challenge_expired");
    if (pending.mode !== complete.mode) throw new Error("passkey_mode_mismatch");

    const clientPublicKey = await importSigningPublicKey(start.signingKey.publicKey);
    const unsigned = {
      protocol: complete.protocol,
      pairingKind: complete.pairingKind,
      pairId: complete.pairId,
      clientId: complete.clientId,
      mode: complete.mode,
      response: complete.response,
      createdAt: complete.createdAt
    };
    if (
      complete.signature.keyId !== start.signingKey.keyId ||
      !(await verifyValue(unsigned, complete.signature, clientPublicKey))
    ) {
      throw new Error("passkey_client_signature_invalid");
    }

    const jwtCheck = await verifyAccessJwt({
      token: accessJwt,
      teamDomain: config.cfAccessTeamDomain,
      audience: config.cfAccessAud,
      allowedEmails: config.pairingAllowedEmails
    });
    if (!jwtCheck.ok) throw new Error(`passkey_access_jwt_${jwtCheck.reason ?? "invalid"}`);
    if (jwtCheck.email !== pending.email) throw new Error("passkey_access_jwt_email_mismatch");

    if (complete.mode === "registration") {
      const verification = await verifyRegistrationResponse({
        response: complete.response as unknown as RegistrationResponseJSON,
        expectedChallenge: pending.challenge,
        expectedOrigin: config.webauthnOrigins.length > 0 ? config.webauthnOrigins : start.secureOrigin,
        expectedRPID: config.webauthnRpId,
        requireUserVerification: true
      });
      if (!verification.verified || !verification.registrationInfo) {
        throw new Error("passkey_registration_verification_failed");
      }
      const { credential } = verification.registrationInfo;
      const publicCredential: E2eePasskeyCredentialPublic = {
        credentialId: credential.id,
        publicKey: encodeBase64Url(credential.publicKey),
        counter: credential.counter,
        ...(credential.transports ? { transports: [...credential.transports] } : {}),
        label: null,
        createdAt: new Date().toISOString(),
        revokedAt: null
      };
      passkeyStore.addCredential(pending.email, publicCredential);
    } else {
      const matched = pending.candidateCredentials.find(
        (credential) => credential.credentialId === (complete.response as { id?: string }).id
      );
      if (!matched) throw new Error("passkey_credential_not_offered");
      const verification = await verifyAuthenticationResponse({
        response: complete.response as unknown as AuthenticationResponseJSON,
        expectedChallenge: pending.challenge,
        expectedOrigin: config.webauthnOrigins.length > 0 ? config.webauthnOrigins : start.secureOrigin,
        expectedRPID: config.webauthnRpId,
        credential: toWebAuthnCredential(matched),
        requireUserVerification: true
      });
      if (!verification.verified) throw new Error("passkey_authentication_verification_failed");
      passkeyStore.updateCounter(
        pending.email,
        matched.credentialId,
        verification.authenticationInfo.newCounter
      );
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
    console.log(
      `Paired secure-web client ${start.clientId} via passkey ${complete.mode} (recipient_fp=${emailFingerprint(pending.email)})`
    );
  } catch (error) {
    rejectReason = passkeyRejectReason(error);
    console.warn(`Passkey pairing ${pairId} rejected:`, rejectReason);
    status = "rejected";
  } finally {
    pendingStore.delete(pairId);
  }

  const cert = await getRunnerCertificate(input.state);
  if (!cert) {
    console.warn(`Cannot publish passkey ack for ${pairId}: no valid Runner identity certificate`);
    return;
  }

  const unsignedAck = {
    protocol: E2EE_PROTOCOL,
    pairingKind: E2EE_PASSKEY_PAIRING_KIND as typeof E2EE_PASSKEY_PAIRING_KIND,
    pairId,
    clientId: start.clientId,
    runnerId: config.runnerId,
    status,
    ...(status === "rejected" && rejectReason ? { reason: rejectReason } : {}),
    runnerEncryptionKey: input.state.encryptionKey,
    runnerSigningKey: input.state.signingKey,
    runnerCertificate: cert,
    createdAt: new Date().toISOString()
  };
  const ack: E2eePasskeyPairingAck = {
    ...unsignedAck,
    signature: await signValue(unsignedAck, input.state.signingPrivateKey, input.state.signingKey.keyId)
  };

  const ackResponse = await input.gatewayFetch("/api/runner/e2ee/v1/passkey/ack", {
    method: "POST",
    body: JSON.stringify({ runnerId: config.runnerId, ack })
  });
  if (!ackResponse.ok) throw new Error(`passkey_ack_failed_${ackResponse.status}`);
}

/** Expose for tests / dry-run helpers. */
export function __testPasskeyStore() {
  return passkeyStore;
}

export function __testWebauthnPending() {
  return pendingStore;
}
