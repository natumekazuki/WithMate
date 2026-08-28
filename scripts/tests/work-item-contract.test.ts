import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, it } from "node:test";

import { createOrVerifyV6FreshDatabase } from "../../src-electron/app-database-v6-bootstrap.js";
import { ensureV6Schema } from "../../src-electron/database-schema-v6.js";
import type { ResolvedAgentRuntimeBinding } from "../../src-electron/agent-runtime-binding.js";
import { SessionExecutionStorageV6 } from "../../src-electron/session-execution-storage-v6.js";
import {
  WorkItemAuthorityError,
  WorkItemExecutionAssociationError,
  WorkItemParentError,
  WorkItemService,
} from "../../src-electron/work-item-service.js";
import {
  WorkItemIdempotencyConflictError,
  WorkItemRevisionConflictError,
  WorkItemStateConflictError,
  WorkItemStorageV6,
} from "../../src-electron/work-item-storage-v6.js";
import { parseSessionRuntimeOperationInput } from "../../src/session-external-runtime-contract.js";
import { WORK_ITEM_TRANSITIONS } from "../../src/work-item.js";

const NOW = "2026-08-24T12:00:00.000Z";
const EXPIRES = "2026-08-25T12:00:00.000Z";
const AFTER_EXPIRES = "2026-08-25T12:00:00.001Z";

function binding(actorSessionId: string): ResolvedAgentRuntimeBinding {
  return {
    bindingId: `binding-${actorSessionId}`,
    bindingIdHash: `hash-${actorSessionId}`,
    actorSessionId,
    providerId: "codex",
    executionGeneration: "generation-1",
    authoritySnapshot: {},
    operationGrants: ["session.runtime.invoke"],
    createdAt: NOW,
    expiresAt: null,
  };
}

const sourceIdentity = {
  workspace: "C:/workspace",
  repository: "WithMate",
  branch: "feat/work-item",
  base: "base-1",
  head: "head-1",
};

