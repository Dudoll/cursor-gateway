// Local dev/verification server for the csapi facade.
//
// Boots the real csapi routes against an in-memory fake backend that simulates
// a runner (echoes the prompt after a short delay). This lets you exercise the
// real HTTP + SSE surface with curl / real CLIs WITHOUT a database or a live
// Windows runner. It is NOT for production — production uses the DB backend.
//
// Usage:
//   PATH="$HOME/.node22/bin:$PATH" \
//   CSAPI_DEV_KEY=dev-key CSAPI_DEV_PORT=18099 \
//   node --import tsx scripts/csapi/dev-fake-server.ts
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import type { CsapiBackend, CsapiRunHandle, CsapiRunSnapshot } from "../../apps/server/src/csapi/backend.js";
import { registerCsapi } from "../../apps/server/src/csapi/server.js";

const KEY = process.env.CSAPI_DEV_KEY ?? "dev-key";
const PORT = Number(process.env.CSAPI_DEV_PORT ?? 18099);
const FINISH_DELAY_MS = Number(process.env.CSAPI_DEV_FINISH_MS ?? 300);

class InMemoryBackend implements CsapiBackend {
  private runs = new Map<string, { createdAt: number; prompt: string; conversationId: string; cancelledAt?: number }>();
  private conversations = new Set<string>();

  listModelIds() {
    return ["cursor-fast", "cursor-smart"];
  }
  runnersOnline() {
    return 1;
  }
  modelIsKnown(model: string) {
    return model === "auto" || this.listModelIds().includes(model);
  }
  async pickWorkspaceId(preferred?: string) {
    return preferred || "ws-dev";
  }
  async getPrincipalId() {
    return "dev-principal";
  }
  async createConversation() {
    const id = randomUUID();
    this.conversations.add(id);
    return id;
  }
  async conversationExists(id: string) {
    return this.conversations.has(id);
  }
  async createRun(input: { conversationId: string; prompt: string }): Promise<CsapiRunHandle> {
    const runId = randomUUID();
    this.runs.set(runId, { createdAt: Date.now(), prompt: input.prompt, conversationId: input.conversationId });
    return { runId, conversationId: input.conversationId, status: "queued" };
  }
  async getRun(runId: string): Promise<CsapiRunSnapshot | undefined> {
    const run = this.runs.get(runId);
    if (!run) return undefined;
    if (run.cancelledAt) {
      return { status: "cancelled", response: null, error: "cancelled", progress: null, inputTokens: null, outputTokens: null };
    }
    const elapsed = Date.now() - run.createdAt;
    if (run.prompt.includes("FORCE_ERROR")) {
      if (elapsed >= FINISH_DELAY_MS) {
        return { status: "error", response: null, error: "simulated upstream error", progress: null, inputTokens: null, outputTokens: null };
      }
      return { status: "running", response: null, error: null, progress: "working", inputTokens: null, outputTokens: null };
    }
    if (elapsed >= FINISH_DELAY_MS) {
      const reply = `You said: ${run.prompt}\n\n(This is a simulated csapi dev-backend reply; no real model was called.)`;
      return { status: "finished", response: reply, error: null, progress: null, inputTokens: 12, outputTokens: 20 };
    }
    return { status: "running", response: null, error: null, progress: "working", inputTokens: null, outputTokens: null };
  }
  async cancelRun(runId: string) {
    const run = this.runs.get(runId);
    if (run && !run.cancelledAt) {
      run.cancelledAt = Date.now();
      console.log(`[dev-backend] cancelRun called for ${runId} (client abort / timeout)`);
    }
  }
  async audit() {
    /* no-op */
  }
}

async function main() {
  const app = Fastify({ logger: true });
  registerCsapi(app, {
    backend: new InMemoryBackend(),
    config: {
      enabled: true,
      apiKeys: new Set([KEY]),
      defaultModel: "auto",
      defaultWorkspaceId: "",
      maxConcurrencyPerKey: 4,
      runTimeoutMs: 60_000,
      allowWrites: false
    },
    pollIntervalMs: 100
  });
  await app.listen({ host: "127.0.0.1", port: PORT });
  app.log.info(`csapi dev fake server on http://127.0.0.1:${PORT} (key=${KEY})`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
