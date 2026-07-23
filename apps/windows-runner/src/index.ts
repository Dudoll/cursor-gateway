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
import { listCursorModels, responseProgressDelta, runCursorJob } from "./cursorAgent.js";
import { E2eeJobProcessor } from "./e2eeProcessor.js";
import { RunnerE2eeState } from "./e2eeState.js";
import { toLocalPath } from "./pathTranslation.js";
import { writeHealthSnapshot } from "./health.js";
import { processCsAuthCycle } from "./csAuth.js";
import { processSecureWebPairingCycle } from "./secureWebPairing.js";
import { assertPairingMailConfigOrThrow } from "./pairingMail.js";
import { processWebauthnPairingCycle } from "./webauthnPairing.js";
import { processDeviceApprovalCycle } from "./deviceApproval.js";
import { processRecoveryPairingCycle } from "./recoveryPairing.js";
import { processRunnerCodePairingCycle } from "./runnerCodePairing.js";
import { trustRootSas } from "@cursor-gateway/e2ee";
import { loadTrustRoots as loadRunnerTrustRoots } from "./runnerCert.js";

const GATEWAY_REQUEST_TIMEOUT_MS = 30_000;
/** Claim long-poll may hold up to ~25s server-side; allow client headroom. */
const GATEWAY_CLAIM_TIMEOUT_MS = 35_000;
const HEARTBEAT_INTERVAL_MS = 60_000;
const MAX_CONSECUTIVE_HEARTBEAT_FAILURES = 5;
const ERROR_BACKOFF_MS = Math.min(config.pollIntervalMs * 5, 15_000);
const PROGRESS_THROTTLE_MS = 1_000;
const RESPONSE_PROGRESS_THROTTLE_MS = 250;
// Long-poll normally keeps this path asleep. If an older gateway returns 204
// immediately, cap the fallback cadence so a misconfigured runner cannot
// turn into a high-rate claim loop.
const NO_JOB_SLEEP_MS = Math.min(Math.max(config.pollIntervalMs, 250), 500);
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

async function gatewayFetch(
  path: string,
  init: RequestInit = {},
  options?: { timeoutMs?: number }
) {
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

  const timeoutMs = options?.timeoutMs ?? GATEWAY_REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

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
      throw new Error(`gateway request ${path} timed out after ${timeoutMs}ms`);
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
  const response = await gatewayFetch(
    "/api/runner/jobs/claim",
    { method: "POST" },
    { timeoutMs: GATEWAY_CLAIM_TIMEOUT_MS }
  );
  if (response.status === 204) return undefined;
  if (!response.ok) throw new Error(`claim failed: ${response.status} ${await response.text()}`);
  const payload = (await response.json()) as { job?: unknown };
  return payload.job ? runnerJobSchema.parse(payload.job) : undefined;
}

