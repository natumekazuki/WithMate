import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  createRepositoryReadOperations,
  REPOSITORY_PAGE_SQL,
  REPOSITORY_SESSION_PAGE_SQL,
  RepositoryReadError,
} from "../src/persistence-worker/repository-read-model.js";

const repositoryTest = Number.parseInt(process.versions.node, 10) >= 24 ? test : test.skip;

repositoryTest("session page derives execution state with a bounded keyset cursor", () => {
  withDatabase((database) => {
    insertSession(database, "session-1", 30);
    insertSession(database, "session-2", 20);
    insertSession(database, "session-3", 10);
    insertMessage(database, "message-1", "session-1", 1, "[]");
    insertRun(database, "run-1", "session-1", "message-1", "active", 30);
    database.prepare("UPDATE runs SET updated_at = 99 WHERE id = 'run-1'").run();
    const operation = operationFor(database, "repository.sessions.page");

    const first = operation({ lifecycleStatus: "active", limit: 2 }) as PageResult;
    assert.deepEqual(
      first.items.map((item) => item.id),
      ["session-1", "session-2"],
    );
    assert.deepEqual(
      first.items.map((item) => item.executionState),
      ["running", "not_started"],
    );
    assert.deepEqual(
      first.items.map((item) => item.stateChangedAt),
      [30, 1],
    );
    assert.equal(typeof first.nextCursor, "string");

    const second = operation({
      lifecycleStatus: "active",
      limit: 2,
      cursor: first.nextCursor,
    }) as PageResult;
    assert.deepEqual(
      second.items.map((item) => item.id),
      ["session-3"],
    );
    assert.throws(
      () => operation({ workspaceKey: "other", lifecycleStatus: "active", cursor: first.nextCursor }),
      (error: unknown) => error instanceof RepositoryReadError && error.code === "cursor_invalid",
    );
  });
});

repositoryTest("Session detail preserves its Provider before the first Run", () => {
  withDatabase((database) => {
    insertSession(database, "session-without-run", 1);
    const detail = operationFor(
      database,
      "repository.session.get",
    )({
      sessionId: "session-without-run",
    }) as Readonly<Record<string, unknown>>;

    assert.deepEqual(detail, {
      session: {
        id: "session-without-run",
        title: "Session",
        providerId: "provider",
        workspaceKey: "workspace",
        workspacePath: path.resolve("workspace"),
        localRepositoryKey: null,
        repositoryName: null,
        allowedAdditionalDirectoriesByteLength: 2,
        allowedAdditionalDirectoriesState: "inline",
        allowedAdditionalDirectories: [],
        defaultCharacterId: "character",
        maxConcurrentChildRuns: 4,
        lifecycleStatus: "active",
        createdAt: 1,
        updatedAt: 1,
        lastActivityAt: 1,
      },
      execution: { state: "not_started" },
    });
  });
});

repositoryTest("Session pages are global by default and accept Workspace only as an optional filter", () => {
  withDatabase((database) => {
    insertSessionWithWorkspace(database, "session-workspace", "workspace", 20);
    insertSessionWithWorkspace(database, "session-other", "other", 10);
    const operation = operationFor(database, "repository.sessions.page");

    const global = operation({ limit: 10 }) as PageResult;
    assert.deepEqual(
      global.items.map((item) => item.id),
      ["session-workspace", "session-other"],
    );

    const filtered = operation({ workspaceKey: "other", limit: 10 }) as PageResult;
    assert.deepEqual(
      filtered.items.map((item) => item.id),
      ["session-other"],
    );
  });
});

