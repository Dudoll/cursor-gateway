import { readFileSync } from "node:fs";
import { e2eeClientPairingBundleSchema } from "@cursor-gateway/shared";
import { decodeBase64Url, decodeUtf8, encodeBase64Url, utf8 } from "@cursor-gateway/e2ee";
import { RunnerE2eeState } from "./e2eeState.js";

function encodeBundle(value: unknown) {
  return encodeBase64Url(utf8(JSON.stringify(value)));
}

function decodeClientBundle(value: string) {
  return e2eeClientPairingBundleSchema.parse(
    JSON.parse(decodeUtf8(decodeBase64Url(value.trim())))
  );
}

async function main() {
  const command = process.argv[2];
  const state = await RunnerE2eeState.loadOrCreate();

  if (command === "runner") {
    const bundle = state.runnerPairingBundle();
    console.log(`Runner: ${bundle.runnerId}`);
    console.log(`Encryption fingerprint: ${bundle.encryptionKey.fingerprint}`);
    console.log(`Signing fingerprint: ${bundle.signingKey.fingerprint}`);
    console.log("Import this bundle only into the trusted signed extension:");
    console.log(encodeBundle(bundle));
    return;
  }

  if (command === "client") {
    const encoded = process.argv[3] ?? readFileSync(0, "utf8").trim();
    if (!encoded) {
      throw new Error("Pass the client pairing bundle as an argument or stdin");
    }
    const paired = await state.pairClient(decodeClientBundle(encoded));
    console.log(`Paired client ${paired.clientId}`);
    console.log(`Client signing fingerprint: ${paired.signingKey.fingerprint}`);
    return;
  }

  if (command === "list-clients") {
    const clients = state.pairedClients();
    if (clients.length === 0) {
      console.log("No paired clients.");
      return;
    }
    for (const client of clients) {
      console.log(`${client.clientId} ${client.signingKey.fingerprint}`);
    }
    return;
  }

  if (command === "revoke-client") {
    const clientId = process.argv[3]?.trim();
    if (!clientId) throw new Error("Pass the client id to revoke");
    if (!(await state.revokeClient(clientId))) throw new Error("paired_client_not_found");
    console.log(`Revoked client ${clientId}`);
    return;
  }

  throw new Error(
    "Usage: pair.ts runner | client <client-bundle> | list-clients | revoke-client <client-id>"
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "pairing_failed");
  process.exit(1);
});
