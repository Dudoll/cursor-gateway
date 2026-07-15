import assert from "node:assert/strict";
import test from "node:test";
import {
  E2EE_DEVICE_APPROVAL_KIND,
  E2EE_PROTOCOL,
  type E2eeDeviceApprovalRequest
} from "@cursor-gateway/shared";
import {
  createKeyDescriptor,
  generateSigningKeyPair,
  signDeviceApprovalDecision,
  verifyDeviceApprovalDecision
} from "@cursor-gateway/e2ee";

test("CS approver can sign device-approval decisions for Secure requests", async () => {
  const approver = await generateSigningKeyPair(true);
  const approverKey = await createKeyDescriptor(approver.publicKey);
  const request: E2eeDeviceApprovalRequest = {
    protocol: E2EE_PROTOCOL,
    approvalKind: E2EE_DEVICE_APPROVAL_KIND,
    approvalId: crypto.randomUUID(),
    newClientId: crypto.randomUUID(),
    newSigningFingerprint: "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    newEncryptionFingerprint: "sha256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    newSigningKey: approverKey,
    newEncryptionKey: approverKey,
    secureOrigin: "https://secure.joelzt.org",
    gatewayOrigin: "https://cs.joelzt.org",
    label: "phone",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdAt: new Date().toISOString()
  };

  const decision = await signDeviceApprovalDecision({
    request,
    approverClientId: "cs-web-approver",
    decision: "approved",
    signingPrivateKey: approver.privateKey,
    signingKeyId: approverKey.keyId
  });

  assert.equal(decision.approverClientId, "cs-web-approver");
  assert.equal(
    await verifyDeviceApprovalDecision({
      request,
      decision,
      approverSigningPublicKey: approver.publicKey
    }),
    true
  );
});
