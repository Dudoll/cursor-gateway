#!/usr/bin/env node

const baseUrl = new URL(process.env.CSAPI_SMOKE_BASE_URL ?? "http://127.0.0.1:8080");
const apiKey = process.env.CSAPI_SMOKE_API_KEY ?? "";
const model = process.env.CSAPI_SMOKE_MODEL ?? "gpt-5.4-nano";
const levels = (process.env.CSAPI_SMOKE_LEVELS ?? "1,2,4")
  .split(",")
  .map((value) => Number.parseInt(value.trim(), 10))
  .filter((value) => Number.isInteger(value) && value > 0 && value <= 8);
const timeoutMs = Number.parseInt(process.env.CSAPI_SMOKE_TIMEOUT_MS ?? "120000", 10);
const localHosts = new Set(["127.0.0.1", "localhost", "::1"]);
const production =
  process.env.CSAPI_SMOKE_PRODUCTION === "1" || !localHosts.has(baseUrl.hostname);

if (production && process.env.CSAPI_SMOKE_ALLOW_PRODUCTION !== "1") {
  throw new Error(
    "Refusing production target. Set CSAPI_SMOKE_ALLOW_PRODUCTION=1 explicitly."
  );
}
if (!apiKey) throw new Error("CSAPI_SMOKE_API_KEY is required");
if (levels.length === 0) throw new Error("CSAPI_SMOKE_LEVELS has no valid levels (max 8)");

const quantile = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
};

async function request(level, index, stamp) {
  const expected = `CSAPI-SMOKE-${stamp}-${level}-${index}`;
  const started = performance.now();
  let headersMs = null;
  let firstDataMs = null;
  let status = 0;
  let body = "";
  let error = null;

  try {
    const response = await fetch(new URL("/v1/chat/completions", baseUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "x-session-id": `csapi-smoke-${stamp}-${level}-${index}`,
        "idempotency-key": `csapi-smoke-${stamp}-${level}-${index}`
      },
      body: JSON.stringify({
        model,
        stream: true,
        max_tokens: 24,
        messages: [{ role: "user", content: `Reply exactly ${expected}` }]
      }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    status = response.status;
    headersMs = performance.now() - started;
    if (response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (firstDataMs === null) firstDataMs = performance.now() - started;
        body += decoder.decode(value, { stream: true });
      }
      body += decoder.decode();
    } else {
      body = await response.text();
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.name : "Error";
  }

  return {
    status,
    error,
    ok: status === 200 && body.includes(expected),
    headersMs,
    firstDataMs,
    totalMs: performance.now() - started,
    heartbeatFrames: (body.match(/chatcmpl-heartbeat/g) ?? []).length
  };
}

console.log(
  JSON.stringify({
    phase: "start",
    target: baseUrl.origin,
    production,
    model,
    levels,
    startedAt: new Date().toISOString()
  })
);

for (const concurrency of levels) {
  const stamp = Date.now();
  const batchStarted = performance.now();
  const results = await Promise.all(
    Array.from({ length: concurrency }, (_, index) => request(concurrency, index, stamp))
  );
  const elapsedSeconds = (performance.now() - batchStarted) / 1_000;
  const latencies = results.map((result) => result.totalMs);
  const statuses = Object.fromEntries(
    [...new Set(results.map((result) => String(result.status)))].map((status) => [
      status,
      results.filter((result) => String(result.status) === status).length
    ])
  );
  const successes = results.filter((result) => result.ok).length;
  console.log(
    JSON.stringify({
      concurrency,
      requests: results.length,
      statuses,
      successes,
      errors: results.filter((result) => result.error).length,
      p50Ms: Number(quantile(latencies, 0.5).toFixed(1)),
      p95Ms: Number(quantile(latencies, 0.95).toFixed(1)),
      maxMs: Number(Math.max(...latencies).toFixed(1)),
      minFirstDataMs: Number(
        Math.min(
          ...results
            .map((result) => result.firstDataMs)
            .filter((value) => value !== null)
        ).toFixed(1)
      ),
      heartbeatFrames: results.reduce(
        (total, result) => total + result.heartbeatFrames,
        0
      ),
      throughputRps: Number((successes / elapsedSeconds).toFixed(3))
    })
  );
}

console.log(JSON.stringify({ phase: "complete", endedAt: new Date().toISOString() }));
