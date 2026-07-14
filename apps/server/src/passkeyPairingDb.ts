import type { PoolClient, QueryResultRow } from "pg";
import {
  e2eePasskeyPairingAckSchema,
  e2eePasskeyPairingCompleteSchema,
  e2eePasskeyPairingOptionsSchema,
  e2eePasskeyPairingStartSchema,
  type E2eePasskeyPairingAck,
  type E2eePasskeyPairingComplete,
  type E2eePasskeyPairingOptions,
  type E2eePasskeyPairingStart,
  type E2eePairingStatus
} from "@cursor-gateway/shared";
import { pool } from "./db.js";
import { assertTrustedRecipientEmail } from "./pairingRecipient.js";

export class PasskeyPairingConflictError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "PasskeyPairingConflictError";
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

export type PasskeyPairingRow = {
  pairId: string;
  userId: string;
  status: E2eePairingStatus;
  start: E2eePasskeyPairingStart;
  options: E2eePasskeyPairingOptions | null;
  complete: E2eePasskeyPairingComplete | null;
  ack: E2eePasskeyPairingAck | null;
  runnerId: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
};

export type ClaimedPasskeyPairingStart = PasskeyPairingRow & { recipientEmail: string };

function mapRow(row: QueryResultRow): PasskeyPairingRow {
  return {
    pairId: row.pair_id,
    userId: row.user_id,
    status: row.status as E2eePairingStatus,
    start: e2eePasskeyPairingStartSchema.parse(row.start_envelope),
    options: row.options_envelope
      ? e2eePasskeyPairingOptionsSchema.parse(row.options_envelope)
      : null,
    complete: row.complete_envelope
      ? e2eePasskeyPairingCompleteSchema.parse(row.complete_envelope)
      : null,
    ack: row.ack_envelope ? e2eePasskeyPairingAckSchema.parse(row.ack_envelope) : null,
    runnerId: row.runner_id ?? null,
    expiresAt: row.expires_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

async function expireStale() {
  await pool.query(
    `
      update e2ee_passkey_pairings
      set status = 'expired', updated_at = now()
      where status in ('pending_start', 'offer_ready', 'complete_submitted')
        and expires_at <= now()
    `
  );
}

export async function createPasskeyPairingStart(input: {
  userId: string;
  start: E2eePasskeyPairingStart;
  ttlSeconds: number;
}): Promise<PasskeyPairingRow> {
  const start = e2eePasskeyPairingStartSchema.parse(input.start);
  const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000);
  try {
    const result = await pool.query(
      `
        insert into e2ee_passkey_pairings (
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
      throw new PasskeyPairingConflictError("pair_id_conflict");
    }
    throw error;
  }
}

export async function getPasskeyPairingForUser(
  pairId: string,
  userId: string
): Promise<PasskeyPairingRow | undefined> {
  await expireStale();
  const result = await pool.query(
    `select * from e2ee_passkey_pairings where pair_id = $1 and user_id = $2`,
    [pairId, userId]
  );
  return result.rows[0] ? mapRow(result.rows[0]) : undefined;
}

export async function claimNextPasskeyPairingStart(input: {
  runnerId: string;
}): Promise<ClaimedPasskeyPairingStart | undefined> {
  await expireStale();
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const claimed = await inTransaction(async (client) => {
      const selected = await client.query(
        `
          select p.*, u.email as user_email
          from e2ee_passkey_pairings p
          join app_users u on u.id = p.user_id
          where p.status = 'pending_start'
            and p.expires_at > now()
            and (p.runner_id is null or p.runner_id = $1)
          order by p.created_at
          for update of p skip locked
          limit 1
        `,
        [input.runnerId]
      );
      const row = selected.rows[0];
      if (!row) return undefined;

      let recipientEmail: string;
      try {
        recipientEmail = assertTrustedRecipientEmail(row.user_email);
      } catch {
        await client.query(
          `update e2ee_passkey_pairings set status = 'rejected', updated_at = now() where pair_id = $1`,
          [row.pair_id]
        );
        return { skippedInvalidRecipient: true as const };
      }

      const updated = await client.query(
        `
          update e2ee_passkey_pairings
          set runner_id = $2, updated_at = now()
          where pair_id = $1
          returning *
        `,
        [row.pair_id, input.runnerId]
      );
      return { pairing: { ...mapRow(updated.rows[0]), recipientEmail } };
    });

    if (!claimed) return undefined;
    if ("skippedInvalidRecipient" in claimed) continue;
    return claimed.pairing;
  }
  return undefined;
}

export async function publishPasskeyPairingOptions(input: {
  runnerId: string;
  options: E2eePasskeyPairingOptions;
}): Promise<PasskeyPairingRow> {
  const options = e2eePasskeyPairingOptionsSchema.parse(input.options);
  return inTransaction(async (client) => {
    const selected = await client.query(
      `select * from e2ee_passkey_pairings where pair_id = $1 for update`,
      [options.pairId]
    );
    const row = selected.rows[0];
    if (!row) throw new PasskeyPairingConflictError("pairing_not_found");
    if (row.expires_at.getTime() <= Date.now()) {
      throw new PasskeyPairingConflictError("pairing_expired");
    }
    if (row.status !== "pending_start" && row.status !== "offer_ready") {
      throw new PasskeyPairingConflictError("pairing_status_invalid");
    }
    if (row.runner_id && row.runner_id !== input.runnerId) {
      throw new PasskeyPairingConflictError("pairing_runner_mismatch");
    }
    const start = e2eePasskeyPairingStartSchema.parse(row.start_envelope);
    if (
      start.clientId !== options.clientId ||
      start.clientChallenge !== options.clientChallenge ||
      start.signingKey.fingerprint !== options.clientSigningFingerprint ||
      start.encryptionKey.fingerprint !== options.clientEncryptionFingerprint
    ) {
      throw new PasskeyPairingConflictError("pairing_options_mismatch");
    }
    const updated = await client.query(
      `
        update e2ee_passkey_pairings
        set status = 'offer_ready',
            options_envelope = $3,
            runner_id = $2,
            expires_at = $4,
            updated_at = now()
        where pair_id = $1
        returning *
      `,
      [options.pairId, input.runnerId, JSON.stringify(options), options.expiresAt]
    );
    return mapRow(updated.rows[0]);
  });
}

export async function submitPasskeyPairingComplete(input: {
  userId: string;
  complete: E2eePasskeyPairingComplete;
}): Promise<PasskeyPairingRow> {
  const complete = e2eePasskeyPairingCompleteSchema.parse(input.complete);
  return inTransaction(async (client) => {
    const selected = await client.query(
      `select * from e2ee_passkey_pairings where pair_id = $1 and user_id = $2 for update`,
      [complete.pairId, input.userId]
    );
    const row = selected.rows[0];
    if (!row) throw new PasskeyPairingConflictError("pairing_not_found");
    if (row.expires_at.getTime() <= Date.now()) {
      throw new PasskeyPairingConflictError("pairing_expired");
    }
    if (row.status !== "offer_ready" && row.status !== "complete_submitted") {
      throw new PasskeyPairingConflictError("pairing_status_invalid");
    }
    const start = e2eePasskeyPairingStartSchema.parse(row.start_envelope);
    if (start.clientId !== complete.clientId) {
      throw new PasskeyPairingConflictError("pairing_client_mismatch");
    }
    if (row.complete_envelope) {
      const existing = e2eePasskeyPairingCompleteSchema.parse(row.complete_envelope);
      if (JSON.stringify(existing) !== JSON.stringify(complete)) {
        throw new PasskeyPairingConflictError("pairing_complete_conflict");
      }
      return mapRow(row);
    }
    const updated = await client.query(
      `
        update e2ee_passkey_pairings
        set status = 'complete_submitted',
            complete_envelope = $2,
            updated_at = now()
        where pair_id = $1
        returning *
      `,
      [complete.pairId, JSON.stringify(complete)]
    );
    return mapRow(updated.rows[0]);
  });
}

export async function claimNextPasskeyPairingComplete(input: {
  runnerId: string;
}): Promise<PasskeyPairingRow | undefined> {
  await expireStale();
  const result = await pool.query(
    `
      select *
      from e2ee_passkey_pairings
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

export async function publishPasskeyPairingAck(input: {
  runnerId: string;
  ack: E2eePasskeyPairingAck;
}): Promise<PasskeyPairingRow> {
  const ack = e2eePasskeyPairingAckSchema.parse(input.ack);
  return inTransaction(async (client) => {
    const selected = await client.query(
      `select * from e2ee_passkey_pairings where pair_id = $1 for update`,
      [ack.pairId]
    );
    const row = selected.rows[0];
    if (!row) throw new PasskeyPairingConflictError("pairing_not_found");
    if (row.runner_id !== input.runnerId) {
      throw new PasskeyPairingConflictError("pairing_runner_mismatch");
    }
    if (row.status !== "complete_submitted" && row.status !== "paired") {
      throw new PasskeyPairingConflictError("pairing_status_invalid");
    }
    const status = ack.status === "paired" ? "paired" : "rejected";
    const updated = await client.query(
      `
        update e2ee_passkey_pairings
        set status = $2, ack_envelope = $3, updated_at = now()
        where pair_id = $1
        returning *
      `,
      [ack.pairId, status, JSON.stringify(ack)]
    );

    if (ack.status === "paired") {
      const start = e2eePasskeyPairingStartSchema.parse(row.start_envelope);
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
          "secure-web-passkey"
        ]
      );
    }
    return mapRow(updated.rows[0]);
  });
}
