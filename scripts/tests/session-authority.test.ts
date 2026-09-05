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
  verifySessionAuthorityMigration,
} from "../../src-electron/session-authority-storage.js";
import { SessionStorageV6 } from "../../src-electron/session-storage-v6.js";
import { SessionExecutionStorageV6 } from "../../src-electron/session-execution-storage-v6.js";
import { verifyResourceHistoryProjections } from "../../src-electron/resource-history-schema.js";

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
  // kind = "security"
  // claim = "Session tombstone後は削除前に発行したagent proofと新しいruntime認可の両方を拒否する"
  // oracle = { type = "contract", ref = "AUTONOMY-HISTORY-04" }
  // failure_mode = "retentionのためrole bindingとgrantを残したtombstone Sessionが、削除前proofまたは新しいauthorize経路で操作を継続できる"
  // scope = "Session authority tombstone invalidation"
  // lifecycle = "permanent"
  // distinction = "有効なrename proofを先に取得し、同じSessionのtombstone後に保存境界のproof再検証とservice認可を個別に観測する"
  // @end-test-value
  it("Session tombstone後は既発行proofと新規認可を拒否する", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-authority-tombstone-"));
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
      const proof = service.authorize(binding("root-a"), "session.rename", { sessionId: "root-a" }).proof;
      db.prepare("UPDATE sessions_v6 SET deleted_at = ? WHERE id = 'root-a'").run(NOW);
      assert.throws(
        () => assertGrantProofCurrent(db, proof, new Date(NOW)),
        (error) => error instanceof SessionAuthorityError && error.code === "AUTHORITY_MIGRATION_REQUIRED",
      );
      assert.throws(
        () => service.authorize(binding("root-a"), "session.rename", { sessionId: "root-a" }),
        (error) => error instanceof SessionAuthorityError,
      );
    } finally {
      db.close();
      service.close();
      storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

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
  // claim = "baseline由来grantはRole templateのaction、relation、target Role、delegable、child ceilingと完全一致する場合だけmigration完了になる"
  // oracle = { type = "contract", ref = "AUTONOMY-GRANT-02" }
  // failure_mode = "baseline grantへ余分なactionまたは広いscopeを混ぜてもstartup verifierが受理し、Role templateを超える認可に使われる"
  // scope = "Session authority baseline migration verifier"
  // lifecycle = "permanent"
  // distinction = "正規baseline集合の再実行成功と、同じprovenanceを保った過大action改変のfail-closedを対比する"
  // @end-test-value
  it("過大なbaseline grantをmigration完了として受理しない", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-authority-overgrant-"));
    const dbPath = path.join(directory, "db.sqlite");
    const storage = new SessionStorageV6(dbPath);
    try {
      storage.insertSession(makeRoot("root-a"));
      const db = new DatabaseSync(dbPath);
      try {
        const grant = db.prepare(`
          SELECT grant_id, actions_json, relation_selector, target_session_roles_json, delegable, child_ceiling_json
          FROM session_authority_grants_v6
          WHERE grantee_session_id = 'root-a'
            AND actions_json = '["session.rename"]'
            AND json_extract(provenance_json, '$.source') = 'role-baseline'
        `).get() as {
          grant_id: string;
          actions_json: string;
          relation_selector: string;
          target_session_roles_json: string;
          delegable: number;
          child_ceiling_json: string;
        };
        const cases = [
          { column: "actions_json", invalid: JSON.stringify(["session.rename", "session.get"]), original: grant.actions_json },
          { column: "relation_selector", invalid: "root_member", original: grant.relation_selector },
          { column: "target_session_roles_json", invalid: JSON.stringify(["executor"]), original: grant.target_session_roles_json },
          { column: "delegable", invalid: 1, original: grant.delegable },
          {
            column: "child_ceiling_json",
            invalid: JSON.stringify([{
              mode: "exercise",
              action: "session.rename",
              resourceKind: "session",
              relationSelector: "self",
              targetSessionRoles: [],
              effectClass: "local_mutation",
            }]),
            original: grant.child_ceiling_json,
          },
        ] as const;
        for (const candidate of cases) {
          db.prepare(`UPDATE session_authority_grants_v6 SET ${candidate.column} = ? WHERE grant_id = ?`)
            .run(candidate.invalid, grant.grant_id);
          assert.throws(
            () => verifySessionAuthorityMigration(db),
            (error) => error instanceof SessionAuthorityError && error.code === "AUTHORITY_MIGRATION_REQUIRED",
            candidate.column,
          );
          db.prepare(`UPDATE session_authority_grants_v6 SET ${candidate.column} = ? WHERE grant_id = ?`)
            .run(candidate.original, grant.grant_id);
        }
        assert.doesNotThrow(() => verifySessionAuthorityMigration(db));
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
  // claim = "正規baseline grantのrevokeはmigration証拠を保持したままactive authorityだけを縮小し、startup backfillで権限を復活させない"
  // oracle = { type = "contract", ref = "AUTONOMY-GRANT-02" }
  // failure_mode = "revoke済みbaselineを欠落扱いしてstartupを停止するか、backfillが同じpermissionを再発行して失効を取り消す"
  // scope = "Session authority baseline migration and active grant evaluation"
  // lifecycle = "permanent"
  // distinction = "grant総数とmigration成功に加え、revoke対象operationが再起動相当のservice生成後も拒否されることを観測する"
  // @end-test-value
  it("revoke済みbaselineを再発行せずstartupと権限縮小を両立する", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-authority-revoked-baseline-"));
    const dbPath = path.join(directory, "db.sqlite");
    const storage = new SessionStorageV6(dbPath);
    try {
      storage.insertSession(makeRoot("root-a"));
      const db = new DatabaseSync(dbPath);
      let grantCount = 0;
      try {
        const grant = db.prepare(`
          SELECT grant_id, revision
          FROM session_authority_grants_v6
          WHERE grantee_session_id = 'root-a'
            AND actions_json = '["session.rename"]'
            AND json_extract(provenance_json, '$.source') = 'role-baseline'
        `).get() as { grant_id: string; revision: number };
        grantCount = (db.prepare("SELECT COUNT(*) AS count FROM session_authority_grants_v6").get() as { count: number }).count;
        revokeSessionAuthorityGrant(db, {
          grantId: grant.grant_id,
          expectedRevision: grant.revision,
          principal: { kind: "system", service: "test" },
          revokedAt: "2026-09-05T12:01:00.000Z",
        });
        backfillBaselineSessionAuthority(db, "2026-09-05T12:02:00.000Z");
        assert.equal(
          (db.prepare("SELECT COUNT(*) AS count FROM session_authority_grants_v6").get() as { count: number }).count,
          grantCount,
        );
      } finally {
        db.close();
      }

      const service = new SessionAuthorityService({
        databasePath: dbPath,
        getExecutionGeneration: () => "generation-1",
        now: () => new Date("2026-09-05T12:02:00.000Z"),
      });
      try {
        assert.throws(
          () => service.authorize(binding("root-a"), "session.rename", { sessionId: "root-a" }),
          (error) => error instanceof SessionAuthorityError && error.code === "AUTHORITY_FORBIDDEN",
        );
      } finally {
        service.close();
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
  // kind = "security"
  // claim = "terminal failure通知先のturn.enqueue grantはsource executionのrun/enqueue admissionと同じtransactionで再検証される"
  // oracle = { type = "contract", ref = "TN-AUTH-REVOKE-08" }
  // failure_mode = "通知先proof発行後にgrantをrevokeしても、通知設定を含むexecution、idempotency、履歴、container revisionがcommitされる"
  // scope = "SessionExecutionStorageV6 terminal failure notification admission"
  // lifecycle = "permanent"
  // distinction = "primary execution proofは有効なまま、通知先proofだけをrevokeし、turn.runとturn.enqueueの両方で全書込みがrollbackされることを確認する"
  // @end-test-value
  it("通知先grantの失効後はrunとenqueueを永続化しない", async () => {
    for (const operation of ["turn.run", "turn.enqueue"] as const) {
      const directory = await mkdtemp(path.join(os.tmpdir(), `withmate-notification-revoke-${operation.slice(5)}-`));
      const dbPath = path.join(directory, "db.sqlite");
      const sessionStorage = new SessionStorageV6(dbPath);
      const root = makeRoot("root-a");
      const target = makeChild("executor-a", root, "executor");
      sessionStorage.insertSession(root);
      sessionStorage.insertSession(target);
      const authority = new SessionAuthorityService({
        databasePath: dbPath,
        getExecutionGeneration: () => "generation-1",
        now: () => new Date(NOW),
      });
      const executionStorage = new SessionExecutionStorageV6(dbPath);
      const db = new DatabaseSync(dbPath);
      try {
        const notificationProof = authority.authorizeSessionAct(root.id, "turn.enqueue", {
          sessionId: target.id,
        }).proof;
        revokeSessionAuthorityGrant(db, {
          grantId: notificationProof.grantId!,
          expectedRevision: notificationProof.grantRevision!,
          principal: { kind: "system", service: "test" },
          revokedAt: "2026-09-05T12:01:00.000Z",
        });
        const containerRevision = executionStorage.getSessionContainerRevision(root.id);
        const sourceSession = {
          kind: "session" as const,
          sessionId: root.id,
          character: { characterId: "character-a", name: "A", iconFilePath: "" },
        };
        const input = {
          id: `execution-${operation.slice(5)}`,
          expectedContainerRevision: containerRevision,
          sessionId: root.id,
          request: {
            initiator: sourceSession,
            catalogRevision: 1,
            terminalFailureNotification: {
              contractVersion: 1 as const,
              targetSessionId: target.id,
              sourceSession,
            },
            turn: { provider: "codex", userMessage: "notify on failure" },
          },
          idempotencyKey: `notification-${operation}`,
          requestFingerprint: `notification-${operation}-fingerprint`,
          createdAt: "2026-09-05T12:02:00.000Z",
          expiresAt: "2026-09-06T12:02:00.000Z",
          proof: {
            principal: { kind: "system" as const, service: "test" },
            operation,
            mappingRevision: 1 as const,
            action: operation,
            resolvedScope: {
              resourceKind: "execution" as const,
              resourceId: root.id,
              rootSessionId: root.id,
              ownerKind: "session" as const,
              ownerId: root.id,
              relation: "self" as const,
            },
            effectClass: "external_side_effect" as const,
            grantId: null,
            grantRevision: null,
            evaluatedAt: NOW,
          },
          terminalFailureNotificationProof: notificationProof,
        };
        assert.throws(
          () => operation === "turn.run"
            ? executionStorage.startImmediate(input)
            : executionStorage.enqueue(input),
          (error) => error instanceof SessionAuthorityError && error.code === "AUTHORITY_GRANT_REVISION_CONFLICT",
        );
        assert.equal(db.prepare("SELECT COUNT(*) AS count FROM session_executions_v6").get().count, 0);
        assert.equal(db.prepare("SELECT COUNT(*) AS count FROM session_execution_idempotency_v6").get().count, 0);
        assert.equal(db.prepare("SELECT COUNT(*) AS count FROM session_execution_events_v6").get().count, 0);
        assert.equal(executionStorage.getSessionContainerRevision(root.id), containerRevision);
      } finally {
        db.close();
        executionStorage.close();
        authority.close();
        sessionStorage.close();
        await rm(directory, { recursive: true, force: true });
      }
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

  // @test-value v1
  // kind = "invariant"
  // claim = "Sessionとexecutionの各eventはrevision後のcanonical projectionを保持し、replay結果とcurrent rowの不一致をstartup verifierが拒否する"
  // oracle = { type = "contract", ref = "AUTONOMY-HISTORY-04" }
  // failure_mode = "eventがrequestやresultを欠落したままrevisionだけ一致し、current projectionの改変をverifierが見逃す"
  // scope = "Session and execution resource event replay verifier"
  // lifecycle = "permanent"
  // distinction = "rich projectionをevent payloadから直接確認した後、revisionを変えないcurrent row改変を反証として検出する"
  // @end-test-value
  it("Sessionとexecutionのevent replayをcurrent projectionと照合する", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-resource-history-"));
    const dbPath = path.join(directory, "db.sqlite");
    const storage = new SessionStorageV6(dbPath);
    const root = makeRoot("root-history");
    storage.insertSession(root);
    storage.upsertSession({
      ...root,
      taskTitle: "updated history title",
      allowedAdditionalDirectories: ["C:/workspace/shared"],
    });
    const authority = new SessionAuthorityService({
      databasePath: dbPath,
      getExecutionGeneration: () => "generation-1",
      now: () => new Date(NOW),
    });
    const executions = new SessionExecutionStorageV6(dbPath);
    const db = new DatabaseSync(dbPath);
    try {
      const sessionPayload = JSON.parse((db.prepare(`
        SELECT payload_json
        FROM session_resource_events_v6
        WHERE session_id = ?
        ORDER BY revision DESC
        LIMIT 1
      `).get(root.id) as { payload_json: string }).payload_json) as {
        projection: { title: string; allowedAdditionalDirectories: string[] };
      };
      assert.equal(sessionPayload.projection.title, "updated history title");
      assert.deepEqual(sessionPayload.projection.allowedAdditionalDirectories, ["C:/workspace/shared"]);

      const containerRevision = (db.prepare("SELECT resource_revision FROM sessions_v6 WHERE id = ?")
        .get(root.id) as { resource_revision: number }).resource_revision;
      const proof = authority.authorize(binding(root.id), "turn.run", { sessionId: root.id }).proof;
      executions.startImmediate({
        id: "execution-history",
        expectedContainerRevision: containerRevision,
        sessionId: root.id,
        request: { prompt: "history request", options: { mode: "strict" } },
        idempotencyKey: "history-run",
        requestFingerprint: "history-run-fingerprint",
        createdAt: NOW,
        expiresAt: "2026-09-06T12:00:00.000Z",
        proof,
      });
      executions.completeRunning({
        executionId: "execution-history",
        state: "completed",
        result: { assistantText: "history result" },
        errorCode: "",
        reason: "",
        completedAt: "2026-09-05T12:01:00.000Z",
        expiresAt: "2026-09-06T12:01:00.000Z",
      });
      const executionPayload = JSON.parse((db.prepare(`
        SELECT payload_json
        FROM session_execution_events_v6
        WHERE execution_id = 'execution-history'
        ORDER BY revision DESC
        LIMIT 1
      `).get() as { payload_json: string }).payload_json) as {
        projection: { request: unknown; result: unknown; authorityProof: unknown };
      };
      assert.deepEqual(executionPayload.projection.request, {
        prompt: "history request",
        options: { mode: "strict" },
      });
      assert.deepEqual(executionPayload.projection.result, { assistantText: "history result" });
      assert.ok(executionPayload.projection.authorityProof);
      assert.doesNotThrow(() => verifyResourceHistoryProjections(db));

      db.prepare("UPDATE session_executions_v6 SET reason = 'tampered' WHERE id = 'execution-history'").run();
      assert.throws(
        () => verifyResourceHistoryProjections(db),
        /event replay does not match the current projection/,
      );
    } finally {
      db.close();
      executions.close();
      authority.close();
      storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