describe("Work Item contract", () => {
  let directory: string;
  let dbPath: string;
  let storage: WorkItemStorageV6;
  let service: WorkItemService;
  let nextId: number;
  let currentNow: string;

  function makeService(targetStorage: WorkItemStorageV6): WorkItemService {
    return new WorkItemService({
      storage: targetStorage,
      getTurnAuthoritySession(sessionId) {
        const db = new DatabaseSync(dbPath, { readOnly: true });
        try {
          const row = db.prepare(`
            SELECT session.id AS session_id, session.title, role.*
            FROM sessions_v6 AS session
            INNER JOIN session_role_bindings_v6 AS role ON role.session_id = session.id
            WHERE session.id = ?
          `).get(sessionId) as Record<string, unknown> | undefined;
          return row ? {
            sessionId: row.session_id,
            title: row.title,
            sessionRole: row.session_role,
            roleContractRevision: row.role_contract_revision,
            rootSessionId: row.root_session_id,
            parentSessionId: row.parent_session_id,
            delegationDepth: row.delegation_depth,
          } as never : null;
        } finally {
          db.close();
        }
      },
      createWorkItemId: () => `work-${nextId++}`,
      currentTimestamp: () => currentNow,
    });
  }

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "withmate-work-item-"));
    ({ dbPath } = await createOrVerifyV6FreshDatabase(directory));
    const db = new DatabaseSync(dbPath);
    try {
      db.exec("PRAGMA foreign_keys = ON;");
      const insertSession = db.prepare(`
        INSERT INTO sessions_v6 (
          id, title, state, provider_id, catalog_revision, model_id, approval_mode,
          created_at, updated_at, last_active_at
        ) VALUES (?, ?, 'active', 'codex', 1, 'gpt-5', 'on-request', ?, ?, ?)
      `);
      for (const id of ["root", "task", "task-sibling", "executor", "sibling", "standalone", "other-root"]) {
        insertSession.run(id, id, NOW, NOW, NOW);
      }
      const insertRole = db.prepare(`
        INSERT INTO session_role_bindings_v6 (
          session_id, session_role, role_contract_revision, root_session_id, parent_session_id, delegation_depth
        ) VALUES (?, ?, 1, ?, ?, ?)
      `);
      insertRole.run("root", "overall-coordinator", "root", null, 0);
      insertRole.run("task", "task-coordinator", "root", "root", 1);
      insertRole.run("task-sibling", "task-coordinator", "root", "root", 1);
      insertRole.run("executor", "executor", "root", "task", 2);
      insertRole.run("sibling", "executor", "root", "root", 1);
      insertRole.run("standalone", "standalone", "standalone", null, 0);
      insertRole.run("other-root", "overall-coordinator", "other-root", null, 0);
    } finally {
      db.close();
    }
    storage = new WorkItemStorageV6(dbPath);
    nextId = 1;
    currentNow = NOW;
    service = makeService(storage);
  });

  afterEach(async () => {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  });

  function createRootWork(key = "create-root") {
    return service.create({
      targetSessionId: "task",
      goal: "Delegate a task",
      scope: "Work Item slice",
      completionCriteria: "All direct checks pass",
      authority: "Local repository changes",
      sourceIdentity,
      idempotencyKey: key,
    }, binding("root"));
  }

  it("WORK-IDENTITY-01: create replayはimmutable bindingを復元し異なるfingerprintを拒否する", () => {
    const created = createRootWork();
    assert.equal(createRootWork().id, created.id);
    assert.deepEqual(storage.get(created.id), created);
    assert.throws(() => service.create({
      targetSessionId: "sibling",
      goal: "Changed",
      scope: "Work Item slice",
      completionCriteria: "All direct checks pass",
      authority: "Local repository changes",
      sourceIdentity,
      idempotencyKey: "create-root",
    }, binding("root")), WorkItemIdempotencyConflictError);
    assert.equal(storage.get(created.id)?.targetSessionId, "task");
  });

  it("WORK-IDENTITY-01: response loss後のprocess restartも同じcreateへ収束する", () => {
    const created = createRootWork("response-loss");
    storage.close();
    storage = new WorkItemStorageV6(dbPath);
    service = makeService(storage);
    const replayed = createRootWork("response-loss");
    assert.equal(replayed.id, created.id);
    assert.deepEqual(replayed, created);
  });

  it("WORK-IDEM-07: 24時間経過後はledgerを削除して同じkeyを新しい要求へ再利用できる", () => {
    const first = createRootWork("expiring-key");
    currentNow = AFTER_EXPIRES;
    const second = service.create({
      targetSessionId: "task",
      goal: "New delegation after retention",
      scope: "scope",
      completionCriteria: "done",
      authority: "local",
      sourceIdentity,
      idempotencyKey: "expiring-key",
    }, binding("root"));
    assert.notEqual(second.id, first.id);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.equal((db.prepare(`
        SELECT COUNT(*) AS count FROM work_item_idempotency_v6
        WHERE principal_session_id = 'root' AND idempotency_key = 'expiring-key'
      `).get() as { count: number }).count, 1);
    } finally {
      db.close();
    }
  });

  it("WORK-AUTH-02: coordinatorとactive parentだけが直属targetへ委譲できる", () => {
    const parent = createRootWork();
    assert.throws(() => service.create({
      targetSessionId: "root",
      goal: "upward communication is not delegation",
      scope: "scope",
      completionCriteria: "done",
      authority: "none",
      sourceIdentity,
      idempotencyKey: "task-to-root",
    }, binding("task")), WorkItemAuthorityError);
    assert.throws(() => service.create({
      targetSessionId: "task-sibling",
      goal: "sibling communication is not delegation",
      scope: "scope",
      completionCriteria: "done",
      authority: "none",
      sourceIdentity,
      idempotencyKey: "task-to-sibling",
    }, binding("task")), WorkItemAuthorityError);
    assert.throws(() => service.create({
      targetSessionId: "standalone",
      goal: "cross root",
      scope: "scope",
      completionCriteria: "done",
      authority: "none",
      sourceIdentity,
      idempotencyKey: "cross-root",
    }, binding("root")), WorkItemAuthorityError);
    assert.throws(() => service.create({
      targetSessionId: "standalone",
      goal: "forbidden",
      scope: "scope",
      completionCriteria: "done",
      authority: "none",
      sourceIdentity,
      idempotencyKey: "standalone-create",
    }, binding("standalone")), WorkItemAuthorityError);
    assert.throws(() => service.create({
      targetSessionId: "executor",
      goal: "self forbidden",
      scope: "scope",
      completionCriteria: "done",
      authority: "none",
      sourceIdentity,
      idempotencyKey: "executor-create",
    }, binding("executor")), WorkItemAuthorityError);
    assert.throws(() => service.create({
      targetSessionId: "task",
      goal: "self",
      scope: "scope",
      completionCriteria: "done",
      authority: "none",
      sourceIdentity,
      idempotencyKey: "self",
    }, binding("task")), WorkItemAuthorityError);

    const child = service.create({
      targetSessionId: "executor",
      parentWorkItemId: parent.id,
      goal: "child",
      scope: "scope",
      completionCriteria: "done",
      authority: "local",
      sourceIdentity,
      idempotencyKey: "child",
    }, binding("task"));
    assert.equal(child.parentWorkItemId, parent.id);
    assert.throws(() => service.create({
      targetSessionId: "executor",
      parentWorkItemId: child.id,
      goal: "bad parent",
      scope: "scope",
      completionCriteria: "done",
      authority: "local",
      sourceIdentity,
      idempotencyKey: "bad-parent",
    }, binding("task")), WorkItemParentError);
  });

  it("WORK-AUTH-02: bounded listはrootとactor visibilityをstorage queryで固定する", () => {
    const assigned = createRootWork("list-task");
    const sibling = service.create({
      targetSessionId: "sibling",
      goal: "sibling",
      scope: "scope",
      completionCriteria: "done",
      authority: "local",
      sourceIdentity,
      idempotencyKey: "list-sibling",
    }, binding("root"));
    assert.deepEqual(service.resolveListScope(binding("root")), {
      rootSessionId: "root",
      actorSessionId: "root",
      visibility: "root",
    });
    assert.deepEqual(service.resolveListScope(binding("task")), {
      rootSessionId: "root",
      actorSessionId: "task",
      visibility: "actor",
    });
    assert.deepEqual(service.list({ limit: 10, afterSequence: null }, binding("task")).map((item) => item.id), [assigned.id]);
    const firstPage = service.list({ limit: 1, afterSequence: null }, binding("root"));
    assert.deepEqual(firstPage.map((item) => item.id), [assigned.id]);
    assert.deepEqual(
      service.list({ limit: 1, afterSequence: firstPage[0]!.sequence }, binding("root")).map((item) => item.id),
      [sibling.id],
    );
  });

  it("WORK-STATE-03/WORK-RESULT-04: revision付き遷移とterminal resultを同時commitする", () => {
    const item = createRootWork();
    assert.throws(() => service.transition({
      workItemId: item.id,
      state: "in_progress",
      expectedRevision: 1,
      idempotencyKey: "wrong-actor",
    }, binding("root")), WorkItemAuthorityError);
    const started = service.transition({
      workItemId: item.id,
      state: "in_progress",
      expectedRevision: 1,
      idempotencyKey: "start",
    }, binding("task"));
    assert.equal(started.revision, 2);
    const waiting = service.transition({
      workItemId: item.id,
      state: "waiting",
      expectedRevision: 2,
      idempotencyKey: "wait",
    }, binding("task"));
    assert.equal(waiting.state, "waiting");
    assert.throws(() => service.transition({
      workItemId: item.id,
      state: "in_progress",
      expectedRevision: 2,
      idempotencyKey: "stale",
    }, binding("task")), WorkItemRevisionConflictError);
    const resumed = service.transition({
      workItemId: item.id,
      state: "in_progress",
      expectedRevision: 3,
      idempotencyKey: "resume",
    }, binding("task"));
    const completed = service.reportResult({
      workItemId: item.id,
      state: "completed",
      expectedRevision: resumed.revision,
      result: {
        summary: "Completed",
        changes: ["Added Work Item"],
        verificationResults: [{ name: "test", status: "passed", details: "ok" }],
        findings: [],
        unverifiedItems: [],
        remainingWork: [],
      },
      idempotencyKey: "result",
    }, binding("task"));
    assert.equal(completed.state, "completed");
    assert.equal(completed.result?.outcome, "completed");
    assert.equal(completed.result?.reportingSessionId, "task");
    assert.equal(service.reportResult({
      workItemId: item.id,
      state: "completed",
      expectedRevision: resumed.revision,
      result: {
        summary: "Completed",
        changes: ["Added Work Item"],
        verificationResults: [{ name: "test", status: "passed", details: "ok" }],
        findings: [],
        unverifiedItems: [],
        remainingWork: [],
      },
      idempotencyKey: "result",
    }, binding("task")).revision, completed.revision);
    assert.throws(() => storage.mutate({
      operation: "work.transition",
      workItemId: item.id,
      principalSessionId: "task",
      idempotencyKey: "restart-terminal",
      requestFingerprint: "terminal",
      expectedRevision: completed.revision,
      state: "in_progress",
      result: null,
      updatedAt: NOW,
    }), WorkItemStateConflictError);
  });

  it("WORK-STATE-03: 許可遷移tableと全terminal outcomeを閉じた契約として保持する", () => {
    assert.deepEqual(WORK_ITEM_TRANSITIONS, {
      pending: ["in_progress", "canceled"],
      in_progress: ["waiting", "completed", "partially_completed", "failed", "canceled"],
      waiting: ["in_progress", "completed", "partially_completed", "failed", "canceled"],
      completed: [],
      partially_completed: [],
      failed: [],
      canceled: [],
    });
    for (const state of ["partially_completed", "failed"] as const) {
      const item = createRootWork(`create-${state}`);
      const started = service.transition({
        workItemId: item.id,
        state: "in_progress",
        expectedRevision: 1,
        idempotencyKey: `start-${state}`,
      }, binding("task"));
      const terminal = service.reportResult({
        workItemId: item.id,
        state,
        expectedRevision: started.revision,
        result: {
          summary: state,
          changes: [],
          verificationResults: [],
          findings: [],
          unverifiedItems: state === "failed" ? ["verification"] : [],
          remainingWork: ["follow-up"],
        },
        idempotencyKey: `result-${state}`,
      }, binding("task"));
      assert.equal(terminal.state, state);
      assert.equal(terminal.result.outcome, state);
    }
    const canceledItem = createRootWork("create-cancel");
    const canceled = service.cancel({
      workItemId: canceledItem.id,
      expectedRevision: 1,
      idempotencyKey: "cancel",
    }, binding("root"));
    assert.equal(canceled.state, "canceled");
    assert.equal(canceled.result, null);
  });

  it("WORK-RESULT-04: commit failureはstateとidempotencyをrollbackし同一key retryで収束する", () => {
    const item = createRootWork();
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`
        CREATE TRIGGER fail_work_item_update BEFORE UPDATE ON work_items_v6
        BEGIN SELECT RAISE(ABORT, 'injected failure'); END;
      `);
    } finally {
      db.close();
    }
    const mutation = {
      workItemId: item.id,
      state: "in_progress" as const,
      expectedRevision: 1,
      idempotencyKey: "retry-after-failure",
    };
    assert.throws(() => service.transition(mutation, binding("task")));
    assert.equal(storage.get(item.id)?.state, "pending");
    const repair = new DatabaseSync(dbPath);
    try {
      repair.exec("DROP TRIGGER fail_work_item_update;");
    } finally {
      repair.close();
    }
    assert.equal(service.transition(mutation, binding("task")).state, "in_progress");
  });

  it("WORK-RESULT-04: DB CHECKはterminal stateとresult outcomeの不一致を拒否する", () => {
    const item = createRootWork();
    const db = new DatabaseSync(dbPath);
    try {
      assert.throws(() => db.prepare(`
        UPDATE work_items_v6
        SET state = 'completed', result_json = ?
        WHERE id = ?
      `).run(JSON.stringify({ outcome: "failed" }), item.id), /CHECK constraint failed/);
      assert.deepEqual({ ...db.prepare(`
        SELECT state, result_json FROM work_items_v6 WHERE id = ?
      `).get(item.id) }, { state: "pending", result_json: null });
    } finally {
      db.close();
    }
  });

  it("WORK-EXEC-05: active target associationをexecutionと同時保存しterminal/mismatchを拒否する", () => {
    const item = createRootWork();
    assert.equal(service.requireExecutionAssociation(item.id, "root", "task").id, item.id);
    assert.throws(
      () => service.requireExecutionAssociation(item.id, "root", "sibling"),
      WorkItemExecutionAssociationError,
    );
    const executionStorage = new SessionExecutionStorageV6(dbPath);
    try {
      executionStorage.enqueue({
        id: "execution-work-1",
        sessionId: "task",
        request: { turn: { userMessage: "work" } },
        idempotencyKey: "execution-key",
        requestFingerprint: "execution-fingerprint",
        createdAt: NOW,
        expiresAt: EXPIRES,
        workItemId: item.id,
      });
      assert.equal(executionStorage.getExecutionWorkItemId("execution-work-1"), item.id);
    } finally {
      executionStorage.close();
    }
    const restarted = new SessionExecutionStorageV6(dbPath);
    try {
      assert.equal(restarted.getExecutionWorkItemId("execution-work-1"), item.id);
    } finally {
      restarted.close();
    }
    service.cancel({
      workItemId: item.id,
      expectedRevision: 1,
      idempotencyKey: "cancel-associated",
    }, binding("root"));
    assert.throws(
      () => service.requireExecutionAssociation(item.id, "root", "task"),
      WorkItemExecutionAssociationError,
    );
    const staleValidationStorage = new SessionExecutionStorageV6(dbPath);
    try {
      assert.throws(() => staleValidationStorage.enqueue({
        id: "execution-after-terminal",
        sessionId: "task",
        request: { turn: { userMessage: "stale validation" } },
        idempotencyKey: "execution-after-terminal-key",
        requestFingerprint: "execution-after-terminal-fingerprint",
        createdAt: NOW,
        expiresAt: EXPIRES,
        workItemId: item.id,
      }), /Work Item.*active target/);
      assert.equal(staleValidationStorage.get("execution-after-terminal"), null);

      const mismatchedItem = createRootWork("create-target-mismatch");
      assert.throws(() => staleValidationStorage.startImmediate({
        id: "execution-target-mismatch",
        sessionId: "executor",
        request: { turn: { userMessage: "wrong target" } },
        idempotencyKey: "execution-target-mismatch-key",
        requestFingerprint: "execution-target-mismatch-fingerprint",
        createdAt: NOW,
        expiresAt: EXPIRES,
        workItemId: mismatchedItem.id,
      }), /Work Item.*active target/);
      assert.equal(staleValidationStorage.get("execution-target-mismatch"), null);
    } finally {
      staleValidationStorage.close();
    }
    createRootWork("delete-protection");
    const db = new DatabaseSync(dbPath);
    try {
      assert.throws(() => db.prepare("DELETE FROM sessions_v6 WHERE id = 'task'").run(), /WORK_ITEM_SESSION_PROTECTED/);
    } finally {
      db.close();
    }
  });

  it("WORK-MIGRATE-06: partial repairは既存Session、execution、Work Itemを保持して再実行可能に収束する", () => {
    const item = createRootWork();
    const executionStorage = new SessionExecutionStorageV6(dbPath);
    try {
      executionStorage.enqueue({
        id: "execution-existing",
        sessionId: "task",
        request: { turn: { userMessage: "existing" } },
        idempotencyKey: "existing-key",
        requestFingerprint: "existing-fingerprint",
        createdAt: NOW,
        expiresAt: EXPIRES,
      });
    } finally {
      executionStorage.close();
    }
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`
        DROP TABLE work_item_execution_associations_v6;
        DROP TABLE work_item_idempotency_v6;
        DROP TRIGGER trg_v6_work_items_protect_session_delete;
      `);
      ensureV6Schema(db);
      ensureV6Schema(db);
      assert.equal((db.prepare("SELECT COUNT(*) AS count FROM sessions_v6").get() as { count: number }).count, 7);
      assert.equal((db.prepare("SELECT COUNT(*) AS count FROM session_executions_v6 WHERE id = 'execution-existing'").get() as { count: number }).count, 1);
      assert.equal((db.prepare("SELECT COUNT(*) AS count FROM work_items_v6 WHERE id = ?").get(item.id) as { count: number }).count, 1);
      assert.equal((db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'trigger' AND name = 'trg_v6_work_items_protect_session_delete'").get() as { count: number }).count, 1);
    } finally {
      db.close();
    }
  });

  it("WORK-MIGRATE-06/WORK-IDEM-07: expiry列のない既存ledgerを保持して24時間expiryを補完する", () => {
    const item = createRootWork("legacy-ledger");
    storage.close();
    const db = new DatabaseSync(dbPath);
    try {
      db.exec("DROP INDEX IF EXISTS idx_v6_work_item_idempotency_expiry");
      db.exec("ALTER TABLE work_item_idempotency_v6 DROP COLUMN expires_at");
      ensureV6Schema(db);
      const row = db.prepare(`
        SELECT work_item_id, expires_at FROM work_item_idempotency_v6
        WHERE operation = 'work.create' AND principal_session_id = 'root' AND idempotency_key = 'legacy-ledger'
      `).get() as { work_item_id: string; expires_at: string };
      assert.equal(row.work_item_id, item.id);
      assert.equal(row.expires_at, EXPIRES);
    } finally {
      db.close();
    }
    storage = new WorkItemStorageV6(dbPath);
    service = makeService(storage);
  });

  it("WORK-RESULT-04: raw contractはunknown fieldとresult size超過を副作用前に拒否する", () => {
    assert.throws(() => parseSessionRuntimeOperationInput("work.create", {
      targetSessionId: "task",
      goal: "goal",
      scope: "scope",
      completionCriteria: "done",
      authority: "local",
      sourceIdentity,
      idempotencyKey: "key",
      mutableTarget: "no",
    }), /Unknown field/);
    assert.throws(() => parseSessionRuntimeOperationInput("work.result", {
      workItemId: "work-1",
      state: "completed",
      expectedRevision: 1,
      result: {
        summary: "summary",
        changes: Array.from({ length: 20 }, () => "x".repeat(16_000)),
        verificationResults: [],
        findings: [],
        unverifiedItems: [],
        remainingWork: [],
      },
      idempotencyKey: "result",
    }), /byte limit/);
  });
});
