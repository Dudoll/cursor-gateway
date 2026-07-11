import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { RunnerJobProgress, RunnerJobResult, Workspace } from "@cursor-gateway/shared";
import { runnerJobSchema } from "@cursor-gateway/shared";
import { config } from "./config.js";
import { listCursorModels, runCursorJob } from "./cursorAgent.js";
import { writeHealthSnapshot } from "./health.js";

const GATEWAY_REQUEST_TIMEOUT_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 60_000;
const MAX_CONSECUTIVE_HEARTBEAT_FAILURES = 5;
const ERROR_BACKOFF_MS = Math.min(config.pollIntervalMs * 5, 15_000);
const PROGRESS_THROTTLE_MS = 1_000;
const RESULT_SUBMIT_ATTEMPTS = 5;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function workspaceId(path: string) {
  return `ws-${createHash("sha256").update(path.toLowerCase()).digest("hex").slice(0, 12)}`;
}

function configuredWorkspaces(): Workspace[] {
  return config.workspaces
    .filter((path) => {
      const exists = existsSync(path);
      if (!exists) console.warn(`Workspace path does not exist and will be skipped: ${path}`);
      return exists;
    })
    .map((path) => ({
      id: workspaceId(path),
      label: basename(path) || path,
      path,
      writable: true
    }));
}

