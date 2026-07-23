import type { PoolClient, QueryResultRow } from "pg";
import {
  e2eePairingAckSchema,
  e2eePairingCompleteSchema,
  e2eePairingOfferSchema,
  e2eePairingStartSchema,
  type E2eeDeviceRecord,
  type E2eePairingAck,
  type E2eePairingComplete,
  type E2eePairingOffer,
  type E2eePairingStart,
  type E2eePairingStatus
} from "@cursor-gateway/shared";
import { pool } from "./db.js";
import { assertTrustedRecipientEmail } from "./pairingRecipient.js";

export class PairingConflictError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "PairingConflictError";
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

export type PairingRow = {
  pairId: string;
  userId: string;
  status: E2eePairingStatus;
  start: E2eePairingStart;
  offer: E2eePairingOffer | null;
  complete: E2eePairingComplete | null;
  ack: E2eePairingAck | null;
  runnerId: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
};

/** Claimed start for runners: includes Access-bound recipient email only. */
export type ClaimedPairingStart = PairingRow & {
  recipientEmail: string;
};

/**
 * Recipient identity always comes from the Access-bound app_users row. Strip
 * legacy/forged recipient hints from stored envelopes before strict protocol
 * validation so they can never influence delivery or break claim processing.
 */
function parseStoredPairingStart(value: unknown): E2eePairingStart {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return e2eePairingStartSchema.parse(value);
  }
  const {
    email: _email,
    recipientEmail: _recipientEmail,
    ...protocolFields
  } = value as Record<string, unknown>;
  return e2eePairingStartSchema.parse(protocolFields);
}

function mapPairing(row: QueryResultRow): PairingRow {
  return {
    pairId: row.pair_id,
    userId: row.user_id,
    status: row.status as E2eePairingStatus,
    start: parseStoredPairingStart(row.start_envelope),
    offer: row.offer_envelope
      ? e2eePairingOfferSchema.parse(row.offer_envelope)
      : null,
    complete: row.complete_envelope
      ? e2eePairingCompleteSchema.parse(row.complete_envelope)
      : null,
    ack: row.ack_envelope ? e2eePairingAckSchema.parse(row.ack_envelope) : null,
    runnerId: row.runner_id ?? null,
    expiresAt: row.expires_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function mapDevice(row: QueryResultRow): E2eeDeviceRecord {
  return {
    clientId: row.client_id,
    signingKey: row.signing_key,
    encryptionKey: row.encryption_key ?? null,
    pairedAt: row.paired_at.toISOString(),
    label: row.label ?? null,
    revokedAt: row.revoked_at?.toISOString() ?? null
  };
}

export async function createPairingStart(input: {
  userId: string;
  start: E2eePairingStart;
  ttlSeconds: number;
}): Promise<PairingRow> {
  const start = e2eePairingStartSchema.parse(input.start);
  const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000);
  try {
    const result = await pool.query(
      `
        insert into e2ee_pairings (
          pair_id, user_id, status, start_envelope, expires_at
        )
        values ($1, $2, 'pending_start', $3, $4)
        returning *
      `,
      [start.pairId, input.userId, JSON.stringify(start), expiresAt.toISOString()]
    );
    const pairing = mapPairing(result.rows[0]);
    const { notifyPairingQueued } = await import("./runWaiter.js");
    // Wake all runners; claim still filters by runner_id / null.
    notifyPairingQueued(pairing.runnerId ?? "");
    return pairing;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "23505"
    ) {
      throw new PairingConflictError("pair_id_conflict");
    }
    throw error;
  }
}

export async function getPairingForUser(
  pairId: string,
  userId: string
): Promise<PairingRow | undefined> {
  await expireStalePairings();
  const result = await pool.query(
    `
      select *
      from e2ee_pairings
      where pair_id = $1 and user_id = $2
    `,
    [pairId, userId]
  );
  return result.rows[0] ? mapPairing(result.rows[0]) : undefined;
}

