import type {
  E2eeKeyDescriptor,
  E2eeProgressEnvelope,
  E2eeResultEnvelope
} from "@cursor-gateway/shared";
import {
  importSigningPublicKey,
  unsignedEnvelope,
  verifyValue
} from "@cursor-gateway/e2ee";

type RunnerSignedEnvelope = E2eeProgressEnvelope | E2eeResultEnvelope;

export async function verifyRunnerEnvelopeSignature(
  envelope: RunnerSignedEnvelope,
  signingKey: E2eeKeyDescriptor
): Promise<boolean> {
  if (envelope.signature.keyId !== signingKey.keyId) return false;
  try {
    const publicKey = await importSigningPublicKey(signingKey.publicKey);
    return verifyValue(unsignedEnvelope(envelope), envelope.signature, publicKey);
  } catch {
    return false;
  }
}