async function claimE2eeJob(state: RunnerE2eeState): Promise<E2eeRunnerJob | undefined> {
  const response = await gatewayFetch(
    "/api/runner/e2ee/v1/jobs/claim",
    {
      method: "POST",
      body: JSON.stringify({
        runnerId: config.runnerId,
        runnerKeyId: state.encryptionKey.keyId,
        protocols: [E2EE_PROTOCOL]
      })
    },
    { timeoutMs: GATEWAY_CLAIM_TIMEOUT_MS }
  );
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
  let lastResponseText = "";
  let pendingResponse = "";
  let lastResponseAt = 0;

  const flushResponse = async () => {
    if (!pendingResponse) return;
    const message = pendingResponse;
    pendingResponse = "";
    lastResponseAt = Date.now();
    try {
      await submitProgress({
        runId: job.runId,
        kind: "responding",
        message
      });
    } catch {
      console.warn(`Failed to report legacy response progress for ${job.runId}`);
    }
  };

  const reportProgress = async (progress: Omit<RunnerJobProgress, "runId">) => {
    if (progress.kind === "responding") {
      const delta = responseProgressDelta(lastResponseText, progress.message);
      lastResponseText = delta.accumulated;
      if (!delta.delta) return;
      pendingResponse += delta.delta;
      if (!lastResponseAt || Date.now() - lastResponseAt >= RESPONSE_PROGRESS_THROTTLE_MS) {
        await flushResponse();
      }
      return;
    }

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
  // Flush a final partial response before the terminal aggregate is persisted.
  // The CSAPI stream will subtract this prefix from the final response.
  await flushResponse();
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
          let pendingProgress: E2eeProgressEnvelope | undefined;
          let progressTimer: ReturnType<typeof setTimeout> | undefined;
          let progressChain = Promise.resolve();
          const flushProgress = async () => {
            if (progressTimer) {
              clearTimeout(progressTimer);
              progressTimer = undefined;
            }
            const envelope = pendingProgress;
            pendingProgress = undefined;
            if (!envelope) return;
            lastProgressAt = Date.now();
            progressChain = progressChain
              .then(() => submitE2eeProgress(encryptedJob.leaseId, envelope))
              .catch(() => {
                console.warn(`Failed to report encrypted progress for ${encryptedJob.request.runId}`);
              });
            await progressChain;
          };
          const queueProgress = (envelope: E2eeProgressEnvelope) => {
            pendingProgress = envelope;
            const remaining = PROGRESS_THROTTLE_MS - (Date.now() - lastProgressAt);
            if (remaining <= 0) {
              void flushProgress();
            } else if (!progressTimer) {
              progressTimer = setTimeout(() => void flushProgress(), remaining);
            }
          };
          const stopLeaseRenewal = startE2eeLeaseRenewal(encryptedJob, state);
          let encryptedResult: E2eeResultEnvelope;
          try {
            encryptedResult = await processor.process(
              encryptedJob,
              async (envelope) => {
                queueProgress(envelope);
              }
            );
            await flushProgress();
            await submitE2eeResultWithRetry(encryptedJob.leaseId, encryptedResult);
          } finally {
            if (progressTimer) clearTimeout(progressTimer);
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

      // Long-poll already waited server-side; only back off on errors.
      // Fallback sleep only applies when the gateway returned immediately.
      await sleep(NO_JOB_SLEEP_MS);
    } catch (error) {
      const code =
        error instanceof Error && /^e2ee_[a-z0-9_]+$/.test(error.message)
          ? error.message
          : "runner_job_failed";
      const reason = error instanceof Error ? error.message.slice(0, 240) : "unknown";
      console.error(
        `Worker ${workerId} job failure: ${code}; backoff_ms=${ERROR_BACKOFF_MS}; reason=${reason}`
      );
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

async function pairingLoop(state: RunnerE2eeState) {
  for (;;) {
    try {
      const batchResponse = await gatewayFetch(
        "/api/runner/e2ee/v1/pairings/claim-batch",
        {
          method: "POST",
          body: JSON.stringify({ runnerId: config.runnerId })
        },
        { timeoutMs: GATEWAY_CLAIM_TIMEOUT_MS }
      );
      if (batchResponse.status === 204) {
        await sleep(50);
        continue;
      }
      if (batchResponse.status === 404 || batchResponse.status === 405) {
        // Older gateways without claim-batch — fall back to serial cycles.
        await processSecureWebPairingCycle({ state, gatewayFetch });
        await processCsAuthCycle({ state, gatewayFetch });
        await processWebauthnPairingCycle({ state, gatewayFetch });
        await processDeviceApprovalCycle({ state, gatewayFetch });
        await processRecoveryPairingCycle({ state, gatewayFetch });
        await processRunnerCodePairingCycle({ state, gatewayFetch });
        await sleep(Math.max(config.pollIntervalMs, 3_000));
        continue;
      }
      if (!batchResponse.ok) {
        throw new Error(`pairing batch claim failed: ${batchResponse.status}`);
      }
      // Batch claim already transitioned rows; process each non-null item via
      // the existing cycle helpers (they re-claim / no-op when empty).
      await processSecureWebPairingCycle({ state, gatewayFetch });
      await processCsAuthCycle({ state, gatewayFetch });
      await processWebauthnPairingCycle({ state, gatewayFetch });
      await processDeviceApprovalCycle({ state, gatewayFetch });
      await processRecoveryPairingCycle({ state, gatewayFetch });
      await processRunnerCodePairingCycle({ state, gatewayFetch });
    } catch (error) {
      console.warn(
        "Pairing batch cycle failed:",
        error instanceof Error ? error.message : "unknown"
      );
      await sleep(Math.max(config.pollIntervalMs, 3_000));
    }
  }
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
  assertPairingMailConfigOrThrow();
  const state = config.e2eeEnabled
    ? await RunnerE2eeState.loadOrCreate()
    : undefined;
  const processor = state ? new E2eeJobProcessor(state, workspaceMap) : undefined;
  if (state) {
    console.log(`E2EE runner encryption key: ${state.encryptionKey.fingerprint}`);
    console.log(`E2EE runner signing key: ${state.signingKey.fingerprint}`);
    // RAMC P4: print the trust-root SAS so operators can read it into the mobile
    // PWA over an independent channel on first install.
    try {
      const roots = loadRunnerTrustRoots();
      for (const root of roots) {
        const sas = await trustRootSas(root.fingerprint);
        console.log(`Trust-root SAS (${root.fingerprint.slice(7, 19)}…): ${sas.join(" ")}`);
      }
    } catch {
      // trust roots optional at startup
    }
  }

  const workers = Array.from({ length: config.maxConcurrentJobs }, (_, index) =>
    jobLoop(index + 1, state, processor)
  );
  console.log(
    `Starting ${workers.length} concurrent job workers (e2ee=${config.e2eeEnabled}, legacy=${config.legacyEnabled})`
  );
  const loops: Array<Promise<void>> = [heartbeatLoop(state), ...workers];
  if (state) {
    console.log(
      `Secure-web pairing enabled (mail=${config.pairingMailMode}, ttl=${config.pairingTtlSeconds}s, ` +
        `webauthn=${config.webauthnEnabled}, rpId=${config.webauthnRpId}, ` +
        `runnerCode=${config.runnerCodeEnabled}/${config.runnerCodeApproval})`
    );
    loops.push(pairingLoop(state));
  }
  await Promise.all(loops);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
