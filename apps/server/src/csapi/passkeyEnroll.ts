/**
 * CS-side WebAuthn credential + enroll challenge store for cg-mitm passkey enroll.
 * Full UV + challenge verification via @simplewebauthn/server.
 */
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type AuthenticatorTransportFuture,
  type VerifiedAuthenticationResponse
} from "@simplewebauthn/server";
import { pool } from "../db.js";

export type CgPasskeyCredential = {
  credentialId: string;
  accountId: string;
  publicKey: Uint8Array;
  counter: number;
  transports: string[];
};

export async function upsertCgPasskeyCredential(input: {
  credentialId: string;
  accountId: string;
  publicKey: Uint8Array;
  counter?: number;
  transports?: string[];
}): Promise<void> {
  await pool.query(
    `insert into cg_passkey_credentials (
       credential_id, account_id, public_key, counter, transports, created_at, updated_at
     ) values ($1,$2,$3,$4,$5::jsonb,now(),now())
     on conflict (credential_id) do update set
       account_id = excluded.account_id,
       public_key = excluded.public_key,
       counter = greatest(cg_passkey_credentials.counter, excluded.counter),
       transports = excluded.transports,
       updated_at = now(),
       revoked_at = null`,
    [
      input.credentialId,
      input.accountId,
      Buffer.from(input.publicKey),
      input.counter ?? 0,
      JSON.stringify(input.transports ?? [])
    ]
  );
}

export async function getCgPasskeyCredential(
  credentialId: string
): Promise<CgPasskeyCredential | null> {
  const result = await pool.query(
    `select credential_id, account_id, public_key, counter, transports
     from cg_passkey_credentials
     where credential_id = $1 and revoked_at is null`,
    [credentialId]
  );
  if (result.rowCount === 0) return null;
  const row = result.rows[0]!;
  return {
    credentialId: String(row.credential_id),
    accountId: String(row.account_id),
    publicKey: new Uint8Array(row.public_key as Buffer),
    counter: Number(row.counter),
    transports: Array.isArray(row.transports) ? row.transports.map(String) : []
  };
}

export async function createCgEnrollChallenge(input: {
  accountIdHint?: string | null;
  rpId: string;
  origins: string[];
}): Promise<{ challengeId: string; options: unknown; expiresAt: string }> {
  const challengeId = crypto.randomUUID();
  const options = await generateAuthenticationOptions({
    rpID: input.rpId,
    userVerification: "required",
    timeout: 120_000
  });
  const expiresAt = new Date(Date.now() + 120_000).toISOString();
  await pool.query(
    `insert into cg_enroll_challenges (
       challenge_id, account_id_hint, challenge, rp_id, origins, expires_at, created_at
     ) values ($1,$2,$3,$4,$5::jsonb,$6,now())`,
    [
      challengeId,
      input.accountIdHint ?? null,
      options.challenge,
      input.rpId,
      JSON.stringify(input.origins),
      expiresAt
    ]
  );
  return { challengeId, options, expiresAt };
}

export async function verifyCgPasskeyAssertion(input: {
  challengeId: string;
  credentialId: string;
  assertion: Record<string, unknown>;
  expectedAccountId?: string | null;
}): Promise<{ accountId: string; verification: VerifiedAuthenticationResponse }> {
  const ch = await pool.query(
    `select * from cg_enroll_challenges
     where challenge_id = $1 and consumed_at is null and expires_at > now()`,
    [input.challengeId]
  );
  if (ch.rowCount === 0) throw new Error("enroll_passkey_challenge_invalid");
  const row = ch.rows[0]!;
  const cred = await getCgPasskeyCredential(input.credentialId);
  if (!cred) throw new Error("enroll_passkey_credential_unknown");
  if (input.expectedAccountId && cred.accountId !== input.expectedAccountId) {
    throw new Error("enroll_passkey_account_mismatch");
  }
  if (row.account_id_hint && String(row.account_id_hint) !== cred.accountId) {
    throw new Error("enroll_passkey_account_mismatch");
  }

  const origins = row.origins as string[];
  const verification = await verifyAuthenticationResponse({
    response: input.assertion as never,
    expectedChallenge: String(row.challenge),
    expectedOrigin: origins,
    expectedRPID: String(row.rp_id),
    credential: {
      id: cred.credentialId,
      publicKey: Uint8Array.from(cred.publicKey),
      counter: cred.counter,
      transports: cred.transports as AuthenticatorTransportFuture[]
    },
    requireUserVerification: true
  });
  if (!verification.verified) throw new Error("enroll_passkey_assertion_invalid");

  await pool.query(
    `update cg_enroll_challenges set consumed_at = now() where challenge_id = $1`,
    [input.challengeId]
  );
  const newCounter = verification.authenticationInfo.newCounter;
  await pool.query(
    `update cg_passkey_credentials set counter = $2, updated_at = now() where credential_id = $1`,
    [cred.credentialId, newCounter]
  );
  return { accountId: cred.accountId, verification };
}
