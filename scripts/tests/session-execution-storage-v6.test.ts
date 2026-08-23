import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { createOrVerifyV6FreshDatabase } from "../../src-electron/app-database-v6-bootstrap.js";
import { ensureV6Schema } from "../../src-electron/database-schema-v6.js";
import {
  SessionExecutionBusyError,
  SessionExecutionIdempotencyConflictError,
  SessionExecutionQueueFullError,
  SessionExecutionStorageV6,
} from "../../src-electron/session-execution-storage-v6.js";
import { insertStandaloneRoleBindingsForSessions } from "./session-role-binding-fixture.js";

const CREATED_AT = "2026-08-10T00:00:00.000Z";
const EXPIRES_AT = "2026-08-11T00:00:00.000Z";

async function createFixture(): Promise<{
  directory: string;
  dbPath: string;
  storage: SessionExecutionStorageV6;
}> {
  const directory = await mkdtemp(path.join(tmpdir(), "withmate-session-execution-"));
  const { dbPath } = await createOrVerifyV6FreshDatabase(directory);
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA foreign_keys = ON;");
    const insertSession = db.prepare(`
      INSERT INTO sessions_v6 (
        id,
        title,
        state,
        provider_id,
        catalog_revision,
        model_id,
        approval_mode,
        created_at,
        updated_at,
        last_active_at
      ) VALUES (?, ?, 'active', 'codex', 1, 'gpt-5', 'on-request', ?, ?, ?)
    `);
    insertSession.run("session-1", "Session 1", CREATED_AT, CREATED_AT, CREATED_AT);
    insertSession.run("session-2", "Session 2", CREATED_AT, CREATED_AT, CREATED_AT);
    db.prepare(`
      INSERT INTO session_messages_v6 (session_id, seq, role, body, created_at)
      VALUES ('session-1', 0, 'user', '{"text":"source"}', ?)
    `).run(CREATED_AT);
    insertStandaloneRoleBindingsForSessions(db);
  } finally {
    db.close();
  }
  return {
    directory,
    dbPath,
    storage: new SessionExecutionStorageV6(dbPath),
  };
}

function enqueueInput(index: number) {
  return {
    id: `execution-${index}`,
    sessionId: "session-1",
    request: { userMessage: `message-${index}` },
    idempotencyKey: `key-${index}`,
    requestFingerprint: `fingerprint-${index}`,
    createdAt: `2026-08-10T00:00:${String(index).padStart(2, "0")}.000Z`,
    expiresAt: EXPIRES_AT,
  };
}

