import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import type {
  E2eeProgressEnvelope,
  E2eeResultEnvelope,
  E2eeRunnerJob,
  PublicWorkspace,
  RunnerJobProgress,
  RunnerJobResult,
  Workspace
} from "@cursor-gateway/shared";
import {
  E2EE_PROTOCOL,
  e2eeRunnerJobSchema,
  runnerJobSchema
} from "@cursor-gateway/shared";
import { config } from "./config.js";
import { listCursorModels, runCursorJob } from "./cursorAgent.js";
import { E2eeJobProcessor } from "./e2eeProcessor.js";
import { RunnerE2eeState } from "./e2eeState.js";
import { toLocalPath } from "./pathTranslation.js";
import { writeHealthSnapshot } from "./health.js";

const GATEWAY_REQUEST_TIMEOUT_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 60_000;
const MAX_CONSECUTIVE_HEARTBEAT_FAILURES = 5;
const ERROR_BACKOFF_MS = Math.min(config.pollIntervalMs * 5, 15_000);
const PROGRESS_THROTTLE_MS = 1_000;
const RESULT_SUBMIT_ATTEMPTS = 5;
const LEASE_RENEW_INTERVAL_MS = 5 * 60_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function workspaceId(path: string) {
  return `ws-${createHash("sha256").update(path.toLowerCase()).digest("hex").slice(0, 12)}`;
}

function configuredWorkspaces(): Workspace[] {
  return config.workspaces
    .filter((path) => {
      // Check the runtime-local path (WSL maps "D:\..." to "/mnt/d/...") but
      // keep the original path for the registered id/label so a WSL runner
      // shares the exact workspace the Windows runner registered.
      const exists = existsSync(toLocalPath(path));
      if (!exists) console.warn(`Workspace path does not exist and will be skipped: ${path}`);
      return exists;
    })
    .map((path) => ({
      id: workspaceId(path),
      // Display basename only; keep Windows-style path for id/routing. On Linux,
      // Node posix basename leaves "D:\\foo" intact — normalize separators first
      // and mark WSL-hosted registrations clearly in the UI label.
      label: (() => {
        const base = basename(path.replace(/\\/g, "/")) || path;
        return /^[A-Za-z]:[\\/]/.test(path) && process.platform !== "win32"
          ? `${base} (WSL)`
          : base;
      })(),
      path,
      writable: true
    }));
}

