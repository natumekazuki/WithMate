import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { createOrVerifyV6FreshDatabase } from "../../src-electron/app-database-v6-bootstrap.js";
import { ensureV6Schema } from "../../src-electron/database-schema-v6.js";
import { SessionExecutionStorageV6 } from "../../src-electron/session-execution-storage-v6.js";
import {
  SessionInteractionAlreadyResolvedError,
  SessionInteractionExecutionStateError,
  SessionInteractionIdempotencyConflictError,
  SessionInteractionPayloadTooLargeError,
  SessionInteractionPendingConflictError,
  SessionInteractionStorageV6,
  SessionInteractionTargetMismatchError,
} from "../../src-electron/session-interaction-storage-v6.js";
import { SESSION_INTERACTION_PUBLIC_MAX_BYTES } from "../../src/session-interaction.js";
import { insertStandaloneRoleBindingsForSessions } from "./session-role-binding-fixture.js";

const CREATED_AT = "2026-08-13T00:00:00.000Z";
const EXPIRES_AT = "2026-08-14T00:00:00.000Z";

async function createFixture(): Promise<{
  directory: string;
  dbPath: string;
  storage: SessionInteractionStorageV6;
}> {
  const directory = await mkdtemp(path.join(tmpdir(), "withmate-session-interaction-"));
  const { dbPath } = await createOrVerifyV6FreshDatabase(directory);
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA foreign_keys = ON;");
    db.prepare(`
      INSERT INTO sessions_v6 (
        id, title, state, provider_id, catalog_revision, model_id, approval_mode,
        created_at, updated_at, last_active_at
      ) VALUES (?, ?, 'active', 'codex', 1, 'gpt-5', 'on-request', ?, ?, ?)
    `).run("session-1", "Session 1", CREATED_AT, CREATED_AT, CREATED_AT);
    db.prepare(`
      INSERT INTO sessions_v6 (
        id, title, state, provider_id, catalog_revision, model_id, approval_mode,
        created_at, updated_at, last_active_at
      ) VALUES (?, ?, 'active', 'codex', 1, 'gpt-5', 'on-request', ?, ?, ?)
    `).run("session-2", "Session 2", CREATED_AT, CREATED_AT, CREATED_AT);
    insertStandaloneRoleBindingsForSessions(db);
  } finally {
    db.close();
  }
  const executions = new SessionExecutionStorageV6(dbPath);
  try {
    executions.startImmediate({
      id: "execution-1",
      sessionId: "session-1",
      request: { userMessage: "hello" },
      idempotencyKey: "run-1",
      requestFingerprint: "run-fingerprint-1",
      createdAt: CREATED_AT,
      expiresAt: EXPIRES_AT,
    });
    executions.startImmediate({
      id: "execution-2",
      sessionId: "session-2",
      request: { userMessage: "hello" },
      idempotencyKey: "run-2",
      requestFingerprint: "run-fingerprint-2",
      createdAt: CREATED_AT,
      expiresAt: EXPIRES_AT,
    });
  } finally {
    executions.close();
  }
  return { directory, dbPath, storage: new SessionInteractionStorageV6(dbPath) };
}

function createPending(storage: SessionInteractionStorageV6, id = "interaction-1") {
  return storage.createPending({
    id,
    sessionId: "session-1",
    executionId: "execution-1",
    kind: "elicitation",
    publicPayload: { message: "入力してね", fields: [{ name: "secret", type: "text" }] },
    createdAt: CREATED_AT,
  });
}