repositoryTest("timeline and output summary remain bounded without hydrating payload BLOBs", () => {
  withDatabase((database) => {
    insertSession(database, "session-1", 1);
    const largeContent = JSON.stringify([{ type: "text", text: "x".repeat(70 * 1024) }]);
    insertMessage(database, "message-1", "session-1", 1, largeContent);
    for (let ordinal = 2; ordinal <= 6; ordinal += 1) {
      insertMessage(
        database,
        `message-${ordinal}`,
        "session-1",
        ordinal,
        JSON.stringify([{ type: "text", text: "x".repeat(60 * 1024) }]),
      );
    }
    insertRun(database, "run-1", "session-1", "message-1", "completed", 1);
    for (let ordinal = 1; ordinal <= 205; ordinal += 1) {
      database
        .prepare(
          `
        INSERT INTO run_output_items (
          id, run_id, ordinal, category, kind, summary, completion_state, payload_state,
          payload_original_byte_length, stored_payload_id, redaction_state, created_at
        ) VALUES (?, 'run-1', ?, 'operation', 'tool', 'summary', 'complete', 'none', NULL, NULL, 'not_required', ?)
      `,
        )
        .run(`output-${ordinal}`, ordinal, ordinal);
    }

    const messages = operationFor(
      database,
      "repository.messages.page",
    )({
      sessionId: "session-1",
      workspaceKey: "workspace",
    }) as PageResult;
    assert.equal(messages.items[0]?.contentState, "chunked");
    assert.equal(Object.hasOwn(messages.items[0] ?? {}, "contentBlocks"), false);
    assert.ok(messages.items.length < 6);
    assert.equal(typeof messages.nextCursor, "string");
    assert.ok(Buffer.byteLength(JSON.stringify(messages)) < 256 * 1024);

    const outputs = operationFor(
      database,
      "repository.run.outputs.page",
    )({
      sessionId: "session-1",
      runId: "run-1",
      workspaceKey: "workspace",
      limit: 200,
    }) as PageResult;
    assert.equal(outputs.items.length, 200);
    assert.equal(typeof outputs.nextCursor, "string");
    assert.equal(JSON.stringify(outputs).includes("content"), false);
  });
});

repositoryTest("child result rejects a relation whose child belongs to another workspace", () => {
  withDatabase((database) => {
    insertSession(database, "parent", 1);
    insertSession(database, "root", 1);
    insertSessionWithWorkspace(database, "child", "other", 1);
    insertMessage(database, "parent-message", "parent", 1, "[]");
    insertMessage(database, "child-message", "child", 1, "[]");
    insertRun(database, "parent-run", "parent", "parent-message", "completed", 1);
    insertRun(database, "child-run", "child", "child-message", "completed", 1);
    database
      .prepare(
        `
      INSERT INTO session_relations VALUES (
        'relation', 'parent', 'child', 'root', 'parent-run', 'correlation', NULL, NULL, 1)
    `,
      )
      .run();
    database
      .prepare(
        `
      INSERT INTO delegations VALUES (
        'delegation', 'relation', 'child-message', 'child-message', 'child-run', NULL,
        'closed', 'completed', 1, 1, 0)
    `,
      )
      .run();
    database
      .prepare(
        `
      INSERT INTO child_result_deliveries VALUES (
        'delivery', 'delegation', 1, 'child-run', 'available', 'completed', 'done', 1,
        NULL, NULL, 1, 1, 0)
    `,
      )
      .run();
    const childResults = operationFor(database, "repository.child-results.page");
    assert.throws(
      () =>
        childResults({
          parentSessionId: "parent",
          workspaceKey: "workspace",
          delegationId: "delegation",
        }),
      (error: unknown) => error instanceof RepositoryReadError && error.code === "not_found",
    );
  });
});

repositoryTest("run-scoped reads hide resources outside the requested workspace", () => {
  withDatabase((database) => {
    insertSession(database, "session-1", 1);
    insertMessage(database, "message-1", "session-1", 1, "[]");
    insertRun(database, "run-1", "session-1", "message-1", "completed", 1);
    const events = operationFor(database, "repository.run.events.page");
    assert.throws(
      () => events({ sessionId: "session-1", runId: "run-1", workspaceKey: "other" }),
      (error: unknown) => error instanceof RepositoryReadError && error.code === "not_found",
    );
  });
});

