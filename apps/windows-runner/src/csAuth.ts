import {
  E2EE_PROTOCOL,
  type E2eeClientPairingBundle,
  type E2eeCsAuthGrant,
  type E2eeCsAuthIntent
} from "@cursor-gateway/shared";
import {
  buildCsAuthGrantUnsigned,
  signCsAuthGrant
} from "@cursor-gateway/e2ee";
import { config } from "./config.js";
import { RunnerE2eeState } from "./e2eeState.js";
import { getRunnerCertificate } from "./runnerCert.js";

type GatewayFetch = (path: string, init?: RequestInit) => Promise<Response>;

/**
 * Claim pending CS device authorization requests created by Secure Web after
 * magic-link pairing, register the CS public keys, and publish a Runner-signed
 * one-time grant for return via URL fragment.
 */
export async function processCsAuthCycle(input: {
  state: RunnerE2eeState;
  gatewayFetch: GatewayFetch;
}) {
  const response = await input.gatewayFetch("/api/runner/e2ee/v1/cs-auth/claim", {
    method: "POST",
    body: JSON.stringify({ runnerId: config.runnerId })
  });
  if (response.status === 204) return;
  if (!response.ok) {
    throw new Error(`cs_auth_claim_failed_${response.status}`);
  }
  const body = (await response.json()) as {
    auth?: {
      authId: string;
      status: string;
      intent: E2eeCsAuthIntent;
      secureClientId: string | null;
      expiresAt: string;
    };
  };
  if (!body.auth?.intent) return;

  const intent = body.auth.intent;
  let status: "authorized" | "rejected" = "rejected";

  try {
    if (Date.parse(body.auth.expiresAt) <= Date.now()) {
      throw new Error("cs_auth_expired");
    }
    if (
      config.webE2eeReturnOrigins.length > 0 &&
      !config.webE2eeReturnOrigins.includes(intent.returnOrigin)
    ) {
      throw new Error("return_origin_not_allowed");
    }
    const secureClientId = body.auth.secureClientId;
    if (
      secureClientId &&
      !input.state.pairedClients().some((client) => client.clientId === secureClientId)
    ) {
      // Secure device must already be paired with this Runner.
      throw new Error("secure_client_not_paired");
    }

    const bundle: E2eeClientPairingBundle = {
      protocol: E2EE_PROTOCOL,
      kind: "client-pairing",
      clientId: intent.clientId,
      signingKey: intent.signingKey,
      encryptionKey: intent.encryptionKey,
      createdAt: new Date().toISOString()
    };
    await input.state.pairClient(bundle);
    status = "authorized";
    console.log(`Authorized CS web device ${intent.clientId} via cs-auth ${intent.authId}`);
  } catch (error) {
    console.warn(
      `CS auth ${intent.authId} rejected:`,
      error instanceof Error ? error.message : "unknown"
    );
    status = "rejected";
  }

  const expiresAt = new Date(
    Math.min(
      Date.parse(body.auth.expiresAt),
      Date.now() + config.csAuthGrantTtlSeconds * 1000
    )
  ).toISOString();

  const runnerCertificate = await getRunnerCertificate(input.state);
  if (status === "authorized" && !runnerCertificate) {
    console.warn(
      `CS auth ${intent.authId}: downgrading authorized→rejected (no valid Runner identity certificate)`
    );
    status = "rejected";
  }
  const unsigned = buildCsAuthGrantUnsigned({
    intent,
    runnerId: config.runnerId,
    runnerEncryptionKey: input.state.encryptionKey,
    runnerSigningKey: input.state.signingKey,
    status,
    expiresAt,
    ...(runnerCertificate ? { runnerCertificate } : {})
  });
  const grant: E2eeCsAuthGrant = await signCsAuthGrant(
    unsigned,
    input.state.signingPrivateKey,
    input.state.signingKey.keyId
  );

  const grantResponse = await input.gatewayFetch("/api/runner/e2ee/v1/cs-auth/grant", {
    method: "POST",
    body: JSON.stringify({ runnerId: config.runnerId, grant })
  });
  if (!grantResponse.ok) {
    throw new Error(`cs_auth_grant_publish_failed_${grantResponse.status}`);
  }
}
