import {
  chmodSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmSync,
  writeSync,
  closeSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  E2EE_PROTOCOL,
  E2EE_RUNNER_CODE_PAIRING_KIND,
  type E2eeClientPairingBundle,
  type E2eeRunnerCodePairingAck,
  type E2eeRunnerCodePairingConfirm,
  type E2eeRunnerCodePairingOffer,
  type E2eeRunnerCodePairingStart
} from "@cursor-gateway/shared";
import {
  generatePairingChallenge,
  generateRunnerDeviceCode,
  importSigningPublicKey,
  runnerCodeSas,
  runnerCodeSasEqual,
  runnerDeviceCodeDisplay,
  signValue,
  unsignedEnvelope,
  verifyRunnerCodeTranscriptMac,
  verifyValue
} from "@cursor-gateway/e2ee";
import { config } from "./config.js";
import { RunnerE2eeState } from "./e2eeState.js";
import { getRunnerCertificate } from "./runnerCert.js";

type GatewayFetch = (path: string, init?: RequestInit) => Promise<Response>;

/** In-memory only — the one-time code NEVER touches disk or the structured log. */
type PendingEnrollment = {
  code: string;
  offer: E2eeRunnerCodePairingOffer;
  sas: string[];
  displayedConfirm: boolean;
};
const pending = new Map<string, PendingEnrollment>();

function approvalsDir(): string {
  return join(homedir(), ".cursor-gateway", "runner-code-approvals");
}

function approvalDecision(enrollId: string): "approved" | "rejected" | "pending" {
  const dir = approvalsDir();
  if (existsSync(join(dir, `${enrollId}.approve`))) return "approved";
  if (existsSync(join(dir, `${enrollId}.reject`))) return "rejected";
  return "pending";
}

function clearApproval(enrollId: string): void {
  const dir = approvalsDir();
  for (const suffix of [".approve", ".reject"]) {
    try {
      rmSync(join(dir, `${enrollId}.${suffix.slice(1)}`), { force: true });
    } catch {
      // best effort
    }
  }
}

/**
 * Show the one-time code + SAS on the operator's own terminal/TTY only.
 * Never write the code to the structured (journald-captured) log. When
 * RUNNER_CODE_TTY is set, write a 0600 file (caller reads then it is deleted);
 * otherwise try /dev/tty, falling back to stdout with an explicit warning.
 */
function displayCode(lines: string[]): void {
  const text = `${lines.join("\n")}\n`;
  const target = config.runnerCodeTty;
  if (target) {
    try {
      writeFileSync(target, text, { mode: 0o600 });
      chmodSync(target, 0o600);
      return;
    } catch {
      // fall through
    }
  }
  try {
    const fd = openSync("/dev/tty", "w");
    writeSync(fd, text);
    closeSync(fd);
    return;
  } catch {
    // No TTY (e.g. under a service manager). Fall back to stdout.
    process.stdout.write(text);
  }
}

export async function processRunnerCodePairingCycle(input: {
  state: RunnerE2eeState;
  gatewayFetch: GatewayFetch;
}) {
  if (!config.runnerCodeEnabled) return;
  pruneExpired();
  await claimAndPublishOffer(input);
  await claimAndVerifyConfirm(input);
}

function pruneExpired() {
  const now = Date.now();
  for (const [enrollId, entry] of pending) {
    if (Date.parse(entry.offer.expiresAt) <= now) {
      pending.delete(enrollId);
      clearApproval(enrollId);
    }
  }
}

