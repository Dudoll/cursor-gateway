/**
 * cs-relay-v1 ciphertext history + account KEK store (relay-P2).
 */
import type { E2eeCiphertext } from "@cursor-gateway/shared";
import { CS_RELAY_CONTENT_MODE } from "@cursor-gateway/shared";
import {
  decryptRelayMessage,
  encryptRelayMessage,
  generateRootKeyBytes,
  importRootKey,
  openDek,
  sealDek,
  zeroize,
  type KmsProvider
} from "@cursor-gateway/e2ee";
import { pool } from "./db.js";

export interface AccountKekRow {
  accountId: string;
  epoch: number;
  wrappedKek: E2eeCiphertext;
  kmsKeyId: string | null;
  createdAt: string;
}

export interface RelayMessageRow {
  id: string;
  conversationId: string;
  accountId: string;
  sequence: number;
  role: string;
  contentCiphertext: E2eeCiphertext;
  contentMode: string;
  idempotencyKey: string | null;
  createdAt: string;
  deletedAt: string | null;
}

export interface RelayConversationMeta {
  id: string;
  accountId: string;
  titleCiphertext: E2eeCiphertext | null;
  wrappedDek: E2eeCiphertext;
  kekEpoch: number;
  lastSequence: number;
  updatedAt: string;
  archivedAt: string | null;
  deletedAt: string | null;
}

async function openAccountKek(
  kms: KmsProvider,
  accountId: string,
  epoch?: number
): Promise<{ epoch: number; kek: CryptoKey; raw: Uint8Array }> {
  const result = epoch
    ? await pool.query(
        `select * from account_keks where account_id = $1 and epoch = $2`,
        [accountId, epoch]
      )
    : await pool.query(
        `select * from account_keks where account_id = $1 order by epoch desc limit 1`,
        [accountId]
      );
  if (result.rowCount === 0) throw new Error("account_kek_missing");
  const row = result.rows[0]!;
  const wrapped = row.wrapped_kek as E2eeCiphertext;
  const aad = { accountId, epoch: Number(row.epoch), kmsKeyId: kms.keyId };
  const raw = await kms.unwrap(wrapped, aad);
  try {
    const kek = await importRootKey(raw, false);
    return { epoch: Number(row.epoch), kek, raw };
  } catch (error) {
    zeroize(raw);
    throw error;
  }
}

export async function ensureAccountKek(
  kms: KmsProvider,
  accountId: string
): Promise<{ epoch: number; kek: CryptoKey }> {
  const existing = await pool.query(
    `select epoch from account_keks where account_id = $1 order by epoch desc limit 1`,
    [accountId]
  );
  if ((existing.rowCount ?? 0) > 0) {
    const opened = await openAccountKek(kms, accountId);
    const kek = opened.kek;
    zeroize(opened.raw);
    return { epoch: opened.epoch, kek };
  }
  const raw = generateRootKeyBytes();
  try {
    const aad = { accountId, epoch: 1, kmsKeyId: kms.keyId };
    const wrapped = await kms.wrap(raw, aad);
    await pool.query(
      `insert into account_keks (account_id, epoch, wrapped_kek, kms_key_id, created_at)
       values ($1, 1, $2::jsonb, $3, now())
       on conflict (account_id, epoch) do nothing`,
      [accountId, JSON.stringify(wrapped), kms.keyId]
    );
    await pool.query(
      `insert into audit_logs (event_type, details)
       values ('cs_relay_kek_create', $1::jsonb)`,
      [JSON.stringify({ accountId, epoch: 1, kmsKeyId: kms.keyId })]
    );
    const kek = await importRootKey(raw, false);
    return { epoch: 1, kek };
  } finally {
    zeroize(raw);
  }
}

export async function bumpAccountKekEpoch(
  kms: KmsProvider,
  accountId: string
): Promise<number> {
  const current = await openAccountKek(kms, accountId);
  const nextEpoch = current.epoch + 1;
  zeroize(current.raw);
  const raw = generateRootKeyBytes();
  try {
    const aad = { accountId, epoch: nextEpoch, kmsKeyId: kms.keyId };
    const wrapped = await kms.wrap(raw, aad);
    await pool.query(
      `insert into account_keks (account_id, epoch, wrapped_kek, kms_key_id, created_at)
       values ($1, $2, $3::jsonb, $4, now())`,
      [accountId, nextEpoch, JSON.stringify(wrapped), kms.keyId]
    );
    await pool.query(
      `insert into audit_logs (event_type, details)
       values ('cs_relay_kek_bump', $1::jsonb)`,
      [JSON.stringify({ accountId, epoch: nextEpoch, kmsKeyId: kms.keyId })]
    );
    return nextEpoch;
  } finally {
    zeroize(raw);
  }
}