export async function claimNextPairingStart(input: {
  runnerId: string;
}): Promise<ClaimedPairingStart | undefined> {
  await expireStalePairings();
  // Retry a few times so a single bad/missing user email does not block the queue.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const claimed = await inTransaction(async (client) => {
      const selected = await client.query(
        `
          select p.*, u.email as user_email
          from e2ee_pairings p
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
          `
            update e2ee_pairings
            set status = 'rejected', updated_at = now()
            where pair_id = $1
          `,
          [row.pair_id]
        );
        return { skippedInvalidRecipient: true as const };
      }

      const updated = await client.query(
        `
          update e2ee_pairings
          set runner_id = $2, updated_at = now()
          where pair_id = $1
          returning *
        `,
        [row.pair_id, input.runnerId]
      );
      return {
        pairing: { ...mapPairing(updated.rows[0]), recipientEmail }
      };
    });

    if (!claimed) return undefined;
    if ("skippedInvalidRecipient" in claimed) continue;
    return claimed.pairing;
  }
  return undefined;
}

export async function publishPairingOffer(input: {
  runnerId: string;
  offer: E2eePairingOffer;
}): Promise<PairingRow> {
  const offer = e2eePairingOfferSchema.parse(input.offer);
  return inTransaction(async (client) => {
    const selected = await client.query(
      `
        select *
        from e2ee_pairings
        where pair_id = $1
        for update
      `,
      [offer.pairId]
    );
    const row = selected.rows[0];
    if (!row) throw new PairingConflictError("pairing_not_found");
    if (row.expires_at.getTime() <= Date.now()) {
      throw new PairingConflictError("pairing_expired");
    }
    if (row.status !== "pending_start" && row.status !== "offer_ready") {
      throw new PairingConflictError("pairing_status_invalid");
    }
    if (row.runner_id && row.runner_id !== input.runnerId) {
      throw new PairingConflictError("pairing_runner_mismatch");
    }
    const start = parseStoredPairingStart(row.start_envelope);
    if (
      start.clientId !== offer.clientId ||
      start.clientChallenge !== offer.clientChallenge ||
      start.signingKey.fingerprint !== offer.clientSigningFingerprint ||
      start.encryptionKey.fingerprint !== offer.clientEncryptionFingerprint
    ) {
      throw new PairingConflictError("pairing_offer_mismatch");
    }
    const updated = await client.query(
      `
        update e2ee_pairings
        set status = 'offer_ready',
            offer_envelope = $3,
            runner_id = $2,
            expires_at = $4,
            updated_at = now()
        where pair_id = $1
        returning *
      `,
      [
        offer.pairId,
        input.runnerId,
        JSON.stringify(offer),
        offer.expiresAt
      ]
    );
    return mapPairing(updated.rows[0]);
  });
}

export async function submitPairingComplete(input: {
  userId: string;
  complete: E2eePairingComplete;
}): Promise<PairingRow> {
  const complete = e2eePairingCompleteSchema.parse(input.complete);
  return inTransaction(async (client) => {
    const selected = await client.query(
      `
        select *
        from e2ee_pairings
        where pair_id = $1 and user_id = $2
        for update
      `,
      [complete.pairId, input.userId]
    );
    const row = selected.rows[0];
    if (!row) throw new PairingConflictError("pairing_not_found");
    if (row.expires_at.getTime() <= Date.now()) {
      throw new PairingConflictError("pairing_expired");
    }
    if (row.status !== "offer_ready" && row.status !== "complete_submitted") {
      throw new PairingConflictError("pairing_status_invalid");
    }
    const start = parseStoredPairingStart(row.start_envelope);
    if (start.clientId !== complete.clientId) {
      throw new PairingConflictError("pairing_client_mismatch");
    }
    if (row.complete_envelope) {
      const existing = e2eePairingCompleteSchema.parse(row.complete_envelope);
      if (JSON.stringify(existing) !== JSON.stringify(complete)) {
        throw new PairingConflictError("pairing_complete_conflict");
      }
      return mapPairing(row);
    }
    const updated = await client.query(
      `
        update e2ee_pairings
        set status = 'complete_submitted',
            complete_envelope = $2,
            updated_at = now()
        where pair_id = $1
        returning *
      `,
      [complete.pairId, JSON.stringify(complete)]
    );
    return mapPairing(updated.rows[0]);
  });
}

export async function claimNextPairingComplete(input: {
  runnerId: string;
}): Promise<PairingRow | undefined> {
  await expireStalePairings();
  const result = await pool.query(
    `
      select *
      from e2ee_pairings
      where status = 'complete_submitted'
        and runner_id = $1
        and expires_at > now()
      order by updated_at
      limit 1
    `,
    [input.runnerId]
  );
  return result.rows[0] ? mapPairing(result.rows[0]) : undefined;
}

export async function publishPairingAck(input: {
  runnerId: string;
  ack: E2eePairingAck;
}): Promise<PairingRow> {
  const ack = e2eePairingAckSchema.parse(input.ack);
  return inTransaction(async (client) => {
    const selected = await client.query(
      `
        select *
        from e2ee_pairings
        where pair_id = $1
        for update
      `,
      [ack.pairId]
    );
    const row = selected.rows[0];
    if (!row) throw new PairingConflictError("pairing_not_found");
    if (row.runner_id !== input.runnerId) {
      throw new PairingConflictError("pairing_runner_mismatch");
    }
    if (row.status !== "complete_submitted" && row.status !== "paired") {
      throw new PairingConflictError("pairing_status_invalid");
    }
    const status = ack.status === "paired" ? "paired" : "rejected";
    const updated = await client.query(
      `
        update e2ee_pairings
        set status = $2,
            ack_envelope = $3,
            updated_at = now()
        where pair_id = $1
        returning *
      `,
      [ack.pairId, status, JSON.stringify(ack)]
    );

    if (ack.status === "paired") {
      const start = parseStoredPairingStart(row.start_envelope);
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
          "secure-web"
        ]
      );
    }
    return mapPairing(updated.rows[0]);
  });
}

export async function listDevicesForUser(userId: string): Promise<E2eeDeviceRecord[]> {
  const result = await pool.query(
    `
      select *
      from e2ee_devices
      where user_id = $1
      order by paired_at desc
    `,
    [userId]
  );
  return result.rows.map(mapDevice);
}

export async function revokeDeviceForUser(input: {
  userId: string;
  clientId: string;
}): Promise<E2eeDeviceRecord | undefined> {
  const result = await pool.query(
    `
      update e2ee_devices
      set revoked_at = coalesce(revoked_at, now()), updated_at = now()
      where user_id = $1 and client_id = $2
      returning *
    `,
    [input.userId, input.clientId]
  );
  return result.rows[0] ? mapDevice(result.rows[0]) : undefined;
}

export async function listPendingRevocations(runnerId: string) {
  const result = await pool.query(
    `
      select client_id, revoked_at
      from e2ee_devices
      where runner_id = $1
        and revoked_at is not null
        and runner_revoked_at is null
      order by revoked_at
    `,
    [runnerId]
  );
  return result.rows.map((row) => ({
    clientId: row.client_id as string,
    revokedAt: row.revoked_at.toISOString() as string
  }));
}

export async function markRunnerRevoked(input: {
  runnerId: string;
  clientId: string;
}) {
  await pool.query(
    `
      update e2ee_devices
      set runner_revoked_at = now(), updated_at = now()
      where runner_id = $1 and client_id = $2
    `,
    [input.runnerId, input.clientId]
  );
}

async function expireStalePairings() {
  await pool.query(
    `
      update e2ee_pairings
      set status = 'expired', updated_at = now()
      where status in ('pending_start', 'offer_ready', 'complete_submitted')
        and expires_at <= now()
    `
  );
}
