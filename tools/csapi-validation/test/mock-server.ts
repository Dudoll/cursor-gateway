import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Clock } from "../src/types.js";

const ORIGIN = Date.parse("2026-07-21T00:00:00.000Z");

interface MockRun {
  runId: string;
  idempotencyKey: string;
  status: "running" | "finished" | "error" | "cancelled";
  queuedAt: string;
  startedAt: string;
  finishedAt: string | null;
  lastActivityAt: string;
  provider: string;
  model: string;
  cancelReason: string | null;
  claimAttempts: number;
  applicationStatusCode: string | null;
  events: Array<{ type: string; at: string }>;
  prompt: string;
  chatId: string;
}

export interface MockCsapiServerOptions {
  terminalStatus?: "finished" | "cancelled";
  cancelReason?: string;
  claimAttempts?: number;
  duplicateIdempotencyRun?: boolean;
}

interface PendingGate {
  promise: Promise<void>;
  release(): void;
  arrivals: number;
}

function gate(): PendingGate {
  let release!: () => void;
  return {
    promise: new Promise<void>((resolve) => {
      release = resolve;
    }),
    release,
    arrivals: 0
  };
}

function iso(offsetMs: number): string {
  return new Date(ORIGIN + offsetMs).toISOString();
}

async function jsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
    if (body.length > 1024 * 1024) throw new Error("request too large");
  }
  return JSON.parse(body) as Record<string, unknown>;
}

function userPrompt(body: Record<string, unknown>): string {
  const messages = body.messages;
  if (!Array.isArray(messages)) return "";
  const first = messages[0];
  if (!first || typeof first !== "object") return "";
  const content = (first as Record<string, unknown>).content;
  return typeof content === "string" ? content : "";
}

function writeJson(
  response: ServerResponse,
  status: number,
  value: unknown
): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function writeSse(response: ServerResponse, run: MockRun): void {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "x-csapi-run-id": run.runId,
    "x-csapi-run-status": run.status,
    "x-csapi-queued-at": run.queuedAt,
    "x-csapi-started-at": run.startedAt,
    "x-csapi-finished-at": run.finishedAt ?? "",
    "x-csapi-last-activity-at": run.lastActivityAt,
    "x-csapi-provider": run.provider,
    "x-csapi-model": run.model,
    "x-csapi-cancel-reason": run.cancelReason ?? "",
    "x-csapi-claim-attempts": String(run.claimAttempts)
  });
  response.write(
    `data: ${JSON.stringify({
      id: "chatcmpl-heartbeat",
      object: "chat.completion.chunk",
      model: run.model,
      choices: [{ index: 0, delta: {}, finish_reason: null }]
    })}\n\n`
  );
  response.write(
    `data: ${JSON.stringify({
      id: run.chatId,
      object: "chat.completion.chunk",
      model: run.model,
      choices: [
        {
          index: 0,
          delta: { content: "mock output intentionally discarded" },
          finish_reason: "stop"
        }
      ]
    })}\n\n`
  );
  response.end("data: [DONE]\n\n");
}

export class FakeClock implements Clock {
  constructor(private current = ORIGIN) {}

  now(): number {
    return this.current;
  }

  async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new Error("ABORTED"));
    this.current += ms;
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (signal?.aborted) throw new Error("ABORTED");
  }
}

export class MockCsapiServer {
  readonly apiKey = "mock-api-key-DO-NOT-PRINT";
  readonly chatId = "chatcmpl-mock-chat-id-DO-NOT-PRINT";
  readonly runsByKey = new Map<string, MockRun>();
  readonly requests: Array<{
    scenario: string;
    authorization: string;
    prompt: string;
    idempotencyKey: string;
  }> = [];
  readonly createCountByKey = new Map<string, number>();
  private readonly extraRunsByKey = new Map<string, MockRun[]>();
  private readonly sixGate = gate();
  private readonly idempotencyGate = gate();
  private readonly longGate = gate();
  private readonly longObservationCount = new Map<string, number>();
  private readonly requestCountByKey = new Map<string, number>();
  private readonly server = createServer((request, response) => {
    void this.handle(request, response).catch(() => {
      if (!response.headersSent) writeJson(response, 500, { error: "mock_failure" });
      else response.end();
    });
  });

  constructor(private readonly options: MockCsapiServerOptions = {}) {}

