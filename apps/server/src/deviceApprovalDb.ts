import type { PoolClient, QueryResultRow } from "pg";
import {
  e2eeDeviceApprovalDecisionSchema,
  e2eeDeviceApprovalRequestSchema,
  e2eeDeviceApprovalResultSchema,
  type E2eeDeviceApprovalDecision,
  type E2eeDeviceApprovalRequest,
  type E2eeDeviceApprovalResult
} from "@cursor-gateway/shared";
import { pool } from "./db.js";

export type DeviceApprovalStatus = "requested" | "decided" | "paired" | "rejected" | "expired";

export class DeviceApprovalConflictError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "DeviceApprovalConflictError";
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

export type DeviceApprovalRow = {
  approvalId: string;
  userId: string;
  status: DeviceApprovalStatus;
  request: E2eeDeviceApprovalRequest;
  decision: E2eeDeviceApprovalDecision | null;
  result: E2eeDeviceApprovalResult | null;
  runnerId: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
};

function mapRow(row: QueryResultRow): DeviceApprovalRow {
  return {
    approvalId: row.approval_id,
    userId: row.user_id,
    status: row.status as DeviceApprovalStatus,
    request: e2eeDeviceApprovalRequestSchema.parse(row.request_envelope),
    decision: row.decision_envelope
      ? e2eeDeviceApprovalDecisionSchema.parse(row.decision_envelope)
      : null,
    result: row.result_envelope
      ? e2eeDeviceApprovalResultSchema.parse(row.result_envelope)
      : null,
    runnerId: row.runner_id ?? null,
    expiresAt: row.expires_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

async function expireStale() {
  await pool.query(
    `
      update e2ee_device_approvals
      set status = 'expired', updated_at = now()
      where status in ('requested', 'decided')
        and expires_at <= now()
    `
  );
}

export async function createDeviceApprovalRequest(input: {
  userId: string;
  request: E2eeDeviceApprovalRequest;
  ttlSeconds: number;
}): Promise<DeviceApprovalRow> {
  const request = e2eeDeviceApprovalRequestSchema.parse(input.request);
  const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000);
  try {
    const result = await pool.query(
      `
        insert into e2ee_device_approvals (
          approval_id, user_id, status, request_envelope, expires_at
        )
        values ($1, $2, 'requested', $3, $4)
        returning *
      `,
      [request.approvalId, input.userId, JSON.stringify(request), expiresAt.toISOString()]
    );
    return mapRow(result.rows[0]);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "23505"
    ) {
      throw new DeviceApprovalConflictError("approval_id_conflict");
    }
    throw error;
  }
}

export async function listPendingDeviceApprovalsForUser(
  userId: string
): Promise<DeviceApprovalRow[]> {
  await expireStale();
  const result = await pool.query(
    `
      select *
      from e2ee_device_approvals
      where user_id = $1 and status = 'requested' and expires_at > now()
      order by created_at
    `,
    [userId]
  );
  return result.rows.map(mapRow);
}

export async function getDeviceApprovalForUser(
  approvalId: string,
  userId: string
): Promise<DeviceApprovalRow | undefined> {
  await expireStale();
  const result = await pool.query(
    `select * from e2ee_device_approvals where approval_id = $1 and user_id = $2`,
    [approvalId, userId]
  );
  return result.rows[0] ? mapRow(result.rows[0]) : undefined;
}

export async function submitDeviceApprovalDecision(input: {
  userId: string;
  runnerId: string;
  decision: E2eeDeviceApprovalDecision;
}): Promise<DeviceApprovalRow> {
  const decision = e2eeDeviceApprovalDecisionSchema.parse(input.decision);
  return inTransaction(async (client) => {
    const selected = await client.query(
      `select * from e2ee_device_approvals where approval_id = $1 and user_id = $2 for update`,
      [decision.approvalId, input.userId]
    );
    const row = selected.rows[0];
    if (!row) throw new DeviceApprovalConflictError("approval_not_found");
    if (row.expires_at.getTime() <= Date.now()) {
      throw new DeviceApprovalConflictError("approval_expired");
    }
    if (row.status !== "requested" && row.status !== "decided") {
      throw new DeviceApprovalConflictError("approval_status_invalid");
    }
    if (row.decision_envelope) {
      const existing = e2eeDeviceApprovalDecisionSchema.parse(row.decision_envelope);
      if (JSON.stringify(existing) !== JSON.stringify(decision)) {
        throw new DeviceApprovalConflictError("approval_decision_conflict");
      }
      return mapRow(row);
    }
    const updated = await client.query(
      `
        update e2ee_device_approvals
        set status = 'decided', decision_envelope = $2, runner_id = $3, updated_at = now()
        where approval_id = $1
        returning *
      `,
      [decision.approvalId, JSON.stringify(decision), input.runnerId]
    );
    return mapRow(updated.rows[0]);
  });
}

export async function claimNextDeviceApprovalDecision(input: {
  runnerId: string;
}): Promise<DeviceApprovalRow | undefined> {
  await expireStale();
  return inTransaction(async (client) => {
    const result = await client.query(
      `
        select *
        from e2ee_device_approvals
        where status = 'decided' and runner_id = $1 and expires_at > now()
        order by updated_at
        for update skip locked
        limit 1
      `,
      [input.runnerId]
    );
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  });
}

export async function publishDeviceApprovalResult(input: {
  runnerId: string;
  result: E2eeDeviceApprovalResult;
}): Promise<DeviceApprovalRow> {
  const result = e2eeDeviceApprovalResultSchema.parse(input.result);
  return inTransaction(async (client) => {
    const selected = await client.query(
      `select * from e2ee_device_approvals where approval_id = $1 for update`,
      [result.approvalId]
    );
    const row = selected.rows[0];
    if (!row) throw new DeviceApprovalConflictError("approval_not_found");
    if (row.runner_id !== input.runnerId) {
      throw new DeviceApprovalConflictError("approval_runner_mismatch");
    }
    if (row.status !== "decided" && row.status !== "paired" && row.status !== "rejected") {
      throw new DeviceApprovalConflictError("approval_status_invalid");
    }
    const updated = await client.query(
      `
        update e2ee_device_approvals
        set status = $2, result_envelope = $3, updated_at = now()
        where approval_id = $1
        returning *
      `,
      [result.approvalId, result.status, JSON.stringify(result)]
    );

    if (result.status === "paired") {
      const request = e2eeDeviceApprovalRequestSchema.parse(row.request_envelope);
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
          request.newClientId,
          row.user_id,
          input.runnerId,
          JSON.stringify(request.newSigningKey),
          JSON.stringify(request.newEncryptionKey),
          "secure-web-device-approval"
        ]
      );
    }
    return mapRow(updated.rows[0]);
  });
}
