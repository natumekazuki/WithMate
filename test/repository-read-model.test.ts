import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  createRepositoryReadOperations,
  REPOSITORY_PAGE_SQL,
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
    const operation = operationFor(database, "repository.sessions.page");

    const first = operation({ workspaceKey: "workspace", lifecycleStatus: "active", limit: 2 }) as PageResult;
    assert.deepEqual(
      first.items.map((item) => item.id),
      ["session-1", "session-2"],
    );
    assert.deepEqual(
      first.items.map((item) => item.executionState),
      ["running", "not_started"],
    );
    assert.equal(typeof first.nextCursor, "string");

    const second = operation({
      workspaceKey: "workspace",
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
    database
      .prepare("INSERT INTO sessions VALUES ('child', 'provider', 'other', '[]', 'character', 4, 'active', 1, 1, 1)")
      .run();
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
        .prepare("INSERT INTO sessions VALUES (?, 'provider', 'workspace', '[]', ?, 4, 'active', 1, 1, ?)")
        .run(`session-${String(index).padStart(3, "0")}`, "c".repeat(3_000), index + 1);
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
    }) as PageResult;
    assert.deepEqual(result.items[0], { omitted: true, reason: "response_size_limit", ordinal: 1 });
    assert.equal(result.items[1]?.id, "event-2");
    assert.equal(Object.hasOwn(result.items[1] ?? {}, "dedupeKey"), false);
    assert.equal(Object.hasOwn(result.items[1] ?? {}, "workspaceKey"), false);
  });
});

repositoryTest("representative ordinal queries use covering indexes and never scan payloads", () => {
  withDatabase((database) => {
    const plans = [
      database.prepare(`EXPLAIN QUERY PLAN ${REPOSITORY_PAGE_SQL.messages}`).all(1024, "s", "w", 0, 10),
      database.prepare(`EXPLAIN QUERY PLAN ${REPOSITORY_PAGE_SQL.runEvents}`).all("r", "s", "w", 0, 10),
      database.prepare(`EXPLAIN QUERY PLAN ${REPOSITORY_PAGE_SQL.runOutputs}`).all("r", "s", "w", 0, 10),
      database
        .prepare(`EXPLAIN QUERY PLAN ${REPOSITORY_PAGE_SQL.runOutputsByCategory}`)
        .all("r", "s", "w", "operation", 0, 10),
    ].flat() as unknown as readonly Readonly<{ detail: string }>[];
    const details = plans.map((row) => row.detail).join("\n");
    assert.match(details, /messages_session_ordinal_uq/u);
    assert.match(details, /run_events_run_ordinal_uq/u);
    assert.match(details, /run_output_items_run_ordinal_uq/u);
    assert.match(details, /run_output_items_run_category_ordinal_idx/u);
    assert.doesNotMatch(details, /run_output_payloads/u);
    assert.doesNotMatch(details, /USE TEMP B-TREE FOR ORDER BY/u);
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
    .prepare("INSERT INTO sessions VALUES (?, 'provider', ?, '[]', 'character', 4, 'active', 1, ?, ?)")
    .run(id, workspaceKey, activity, activity);
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
