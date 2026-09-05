import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { createOrVerifyV6FreshDatabase } from "../../src-electron/app-database-v6-bootstrap.js";
import {
  CREATE_V6_SESSION_INTERACTIONS_TABLE_SQL,
  CREATE_V6_SESSION_INTERACTION_IDEMPOTENCY_TABLE_SQL,
} from "../../src-electron/database-schema-v6.js";
import { SessionExecutionStorageV6 } from "../../src-electron/session-execution-storage-v6.js";
import { ensureSessionInteractionAuthoritySchema } from "../../src-electron/session-interaction-authority-schema.js";
import {
  SessionInteractionAlreadyResolvedError,
  SessionInteractionAuthorityError,
  SessionInteractionExecutionStateError,
  SessionInteractionIdempotencyConflictError,
  SessionInteractionPayloadTooLargeError,
  SessionInteractionPendingConflictError,
  SessionInteractionRevisionConflictError,
  SessionInteractionStorageV6,
  SessionInteractionTargetMismatchError,
} from "../../src-electron/session-interaction-storage-v6.js";
import {
  SESSION_AUTHORITY_MAPPING_REVISION,
  type TrustedMutationProof,
} from "../../src/session-authority.js";
import { SESSION_INTERACTION_PUBLIC_MAX_BYTES } from "../../src/session-interaction.js";
import { insertStandaloneRoleBindingsForSessions } from "./session-role-binding-fixture.js";

const CREATED_AT = "2026-08-13T00:00:00.000Z";
const EXPIRES_AT = "2026-08-14T00:00:00.000Z";

