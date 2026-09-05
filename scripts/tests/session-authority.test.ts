import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import {
  SESSION_AUTHORITY_OPERATION_DEFINITIONS,
  SessionAuthorityError,
  verifySessionAuthorityOperationDefinitions,
} from "../../src/session-authority.js";
import { SESSION_RUNTIME_OPERATIONS } from "../../src/session-external-runtime-contract.js";
import { buildChildSessionRoleBinding } from "../../src/session-role-binding.js";
import { buildNewSession, type Session } from "../../src/session-state.js";
import type { ResolvedAgentRuntimeBinding } from "../../src-electron/agent-runtime-binding.js";
import { SessionAuthorityService } from "../../src-electron/session-authority-service.js";
import {
  appendResourceEventHeader,
  assertGrantProofCurrent,
  backfillBaselineSessionAuthority,
  createDelegatedChildAuthority,
  revokeSessionAuthorityGrant,
} from "../../src-electron/session-authority-storage.js";
import { SessionStorageV6 } from "../../src-electron/session-storage-v6.js";

const NOW = "2026-09-05T12:00:00.000Z";

function makeRoot(id: string): Session {
  return {
    ...buildNewSession({
    id,
    taskTitle: id,
    workspaceLabel: "workspace",
    workspacePath: "C:/workspace",
    branch: "main",
    characterId: "character-a",
    character: "A",
    characterIconPath: "",
    characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
    approvalMode: DEFAULT_APPROVAL_MODE,
    rootSessionRole: "overall-coordinator",
    }),
    updatedAt: NOW,
  };
}

function makeChild(id: string, parent: Session, role: "task-coordinator" | "executor"): Session {
  return {
    ...buildNewSession({
    id,
    taskTitle: id,
    workspaceLabel: "workspace",
    workspacePath: "C:/workspace",
    branch: "main",
    characterId: "character-a",
    character: "A",
    characterIconPath: "",
    characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
    approvalMode: DEFAULT_APPROVAL_MODE,
    roleBinding: buildChildSessionRoleBinding(id, parent.id, parent.roleBinding!, role),
    }),
    updatedAt: NOW,
  };
}

function binding(sessionId: string, generation = "generation-1"): ResolvedAgentRuntimeBinding {
  return {
    bindingId: `binding-${sessionId}`,
    bindingIdHash: `binding-hash-${sessionId}`,
    actorSessionId: sessionId,
    providerId: "codex",
    executionGeneration: generation,
    authoritySnapshot: {},
    operationGrants: ["session.runtime.invoke"],
    createdAt: NOW,
    expiresAt: null,
  };
}