repositoryTest("pending Run Input delivery recovery is run-scoped, paged, and preserves dispatch state", () => {
  withDatabase((database) => {
    insertSession(database, "session-1", 1);
    insertMessage(database, "message-1", "session-1", 1, "[]");
    insertMessage(database, "input-pending", "session-1", 2, "[]");
    insertMessage(database, "input-dispatching", "session-1", 3, "[]");
    insertMessage(database, "input-accepted", "session-1", 4, "[]");
    insertRun(database, "run-1", "session-1", "message-1", "active", 1);
    database.exec(`
      BEGIN;
      INSERT INTO provider_bindings (
        id, session_id, ordinal, provider_id, external_conversation_id, persistence_mode,
        binding_state, created_by_run_attempt_id, created_at
      ) VALUES ('binding-1', 'session-1', 1, 'provider', 'conversation-1', 'persistent',
        'active', 'attempt-1', 1);
      INSERT INTO run_attempts (
        id, run_id, ordinal, provider_binding_id, attempt_reason, attempt_state,
        external_execution_id, created_at, started_at
      ) VALUES ('attempt-1', 'run-1', 1, 'binding-1', 'initial', 'active', 'execution-1', 1, 1);
      INSERT INTO run_input_deliveries VALUES
        ('input-pending', 'run-1', 'attempt-1', 'pending', NULL, 2, NULL, NULL),
        ('input-dispatching', 'run-1', 'attempt-1', 'dispatching', NULL, 3, 4, NULL),
        ('input-accepted', 'run-1', 'attempt-1', 'accepted', NULL, 5, 6, 7);
      COMMIT;
    `);

    const recoverInputs = operationFor(database, "repository.run.input-deliveries.page");
    const first = recoverInputs({
      sessionId: "session-1",
      runId: "run-1",
      workspaceKey: "workspace",
      limit: 1,
    }) as PageResult;
    assert.deepEqual(first.items, [
      {
        messageId: "input-pending",
        runId: "run-1",
        attemptId: "attempt-1",
        bindingId: "binding-1",
        deliveryState: "pending",
        createdAt: 2,
        dispatchingAt: null,
      },
    ]);
    assert.equal(typeof first.nextCursor, "string");

    const second = recoverInputs({
      sessionId: "session-1",
      runId: "run-1",
      workspaceKey: "workspace",
      cursor: first.nextCursor,
      limit: 1,
    }) as PageResult;
    assert.deepEqual(second.items, [
      {
        messageId: "input-dispatching",
        runId: "run-1",
        attemptId: "attempt-1",
        bindingId: "binding-1",
        deliveryState: "dispatching",
        createdAt: 3,
        dispatchingAt: 4,
      },
    ]);
    assert.equal(second.nextCursor, undefined);
    database.prepare("UPDATE provider_bindings SET provider_id = 'other-provider' WHERE id = 'binding-1'").run();
    const foreignBinding = recoverInputs({
      sessionId: "session-1",
      runId: "run-1",
      workspaceKey: "workspace",
      limit: 1,
    }) as PageResult;
    assert.equal(foreignBinding.items[0]?.bindingId, null);
    assert.throws(
      () =>
        recoverInputs({
          sessionId: "session-1",
          runId: "run-1",
          workspaceKey: "other",
        }),
      (error: unknown) => error instanceof RepositoryReadError && error.code === "not_found",
    );
  });
});

repositoryTest("cursor scope digest accepts long values and rejects NUL-delimited collisions", () => {
  withDatabase((database) => {
    const longWorkspace = "w".repeat(400);
    insertSessionWithWorkspace(database, "long-session", longWorkspace, 1);
    insertMessage(database, "long-message-1", "long-session", 1, "[]");
    insertMessage(database, "long-message-2", "long-session", 2, "[]");
    const messages = operationFor(database, "repository.messages.page");
    const first = messages({ sessionId: "long-session", workspaceKey: longWorkspace, limit: 1 }) as PageResult;
    assert.ok(first.nextCursor);
    const second = messages({
      sessionId: "long-session",
      workspaceKey: longWorkspace,
      limit: 1,
      cursor: first.nextCursor,
    }) as PageResult;
    assert.equal(second.items[0]?.ordinal, 2);

    insertSessionWithWorkspace(database, "b\0c", "a", 1);
    insertSessionWithWorkspace(database, "c", "a\0b", 1);
    insertMessage(database, "collision-a-1", "b\0c", 1, "[]");
    insertMessage(database, "collision-a-2", "b\0c", 2, "[]");
    insertMessage(database, "collision-b-1", "c", 1, "[]");
    const collisionCursor = (messages({ sessionId: "b\0c", workspaceKey: "a", limit: 1 }) as PageResult).nextCursor;
    assert.throws(
      () => messages({ sessionId: "c", workspaceKey: "a\0b", cursor: collisionCursor }),
      (error: unknown) => error instanceof RepositoryReadError && error.code === "cursor_invalid",
    );
  });
});

repositoryTest("session pages apply the byte budget and continue from the last included row", () => {
  withDatabase((database) => {
    const maximumSessionId = "z".repeat(1_024);
    insertSession(database, maximumSessionId, 200);
    for (let index = 0; index < 100; index += 1) {
      database
        .prepare(
          "INSERT INTO sessions VALUES (?, 'Session', 'provider', 'workspace', ?, NULL, NULL, '[]', ?, 4, 'active', 1, 1, ?)",
        )
        .run(`session-${String(index).padStart(3, "0")}`, path.resolve("workspace"), "c".repeat(3_000), index + 1);
    }
    const sessions = operationFor(database, "repository.sessions.page");
    const maximumIdPage = sessions({ workspaceKey: "workspace", limit: 1 }) as PageResult;
    assert.equal(maximumIdPage.items[0]?.id, maximumSessionId);
    assert.ok(maximumIdPage.nextCursor && maximumIdPage.nextCursor.length <= 2_048);
    assert.doesNotThrow(() => sessions({ workspaceKey: "workspace", limit: 1, cursor: maximumIdPage.nextCursor }));
    const first = sessions({ workspaceKey: "workspace", limit: 100 }) as PageResult;
    assert.ok(first.items.length < 100);
    assert.ok(Buffer.byteLength(JSON.stringify(first)) < 256 * 1024);
    assert.equal(typeof first.nextCursor, "string");
    const second = sessions({ workspaceKey: "workspace", limit: 100, cursor: first.nextCursor }) as PageResult;
    assert.ok(second.items.length > 0);
    assert.throws(
      () => insertSession(database, "x".repeat(1_025), 300),
      (error: unknown) => error instanceof Error && error.message.includes("CHECK constraint failed"),
    );
  });
});

