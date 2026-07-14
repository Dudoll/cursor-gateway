import type { PoolClient, QueryResultRow } from "pg";
import {
  e2eeRecoveryPairingAckSchema,
  e2eeRecoveryPairingCompleteSchema,
  e2eeRecoveryPairingOfferSchema,
  e2eeRecoveryPairingStartSchema,
  e2eeRecoveryHandleSchema,
  type E2eeRecoveryPairingAck,
  type E2eeRecoveryPairingComplete,
  type E2eeRecoveryPairingOffer,
  type E2eeRecoveryPairingStart,
  type E2eeRecoveryHandle,
  type E2eePairingStatus
} from "@cursor-gateway/shared";
import { pool } from "./db.js";

export class RecoveryPairingConflictError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "RecoveryPairingConflictError";
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

export type RecoveryPairingRow = {
  pairId: string;
  userId: string;
  status: E2eePairingStatus;
  start: E2eeRecoveryPairingStart;
  offer: E2eeRecoveryPairingOffer | null;
  complete: E2eeRecoveryPairingComplete | null;
  ack: E2eeRecoveryPairingAck | null;
  runnerId: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
};

function mapRow(row: QueryResultRow): RecoveryPairingRow {
  return {
    pairId: row.pair_id,
    userId: row.user_id,
    status: row.status as E2eePairingStatus,
    start: e2eeRecoveryPairingStartSchema.parse(row.start_envelope),
    offer: row.offer_envelope
      ? e2eeRecoveryPairingOfferSchema.parse(row.offer_envelope)
      : null,
    complete: row.complete_envelope
      ? e2eeRecoveryPairingCompleteSchema.parse(row.complete_envelope)
      : null,
    ack: row.ack_envelope ? e2eeRecoveryPairingAckSchema.parse(row.ack_envelope) : null,
    runnerId: row.runner_id ?? null,
    expiresAt: row.expires_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

async function expireStale() {
  await pool.query(
    `
      update e2ee_recovery_pairings
      set status = 'expired', updated_at = now()
      where status in ('pending_start', 'offer_ready', 'complete_submitted')
        and expires_at <= now()
    `
  );
}

export async function createRecoveryPairingStart(input: {
  userId: string;
  start: E2eeRecoveryPairingStart;
  ttlSeconds: number;
}): Promise<RecoveryPairingRow> {
  const start = e2eeRecoveryPairingStartSchema.parse(input.start);
  const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000);
  try {
    const result = await pool.query(
      `
        insert into e2ee_recovery_pairings (
          pair_id, user_id, status, start_envelope, expires_at
        )
        values ($1, $2, 'pending_start', $3, $4)
        returning *
      `,
      [start.pairId, input.userId, JSON.stringify(start), expiresAt.toISOString()]
    );
    return mapRow(result.rows[0]);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "23505"
    ) {
      throw new RecoveryPairingConflictError("pair_id_conflict");
    }
    throw error;
  }
}

export async function getRecoveryPairingForUser(
  pairId: string,
  userId: string
): Promise<RecoveryPairingRow | undefined> {
  await expireStale();
  const result = await pool.query(
    `select * from e2ee_recovery_pairings where pair_id = $1 and user_id = $2`,
    [pairId, userId]
  );
  return result.rows[0] ? mapRow(result.rows[0]) : undefined;
}

