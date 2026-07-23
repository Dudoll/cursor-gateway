import type { PoolClient, QueryResultRow } from "pg";
import {
  E2EE_PROTOCOL,
  e2eeApprovalEnvelopeSchema,
  e2eeMemoryEnvelopeSchema,
  e2eeProgressEnvelopeSchema,
  e2eeResultEnvelopeSchema,
  e2eeRunRequestEnvelopeSchema,
  type E2eeApprovalEnvelope,
  type E2eeConversationRecord,
  type E2eeMemoryEnvelope,
  type E2eeMemoryRecord,
  type E2eeProgressEnvelope,
  type E2eeResultEnvelope,
  type E2eeRunRecord,
  type E2eeRunRequestEnvelope,
  type E2eeRunnerDirectoryEntry,
  type E2eeRunnerHeartbeat,
  type E2eeRunnerJob,
  type RunStatus
} from "@cursor-gateway/shared";
import { pool } from "./db.js";

const CONTENT_MODE = "e2ee-v1";
const LEASE_MINUTES = 15;
const RUNNER_ONLINE_WINDOW_MS = 3 * 60_000;

export class E2eeConflictError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "E2eeConflictError";
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

function mapRun(row: QueryResultRow): E2eeRunRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    status: row.status as RunStatus,
    model: row.model,
    workspaceId: row.workspace_id,
    allowWrites: row.allow_writes,
    request: e2eeRunRequestEnvelopeSchema.parse(row.request_envelope),
    approval: row.approval_envelope
      ? e2eeApprovalEnvelopeSchema.parse(row.approval_envelope)
      : null,
    progress: row.progress_envelope
      ? e2eeProgressEnvelopeSchema.parse(row.progress_envelope)
      : null,
    result: row.result_envelope
      ? e2eeResultEnvelopeSchema.parse(row.result_envelope)
      : null,
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    finishedAt: row.finished_at?.toISOString() ?? null,
    updatedAt: row.updated_at.toISOString()
  };
}