describe("SessionExecutionStorageV6", () => {
  it("ORCH-OUTBOUND-01: origin snapshotをacceptanceと同時保存しtarget削除後もsource queryから復元する", async () => {
    const fixture = await createFixture();
    try {
      fixture.storage.enqueue({
        ...enqueueInput(1),
        sessionId: "session-2",
        request: { turn: { userMessage: "delegate this" } },
        origin: {
          sourceSessionId: "session-1",
          targetSessionTitle: "Session 2",
          targetSessionRole: "standalone",
          userMessage: "delegate this",
        },
      });
      assert.deepEqual(fixture.storage.listSessionOutboundExecutions("session-1"), [{
        sequence: 1,
        executionId: "execution-1",
        targetSessionId: "session-2",
        sourceMessageSequence: 0,
        operation: "turn.enqueue",
        targetSessionTitle: "Session 2",
        targetSessionRole: "standalone",
        userMessage: "delegate this",
        createdAt: "2026-08-10T00:00:01.000Z",
      }]);
      assert.equal(fixture.storage.enqueue({
        ...enqueueInput(1),
        sessionId: "session-2",
        request: { turn: { userMessage: "delegate this" } },
        origin: {
          sourceSessionId: "session-1",
          targetSessionTitle: "Session 2",
          targetSessionRole: "standalone",
          userMessage: "delegate this",
        },
      }).replayed, true);
      fixture.storage.enqueue({
        ...enqueueInput(2),
        sessionId: "session-2",
        request: { turn: { userMessage: "delegate next" } },
        origin: {
          sourceSessionId: "session-1",
          targetSessionTitle: "Session 2",
          targetSessionRole: "standalone",
          userMessage: "delegate next",
        },
      });
      assert.deepEqual(
        fixture.storage.listSessionOutboundExecutions("session-1").map((record) => record.executionId),
        ["execution-1", "execution-2"],
      );

      const renameDb = new DatabaseSync(fixture.dbPath);
      try {
        renameDb.prepare("UPDATE sessions_v6 SET title = ? WHERE id = ?").run("Renamed target", "session-2");
      } finally {
        renameDb.close();
      }
      assert.equal(fixture.storage.listSessionOutboundExecutions("session-1")[0]?.targetSessionTitle, "Session 2");

      fixture.storage.close();
      const db = new DatabaseSync(fixture.dbPath);
      try {
        db.exec("PRAGMA foreign_keys = ON;");
        db.prepare("DELETE FROM session_role_bindings_v6 WHERE session_id = ?").run("session-2");
        db.prepare("DELETE FROM sessions_v6 WHERE id = ?").run("session-2");
      } finally {
        db.close();
      }
      const restarted = new SessionExecutionStorageV6(fixture.dbPath);
      try {
        assert.equal(restarted.get("execution-1"), null);
        assert.deepEqual(
          restarted.listSessionOutboundExecutions("session-1").map((record) => record.targetSessionTitle),
          ["Session 2", "Session 2"],
        );
      } finally {
        restarted.close();
      }
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("ID-03: restart loadとqueuedからrunningへの遷移でinitiator tupleを維持する", async () => {
    const fixture = await createFixture();
    const initiator = {
      kind: "session" as const,
      sessionId: "session-actor",
      character: {
        characterId: "character-actor",
        name: "Actor Snapshot",
        iconFilePath: "C:/characters/actor.png",
      },
    };
    try {
      fixture.storage.enqueue({
        ...enqueueInput(1),
        request: {
          initiator,
          catalogRevision: 4,
          turn: { provider: "codex", userMessage: "queued request" },
        },
      });
      fixture.storage.close();
      const restarted = new SessionExecutionStorageV6(fixture.dbPath);
      try {
        assert.deepEqual((restarted.get("execution-1")?.request as any).initiator, initiator);
        restarted.admitNextQueued("session-1", "2026-08-10T00:01:00.000Z");
        assert.deepEqual((restarted.get("execution-1")?.request as any).initiator, initiator);
      } finally {
        restarted.close();
      }
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("PG-01: execution履歴をsequence keysetとlimitでページングする", async () => {
    const fixture = await createFixture();
    try {
      for (let index = 1; index <= 3; index += 1) {
        fixture.storage.enqueue(enqueueInput(index));
      }

      const first = fixture.storage.listSessionExecutionsPage("session-1", null, 2);
      assert.deepEqual(first.map((item) => item.id), ["execution-1", "execution-2"]);

      fixture.storage.enqueue(enqueueInput(4));
      const second = fixture.storage.listSessionExecutionsPage(
        "session-1",
        first.at(-1)?.sequence ?? null,
        2,
      );
      assert.deepEqual(second.map((item) => item.id), ["execution-3", "execution-4"]);
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("TN-BOUND-08: GUI projection sourceはactive executionと最新terminalだけへ制限する", async () => {
    const fixture = await createFixture();
    try {
      for (let index = 1; index <= 20; index += 1) {
        fixture.storage.startImmediate(enqueueInput(index));
        fixture.storage.completeRunning({
          executionId: `execution-${index}`,
          state: "failed",
          result: null,
          errorCode: "PROVIDER_FAILURE",
          reason: "session_runtime_failed",
          completedAt: `2026-08-10T00:01:${String(index).padStart(2, "0")}.000Z`,
          expiresAt: EXPIRES_AT,
        });
      }
      fixture.storage.enqueue(enqueueInput(21));
      fixture.storage.enqueue(enqueueInput(22));

      assert.deepEqual(
        fixture.storage.listSessionExecutionProjectionRecords("session-1").map((execution) => execution.id),
        ["execution-20", "execution-21", "execution-22"],
      );
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("Q-01: 待機中executionを10件に制限し、runningは件数へ含めない", async () => {
    const fixture = await createFixture();
    try {
      for (let index = 1; index <= 10; index += 1) {
        const result = fixture.storage.enqueue(enqueueInput(index));
        assert.equal(result.execution.state, "queued");
        assert.equal(result.replayed, false);
      }

      const admitted = fixture.storage.admitNextQueued("session-1", "2026-08-10T00:01:00.000Z");
      assert.equal(admitted?.id, "execution-1");
      assert.equal(admitted?.state, "running");

      const tenthQueued = fixture.storage.enqueue(enqueueInput(11));
      assert.equal(tenthQueued.execution.state, "queued");
      assert.equal(fixture.storage.listSessionExecutions("session-1").filter((item) => item.state === "queued").length, 10);

      assert.throws(
        () => fixture.storage.enqueue(enqueueInput(12)),
        (error) => error instanceof SessionExecutionQueueFullError && error.code === "QUEUE_FULL",
      );

      const db = new DatabaseSync(fixture.dbPath);
      try {
        const executionCount = db.prepare("SELECT COUNT(*) AS count FROM session_executions_v6").get() as { count: number };
        const idempotencyCount = db.prepare("SELECT COUNT(*) AS count FROM session_execution_idempotency_v6").get() as { count: number };
        assert.equal(executionCount.count, 11);
        assert.equal(idempotencyCount.count, 11);
      } finally {
        db.close();
      }
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("I-01: 同じoperationとkeyの同一fingerprintをcanonical executionへreplayする", async () => {
    const fixture = await createFixture();
    try {
      const first = fixture.storage.enqueue(enqueueInput(1));
      const replay = fixture.storage.enqueue({
        ...enqueueInput(1),
        id: "execution-retry",
      });

      assert.equal(first.execution.id, "execution-1");
      assert.equal(replay.execution.id, "execution-1");
      assert.equal(replay.replayed, true);
      assert.equal(fixture.storage.listSessionExecutions("session-1").length, 1);
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("I-01: 同じoperationとkeyの異なるfingerprintを拒否して既存executionを保つ", async () => {
    const fixture = await createFixture();
    try {
      fixture.storage.enqueue(enqueueInput(1));

      assert.throws(
        () => fixture.storage.enqueue({
          ...enqueueInput(1),
          id: "execution-conflict",
          requestFingerprint: "different-fingerprint",
        }),
        (error) => error instanceof SessionExecutionIdempotencyConflictError
          && error.code === "IDEMPOTENCY_CONFLICT",
      );
      assert.equal(fixture.storage.listSessionExecutions("session-1").length, 1);
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("I-01: turn.runとturn.enqueueは同じidempotency keyでも別scopeとして扱う", async () => {
    const fixture = await createFixture();
    try {
      const queued = fixture.storage.enqueue(enqueueInput(1));
      const running = fixture.storage.startImmediate({
        ...enqueueInput(2),
        sessionId: "session-2",
        idempotencyKey: enqueueInput(1).idempotencyKey,
      });

      assert.equal(queued.execution.operation, "turn.enqueue");
      assert.equal(running.execution.operation, "turn.run");
      assert.equal(fixture.storage.listSessionExecutions("session-1").length, 1);
      assert.equal(fixture.storage.listSessionExecutions("session-2").length, 1);

      assert.throws(
        () => fixture.storage.startImmediate(enqueueInput(3)),
        (error) => error instanceof SessionExecutionBusyError && error.code === "SESSION_BUSY",
      );
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("E-02: queueを永続FIFO順で一件だけadmitする", async () => {
    const fixture = await createFixture();
    try {
      fixture.storage.enqueue(enqueueInput(1));
      fixture.storage.enqueue(enqueueInput(2));

      const first = fixture.storage.admitNextQueued("session-1", "2026-08-10T00:01:00.000Z");
      const blocked = fixture.storage.admitNextQueued("session-1", "2026-08-10T00:02:00.000Z");

      assert.equal(first?.id, "execution-1");
      assert.equal(first?.state, "running");
      assert.equal(blocked, null);
      assert.equal(fixture.storage.get("execution-2")?.state, "queued");
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("EXT-QUEUE-08: admission exhaustionはFIFO先頭をfailedへ永続化する", async () => {
    const fixture = await createFixture();
    try {
      fixture.storage.enqueue(enqueueInput(1));
      fixture.storage.enqueue(enqueueInput(2));

      const failed = fixture.storage.failNextQueued(
        "session-1",
        "2026-08-10T00:01:00.000Z",
        "2026-08-11T00:01:00.000Z",
      );

      assert.equal(failed?.id, "execution-1");
      assert.equal(failed?.state, "failed");
      assert.equal(failed?.errorCode, "QUEUE_ADMISSION_FAILURE");
      assert.equal(failed?.reason, "queue_admission_exhausted");
      assert.equal(fixture.storage.get("execution-2")?.state, "queued");
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("E-03: 起動時reconciliation用にrunningをinterruptedへ収束する", async () => {
    const fixture = await createFixture();
    try {
      fixture.storage.enqueue(enqueueInput(1));
      fixture.storage.enqueue(enqueueInput(2));
      fixture.storage.admitNextQueued("session-1", "2026-08-10T00:01:00.000Z");

      const interrupted = fixture.storage.interruptRunningForRestart(
        "2026-08-10T00:02:00.000Z",
        "2026-08-11T00:02:00.000Z",
      );

      assert.deepEqual(interrupted.map((item) => item.id), ["execution-1"]);
      assert.equal(interrupted[0]?.state, "interrupted");
      assert.equal(interrupted[0]?.reason, "runtime_restarted");
      assert.equal(fixture.storage.get("execution-2")?.state, "queued");

      const next = fixture.storage.admitNextQueued("session-1", "2026-08-10T00:03:00.000Z");
      assert.equal(next?.id, "execution-2");
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("EXT-SHUTDOWN-07: shutdown時のrunningを専用reasonでinterruptedへ収束する", async () => {
    const fixture = await createFixture();
    try {
      fixture.storage.enqueue(enqueueInput(1));
      fixture.storage.admitNextQueued("session-1", "2026-08-10T00:01:00.000Z");

      const interrupted = fixture.storage.interruptRunningForShutdown(
        "2026-08-10T00:02:00.000Z",
        "2026-08-11T00:02:00.000Z",
      );

      assert.deepEqual(interrupted.map((item) => item.id), ["execution-1"]);
      assert.equal(interrupted[0]?.state, "interrupted");
      assert.equal(interrupted[0]?.reason, "runtime_shutdown");
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("I-01: terminalから24時間のexpiryへ更新し、cleanupはexpired terminalだけを削除する", async () => {
    const fixture = await createFixture();
    try {
      const running = fixture.storage.startImmediate({
        ...enqueueInput(1),
        expiresAt: "2026-08-10T00:30:00.000Z",
      });
      fixture.storage.enqueue({
        ...enqueueInput(2),
        expiresAt: "2026-08-10T00:30:00.000Z",
      });
      fixture.storage.completeRunning({
        executionId: running.execution.id,
        state: "completed",
        result: null,
        errorCode: "",
        reason: "",
        completedAt: "2026-08-10T01:00:00.000Z",
        expiresAt: "2026-08-11T01:00:00.000Z",
      });

      assert.equal(fixture.storage.cleanupExpiredIdempotency("2026-08-10T02:00:00.000Z"), 0);
      assert.equal(fixture.storage.resolveIdempotency("turn.run", "key-1", "fingerprint-1")?.id, "execution-1");
      assert.equal(fixture.storage.resolveIdempotency("turn.enqueue", "key-2", "fingerprint-2")?.id, "execution-2");

      assert.equal(fixture.storage.cleanupExpiredIdempotency("2026-08-11T01:00:00.000Z"), 1);
      assert.equal(fixture.storage.resolveIdempotency("turn.run", "key-1", "fingerprint-1"), null);
      assert.equal(fixture.storage.resolveIdempotency("turn.enqueue", "key-2", "fingerprint-2")?.id, "execution-2");
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("Session削除時にexecutionとidempotencyをcascade削除する", async () => {
    const fixture = await createFixture();
    try {
      fixture.storage.enqueue(enqueueInput(1));
      const db = new DatabaseSync(fixture.dbPath);
      try {
        db.exec("PRAGMA foreign_keys = ON;");
        db.prepare("DELETE FROM session_role_bindings_v6 WHERE session_id = ?").run("session-1");
        db.prepare("DELETE FROM sessions_v6 WHERE id = ?").run("session-1");
        const executionCount = db.prepare("SELECT COUNT(*) AS count FROM session_executions_v6").get() as { count: number };
        const idempotencyCount = db.prepare("SELECT COUNT(*) AS count FROM session_execution_idempotency_v6").get() as { count: number };
        assert.equal(executionCount.count, 0);
        assert.equal(idempotencyCount.count, 0);
      } finally {
        db.close();
      }
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("ID-02: populatedな旧idempotency tableをcancel対応schemaへ移行して既存recordを保つ", async () => {
    const fixture = await createFixture();
    try {
      fixture.storage.enqueue(enqueueInput(1));
      fixture.storage.close();
      const db = new DatabaseSync(fixture.dbPath);
      try {
        db.exec("PRAGMA foreign_keys = ON;");
        db.exec(`
          DROP TABLE session_execution_idempotency_v6;
          CREATE TABLE session_execution_idempotency_v6 (
            operation TEXT NOT NULL CHECK (operation IN ('turn.run', 'turn.enqueue')),
            idempotency_key TEXT NOT NULL,
            request_fingerprint TEXT NOT NULL,
            execution_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            PRIMARY KEY (operation, idempotency_key),
            FOREIGN KEY (execution_id) REFERENCES session_executions_v6(id) ON DELETE CASCADE
          );
        `);
        db.prepare(`
          INSERT INTO session_execution_idempotency_v6 (
            operation, idempotency_key, request_fingerprint, execution_id, created_at, expires_at
          ) VALUES ('turn.enqueue', ?, ?, ?, ?, ?)
        `).run("key-1", "fingerprint-1", "execution-1", CREATED_AT, EXPIRES_AT);

        ensureV6Schema(db);

        const table = db.prepare(`
          SELECT sql FROM sqlite_schema
          WHERE type = 'table' AND name = 'session_execution_idempotency_v6'
        `).get() as { sql: string };
        assert.match(table.sql, /'turn\.cancel'/);
        const preserved = db.prepare(`
          SELECT execution_id FROM session_execution_idempotency_v6
          WHERE operation = 'turn.enqueue' AND idempotency_key = 'key-1'
        `).get() as { execution_id: string };
        assert.equal(preserved.execution_id, "execution-1");
        db.prepare(`
          INSERT INTO session_execution_idempotency_v6 (
            operation, idempotency_key, request_fingerprint, execution_id, created_at, expires_at
          ) VALUES ('turn.cancel', ?, ?, ?, ?, ?)
        `).run("cancel-key", "cancel-fingerprint", "execution-1", CREATED_AT, EXPIRES_AT);
      } finally {
        db.close();
      }
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });
});
