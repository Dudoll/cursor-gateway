import assert from "node:assert/strict";
import test from "node:test";

const databaseUrl = process.env.TEST_DATABASE_URL;

test(
  "Postgres enforces capacity, activity, deadlines, and idempotency",
  { skip: !databaseUrl },
  async () => {
    process.env.NODE_ENV = "test";
    process.env.PUBLIC_ORIGIN = "https://gateway.test";
    process.env.JWT_SECRET = "j".repeat(32);
    process.env.DATABASE_URL = databaseUrl;
    process.env.RUNNER_SHARED_SECRET = "r".repeat(32);

    const {
      cancelRun,
      claimNextRun,
      expireCsapiRuns,
      finishRun,
      migrate,
      pool,
      renewRunLease,
      updateRunProgress,
      upsertServicePrincipal
    } = await import("../src/db.js");
    const { createDbBackend } = await import("../src/csapi/backend.js");
    await migrate();
    const lifecycleColumns = await pool.query(
      `
        select column_name, is_nullable, column_default
        from information_schema.columns
        where table_schema = current_schema()
          and table_name = 'runs'
          and column_name = any($1::text[])
      `,
      [["queued_at", "last_activity_at", "cancel_reason", "csapi_key_id"]]
    );
    const columns = new Map(
      lifecycleColumns.rows.map((row) => [row.column_name, row])
    );
    assert.equal(columns.get("queued_at")?.is_nullable, "NO");
    assert.match(String(columns.get("queued_at")?.column_default), /now\(\)/);
    assert.ok(columns.has("last_activity_at"));
    assert.ok(columns.has("cancel_reason"));
    assert.equal(columns.get("csapi_key_id")?.is_nullable, "YES");

    const suffix = globalThis.crypto.randomUUID().slice(0, 8);
    const userId = (await upsertServicePrincipal("csapi", "operator")).id;
    const workspaceId = `csapi-capacity-${suffix}`;
    const runnerId = `capacity-runner-${suffix}`;
    const conversationIds = Array.from(
      { length: 7 },
      () => globalThis.crypto.randomUUID()
    );
    const idempotencyConversationIds = Array.from(
      { length: 6 },
      () => globalThis.crypto.randomUUID()
    );
    const runIds = Array.from({ length: 7 }, () => globalThis.crypto.randomUUID());

    try {
      await pool.query(
        `
          insert into workspaces (id, label, path, writable)
          values ($1, 'CSAPI capacity test', '/tmp', false)
        `,
        [workspaceId]
      );
      for (let index = 0; index < runIds.length; index += 1) {
        await pool.query(
          `
            insert into conversations (id, user_id, workspace_id, title)
            values ($1, $2, $3, 'capacity')
          `,
          [conversationIds[index], userId, workspaceId]
        );
        await pool.query(
          `
            insert into runs (
              id, conversation_id, user_id, origin, status, model,
              workspace_id, prompt, allow_writes, content_mode, queued_at
            )
            values (
              $1, $2, $3, 'automation', 'queued', $4, $5, 'hold', false,
              'plaintext', now() - make_interval(secs => $6::double precision)
            )
          `,
          [
            runIds[index],
            conversationIds[index],
            userId,
            `hermes:capacity-${suffix}`,
            workspaceId,
            runIds.length - index
          ]
        );
      }
      for (const conversationId of idempotencyConversationIds) {
        await pool.query(
          `
            insert into conversations (id, user_id, workspace_id, title)
            values ($1, $2, $3, 'idempotency')
          `,
          [conversationId, userId, workspaceId]
        );
      }

      const claims = await Promise.all(
        Array.from({ length: 7 }, () =>
          claimNextRun("hermes", runnerId, 6)
        )
      );
      const claimed = claims.filter(
        (claim): claim is NonNullable<typeof claim> => Boolean(claim)
      );
      assert.equal(claimed.length, 6);
      assert.equal(new Set(claimed.map((claim) => claim.run.id)).size, 6);
      assert.equal(new Set(claimed.map((claim) => claim.leaseId)).size, 6);
      assert.equal(
        await claimNextRun(
          "hermes",
          `duplicate-identity-${suffix}`,
          6
        ),
        undefined,
        "a second runner identity must not create 6+6 capacity"
      );
      const activityResults = await Promise.all(
        claimed.flatMap((claim, index) => [
          renewRunLease({
            runId: claim.run.id,
            runnerId,
            leaseId: claim.leaseId
          }),
          updateRunProgress({
            runId: claim.run.id,
            runnerId,
            leaseId: claim.leaseId,
            kind: "working",
            message: `capacity progress ${index}`
          })
        ])
      );
      assert.ok(activityResults.every(Boolean));
      const capacity = (
        await pool.query(
          `
            select
              count(*)::integer as running,
              count(distinct id)::integer as distinct_runs,
              count(distinct claim_lease_id)::integer as distinct_leases,
              max(claim_attempts)::integer as max_attempts
            from runs
            where claimed_by = $1 and status = 'running'
          `,
          [runnerId]
        )
      ).rows[0];
      assert.deepEqual(
        {
          running: capacity?.running,
          distinctRuns: capacity?.distinct_runs,
          distinctLeases: capacity?.distinct_leases,
          maxAttempts: capacity?.max_attempts
        },
        {
          running: 6,
          distinctRuns: 6,
          distinctLeases: 6,
          maxAttempts: 1
        }
      );

      const sample = claimed[0]!;
      assert.ok(sample.run.queuedAt);
      assert.ok(sample.run.startedAt);
      assert.ok(sample.run.lastActivityAt);
      assert.equal(sample.run.cancelReason, null);

      await pool.query(
        `
          update runs
          set updated_at = '2000-01-01T00:00:00Z',
              last_activity_at = '2001-01-01T00:00:00Z'
          where id = $1
        `,
        [sample.run.id]
      );
      assert.equal(
        await renewRunLease({
          runId: sample.run.id,
          runnerId,
          leaseId: sample.leaseId
        }),
        true
      );
      const renewed = await pool.query(
        "select updated_at, last_activity_at from runs where id = $1",
        [sample.run.id]
      );
      assert.equal(
        renewed.rows[0]?.updated_at.toISOString(),
        "2000-01-01T00:00:00.000Z"
      );
      assert.ok(renewed.rows[0]?.last_activity_at > renewed.rows[0]?.updated_at);

      const progressRun = claimed[3]!;
      await pool.query(
        `
          update runs
          set updated_at = now() - interval '3 minutes',
              last_activity_at = now() - interval '3 minutes'
          where id = $1
        `,
        [progressRun.run.id]
      );
      assert.equal(
        await updateRunProgress({
          runId: progressRun.run.id,
          runnerId,
          leaseId: progressRun.leaseId,
          kind: "thinking",
          message: "fresh progress"
        }),
        true
      );

      const guardedRun = claimed[4]!;
      await pool.query(
        "update runs set last_activity_at = now() - interval '3 minutes' where id = $1",
        [guardedRun.run.id]
      );
      await assert.rejects(
        cancelRun(guardedRun.run.id, userId, "idle_timeout"),
        /csapi_timeout_guard_required/
      );
      assert.equal(
        await renewRunLease({
          runId: guardedRun.run.id,
          runnerId,
          leaseId: guardedRun.leaseId
        }),
        true
      );
      assert.equal(
        await cancelRun(guardedRun.run.id, userId, "idle_timeout", 120_000),
        undefined
      );

      const claimedIds = new Set(claimed.map((claim) => claim.run.id));
      const queuedRunId = runIds.find((runId) => !claimedIds.has(runId))!;
      assert.equal(queuedRunId, runIds[6]);
      const absoluteRun = claimed[1]!;
      const requeuedRun = claimed[5]!;
      await pool.query(
        `
          update runs
          set started_at = now() - interval '10 minutes',
              last_activity_at = now() - interval '3 minutes'
          where id = $1
        `,
        [sample.run.id]
      );
      await pool.query(
        `
          update runs
          set started_at = now() - interval '30 minutes',
              last_activity_at = now()
          where id = $1
        `,
        [absoluteRun.run.id]
      );
      await pool.query(
        `
          update runs
          set queued_at = now() - interval '31 seconds'
          where id = $1
        `,
        [queuedRunId]
      );
      await pool.query(
        `
          update runs
          set status = 'queued',
              started_at = now() - interval '10 minutes',
              queued_at = now() - interval '31 seconds',
              last_activity_at = null,
              progress = null,
              progress_kind = null,
              claim_lease_id = null,
              claimed_by = null
          where id = $1
        `,
        [requeuedRun.run.id]
      );
      const expired = await expireCsapiRuns({
        queueTimeoutMs: 30_000,
        idleTimeoutMs: 120_000,
        absoluteTimeoutMs: 29 * 60_000
      });
      assert.ok(expired.queueTimeout >= 1);
      assert.ok(expired.idleTimeout >= 1);
      assert.ok(expired.absoluteTimeout >= 1);
      const reasons = await pool.query(
        "select id, cancel_reason from runs where id = any($1::uuid[])",
        [[sample.run.id, absoluteRun.run.id, queuedRunId, requeuedRun.run.id]]
      );
      assert.deepEqual(
        new Map(reasons.rows.map((row) => [row.id, row.cancel_reason])),
        new Map([
          [sample.run.id, "idle_timeout"],
          [absoluteRun.run.id, "absolute_timeout"],
          [queuedRunId, "queue_timeout"],
          [requeuedRun.run.id, "queue_timeout"]
        ])
      );
      assert.equal(
        await renewRunLease({
          runId: sample.run.id,
          runnerId,
          leaseId: sample.leaseId
        }),
        false
      );
      assert.equal(
        (
          await pool.query("select status from runs where id = $1", [
            progressRun.run.id
          ])
        ).rows[0]?.status,
        "running"
      );

      const callerCancelled = await cancelRun(
        claimed[2]!.run.id,
        userId,
        "caller_cancelled"
      );
      assert.equal(callerCancelled?.cancelReason, "caller_cancelled");
      assert.equal(callerCancelled?.status, "cancelled");

      const backend = await createDbBackend();
      const idempotencyKey = `csapi-db-idempotency-${suffix}`;
      const csapiKeyId = `k_db_${suffix}`;
      const idempotentHandles = await Promise.all(
        idempotencyConversationIds.map((conversationId) =>
          backend.createRun({
            principalId: userId,
            conversationId,
            model: `hermes:idempotency-${suffix}`,
            workspaceId,
            prompt: "idempotent database run",
            allowWrites: false,
            keyId: csapiKeyId,
            idempotencyKey
          })
        )
      );
      const idempotentRunIds = new Set(
        idempotentHandles.map((handle) => handle.runId)
      );
      assert.equal(idempotentRunIds.size, 1);
      assert.equal(
        (
          await pool.query(
            "select count(*)::integer as count from runs where user_id = $1 and idempotency_key = $2",
            [userId, idempotencyKey]
          )
        ).rows[0]?.count,
        1
      );

      const idempotentRunId = idempotentHandles[0]!.runId;
      const idempotentClaim = await claimNextRun(
        "hermes",
        `idempotency-runner-${suffix}`,
        6
      );
      assert.equal(idempotentClaim?.run.id, idempotentRunId);
      const firstTerminal = await finishRun({
        runId: idempotentRunId,
        runnerId: `idempotency-runner-${suffix}`,
        leaseId: idempotentClaim!.leaseId,
        status: "finished",
        response: "stable terminal response",
        error: null,
        inputTokens: 7,
        outputTokens: 5
      });
      const replayedTerminal = await finishRun({
        runId: idempotentRunId,
        runnerId: `idempotency-runner-${suffix}`,
        leaseId: idempotentClaim!.leaseId,
        status: "finished",
        response: "stable terminal response",
        error: null,
        inputTokens: 7,
        outputTokens: 5
      });
      assert.equal(firstTerminal?.status, "finished");
      assert.equal(replayedTerminal?.id, firstTerminal?.id);
      assert.equal(
        await finishRun({
          runId: idempotentRunId,
          runnerId: `idempotency-runner-${suffix}`,
          leaseId: idempotentClaim!.leaseId,
          status: "finished",
          response: "different terminal response",
          error: null,
          inputTokens: 7,
          outputTokens: 5
        }),
        undefined
      );
      const reattached = await backend.createRun({
        principalId: userId,
        conversationId: idempotencyConversationIds[0]!,
        model: `hermes:idempotency-${suffix}`,
        workspaceId,
        prompt: "retry must not create another run",
        allowWrites: false,
        keyId: csapiKeyId,
        idempotencyKey
      });
      assert.equal(reattached.runId, idempotentRunId);
      assert.equal(reattached.status, "finished");
      const observed = await backend.observeByIdempotencyKey(
        idempotencyKey,
        userId,
        csapiKeyId
      );
      assert.equal(observed.length, 1);
      assert.equal(observed[0]?.runId, idempotentRunId);
      assert.equal(observed[0]?.terminal, true);
      assert.equal(observed[0]?.claimAttempts, 1);
      assert.equal(observed[0]?.applicationStatusCode, "CSAPI_COMPLETED");
      assert.equal(observed[0]?.provider, "hermes");
      assert.equal(
        await backend.observeByRunId(
          idempotentRunId,
          userId,
          "k_foreign"
        ),
        undefined
      );
      assert.deepEqual(
        await backend.observeByIdempotencyKey(
          idempotencyKey,
          userId,
          "k_foreign"
        ),
        []
      );
    } finally {
      await pool.query("delete from runs where workspace_id = $1", [workspaceId]);
      await pool.query("delete from conversations where workspace_id = $1", [
        workspaceId
      ]);
      await pool.query("delete from workspaces where id = $1", [workspaceId]);
      await pool.end();
    }
  }
);
