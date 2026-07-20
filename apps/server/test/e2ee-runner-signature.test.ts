import assert from "node:assert/strict";
import test from "node:test";
import {
  E2EE_PROTOCOL,
  e2eeProgressEnvelopeSchema
} from "@cursor-gateway/shared";
import {
  createKeyDescriptor,
  generateSigningKeyPair,
  signValue
} from "@cursor-gateway/e2ee";
import { verifyRunnerEnvelopeSignature } from "../src/e2eeRunnerSignature.js";

test("runner progress metadata requires a valid envelope signature", async () => {
  const signing = await generateSigningKeyPair();
  const signingKey = await createKeyDescriptor(signing.publicKey);
  const unsigned = {
    protocol: E2EE_PROTOCOL,
    kind: "run-progress" as const,
    messageId: crypto.randomUUID(),
    runId: crypto.randomUUID(),
    conversationId: crypto.randomUUID(),
    runnerId: "runner-signature-test",
    runnerKeyId: "runner-encryption-key-test",
    requestDigest: "A".repeat(43),
    sequence: 1,
    progressKind: "working" as const,
    createdAt: new Date().toISOString(),
    payload: {
      alg: "A256GCM" as const,
      nonce: "A".repeat(16),
      ciphertext: "AA"
    }
  };
  const envelope = e2eeProgressEnvelopeSchema.parse({
    ...unsigned,
    signature: await signValue(unsigned, signing.privateKey, signingKey.keyId)
  });

  assert.equal(
    await verifyRunnerEnvelopeSignature(envelope, signingKey),
    true
  );
  assert.equal(
    await verifyRunnerEnvelopeSignature(
      { ...envelope, sequence: envelope.sequence + 1 },
      signingKey
    ),
    false
  );
});