repositoryTest("Session schema accepts the exact child Run limit and rejects values above the durable maximum", () => {
  withDatabase((database) => {
    database
      .prepare(
        "INSERT INTO sessions VALUES (?, 'Session', 'provider', 'workspace', ?, NULL, NULL, '[]', 'character', ?, 'active', 1, 1, 1)",
      )
      .run("session-exact-limit", path.resolve("workspace"), 1_024);
    assert.throws(
      () =>
        database
          .prepare(
            "INSERT INTO sessions VALUES (?, 'Session', 'provider', 'workspace', ?, NULL, NULL, '[]', 'character', ?, 'active', 1, 1, 1)",
          )
          .run("session-over-limit", path.resolve("workspace"), 1_025),
      (error: unknown) => error instanceof Error && error.message.includes("CHECK constraint failed"),
    );
    assert.throws(
      () =>
        database
          .prepare("UPDATE sessions SET max_concurrent_child_runs = ? WHERE id = 'session-exact-limit'")
          .run(1_025),
      (error: unknown) => error instanceof Error && error.message.includes("CHECK constraint failed"),
    );
  });
});

repositoryTest("public RunEvent omits internal fields and advances past an oversize first row explicitly", () => {
  withDatabase((database) => {
    insertSession(database, "session-1", 1);
    insertMessage(database, "message-1", "session-1", 1, "[]");
    insertRun(database, "run-1", "session-1", "message-1", "completed", 1);
    database
      .prepare("INSERT INTO run_events VALUES (?, 'run-1', ?, 'event', 'item', ?, ?, 'summary', ?)")
      .run("event-1", 1, "s".repeat(200 * 1024), "d".repeat(300 * 1024), 1);
    database
      .prepare("INSERT INTO run_events VALUES ('event-2', 'run-1', 2, 'event', NULL, NULL, 'dedupe', 'ok', 2)")
      .run();
    const result = operationFor(
      database,
      "repository.run.events.page",
    )({
      sessionId: "session-1",
      runId: "run-1",
      workspaceKey: "workspace",
    }) as RunEventPageResult;
    assert.deepEqual(result.items[0], { omitted: true, reason: "response_size_limit", ordinal: 1 });
    assert.equal(result.items[1]?.id, "event-2");
    assert.equal(Object.hasOwn(result.items[1] ?? {}, "dedupeKey"), false);
    assert.equal(Object.hasOwn(result.items[1] ?? {}, "workspaceKey"), false);
    assert.equal(typeof result.continuationCursor, "string");
    assert.equal(result.hasMore, false);

    database
      .prepare("INSERT INTO run_events VALUES ('event-3', 'run-1', 3, 'event', NULL, NULL, NULL, 'later', 3)")
      .run();
    const continuation = operationFor(
      database,
      "repository.run.events.page",
    )({
      sessionId: "session-1",
      runId: "run-1",
      workspaceKey: "workspace",
      cursor: result.continuationCursor,
    }) as RunEventPageResult;
    assert.deepEqual(
      continuation.items.map((item) => item.id),
      ["event-3"],
    );
    assert.equal(continuation.hasMore, false);
  });
});

repositoryTest("RunEvent continuation is usable when the initial page is empty", () => {
  withDatabase((database) => {
    insertSession(database, "session-empty", 1);
    insertMessage(database, "message-empty", "session-empty", 1, "[]");
    insertRun(database, "run-empty", "session-empty", "message-empty", "active", 1);
    const operation = operationFor(database, "repository.run.events.page");
    const empty = operation({
      sessionId: "session-empty",
      runId: "run-empty",
      workspaceKey: "workspace",
    }) as RunEventPageResult;
    assert.deepEqual(empty.items, []);
    assert.equal(typeof empty.continuationCursor, "string");
    assert.equal(empty.hasMore, false);

    database
      .prepare(
        "INSERT INTO run_events VALUES ('event-after-empty', 'run-empty', 1, 'event', NULL, NULL, NULL, 'later', 2)",
      )
      .run();
    const next = operation({
      sessionId: "session-empty",
      runId: "run-empty",
      workspaceKey: "workspace",
      cursor: empty.continuationCursor,
    }) as RunEventPageResult;
    assert.deepEqual(
      next.items.map((item) => item.id),
      ["event-after-empty"],
    );
  });
});