describe("Session authority", () => {
  // @test-value v1
  // kind = "contract"
  // claim = "canonical Session Runtime operation集合の全要素がauthority mappingへ一度ずつ分類される"
  // oracle = { type = "contract", ref = "AUTONOMY-AUTHORITY-OPERATION-MAPPING" }
  // failure_mode = "公開operationの追加時にauthority分類が欠落し、grant評価を迂回する"
  // scope = "session-authority-operation-registry"
  // lifecycle = "permanent"
  // @end-test-value
  it("公開operationをauthority mappingで網羅する", () => {
    verifySessionAuthorityOperationDefinitions(SESSION_RUNTIME_OPERATIONS);
    assert.deepEqual(Object.keys(SESSION_AUTHORITY_OPERATION_DEFINITIONS).sort(), [...SESSION_RUNTIME_OPERATIONS].sort());
  });

  // @test-value v1
  // kind = "invariant"
  // claim = "baseline migrationは既存Sessionのgrantを一度だけ生成し、再実行しても権限を増やさない"
  // oracle = { type = "contract", ref = "AUTONOMY-AUTHORITY-BASELINE-MIGRATION" }
  // failure_mode = "startupごとに重複grantが追加され、同じSessionのauthorityと監査履歴が増殖する"
  // scope = "session-authority-storage"
  // lifecycle = "permanent"
  // @end-test-value
  it("baseline migrationを再実行してもgrantとeventを重複生成しない", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-authority-migration-"));
    const dbPath = path.join(directory, "db.sqlite");
    const storage = new SessionStorageV6(dbPath);
    try {
      storage.insertSession(makeRoot("root-a"));
      const db = new DatabaseSync(dbPath);
      try {
        backfillBaselineSessionAuthority(db, NOW);
        const first = db.prepare("SELECT COUNT(*) AS count FROM session_authority_grants_v6").get() as { count: number };
        const firstEvents = db.prepare("SELECT COUNT(*) AS count FROM session_authority_grant_events_v6").get() as { count: number };
        backfillBaselineSessionAuthority(db, NOW);
        const second = db.prepare("SELECT COUNT(*) AS count FROM session_authority_grants_v6").get() as { count: number };
        const secondEvents = db.prepare("SELECT COUNT(*) AS count FROM session_authority_grant_events_v6").get() as { count: number };
        assert.ok(first.count > 0);
        assert.equal(second.count, first.count);
        assert.equal(secondEvents.count, firstEvents.count);
      } finally {
        db.close();
      }
    } finally {
      storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  // @test-value v1
  // kind = "security"
  // claim = "runtime bindingのprovider別generationがcurrent値と一致しないrequestはgrant評価前に拒否される"
  // oracle = { type = "contract", ref = "AUTONOMY-AUTHORITY-BINDING-GENERATION" }
  // failure_mode = "失効したprovider runtimeから保存済みgrantを再利用してmutationを開始できる"
  // scope = "session-authority-service"
  // lifecycle = "permanent"
  // @end-test-value
  it("stale runtime generationを拒否する", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-authority-generation-"));
    const dbPath = path.join(directory, "db.sqlite");
    const storage = new SessionStorageV6(dbPath);
    storage.insertSession(makeRoot("root-a"));
    const service = new SessionAuthorityService({
      databasePath: dbPath,
      getExecutionGeneration: () => "generation-2",
      now: () => new Date(NOW),
    });
    try {
      assert.throws(
        () => service.authorize(binding("root-a"), "session.rename", { sessionId: "root-a" }),
        (error) => error instanceof SessionAuthorityError && error.code === "AUTHORITY_FORBIDDEN",
      );
    } finally {
      service.close();
      storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  // @test-value v1
  // kind = "security"
  // claim = "actor originを持つexecutionでもcanonical target Sessionが別rootならcreated relationとして認可しない"
  // oracle = { type = "contract", ref = "AUTONOMY-IDENTITY-03" }
  // failure_mode = "別root executionへactorのorigin rowを付けるとcross-root get/cancel authorityを取得できる"
  // scope = "session-authority execution scope resolver"
  // lifecycle = "permanent"
  // @end-test-value
  it("execution originがactorでもcross-root targetを拒否する", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-authority-execution-root-"));
    const dbPath = path.join(directory, "db.sqlite");
    const storage = new SessionStorageV6(dbPath);
    storage.insertSession(makeRoot("root-a"));
    storage.insertSession(makeRoot("root-b"));
    const service = new SessionAuthorityService({
      databasePath: dbPath,
      getExecutionGeneration: () => "generation-1",
      now: () => new Date(NOW),
    });
    const db = new DatabaseSync(dbPath);
    try {
      db.prepare(`
        INSERT INTO session_executions_v6 (
          id, session_id, operation, state, request_json, created_at, admitted_at, updated_at
        ) VALUES ('execution-root-b', 'root-b', 'turn.run', 'running', '{}', ?, ?, ?)
      `).run(NOW, NOW, NOW);
      const execution = db.prepare("SELECT sequence FROM session_executions_v6 WHERE id = 'execution-root-b'")
        .get() as { sequence: number };
      db.prepare(`
        INSERT INTO session_execution_origins_v6 (
          execution_id, execution_sequence, source_session_id, target_session_id, operation,
          target_session_title_snapshot, target_session_role_snapshot, source_message_seq_anchor,
          user_message, accepted_at
        ) VALUES ('execution-root-b', ?, 'root-a', 'root-b', 'turn.run', 'Root B',
          'overall-coordinator', -1, 'cross root', ?)
      `).run(execution.sequence, NOW);

      assert.throws(
        () => service.authorize(binding("root-a"), "turn.get", {
          sessionId: "root-b",
          executionId: "execution-root-b",
        }),
        (error) => error instanceof SessionAuthorityError && error.code === "AUTHORITY_FORBIDDEN",
      );
    } finally {
      db.close();
      service.close();
      storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  // @test-value v1
  // kind = "security"
  // claim = "fresh task coordinatorはself操作を保持しつつconstructor ceiling外のsibling executor Turnを得ず、grant expiryは親を超えない"
  // oracle = { type = "contract", ref = "AUTONOMY-AUTHORITY-CHILD-ATTENUATION" }
  // failure_mode = "task coordinatorがsibling executorへのTurnなどconstructor ceiling外のauthorityを取得する"
  // scope = "session-authority-delegation"
  // lifecycle = "permanent"
  // @end-test-value
  it("child authorityをconstructor ceilingで縮小しsibling executorを許可しない", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-authority-child-"));
    const dbPath = path.join(directory, "db.sqlite");
    const storage = new SessionStorageV6(dbPath);
    const root = makeRoot("root-a");
    storage.insertSession(root);
    const service = new SessionAuthorityService({
      databasePath: dbPath,
      getExecutionGeneration: () => "generation-1",
      now: () => new Date(NOW),
    });
    try {
      const taskProof = service.authorize(binding(root.id), "session.create", {
        sessionRole: "task-coordinator",
      }).proof;
      const task = makeChild("task-a", root, "task-coordinator");
      storage.insertSession(task);
      const db = new DatabaseSync(dbPath);
      try {
        db.prepare("DELETE FROM session_authority_grants_v6 WHERE grantee_session_id = ?").run(task.id);
        db.prepare("UPDATE session_authority_grants_v6 SET expires_at = ? WHERE grant_id = ?")
          .run("2026-09-06T12:00:00.000Z", taskProof.grantId);
        db.exec("BEGIN IMMEDIATE");
        createDelegatedChildAuthority(db, {
          parentProof: taskProof,
          childSessionId: task.id,
          operationId: "create-task-a",
          createdAt: NOW,
        });
        db.exec("COMMIT");
        const taskExpiryRows = db.prepare("SELECT DISTINCT expires_at FROM session_authority_grants_v6 WHERE grantee_session_id = ?")
          .all(task.id) as Array<{ expires_at: string | null }>;
        assert.deepEqual(taskExpiryRows.map((row) => row.expires_at), ["2026-09-06T12:00:00.000Z"]);

        const executorProof = service.authorize(binding(root.id), "session.create", { sessionRole: "executor" }).proof;
        const executor = makeChild("executor-a", root, "executor");
        storage.insertSession(executor);
        db.prepare("DELETE FROM session_authority_grants_v6 WHERE grantee_session_id = ?").run(executor.id);
        db.exec("BEGIN IMMEDIATE");
        createDelegatedChildAuthority(db, {
          parentProof: executorProof,
          childSessionId: executor.id,
          operationId: "create-executor-a",
          createdAt: NOW,
        });
        db.exec("COMMIT");

        assert.doesNotThrow(() => service.authorize(binding(task.id), "session.get", { sessionId: task.id }));
        assert.throws(
          () => service.authorize(binding(task.id), "turn.run", { sessionId: executor.id }),
          (error) => error instanceof SessionAuthorityError && error.code === "AUTHORITY_FORBIDDEN",
        );
      } finally {
        db.close();
      }
    } finally {
      service.close();
      storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  // @test-value v1
  // kind = "security"
  // claim = "issuer grantをrevokeするとそのrevisionを根拠に発行されたchild proofは同transaction再検証で失効する"
  // oracle = { type = "contract", ref = "AUTONOMY-AUTHORITY-REVOKE-CHAIN" }
  // failure_mode = "親grant失効後も既発行child proofがmutation commitへ到達する"
  // scope = "session-authority-storage"
  // lifecycle = "permanent"
  // @end-test-value
  it("issuer revoke後のchild proofをtransaction内再検証で拒否する", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-authority-revoke-"));
    const dbPath = path.join(directory, "db.sqlite");
    const storage = new SessionStorageV6(dbPath);
    const root = makeRoot("root-a");
    storage.insertSession(root);
    const service = new SessionAuthorityService({
      databasePath: dbPath,
      getExecutionGeneration: () => "generation-1",
      now: () => new Date(NOW),
    });
    try {
      const constructorProof = service.authorize(binding(root.id), "session.create", { sessionRole: "executor" }).proof;
      const child = makeChild("executor-a", root, "executor");
      storage.insertSession(child);
      const db = new DatabaseSync(dbPath);
      try {
        db.prepare("DELETE FROM session_authority_grants_v6 WHERE grantee_session_id = ?").run(child.id);
        createDelegatedChildAuthority(db, {
          parentProof: constructorProof,
          childSessionId: child.id,
          operationId: "create-executor-a",
          createdAt: NOW,
        });
        const childProof = service.authorize(binding(child.id), "session.rename", { sessionId: child.id }).proof;
        revokeSessionAuthorityGrant(db, {
          grantId: constructorProof.grantId,
          expectedRevision: constructorProof.grantRevision,
          principal: { kind: "system", service: "test" },
          revokedAt: "2026-09-05T12:01:00.000Z",
        });
        assert.throws(
          () => assertGrantProofCurrent(db, childProof, new Date("2026-09-05T12:02:00.000Z")),
          (error) => error instanceof SessionAuthorityError && error.code === "AUTHORITY_GRANT_REVISION_CONFLICT",
        );
      } finally {
        db.close();
      }
    } finally {
      service.close();
      storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  // @test-value v1
  // kind = "invariant"
  // claim = "resource event headerはpayloadから独立して保存され、保存後に更新または削除できない"
  // oracle = { type = "contract", ref = "AUTONOMY-HISTORY-APPEND-ONLY-HEADER" }
  // failure_mode = "resource固有payloadの変更経路から共通監査identityを改ざんまたは削除できる"
  // scope = "resource-event-header-storage"
  // lifecycle = "permanent"
  // @end-test-value
  it("resource event headerをappend-onlyで保存する", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-authority-event-"));
    const dbPath = path.join(directory, "db.sqlite");
    const storage = new SessionStorageV6(dbPath);
    storage.insertSession(makeRoot("root-a"));
    const service = new SessionAuthorityService({
      databasePath: dbPath,
      getExecutionGeneration: () => "generation-1",
      now: () => new Date(NOW),
    });
    const db = new DatabaseSync(dbPath);
    try {
      appendResourceEventHeader(db, {
        eventId: "event-a",
        resourceKind: "session",
        resourceId: "root-a",
        rootId: "root-a",
        ownerKind: "session",
        ownerId: "root-a",
        eventKind: "renamed",
        resourceRevision: 2,
        principalKind: "system",
        actorSessionId: null,
        grantId: null,
        grantRevision: null,
        operationId: "operation-a",
        idempotencyKeyFingerprint: null,
        occurredAt: NOW,
        committedAt: NOW,
        supersedesEventId: null,
        payloadSchemaRevision: 1,
        effect: "committed",
      });
      assert.throws(() => db.prepare("UPDATE resource_event_headers_v6 SET event_kind = 'changed' WHERE event_id = 'event-a'").run());
      assert.throws(() => db.prepare("DELETE FROM resource_event_headers_v6 WHERE event_id = 'event-a'").run());
    } finally {
      db.close();
      service.close();
      storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