async function ensureConversationDek(input: {
  kms: KmsProvider;
  accountId: string;
  conversationId: string;
  title?: string | null;
}): Promise<{ dek: CryptoKey; kekEpoch: number }> {
  const existing = await pool.query(
    `select wrapped_dek, kek_epoch from conversations where id = $1 and account_id = $2`,
    [input.conversationId, input.accountId]
  );
  if ((existing.rowCount ?? 0) > 0 && existing.rows[0]?.wrapped_dek) {
    const kekEpoch = Number(existing.rows[0].kek_epoch);
    const { kek, raw } = await openAccountKek(input.kms, input.accountId, kekEpoch);
    try {
      const dekBytes = await openDek(kek, existing.rows[0].wrapped_dek as E2eeCiphertext, {
        accountId: input.accountId,
        conversationId: input.conversationId,
        kekEpoch
      });
      try {
        return { dek: await importRootKey(dekBytes, false), kekEpoch };
      } finally {
        zeroize(dekBytes);
      }
    } finally {
      zeroize(raw);
    }
  }

  const { epoch, kek } = await ensureAccountKek(input.kms, input.accountId);
  const dekBytes = generateRootKeyBytes();
  try {
    const wrappedDek = await sealDek(kek, dekBytes, {
      accountId: input.accountId,
      conversationId: input.conversationId,
      kekEpoch: epoch
    });
    let titleCiphertext: E2eeCiphertext | null = null;
    if (input.title) {
      const dek = await importRootKey(dekBytes, false);
      titleCiphertext = await encryptRelayMessage(
        dek,
        { conversationId: input.conversationId, field: "title" },
        { role: "system", text: input.title }
      );
    }
    await pool.query(
      `update conversations set
         account_id = $2,
         content_mode = $3,
         wrapped_dek = $4::jsonb,
         kek_epoch = $5,
         encrypted_title = coalesce($6::jsonb, encrypted_title),
         title = null,
         updated_at = now()
       where id = $1`,
      [
        input.conversationId,
        input.accountId,
        CS_RELAY_CONTENT_MODE,
        JSON.stringify(wrappedDek),
        epoch,
        titleCiphertext ? JSON.stringify(titleCiphertext) : null
      ]
    );
    return { dek: await importRootKey(dekBytes, false), kekEpoch: epoch };
  } finally {
    zeroize(dekBytes);
  }
}

export async function ensureRelayConversation(input: {
  kms: KmsProvider;
  accountId: string;
  conversationId?: string;
  workspaceId: string;
  userId: string;
  title?: string | null;
}): Promise<{ conversationId: string; dek: CryptoKey; kekEpoch: number }> {
  let conversationId = input.conversationId;
  if (!conversationId) {
    // Insert as plaintext first so cs-relay-v1 empty-column constraint is not
    // violated before wrapped_dek exists; ensureConversationDek flips the mode.
    const created = await pool.query(
      `insert into conversations (user_id, workspace_id, account_id, content_mode, title)
       values ($1, $2, $3, 'plaintext', null)
       returning id`,
      [input.userId, input.workspaceId, input.accountId]
    );
    conversationId = String(created.rows[0]!.id);
  }
  const { dek, kekEpoch } = await ensureConversationDek({
    kms: input.kms,
    accountId: input.accountId,
    conversationId,
    title: input.title ?? null
  });
  return { conversationId, dek, kekEpoch };
}