function publicWorkspaces(workspaces: Workspace[]): PublicWorkspace[] {
  return workspaces.map(({ id, label, writable }) => ({ id, label, writable }));
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

async function heartbeat(state?: RunnerE2eeState) {
  const [models, workspaces] = await Promise.all([
    listCursorModels(),
    Promise.resolve(configuredWorkspaces())
  ]);

  if (config.e2eeEnabled) {
    if (!state) throw new Error("e2ee_state_not_initialized");
    const response = await gatewayFetch("/api/runner/e2ee/v1/heartbeat", {
      method: "POST",
      body: JSON.stringify({
        runnerId: config.runnerId,
        runnerVersion: config.runnerVersion,
        models,
        workspaces: publicWorkspaces(workspaces),
        e2ee: {
          protocols: [E2EE_PROTOCOL],
          encryptionKey: state.encryptionKey,
          signingKey: state.signingKey
        }
      })
    });
    if (!response.ok) {
      throw new Error(`e2ee heartbeat failed with status ${response.status}`);
    }
  }

  if (config.legacyEnabled) {
    const response = await gatewayFetch("/api/runner/heartbeat", {
      method: "POST",
      body: JSON.stringify({
        runnerId: config.runnerId,
        models,
        workspaces
      })
    });
    if (!response.ok) {
      throw new Error(`legacy heartbeat failed with status ${response.status}`);
    }
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

async function claimE2eeJob(state: RunnerE2eeState): Promise<E2eeRunnerJob | undefined> {
  const response = await gatewayFetch("/api/runner/e2ee/v1/jobs/claim", {
    method: "POST",
    body: JSON.stringify({
      runnerId: config.runnerId,
      runnerKeyId: state.encryptionKey.keyId,
      protocols: [E2EE_PROTOCOL]
    })
  });
  if (response.status === 204) return undefined;
  if (!response.ok) throw new Error(`e2ee claim failed with status ${response.status}`);
  const payload = (await response.json()) as { job?: unknown };
  return payload.job ? e2eeRunnerJobSchema.parse(payload.job) : undefined;
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

async function submitE2eeProgress(
  leaseId: string,
  envelope: E2eeProgressEnvelope
) {
  const response = await gatewayFetch(
    `/api/runner/e2ee/v1/jobs/${envelope.runId}/progress`,
    {
      method: "POST",
      body: JSON.stringify({ leaseId, envelope })
    }
  );
  if (!response.ok && response.status !== 409) {
    throw new Error(`e2ee progress submit failed with status ${response.status}`);
  }
}

async function submitE2eeResult(
  leaseId: string,
  envelope: E2eeResultEnvelope
) {
  const response = await gatewayFetch(
    `/api/runner/e2ee/v1/jobs/${envelope.runId}/result`,
    {
      method: "POST",
      body: JSON.stringify({ leaseId, envelope })
    }
  );
  if (!response.ok) {
    throw new Error(`e2ee result submit failed with status ${response.status}`);
  }
}

function startE2eeLeaseRenewal(job: E2eeRunnerJob, state: RunnerE2eeState) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const renew = async () => {
    if (stopped) return;
    try {
      const response = await gatewayFetch(
        `/api/runner/e2ee/v1/jobs/${job.request.runId}/lease`,
        {
          method: "POST",
          body: JSON.stringify({
            runnerId: config.runnerId,
            runnerKeyId: state.encryptionKey.keyId,
            leaseId: job.leaseId
          })
        }
      );
      if (!response.ok) {
        console.warn(`Encrypted lease renewal failed with status ${response.status}`);
      }
    } catch {
      console.warn("Encrypted lease renewal failed");
    } finally {
      if (!stopped) timer = setTimeout(() => void renew(), LEASE_RENEW_INTERVAL_MS);
    }
  };
  timer = setTimeout(() => void renew(), LEASE_RENEW_INTERVAL_MS);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
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

async function submitE2eeResultWithRetry(
  leaseId: string,
  result: E2eeResultEnvelope
) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= RESULT_SUBMIT_ATTEMPTS; attempt += 1) {
    try {
      await submitE2eeResult(leaseId, result);
      return;
    } catch (error) {
      lastError = error;
      console.error(
        `Encrypted result submit attempt ${attempt}/${RESULT_SUBMIT_ATTEMPTS} failed`
      );
      if (attempt < RESULT_SUBMIT_ATTEMPTS) await sleep(ERROR_BACKOFF_MS);
    }
  }
  throw lastError;
}

async function heartbeatLoop(state?: RunnerE2eeState) {
  let consecutiveFailures = 0;

  for (;;) {
    try {
      await heartbeat(state);
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

async function runLegacyJob(
  workerId: number,
  job: NonNullable<Awaited<ReturnType<typeof claimJob>>>
) {
  console.log(`Worker ${workerId} running legacy job ${job.runId} with model ${job.model}`);
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
    } catch {
      console.warn(`Failed to report legacy progress for ${job.runId}`);
    }
  };
  await reportProgress({ kind: "working", message: "Starting the model..." });
  const result = await runCursorJob(job, reportProgress);
  await submitResultWithRetry(result);
  console.log(`Worker ${workerId} completed legacy run ${job.runId} with ${result.status}`);
}

async function jobLoop(
  workerId: number,
  state: RunnerE2eeState | undefined,
  processor: E2eeJobProcessor | undefined
) {
  for (;;) {
    try {
      if (config.e2eeEnabled) {
        if (!state || !processor) throw new Error("e2ee_processor_not_initialized");
        const encryptedJob = await claimE2eeJob(state);
        if (encryptedJob) {
          console.log(
            `Worker ${workerId} running encrypted job ${encryptedJob.request.runId}`
          );
          let lastProgressAt = 0;
          const stopLeaseRenewal = startE2eeLeaseRenewal(encryptedJob, state);
          let encryptedResult: E2eeResultEnvelope;
          try {
            encryptedResult = await processor.process(
              encryptedJob,
              async (envelope) => {
                const now = Date.now();
                if (now - lastProgressAt < PROGRESS_THROTTLE_MS) return;
                lastProgressAt = now;
                await submitE2eeProgress(encryptedJob.leaseId, envelope);
              }
            );
            await submitE2eeResultWithRetry(encryptedJob.leaseId, encryptedResult);
          } finally {
            stopLeaseRenewal();
          }
          console.log(
            `Worker ${workerId} completed encrypted run ${encryptedJob.request.runId} with ${encryptedResult.status}`
          );
          continue;
        }
      }

      if (config.legacyEnabled) {
        const legacyJob = await claimJob();
        if (legacyJob) {
          await runLegacyJob(workerId, legacyJob);
          continue;
        }
      }

      await sleep(config.pollIntervalMs);
    } catch (error) {
      const code =
        error instanceof Error && /^e2ee_[a-z0-9_]+$/.test(error.message)
          ? error.message
          : "runner_job_failed";
      console.error(`Worker ${workerId} job failure: ${code}`);
      await sleep(ERROR_BACKOFF_MS);
    }
  }
}

function installProcessGuards() {
  process.on("uncaughtException", () => {
    console.error("uncaughtException; exiting for daemon restart");
    try {
      writeHealthSnapshot({
        lastHeartbeatOk: false,
        consecutiveFailures: MAX_CONSECUTIVE_HEARTBEAT_FAILURES,
        lastError: "uncaught_exception"
      });
    } catch {
      // ignore health write failures during crash
    }
    process.exit(1);
  });

  process.on("unhandledRejection", () => {
    console.error("unhandledRejection; exiting for daemon restart");
    try {
      writeHealthSnapshot({
        lastHeartbeatOk: false,
        consecutiveFailures: MAX_CONSECUTIVE_HEARTBEAT_FAILURES,
        lastError: "unhandled_rejection"
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

  const workspaces = configuredWorkspaces();
  const workspaceMap = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
  const state = config.e2eeEnabled
    ? await RunnerE2eeState.loadOrCreate()
    : undefined;
  const processor = state ? new E2eeJobProcessor(state, workspaceMap) : undefined;
  if (state) {
    console.log(`E2EE runner encryption key: ${state.encryptionKey.fingerprint}`);
    console.log(`E2EE runner signing key: ${state.signingKey.fingerprint}`);
  }

  const workers = Array.from({ length: config.maxConcurrentJobs }, (_, index) =>
    jobLoop(index + 1, state, processor)
  );
  console.log(
    `Starting ${workers.length} concurrent job workers (e2ee=${config.e2eeEnabled}, legacy=${config.legacyEnabled})`
  );
  await Promise.all([heartbeatLoop(state), ...workers]);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
