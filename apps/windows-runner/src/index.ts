import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import type {
  E2eeProgressEnvelope,
  E2eeResultEnvelope,
  E2eeRunRejectionCode,
  E2eeRunnerJob,
  PublicWorkspace,
  RunnerClaimedJob,
  RunnerJobProgress,
  RunnerJobResult,
  Workspace
} from "@cursor-gateway/shared";
import {
  E2EE_PROTOCOL,
  e2eeRunnerJobSchema,
  runnerClaimedJobSchema
} from "@cursor-gateway/shared";
import { config } from "./config.js";
import { listCursorModels, runCursorJob } from "./cursorAgent.js";
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
const HEARTBEAT_INTERVAL_MS = 60_000;
const MAX_CONSECUTIVE_HEARTBEAT_FAILURES = 5;
const ERROR_BACKOFF_MS = Math.min(config.pollIntervalMs * 5, 15_000);
const PROGRESS_THROTTLE_MS = 1_000;
const RESULT_SUBMIT_ATTEMPTS = 5;
const E2EE_LEASE_RENEW_INTERVAL_MS = 60_000;
const LEGACY_LEASE_RENEW_INTERVAL_MS = 30_000;

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
  const response = await gatewayFetch("/api/runner/jobs/claim", {
    method: "POST",
    body: JSON.stringify({ runnerId: config.runnerId })
  });
  if (response.status === 204) return undefined;
  if (!response.ok) throw new Error(`claim failed: ${response.status} ${await response.text()}`);
  const payload = (await response.json()) as { job?: unknown };
  return payload.job ? runnerClaimedJobSchema.parse(payload.job) : undefined;
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

async function submitResult(job: RunnerClaimedJob, result: RunnerJobResult) {
  const response = await gatewayFetch(`/api/runner/jobs/${result.runId}/result`, {
    method: "POST",
    body: JSON.stringify({
      ...result,
      runnerId: config.runnerId,
      leaseId: job.leaseId
    })
  });
  if (!response.ok) {
    throw new Error(`result submit failed: ${response.status} ${await response.text()}`);
  }
}

async function submitProgress(job: RunnerClaimedJob, progress: RunnerJobProgress) {
  const response = await gatewayFetch(`/api/runner/jobs/${progress.runId}/progress`, {
    method: "POST",
    body: JSON.stringify({
      ...progress,
      runnerId: config.runnerId,
      leaseId: job.leaseId
    })
  });
  if (response.status === 409) return false;
  if (!response.ok) {
    throw new Error(`progress submit failed: ${response.status} ${await response.text()}`);
  }
  return true;
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
  if (response.status === 409) return false;
  if (!response.ok) {
    throw new Error(`e2ee progress submit failed with status ${response.status}`);
  }
  return true;
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

async function submitE2eeRejection(
  job: E2eeRunnerJob,
  state: RunnerE2eeState,
  code: E2eeRunRejectionCode
) {
  const response = await gatewayFetch(
    `/api/runner/e2ee/v1/jobs/${job.request.runId}/reject`,
    {
      method: "POST",
      body: JSON.stringify({
        runnerId: config.runnerId,
        runnerKeyId: state.encryptionKey.keyId,
        leaseId: job.leaseId,
        code
      })
    }
  );
  if (!response.ok) {
    throw new Error(`e2ee rejection submit failed with status ${response.status}`);
  }
}

function startE2eeLeaseRenewal(
  job: E2eeRunnerJob,
  state: RunnerE2eeState,
  abortController: AbortController
) {
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
        if (response.status === 404 || response.status === 409) {
          abortController.abort();
        }
      }
    } catch {
      console.warn("Encrypted lease renewal failed");
    } finally {
      if (!stopped) timer = setTimeout(() => void renew(), E2EE_LEASE_RENEW_INTERVAL_MS);
    }
  };
  timer = setTimeout(() => void renew(), E2EE_LEASE_RENEW_INTERVAL_MS);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

