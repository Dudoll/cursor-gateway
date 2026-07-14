import type { PoolClient, QueryResultRow } from "pg";
import {
  e2eeCsAuthGrantSchema,
  e2eeCsAuthIntentSchema,
  type E2eeCsAuthGrant,
  type E2eeCsAuthIntent,
  type E2eeCsAuthStatus
} from "@cursor-gateway/shared";
import { pool } from "./db.js";

export class CsAuthConflictError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "CsAuthConflictError";
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

export type CsAuthRow = {
  authId: string;
  userId: string;
  status: E2eeCsAuthStatus;
  intent: E2eeCsAuthIntent;
  grant: E2eeCsAuthGrant | null;
  runnerId: string | null;
  secureClientId: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
};

function mapRow(row: QueryResultRow): CsAuthRow {
  return {
    authId: row.auth_id,
    userId: row.user_id,
    status: row.status as E2eeCsAuthStatus,
    intent: e2eeCsAuthIntentSchema.parse(row.intent_envelope),
    grant: row.grant_envelope ? e2eeCsAuthGrantSchema.parse(row.grant_envelope) : null,
    runnerId: row.runner_id ?? null,
    secureClientId: row.secure_client_id ?? null,
    expiresAt: row.expires_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

async function expireStale() {
  await pool.query(
    `
      update e2ee_cs_auth
      set status = 'expired', updated_at = now()
      where status in ('intent_ready', 'pending_runner', 'granted')
        and expires_at <= now()
    `
  );
}

export async function createCsAuthIntent(input: {
  userId: string;
  intent: E2eeCsAuthIntent;
  ttlSeconds: number;
}): Promise<CsAuthRow> {
  const intent = e2eeCsAuthIntentSchema.parse(input.intent);
  const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000);
  try {
    const result = await pool.query(
      `
        insert into e2ee_cs_auth (
          auth_id, user_id, status, intent_envelope, expires_at
        )
        values ($1, $2, 'intent_ready', $3, $4)
        returning *
      `,
      [intent.authId, input.userId, JSON.stringify(intent), expiresAt.toISOString()]
    );
    return mapRow(result.rows[0]);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "23505"
    ) {
      throw new CsAuthConflictError("auth_id_conflict");
    }
    throw error;
  }
}

export async function getCsAuthForUser(
  authId: string,
  userId: string
): Promise<CsAuthRow | undefined> {
  await expireStale();
  const result = await pool.query(
    `
      select *
      from e2ee_cs_auth
      where auth_id = $1 and user_id = $2
    `,
    [authId, userId]
  );
  return result.rows[0] ? mapRow(result.rows[0]) : undefined;
}

/** Secure Web marks the intent ready for Runner claim. */
export async function markCsAuthPendingRunner(input: {
  authId: string;
  userId: string;
  secureClientId: string;
  expected: {
    challenge: string;
    state: string;
    returnOrigin: string;
    signingFingerprint: string;
    encryptionFingerprint: string;
    clientId: string;
  };
}): Promise<CsAuthRow> {
  await expireStale();
  return inTransaction(async (client) => {
    const selected = await client.query(
      `
        select *
        from e2ee_cs_auth
        where auth_id = $1
        for update
      `,
      [input.authId]
    );
    const row = selected.rows[0];
    if (!row) throw new CsAuthConflictError("auth_not_found");
    if (row.user_id !== input.userId) throw new CsAuthConflictError("auth_user_mismatch");
    if (row.status !== "intent_ready" && row.status !== "pending_runner") {
      throw new CsAuthConflictError("auth_status_invalid");
    }
    if (row.expires_at <= new Date()) {
      await client.query(
        `update e2ee_cs_auth set status = 'expired', updated_at = now() where auth_id = $1`,
        [input.authId]
      );
      throw new CsAuthConflictError("auth_expired");
    }
    const intent = e2eeCsAuthIntentSchema.parse(row.intent_envelope);
    if (intent.clientId !== input.expected.clientId) {
      throw new CsAuthConflictError("client_id_mismatch");
    }
    if (intent.challenge !== input.expected.challenge) {
      throw new CsAuthConflictError("challenge_mismatch");
    }
    if (intent.state !== input.expected.state) {
      throw new CsAuthConflictError("state_mismatch");
    }
    if (intent.returnOrigin !== input.expected.returnOrigin) {
      throw new CsAuthConflictError("return_origin_mismatch");
    }
    if (intent.signingKey.fingerprint !== input.expected.signingFingerprint) {
      throw new CsAuthConflictError("signing_fingerprint_mismatch");
    }
    if (intent.encryptionKey.fingerprint !== input.expected.encryptionFingerprint) {
      throw new CsAuthConflictError("encryption_fingerprint_mismatch");
    }
    const updated = await client.query(
      `
        update e2ee_cs_auth
        set status = 'pending_runner',
            secure_client_id = $2,
            updated_at = now()
        where auth_id = $1
        returning *
      `,
      [input.authId, input.secureClientId]
    );
    return mapRow(updated.rows[0]);
  });
}

