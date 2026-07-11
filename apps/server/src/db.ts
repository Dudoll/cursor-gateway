import { Pool, type PoolClient, type QueryResultRow } from "pg";
import type {
  Conversation,
  ConversationTurn,
  InterviewPlan,
  InterviewProfile,
  InterviewProfileUpdate,
  InterviewProgress,
  InterviewProgressUpdate,
  MemoryFact,
  Origin,
  Role,
  RunRecord,
  RunStatus,
  Workspace
} from "@cursor-gateway/shared";
import { config } from "./config.js";

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 10
});

export class AutomationThreadWorkspaceMismatchError extends Error {
  constructor(readonly existingWorkspaceId: string) {
    super("automation_thread_workspace_mismatch");
    this.name = "AutomationThreadWorkspaceMismatchError";
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

export async function migrate() {
  await pool.query(`
    create extension if not exists pgcrypto;

    create table if not exists app_users (
      id uuid primary key default gen_random_uuid(),
      email text unique,
      telegram_user_id text unique,
      display_name text,
      service_name text,
      role text not null default 'viewer',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists workspaces (
      id text primary key,
      label text not null,
      path text not null,
      writable boolean not null default false,
      enabled boolean not null default true,
      created_at timestamptz not null default now()
    );

    create table if not exists conversations (
      id uuid primary key default gen_random_uuid(),
      user_id uuid not null references app_users(id),
      workspace_id text not null references workspaces(id),
      agent_id text,
      title text,
      deleted_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists runs (
      id uuid primary key default gen_random_uuid(),
      conversation_id uuid not null references conversations(id),
      user_id uuid not null references app_users(id),
      origin text not null,
      status text not null,
      model text not null,
      workspace_id text not null references workspaces(id),
      prompt text not null,
      response text,
      error text,
      allow_writes boolean not null default false,
      memory_enabled boolean not null default true,
      idempotency_key text,
      input_tokens bigint,
      output_tokens bigint,
      started_at timestamptz,
      finished_at timestamptz,
      deleted_at timestamptz,
      deleted_with_conversation boolean not null default false,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists memory_facts (
      id uuid primary key default gen_random_uuid(),
      user_id uuid not null references app_users(id),
      scope text not null,
      workspace_id text references workspaces(id),
      content text not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists audit_logs (
      id uuid primary key default gen_random_uuid(),
      actor_user_id uuid references app_users(id),
      event_type text not null,
      details jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    );

    alter table app_users add column if not exists display_name text;
    alter table app_users add column if not exists service_name text;
    alter table runs add column if not exists memory_enabled boolean not null default true;
    alter table runs add column if not exists idempotency_key text;
    alter table runs add column if not exists input_tokens bigint;
    alter table runs add column if not exists output_tokens bigint;
    alter table runs add column if not exists started_at timestamptz;
    alter table runs add column if not exists finished_at timestamptz;
    alter table runs add column if not exists deleted_at timestamptz;
    alter table runs add column if not exists deleted_with_conversation boolean not null default false;
    alter table runs add column if not exists progress text;
    alter table runs add column if not exists progress_kind text;
    alter table conversations add column if not exists deleted_at timestamptz;

    update runs
    set finished_at = updated_at
    where finished_at is null and status in ('finished', 'error', 'cancelled');

    create table if not exists automation_threads (
      id uuid primary key default gen_random_uuid(),
      user_id uuid not null references app_users(id) on delete cascade,
      thread_key text not null,
      conversation_id uuid not null references conversations(id) on delete cascade,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists telegram_sessions (
      user_id uuid primary key references app_users(id) on delete cascade,
      model text not null default 'auto',
      workspace_id text references workspaces(id) on delete set null,
      conversation_id uuid references conversations(id) on delete set null,
      updated_at timestamptz not null default now()
    );

    create table if not exists interview_entitlements (
      email text primary key,
      plan text not null,
      status text not null default 'pending',
      payment_provider text not null,
      payment_reference text not null,
      activation_token_hash text,
      activation_expires_at timestamptz,
      activated_user_id uuid references app_users(id) on delete set null,
      paid_at timestamptz not null default now(),
      expires_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      check (status in ('pending', 'active', 'revoked'))
    );

    create table if not exists interview_profiles (
      user_id uuid primary key references app_users(id) on delete cascade,
      target_role text not null,
      source_stack text not null,
      target_companies text[] not null default '{}',
      current_level text not null,
      weekly_hours integer not null,
      target_date date,
      goals text not null default '',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      check (current_level in ('starting', 'building', 'interviewing')),
      check (weekly_hours between 1 and 80)
    );

    create table if not exists interview_question_progress (
      user_id uuid not null references app_users(id) on delete cascade,
      report_id text not null,
      question_key text not null,
      status text not null,
      confidence integer not null,
      notes text not null default '',
      next_review_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      primary key (user_id, report_id, question_key),
      check (status in ('new', 'practicing', 'mastered')),
      check (confidence between 1 and 5)
    );

    create index if not exists runs_status_created_idx on runs(status, created_at);
    drop index if exists runs_user_idempotency_unique;
    create unique index if not exists runs_user_idempotency_active_unique
      on runs(user_id, idempotency_key)
      where idempotency_key is not null and deleted_at is null;
    create unique index if not exists app_users_service_name_unique
      on app_users(service_name)
      where service_name is not null;
    create unique index if not exists automation_threads_user_key_unique
      on automation_threads(user_id, thread_key);
    create unique index if not exists automation_threads_conversation_unique
      on automation_threads(conversation_id);
    create index if not exists conversations_user_updated_idx
      on conversations(user_id, updated_at desc);
    create index if not exists runs_conversation_created_idx
      on runs(conversation_id, created_at);
    create index if not exists conversations_active_user_updated_idx
      on conversations(user_id, updated_at desc)
      where deleted_at is null;
    create index if not exists runs_active_conversation_created_idx
      on runs(conversation_id, created_at)
      where deleted_at is null;
    create index if not exists memory_user_workspace_idx on memory_facts(user_id, workspace_id);
    create index if not exists audit_created_idx on audit_logs(created_at desc);
    create unique index if not exists interview_entitlements_payment_unique
      on interview_entitlements(payment_provider, payment_reference);
    create unique index if not exists interview_entitlements_token_unique
      on interview_entitlements(activation_token_hash)
      where activation_token_hash is not null;
    create index if not exists interview_progress_user_review_idx
      on interview_question_progress(user_id, next_review_at, updated_at desc);
  `);
}

function mapRun(row: QueryResultRow): RunRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    origin: row.origin as Origin,
    status: row.status as RunStatus,
    model: row.model,
    workspaceId: row.workspace_id,
    prompt: row.prompt,
    response: row.response,
    error: row.error,
    progress: row.progress ?? null,
    progressKind: (row.progress_kind as RunRecord["progressKind"]) ?? null,
    allowWrites: row.allow_writes,
    idempotencyKey: row.idempotency_key,
    inputTokens: row.input_tokens === null || row.input_tokens === undefined ? null : Number(row.input_tokens),
    outputTokens: row.output_tokens === null || row.output_tokens === undefined ? null : Number(row.output_tokens),
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    finishedAt: row.finished_at?.toISOString() ?? null,
    updatedAt: row.updated_at.toISOString()
  };
}