function startLegacyLeaseRenewal(
  job: RunnerClaimedJob,
  abortController: AbortController
) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const renew = async () => {
    if (stopped) return;
    try {
      const response = await gatewayFetch(`/api/runner/jobs/${job.runId}/lease`, {
        method: "POST",
        body: JSON.stringify({
          runnerId: config.runnerId,
          leaseId: job.leaseId
        })
      });
      if (!response.ok) {
        console.warn(`Legacy lease renewal failed with status ${response.status} for ${job.runId}`);
        if (response.status === 404 || response.status === 409) {
          abortController.abort();
        }
      }
    } catch {
      console.warn(`Legacy lease renewal failed for ${job.runId}`);
    } finally {
      if (!stopped) timer = setTimeout(() => void renew(), LEGACY_LEASE_RENEW_INTERVAL_MS);
    }
  };
  timer = setTimeout(() => void renew(), LEGACY_LEASE_RENEW_INTERVAL_MS);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

async function submitResultWithRetry(
  job: RunnerClaimedJob,
  result: RunnerJobResult
) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= RESULT_SUBMIT_ATTEMPTS; attempt += 1) {
    try {
      await submitResult(job, result);
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

function e2eeRejectionCode(error: unknown): E2eeRunRejectionCode {
  const code = error instanceof Error ? error.message : "";
  if (code === "e2ee_client_not_paired") return "client_not_paired";
  if (
    code === "e2ee_wrong_runner" ||
    code === "e2ee_workspace_not_configured_locally" ||
    code === "e2ee_workspace_read_only_locally"
  ) {
    return "runner_state_mismatch";
  }
  if (code.startsWith("e2ee_")) return "invalid_request";
  return "processor_failed";
}

async function submitE2eeRejectionWithRetry(
  job: E2eeRunnerJob,
  state: RunnerE2eeState,
  code: E2eeRunRejectionCode
) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= RESULT_SUBMIT_ATTEMPTS; attempt += 1) {
    try {
      await submitE2eeRejection(job, state, code);
      return;
    } catch (error) {
      lastError = error;
      console.error(
        `Encrypted rejection submit attempt ${attempt}/${RESULT_SUBMIT_ATTEMPTS} failed`
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
  const abortController = new AbortController();
  const reportProgress = async (progress: Omit<RunnerJobProgress, "runId">) => {
    const message = progress.message.slice(-200_000);
    const fingerprint = `${progress.kind}:${message}`;
    const now = Date.now();
    if (fingerprint === lastProgress || now - lastProgressAt < PROGRESS_THROTTLE_MS) return;
    lastProgress = fingerprint;
    lastProgressAt = now;
    try {
      const accepted = await submitProgress(job, {
        runId: job.runId,
        ...progress,
        message
      });
      if (!accepted) abortController.abort();
    } catch {
      console.warn(`Failed to report legacy progress for ${job.runId}`);
    }
  };
  await reportProgress({ kind: "working", message: "Starting the model..." });
  const stopLeaseRenewal = startLegacyLeaseRenewal(job, abortController);
  try {
    const result = await runCursorJob(job, reportProgress, abortController.signal);
    if (abortController.signal.aborted) {
      console.warn(`Worker ${workerId} stopped legacy run ${job.runId} after lease loss`);
      return;
    }
    await submitResultWithRetry(job, result);
    console.log(`Worker ${workerId} completed legacy run ${job.runId} with ${result.status}`);
  } finally {
    stopLeaseRenewal();
  }
}

async function e2eeJobLoop(
  workerId: number,
  state: RunnerE2eeState,
  processor: E2eeJobProcessor
) {
  for (;;) {
    try {
      const encryptedJob = await claimE2eeJob(state);
      if (!encryptedJob) {
        await sleep(config.pollIntervalMs);
        continue;
      }

      console.log(
        `Worker ${workerId} running encrypted job ${encryptedJob.request.runId}`
      );
      let lastProgressAt = 0;
      const abortController = new AbortController();
      const stopLeaseRenewal = startE2eeLeaseRenewal(
        encryptedJob,
        state,
        abortController
      );
      try {
        const encryptedResult = await processor.process(
          encryptedJob,
          async (envelope) => {
            const now = Date.now();
            if (now - lastProgressAt < PROGRESS_THROTTLE_MS) return;
            lastProgressAt = now;
            const accepted = await submitE2eeProgress(
              encryptedJob.leaseId,
              envelope
            );
            if (!accepted) abortController.abort();
          },
          abortController.signal
        );
        if (abortController.signal.aborted) {
          console.warn(
            `Worker ${workerId} stopped encrypted run ${encryptedJob.request.runId} after lease loss`
          );
          continue;
        }
        await submitE2eeResultWithRetry(encryptedJob.leaseId, encryptedResult);
        console.log(
          `Worker ${workerId} completed encrypted run ${encryptedJob.request.runId} with ${encryptedResult.status}`
        );
      } catch (error) {
        if (!abortController.signal.aborted) {
          const rejection = e2eeRejectionCode(error);
          console.error(
            `Worker ${workerId} rejected encrypted run ${encryptedJob.request.runId}: ${rejection}`
          );
          await submitE2eeRejectionWithRetry(encryptedJob, state, rejection);
        }
      } finally {
        stopLeaseRenewal();
      }
    } catch (error) {
      const code =
        error instanceof Error && /^e2ee_[a-z0-9_]+$/.test(error.message)
          ? error.message
          : "runner_job_failed";
      console.error(`E2EE worker ${workerId} loop failure: ${code}`);
      await sleep(ERROR_BACKOFF_MS);
    }
  }
}

async function legacyJobLoop(workerId: number) {
  for (;;) {
    try {
      const legacyJob = await claimJob();
      if (!legacyJob) {
        await sleep(config.pollIntervalMs);
        continue;
      }
      await runLegacyJob(workerId, legacyJob);
    } catch {
      console.error(`Legacy worker ${workerId} loop failure`);
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
      await processSecureWebPairingCycle({
        state,
        gatewayFetch
      });
    } catch (error) {
      console.warn(
        "Secure-web pairing cycle failed:",
        error instanceof Error ? error.message : "unknown"
      );
    }
    try {
      await processCsAuthCycle({
        state,
        gatewayFetch
      });
    } catch (error) {
      console.warn(
        "CS device auth cycle failed:",
        error instanceof Error ? error.message : "unknown"
      );
    }
    try {
      await processWebauthnPairingCycle({
        state,
        gatewayFetch
      });
    } catch (error) {
      console.warn(
        "Passkey pairing cycle failed:",
        error instanceof Error ? error.message : "unknown"
      );
    }
    try {
      await processDeviceApprovalCycle({
        state,
        gatewayFetch
      });
    } catch (error) {
      console.warn(
        "Device approval cycle failed:",
        error instanceof Error ? error.message : "unknown"
      );
    }
    try {
      await processRecoveryPairingCycle({
        state,
        gatewayFetch
      });
    } catch (error) {
      console.warn(
        "Recovery pairing cycle failed:",
        error instanceof Error ? error.message : "unknown"
      );
    }
    try {
      await processRunnerCodePairingCycle({
        state,
        gatewayFetch
      });
    } catch (error) {
      console.warn(
        "Runner-code pairing cycle failed:",
        error instanceof Error ? error.message : "unknown"
      );
    }
    await sleep(Math.max(config.pollIntervalMs, 3_000));
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

  const e2eeWorkers =
    state && processor
      ? Array.from({ length: config.e2eeConcurrentJobs }, (_, index) =>
          e2eeJobLoop(index + 1, state, processor)
        )
      : [];
  const legacyWorkers = Array.from(
    { length: config.legacyConcurrentJobs },
    (_, index) => legacyJobLoop(index + 1)
  );
  console.log(
    `Starting isolated worker pools (e2ee=${e2eeWorkers.length}, legacy=${legacyWorkers.length})`
  );
  const loops: Array<Promise<void>> = [
    heartbeatLoop(state),
    ...e2eeWorkers,
    ...legacyWorkers
  ];
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