export async function appendRelayMessage(input: {
  kms: KmsProvider;
  accountId: string;
  conversationId: string;
  role: "user" | "assistant";
  text: string;
  idempotencyKey?: string | null;
  expectedSequence?: number | null;
}): Promise<{ sequence: number; id: string }> {
  if (input.idempotencyKey) {
    const existing = await pool.query(
      `select id, sequence from cs_relay_messages
       where account_id = $1 and idempotency_key = $2`,
      [input.accountId, input.idempotencyKey]
    );
    if ((existing.rowCount ?? 0) > 0) {
      return {
        id: String(existing.rows[0]!.id),
        sequence: Number(existing.rows[0]!.sequence)
      };
    }
  }

  const { dek } = await ensureConversationDek({
    kms: input.kms,
    accountId: input.accountId,
    conversationId: input.conversationId
  });

  const seqResult = await pool.query(
    `select coalesce(max(sequence), 0) as max_seq
     from cs_relay_messages where conversation_id = $1 and deleted_at is null`,
    [input.conversationId]
  );
  const nextSeq = Number(seqResult.rows[0]!.max_seq) + 1;
  if (
    input.expectedSequence != null &&
    input.expectedSequence !== nextSeq - 1 &&
    input.expectedSequence !== nextSeq
  ) {
    const err = new Error("sequence_conflict");
    (err as Error & { latestSequence: number }).latestSequence = nextSeq - 1;
    throw err;
  }

  const ciphertext = await encryptRelayMessage(
    dek,
    {
      conversationId: input.conversationId,
      sequence: nextSeq,
      role: input.role
    },
    { role: input.role, text: input.text }
  );

  const inserted = await pool.query(
    `insert into cs_relay_messages (
       id, conversation_id, account_id, sequence, role,
       content_ciphertext, content_mode, idempotency_key, created_at
     ) values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,now())
     on conflict do nothing
     returning id, sequence`,
    [
      crypto.randomUUID(),
      input.conversationId,
      input.accountId,
      nextSeq,
      input.role,
      JSON.stringify(ciphertext),
      CS_RELAY_CONTENT_MODE,
      input.idempotencyKey ?? null
    ]
  );

  if ((inserted.rowCount ?? 0) === 0 && input.idempotencyKey) {
    const again = await pool.query(
      `select id, sequence from cs_relay_messages
       where account_id = $1 and idempotency_key = $2`,
      [input.accountId, input.idempotencyKey]
    );
    return {
      id: String(again.rows[0]!.id),
      sequence: Number(again.rows[0]!.sequence)
    };
  }

  await pool.query(`update conversations set updated_at = now() where id = $1`, [
    input.conversationId
  ]);

  return {
    id: String(inserted.rows[0]!.id),
    sequence: Number(inserted.rows[0]!.sequence)
  };
}

export async function listRelayConversations(input: {
  accountId: string;
  limit: number;
  cursor?: string | null;
  sinceUpdatedAt?: string | null;
}): Promise<{
  conversations: Array<{
    id: string;
    updatedAt: string;
    lastSequence: number;
    archived: boolean;
    deleted: boolean;
    titleCiphertext: E2eeCiphertext | null;
    wrappedDek: E2eeCiphertext | null;
    kekEpoch: number | null;
  }>;
  nextCursor: string | null;
}> {
  const limit = Math.min(Math.max(input.limit, 1), 200);
  let updatedAt: string | null = null;
  let id: string | null = null;
  if (input.cursor) {
    try {
      const parsed = JSON.parse(
        Buffer.from(input.cursor, "base64url").toString("utf8")
      ) as { updatedAt?: string; id?: string };
      updatedAt = parsed.updatedAt ?? null;
      id = parsed.id ?? null;
    } catch {
      updatedAt = null;
      id = null;
    }
  }
  const result = await pool.query(
    `select c.id, c.updated_at, c.encrypted_title, c.wrapped_dek, c.kek_epoch,
            c.deleted_at, c.archived_at,
            coalesce((
              select max(m.sequence) from cs_relay_messages m
              where m.conversation_id = c.id and m.deleted_at is null
            ), 0) as last_sequence
     from conversations c
     where c.account_id = $1
       and c.content_mode = $2
       and ($3::timestamptz is null or c.updated_at > $3::timestamptz)
       and (
         $4::timestamptz is null
         or (c.updated_at, c.id) < ($4::timestamptz, $5::uuid)
       )
     order by c.updated_at desc, c.id desc
     limit $6`,
    [
      input.accountId,
      CS_RELAY_CONTENT_MODE,
      input.sinceUpdatedAt ?? null,
      updatedAt,
      id,
      limit + 1
    ]
  );
  const rows = result.rows.slice(0, limit);
  const conversations = rows.map((row) => ({
    id: String(row.id),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
    lastSequence: Number(row.last_sequence),
    archived: Boolean(row.archived_at),
    deleted: Boolean(row.deleted_at),
    titleCiphertext: (row.encrypted_title as E2eeCiphertext | null) ?? null,
    wrappedDek: (row.wrapped_dek as E2eeCiphertext | null) ?? null,
    kekEpoch: row.kek_epoch == null ? null : Number(row.kek_epoch)
  }));
  let nextCursor: string | null = null;
  if (result.rows.length > limit) {
    const last = conversations[conversations.length - 1]!;
    nextCursor = Buffer.from(
      JSON.stringify({ updatedAt: last.updatedAt, id: last.id }),
      "utf8"
    ).toString("base64url");
  }
  return { conversations, nextCursor };
}