async function claimAndPublishOffer(input: { state: RunnerE2eeState; gatewayFetch: GatewayFetch }) {
  const response = await input.gatewayFetch("/api/runner/e2ee/v1/runner-code/claim-start", {
    method: "POST",
    body: JSON.stringify({ runnerId: config.runnerId })
  });
  if (response.status === 204) return;
  if (!response.ok) throw new Error(`runner_code_claim_start_failed_${response.status}`);
  const body = (await response.json()) as {
    enrollment?: {
      enrollId: string;
      start: E2eeRunnerCodePairingStart;
      email: string | null;
      expiresAt: string;
    };
  };
  if (!body.enrollment?.start) return;
  const { enrollId, start, email } = body.enrollment;
  if (pending.has(enrollId)) return; // already offered; await confirm

  if (
    config.secureClientOrigins.size > 0 &&
    !config.secureClientOrigins.has(start.secureOrigin)
  ) {
    console.warn(`Rejecting runner-code enrollment ${enrollId}: secure origin mismatch`);
    return;
  }

  const cert = await getRunnerCertificate(input.state);
  if (!cert) {
    console.warn(`Cannot offer runner-code ${enrollId}: no valid Runner identity certificate`);
    return;
  }

  const code = generateRunnerDeviceCode();
  const expiresAt = new Date(Date.now() + config.runnerCodeTtlSeconds * 1000).toISOString();
  const offer: E2eeRunnerCodePairingOffer = {
    protocol: E2EE_PROTOCOL,
    pairingKind: E2EE_RUNNER_CODE_PAIRING_KIND,
    enrollId,
    runnerId: config.runnerId,
    serverNonce: generatePairingChallenge(),
    runnerChallenge: generatePairingChallenge(),
    runnerEncryptionKey: input.state.encryptionKey,
    runnerSigningKey: input.state.signingKey,
    runnerCertificate: cert,
    clientId: start.clientId,
    clientChallenge: start.clientChallenge,
    clientSigningFingerprint: start.signingKey.fingerprint,
    clientEncryptionFingerprint: start.encryptionKey.fingerprint,
    secureOrigin: start.secureOrigin,
    gatewayOrigin: start.gatewayOrigin,
    expiresAt,
    createdAt: new Date().toISOString()
  };
  const sas = await runnerCodeSas(code, offer);
  pending.set(enrollId, { code, offer, sas, displayedConfirm: false });

  const publishResponse = await input.gatewayFetch("/api/runner/e2ee/v1/runner-code/offer", {
    method: "POST",
    body: JSON.stringify({ runnerId: config.runnerId, offer })
  });
  if (!publishResponse.ok) {
    pending.delete(enrollId);
    throw new Error(`runner_code_offer_publish_failed_${publishResponse.status}`);
  }

  displayCode([
    "",
    "==================== RUNNER DEVICE CODE (RAMC) ====================",
    `  account : ${email ?? "(cf-access user)"}`,
    `  device  : ${start.label ?? start.clientId.slice(0, 16)}`,
    `  enrollId: ${enrollId}`,
    "",
    `  CODE    : ${runnerDeviceCodeDisplay(code)}`,
    `  SAS     : ${sas.join(" ")}`,
    "",
    "  Type the CODE into the browser. Compare the 6-word SAS shown in the",
    "  browser with the SAS above — they MUST match.",
    config.runnerCodeApproval === "manual"
      ? `  After the browser confirms, approve with:\n    npm run code:approve -- ${enrollId}   (in apps/windows-runner)`
      : "  Auto-approve is ON: a correct code pairs immediately.",
    "==================================================================",
    ""
  ]);
  console.log(`Published runner-code offer for ${enrollId} (code shown on Runner terminal)`);
}

