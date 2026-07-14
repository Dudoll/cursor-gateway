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
} from "../src/index.js";

test("device approval decision signature verifies and rejects replay/mismatch", async () => {
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
    approverClientId: "approver-client",
    decision: "approved",
    signingPrivateKey: approver.privateKey,
    signingKeyId: approverKey.keyId
  });
  assert.equal(
    await verifyDeviceApprovalDecision({
      request,
      decision,
      approverSigningPublicKey: approver.publicKey
    }),
    true
  );

  const rejected = await signDeviceApprovalDecision({
    request,
    approverClientId: "approver-client",
    decision: "rejected",
    signingPrivateKey: approver.privateKey,
    signingKeyId: approverKey.keyId
  });
  assert.equal(rejected.decision, "rejected");
  assert.equal(
    await verifyDeviceApprovalDecision({
      request,
      decision: rejected,
      approverSigningPublicKey: approver.publicKey
    }),
    true
  );

  const wrongRequest = { ...request, approvalId: crypto.randomUUID() };
  assert.equal(
    await verifyDeviceApprovalDecision({
      request: wrongRequest,
      decision,
      approverSigningPublicKey: approver.publicKey
    }),
    false
  );

  const other = await generateSigningKeyPair();
  assert.equal(
    await verifyDeviceApprovalDecision({
      request,
      decision,
      approverSigningPublicKey: other.publicKey
    }),
    false
  );
});
