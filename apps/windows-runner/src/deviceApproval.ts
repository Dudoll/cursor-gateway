import {
  E2EE_DEVICE_APPROVAL_KIND,
  E2EE_PROTOCOL,
  type E2eeClientPairingBundle,
  type E2eeDeviceApprovalDecision,
  type E2eeDeviceApprovalRequest,
  type E2eeDeviceApprovalResult
} from "@cursor-gateway/shared";
import {
  importSigningPublicKey,
  signValue,
  verifyDeviceApprovalDecision
} from "@cursor-gateway/e2ee";
import { config } from "./config.js";
import { RunnerE2eeState } from "./e2eeState.js";
import { getRunnerCertificate } from "./runnerCert.js";

type GatewayFetch = (path: string, init?: RequestInit) => Promise<Response>;

/**
 * Claim paired-device-approval decisions signed by an *already-paired*
 * Secure Web device, verify the signature against that device's registered
 * signing key, then pair the new device and publish a Runner-signed result.
 * The Runner never needs to publish an "offer" step here — no cryptographic
 * material is required from the Runner until a decision has been made.
 */
export async function processDeviceApprovalCycle(input: {
  state: RunnerE2eeState;
  gatewayFetch: GatewayFetch;
}) {
  const response = await input.gatewayFetch("/api/runner/e2ee/v1/approvals/claim", {
    method: "POST",
    body: JSON.stringify({ runnerId: config.runnerId })
  });
  if (response.status === 204) return;
  if (!response.ok) throw new Error(`device_approval_claim_failed_${response.status}`);
  const body = (await response.json()) as {
    approval?: {
      approvalId: string;
      request: E2eeDeviceApprovalRequest;
      decision: E2eeDeviceApprovalDecision;
      expiresAt: string;
    };
  };
  if (!body.approval?.decision) return;
  const { approvalId, request, decision, expiresAt } = body.approval;
  let status: "paired" | "rejected" = "rejected";

  try {
    if (Date.parse(expiresAt) <= Date.now()) throw new Error("device_approval_expired");
    if (
      request.newSigningFingerprint !== request.newSigningKey.fingerprint ||
      request.newEncryptionFingerprint !== request.newEncryptionKey.fingerprint
    ) {
      throw new Error("device_approval_fingerprint_mismatch");
    }
    if (
      config.secureClientOrigin &&
      request.secureOrigin !== config.secureClientOrigin
    ) {
      throw new Error("device_approval_secure_origin_mismatch");
    }

    const approver = input.state.getPairedClient(
      decision.approverClientId,
      decision.signature.keyId
    );
    if (!approver || !approver.signingKey) throw new Error("device_approval_approver_not_paired");

    const approverPublicKey = await importSigningPublicKey(approver.signingKey.publicKey);
    const validSignature = await verifyDeviceApprovalDecision({
      request,
      decision,
      approverSigningPublicKey: approverPublicKey
    });
    if (!validSignature) throw new Error("device_approval_decision_signature_invalid");

    if (decision.decision === "approved") {
      const bundle: E2eeClientPairingBundle = {
        protocol: E2EE_PROTOCOL,
        kind: "client-pairing",
        clientId: request.newClientId,
        signingKey: request.newSigningKey,
        encryptionKey: request.newEncryptionKey,
        createdAt: new Date().toISOString()
      };
      await input.state.pairClient(bundle);
      status = "paired";
      console.log(
        `Paired secure-web client ${request.newClientId} via device approval by ${decision.approverClientId}`
      );
    } else {
      status = "rejected";
    }
  } catch (error) {
    console.warn(
      `Device approval ${approvalId} rejected:`,
      error instanceof Error ? error.message : "unknown"
    );
    status = "rejected";
  }

  const cert = await getRunnerCertificate(input.state);
  if (!cert) {
    console.warn(`Cannot publish device approval result for ${approvalId}: no valid Runner identity certificate`);
    return;
  }
  const unsignedResult = {
    protocol: E2EE_PROTOCOL,
    approvalKind: E2EE_DEVICE_APPROVAL_KIND as typeof E2EE_DEVICE_APPROVAL_KIND,
    approvalId,
    newClientId: request.newClientId,
    runnerId: config.runnerId,
    status,
    runnerEncryptionKey: input.state.encryptionKey,
    runnerSigningKey: input.state.signingKey,
    runnerCertificate: cert,
    createdAt: new Date().toISOString()
  };
  const result: E2eeDeviceApprovalResult = {
    ...unsignedResult,
    signature: await signValue(unsignedResult, input.state.signingPrivateKey, input.state.signingKey.keyId)
  };

  const resultResponse = await input.gatewayFetch("/api/runner/e2ee/v1/approvals/result", {
    method: "POST",
    body: JSON.stringify({ runnerId: config.runnerId, result })
  });
  if (!resultResponse.ok) throw new Error(`device_approval_result_failed_${resultResponse.status}`);
}