export async function listRelayMessages(input: {
  kms: KmsProvider;
  accountId: string;
  conversationId: string;
  sinceSequence?: number | null;
  limit: number;
  cursor?: string | null;
}): Promise<{
  messages: Array<{
    sequence: number;
    role: string;
    content: string;
    createdAt: string;
  }>;
  nextCursor: string | null;
  latestSequence: number;
}> {
  const owned = await pool.query(
    `select id, wrapped_dek, kek_epoch from conversations
     where id = $1 and account_id = $2 and content_mode = $3`,
    [input.conversationId, input.accountId, CS_RELAY_CONTENT_MODE]
  );
  if ((owned.rowCount ?? 0) === 0) throw new Error("cross_account_denied");
  const row = owned.rows[0]!;
  if (!row.wrapped_dek) throw new Error("conversation_dek_missing");

  const kekEpoch = Number(row.kek_epoch);
  const { kek, raw } = await openAccountKek(input.kms, input.accountId, kekEpoch);
  let dek: CryptoKey;
  try {
    const dekBytes = await openDek(kek, row.wrapped_dek as E2eeCiphertext, {
      accountId: input.accountId,
      conversationId: input.conversationId,
      kekEpoch
    });
    try {
      dek = await importRootKey(dekBytes, false);
    } finally {
      zeroize(dekBytes);
    }
  } finally {
    zeroize(raw);
  }

  let afterSeq = input.sinceSequence ?? 0;
  if (input.cursor) {
    try {
      afterSeq = Math.max(
        afterSeq,
        Number(
          JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")).sequence ?? 0
        )
      );
    } catch {
      // ignore bad cursor
    }
  }
  const limit = Math.min(Math.max(input.limit, 1), 200);
  const msgs = await pool.query(
    `select sequence, role, content_ciphertext, created_at
     from cs_relay_messages
     where conversation_id = $1 and account_id = $2 and deleted_at is null
       and sequence > $3
     order by sequence asc
     limit $4`,
    [input.conversationId, input.accountId, afterSeq, limit + 1]
  );
  const latest = await pool.query(
    `select coalesce(max(sequence), 0) as latest
     from cs_relay_messages where conversation_id = $1 and deleted_at is null`,
    [input.conversationId]
  );
  const slice = msgs.rows.slice(0, limit);
  const messages = [];
  for (const m of slice) {
    const sequence = Number(m.sequence);
    const plain = await decryptRelayMessage<{ role: string; text: string }>(
      dek,
      {
        conversationId: input.conversationId,
        sequence,
        role: String(m.role)
      },
      m.content_ciphertext as E2eeCiphertext
    );
    messages.push({
      sequence,
      role: String(m.role),
      content: plain.text,
      createdAt: new Date(String(m.created_at)).toISOString()
    });
  }
  let nextCursor: string | null = null;
  if (msgs.rows.length > limit) {
    const last = messages[messages.length - 1]!;
    nextCursor = Buffer.from(JSON.stringify({ sequence: last.sequence }), "utf8").toString(
      "base64url"
    );
  }
  return {
    messages,
    nextCursor,
    latestSequence: Number(latest.rows[0]!.latest)
  };
}

export async function softDeleteRelayConversation(input: {
  accountId: string;
  conversationId: string;
}): Promise<boolean> {
  const result = await pool.query(
    `update conversations set deleted_at = now(), updated_at = now()
     where id = $1 and account_id = $2 and deleted_at is null`,
    [input.conversationId, input.accountId]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function archiveRelayConversation(input: {
  accountId: string;
  conversationId: string;
}): Promise<boolean> {
  const result = await pool.query(
    `update conversations set archived_at = now(), updated_at = now()
     where id = $1 and account_id = $2 and archived_at is null`,
    [input.conversationId, input.accountId]
  );
  return (result.rowCount ?? 0) > 0;
}