export async function claimNextCsAuth(input: {
  runnerId: string;
}): Promise<CsAuthRow | undefined> {
  await expireStale();
  const result = await pool.query(
    `
      update e2ee_cs_auth
      set runner_id = $1,
          updated_at = now()
      where auth_id = (
        select auth_id
        from e2ee_cs_auth
        where status = 'pending_runner'
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

export async function publishCsAuthGrant(input: {
  runnerId: string;
  grant: E2eeCsAuthGrant;
}): Promise<CsAuthRow> {
  const grant = e2eeCsAuthGrantSchema.parse(input.grant);
  return inTransaction(async (client) => {
    const selected = await client.query(
      `
        select *
        from e2ee_cs_auth
        where auth_id = $1
        for update
      `,
      [grant.authId]
    );
    const row = selected.rows[0];
    if (!row) throw new CsAuthConflictError("auth_not_found");
    if (row.runner_id !== input.runnerId) {
      throw new CsAuthConflictError("auth_runner_mismatch");
    }
    if (row.status !== "pending_runner" && row.status !== "granted") {
      throw new CsAuthConflictError("auth_status_invalid");
    }
    const intent = e2eeCsAuthIntentSchema.parse(row.intent_envelope);
    if (
      grant.clientId !== intent.clientId ||
      grant.challenge !== intent.challenge ||
      grant.state !== intent.state ||
      grant.returnOrigin !== intent.returnOrigin ||
      grant.signingFingerprint !== intent.signingKey.fingerprint ||
      grant.encryptionFingerprint !== intent.encryptionKey.fingerprint
    ) {
      throw new CsAuthConflictError("grant_intent_mismatch");
    }
    const status = grant.status === "authorized" ? "granted" : "rejected";
    const updated = await client.query(
      `
        update e2ee_cs_auth
        set status = $2,
            grant_envelope = $3,
            updated_at = now()
        where auth_id = $1
        returning *
      `,
      [grant.authId, status, JSON.stringify(grant)]
    );

    if (grant.status === "authorized") {
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
          intent.clientId,
          row.user_id,
          input.runnerId,
          JSON.stringify(intent.signingKey),
          JSON.stringify(intent.encryptionKey),
          "cs-web"
        ]
      );
    }
    return mapRow(updated.rows[0]);
  });
}

/** One-time consume after CS locally verified the grant (anti-replay). */
export async function consumeCsAuthGrant(input: {
  authId: string;
  userId: string;
  challenge: string;
  state: string;
}): Promise<CsAuthRow> {
  await expireStale();
  return inTransaction(async (client) => {
    const selected = await client.query(
      `
        select *
        from e2ee_cs_auth
        where auth_id = $1
        for update
      `,
      [input.authId]
    );
    const row = selected.rows[0];
    if (!row) throw new CsAuthConflictError("auth_not_found");
    if (row.user_id !== input.userId) throw new CsAuthConflictError("auth_user_mismatch");
    if (row.status === "consumed") throw new CsAuthConflictError("auth_already_consumed");
    if (row.status !== "granted") throw new CsAuthConflictError("auth_status_invalid");
    if (row.expires_at <= new Date()) {
      await client.query(
        `update e2ee_cs_auth set status = 'expired', updated_at = now() where auth_id = $1`,
        [input.authId]
      );
      throw new CsAuthConflictError("auth_expired");
    }
    const intent = e2eeCsAuthIntentSchema.parse(row.intent_envelope);
    if (intent.challenge !== input.challenge || intent.state !== input.state) {
      throw new CsAuthConflictError("challenge_or_state_mismatch");
    }
    const updated = await client.query(
      `
        update e2ee_cs_auth
        set status = 'consumed', updated_at = now()
        where auth_id = $1
        returning *
      `,
      [input.authId]
    );
    return mapRow(updated.rows[0]);
  });
}