describe("SessionInteractionStorageV6", () => {
  it("EXT-INTERACTION-11: execution ownershipとpending最大1件をatomicに守る", async () => {
    const fixture = await createFixture();
    try {
      const pending = createPending(fixture.storage);
      assert.equal(pending.state, "pending");
      assert.equal(fixture.storage.getPendingForExecution("execution-1")?.id, "interaction-1");
      assert.throws(
        () => createPending(fixture.storage, "interaction-2"),
        (error) => error instanceof SessionInteractionPendingConflictError,
      );
      assert.throws(
        () => fixture.storage.createPending({
          id: "interaction-wrong-session",
          sessionId: "session-2",
          executionId: "execution-1",
          kind: "approval",
          publicPayload: {},
          createdAt: CREATED_AT,
        }),
        (error) => error instanceof SessionInteractionTargetMismatchError,
      );
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("EXT-INTERACTION-11: answerとidempotencyを同一transactionへcommitしてretryを収束する", async () => {
    const fixture = await createFixture();
    try {
      createPending(fixture.storage);
      const input = {
        sessionId: "session-1",
        executionId: "execution-1",
        interactionId: "interaction-1",
        action: "accept" as const,
        submittedFields: ["secret", "name"],
        idempotencyKey: "respond-1",
        requestFingerprint: "response-fingerprint-1",
        respondedAt: "2026-08-13T00:01:00.000Z",
        expiresAt: EXPIRES_AT,
      };
      assert.throws(
        () => fixture.storage.respond({ ...input, sessionId: "session-2", idempotencyKey: "wrong-target" }),
        (error) => error instanceof SessionInteractionTargetMismatchError,
      );
      const answered = fixture.storage.respond(input);
      const replay = fixture.storage.respond(input);
      assert.equal(answered.replayed, false);
      assert.equal(answered.interaction.state, "answered");
      assert.deepEqual(answered.interaction.response, {
        action: "accept",
        submittedFields: ["name", "secret"],
      });
      assert.equal(replay.replayed, true);
      assert.throws(
        () => fixture.storage.respond({ ...input, requestFingerprint: "different" }),
        (error) => error instanceof SessionInteractionIdempotencyConflictError,
      );
      assert.throws(
        () => fixture.storage.respond({ ...input, idempotencyKey: "respond-2" }),
        (error) => error instanceof SessionInteractionAlreadyResolvedError,
      );

      const db = new DatabaseSync(fixture.dbPath, { readOnly: true });
      try {
        const row = db.prepare(`
          SELECT response_action, response_submitted_fields_json, response_fingerprint
          FROM session_interactions_v6
          WHERE id = 'interaction-1'
        `).get() as {
          response_action: string;
          response_submitted_fields_json: string;
          response_fingerprint: string;
        };
        assert.equal(row.response_action, "accept");
        assert.deepEqual(JSON.parse(row.response_submitted_fields_json), ["name", "secret"]);
        assert.equal(row.response_fingerprint, "response-fingerprint-1");
        assert.equal(JSON.stringify(row).includes("top-secret-value"), false);
      } finally {
        db.close();
      }
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("EXT-INTERACTION-11: restart/shutdownでpendingをexpiredへ収束する", async () => {
    const fixture = await createFixture();
    try {
      createPending(fixture.storage);
      const db = new DatabaseSync(fixture.dbPath);
      try {
        db.prepare(`
          UPDATE session_executions_v6
          SET state = 'completed', completed_at = ?, updated_at = ?
          WHERE id = 'execution-1'
        `).run("2026-08-13T00:01:00.000Z", "2026-08-13T00:01:00.000Z");
      } finally {
        db.close();
      }
      assert.throws(
        () => fixture.storage.respond({
          sessionId: "session-1",
          executionId: "execution-1",
          interactionId: "interaction-1",
          action: "cancel",
          submittedFields: [],
          idempotencyKey: "delayed-response",
          requestFingerprint: "delayed-response-fingerprint",
          respondedAt: "2026-08-13T00:01:30.000Z",
          expiresAt: EXPIRES_AT,
        }),
        (error) => error instanceof SessionInteractionExecutionStateError,
      );
      const expired = fixture.storage.expirePendingForRestart("2026-08-13T00:02:00.000Z");
      assert.equal(expired.length, 1);
      assert.equal(expired[0]?.state, "expired");
      assert.equal(expired[0]?.expiryReason, "runtime_restarted");
      assert.throws(
        () => fixture.storage.respond({
          sessionId: "session-1",
          executionId: "execution-1",
          interactionId: "interaction-1",
          action: "cancel",
          submittedFields: [],
          idempotencyKey: "late-response",
          requestFingerprint: "late-response-fingerprint",
          respondedAt: "2026-08-13T00:03:00.000Z",
          expiresAt: EXPIRES_AT,
        }),
        (error) => error instanceof SessionInteractionAlreadyResolvedError,
      );
      assert.deepEqual(fixture.storage.expirePendingForShutdown("2026-08-13T00:04:00.000Z"), []);
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("EXT-INTERACTION-11: execution terminal reasonをschemaに保存できる", async () => {
    const fixture = await createFixture();
    try {
      createPending(fixture.storage);
      const expired = fixture.storage.expirePendingForExecution(
        "execution-1",
        "execution_terminal",
        "2026-08-13T00:02:00.000Z",
      );
      assert.equal(expired.length, 1);
      assert.equal(expired[0]?.expiryReason, "execution_terminal");
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("EXT-INTERACTION-11: public payloadをUTF-8 256KiBで拒否し、sequence keysetで列挙する", async () => {
    const fixture = await createFixture();
    try {
      const exactPayload = "a".repeat(SESSION_INTERACTION_PUBLIC_MAX_BYTES - 2);
      fixture.storage.createPending({
        id: "interaction-exact",
        sessionId: "session-1",
        executionId: "execution-1",
        kind: "approval",
        publicPayload: exactPayload,
        createdAt: CREATED_AT,
      });
      fixture.storage.expirePendingForShutdown("2026-08-13T00:01:00.000Z");
      assert.throws(
        () => fixture.storage.createPending({
          id: "interaction-too-large",
          sessionId: "session-1",
          executionId: "execution-1",
          kind: "approval",
          publicPayload: `${exactPayload}a`,
          createdAt: CREATED_AT,
        }),
        (error) => error instanceof SessionInteractionPayloadTooLargeError,
      );
      createPending(fixture.storage, "interaction-next");
      const first = fixture.storage.listSessionInteractionsPage("session-1", null, 1);
      const second = fixture.storage.listSessionInteractionsPage("session-1", first[0]?.sequence ?? null, 1);
      assert.deepEqual(first.map((item) => item.id), ["interaction-exact"]);
      assert.deepEqual(second.map((item) => item.id), ["interaction-next"]);
      assert.throws(() => fixture.storage.listSessionInteractionsPage("session-1", null, 501), RangeError);
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("EXT-INTERACTION-11: populated V6 databaseへadditive schemaを再適用して既存executionを保つ", async () => {
    const fixture = await createFixture();
    fixture.storage.close();
    try {
      const db = new DatabaseSync(fixture.dbPath);
      try {
        db.exec("DROP TABLE session_interaction_idempotency_v6; DROP TABLE session_interactions_v6;");
        const before = db.prepare("SELECT COUNT(*) AS count FROM session_executions_v6").get() as { count: number };
        ensureV6Schema(db);
        const after = db.prepare("SELECT COUNT(*) AS count FROM session_executions_v6").get() as { count: number };
        const tables = db.prepare(`
          SELECT name FROM sqlite_schema
          WHERE type = 'table' AND name IN ('session_interactions_v6', 'session_interaction_idempotency_v6')
        `).all() as Array<{ name: string }>;
        assert.equal(before.count, 2);
        assert.equal(after.count, 2);
        assert.equal(tables.length, 2);
      } finally {
        db.close();
      }
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });
});