function mapConversation(row: QueryResultRow): E2eeConversationRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    runnerId: row.target_runner_id,
    runnerKeyId: row.runner_key_id,
    title: row.encrypted_title ?? null,
    runCount: Number(row.run_count ?? 0),
    lastRunAt: row.last_run_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function mapMemory(row: QueryResultRow): E2eeMemoryRecord {
  return {
    id: row.id,
    scope: row.scope,
    workspaceId: row.workspace_id,
    envelope: e2eeMemoryEnvelopeSchema.parse(row.content_envelope),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

export async function upsertE2eeRunner(input: E2eeRunnerHeartbeat) {
  await inTransaction(async (client) => {
    await client.query(
      `
        insert into runner_devices (
          runner_id,
          runner_version,
          protocols,
          encryption_key,
          signing_key,
          models,
          workspaces,
          last_seen_at,
          revoked_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, now(), null)
        on conflict (runner_id)
        do update set
          runner_version = excluded.runner_version,
          protocols = excluded.protocols,
          encryption_key = excluded.encryption_key,
          signing_key = excluded.signing_key,
          models = excluded.models,
          workspaces = excluded.workspaces,
          last_seen_at = now()
      `,
      [
        input.runnerId,
        input.runnerVersion,
        JSON.stringify(input.e2ee.protocols),
        JSON.stringify(input.e2ee.encryptionKey),
        JSON.stringify(input.e2ee.signingKey),
        JSON.stringify(input.models),
        JSON.stringify(input.workspaces)
      ]
    );

    for (const workspace of input.workspaces) {
      // E2EE heartbeats intentionally omit filesystem paths (gateway never learns
      // them). Do not wipe a path previously registered by a legacy runner for the
      // same workspace id — CS `/api/workspaces` still filters on path IS NOT NULL.
      await client.query(
        `
          insert into workspaces (id, label, path, writable, runner_id)
          values ($1, $2, null, $3, $4)
          on conflict (id)
          do update set
            label = excluded.label,
            path = workspaces.path,
            writable = excluded.writable,
            runner_id = excluded.runner_id,
            enabled = true
        `,
        [workspace.id, workspace.label, workspace.writable, input.runnerId]
      );
    }
  });

  return getE2eeRunner(input.runnerId);
}

export async function getE2eeRunner(
  runnerId: string
): Promise<E2eeRunnerDirectoryEntry | undefined> {
  const result = await pool.query(
    `
      select *
      from runner_devices
      where runner_id = $1 and revoked_at is null
    `,
    [runnerId]
  );
  const row = result.rows[0];
  if (!row) return undefined;
  return {
    runnerId: row.runner_id,
    runnerVersion: row.runner_version,
    models: row.models,
    workspaces: row.workspaces,
    e2ee: {
      protocols: row.protocols,
      encryptionKey: row.encryption_key,
      signingKey: row.signing_key
    },
    lastSeenAt: row.last_seen_at.toISOString(),
    online: Date.now() - row.last_seen_at.getTime() < RUNNER_ONLINE_WINDOW_MS
  } satisfies E2eeRunnerDirectoryEntry;
}

export async function listE2eeRunners(): Promise<E2eeRunnerDirectoryEntry[]> {
  const result = await pool.query(
    `
      select *
      from runner_devices
      where revoked_at is null
      order by runner_id
    `
  );
  return result.rows.map((row) => ({
    runnerId: row.runner_id,
    runnerVersion: row.runner_version,
    models: row.models,
    workspaces: row.workspaces,
    e2ee: {
      protocols: row.protocols,
      encryptionKey: row.encryption_key,
      signingKey: row.signing_key
    },
    lastSeenAt: row.last_seen_at.toISOString(),
    online: Date.now() - row.last_seen_at.getTime() < RUNNER_ONLINE_WINDOW_MS
  }));
}

export async function createE2eeRun(input: {
  userId: string;
  request: E2eeRunRequestEnvelope;
}): Promise<{ run: E2eeRunRecord; created: boolean }> {
  const request = input.request;
  if (
    request.runId !== request.messageId ||
    request.routing.model.length === 0 ||
    request.routing.workspaceId.length === 0
  ) {
    throw new E2eeConflictError("invalid_e2ee_request_identity");
  }

  return inTransaction(async (client) => {
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [
      `e2ee-run:${input.userId}:${request.runId}`
    ]);

    const existingRun = await client.query(
      `
        select *, request_envelope = $4::jsonb as same_request
        from runs
        where id = $1 and user_id = $2 and content_mode = $3
      `,
      [request.runId, input.userId, CONTENT_MODE, JSON.stringify(request)]
    );
    if (existingRun.rows[0]) {
      if (!existingRun.rows[0].same_request) {
        throw new E2eeConflictError("run_id_conflict");
      }
      return { run: mapRun(existingRun.rows[0]), created: false };
    }

    const anyRun = await client.query("select user_id from runs where id = $1", [request.runId]);
    if (anyRun.rows[0]) throw new E2eeConflictError("run_id_conflict");

    const conversationResult = await client.query(
      `
        select *
        from conversations
        where id = $1
        for update
      `,
      [request.conversationId]
    );
    const conversation = conversationResult.rows[0];
    if (conversation) {
      if (conversation.user_id !== input.userId) {
        throw new E2eeConflictError("conversation_not_found");
      }
      if (conversation.content_mode !== CONTENT_MODE) {
        throw new E2eeConflictError("conversation_encryption_downgrade");
      }
      if (
        conversation.workspace_id !== request.routing.workspaceId ||
        conversation.target_runner_id !== request.runnerId ||
        conversation.runner_key_id !== request.runnerKeyId
      ) {
        throw new E2eeConflictError("conversation_e2ee_context_mismatch");
      }
      await client.query(
        `
          update conversations
          set encrypted_title = coalesce(encrypted_title, $2::jsonb), updated_at = now()
          where id = $1
        `,
        [request.conversationId, request.title ? JSON.stringify(request.title) : null]
      );
    } else {
      await client.query(
        `
          insert into conversations (
            id,
            user_id,
            workspace_id,
            title,
            content_mode,
            target_runner_id,
            runner_key_id,
            encrypted_title
          )
          values ($1, $2, $3, null, $4, $5, $6, $7)
        `,
        [
          request.conversationId,
          input.userId,
          request.routing.workspaceId,
          CONTENT_MODE,
          request.runnerId,
          request.runnerKeyId,
          request.title ? JSON.stringify(request.title) : null
        ]
      );
    }

    const status: RunStatus = request.routing.allowWrites ? "waiting_approval" : "queued";
    const runResult = await client.query(
      `
        insert into runs (
          id,
          conversation_id,
          user_id,
          origin,
          status,
          model,
          workspace_id,
          prompt,
          response,
          error,
          allow_writes,
          memory_enabled,
          content_mode,
          protocol_version,
          client_request_id,
          client_id,
          client_key_id,
          target_runner_id,
          runner_key_id,
          request_envelope
        )
        values (
          $1, $2, $3, 'web', $4, $5, $6, null, null, null, $7, $8,
          $9, $10, $11, $12, $13, $14, $15, $16
        )
        returning *
      `,
      [
        request.runId,
        request.conversationId,
        input.userId,
        status,
        request.routing.model,
        request.routing.workspaceId,
        request.routing.allowWrites,
        request.routing.memoryEnabled,
        CONTENT_MODE,
        E2EE_PROTOCOL,
        request.messageId,
        request.clientId,
        request.clientKeyId,
        request.runnerId,
        request.runnerKeyId,
        JSON.stringify(request)
      ]
    );
    return { run: mapRun(runResult.rows[0]), created: true };
  }).then(async (result) => {
    if (result.created && result.run.status === "queued") {
      const { notifyE2eeJobQueued } = await import("./runWaiter.js");
      notifyE2eeJobQueued(request.runnerId);
    }
    return result;
  });
}

export async function submitE2eeApproval(input: {
  userId: string;
  approval: E2eeApprovalEnvelope;
}) {
  return inTransaction(async (client) => {
    const selected = await client.query(
      `
        select *, approval_envelope = $4::jsonb as same_approval
        from runs
        where id = $1 and user_id = $2 and content_mode = $3
        for update
      `,
      [
        input.approval.runId,
        input.userId,
        CONTENT_MODE,
        JSON.stringify(input.approval)
      ]
    );
    const row = selected.rows[0];
    if (!row) return undefined;
    const request = e2eeRunRequestEnvelopeSchema.parse(row.request_envelope);
    const approval = input.approval;
    if (
      request.conversationId !== approval.conversationId ||
      request.clientId !== approval.clientId ||
      request.clientKeyId !== approval.clientKeyId ||
      request.runnerId !== approval.runnerId ||
      request.runnerKeyId !== approval.runnerKeyId ||
      request.routing.allowWrites !== true
    ) {
      throw new E2eeConflictError("approval_request_mismatch");
    }
    if (row.approval_envelope) {
      const existing = e2eeApprovalEnvelopeSchema.parse(row.approval_envelope);
      if (existing.messageId !== approval.messageId || !row.same_approval) {
        throw new E2eeConflictError("approval_already_submitted");
      }
      return mapRun(row);
    }
    const updated = await client.query(
      `
        update runs
        set approval_envelope = $3,
            status = 'queued',
            updated_at = now()
        where id = $1 and user_id = $2 and status = 'waiting_approval'
        returning *
      `,
      [approval.runId, input.userId, JSON.stringify(approval)]
    );
    return updated.rows[0] ? mapRun(updated.rows[0]) : undefined;
  });
}

export async function listE2eeConversations(
  userId: string,
  limit = 100
): Promise<E2eeConversationRecord[]> {
  const result = await pool.query(
    `
      select
        c.*,
        count(r.id)::integer as run_count,
        max(r.created_at) as last_run_at
      from conversations c
      left join runs r on r.conversation_id = c.id and r.deleted_at is null
      where c.user_id = $1
        and c.content_mode = $2
        and c.deleted_at is null
      group by c.id
      order by coalesce(max(r.created_at), c.updated_at) desc
      limit $3
    `,
    [userId, CONTENT_MODE, limit]
  );
  return result.rows.map(mapConversation);
}

export async function listE2eeConversationRuns(input: {
  userId: string;
  conversationId: string;
}): Promise<E2eeRunRecord[] | undefined> {
  const conversation = await pool.query(
    `
      select id
      from conversations
      where id = $1 and user_id = $2 and content_mode = $3 and deleted_at is null
    `,
    [input.conversationId, input.userId, CONTENT_MODE]
  );
  if (!conversation.rows[0]) return undefined;
  const result = await pool.query(
    `
      select *
      from runs
      where conversation_id = $1
        and user_id = $2
        and content_mode = $3
        and deleted_at is null
      order by created_at
    `,
    [input.conversationId, input.userId, CONTENT_MODE]
  );
  return result.rows.map(mapRun);
}

export async function getE2eeRunForUser(runId: string, userId: string) {
  const result = await pool.query(
    `
      select *
      from runs
      where id = $1 and user_id = $2 and content_mode = $3 and deleted_at is null
    `,
    [runId, userId, CONTENT_MODE]
  );
  return result.rows[0] ? mapRun(result.rows[0]) : undefined;
}

export async function cancelE2eeRun(runId: string, userId: string) {
  const result = await pool.query(
    `
      update runs
      set status = 'cancelled',
          cancel_reason = 'caller_cancelled',
          progress_envelope = null,
          progress_sequence = null,
          claim_lease_id = null,
          claimed_by = null,
          lease_expires_at = null,
          last_activity_at = now(),
          finished_at = now(),
          updated_at = now()
      where id = $1
        and user_id = $2
        and content_mode = $3
        and status in ('queued', 'waiting_approval', 'running')
        and deleted_at is null
      returning *
    `,
    [runId, userId, CONTENT_MODE]
  );
  return result.rows[0] ? mapRun(result.rows[0]) : undefined;
}

export async function addE2eeMemory(input: {
  userId: string;
  envelope: E2eeMemoryEnvelope;
}): Promise<{ memory: E2eeMemoryRecord; created: boolean }> {
  const envelope = input.envelope;
  if (
    (envelope.scope === "workspace" && !envelope.workspaceId) ||
    (envelope.scope === "user" && envelope.workspaceId !== null)
  ) {
    throw new E2eeConflictError("memory_scope_mismatch");
  }
  const result = await pool.query(
    `
      insert into memory_facts (
        id,
        user_id,
        scope,
        workspace_id,
        content,
        content_mode,
        client_id,
        client_key_id,
        content_envelope
      )
      values ($1, $2, $3, $4, null, $5, $6, $7, $8)
      on conflict (id) do nothing
      returning *
    `,
    [
      envelope.memoryId,
      input.userId,
      envelope.scope,
      envelope.workspaceId,
      CONTENT_MODE,
      envelope.clientId,
      envelope.clientKeyId,
      JSON.stringify(envelope)
    ]
  );
  if (result.rows[0]) return { memory: mapMemory(result.rows[0]), created: true };
  const existing = await pool.query(
    `
      select *, content_envelope = $4::jsonb as same_envelope
      from memory_facts
      where id = $1 and user_id = $2 and content_mode = $3
    `,
    [
      envelope.memoryId,
      input.userId,
      CONTENT_MODE,
      JSON.stringify(envelope)
    ]
  );
  if (!existing.rows[0]) throw new E2eeConflictError("memory_id_conflict");
  if (!existing.rows[0].same_envelope) {
    throw new E2eeConflictError("memory_id_conflict");
  }
  return { memory: mapMemory(existing.rows[0]), created: false };
}

export async function listE2eeMemory(input: {
  userId: string;
  workspaceId?: string | undefined;
  limit?: number;
}): Promise<E2eeMemoryRecord[]> {
  const result = await pool.query(
    `
      select *
      from memory_facts
      where user_id = $1
        and content_mode = $2
        and (workspace_id is null or workspace_id = $3)
      order by updated_at desc
      limit $4
    `,
    [input.userId, CONTENT_MODE, input.workspaceId ?? null, input.limit ?? 200]
  );
  return result.rows.map(mapMemory);
}

export async function scrubLegacyData(input: {
  userId: string;
  conversationIds: string[];
  memoryIds: string[];
}) {
  return inTransaction(async (client) => {
    const active = await client.query(
      `
        select id
        from runs
        where user_id = $1
          and content_mode = 'plaintext'
          and conversation_id = any($2::uuid[])
          and status in ('queued', 'waiting_approval', 'running')
        limit 1
      `,
      [input.userId, input.conversationIds]
    );
    if (active.rows[0]) {
      throw new E2eeConflictError("legacy_migration_has_active_runs");
    }

    const runs = await client.query(
      `
        update runs
        set prompt = null,
            response = null,
            error = null,
            progress = null,
            progress_kind = null,
            input_tokens = null,
            output_tokens = null,
            content_mode = 'scrubbed',
            deleted_at = coalesce(deleted_at, now()),
            updated_at = now()
        where user_id = $1
          and content_mode = 'plaintext'
          and conversation_id = any($2::uuid[])
      `,
      [input.userId, input.conversationIds]
    );
    const conversations = await client.query(
      `
        update conversations
        set title = null,
            agent_id = null,
            content_mode = 'scrubbed',
            deleted_at = coalesce(deleted_at, now()),
            updated_at = now()
        where user_id = $1
          and content_mode = 'plaintext'
          and id = any($2::uuid[])
      `,
      [input.userId, input.conversationIds]
    );
    const memory = await client.query(
      `
        update memory_facts
        set content = null,
            content_mode = 'scrubbed',
            updated_at = now()
        where user_id = $1
          and content_mode = 'plaintext'
          and id = any($2::uuid[])
      `,
      [input.userId, input.memoryIds]
    );
    return {
      conversations: conversations.rowCount ?? 0,
      runs: runs.rowCount ?? 0,
      memory: memory.rowCount ?? 0
    };
  });
}

export async function claimNextE2eeRun(input: {
  runnerId: string;
  runnerKeyId: string;
  maxAttempts?: number;
  maxConcurrentJobs?: number;
}): Promise<E2eeRunnerJob | undefined> {
  const result = await pool.query(
    `
      with capacity_lock as (
        select pg_advisory_xact_lock(
          hashtext('cursor-gateway-execution-capacity')
        )
      ),
      expired_failed as (
        update runs
        set status = 'error',
            progress_envelope = null,
            progress_sequence = null,
            claim_lease_id = null,
            claimed_by = null,
            lease_expires_at = null,
            finished_at = now(),
            updated_at = now()
        where content_mode = $1
          and status = 'running'
          and deleted_at is null
          and lease_expires_at < now()
          and claim_attempts >= $4
      ),
      expired_requeued as (
        update runs
        set status = 'queued',
            progress_envelope = null,
            progress_sequence = null,
            claim_lease_id = null,
            claimed_by = null,
            lease_expires_at = null,
            started_at = null,
            updated_at = now()
        where content_mode = $1
          and status = 'running'
          and deleted_at is null
          and lease_expires_at < now()
          and claim_attempts < $4
      ),
      capacity as (
        select count(*)::integer as count
        from runs, capacity_lock
        where status = 'running'
          and deleted_at is null
          and claimed_by is not null
      ),
      candidate as (
        select r.id
        from runs r
        join conversations c on c.id = r.conversation_id
        where r.content_mode = $1
          and r.status = 'queued'
          and r.target_runner_id = $2
          and r.runner_key_id = $3
          and r.deleted_at is null
          and c.deleted_at is null
          and (select count from capacity) < $6
          and not exists (
            select 1
            from runs runner_active
            where runner_active.content_mode = $1
              and runner_active.status = 'running'
              and runner_active.claimed_by = $2
              and runner_active.deleted_at is null
          )
          and not exists (
            select 1
            from runs active
            where active.conversation_id = r.conversation_id
              and active.status = 'running'
              and active.deleted_at is null
          )
        order by r.created_at
        for update of r, c skip locked
        limit 1
      )
      update runs claimed
      set status = 'running',
          started_at = now(),
          updated_at = now(),
          claim_attempts = claimed.claim_attempts + 1,
          claim_lease_id = gen_random_uuid(),
          claimed_by = $2,
          lease_expires_at = now() + make_interval(mins => $5)
      from candidate
      where claimed.id = candidate.id
      returning claimed.*
    `,
    [
      CONTENT_MODE,
      input.runnerId,
      input.runnerKeyId,
      input.maxAttempts ?? 3,
      LEASE_MINUTES,
      input.maxConcurrentJobs ?? 6
    ]
  );
  const row = result.rows[0];
  if (!row) return undefined;
  return {
    contentMode: CONTENT_MODE,
    leaseId: row.claim_lease_id,
    leaseExpiresAt: row.lease_expires_at.toISOString(),
    request: e2eeRunRequestEnvelopeSchema.parse(row.request_envelope),
    approval: row.approval_envelope
      ? e2eeApprovalEnvelopeSchema.parse(row.approval_envelope)
      : null
  };
}

export async function updateE2eeProgress(input: {
  runnerId: string;
  leaseId: string;
  envelope: E2eeProgressEnvelope;
}) {
  const envelope = input.envelope;
  const result = await pool.query(
    `
      update runs
      set progress_envelope = $5,
          progress_sequence = $6,
          lease_expires_at = now() + make_interval(mins => $7),
          updated_at = now()
      where id = $1
        and conversation_id = $2
        and target_runner_id = $3
        and claimed_by = $3
        and claim_lease_id = $4
        and status = 'running'
        and content_mode = $8
        and coalesce(progress_sequence, 0) < $6
      returning id
    `,
    [
      envelope.runId,
      envelope.conversationId,
      input.runnerId,
      input.leaseId,
      JSON.stringify(envelope),
      envelope.sequence,
      LEASE_MINUTES,
      CONTENT_MODE
    ]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function renewE2eeLease(input: {
  runId: string;
  runnerId: string;
  runnerKeyId: string;
  leaseId: string;
}) {
  const result = await pool.query(
    `
      update runs
      set lease_expires_at = now() + make_interval(mins => $5),
          updated_at = now()
      where id = $1
        and target_runner_id = $2
        and runner_key_id = $3
        and claimed_by = $2
        and claim_lease_id = $4
        and status = 'running'
        and content_mode = $6
      returning id
    `,
    [
      input.runId,
      input.runnerId,
      input.runnerKeyId,
      input.leaseId,
      LEASE_MINUTES,
      CONTENT_MODE
    ]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function finishE2eeRun(input: {
  runnerId: string;
  leaseId: string;
  envelope: E2eeResultEnvelope;
}) {
  const envelope = input.envelope;
  const result = await pool.query(
    `
      update runs
      set status = $5,
          result_envelope = $6,
          progress_envelope = null,
          progress_sequence = null,
          claim_lease_id = null,
          claimed_by = null,
          lease_expires_at = null,
          finished_at = now(),
          updated_at = now()
      where id = $1
        and conversation_id = $2
        and target_runner_id = $3
        and claimed_by = $3
        and claim_lease_id = $4
        and status = 'running'
        and content_mode = $7
      returning *
    `,
    [
      envelope.runId,
      envelope.conversationId,
      input.runnerId,
      input.leaseId,
      envelope.status,
      JSON.stringify(envelope),
      CONTENT_MODE
    ]
  );
  if (result.rows[0]) return mapRun(result.rows[0]);

  const existing = await pool.query(
    `
      select *
      from runs
      where id = $1
        and target_runner_id = $2
        and content_mode = $3
        and result_envelope ->> 'messageId' = $4
    `,
    [envelope.runId, input.runnerId, CONTENT_MODE, envelope.messageId]
  );
  return existing.rows[0] ? mapRun(existing.rows[0]) : undefined;
}

export async function rejectE2eeRun(input: {
  runId: string;
  runnerId: string;
  runnerKeyId: string;
  leaseId: string;
}) {
  const result = await pool.query(
    `
      update runs
      set status = 'error',
          progress_envelope = null,
          progress_sequence = null,
          claim_lease_id = null,
          claimed_by = null,
          lease_expires_at = null,
          finished_at = now(),
          updated_at = now()
      where id = $1
        and target_runner_id = $2
        and runner_key_id = $3
        and claimed_by = $2
        and claim_lease_id = $4
        and status = 'running'
        and content_mode = $5
      returning *
    `,
    [
      input.runId,
      input.runnerId,
      input.runnerKeyId,
      input.leaseId,
      CONTENT_MODE
    ]
  );
  if (result.rows[0]) return mapRun(result.rows[0]);

  // A lost HTTP response must not cause the runner to retry a terminally
  // rejected job forever. Treat an already-terminal, envelope-free rejection
  // for the same runner identity as an idempotent success.
  const existing = await pool.query(
    `
      select *
      from runs
      where id = $1
        and target_runner_id = $2
        and runner_key_id = $3
        and status = 'error'
        and content_mode = $4
        and result_envelope is null
    `,
    [input.runId, input.runnerId, input.runnerKeyId, CONTENT_MODE]
  );
  return existing.rows[0] ? mapRun(existing.rows[0]) : undefined;
}