function trustedTurnRunProof(sessionId: string): TrustedMutationProof {
  return {
    principal: { kind: "system", service: "test-fixture" },
    operation: "turn.run",
    mappingRevision: SESSION_AUTHORITY_MAPPING_REVISION,
    action: "turn.run",
    resolvedScope: {
      resourceKind: "execution",
      resourceId: sessionId,
      rootSessionId: sessionId,
      ownerKind: "session",
      ownerId: sessionId,
      relation: "self",
    },
    effectClass: "external_side_effect",
    grantId: null,
    grantRevision: null,
    evaluatedAt: CREATED_AT,
  };
}

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
      expectedContainerRevision: 1,
      id: "execution-1",
      sessionId: "session-1",
      request: { userMessage: "hello" },
      idempotencyKey: "run-1",
      requestFingerprint: "run-fingerprint-1",
      createdAt: CREATED_AT,
      expiresAt: EXPIRES_AT,
      proof: trustedTurnRunProof("session-1"),
    });
    executions.startImmediate({
      expectedContainerRevision: 1,
      id: "execution-2",
      sessionId: "session-2",
      request: { userMessage: "hello" },
      idempotencyKey: "run-2",
      requestFingerprint: "run-fingerprint-2",
      createdAt: CREATED_AT,
      expiresAt: EXPIRES_AT,
      proof: trustedTurnRunProof("session-2"),
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

  // @test-value v1
  // kind = "security"
  // claim = "保存済みuser_only classとcurrent revisionに反するresponseはmutation前に拒否される"
  // oracle = { type = "contract", ref = "AUTONOMY-USER-01" }
  // failure_mode = "Agentがuser decisionを偽装するか、stale UI receiptが新しいinteraction stateを上書きする"
  // scope = "session-interaction-storage"
  // lifecycle = "permanent"
  // @end-test-value
  it("stored decision classとrevisionでagent responseとstale receiptを拒否する", async () => {
    const fixture = await createFixture();
    try {
      createPending(fixture.storage);
      const base = {
        sessionId: "session-1",
        executionId: "execution-1",
        interactionId: "interaction-1",
        action: "cancel" as const,
        submittedFields: [],
        idempotencyKey: "response-authority",
        requestFingerprint: "response-authority-fingerprint",
        respondedAt: "2026-08-13T00:01:00.000Z",
        expiresAt: EXPIRES_AT,
      };
      assert.throws(
        () => fixture.storage.respond({
          ...base,
          expectedRevision: 1,
          principal: { kind: "agent", sessionId: "session-1" },
        }),
        (error) => error instanceof SessionInteractionAuthorityError,
      );
      assert.throws(
        () => fixture.storage.respond({
          ...base,
          expectedRevision: 0,
          principal: { kind: "user" },
        }),
        (error) => error instanceof SessionInteractionRevisionConflictError
          && error.currentRevision === 1,
      );
      assert.equal(fixture.storage.get("interaction-1")?.state, "pending");
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  // @test-value v1
  // kind = "invariant"
  // claim = "event insert failureはresponse projectionとidempotency rowも同じtransactionでrollbackする"
  // oracle = { type = "contract", ref = "AUTONOMY-MUTATION-05" }
  // failure_mode = "history保存だけ失敗したresponseがanswered projectionまたはreplay resultを残す"
  // scope = "session-interaction-storage"
  // lifecycle = "permanent"
  // @end-test-value
  it("event insert failureでresponse projectionとidempotencyもrollbackする", async () => {
    const fixture = await createFixture();
    try {
      createPending(fixture.storage);
      const db = new DatabaseSync(fixture.dbPath);
      try {
        db.exec(`
          CREATE TRIGGER reject_answered_interaction_event
          BEFORE INSERT ON session_interaction_events_v6
          WHEN NEW.event_kind = 'answered'
          BEGIN
            SELECT RAISE(ABORT, 'injected event failure');
          END;
        `);
      } finally {
        db.close();
      }
      assert.throws(() => fixture.storage.respond({
        sessionId: "session-1",
        executionId: "execution-1",
        interactionId: "interaction-1",
        expectedRevision: 1,
        principal: { kind: "user" },
        action: "cancel",
        submittedFields: [],
        idempotencyKey: "response-rollback",
        requestFingerprint: "response-rollback-fingerprint",
        respondedAt: "2026-08-13T00:01:00.000Z",
        expiresAt: EXPIRES_AT,
      }), /injected event failure/);
      assert.equal(fixture.storage.get("interaction-1")?.state, "pending");
      const verification = new DatabaseSync(fixture.dbPath, { readOnly: true });
      try {
        const idempotency = verification.prepare(`
          SELECT COUNT(*) AS count FROM session_interaction_idempotency_v6
          WHERE idempotency_key = 'response-rollback'
        `).get() as { count: number };
        const events = verification.prepare(`
          SELECT COUNT(*) AS count FROM session_interaction_events_v6
          WHERE interaction_id = 'interaction-1'
        `).get() as { count: number };
        assert.equal(idempotency.count, 0);
        assert.equal(events.count, 1);
      } finally {
        verification.close();
      }
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  // @test-value v1
  // kind = "invariant"
  // claim = "user responseのprojection、revision、event、principal-scoped idempotencyが同じtransactionで一度だけ保存される"
  // oracle = { type = "contract", ref = "AUTONOMY-USER-01/AUTONOMY-HISTORY-04/AUTONOMY-MUTATION-05" }
  // failure_mode = "response loss後のretryで二重eventを作るか、projectionとprovenanceが部分保存される"
  // scope = "session-interaction-storage"
  // lifecycle = "permanent"
  // @end-test-value
  it("answer、event、principal idempotencyをatomicにcommitしてretryを収束する", async () => {
    const fixture = await createFixture();
    try {
      createPending(fixture.storage);
      const input = {
        sessionId: "session-1",
        executionId: "execution-1",
        interactionId: "interaction-1",
        expectedRevision: 1,
        principal: { kind: "user" as const },
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
      assert.equal(answered.interaction.revision, 2);
      assert.deepEqual(answered.interaction.resolvedBy, { kind: "user" });
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
          SELECT response_action, response_submitted_fields_json, response_fingerprint,
                 revision, response_principal_kind
          FROM session_interactions_v6
          WHERE id = 'interaction-1'
        `).get() as {
          response_action: string;
          response_submitted_fields_json: string;
          response_fingerprint: string;
          revision: number;
          response_principal_kind: string;
        };
        assert.equal(row.response_action, "accept");
        assert.deepEqual(JSON.parse(row.response_submitted_fields_json), ["name", "secret"]);
        assert.equal(row.response_fingerprint, "response-fingerprint-1");
        assert.equal(row.revision, 2);
        assert.equal(row.response_principal_kind, "user");
        assert.equal(JSON.stringify(row).includes("top-secret-value"), false);
        const events = db.prepare(`
          SELECT interaction_revision, event_kind, principal_kind, idempotency_key_fingerprint, projection_json
          FROM session_interaction_events_v6 WHERE interaction_id = 'interaction-1'
          ORDER BY interaction_revision
        `).all() as Array<Record<string, unknown>>;
        assert.deepEqual(events.map(({ interaction_revision, event_kind, principal_kind }) => ({
          interaction_revision, event_kind, principal_kind,
        })), [
          { interaction_revision: 1, event_kind: "created", principal_kind: "system" },
          { interaction_revision: 2, event_kind: "answered", principal_kind: "user" },
        ]);
        assert.match(String(events[1]?.idempotency_key_fingerprint), /^[0-9a-f]{64}$/);
        assert.notEqual(events[1]?.idempotency_key_fingerprint, "respond-1");
        const { responseFingerprint: _responseFingerprint, ...publicProjection } = answered.interaction;
        assert.deepEqual(JSON.parse(String(events[1]?.projection_json)), publicProjection);
        const headers = db.prepare(`
          SELECT resource_kind, resource_id, root_id, owner_id, event_kind,
                 resource_revision, principal_kind, operation_id,
                 idempotency_key_fingerprint, supersedes_event_id, effect
          FROM resource_event_headers_v6
          WHERE resource_kind = 'interaction' AND resource_id = 'interaction-1'
          ORDER BY resource_revision
        `).all() as Array<Record<string, unknown>>;
        assert.deepEqual(headers.map((header) => ({ ...header })), [
          {
            resource_kind: "interaction",
            resource_id: "interaction-1",
            root_id: "session-1",
            owner_id: "session-1",
            event_kind: "created",
            resource_revision: 1,
            principal_kind: "system",
            operation_id: "interaction.create:interaction-1",
            idempotency_key_fingerprint: null,
            supersedes_event_id: null,
            effect: "committed",
          },
          {
            resource_kind: "interaction",
            resource_id: "interaction-1",
            root_id: "session-1",
            owner_id: "session-1",
            event_kind: "answered",
            resource_revision: 2,
            principal_kind: "user",
            operation_id: "interaction.respond:response-fingerprint-1",
            idempotency_key_fingerprint: events[1]?.idempotency_key_fingerprint,
            supersedes_event_id: "interaction:interaction-1:revision:1",
            effect: "committed",
          },
        ]);
      } finally {
        db.close();
      }
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  // @test-value v1
  // kind = "invariant"
  // claim = "system expiryはrevisionを進めてexpired eventとprojectionをatomicに保存する"
  // oracle = { type = "contract", ref = "AUTONOMY-HISTORY-04" }
  // failure_mode = "restart expiryでprojectionだけが更新され、履歴またはsystem provenanceが欠落する"
  // scope = "session-interaction-storage"
  // lifecycle = "permanent"
  // @end-test-value
  it("restart/shutdownでpendingをsystem provenance付きexpiredへ収束する", async () => {
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
          expectedRevision: 1,
          principal: { kind: "user" },
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
      assert.equal(expired[0]?.revision, 2);
      assert.deepEqual(expired[0]?.resolvedBy, { kind: "system" });
      assert.throws(
        () => fixture.storage.respond({
          sessionId: "session-1",
          executionId: "execution-1",
          interactionId: "interaction-1",
          expectedRevision: 1,
          principal: { kind: "user" },
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

  // @test-value v1
  // kind = "compatibility"
  // claim = "既存interactionとidempotencyを保持し、推定したuser provenanceではなく一件のmigration baselineへ移行して現userの同key retryを再適用しない"
  // oracle = { type = "contract", ref = "AUTONOMY-MIGRATION-09" }
  // failure_mode = "旧gui形式のkeyからuser provenanceを偽造するか、現userのretryを別mutationとして再適用するか、再実行でbaseline eventを重複させる"
  // scope = "session-interaction-authority-schema"
  // lifecycle = "permanent"
  // @end-test-value
  it("populated V6 interactionを正直なmigration baselineへ一度だけ移行する", async () => {
    const fixture = await createFixture();
    fixture.storage.close();
    try {
      const db = new DatabaseSync(fixture.dbPath);
      try {
        db.exec(`
          DROP TABLE session_interaction_events_v6;
          DROP TABLE session_interaction_idempotency_v6;
          DROP TABLE session_interactions_v6;
        `);
        db.exec(CREATE_V6_SESSION_INTERACTIONS_TABLE_SQL);
        db.exec(CREATE_V6_SESSION_INTERACTION_IDEMPOTENCY_TABLE_SQL);
        db.prepare(`
          INSERT INTO session_interactions_v6 (
            id, execution_id, kind, state, public_payload_json, response_action,
            response_submitted_fields_json, response_fingerprint, created_at, resolved_at, updated_at
          ) VALUES (?, ?, 'approval', 'answered', ?, 'approve', '[]', ?, ?, ?, ?)
        `).run(
          "legacy-interaction",
          "execution-1",
          JSON.stringify({ title: "Approve", summary: "Legacy request" }),
          "legacy-response-fingerprint",
          CREATED_AT,
          "2026-08-13T00:01:00.000Z",
          "2026-08-13T00:01:00.000Z",
        );
        db.prepare(`
          INSERT INTO session_interaction_idempotency_v6 (
            operation, idempotency_key, request_fingerprint, interaction_id, created_at, expires_at
          ) VALUES ('interaction.respond', 'gui:legacy-interaction', ?, 'legacy-interaction', ?, ?)
        `).run("legacy-response-fingerprint", "2026-08-13T00:01:00.000Z", EXPIRES_AT);
        db.exec("BEGIN IMMEDIATE TRANSACTION");
        ensureSessionInteractionAuthoritySchema(db);
        db.exec("ROLLBACK");
        const rolledBackColumns = db.prepare("PRAGMA table_info(session_interactions_v6)").all() as Array<{ name: string }>;
        assert.equal(rolledBackColumns.some(({ name }) => name === "decision_class"), false);
      } finally {
        db.close();
      }
      const migrated = new SessionInteractionStorageV6(fixture.dbPath);
      const migratedInteraction = migrated.get("legacy-interaction");
      assert.equal(migratedInteraction?.revision, 2);
      assert.equal(migratedInteraction?.resolvedBy, null);
      assert.throws(() => migrated.respond({
        sessionId: "session-1",
        executionId: "execution-1",
        interactionId: "legacy-interaction",
        expectedRevision: 2,
        principal: { kind: "user" },
        action: "approve",
        submittedFields: [],
        idempotencyKey: "gui:legacy-interaction",
        requestFingerprint: "legacy-response-fingerprint",
        respondedAt: "2026-08-13T00:02:00.000Z",
        expiresAt: EXPIRES_AT,
      }), SessionInteractionAlreadyResolvedError);
      migrated.close();
      const reopened = new SessionInteractionStorageV6(fixture.dbPath);
      reopened.close();
      const verification = new DatabaseSync(fixture.dbPath, { readOnly: true });
      try {
        const idempotency = verification.prepare(`
          SELECT principal_kind, principal_id, result_revision
          FROM session_interaction_idempotency_v6 WHERE interaction_id = 'legacy-interaction'
        `).get() as Record<string, unknown>;
        assert.deepEqual({ ...idempotency }, {
          principal_kind: "legacy_unknown",
          principal_id: "migration",
          result_revision: 2,
        });
        const events = verification.prepare(`
          SELECT event_kind, principal_kind, interaction_revision, idempotency_key_fingerprint, projection_json
          FROM session_interaction_events_v6 WHERE interaction_id = 'legacy-interaction'
        `).all() as Array<Record<string, unknown>>;
        assert.equal(events.length, 1);
        assert.equal(events[0]?.event_kind, "migration_baseline");
        assert.equal(events[0]?.principal_kind, "system");
        assert.equal(events[0]?.interaction_revision, 2);
        assert.match(String(events[0]?.idempotency_key_fingerprint), /^[0-9a-f]{64}$/);
        assert.notEqual(events[0]?.idempotency_key_fingerprint, "gui:legacy-interaction");
        const { responseFingerprint: _responseFingerprint, ...publicProjection } = migratedInteraction!;
        assert.deepEqual(JSON.parse(String(events[0]?.projection_json)), publicProjection);
        const header = verification.prepare(`
          SELECT principal_kind, operation_id, idempotency_key_fingerprint
          FROM resource_event_headers_v6
          WHERE event_id = 'interaction:legacy-interaction:revision:2'
        `).get() as Record<string, unknown>;
        assert.deepEqual({ ...header }, {
          principal_kind: "system",
          operation_id: "migration:interaction-history",
          idempotency_key_fingerprint: events[0]?.idempotency_key_fingerprint,
        });
      } finally {
        verification.close();
      }
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });
});
