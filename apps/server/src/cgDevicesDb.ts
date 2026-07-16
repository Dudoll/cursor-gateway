/**
 * Persistent cg-mitm device registry (relay-P1).
 * Replaces the in-memory deviceCerts Map for account-bound devices.
 */
import type { CgDeviceCert } from "@cursor-gateway/shared";
import { pool } from "./db.js";

export type CgDeviceStatus = "active" | "revoked";

export interface CgDeviceRow {
  deviceId: string;
  accountId: string;
  signingFingerprint: string;
  encryptionFingerprint: string;
  deviceCert: CgDeviceCert;
  epoch: number;
  label: string | null;
  status: CgDeviceStatus;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

function mapRow(row: Record<string, unknown>): CgDeviceRow {
  return {
    deviceId: String(row.device_id),
    accountId: String(row.account_id),
    signingFingerprint: String(row.signing_fingerprint),
    encryptionFingerprint: String(row.encryption_fingerprint),
    deviceCert: row.device_cert as CgDeviceCert,
    epoch: Number(row.epoch),
    label: row.label == null ? null : String(row.label),
    status: row.status === "revoked" ? "revoked" : "active",
    createdAt: new Date(String(row.created_at)).toISOString(),
    lastSeenAt: row.last_seen_at ? new Date(String(row.last_seen_at)).toISOString() : null,
    revokedAt: row.revoked_at ? new Date(String(row.revoked_at)).toISOString() : null
  };
}

export async function upsertCgDevice(input: {
  deviceId: string;
  accountId: string;
  signingFingerprint: string;
  encryptionFingerprint: string;
  deviceCert: CgDeviceCert;
  epoch: number;
  label: string | null;
}): Promise<CgDeviceRow> {
  const result = await pool.query(
    `insert into cg_devices (
       device_id, account_id, signing_fingerprint, encryption_fingerprint,
       device_cert, epoch, label, status, created_at, last_seen_at
     ) values ($1,$2,$3,$4,$5::jsonb,$6,$7,'active',now(),now())
     on conflict (device_id) do update set
       account_id = excluded.account_id,
       signing_fingerprint = excluded.signing_fingerprint,
       encryption_fingerprint = excluded.encryption_fingerprint,
       device_cert = excluded.device_cert,
       epoch = excluded.epoch,
       label = excluded.label,
       status = 'active',
       revoked_at = null,
       last_seen_at = now()
     returning *`,
    [
      input.deviceId,
      input.accountId,
      input.signingFingerprint,
      input.encryptionFingerprint,
      JSON.stringify(input.deviceCert),
      input.epoch,
      input.label
    ]
  );
  return mapRow(result.rows[0]!);
}

export async function getCgDevice(deviceId: string): Promise<CgDeviceRow | null> {
  const result = await pool.query(`select * from cg_devices where device_id = $1`, [deviceId]);
  if (result.rowCount === 0) return null;
  return mapRow(result.rows[0]!);
}

export async function touchCgDevice(deviceId: string): Promise<void> {
  await pool.query(`update cg_devices set last_seen_at = now() where device_id = $1`, [deviceId]);
}

export async function revokeCgDevice(input: {
  accountId: string;
  targetDeviceId: string;
}): Promise<CgDeviceRow | null> {
  const result = await pool.query(
    `update cg_devices
     set status = 'revoked', revoked_at = now()
     where device_id = $1 and account_id = $2 and status = 'active'
     returning *`,
    [input.targetDeviceId, input.accountId]
  );
  if (result.rowCount === 0) return null;
  return mapRow(result.rows[0]!);
}

export async function listActiveCgDevices(accountId: string): Promise<CgDeviceRow[]> {
  const result = await pool.query(
    `select * from cg_devices where account_id = $1 and status = 'active' order by created_at asc`,
    [accountId]
  );
  return result.rows.map(mapRow);
}

/** Short-TTL active-device cache (≤30s) so revoke invalidates in-flight sessions quickly. */
export class CgDeviceStatusCache {
  private readonly cache = new Map<string, { status: CgDeviceStatus; accountId: string; expiresAt: number }>();
  constructor(private readonly ttlMs = 30_000) {}

  invalidate(deviceId: string): void {
    this.cache.delete(deviceId);
  }

  async requireActive(deviceId: string): Promise<{ accountId: string; cert: CgDeviceCert }> {
    const now = Date.now();
    const hit = this.cache.get(deviceId);
    if (hit && hit.expiresAt > now) {
      if (hit.status !== "active") throw new Error("device_revoked");
      const row = await getCgDevice(deviceId);
      if (!row || row.status !== "active") {
        this.cache.set(deviceId, { status: "revoked", accountId: hit.accountId, expiresAt: now + this.ttlMs });
        throw new Error("device_revoked");
      }
      return { accountId: row.accountId, cert: row.deviceCert };
    }
    const row = await getCgDevice(deviceId);
    if (!row) throw new Error("device_not_enrolled");
    this.cache.set(deviceId, {
      status: row.status,
      accountId: row.accountId,
      expiresAt: now + this.ttlMs
    });
    if (row.status !== "active") throw new Error("device_revoked");
    return { accountId: row.accountId, cert: row.deviceCert };
  }
}