function mapConversation(row: QueryResultRow): Conversation {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    runCount: Number(row.run_count ?? 0),
    lastRunAt: row.last_run_at ? row.last_run_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

export async function upsertUser(input: {
  email?: string;
  telegramUserId?: string;
  role?: Role;
}) {
  const role = input.role ?? "viewer";
  if (input.email) {
    const result = await pool.query(
      `
        insert into app_users (email, telegram_user_id, role)
        values ($1, $2, $3)
        on conflict (email)
        do update set updated_at = now()
        returning id, email, telegram_user_id, display_name, role
      `,
      [input.email.toLowerCase(), input.telegramUserId ?? null, role]
    );
    return result.rows[0] as {
      id: string;
      email: string | null;
      telegram_user_id: string | null;
      display_name: string | null;
      role: Role;
    };
  }

  const result = await pool.query(
    `
      insert into app_users (email, telegram_user_id, role)
      values ($1, $2, $3)
      on conflict (telegram_user_id)
      do update set updated_at = now()
      returning id, email, telegram_user_id, display_name, role
    `,
    [null, input.telegramUserId ?? null, role]
  );
  return result.rows[0] as {
    id: string;
    email: string | null;
    telegram_user_id: string | null;
    display_name: string | null;
    role: Role;
  };
}

export async function upsertServicePrincipal(serviceName: string, role: Role = "operator") {
  const result = await pool.query(
    `
      insert into app_users (service_name, role)
      values ($1, $2)
      on conflict (service_name) where service_name is not null
      do update set role = excluded.role, updated_at = now()
      returning id, role
    `,
    [serviceName, role]
  );
  return result.rows[0] as { id: string; role: Role };
}

export async function findUserByTelegramId(telegramUserId: string) {
  const result = await pool.query(
    "select id, email, telegram_user_id, display_name, role from app_users where telegram_user_id = $1",
    [telegramUserId]
  );
  return result.rows[0] as
    | {
        id: string;
        email: string | null;
        telegram_user_id: string | null;
        display_name: string | null;
        role: Role;
      }
    | undefined;
}

export async function updateUserDisplayName(userId: string, displayName: string) {
  const result = await pool.query(
    `
      update app_users
      set display_name = $2, updated_at = now()
      where id = $1
      returning id, email, telegram_user_id, display_name, role
    `,
    [userId, displayName]
  );
  return result.rows[0] as
    | {
        id: string;
        email: string | null;
        telegram_user_id: string | null;
        display_name: string | null;
        role: Role;
      }
    | undefined;
}

export async function listWorkspaces(): Promise<Workspace[]> {
  const result = await pool.query(
    "select id, label, path, writable from workspaces where enabled = true order by label"
  );
  return result.rows.map((row) => ({
    id: row.id,
    label: row.label,
    path: row.path,
    writable: row.writable
  }));
}

export async function upsertWorkspace(workspace: Workspace) {
  await pool.query(
    `
      insert into workspaces (id, label, path, writable)
      values ($1, $2, $3, $4)
      on conflict (id)
      do update set label = excluded.label, path = excluded.path, writable = excluded.writable, enabled = true
    `,
    [workspace.id, workspace.label, workspace.path, workspace.writable]
  );
}

export async function getWorkspace(id: string): Promise<Workspace | undefined> {
  const result = await pool.query(
    "select id, label, path, writable from workspaces where id = $1 and enabled = true",
    [id]
  );
  const row = result.rows[0];
  return row ? { id: row.id, label: row.label, path: row.path, writable: row.writable } : undefined;
}

export async function createConversation(input: {
  userId: string;
  workspaceId: string;
  title?: string;
}) {
  const result = await pool.query(
    `
      insert into conversations (user_id, workspace_id, title)
      values ($1, $2, $3)
      returning id, workspace_id, agent_id, title
    `,
    [input.userId, input.workspaceId, input.title ?? null]
  );
  return result.rows[0] as {
    id: string;
    workspace_id: string;
    agent_id: string | null;
    title: string | null;
  };
}

export async function getConversation(id: string, userId: string) {
  const result = await pool.query(
    `
      select id, workspace_id, agent_id, title
      from conversations
      where id = $1 and user_id = $2 and deleted_at is null
    `,
    [id, userId]
  );
  return result.rows[0] as
    | { id: string; workspace_id: string; agent_id: string | null; title: string | null }
    | undefined;
}

export async function getLatestConversation(userId: string, workspaceId: string) {
  const result = await pool.query(
    `
      select id, workspace_id, agent_id, title
      from conversations
      where user_id = $1 and workspace_id = $2 and deleted_at is null
      order by updated_at desc
      limit 1
    `,
    [userId, workspaceId]
  );
  return result.rows[0] as
    | { id: string; workspace_id: string; agent_id: string | null; title: string | null }
    | undefined;
}

export async function listConversations(userId: string, limit = 100): Promise<Conversation[]> {
  const result = await pool.query(
    `
      select
        c.id,
        c.workspace_id,
        c.title,
        c.created_at,
        c.updated_at,
        count(r.id)::integer as run_count,
        max(r.created_at) as last_run_at
      from conversations c
      left join runs r on r.conversation_id = c.id
        and r.deleted_at is null
      where c.user_id = $1 and c.deleted_at is null
      group by c.id
      order by coalesce(max(r.created_at), c.updated_at) desc
      limit $2
    `,
    [userId, limit]
  );
  return result.rows.map(mapConversation);
}

export async function listConversationRuns(input: {
  conversationId: string;
  userId: string;
}): Promise<RunRecord[] | undefined> {
  const conversation = await getConversation(input.conversationId, input.userId);
  if (!conversation) return undefined;

  const result = await pool.query(
    `
      select *
      from runs
      where conversation_id = $1 and user_id = $2 and deleted_at is null
      order by created_at asc
    `,
    [input.conversationId, input.userId]
  );
  return result.rows.map(mapRun);
}

export async function updateConversationAgent(conversationId: string, agentId: string | null) {
  await pool.query(
    "update conversations set agent_id = $2, updated_at = now() where id = $1",
    [conversationId, agentId]
  );
}

export async function createRun(input: {
  conversationId: string;
  userId: string;
  origin: Origin;
  status: RunStatus;
  model: string;
  workspaceId: string;
  prompt: string;
  allowWrites: boolean;
  memoryEnabled: boolean;
  idempotencyKey?: string;
}) {
  const result = await pool.query(
    `
      with touched as (
        update conversations
        set updated_at = now()
        where id = $1
      )
      insert into runs (
        conversation_id,
        user_id,
        origin,
        status,
        model,
        workspace_id,
        prompt,
        allow_writes,
        memory_enabled,
        idempotency_key
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      returning *
    `,
    [
      input.conversationId,
      input.userId,
      input.origin,
      input.status,
      input.model,
      input.workspaceId,
      input.prompt,
      input.allowWrites,
      input.memoryEnabled,
      input.idempotencyKey ?? null
    ]
  );
  return mapRun(result.rows[0]);
}

export type RunExecutor = "windows" | "hermes";

export async function claimNextRun(executor: RunExecutor) {
  const result = await pool.query(
    `
      update runs
      set status = 'running', started_at = now(), updated_at = now()
      where id = (
        select r.id
        from runs r
        join conversations c on c.id = r.conversation_id
        where r.status = 'queued'
          and r.deleted_at is null
          and c.deleted_at is null
          and (
            ($1 = 'hermes' and r.model like 'hermes:%')
            or
            ($1 = 'windows' and r.model not like 'hermes:%')
          )
        order by r.created_at asc
        for update skip locked
        limit 1
      )
      returning *
    `,
    [executor]
  );
  return result.rows[0] ? mapRun(result.rows[0]) : undefined;
}

export async function requeueStaleRuns(executor: RunExecutor, staleAfterSeconds = 900) {
  const result = await pool.query(
    `
      update runs
      set
        status = 'queued',
        error = 'requeued after runner interruption',
        updated_at = now()
      where status = 'running'
        and deleted_at is null
        and updated_at < now() - make_interval(secs => $2)
        and (
          ($1 = 'hermes' and model like 'hermes:%')
          or
          ($1 = 'windows' and model not like 'hermes:%')
        )
      returning id
    `,
    [executor, staleAfterSeconds]
  );
  return result.rowCount ?? 0;
}

export async function finishRun(input: {
  runId: string;
  status: "finished" | "error" | "cancelled";
  response: string | null;
  error: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
}) {
  const result = await pool.query(
    `
      update runs
      set status = $2,
          response = $3,
          error = $4,
          input_tokens = $5,
          output_tokens = $6,
          progress = null,
          progress_kind = null,
          finished_at = now(),
          updated_at = now()
      where id = $1
      returning *
    `,
    [
      input.runId,
      input.status,
      input.response,
      input.error,
      input.inputTokens ?? null,
      input.outputTokens ?? null
    ]
  );
  return result.rows[0] ? mapRun(result.rows[0]) : undefined;
}

export async function updateRunProgress(input: {
  runId: string;
  kind: NonNullable<RunRecord["progressKind"]>;
  message: string;
}) {
  const result = await pool.query(
    `
      update runs
      set progress = $2,
          progress_kind = $3,
          updated_at = now()
      where id = $1 and status = 'running'
      returning id
    `,
    [input.runId, input.message, input.kind]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function approveRun(runId: string, userId: string) {
  const result = await pool.query(
    `
      update runs
      set status = 'queued', updated_at = now()
      where id = $1 and user_id = $2 and status = 'waiting_approval'
      returning *
    `,
    [runId, userId]
  );
  return result.rows[0] ? mapRun(result.rows[0]) : undefined;
}

export async function getRunForUser(runId: string, userId: string) {
  const result = await pool.query(
    "select * from runs where id = $1 and user_id = $2 and deleted_at is null",
    [runId, userId]
  );
  return result.rows[0] ? mapRun(result.rows[0]) : undefined;
}

export async function getRunByIdempotencyKey(userId: string, idempotencyKey: string) {
  const result = await pool.query(
    `
      select *
      from runs
      where user_id = $1 and idempotency_key = $2 and deleted_at is null
    `,
    [userId, idempotencyKey]
  );
  return result.rows[0] ? mapRun(result.rows[0]) : undefined;
}

export async function createAutomationThreadRun(input: {
  userId: string;
  threadKey: string;
  title?: string;
  status: RunStatus;
  model: string;
  workspaceId: string;
  prompt: string;
  idempotencyKey: string;
  allowWrites: boolean;
}): Promise<{ run: RunRecord; created: boolean }> {
  return inTransaction(async (client) => {
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [
      `automation-idempotency:${input.userId}:${input.idempotencyKey}`
    ]);

    const existing = await client.query(
      `
        select *
        from runs
        where user_id = $1 and idempotency_key = $2 and deleted_at is null
      `,
      [input.userId, input.idempotencyKey]
    );
    if (existing.rows[0]) return { run: mapRun(existing.rows[0]), created: false };

    await client.query("select pg_advisory_xact_lock(hashtext($1))", [
      `automation-thread:${input.userId}:${input.threadKey}`
    ]);

    const threadResult = await client.query(
      `
        select t.conversation_id, c.workspace_id
        from automation_threads t
        join conversations c on c.id = t.conversation_id
        where t.user_id = $1 and t.thread_key = $2 and c.deleted_at is null
        for update of t, c
      `,
      [input.userId, input.threadKey]
    );

    let conversationId: string;
    const thread = threadResult.rows[0];
    if (thread) {
      if (thread.workspace_id !== input.workspaceId) {
        throw new AutomationThreadWorkspaceMismatchError(thread.workspace_id);
      }
      conversationId = thread.conversation_id;
      await client.query(
        `
          update conversations
          set title = coalesce(title, $2), updated_at = now()
          where id = $1
        `,
        [conversationId, input.title ?? null]
      );
      await client.query(
        "update automation_threads set updated_at = now() where user_id = $1 and thread_key = $2",
        [input.userId, input.threadKey]
      );
    } else {
      const conversationResult = await client.query(
        `
          insert into conversations (user_id, workspace_id, title)
          values ($1, $2, $3)
          returning id
        `,
        [input.userId, input.workspaceId, input.title ?? input.prompt.slice(0, 80)]
      );
      conversationId = conversationResult.rows[0].id;
      await client.query(
        `
          insert into automation_threads (user_id, thread_key, conversation_id)
          values ($1, $2, $3)
        `,
        [input.userId, input.threadKey, conversationId]
      );
    }

    const runResult = await client.query(
      `
        insert into runs (
          conversation_id,
          user_id,
          origin,
          status,
          model,
          workspace_id,
          prompt,
          allow_writes,
          idempotency_key
        )
        values ($1, $2, 'automation', $3, $4, $5, $6, $7, $8)
        returning *
      `,
      [
        conversationId,
        input.userId,
        input.status,
        input.model,
        input.workspaceId,
        input.prompt,
        input.allowWrites,
        input.idempotencyKey
      ]
    );
    return { run: mapRun(runResult.rows[0]), created: true };
  });
}

export async function listAutomationThreadRuns(input: {
  userId: string;
  threadKey: string;
  limit?: number;
}): Promise<RunRecord[]> {
  const result = await pool.query(
    `
      select r.*
      from automation_threads t
      join conversations c on c.id = t.conversation_id
      join runs r on r.conversation_id = t.conversation_id
      where t.user_id = $1
        and t.thread_key = $2
        and c.deleted_at is null
        and r.deleted_at is null
      order by r.created_at desc
      limit $3
    `,
    [input.userId, input.threadKey, input.limit ?? 100]
  );
  return result.rows.map(mapRun);
}

export async function getAutomationThreadRun(input: {
  userId: string;
  threadKey: string;
  runId: string;
}): Promise<RunRecord | undefined> {
  const result = await pool.query(
    `
      select r.*
      from automation_threads t
      join conversations c on c.id = t.conversation_id
      join runs r on r.conversation_id = t.conversation_id
      where t.user_id = $1
        and t.thread_key = $2
        and r.id = $3
        and c.deleted_at is null
        and r.deleted_at is null
    `,
    [input.userId, input.threadKey, input.runId]
  );
  return result.rows[0] ? mapRun(result.rows[0]) : undefined;
}

export type SoftDeleteResult =
  | { status: "deleted"; run?: RunRecord }
  | { status: "running" }
  | { status: "not_found" };

export async function softDeleteRun(runId: string, userId: string): Promise<SoftDeleteResult> {
  const result = await pool.query(
    `
      update runs
      set
        status = case
          when status in ('queued', 'waiting_approval') then 'cancelled'
          else status
        end,
        error = case
          when status in ('queued', 'waiting_approval')
            then coalesce(error, 'deleted by user')
          else error
        end,
        deleted_at = now(),
        deleted_with_conversation = false,
        updated_at = now()
      where id = $1
        and user_id = $2
        and deleted_at is null
        and status <> 'running'
      returning *
    `,
    [runId, userId]
  );
  if (result.rows[0]) return { status: "deleted", run: mapRun(result.rows[0]) };

  const current = await pool.query(
    "select status, deleted_at from runs where id = $1 and user_id = $2",
    [runId, userId]
  );
  if (!current.rows[0] || current.rows[0].deleted_at) return { status: "not_found" };
  return current.rows[0].status === "running" ? { status: "running" } : { status: "not_found" };
}

export async function softDeleteConversation(
  conversationId: string,
  userId: string
): Promise<SoftDeleteResult> {
  return inTransaction(async (client) => {
    const conversation = await client.query(
      `
        select id
        from conversations
        where id = $1 and user_id = $2 and deleted_at is null
        for update
      `,
      [conversationId, userId]
    );
    if (!conversation.rows[0]) return { status: "not_found" };

    const activeRuns = await client.query(
      `
        select id, status
        from runs
        where conversation_id = $1 and deleted_at is null
        for update
      `,
      [conversationId]
    );
    if (activeRuns.rows.some((row) => row.status === "running")) {
      return { status: "running" };
    }

    await client.query(
      `
        update runs
        set
          status = case
            when status in ('queued', 'waiting_approval') then 'cancelled'
            else status
          end,
          error = case
            when status in ('queued', 'waiting_approval')
              then coalesce(error, 'conversation deleted by user')
            else error
          end,
          deleted_at = now(),
          deleted_with_conversation = true,
          updated_at = now()
        where conversation_id = $1 and deleted_at is null
      `,
      [conversationId]
    );
    await client.query(
      `
        update conversations
        set deleted_at = now(), updated_at = now()
        where id = $1
      `,
      [conversationId]
    );
    await client.query(
      `
        update telegram_sessions
        set conversation_id = null, updated_at = now()
        where conversation_id = $1
      `,
      [conversationId]
    );
    return { status: "deleted" };
  });
}

export type TrashConversation = {
  id: string;
  workspaceId: string;
  title: string | null;
  runCount: number;
  deletedAt: string;
};

export type TrashRun = {
  id: string;
  conversationId: string;
  status: RunStatus;
  model: string;
  prompt: string;
  deletedAt: string;
  createdAt: string;
};

export async function listTrash(userId: string): Promise<{
  conversations: TrashConversation[];
  runs: TrashRun[];
}> {
  const [conversations, runs] = await Promise.all([
    pool.query(
      `
        select
          c.id,
          c.workspace_id,
          c.title,
          c.deleted_at,
          count(r.id)::integer as run_count
        from conversations c
        left join runs r on r.conversation_id = c.id
        where c.user_id = $1 and c.deleted_at is not null
        group by c.id
        order by c.deleted_at desc
      `,
      [userId]
    ),
    pool.query(
      `
        select
          r.id,
          r.conversation_id,
          r.status,
          r.model,
          r.prompt,
          r.deleted_at,
          r.created_at
        from runs r
        join conversations c on c.id = r.conversation_id
        where r.user_id = $1
          and r.deleted_at is not null
          and r.deleted_with_conversation = false
          and c.deleted_at is null
        order by r.deleted_at desc
      `,
      [userId]
    )
  ]);

  return {
    conversations: conversations.rows.map((row) => ({
      id: row.id,
      workspaceId: row.workspace_id,
      title: row.title,
      runCount: Number(row.run_count ?? 0),
      deletedAt: row.deleted_at.toISOString()
    })),
    runs: runs.rows.map((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      status: row.status as RunStatus,
      model: row.model,
      prompt: row.prompt,
      deletedAt: row.deleted_at.toISOString(),
      createdAt: row.created_at.toISOString()
    }))
  };
}

export async function restoreRun(runId: string, userId: string) {
  const result = await pool.query(
    `
      update runs r
      set
        deleted_at = null,
        deleted_with_conversation = false,
        updated_at = now()
      from conversations c
      where r.id = $1
        and r.user_id = $2
        and r.conversation_id = c.id
        and r.deleted_at is not null
        and r.deleted_with_conversation = false
        and c.deleted_at is null
      returning r.*
    `,
    [runId, userId]
  );
  return result.rows[0] ? mapRun(result.rows[0]) : undefined;
}

export async function restoreConversation(conversationId: string, userId: string) {
  return inTransaction(async (client) => {
    const conversation = await client.query(
      `
        update conversations
        set deleted_at = null, updated_at = now()
        where id = $1 and user_id = $2 and deleted_at is not null
        returning id
      `,
      [conversationId, userId]
    );
    if (!conversation.rows[0]) return false;

    await client.query(
      `
        update runs
        set
          deleted_at = null,
          deleted_with_conversation = false,
          updated_at = now()
        where conversation_id = $1 and deleted_with_conversation = true
      `,
      [conversationId]
    );
    return true;
  });
}

export async function cancelQueuedRun(runId: string, userId: string) {
  const result = await pool.query(
    `
      update runs
      set status = 'cancelled', finished_at = now(), updated_at = now()
      where id = $1 and user_id = $2 and status in ('queued', 'waiting_approval')
      returning *
    `,
    [runId, userId]
  );
  return result.rows[0] ? mapRun(result.rows[0]) : undefined;
}

export async function getRunWithConversation(runId: string) {
  const result = await pool.query(
    `
      select r.*, c.agent_id, u.display_name, u.email, u.telegram_user_id
      from runs r
      join conversations c on c.id = r.conversation_id
      join app_users u on u.id = r.user_id
      where r.id = $1 and r.deleted_at is null and c.deleted_at is null
    `,
    [runId]
  );
  return result.rows[0] as (QueryResultRow & { agent_id: string | null }) | undefined;
}

export async function listCompletedConversationHistory(input: {
  conversationId: string;
  beforeRunId: string;
  limit?: number;
}): Promise<ConversationTurn[]> {
  const result = await pool.query(
    `
      select previous.prompt, previous.response
      from runs previous
      join runs current_run on current_run.id = $2
      where previous.conversation_id = $1
        and previous.id <> current_run.id
        and previous.created_at <= current_run.created_at
        and previous.status = 'finished'
        and previous.response is not null
        and previous.deleted_at is null
        and current_run.deleted_at is null
      order by previous.created_at desc
      limit $3
    `,
    [input.conversationId, input.beforeRunId, input.limit ?? 50]
  );
  return result.rows
    .map((row) => ({ prompt: row.prompt as string, response: row.response as string }))
    .reverse();
}

export async function listRuns(userId: string): Promise<RunRecord[]> {
  const result = await pool.query(
    `
      select *
      from runs
      where user_id = $1 and deleted_at is null
      order by created_at desc
      limit 50
    `,
    [userId]
  );
  return result.rows.map(mapRun);
}

export type TelegramSessionRecord = {
  model: string;
  workspaceId: string | null;
  conversationId: string | null;
};

function mapTelegramSession(row: QueryResultRow): TelegramSessionRecord {
  return {
    model: row.model,
    workspaceId: row.workspace_id,
    conversationId: row.conversation_id
  };
}

export async function getTelegramSession(userId: string): Promise<TelegramSessionRecord> {
  await pool.query(
    `
      insert into telegram_sessions (user_id)
      values ($1)
      on conflict (user_id) do nothing
    `,
    [userId]
  );
  const result = await pool.query(
    "select model, workspace_id, conversation_id from telegram_sessions where user_id = $1",
    [userId]
  );
  if (!result.rows[0]) throw new Error("telegram_session_not_found_after_insert");
  return mapTelegramSession(result.rows[0]);
}

export async function saveTelegramSession(userId: string, session: TelegramSessionRecord) {
  const result = await pool.query(
    `
      insert into telegram_sessions (user_id, model, workspace_id, conversation_id)
      values ($1, $2, $3, $4)
      on conflict (user_id)
      do update set
        model = excluded.model,
        workspace_id = excluded.workspace_id,
        conversation_id = excluded.conversation_id,
        updated_at = now()
      returning model, workspace_id, conversation_id
    `,
    [userId, session.model, session.workspaceId, session.conversationId]
  );
  return mapTelegramSession(result.rows[0]);
}

export async function listMemoryFacts(input: {
  userId: string;
  workspaceId?: string | undefined;
  limit?: number;
}): Promise<MemoryFact[]> {
  const result = await pool.query(
    `
      select id, scope, workspace_id, content, created_at, updated_at
      from memory_facts
      where user_id = $1 and (workspace_id is null or workspace_id = $2)
      order by updated_at desc
      limit $3
    `,
    [input.userId, input.workspaceId ?? null, input.limit ?? 12]
  );
  return result.rows.map((row) => ({
    id: row.id,
    scope: row.scope,
    workspaceId: row.workspace_id,
    content: row.content,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  }));
}

export async function addMemoryFact(input: {
  userId: string;
  scope: "user" | "workspace";
  workspaceId: string | null;
  content: string;
}) {
  const result = await pool.query(
    `
      insert into memory_facts (user_id, scope, workspace_id, content)
      values ($1, $2, $3, $4)
      returning id, scope, workspace_id, content, created_at, updated_at
    `,
    [input.userId, input.scope, input.workspaceId, input.content]
  );
  const row = result.rows[0];
  return {
    id: row.id,
    scope: row.scope,
    workspaceId: row.workspace_id,
    content: row.content,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  } satisfies MemoryFact;
}

export type InterviewEntitlementRecord = {
  email: string;
  plan: InterviewPlan;
  status: "pending" | "active" | "revoked";
  paymentProvider: string;
  paymentReference: string;
  activationExpiresAt: string | null;
  activatedUserId: string | null;
  paidAt: string;
  expiresAt: string | null;
};

function mapInterviewEntitlement(row: QueryResultRow): InterviewEntitlementRecord {
  return {
    email: row.email,
    plan: row.plan as InterviewPlan,
    status: row.status,
    paymentProvider: row.payment_provider,
    paymentReference: row.payment_reference,
    activationExpiresAt: row.activation_expires_at?.toISOString() ?? null,
    activatedUserId: row.activated_user_id ?? null,
    paidAt: row.paid_at.toISOString(),
    expiresAt: row.expires_at?.toISOString() ?? null
  };
}

export async function interviewEmailCanAuthenticate(email: string) {
  const result = await pool.query(
    `
      select 1
      from interview_entitlements
      where email = $1
        and status in ('pending', 'active')
        and (expires_at is null or expires_at > now())
        and (
          status = 'active'
          or activation_expires_at is null
          or activation_expires_at > now()
        )
    `,
    [email.toLowerCase()]
  );
  return Boolean(result.rows[0]);
}

export async function provisionInterviewEntitlement(input: {
  email: string;
  plan: InterviewPlan;
  paymentProvider: string;
  paymentReference: string;
  activationTokenHash: string;
  activationExpiresAt: Date;
  expiresAt: Date | null;
}) {
  const result = await pool.query(
    `
      insert into interview_entitlements (
        email,
        plan,
        status,
        payment_provider,
        payment_reference,
        activation_token_hash,
        activation_expires_at,
        activated_user_id,
        paid_at,
        expires_at
      )
      values ($1, $2, 'pending', $3, $4, $5, $6, null, now(), $7)
      on conflict (email)
      do update set
        plan = excluded.plan,
        status = 'pending',
        payment_provider = excluded.payment_provider,
        payment_reference = excluded.payment_reference,
        activation_token_hash = excluded.activation_token_hash,
        activation_expires_at = excluded.activation_expires_at,
        activated_user_id = null,
        paid_at = now(),
        expires_at = excluded.expires_at,
        updated_at = now()
      returning *
    `,
    [
      input.email.toLowerCase(),
      input.plan,
      input.paymentProvider,
      input.paymentReference,
      input.activationTokenHash,
      input.activationExpiresAt,
      input.expiresAt
    ]
  );
  return mapInterviewEntitlement(result.rows[0]);
}

export async function activateInterviewEntitlement(input: {
  email: string;
  userId: string;
  activationTokenHash: string;
}) {
  const result = await pool.query(
    `
      update interview_entitlements
      set
        status = 'active',
        activated_user_id = $2,
        activation_token_hash = null,
        activation_expires_at = null,
        updated_at = now()
      where email = $1
        and status = 'pending'
        and activation_token_hash = $3
        and activation_expires_at > now()
        and (expires_at is null or expires_at > now())
      returning *
    `,
    [input.email.toLowerCase(), input.userId, input.activationTokenHash]
  );
  return result.rows[0] ? mapInterviewEntitlement(result.rows[0]) : undefined;
}

export async function getInterviewEntitlementForUser(userId: string, email: string) {
  const result = await pool.query(
    `
      select *
      from interview_entitlements
      where email = $1
        and status in ('pending', 'active')
        and (expires_at is null or expires_at > now())
        and (activated_user_id is null or activated_user_id = $2)
    `,
    [email.toLowerCase(), userId]
  );
  return result.rows[0] ? mapInterviewEntitlement(result.rows[0]) : undefined;
}

function mapInterviewProfile(row: QueryResultRow): InterviewProfile {
  return {
    targetRole: row.target_role,
    sourceStack: row.source_stack,
    targetCompanies: row.target_companies ?? [],
    currentLevel: row.current_level,
    weeklyHours: row.weekly_hours,
    targetDate: row.target_date
      ? row.target_date instanceof Date
        ? row.target_date.toISOString().slice(0, 10)
        : String(row.target_date).slice(0, 10)
      : null,
    goals: row.goals,
    updatedAt: row.updated_at.toISOString()
  };
}

export async function getInterviewProfile(userId: string) {
  const result = await pool.query("select * from interview_profiles where user_id = $1", [userId]);
  return result.rows[0] ? mapInterviewProfile(result.rows[0]) : undefined;
}

export async function upsertInterviewProfile(userId: string, input: InterviewProfileUpdate) {
  const result = await pool.query(
    `
      insert into interview_profiles (
        user_id, target_role, source_stack, target_companies,
        current_level, weekly_hours, target_date, goals
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8)
      on conflict (user_id)
      do update set
        target_role = excluded.target_role,
        source_stack = excluded.source_stack,
        target_companies = excluded.target_companies,
        current_level = excluded.current_level,
        weekly_hours = excluded.weekly_hours,
        target_date = excluded.target_date,
        goals = excluded.goals,
        updated_at = now()
      returning *
    `,
    [
      userId,
      input.targetRole,
      input.sourceStack,
      input.targetCompanies,
      input.currentLevel,
      input.weeklyHours,
      input.targetDate,
      input.goals
    ]
  );
  return mapInterviewProfile(result.rows[0]);
}

function mapInterviewProgress(row: QueryResultRow): InterviewProgress {
  return {
    reportId: row.report_id,
    questionKey: row.question_key,
    status: row.status,
    confidence: row.confidence,
    notes: row.notes,
    nextReviewAt: row.next_review_at?.toISOString() ?? null,
    updatedAt: row.updated_at.toISOString()
  };
}

export async function listInterviewProgress(userId: string) {
  const result = await pool.query(
    `
      select *
      from interview_question_progress
      where user_id = $1
      order by next_review_at asc nulls last, updated_at desc
      limit 200
    `,
    [userId]
  );
  return result.rows.map(mapInterviewProgress);
}

export async function upsertInterviewProgress(userId: string, input: InterviewProgressUpdate) {
  const result = await pool.query(
    `
      insert into interview_question_progress (
        user_id, report_id, question_key, status, confidence, notes, next_review_at
      )
      values ($1, $2, $3, $4, $5, $6, $7)
      on conflict (user_id, report_id, question_key)
      do update set
        status = excluded.status,
        confidence = excluded.confidence,
        notes = excluded.notes,
        next_review_at = excluded.next_review_at,
        updated_at = now()
      returning *
    `,
    [
      userId,
      input.reportId,
      input.questionKey,
      input.status,
      input.confidence,
      input.notes,
      input.nextReviewAt
    ]
  );
  return mapInterviewProgress(result.rows[0]);
}

export async function appendAudit(input: {
  actorUserId?: string;
  eventType: string;
  details?: unknown;
}) {
  await pool.query(
    "insert into audit_logs (actor_user_id, event_type, details) values ($1, $2, $3)",
    [input.actorUserId ?? null, input.eventType, JSON.stringify(input.details ?? {})]
  );
}