export async function claimNextRecoveryPairingStart(input: {
  runnerId: string;
}): Promise<RecoveryPairingRow | undefined> {
  await expireStale();
  const result = await pool.query(
    `
      update e2ee_recovery_pairings
      set runner_id = $1, updated_at = now()
      where pair_id = (
        select pair_id
        from e2ee_recovery_pairings
        where status = 'pending_start'
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

export async function publishRecoveryPairingOffer(input: {
  runnerId: string;
  offer: E2eeRecoveryPairingOffer;
}): Promise<RecoveryPairingRow> {
  const offer = e2eeRecoveryPairingOfferSchema.parse(input.offer);
  return inTransaction(async (client) => {
    const selected = await client.query(
      `select * from e2ee_recovery_pairings where pair_id = $1 for update`,
      [offer.pairId]
    );
    const row = selected.rows[0];
    if (!row) throw new RecoveryPairingConflictError("pairing_not_found");
    if (row.expires_at.getTime() <= Date.now()) {
      throw new RecoveryPairingConflictError("pairing_expired");
    }
    if (row.status !== "pending_start" && row.status !== "offer_ready") {
      throw new RecoveryPairingConflictError("pairing_status_invalid");
    }
    if (row.runner_id && row.runner_id !== input.runnerId) {
      throw new RecoveryPairingConflictError("pairing_runner_mismatch");
    }
    const start = e2eeRecoveryPairingStartSchema.parse(row.start_envelope);
    if (
      start.clientId !== offer.clientId ||
      start.clientChallenge !== offer.clientChallenge ||
      start.signingKey.fingerprint !== offer.clientSigningFingerprint ||
      start.encryptionKey.fingerprint !== offer.clientEncryptionFingerprint
    ) {
      throw new RecoveryPairingConflictError("pairing_offer_mismatch");
    }
    const updated = await client.query(
      `
        update e2ee_recovery_pairings
        set status = 'offer_ready', offer_envelope = $3, runner_id = $2,
            expires_at = $4, updated_at = now()
        where pair_id = $1
        returning *
      `,
      [offer.pairId, input.runnerId, JSON.stringify(offer), offer.expiresAt]
    );
    return mapRow(updated.rows[0]);
  });
}

export async function submitRecoveryPairingComplete(input: {
  userId: string;
  complete: E2eeRecoveryPairingComplete;
}): Promise<RecoveryPairingRow> {
  const complete = e2eeRecoveryPairingCompleteSchema.parse(input.complete);
  return inTransaction(async (client) => {
    const selected = await client.query(
      `select * from e2ee_recovery_pairings where pair_id = $1 and user_id = $2 for update`,
      [complete.pairId, input.userId]
    );
    const row = selected.rows[0];
    if (!row) throw new RecoveryPairingConflictError("pairing_not_found");
    if (row.expires_at.getTime() <= Date.now()) {
      throw new RecoveryPairingConflictError("pairing_expired");
    }
    if (row.status !== "offer_ready" && row.status !== "complete_submitted") {
      throw new RecoveryPairingConflictError("pairing_status_invalid");
    }
    const start = e2eeRecoveryPairingStartSchema.parse(row.start_envelope);
    if (start.clientId !== complete.clientId) {
      throw new RecoveryPairingConflictError("pairing_client_mismatch");
    }
    if (row.complete_envelope) {
      const existing = e2eeRecoveryPairingCompleteSchema.parse(row.complete_envelope);
      if (JSON.stringify(existing) !== JSON.stringify(complete)) {
        throw new RecoveryPairingConflictError("pairing_complete_conflict");
      }
      return mapRow(row);
    }
    const updated = await client.query(
      `
        update e2ee_recovery_pairings
        set status = 'complete_submitted', complete_envelope = $2, updated_at = now()
        where pair_id = $1
        returning *
      `,
      [complete.pairId, JSON.stringify(complete)]
    );
    return mapRow(updated.rows[0]);
  });
}

export async function claimNextRecoveryPairingComplete(input: {
  runnerId: string;
}): Promise<RecoveryPairingRow | undefined> {
  await expireStale();
  const result = await pool.query(
    `
      select *
      from e2ee_recovery_pairings
      where status = 'complete_submitted'
        and runner_id = $1
        and expires_at > now()
      order by updated_at
      limit 1
    `,
    [input.runnerId]
  );
  return result.rows[0] ? mapRow(result.rows[0]) : undefined;
}

export async function publishRecoveryPairingAck(input: {
  runnerId: string;
  ack: E2eeRecoveryPairingAck;
}): Promise<RecoveryPairingRow> {
  const ack = e2eeRecoveryPairingAckSchema.parse(input.ack);
  return inTransaction(async (client) => {
    const selected = await client.query(
      `select * from e2ee_recovery_pairings where pair_id = $1 for update`,
      [ack.pairId]
    );
    const row = selected.rows[0];
    if (!row) throw new RecoveryPairingConflictError("pairing_not_found");
    if (row.runner_id !== input.runnerId) {
      throw new RecoveryPairingConflictError("pairing_runner_mismatch");
    }
    if (row.status !== "complete_submitted" && row.status !== "paired") {
      throw new RecoveryPairingConflictError("pairing_status_invalid");
    }
    const status = ack.status === "paired" ? "paired" : "rejected";
    const updated = await client.query(
      `
        update e2ee_recovery_pairings
        set status = $2, ack_envelope = $3, updated_at = now()
        where pair_id = $1
        returning *
      `,
      [ack.pairId, status, JSON.stringify(ack)]
    );

    if (ack.status === "paired") {
      const start = e2eeRecoveryPairingStartSchema.parse(row.start_envelope);
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
          ack.clientId,
          row.user_id,
          input.runnerId,
          JSON.stringify(start.signingKey),
          JSON.stringify(start.encryptionKey),
          "secure-web-recovery"
        ]
      );
    }
    return mapRow(updated.rows[0]);
  });
}

/** Public recovery handle (no secret) advertised by the Runner CLI. */
export async function publishRecoveryHandle(input: {
  runnerId: string;
  handle: E2eeRecoveryHandle;
}): Promise<void> {
  const handle = e2eeRecoveryHandleSchema.parse(input.handle);
  await pool.query(
    `
      insert into e2ee_recovery_handles (recovery_id, runner_id, expires_at)
      values ($1, $2, $3)
      on conflict (recovery_id) do update set
        runner_id = excluded.runner_id,
        expires_at = excluded.expires_at
    `,
    [handle.recoveryId, input.runnerId, handle.expiresAt]
  );
}

export async function getRecoveryHandle(
  recoveryId: string
): Promise<{ runnerId: string; expiresAt: string } | undefined> {
  const result = await pool.query(
    `
      select runner_id, expires_at
      from e2ee_recovery_handles
      where recovery_id = $1 and expires_at > now()
    `,
    [recoveryId]
  );
  const row = result.rows[0];
  return row ? { runnerId: row.runner_id, expiresAt: row.expires_at.toISOString() } : undefined;
}
