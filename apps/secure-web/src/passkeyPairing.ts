import {
  browserSupportsWebAuthn,
  platformAuthenticatorIsAvailable,
  startAuthentication,
  startRegistration
} from "@simplewebauthn/browser";
import {
  E2EE_PASSKEY_PAIRING_KIND,
  E2EE_PROTOCOL,
  e2eePasskeyPairingAckSchema,
  e2eePasskeyPairingOptionsSchema,
  type E2eePasskeyPairingOptions,
  type E2eeRunnerPairingBundle,
  type E2eeTrustRootPublic
} from "@cursor-gateway/shared";
import {
  generatePairingChallenge,
  importSigningPublicKey,
  signValue,
  unsignedEnvelope,
  verifyRunnerIdentityCert,
  verifyValue
} from "@cursor-gateway/e2ee";
import { GatewayApi } from "./api.js";
import { desktopPerformPasskey, isDesktopShell } from "./desktopShell.js";
import { SecureWebKeyStore } from "./keyStore.js";
import { classifyWebauthnError } from "./passkeyErrors.js";
import {
  decodePasskeyBridgeResponse,
  encodePasskeyBridgePayload
} from "./passkeyCodec.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function passkeySupportStatus(): Promise<{
  supported: boolean;
  platformAuthenticator: boolean;
}> {
  const supported = browserSupportsWebAuthn();
  if (!supported) return { supported: false, platformAuthenticator: false };
  const platformAuthenticator = await platformAuthenticatorIsAvailable().catch(() => false);
  return { supported, platformAuthenticator };
}

export async function fetchTrustRoots(api: GatewayApi): Promise<E2eeTrustRootPublic[]> {
  const { loadTrustRoots } = await import("./trustRoots.js");
  return loadTrustRoots(api);
}

export async function startPasskeyPairing(input: {
  api: GatewayApi;
  keys: SecureWebKeyStore;
  ceremonyOrigin?: string;
}): Promise<{ pairId: string; expiresAt: string }> {
  const device = await input.keys.device();
  const ceremonyOrigin = normalizeCeremonyOrigin(input.ceremonyOrigin ?? window.location.origin);
  const pairId = crypto.randomUUID();
  const start = {
    protocol: E2EE_PROTOCOL,
    pairingKind: E2EE_PASSKEY_PAIRING_KIND,
    pairId,
    clientId: device.clientId,
    clientChallenge: generatePairingChallenge(),
    signingKey: device.signingKey,
    encryptionKey: device.encryptionKey,
    secureOrigin: ceremonyOrigin,
    gatewayOrigin: input.api.origin,
    createdAt: new Date().toISOString()
  };
  const response = await input.api.post<{ pairId: string; status: string; expiresAt: string }>(
    "/api/e2ee/v1/passkey/start",
    { start }
  );
  return { pairId: response.pairId, expiresAt: response.expiresAt };
}

export function normalizeCeremonyOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("passkey_security_error");
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("passkey_security_error");
  }
  return url.origin;
}

export function passkeyRpId(options: E2eePasskeyPairingOptions): string {
  const raw =
    options.mode === "registration"
      ? (options.options.rp as { id?: unknown } | undefined)?.id
      : (options.options as { rpId?: unknown }).rpId;
  if (typeof raw !== "string" || !/^[a-z0-9.-]+$/i.test(raw)) {
    throw new Error("passkey_rp_id_mismatch");
  }
  return raw.toLowerCase();
}

export function originCanUseRpId(origin: string, rpId: string): boolean {
  const hostname = new URL(origin).hostname.toLowerCase();
  const normalizedRpId = rpId.toLowerCase();
  return hostname === normalizedRpId || hostname.endsWith(`.${normalizedRpId}`);
}

async function randomChallenge(): Promise<string> {
  const { generatePairingChallenge } = await import("@cursor-gateway/e2ee");
  return generatePairingChallenge();
}

export async function pollUntilPasskeyOptions(
  api: GatewayApi,
  pairId: string,
  options?: { timeoutMs?: number; intervalMs?: number }
): Promise<E2eePasskeyPairingOptions> {
  const timeoutMs = options?.timeoutMs ?? 180_000;
  const intervalMs = options?.intervalMs ?? 2_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await api.get<{ status: string; options: unknown | null }>(
      `/api/e2ee/v1/passkey/${pairId}`
    );
    if (status.options) return e2eePasskeyPairingOptionsSchema.parse(status.options);
    if (status.status === "expired" || status.status === "rejected") {
      throw new Error(`passkey_${status.status}`);
    }
    await sleep(intervalMs);
  }
  throw new Error("passkey_options_timeout");
}