repositoryTest("representative ordinal queries use covering indexes and never scan payloads", () => {
  withDatabase((database) => {
    const plans = [
      database.prepare(`EXPLAIN QUERY PLAN ${REPOSITORY_SESSION_PAGE_SQL.all}`).all(null, null, null, null, 10),
      database
        .prepare(`EXPLAIN QUERY PLAN ${REPOSITORY_SESSION_PAGE_SQL.lifecycle}`)
        .all("active", null, null, null, null, 10),
      database
        .prepare(`EXPLAIN QUERY PLAN ${REPOSITORY_SESSION_PAGE_SQL.workspace}`)
        .all("workspace", null, null, null, null, 10),
      database
        .prepare(`EXPLAIN QUERY PLAN ${REPOSITORY_SESSION_PAGE_SQL.workspaceLifecycle}`)
        .all("workspace", "active", null, null, null, null, 10),
      database.prepare(`EXPLAIN QUERY PLAN ${REPOSITORY_PAGE_SQL.messages}`).all(1024, "s", "w", 0, 10),
      database.prepare(`EXPLAIN QUERY PLAN ${REPOSITORY_PAGE_SQL.runEvents}`).all("r", "s", "w", 0, 10),
      database.prepare(`EXPLAIN QUERY PLAN ${REPOSITORY_PAGE_SQL.runOutputs}`).all("r", "s", "w", 0, 10),
      database
        .prepare(`EXPLAIN QUERY PLAN ${REPOSITORY_PAGE_SQL.runOutputsByCategory}`)
        .all("r", "s", "w", "operation", 0, 10),
    ].flat() as unknown as readonly Readonly<{ detail: string }>[];
    const details = plans.map((row) => row.detail).join("\n");
    assert.match(details, /sessions_activity_idx/u);
    assert.match(details, /sessions_lifecycle_activity_idx/u);
    assert.match(details, /sessions_workspace_activity_idx/u);
    assert.match(details, /messages_session_ordinal_uq/u);
    assert.match(details, /run_events_run_ordinal_uq/u);
    assert.match(details, /run_output_items_run_ordinal_uq/u);
    assert.match(details, /run_output_items_run_category_ordinal_idx/u);
    assert.doesNotMatch(details, /run_output_payloads/u);
    assert.doesNotMatch(details, /USE TEMP B-TREE FOR ORDER BY/u);
  });
});

repositoryTest("Session deletion status resolves pending and completed workspace bindings by deletion ID", () => {
  withDatabase((database) => {
    const pendingToken = "018f1f4e-7f0a-7000-8000-000000000449";
    const completedToken = "018f1f4e-7f0a-7000-8000-000000000450";
    database
      .prepare(
        `
        INSERT INTO session_deletion_manifests (
          deletion_id, workspace_key, root_session_id, request_fingerprint, deleted_session_count, created_at
        ) VALUES (?, 'pending-workspace', 'deleted-root', ?, 3, 1)
      `,
      )
      .run(pendingToken, "a".repeat(64));
    database
      .prepare(
        `
        INSERT INTO session_deletion_completion_tombstones (
          deletion_id, workspace_key, request_fingerprint, deleted_session_count, completed_at
        ) VALUES (?, 'completed-workspace', ?, 2, 2)
      `,
      )
      .run(completedToken, "b".repeat(64));
    const status = operationFor(database, "repository.session-deletion.status.get");

    assert.deepEqual(status({ cleanupToken: pendingToken }), {
      cleanupToken: pendingToken,
      workspaceKey: "pending-workspace",
      deletedSessionCount: 3,
      localOnly: true,
      status: "pending",
    });
    assert.deepEqual(status({ cleanupToken: completedToken }), {
      cleanupToken: completedToken,
      workspaceKey: "completed-workspace",
      deletedSessionCount: 2,
      localOnly: true,
      status: "completed",
    });
  });
});