  async start(): Promise<string> {
    await new Promise<void>((resolve) => {
      this.server.listen(0, "127.0.0.1", resolve);
    });
    const address = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private authorized(request: IncomingMessage): boolean {
    return request.headers.authorization === `Bearer ${this.apiKey}`;
  }

  private createRun(
    key: string,
    scenario: string,
    slot: number,
    prompt: string
  ): MockRun {
    const existing = this.runsByKey.get(key);
    if (existing) return existing;
    const long = scenario === "long-active-reattach";
    const terminalStatus = this.options.terminalStatus ?? "finished";
    const run: MockRun = {
      runId: randomUUID(),
      idempotencyKey: key,
      status: long ? "running" : terminalStatus,
      queuedAt: iso(slot),
      startedAt: iso(long ? 1_000 : 100),
      finishedAt: long ? null : iso(1_100 + slot),
      lastActivityAt: iso(long ? 301_000 : 1_000),
      provider: "cursor-gateway",
      model: "gpt-5.6-sol",
      cancelReason:
        !long && terminalStatus === "cancelled"
          ? (this.options.cancelReason ?? "validation-tool-cancelled")
          : null,
      claimAttempts: this.options.claimAttempts ?? 1,
      applicationStatusCode: null,
      events: long
        ? []
        : [
            { type: "accepted", at: iso(slot) },
            { type: "started", at: iso(100) },
            {
              type:
                terminalStatus === "finished"
                  ? "completed"
                  : "cancelled",
              at: iso(1_100 + slot)
            }
          ],
      prompt,
      chatId: this.chatId
    };
    this.runsByKey.set(key, run);
    const duplicate =
      this.options.duplicateIdempotencyRun === true &&
      scenario === "concurrent-idempotency";
    if (duplicate) {
      this.extraRunsByKey.set(key, [{ ...run, runId: randomUUID() }]);
    }
    this.createCountByKey.set(
      key,
      (this.createCountByKey.get(key) ?? 0) + (duplicate ? 2 : 1)
    );
    return run;
  }

  private publicRun(run: MockRun): Record<string, unknown> {
    return {
      runId: run.runId,
      status: run.status,
      queuedAt: run.queuedAt,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      lastActivityAt: run.lastActivityAt,
      terminal: run.status !== "running",
      cancelReason: run.cancelReason,
      claimAttempts: run.claimAttempts,
      provider: run.provider,
      model: run.model,
      applicationStatusCode: run.applicationStatusCode,
      events: run.events,
      chatId: run.chatId,
      prompt: run.prompt,
      response: run.prompt
    };
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    const url = new URL(request.url ?? "/", "http://mock.invalid");
    if (!this.authorized(request)) {
      writeJson(response, 401, { error: "unauthorized" });
      return;
    }

    if (request.method === "GET" && url.pathname.startsWith("/observe/by-key/")) {
      const key = decodeURIComponent(url.pathname.slice("/observe/by-key/".length));
      const run = this.runsByKey.get(key);
      if (run?.status === "running") {
        const count = (this.longObservationCount.get(key) ?? 0) + 1;
        this.longObservationCount.set(key, count);
        run.lastActivityAt = iso(1_000 + Math.min(6, count - 1) * 60_000);
        if (count >= 7) {
          run.status = "finished";
          run.finishedAt = iso(371_000);
          run.lastActivityAt = iso(361_000);
          this.longGate.release();
        }
      }
      writeJson(response, 200, {
        runs: run
          ? [
              this.publicRun(run),
              ...(this.extraRunsByKey.get(key) ?? []).map((item) =>
                this.publicRun(item)
              )
            ]
          : []
      });
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/observe/by-run/")) {
      const runId = decodeURIComponent(url.pathname.slice("/observe/by-run/".length));
      const run = [
        ...this.runsByKey.values(),
        ...[...this.extraRunsByKey.values()].flat()
      ].find((item) => item.runId === runId);
      if (!run) {
        writeJson(response, 404, { error: "not_found" });
        return;
      }
      writeJson(response, 200, { run: this.publicRun(run) });
      return;
    }
    if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
      writeJson(response, 404, { error: "not_found" });
      return;
    }

    const body = await jsonBody(request);
    const scenario = String(
      request.headers["x-csapi-validation-scenario"] ?? "success"
    );
    const idempotencyKey = String(request.headers["idempotency-key"] ?? "");
    const prompt = userPrompt(body);
    const slot = Number(
      (body.metadata as Record<string, unknown> | undefined)?.validation_slot ?? 1
    );
    this.requests.push({
      scenario,
      authorization: String(request.headers.authorization ?? ""),
      prompt,
      idempotencyKey
    });

    if (scenario === "internal-502") {
      writeJson(response, 502, {
        error: {
          code: "CSAPI_RUN_ERROR",
          applicationStatusCode: "CSAPI_RUN_ERROR",
          provider: "cursor-gateway",
          model: "gpt-5.6-sol",
          message: `${prompt} ${this.apiKey}`
        }
      });
      return;
    }
    if (scenario === "internal-504") {
      writeJson(response, 504, {
        error: {
          code: "CSAPI_IDLE_TIMEOUT",
          applicationStatusCode: "CSAPI_IDLE_TIMEOUT",
          provider: "cursor-gateway",
          model: "gpt-5.6-sol",
          message: `${prompt} ${this.apiKey}`
        }
      });
      return;
    }
    if (scenario === "provider-drift") {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "x-csapi-provider": "DeepSeek",
        "x-csapi-model": "deepseek-chat"
      });
      response.end("data: [DONE]\n\n");
      return;
    }

    const run = this.createRun(idempotencyKey, scenario, slot, prompt);
    const attempt = (this.requestCountByKey.get(idempotencyKey) ?? 0) + 1;
    this.requestCountByKey.set(idempotencyKey, attempt);

    if (scenario === "long-active-reattach" && attempt === 1) {
      writeJson(response, 504, {
        error: {
          code: "CSAPI_CALLER_WAIT_TIMEOUT",
          applicationStatusCode: "CSAPI_CALLER_WAIT_TIMEOUT",
          provider: run.provider,
          model: run.model,
          message: `${prompt} ${this.apiKey}`
        }
      });
      return;
    }
    if (scenario === "long-active-reattach") {
      await this.longGate.promise;
      writeSse(response, run);
      return;
    }

    if (scenario === "six-concurrency") {
      this.sixGate.arrivals += 1;
      if (this.sixGate.arrivals === 6) this.sixGate.release();
      await this.sixGate.promise;
    }
    if (scenario === "concurrent-idempotency") {
      this.idempotencyGate.arrivals += 1;
      if (this.idempotencyGate.arrivals === 2) this.idempotencyGate.release();
      await this.idempotencyGate.promise;
    }
    writeSse(response, run);
  }
}
