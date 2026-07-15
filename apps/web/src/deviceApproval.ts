import type { E2eeDeviceApprovalRequest } from "@cursor-gateway/shared";
import { signDeviceApprovalDecision } from "@cursor-gateway/e2ee";
import { GatewayApi } from "./api.js";
import type { CsWebKeyStore } from "./keyStore.js";

/** List pending paired-device approvals for the current Access user. */
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

/**
 * Already-paired CS browser: sign approve/reject for a new Secure device.
 * Uses the CS-origin device keys already registered with the Runner.
 */
export async function decideDeviceApproval(input: {
  api: GatewayApi;
  keys: CsWebKeyStore;
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