repositoryTest("Session deletion status rejects invalid, missing, and expanded requests", () => {
  withDatabase((database) => {
    const status = operationFor(database, "repository.session-deletion.status.get");

    assert.throws(
      () => status({ cleanupToken: "not-a-uuid" }),
      (error: unknown) => error instanceof RepositoryReadError && error.code === "request_invalid",
    );
    assert.throws(
      () => status({ cleanupToken: "018f1f4e-7f0a-7000-8000-000000000448" }),
      (error: unknown) => error instanceof RepositoryReadError && error.code === "not_found",
    );
    assert.throws(
      () => status({ cleanupToken: "018f1f4e-7f0a-7000-8000-000000000448", workspaceKey: "workspace" }),
      (error: unknown) => error instanceof RepositoryReadError && error.code === "request_invalid",
    );
  });
});

repositoryTest("Session deletion cleanup manifest is recoverable through bounded pages", () => {
  withDatabase((database) => {
    const cleanupToken = "018f1f4e-7f0a-7000-8000-000000000451";
    database
      .prepare(
        `
        INSERT INTO session_deletion_manifests (
          deletion_id, workspace_key, root_session_id, request_fingerprint, deleted_session_count, created_at
        ) VALUES (?, 'workspace', 'deleted-root', ?, 3, 1)
      `,
      )
      .run(cleanupToken, "a".repeat(64));
    const insert = database.prepare(
      "INSERT INTO session_deletion_items (deletion_id, ordinal, session_id) VALUES (?, ?, ?)",
    );
    for (const [ordinal, sessionId] of ["deleted-root", "deleted-child-a", "deleted-child-b"].entries()) {
      insert.run(cleanupToken, ordinal + 1, sessionId);
    }
    const cleanup = operationFor(database, "repository.session-deletion.cleanup.page");
    const first = cleanup({ cleanupToken, workspaceKey: "workspace", limit: 2 }) as PageResult &
      Record<string, unknown>;
    assert.deepEqual(first.items, [
      { ordinal: 1, sessionId: "deleted-root" },
      { ordinal: 2, sessionId: "deleted-child-a" },
    ]);
    assert.equal(first.deletedSessionCount, 3);
    assert.equal(first.localOnly, true);
    assert.equal(typeof first.nextCursor, "string");
    const second = cleanup({
      cleanupToken,
      workspaceKey: "workspace",
      cursor: first.nextCursor,
      limit: 2,
    }) as PageResult;
    assert.deepEqual(second.items, [{ ordinal: 3, sessionId: "deleted-child-b" }]);
    assert.throws(
      () => cleanup({ cleanupToken, workspaceKey: "other-workspace" }),
      (error: unknown) => error instanceof RepositoryReadError && error.code === "not_found",
    );
  });
});

repositoryTest("recovery projection finds a creating Binding and preserves nullable fields", () => {
  withDatabase((database) => {
    insertSession(database, "recovery-session", 1);
    insertMessage(database, "recovery-message", "recovery-session", 1, "[]");
    database.exec(`
      BEGIN;
      INSERT INTO runs (
        id, session_id, ordinal, initiating_message_id, phase, execution_snapshot_json,
        external_side_effect_state, created_at, updated_at, version
      ) VALUES ('recovery-run', 'recovery-session', 1, 'recovery-message', 'queued', '{}', 'unknown', 1, 1, 0);
      INSERT INTO provider_bindings (
        id, session_id, ordinal, provider_id, persistence_mode, binding_state,
        created_by_run_attempt_id, created_at
      ) VALUES ('recovery-binding', 'recovery-session', 1, 'provider', 'persistent', 'creating',
        'recovery-attempt', 1);
      INSERT INTO run_attempts (
        id, run_id, ordinal, provider_binding_id, attempt_reason, attempt_state, created_at
      ) VALUES ('recovery-attempt', 'recovery-run', 1, NULL, 'initial', 'preparing', 1);
      INSERT INTO run_dispatches (
        run_attempt_id, dispatch_state, request_fingerprint, created_at
      ) VALUES ('recovery-attempt', 'pending', '${"a".repeat(64)}', 1);
      COMMIT;
    `);

    const recovery = operationFor(
      database,
      "repository.recovery.get",
    )({
      sessionId: "recovery-session",
      runId: "recovery-run",
      workspaceKey: "workspace",
    }) as Readonly<Record<string, unknown>>;

    assert.equal(recovery.bindingId, "recovery-binding");
    assert.equal(recovery.bindingState, "creating");
    for (const key of ["externalExecutionId", "externalConversationId", "providerIdempotencyKey"] as const) {
      assert.equal(Object.hasOwn(recovery, key), true);
      assert.equal(recovery[key], null);
    }

    insertMessage(database, "recovery-terminal-message", "recovery-session", 2, "[]");
    database
      .prepare(
        `
        INSERT INTO runs (
          id, session_id, ordinal, initiating_message_id, phase, execution_snapshot_json,
          external_side_effect_state, created_at, terminal_at, updated_at, version
        ) VALUES ('recovery-terminal-run', 'recovery-session', 2, 'recovery-terminal-message',
          'canceled', '{}', 'none', 2, 2, 2, 0)
      `,
      )
      .run();
    const withoutAttempt = operationFor(
      database,
      "repository.recovery.get",
    )({
      sessionId: "recovery-session",
      runId: "recovery-terminal-run",
      workspaceKey: "workspace",
    }) as Readonly<Record<string, unknown>>;
    for (const key of [
      "attemptId",
      "attemptOrdinal",
      "attemptState",
      "externalExecutionId",
      "bindingId",
      "providerId",
      "persistenceMode",
      "bindingState",
      "externalConversationId",
      "dispatchState",
      "providerIdempotencyKey",
    ] as const) {
      assert.equal(Object.hasOwn(withoutAttempt, key), true);
      assert.equal(withoutAttempt[key], null);
    }
  });
});

