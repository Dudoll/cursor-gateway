import {
  E2EE_CS_AUTH_KIND,
  E2EE_PROTOCOL,
  e2eeCsAuthGrantSchema,
  type E2eeCsAuthGrant,
  type E2eeCsAuthIntent,
  type E2eeRunnerPairingBundle
} from "@cursor-gateway/shared";
import {
  buildCsAuthRedirectUrl,
  clearCsAuthFragment,
  generatePairingChallenge,
  parseCsAuthGrantFragment,
  validateCsAuthGrant
} from "@cursor-gateway/e2ee";
import { GatewayApi } from "./api.js";
import { CsWebKeyStore } from "./keyStore.js";

const PENDING_KEY = "cg-cs-web:pending-cs-auth";

export type PendingCsAuth = {
  authId: string;
  clientId: string;
  challenge: string;
  state: string;
  returnOrigin: string;
  gatewayOrigin: string;
  signingFingerprint: string;
  encryptionFingerprint: string;
  secureOrigin: string;
  createdAt: string;
};

export function loadPendingCsAuth(): PendingCsAuth | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as PendingCsAuth;
  } catch {
    return null;
  }
}

export function savePendingCsAuth(value: PendingCsAuth) {
  sessionStorage.setItem(PENDING_KEY, JSON.stringify(value));
}

export function clearPendingCsAuth() {
  sessionStorage.removeItem(PENDING_KEY);
}

/** Create Gateway intent and navigate to Secure Web with public fingerprints only. */
export async function beginCsDeviceAuth(input: {
  api: GatewayApi;
  keys: CsWebKeyStore;
  secureOrigin: string;
}): Promise<void> {
  const device = await input.keys.device();
  if (device.signingPrivateKey.extractable || device.encryptionPrivateKey.extractable) {
    throw new Error("device_keys_must_be_non_extractable");
  }
  const authId = crypto.randomUUID();
  const challenge = generatePairingChallenge();
  const state = generatePairingChallenge();
  const returnOrigin = window.location.origin;
  const intent: E2eeCsAuthIntent = {
    protocol: E2EE_PROTOCOL,
    authKind: E2EE_CS_AUTH_KIND,
    authId,
    clientId: device.clientId,
    challenge,
    state,
    signingKey: device.signingKey,
    encryptionKey: device.encryptionKey,
    returnOrigin,
    gatewayOrigin: input.api.origin || window.location.origin,
    createdAt: new Date().toISOString()
  };
  await input.api.post("/api/e2ee/v1/cs-auth/intent", { intent });
  const pending: PendingCsAuth = {
    authId,
    clientId: device.clientId,
    challenge,
    state,
    returnOrigin,
    gatewayOrigin: intent.gatewayOrigin,
    signingFingerprint: device.signingKey.fingerprint,
    encryptionFingerprint: device.encryptionKey.fingerprint,
    secureOrigin: input.secureOrigin.replace(/\/$/, ""),
    createdAt: intent.createdAt
  };
  savePendingCsAuth(pending);
  const url = buildCsAuthRedirectUrl(pending.secureOrigin, {
    authId,
    clientId: device.clientId,
    challenge,
    state,
    returnOrigin,
    signingFingerprint: device.signingKey.fingerprint,
    encryptionFingerprint: device.encryptionKey.fingerprint
  });
  window.location.assign(url);
}

/**
 * Consume `#cs_auth=` grant fragment: verify Runner signature + bindings,
 * pin Runner public keys, one-time consume on Gateway.
 */
export async function completeCsDeviceAuthFromFragment(input: {
  api: GatewayApi;
  keys: CsWebKeyStore;
}): Promise<{ runnerId: string; grant: E2eeCsAuthGrant } | null> {
  const rawGrant = parseCsAuthGrantFragment(window.location.hash);
  if (!rawGrant) return null;
  const grant = e2eeCsAuthGrantSchema.parse(rawGrant);
  const pending = loadPendingCsAuth();
  if (!pending) {
    clearCsAuthFragment();
    throw new Error("cs_auth_pending_missing");
  }
  const validated = await validateCsAuthGrant({
    grant,
    expected: {
      authId: pending.authId,
      clientId: pending.clientId,
      challenge: pending.challenge,
      state: pending.state,
      returnOrigin: pending.returnOrigin,
      signingFingerprint: pending.signingFingerprint,
      encryptionFingerprint: pending.encryptionFingerprint,
      gatewayOrigin: pending.gatewayOrigin
    }
  });
  if (!validated.ok) {
    clearCsAuthFragment();
    throw new Error(validated.reason);
  }

  const bundle: E2eeRunnerPairingBundle = {
    protocol: E2EE_PROTOCOL,
    kind: "runner-pairing",
    runnerId: grant.runnerId,
    encryptionKey: grant.runnerEncryptionKey,
    signingKey: grant.runnerSigningKey,
    createdAt: grant.createdAt
  };
  await input.keys.importRunner(bundle);
  await input.keys.markPaired(grant.runnerId);

  await input.api.post(`/api/e2ee/v1/cs-auth/${grant.authId}/consume`, {
    challenge: pending.challenge,
    state: pending.state
  });

  clearPendingCsAuth();
  clearCsAuthFragment();
  return { runnerId: grant.runnerId, grant };
}
