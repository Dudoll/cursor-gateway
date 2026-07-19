import {
  E2EE_DEVICE_APPROVAL_KIND,
  E2EE_PROTOCOL,
  e2eeDeviceApprovalRequestSchema,
  e2eeDeviceApprovalResultSchema,
  type E2eeDeviceApprovalRequest,
  type E2eeRunnerPairingBundle
} from "@cursor-gateway/shared";
import {
  importSigningPublicKey,
  signDeviceApprovalDecision,
  unsignedEnvelope,
  verifyValue
} from "@cursor-gateway/e2ee";
import { GatewayApi } from "./api.js";
import { SecureWebKeyStore } from "./keyStore.js";
import { assertRunnerCertificate, loadTrustRoots } from "./trustRoots.js";

const abortableSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true }
    );
  });

/** New device: publish a pending approval request for an already-paired device. */
export async function requestDeviceApproval(input: {
  api: GatewayApi;
  keys: SecureWebKeyStore;
  label?: string;
}): Promise<{ approvalId: string; expiresAt: string }> {
  const device = await input.keys.device();
  const approvalId = crypto.randomUUID();
  const request: E2eeDeviceApprovalRequest = e2eeDeviceApprovalRequestSchema.parse({
    protocol: E2EE_PROTOCOL,
    approvalKind: E2EE_DEVICE_APPROVAL_KIND,
    approvalId,
    newClientId: device.clientId,
    newSigningFingerprint: device.signingKey.fingerprint,
    newEncryptionFingerprint: device.encryptionKey.fingerprint,
    newSigningKey: device.signingKey,
    newEncryptionKey: device.encryptionKey,
    secureOrigin: window.location.origin,
    gatewayOrigin: input.api.origin,
    label: input.label ?? null,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    createdAt: new Date().toISOString()
  });
  const response = await input.api.post<{
    approvalId: string;
    status: string;
    expiresAt: string;
  }>("/api/e2ee/v1/approvals/request", { request });
  return { approvalId: response.approvalId, expiresAt: response.expiresAt };
}

/** Already-paired device: list pending approvals for this Access user. */
export async function listPendingApprovals(api: GatewayApi): Promise<
  Array<{ approvalId: string; request: E2eeDeviceApprovalRequest; expiresAt: string }>
> {
  const response = await api.get<{
    approvals: Array<{
      approvalId: string;
      request: E2eeDeviceApprovalRequest;
      expiresAt: string;
    }>;
  }>("/api/e2ee/v1/approvals/pending");
  return response.approvals;
}

/** Already-paired device: sign approve/reject decision. */
export async function decideDeviceApproval(input: {
  api: GatewayApi;
  keys: SecureWebKeyStore;
  request: E2eeDeviceApprovalRequest;
  decision: "approved" | "rejected";
}): Promise<void> {
  const device = await input.keys.device();
  if (!device.pairedRunnerId) throw new Error("device_not_paired");
  const decision = await signDeviceApprovalDecision({
    request: input.request,
    approverClientId: device.clientId,
    decision: input.decision,
    signingPrivateKey: device.signingPrivateKey,
    signingKeyId: device.signingKey.keyId
  });
  await input.api.post(`/api/e2ee/v1/approvals/${input.request.approvalId}/decision`, {
    decision,
    runnerId: device.pairedRunnerId
  });
}

/** New device: wait for Runner-signed result after an approver decides. */
export async function waitForDeviceApprovalResult(input: {
  api: GatewayApi;
  keys: SecureWebKeyStore;
  approvalId: string;
  signal?: AbortSignal;
  onStatus?: (text: string) => void;
}): Promise<{ runnerId: string; bundle: E2eeRunnerPairingBundle }> {
  const trustRoots = await loadTrustRoots(input.api);
  if (trustRoots.length === 0) throw new Error("trust_roots_not_configured");
  const deadline = Date.now() + 600_000;
  while (Date.now() < deadline) {
    if (input.signal?.aborted) throw new Error("device_approval_cancelled");
    const latest = await input.api.get<{
      status: string;
      result: unknown | null;
      expiresAt: string;
    }>(`/api/e2ee/v1/approvals/${input.approvalId}`);
    if (latest.result) {
      const result = e2eeDeviceApprovalResultSchema.parse(latest.result);
      await assertRunnerCertificate({
        cert: result.runnerCertificate,
        trustRoots,
        runnerId: result.runnerId,
        encryptionFingerprint: result.runnerEncryptionKey.fingerprint,
        signingFingerprint: result.runnerSigningKey.fingerprint,
        secureOrigin: window.location.origin
      });
      const runnerKey = await importSigningPublicKey(result.runnerSigningKey.publicKey);
      if (!(await verifyValue(unsignedEnvelope(result), result.signature, runnerKey))) {
        throw new Error("device_approval_result_signature_invalid");
      }
      if (result.status !== "paired") {
        throw new Error("device_approval_rejected");
      }
      const bundle: E2eeRunnerPairingBundle = {
        protocol: E2EE_PROTOCOL,
        kind: "runner-pairing",
        runnerId: result.runnerId,
        encryptionKey: result.runnerEncryptionKey,
        signingKey: result.runnerSigningKey,
        createdAt: result.createdAt
      };
      await input.keys.importRunner(bundle);
      await input.keys.markPaired(result.runnerId);
      return { runnerId: result.runnerId, bundle };
    }
    if (latest.status === "expired" || latest.status === "rejected") {
      throw new Error(`device_approval_${latest.status}`);
    }
    input.onStatus?.("等待已授权设备批准…");
    await abortableSleep(2_000, input.signal);
  }
  throw new Error("device_approval_timeout");
}