repositoryTest("recovery projection hides Bindings outside the Run owner tuple", () => {
  for (const scenario of ["foreign_creator_session", "foreign_provider"] as const) {
    withDatabase((database) => {
      insertSession(database, "recovery-session", 1);
      insertSession(database, "creator-session", 1);
      insertMessage(database, "recovery-message", "recovery-session", 1, "[]");
      insertMessage(database, "creator-message", "creator-session", 1, "[]");
      const bindingProvider = scenario === "foreign_provider" ? "other-provider" : "provider";
      const creatorAttemptId = scenario === "foreign_creator_session" ? "creator-attempt" : "recovery-attempt";
      const directBindingId = scenario === "foreign_creator_session" ? "'foreign-binding'" : "NULL";
      database.exec(`
        BEGIN;
        INSERT INTO runs (
          id, session_id, ordinal, initiating_message_id, phase, execution_snapshot_json,
          external_side_effect_state, created_at, updated_at, version
        ) VALUES
          ('recovery-run', 'recovery-session', 1, 'recovery-message', 'queued', '{}', 'unknown', 1, 1, 0),
          ('creator-run', 'creator-session', 1, 'creator-message', 'queued', '{}', 'unknown', 1, 1, 0);
        INSERT INTO run_attempts (
          id, run_id, ordinal, provider_binding_id, attempt_reason, attempt_state, created_at
        ) VALUES
          ('recovery-attempt', 'recovery-run', 1, ${directBindingId}, 'initial', 'preparing', 1),
          ('creator-attempt', 'creator-run', 1, NULL, 'initial', 'preparing', 1);
        INSERT INTO provider_bindings (
          id, session_id, ordinal, provider_id, external_conversation_id, persistence_mode,
          binding_state, created_by_run_attempt_id, created_at
        ) VALUES (
          'foreign-binding', 'recovery-session', 1, '${bindingProvider}', 'foreign-conversation', 'persistent',
          'active', '${creatorAttemptId}', 1
        );
        INSERT INTO run_dispatches (
          run_attempt_id, dispatch_state, request_fingerprint, created_at
        ) VALUES ('recovery-attempt', 'pending', '${"b".repeat(64)}', 1);
        COMMIT;
      `);

      const recovery = operationFor(
        database,
        "repository.recovery.get",
      )({
        sessionId: "recovery-session",
        runId: "recovery-run",
        workspaceKey: "workspace",
      }) as Readonly<Record<string, unknown>>;

      assert.equal(recovery.attemptId, "recovery-attempt");
      assert.equal(recovery.dispatchState, "pending");
      for (const key of [
        "bindingId",
        "providerId",
        "persistenceMode",
        "bindingState",
        "externalConversationId",
      ] as const) {
        assert.equal(recovery[key], null);
      }
    });
  }
});