async function claimAndVerifyConfirm(input: { state: RunnerE2eeState; gatewayFetch: GatewayFetch }) {
  const response = await input.gatewayFetch("/api/runner/e2ee/v1/runner-code/claim-confirm", {
    method: "POST",
    body: JSON.stringify({ runnerId: config.runnerId })
  });
  if (response.status === 204) return;
  if (!response.ok) throw new Error(`runner_code_claim_confirm_failed_${response.status}`);
  const body = (await response.json()) as {
    enrollment?: {
      enrollId: string;
      start: E2eeRunnerCodePairingStart;
      offer: E2eeRunnerCodePairingOffer;
      confirm: E2eeRunnerCodePairingConfirm;
      expiresAt: string;
    };
  };
  if (!body.enrollment?.confirm) return;
  const { enrollId, start, confirm } = body.enrollment;

  const entry = pending.get(enrollId);
  if (!entry) return; // no local code for this enrollment (another Runner / restarted)

  let status: "paired" | "rejected" = "rejected";
  let reason: string | undefined;

  try {
    if (Date.parse(entry.offer.expiresAt) <= Date.now()) throw new Error("expired");

    // Verify the client signature over the confirm envelope first.
    const clientPublicKey = await importSigningPublicKey(start.signingKey.publicKey);
    if (
      confirm.signature.keyId !== start.signingKey.keyId ||
      !(await verifyValue(unsignedEnvelope(confirm), confirm.signature, clientPublicKey))
    ) {
      throw new Error("client_signature_invalid");
    }

    // Verify the HMAC transcript tag against the Runner's OWN authentic offer.
    // A relay that tampered the offer the browser saw makes this fail-closed.
    const macOk = await verifyRunnerCodeTranscriptMac(entry.code, entry.offer, confirm.transcriptMac);
    if (!macOk) {
      reason = "code_mismatch";
      throw new Error("code_mismatch");
    }

    // SAS cross-check (P2 mode B): browser-displayed SAS must equal ours.
    if (!runnerCodeSasEqual(confirm.sas, entry.sas)) {
      reason = "sas_mismatch";
      throw new Error("sas_mismatch");
    }

    // Manual approval: require the operator to confirm the SAS out-of-band.
    if (config.runnerCodeApproval === "manual") {
      const decision = approvalDecision(enrollId);
      if (decision === "pending") {
        if (!entry.displayedConfirm) {
          entry.displayedConfirm = true;
          displayCode([
            "",
            `  Browser confirmed runner-code ${enrollId}. SAS matched: ${entry.sas.join(" ")}`,
            `  Approve : npm run code:approve -- ${enrollId}`,
            `  Reject  : npm run code:reject -- ${enrollId}`,
            ""
          ]);
        }
        return; // leave in confirm_submitted; re-claimed next cycle
      }
      if (decision === "rejected") {
        reason = "operator_rejected";
        throw new Error("operator_rejected");
      }
    }

    const bundle: E2eeClientPairingBundle = {
      protocol: E2EE_PROTOCOL,
      kind: "client-pairing",
      clientId: start.clientId,
      signingKey: start.signingKey,
      encryptionKey: start.encryptionKey,
      createdAt: new Date().toISOString()
    };
    await input.state.pairClient(bundle);
    status = "paired";
    console.log(`Paired secure-web client ${start.clientId} via runner-code ${enrollId}`);
  } catch (error) {
    status = "rejected";
    if (!reason) reason = "rejected";
    console.warn(
      `Runner-code ${enrollId} ${reason}:`,
      error instanceof Error ? error.message : "unknown"
    );
  }

  const cert = await getRunnerCertificate(input.state);
  if (!cert) {
    console.warn(`Cannot ack runner-code ${enrollId}: no valid Runner identity certificate`);
    return;
  }
  const unsignedAck = {
    protocol: E2EE_PROTOCOL,
    pairingKind: E2EE_RUNNER_CODE_PAIRING_KIND as typeof E2EE_RUNNER_CODE_PAIRING_KIND,
    enrollId,
    clientId: start.clientId,
    runnerId: config.runnerId,
    status,
    ...(status === "rejected" && reason ? { reason } : {}),
    runnerEncryptionKey: input.state.encryptionKey,
    runnerSigningKey: input.state.signingKey,
    runnerCertificate: cert,
    createdAt: new Date().toISOString()
  };
  const ack: E2eeRunnerCodePairingAck = {
    ...unsignedAck,
    signature: await signValue(unsignedAck, input.state.signingPrivateKey, input.state.signingKey.keyId)
  };
  const ackResponse = await input.gatewayFetch("/api/runner/e2ee/v1/runner-code/ack", {
    method: "POST",
    body: JSON.stringify({ runnerId: config.runnerId, ack })
  });
  if (!ackResponse.ok) throw new Error(`runner_code_ack_failed_${ackResponse.status}`);

  // Only forget the code once the outcome is terminal (paired, or a
  // non-retryable rejection). Retryable code/sas mismatches keep the pending
  // entry so the operator can retype without regenerating the code.
  if (status === "paired" || (reason && reason !== "code_mismatch" && reason !== "sas_mismatch")) {
    pending.delete(enrollId);
    clearApproval(enrollId);
  }
}

/** CLI helper (pair.ts): record an operator approve/reject decision. */
export function writeRunnerCodeDecision(enrollId: string, decision: "approve" | "reject"): void {
  const dir = approvalsDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${enrollId}.${decision === "approve" ? "approve" : "reject"}`);
  writeFileSync(path, new Date().toISOString(), { mode: 0o600 });
}

/** CLI helper: list pending approval markers. */
export function listRunnerCodeApprovals(): string[] {
  const dir = approvalsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir);
}