async function gatewayFetch(path: string, init: RequestInit = {}) {
  const headers: Record<string, string> = {
    authorization: `Bearer ${config.sharedSecret}`,
    ...(init.body ? { "content-type": "application/json" } : {}),
    ...(config.cloudflareAccessClientId && config.cloudflareAccessClientSecret
      ? {
          "cf-access-client-id": config.cloudflareAccessClientId,
          "cf-access-client-secret": config.cloudflareAccessClientSecret
        }
      : {}),
    ...(init.headers as Record<string, string> | undefined)
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GATEWAY_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${config.gatewayUrl}${path}`, {
      ...init,
      headers,
      redirect: "manual",
      signal: controller.signal
    });

    if (response.status >= 300 && response.status < 400) {
      throw new Error(
        `gateway request ${path} was redirected (${response.status}); Cloudflare Access service token was not accepted`
      );
    }

    return response;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`gateway request ${path} timed out after ${GATEWAY_REQUEST_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function heartbeat() {
  const [models, workspaces] = await Promise.all([listCursorModels(), Promise.resolve(configuredWorkspaces())]);
  const response = await gatewayFetch("/api/runner/heartbeat", {
    method: "POST",
    body: JSON.stringify({
      runnerId: config.runnerId,
      models,
      workspaces
    })
  });
  if (!response.ok) {
    throw new Error(`heartbeat failed: ${response.status} ${await response.text()}`);
  }
  console.log(`Heartbeat registered ${workspaces.length} workspaces and ${models.length} models`);
}

async function claimJob() {
  const response = await gatewayFetch("/api/runner/jobs/claim", { method: "POST" });
  if (response.status === 204) return undefined;
  if (!response.ok) throw new Error(`claim failed: ${response.status} ${await response.text()}`);
  const payload = (await response.json()) as { job?: unknown };
  return payload.job ? runnerJobSchema.parse(payload.job) : undefined;
}

async function submitResult(result: RunnerJobResult) {
  const response = await gatewayFetch(`/api/runner/jobs/${result.runId}/result`, {
    method: "POST",
    body: JSON.stringify(result)
  });
  if (!response.ok) {
    throw new Error(`result submit failed: ${response.status} ${await response.text()}`);
  }
}

async function submitProgress(progress: RunnerJobProgress) {
  const response = await gatewayFetch(`/api/runner/jobs/${progress.runId}/progress`, {
    method: "POST",
    body: JSON.stringify(progress)
  });
  if (!response.ok && response.status !== 409) {
    throw new Error(`progress submit failed: ${response.status} ${await response.text()}`);
  }
}

async function submitResultWithRetry(result: RunnerJobResult) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= RESULT_SUBMIT_ATTEMPTS; attempt += 1) {
    try {
      await submitResult(result);
      return;
    } catch (error) {
      lastError = error;
      console.error(`Result submit attempt ${attempt}/${RESULT_SUBMIT_ATTEMPTS} failed`, error);
      if (attempt < RESULT_SUBMIT_ATTEMPTS) await sleep(ERROR_BACKOFF_MS);
    }
  }
  throw lastError;
}

async function heartbeatLoop() {
  let consecutiveFailures = 0;

  for (;;) {
    try {
      await heartbeat();
      consecutiveFailures = 0;
      writeHealthSnapshot({
        lastHeartbeatOk: true,
        consecutiveFailures,
        lastError: null,
        lastHeartbeatAt: new Date().toISOString()
      });
    } catch (error) {
      consecutiveFailures += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Heartbeat failure ${consecutiveFailures}/${MAX_CONSECUTIVE_HEARTBEAT_FAILURES}:`, error);
      writeHealthSnapshot({
        lastHeartbeatOk: false,
        consecutiveFailures,
        lastError: message
      });

      if (consecutiveFailures >= MAX_CONSECUTIVE_HEARTBEAT_FAILURES) {
        console.error("Too many consecutive heartbeat failures; exiting for daemon restart.");
        process.exit(1);
      }
    }

    await sleep(HEARTBEAT_INTERVAL_MS);
  }
}

async function jobLoop(workerId: number) {
  for (;;) {
    try {
      const job = await claimJob();
      if (!job) {
        await sleep(config.pollIntervalMs);
        continue;
      }

      console.log(
        `Worker ${workerId} running ${job.runId} in ${job.workspace.path} with model ${job.model}`
      );
      let lastProgressAt = 0;
      let lastProgress = "";
      const reportProgress = async (progress: Omit<RunnerJobProgress, "runId">) => {
        const message = progress.message.slice(-200_000);
        const fingerprint = `${progress.kind}:${message}`;
        const now = Date.now();
        if (fingerprint === lastProgress || now - lastProgressAt < PROGRESS_THROTTLE_MS) return;
        lastProgress = fingerprint;
        lastProgressAt = now;
        try {
          await submitProgress({ runId: job.runId, ...progress, message });
        } catch (error) {
          // Losing a progress update must not terminate the Cursor run.
          console.warn(`Failed to report progress for ${job.runId}`, error);
        }
      };
      await reportProgress({ kind: "working", message: "Starting the model..." });
      const result = await runCursorJob(job, reportProgress);
      await submitResultWithRetry(result);
      console.log(`Worker ${workerId} completed run ${job.runId} with ${result.status}`);
    } catch (error) {
      console.error(error);
      await sleep(ERROR_BACKOFF_MS);
    }
  }
}

function installProcessGuards() {
  process.on("uncaughtException", (error) => {
    console.error("uncaughtException; exiting for daemon restart:", error);
    try {
      writeHealthSnapshot({
        lastHeartbeatOk: false,
        consecutiveFailures: MAX_CONSECUTIVE_HEARTBEAT_FAILURES,
        lastError: error instanceof Error ? error.message : String(error)
      });
    } catch {
      // ignore health write failures during crash
    }
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    console.error("unhandledRejection; exiting for daemon restart:", reason);
    try {
      writeHealthSnapshot({
        lastHeartbeatOk: false,
        consecutiveFailures: MAX_CONSECUTIVE_HEARTBEAT_FAILURES,
        lastError: reason instanceof Error ? reason.message : String(reason)
      });
    } catch {
      // ignore health write failures during crash
    }
    process.exit(1);
  });
}

async function main() {
  installProcessGuards();
  writeHealthSnapshot({
    lastHeartbeatOk: false,
    consecutiveFailures: 0,
    lastError: "starting"
  });

  const workers = Array.from({ length: config.maxConcurrentJobs }, (_, index) => jobLoop(index + 1));
  console.log(`Starting ${workers.length} concurrent job workers`);
  await Promise.all([heartbeatLoop(), ...workers]);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