repositoryTest("recovery projections hide an ephemeral Binding created by another Attempt", () => {
  withDatabase((database) => {
    insertSession(database, "recovery-session", 1);
    insertMessage(database, "creator-message", "recovery-session", 1, "[]");
    insertMessage(database, "recovery-message", "recovery-session", 2, "[]");
    insertMessage(database, "input-message", "recovery-session", 3, "[]");
    database.exec(`
      BEGIN;
      INSERT INTO runs (
        id, session_id, ordinal, initiating_message_id, phase, execution_snapshot_json,
        external_side_effect_state, created_at, terminal_at, updated_at, version
      ) VALUES
        ('creator-run', 'recovery-session', 1, 'creator-message', 'canceled', '{}', 'unknown', 1, 2, 2, 0),
        ('recovery-run', 'recovery-session', 2, 'recovery-message', 'queued', '{}', 'unknown', 3, NULL, 3, 0);
      INSERT INTO run_attempts (
        id, run_id, ordinal, provider_binding_id, attempt_reason, attempt_state,
        failure_origin, created_at, terminal_at
      ) VALUES
        ('creator-attempt', 'creator-run', 1, NULL, 'initial', 'interrupted', 'application', 1, 2),
        ('recovery-attempt', 'recovery-run', 1, 'ephemeral-binding', 'initial', 'preparing', NULL, 3, NULL);
      INSERT INTO provider_bindings (
        id, session_id, ordinal, provider_id, external_conversation_id, persistence_mode,
        binding_state, created_by_run_attempt_id, created_at
      ) VALUES (
        'ephemeral-binding', 'recovery-session', 1, 'provider', 'foreign-conversation', 'ephemeral',
        'active', 'creator-attempt', 1
      );
      INSERT INTO run_dispatches (
        run_attempt_id, dispatch_state, request_fingerprint, created_at, dispatching_at, resolved_at
      ) VALUES ('recovery-attempt', 'ambiguous', '${"c".repeat(64)}', 3, 4, 5);
      INSERT INTO run_input_deliveries (
        message_id, run_id, run_attempt_id, delivery_state, created_at
      ) VALUES ('input-message', 'recovery-run', 'recovery-attempt', 'pending', 6);
      COMMIT;
    `);

    const recovery = operationFor(
      database,
      "repository.recovery.get",
    )({
      sessionId: "recovery-session",
      runId: "recovery-run",
      workspaceKey: "workspace",
    }) as Readonly<Record<string, unknown>>;
    assert.equal(recovery.bindingId, null);
    assert.equal(recovery.externalConversationId, null);
    assert.equal(recovery.dispatchState, "ambiguous");

    const deliveries = operationFor(
      database,
      "repository.run.input-deliveries.page",
    )({
      sessionId: "recovery-session",
      runId: "recovery-run",
      workspaceKey: "workspace",
    }) as PageResult;
    assert.equal(deliveries.items[0]?.bindingId, null);
  });
});

function operationFor(database: DatabaseSync, name: string) {
  const operation = createRepositoryReadOperations(database).get(name);
  assert.ok(operation);
  return (payload: Readonly<Record<string, unknown>>) => operation.execute(payload).result;
}

function withDatabase(run: (database: DatabaseSync) => void): void {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(fs.readFileSync(new URL("../schema/sqlite/v1.sql", import.meta.url), "utf8"));
    run(database);
  } finally {
    database.close();
  }
}

function insertSession(database: DatabaseSync, id: string, activity: number): void {
  insertSessionWithWorkspace(database, id, "workspace", activity);
}

function insertSessionWithWorkspace(database: DatabaseSync, id: string, workspaceKey: string, activity: number): void {
  database
    .prepare(
      "INSERT INTO sessions VALUES (?, 'Session', 'provider', ?, ?, NULL, NULL, '[]', 'character', 4, 'active', 1, ?, ?)",
    )
    .run(id, workspaceKey, path.resolve(workspaceKey), activity, activity);
}

function insertMessage(database: DatabaseSync, id: string, sessionId: string, ordinal: number, content: string): void {
  database.prepare("INSERT INTO messages VALUES (?, ?, ?, 'user', ?, ?)").run(id, sessionId, ordinal, content, ordinal);
}

function insertRun(
  database: DatabaseSync,
  id: string,
  sessionId: string,
  messageId: string,
  phase: "active" | "completed",
  timestamp: number,
): void {
  database
    .prepare(
      `
    INSERT INTO runs (
      id, session_id, ordinal, initiating_message_id, phase, execution_snapshot_json,
      external_side_effect_state, created_at, started_at, terminal_at, updated_at, version
    ) VALUES (?, ?, 1, ?, ?, '{}', 'none', ?, ?, ?, ?, 0)
  `,
    )
    .run(id, sessionId, messageId, phase, timestamp, timestamp, phase === "completed" ? timestamp : null, timestamp);
}

type PageResult = Readonly<{
  items: readonly Readonly<Record<string, unknown>>[];
  nextCursor?: string;
}>;

type RunEventPageResult = Readonly<{
  items: readonly Readonly<Record<string, unknown>>[];
  continuationCursor: string;
  hasMore: boolean;
}>;
