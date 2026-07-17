/**
 * Runner-assisted manual code (RAMC) enrollment persistence — the primary
 * no-QR / no-email device verification flow (secure-web-runner-code/1).
 *
 * The one-time code lives ONLY on the Runner. This table persists public
 * envelopes plus an HMAC transcript tag and attempt/TTL bookkeeping; it never
 * stores the code in cleartext. Postgres-backed with row `for update skip
 * locked` claiming — production must not fall back to memory.
 *
 * Mirrors deviceApprovalDb.ts / recoveryPairingDb.ts conventions.
 */
import type { PoolClient, QueryResultRow } from "pg";
import {
  e2eeRunnerCodePairingAckSchema,
  e2eeRunnerCodePairingConfirmSchema,
  e2eeRunnerCodePairingOfferSchema,
  e2eeRunnerCodePairingStartSchema,
  type CgDeviceCert,
  type E2eeRunnerCodePairingAck,
  type E2eeRunnerCodePairingConfirm,
  type E2eeRunnerCodePairingOffer,
  type E2eeRunnerCodePairingStart,
  type E2eeRunnerCodeStatus
} from "@cursor-gateway/shared";
import { pool } from "./db.js";

export class RunnerCodeConflictError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "RunnerCodeConflictError";
  }
}

async function inTransaction<T>(operation: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await operation(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export type RunnerCodeRow = {
  enrollId: string;
  userId: string;
  email: string | null;
  status: E2eeRunnerCodeStatus;
  start: E2eeRunnerCodePairingStart;
  offer: E2eeRunnerCodePairingOffer | null;
  confirm: E2eeRunnerCodePairingConfirm | null;
  ack: E2eeRunnerCodePairingAck | null;
  deviceCert: CgDeviceCert | null;
  runnerId: string | null;
  attempts: number;
  maxAttempts: number;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
};

function mapRow(row: QueryResultRow): RunnerCodeRow {
  return {
    enrollId: row.enroll_id,
    userId: row.user_id,
    email: row.email ?? null,
    status: row.status as E2eeRunnerCodeStatus,
    start: e2eeRunnerCodePairingStartSchema.parse(row.start_envelope),
    offer: row.offer_envelope ? e2eeRunnerCodePairingOfferSchema.parse(row.offer_envelope) : null,
    confirm: row.confirm_envelope
      ? e2eeRunnerCodePairingConfirmSchema.parse(row.confirm_envelope)
      : null,
    ack: row.ack_envelope ? e2eeRunnerCodePairingAckSchema.parse(row.ack_envelope) : null,
    deviceCert: (row.device_cert as CgDeviceCert | null) ?? null,
    runnerId: row.runner_id ?? null,
    attempts: Number(row.attempts ?? 0),
    maxAttempts: Number(row.max_attempts ?? 3),
    expiresAt: row.expires_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

async function expireStale() {
  await pool.query(
    `
      update e2ee_runner_code_enrollments
      set status = 'expired', updated_at = now()
      where status in ('requested', 'offered', 'confirm_submitted')
        and expires_at <= now()
    `
  );
}

export async function createRunnerCodeStart(input: {
  userId: string;
  email: string | null;
  start: E2eeRunnerCodePairingStart;
  ttlSeconds: number;
  maxAttempts: number;
}): Promise<RunnerCodeRow> {
  const start = e2eeRunnerCodePairingStartSchema.parse(input.start);
  const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000);
  try {
    const result = await pool.query(
      `
        insert into e2ee_runner_code_enrollments (
          enroll_id, user_id, email, status, start_envelope, max_attempts, expires_at
        )
        values ($1, $2, $3, 'requested', $4, $5, $6)
        returning *
      `,
      [
        start.enrollId,
        input.userId,
        input.email,
        JSON.stringify(start),
        input.maxAttempts,
        expiresAt.toISOString()
      ]
    );
    return mapRow(result.rows[0]);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "23505"
    ) {
      throw new RunnerCodeConflictError("enroll_id_conflict");
    }
    throw error;
  }
}

export async function getRunnerCodeForUser(
  enrollId: string,
  userId: string
): Promise<RunnerCodeRow | undefined> {
  await expireStale();
  const result = await pool.query(
    `select * from e2ee_runner_code_enrollments where enroll_id = $1 and user_id = $2`,
    [enrollId, userId]
  );
  return result.rows[0] ? mapRow(result.rows[0]) : undefined;
}

/** Runner claims the next `requested` enrollment and binds itself to it. */
export async function claimNextRunnerCodeStart(input: {
  runnerId: string;
}): Promise<RunnerCodeRow | undefined> {
  await expireStale();
  const result = await pool.query(
    `
      update e2ee_runner_code_enrollments
      set runner_id = $1, updated_at = now()
      where enroll_id = (
        select enroll_id
        from e2ee_runner_code_enrollments
        where status = 'requested'
          and expires_at > now()
          and (runner_id is null or runner_id = $1)
        order by created_at
        limit 1
        for update skip locked
      )
      returning *
    `,
    [input.runnerId]
  );
  return result.rows[0] ? mapRow(result.rows[0]) : undefined;
}

export async function publishRunnerCodeOffer(input: {
  runnerId: string;
  offer: E2eeRunnerCodePairingOffer;
}): Promise<RunnerCodeRow> {
  const offer = e2eeRunnerCodePairingOfferSchema.parse(input.offer);
  return inTransaction(async (client) => {
    const selected = await client.query(
      `select * from e2ee_runner_code_enrollments where enroll_id = $1 for update`,
      [offer.enrollId]
    );
    const row = selected.rows[0];
    if (!row) throw new RunnerCodeConflictError("enrollment_not_found");
    if (row.expires_at.getTime() <= Date.now()) {
      throw new RunnerCodeConflictError("enrollment_expired");
    }
    if (row.status !== "requested" && row.status !== "offered") {
      throw new RunnerCodeConflictError("enrollment_status_invalid");
    }
    if (row.runner_id && row.runner_id !== input.runnerId) {
      throw new RunnerCodeConflictError("enrollment_runner_mismatch");
    }
    const start = e2eeRunnerCodePairingStartSchema.parse(row.start_envelope);
    if (
      start.clientId !== offer.clientId ||
      start.clientChallenge !== offer.clientChallenge ||
      start.signingKey.fingerprint !== offer.clientSigningFingerprint ||
      start.encryptionKey.fingerprint !== offer.clientEncryptionFingerprint
    ) {
      throw new RunnerCodeConflictError("enrollment_offer_mismatch");
    }
    const updated = await client.query(
      `
        update e2ee_runner_code_enrollments
        set status = 'offered', offer_envelope = $3, runner_id = $2,
            expires_at = least(expires_at, $4::timestamptz), updated_at = now()
        where enroll_id = $1
        returning *
      `,
      [offer.enrollId, input.runnerId, JSON.stringify(offer), offer.expiresAt]
    );
    return mapRow(updated.rows[0]);
  });
}

/** Browser submits its HMAC transcript tag (proof of the typed code). */
export async function submitRunnerCodeConfirm(input: {
  userId: string;
  confirm: E2eeRunnerCodePairingConfirm;
}): Promise<RunnerCodeRow> {
  const confirm = e2eeRunnerCodePairingConfirmSchema.parse(input.confirm);
  return inTransaction(async (client) => {
    const selected = await client.query(
      `select * from e2ee_runner_code_enrollments where enroll_id = $1 and user_id = $2 for update`,
      [confirm.enrollId, input.userId]
    );
    const row = selected.rows[0];
    if (!row) throw new RunnerCodeConflictError("enrollment_not_found");
    if (row.expires_at.getTime() <= Date.now()) {
      throw new RunnerCodeConflictError("enrollment_expired");
    }
    if (row.status === "locked") throw new RunnerCodeConflictError("enrollment_locked");
    if (row.status !== "offered" && row.status !== "confirm_submitted") {
      throw new RunnerCodeConflictError("enrollment_status_invalid");
    }
    const start = e2eeRunnerCodePairingStartSchema.parse(row.start_envelope);
    if (start.clientId !== confirm.clientId) {
      throw new RunnerCodeConflictError("enrollment_client_mismatch");
    }
    if (Number(row.attempts ?? 0) >= Number(row.max_attempts ?? 3)) {
      await client.query(
        `update e2ee_runner_code_enrollments set status = 'locked', updated_at = now() where enroll_id = $1`,
        [confirm.enrollId]
      );
      throw new RunnerCodeConflictError("enrollment_locked");
    }
    const updated = await client.query(
      `
        update e2ee_runner_code_enrollments
        set status = 'confirm_submitted', confirm_envelope = $2, updated_at = now()
        where enroll_id = $1
        returning *
      `,
      [confirm.enrollId, JSON.stringify(confirm)]
    );
    return mapRow(updated.rows[0]);
  });
}

export async function claimNextRunnerCodeConfirm(input: {
  runnerId: string;
}): Promise<RunnerCodeRow | undefined> {
  await expireStale();
  const result = await pool.query(
    `
      select *
      from e2ee_runner_code_enrollments
      where status = 'confirm_submitted'
        and runner_id = $1
        and expires_at > now()
      order by updated_at
      limit 1
    `,
    [input.runnerId]
  );
  return result.rows[0] ? mapRow(result.rows[0]) : undefined;
}

/**
 * Runner publishes the signed outcome.
 * - paired:   write the e2ee device row, status -> 'paired'.
 * - rejected + reason 'code_mismatch'/'sas_mismatch': increment attempts;
 *   revert to 'offered' for a retry, or 'locked' when attempts are exhausted
 *   (retryable rejections are NOT persisted as a terminal ack).
 * - rejected + any other reason: terminal 'rejected', persist the ack.
 */
export async function publishRunnerCodeAck(input: {
  runnerId: string;
  ack: E2eeRunnerCodePairingAck;
}): Promise<RunnerCodeRow> {
  const ack = e2eeRunnerCodePairingAckSchema.parse(input.ack);
  const retryableReasons = new Set(["code_mismatch", "sas_mismatch"]);
  return inTransaction(async (client) => {
    const selected = await client.query(
      `select * from e2ee_runner_code_enrollments where enroll_id = $1 for update`,
      [ack.enrollId]
    );
    const row = selected.rows[0];
    if (!row) throw new RunnerCodeConflictError("enrollment_not_found");
    if (row.runner_id !== input.runnerId) {
      throw new RunnerCodeConflictError("enrollment_runner_mismatch");
    }
    if (
      row.status !== "confirm_submitted" &&
      row.status !== "paired" &&
      row.status !== "cert_issued"
    ) {
      throw new RunnerCodeConflictError("enrollment_status_invalid");
    }

    if (ack.status === "paired") {
      const start = e2eeRunnerCodePairingStartSchema.parse(row.start_envelope);
      const updated = await client.query(
        `
          update e2ee_runner_code_enrollments
          set status = 'paired', ack_envelope = $2, updated_at = now()
          where enroll_id = $1
          returning *
        `,
        [ack.enrollId, JSON.stringify(ack)]
      );
      await client.query(
        `
          insert into e2ee_devices (
            client_id, user_id, runner_id, signing_key, encryption_key, paired_at, label
          )
          values ($1, $2, $3, $4, $5, now(), $6)
          on conflict (client_id) do update set
            user_id = excluded.user_id,
            runner_id = excluded.runner_id,
            signing_key = excluded.signing_key,
            encryption_key = excluded.encryption_key,
            paired_at = now(),
            revoked_at = null,
            label = coalesce(excluded.label, e2ee_devices.label),
            updated_at = now()
        `,
        [
          start.clientId,
          row.user_id,
          input.runnerId,
          JSON.stringify(start.signingKey),
          JSON.stringify(start.encryptionKey),
          "secure-web-runner-code"
        ]
      );
      return mapRow(updated.rows[0]);
    }

    // Rejected paths.
    const reason = ack.reason ?? "rejected";
    if (retryableReasons.has(reason)) {
      const attempts = Number(row.attempts ?? 0) + 1;
      const maxAttempts = Number(row.max_attempts ?? 3);
      if (attempts >= maxAttempts) {
        const updated = await client.query(
          `
            update e2ee_runner_code_enrollments
            set status = 'locked', attempts = $2, ack_envelope = $3, updated_at = now()
            where enroll_id = $1
            returning *
          `,
          [ack.enrollId, attempts, JSON.stringify(ack)]
        );
        return mapRow(updated.rows[0]);
      }
      const updated = await client.query(
        `
          update e2ee_runner_code_enrollments
          set status = 'offered', attempts = $2, confirm_envelope = null, updated_at = now()
          where enroll_id = $1
          returning *
        `,
        [ack.enrollId, attempts]
      );
      return mapRow(updated.rows[0]);
    }

    const updated = await client.query(
      `
        update e2ee_runner_code_enrollments
        set status = 'rejected', ack_envelope = $2, updated_at = now()
        where enroll_id = $1
        returning *
      `,
      [ack.enrollId, JSON.stringify(ack)]
    );
    return mapRow(updated.rows[0]);
  });
}

/** Attach the server-signed cg-device-cert/2 after pairing (status -> cert_issued). */
export async function attachRunnerCodeDeviceCert(input: {
  enrollId: string;
  deviceCert: CgDeviceCert;
}): Promise<RunnerCodeRow | undefined> {
  const result = await pool.query(
    `
      update e2ee_runner_code_enrollments
      set device_cert = $2::jsonb, status = 'cert_issued', updated_at = now()
      where enroll_id = $1 and status = 'paired'
      returning *
    `,
    [input.enrollId, JSON.stringify(input.deviceCert)]
  );
  return result.rows[0] ? mapRow(result.rows[0]) : undefined;
}