export async function completePasskeyPairing(input: {
  api: GatewayApi;
  keys: SecureWebKeyStore;
  options: E2eePasskeyPairingOptions;
  ceremonyOrigin?: string;
}): Promise<{ runnerId: string; bundle: E2eeRunnerPairingBundle }> {
  const { options } = input;
  const ceremonyOrigin = normalizeCeremonyOrigin(
    input.ceremonyOrigin ?? window.location.origin
  );
  const rpId = passkeyRpId(options);
  if (!originCanUseRpId(ceremonyOrigin, rpId)) {
    throw new Error("passkey_rp_id_mismatch");
  }
  const device = await input.keys.device();
  if (device.clientId !== options.clientId) throw new Error("passkey_client_mismatch");
  if (
    options.clientSigningFingerprint !== device.signingKey.fingerprint ||
    options.clientEncryptionFingerprint !== device.encryptionKey.fingerprint
  ) {
    throw new Error("passkey_fingerprint_mismatch");
  }
  if (options.secureOrigin !== ceremonyOrigin) {
    throw new Error("passkey_secure_origin_mismatch");
  }
  if (Date.parse(options.expiresAt) <= Date.now()) throw new Error("passkey_expired");

  const trustRoots = await fetchTrustRoots(input.api);
  if (trustRoots.length === 0) throw new Error("trust_roots_not_configured");
  const certCheck = await verifyRunnerIdentityCert({
    cert: options.runnerCertificate,
    trustRoots,
    expected: {
      runnerId: options.runnerId,
      encryptionFingerprint: options.runnerEncryptionKey.fingerprint,
      signingFingerprint: options.runnerSigningKey.fingerprint,
      secureOrigin: options.secureOrigin,
      rpId
    }
  });
  if (!certCheck.ok) throw new Error(`passkey_runner_cert_${certCheck.reason}`);

  let response: Record<string, unknown>;
  try {
    const bridgePayload = encodePasskeyBridgePayload(options.mode, options.options);
    const ceremony = isDesktopShell()
      ? await desktopPerformPasskey({
          passkeyOrigin: ceremonyOrigin,
          mode: bridgePayload.mode,
          options: bridgePayload.options
        })
      : options.mode === "registration"
        ? await startRegistration({ optionsJSON: options.options as never })
        : await startAuthentication({ optionsJSON: options.options as never });
    response = decodePasskeyBridgeResponse(options.mode, ceremony);
  } catch (error) {
    if (typeof error === "string" && /^[a-z0-9_:-]{1,160}$/i.test(error)) {
      throw new Error(error.split(":")[0]);
    }
    if (error instanceof Error && /^passkey_[a-z0-9_]+$/i.test(error.message)) {
      throw error;
    }
    throw new Error(classifyWebauthnError(error));
  }

  const createdAt = new Date().toISOString();
  const unsigned = {
    protocol: E2EE_PROTOCOL,
    pairingKind: E2EE_PASSKEY_PAIRING_KIND,
    pairId: options.pairId,
    clientId: device.clientId,
    mode: options.mode,
    response,
    createdAt
  };
  const complete = {
    ...unsigned,
    signature: await signValue(unsigned, device.signingPrivateKey, device.signingKey.keyId)
  };

  await input.api.post(`/api/e2ee/v1/passkey/${options.pairId}/complete`, { complete });

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const latest = await input.api.get<{ status: string; ack: unknown | null }>(
      `/api/e2ee/v1/passkey/${options.pairId}`
    );
    if (latest.ack) {
      const ack = e2eePasskeyPairingAckSchema.parse(latest.ack);
      const runnerKey = await importSigningPublicKey(ack.runnerSigningKey.publicKey);
      if (!(await verifyValue(unsignedEnvelope(ack), ack.signature, runnerKey))) {
        throw new Error("passkey_ack_signature_invalid");
      }
      if (ack.status !== "paired") {
        throw new Error(ack.reason ?? "passkey_rejected_by_runner");
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
    if (latest.status === "rejected" || latest.status === "expired") {
      throw new Error(`passkey_${latest.status}`);
    }
    await sleep(1_500);
  }
  throw new Error("passkey_ack_timeout");
}

/** One-shot: start → poll options → WebAuthn ceremony → ack. */
export async function pairWithPasskey(input: {
  api: GatewayApi;
  keys: SecureWebKeyStore;
  ceremonyOrigin?: string;
  onStatus?: (text: string) => void;
}): Promise<{ runnerId: string; bundle: E2eeRunnerPairingBundle }> {
  if (!isDesktopShell()) {
    const support = await passkeySupportStatus();
    if (!support.supported) throw new Error("passkey_unsupported_browser");
  }
  const ceremonyOrigin = normalizeCeremonyOrigin(
    input.ceremonyOrigin ?? window.location.origin
  );
  input.onStatus?.("正在联系授权设备…");
  const started = await startPasskeyPairing({ ...input, ceremonyOrigin });
  input.onStatus?.("等待授权设备响应…");
  const options = await pollUntilPasskeyOptions(input.api, started.pairId);
  input.onStatus?.(
    options.mode === "registration"
      ? "请在弹出的安全窗口中创建 Passkey。"
      : "请在弹出的安全窗口中完成 Passkey 验证。"
  );
  return completePasskeyPairing({
    api: input.api,
    keys: input.keys,
    options,
    ceremonyOrigin
  });
}
