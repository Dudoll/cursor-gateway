// Secure Adapter entrypoint. Fail-closed: if server-keys pinning or enrollment
// fails, we exit non-zero and never listen — there is no plaintext fallback.
import { createFacade } from "./facade.js";
import { loadAdapterConfig } from "./config.js";
import { FailClosedError, SecureClient } from "./secureClient.js";
import { StateStore } from "./state.js";

async function main(): Promise<void> {
  const cfg = loadAdapterConfig();
  const store = new StateStore(cfg.statePath, cfg.masterKey);
  const client = new SecureClient(cfg, store);

  try {
    await client.init();
  } catch (error) {
    const reason = error instanceof FailClosedError ? error.reason : String(error);
    console.error(`[cg-mitm-adapter] fail-closed on startup: ${reason}`);
    process.exit(1);
  }

  const app = createFacade(cfg, client);
  await app.listen({ host: cfg.listenHost, port: cfg.listenPort });
  console.log(
    `[cg-mitm-adapter] listening on http://${cfg.listenHost}:${cfg.listenPort} → ${cfg.upstreamUrl} ` +
      `(device ${client.deviceId}); point your CLI's ANTHROPIC_BASE_URL / OPENAI_BASE_URL here.`
  );
}

main().catch((error) => {
  console.error(`[cg-mitm-adapter] fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
