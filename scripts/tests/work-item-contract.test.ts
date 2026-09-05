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
import { SessionAuthorityService } from "../../src-electron/session-authority-service.js";
import {
  backfillBaselineSessionAuthority,
  revokeSessionAuthorityGrant,
} from "../../src-electron/session-authority-storage.js";
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
  WorkItemAggregationConflictError,
  WorkItemStorageV6,
} from "../../src-electron/work-item-storage-v6.js";
import { parseSessionRuntimeOperationInput } from "../../src/session-external-runtime-contract.js";
import {
  SESSION_AUTHORITY_MAPPING_REVISION,
  SESSION_AUTHORITY_OPERATION_DEFINITIONS,
  type MutationAuthorityProof,
} from "../../src/session-authority.js";
import type { SessionRuntimeOperation } from "../../src/session-external-runtime-contract.js";
import { WORK_ITEM_TRANSITIONS } from "../../src/work-item.js";

const NOW = "2026-08-24T12:00:00.000Z";
const EXPIRES = "2026-08-25T12:00:00.000Z";
const AFTER_EXPIRES = "2026-08-25T12:00:00.001Z";

function trustedProof(operation: SessionRuntimeOperation, ownerId = "root"): MutationAuthorityProof {
  const definition = SESSION_AUTHORITY_OPERATION_DEFINITIONS[operation];
  return {
    principal: { kind: "system", service: "work-item-contract-test" },
    providerId: null,
    operation,
    mappingRevision: SESSION_AUTHORITY_MAPPING_REVISION,
    action: definition.action,
    resolvedScope: {
      resourceKind: definition.resourceKind,
      resourceId: ownerId,
      rootSessionId: "root",
      ownerKind: "session",
      ownerId,
      relation: "self",
    },
    effectClass: definition.effectClass,
    grantId: null,
    grantRevision: null,
    evaluatedAt: NOW,
  };
}

const workItemMutationOperations = {
  create: "work.create",
  revise: "work.revise",
  appendHistory: "work.history.append",
  transition: "work.transition",
  reportResult: "work.result",
  cancel: "work.cancel",
  decideAggregation: "work.aggregation.decide",
  retryAggregation: "work.aggregation.retry",
} as const satisfies Partial<Record<keyof WorkItemService, SessionRuntimeOperation>>;

function withTrustedMutationProof(target: WorkItemService): WorkItemService {
  return new Proxy(target, {
    get(service, property, receiver) {
      const value = Reflect.get(service, property, receiver);
      const operation = workItemMutationOperations[property as keyof typeof workItemMutationOperations];
      if (!operation || typeof value !== "function") return value;
      return (input: unknown, actorBinding: ResolvedAgentRuntimeBinding, proof?: MutationAuthorityProof) =>
        Reflect.apply(value, service, [input, actorBinding, proof ?? trustedProof(operation, actorBinding.actorSessionId)]);
    },
  });
}

function binding(actorSessionId: string): ResolvedAgentRuntimeBinding {
  return {
    bindingId: "binding-" + actorSessionId,
    bindingIdHash: "hash-" + actorSessionId,
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
  let authorityService: SessionAuthorityService;
  let nextId: number;
  let currentNow: string;
  let createContainerRevisions: Map<string, number>;

  function makeService(targetStorage: WorkItemStorageV6): WorkItemService {
    return withTrustedMutationProof(new WorkItemService({
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
      createWorkItemId: () => "work-" + nextId++,
      currentTimestamp: () => currentNow,
    }));
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
      backfillBaselineSessionAuthority(db, NOW);
    } finally {
      db.close();
    }
    storage = new WorkItemStorageV6(dbPath);
    nextId = 1;
    currentNow = NOW;
    createContainerRevisions = new Map();
    authorityService = new SessionAuthorityService({
      databasePath: dbPath,
      getExecutionGeneration: () => "generation-1",
      now: () => new Date(currentNow),
    });
    service = makeService(storage);
  });

  afterEach(async () => {
    authorityService.close();
    storage.close();
    await rm(directory, { recursive: true, force: true });
  });

  function createRootWork(key = "create-root") {
    const expectedContainerRevision = createContainerRevisions.get(key)
      ?? currentSessionResourceRevision("task");
    createContainerRevisions.set(key, expectedContainerRevision);
    return service.create({
      expectedContainerRevision,
      targetSessionId: "task",
      goal: "Delegate a task",
      scope: "Work Item slice",
      completionCriteria: "All direct checks pass",
      authority: "Local repository changes",
      sourceIdentity,
      idempotencyKey: key,
    }, binding("root"));
  }

  function createWithActiveGrant(
    input: Omit<Parameters<WorkItemService["create"]>[0], "expectedContainerRevision">,
    actorBinding: ResolvedAgentRuntimeBinding,
  ) {
    const admittedInput = {
      ...input,
      expectedContainerRevision: currentSessionResourceRevision(input.targetSessionId),
    };
    const proof = authorityService.authorize(actorBinding, "work.create", admittedInput).proof;
    return service.create(admittedInput, actorBinding, proof);
  }

  function createChild(parentWorkItemId: string, key: string) {
    return service.create({
      expectedContainerRevision: currentSessionResourceRevision("executor"),
      targetSessionId: "executor", parentWorkItemId, goal: "child", scope: "scope",
      completionCriteria: "done", authority: "local", sourceIdentity, idempotencyKey: key,
    }, binding("task"));
  }

  function currentSessionResourceRevision(sessionId: string): number {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db.prepare("SELECT resource_revision FROM sessions_v6 WHERE id = ?")
        .get(sessionId) as { resource_revision: number } | undefined;
      assert.ok(row);
      return row.resource_revision;
    } finally {
      db.close();
    }
  }

  function completeChild(workItemId: string, key: string) {
    const active = service.transition({ workItemId, state: "in_progress", expectedRevision: 1, idempotencyKey: key + "-start" }, binding("executor"));
    return service.reportResult({
      workItemId, state: "completed", expectedRevision: active.revision,
      result: { summary: "child result", changes: [], verificationResults: [], findings: [], unverifiedItems: [], remainingWork: [] },
      idempotencyKey: key + "-result",
    }, binding("executor"));
  }

  it("AGG-SCOPE-01/AGG-DECISION-02: 直属terminal childだけをimmutable decisionへ集約する", () => {
    const parent = createRootWork("agg-parent");
    const child = createChild(parent.id, "agg-child");
    completeChild(child.id, "agg-child");
    assert.deepEqual(service.getAggregation({ parentWorkItemId: parent.id }, binding("root")), {
      contractRevision: 1, parentWorkItemId: parent.id, aggregateRevision: 1, directChildCount: 1,
      activeCount: 0, undecidedTerminalCount: 1, acceptedCount: 0, excludedCount: 0, retryRequestedCount: 0,
    });
    assert.throws(() => service.decideAggregation({
      parentWorkItemId: parent.id, childWorkItemId: child.id, decision: "accepted",
      expectedAggregateRevision: 1, idempotencyKey: "wrong-actor",
    }, binding("root")), WorkItemAuthorityError);
    const decision = service.decideAggregation({
      parentWorkItemId: parent.id, childWorkItemId: child.id, decision: "accepted",
      expectedAggregateRevision: 1, idempotencyKey: "accept-child",
    }, binding("task"));
    assert.equal(decision.decision, "accepted");
    assert.equal(service.get(child.id, binding("task")).result?.summary, "child result");
    assert.throws(() => service.decideAggregation({
      parentWorkItemId: parent.id, childWorkItemId: child.id, decision: "excluded", reason: "changed mind",
      expectedAggregateRevision: 2, idempotencyKey: "replace-decision",
    }, binding("task")), WorkItemAggregationConflictError);
    const page = service.listAggregation({ parentWorkItemId: parent.id, limit: 2, afterSequence: null }, binding("root"));
    assert.equal(page.length, 1);
    assert.equal(page[0]?.resultSummary, "child result");
    assert.equal(page[0]?.decision?.decision, "accepted");
  });

  // @test-value v1
  // kind = "regression"
  // claim = "retry decisionとreplacementは同じidempotency keyの再送とprocess restart後の再送で同じ永続結果へ収束する"
  // oracle = { type = "contract", ref = "docs/plans/20260830-session-root-work-item/plan.md#Migration と repair" }
  // failure_mode = "response lossかprocess restart後のretry再送がreplacementを重複作成する、decisionとの対応を失う、または同じkeyの異なるpayloadを受理する"
  // scope = "WorkItemStorageV6 aggregation retry transaction and idempotency"
  // lifecycle = "permanent"
  // distinction = "同一connection内の即時再送に加え、replacementをterminalにした後でstorage connectionを再生成してledger replayを観測する"
  // @end-test-value
  it("AGG-RETRY-03: retry decisionとreplacementをatomicかつ再送可能に保存する", () => {
    const parent = createRootWork("retry-parent");
    const child = createChild(parent.id, "retry-child");
    service.cancel({ workItemId: child.id, expectedRevision: 1, idempotencyKey: "cancel-child" }, binding("task"));
    const db = new DatabaseSync(dbPath);
    try {
      db.prepare(`
        UPDATE session_role_bindings_v6
        SET session_role = 'executor', root_session_id = 'root', parent_session_id = 'task', delegation_depth = 2
        WHERE session_id = 'task-sibling'
      `).run();
    } finally {
      db.close();
    }
    const request = {
      parentWorkItemId: parent.id, childWorkItemId: child.id, targetSessionId: "task-sibling",
      goal: "retry", scope: "retry scope", completionCriteria: "done", authority: "local", sourceIdentity,
      expectedAggregateRevision: 1, idempotencyKey: "retry-request",
    } as const;
    const first = service.retryAggregation(request, binding("task"));
    const replay = service.retryAggregation(request, binding("task"));
    assert.equal(replay.replacement.id, first.replacement.id);
    assert.equal(first.decision.replacementWorkItemId, first.replacement.id);
    assert.equal(storage.get(child.id)?.state, "canceled");
    assert.equal(service.getAggregation({ parentWorkItemId: parent.id }, binding("task")).aggregateRevision, 3);
    service.cancel({
      workItemId: first.replacement.id,
      expectedRevision: first.replacement.revision,
      idempotencyKey: "cancel-replacement-before-replay",
    }, binding("task"));
    storage.close();
    storage = new WorkItemStorageV6(dbPath);
    service = makeService(storage);
    assert.equal(service.retryAggregation(request, binding("task")).replacement.id, first.replacement.id);
    assert.throws(() => service.retryAggregation({ ...request, goal: "different" }, binding("task")), WorkItemIdempotencyConflictError);
  });

  // @test-value v1
  // kind = "contract"
  // claim = "aggregation decisionはterminal childだけを対象とし、canceledはacceptedを拒否しつつexcluded、failedとpartially_completedはexcludedを許可する"
  // oracle = { type = "contract", ref = "docs/design/session-external-runtime.md#Work Item contract" }
  // failure_mode = "未完了または取消済みchildを採用するか、除外可能なterminal結果を集約から外せずparentの完了判定が不正になる"
  // scope = "WorkItemService.decideAggregationのchild state別decision matrix"
  // lifecycle = "permanent"
  // distinction = "active、canceled、failed、partially_completedを一つのdecision境界へ通し、accepted拒否とexcluded許可の差を観測する"
  // @end-test-value
  it("AGG-DECISION-02: activeとcanceled採用を拒否しfailedとpartially_completedを除外できる", () => {
    const parent = createRootWork("state-parent");
    const active = createChild(parent.id, "state-active");
    assert.throws(() => service.decideAggregation({
      parentWorkItemId: parent.id, childWorkItemId: active.id, decision: "accepted",
      expectedAggregateRevision: 1, idempotencyKey: "active-accept",
    }, binding("task")), WorkItemAggregationConflictError);
    service.cancel({ workItemId: active.id, expectedRevision: 1, idempotencyKey: "state-cancel" }, binding("task"));
    assert.throws(() => service.decideAggregation({
      parentWorkItemId: parent.id, childWorkItemId: active.id, decision: "accepted",
      expectedAggregateRevision: 1, idempotencyKey: "canceled-accept",
    }, binding("task")), WorkItemAggregationConflictError);
    service.decideAggregation({
      parentWorkItemId: parent.id, childWorkItemId: active.id, decision: "excluded", reason: "canceled",
      expectedAggregateRevision: 1, idempotencyKey: "canceled-exclude",
    }, binding("task"));
    for (const state of ["failed", "partially_completed"] as const) {
      const child = createChild(parent.id, "state-" + state);
      service.transition({ workItemId: child.id, state: "in_progress", expectedRevision: 1, idempotencyKey: state + "-start" }, binding("executor"));
      service.reportResult({
        workItemId: child.id, state, expectedRevision: 2,
        result: { summary: state, changes: [], verificationResults: [], findings: [], unverifiedItems: [], remainingWork: [] },
        idempotencyKey: state + "-result",
      }, binding("executor"));
      const revision = service.getAggregation({ parentWorkItemId: parent.id }, binding("task")).aggregateRevision;
      service.decideAggregation({
        parentWorkItemId: parent.id, childWorkItemId: child.id, decision: "excluded", reason: state,
        expectedAggregateRevision: revision, idempotencyKey: state + "-exclude",
      }, binding("task"));
    }
    assert.equal(service.getAggregation({ parentWorkItemId: parent.id }, binding("task")).excludedCount, 3);
  });

  it("AGG-RETRY-03: decision insert failureはreplacementとaggregate revisionもrollbackする", () => {
    const parent = createRootWork("rollback-parent");
    const child = createChild(parent.id, "rollback-child");
    service.cancel({ workItemId: child.id, expectedRevision: 1, idempotencyKey: "rollback-cancel" }, binding("task"));
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`CREATE TRIGGER fail_aggregation_decision BEFORE INSERT ON work_item_aggregation_decisions_v6
        BEGIN SELECT RAISE(ABORT, 'injected decision failure'); END;`);
    } finally {
      db.close();
    }
    assert.throws(() => service.retryAggregation({
      parentWorkItemId: parent.id, childWorkItemId: child.id, targetSessionId: "executor",
      goal: "retry", scope: "scope", completionCriteria: "done", authority: "local", sourceIdentity,
      expectedAggregateRevision: 1, idempotencyKey: "rollback-retry",
    }, binding("task")), /injected decision failure/);
    const verify = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.equal((verify.prepare("SELECT COUNT(*) AS count FROM work_items_v6 WHERE parent_work_item_id = ?").get(parent.id) as { count: number }).count, 1);
      assert.equal((verify.prepare("SELECT COUNT(*) AS count FROM work_item_aggregation_decisions_v6").get() as { count: number }).count, 0);
      assert.equal((verify.prepare("SELECT aggregate_revision FROM work_item_aggregations_v6 WHERE parent_work_item_id = ?").get(parent.id) as { aggregate_revision: number }).aggregate_revision, 1);
    } finally {
      verify.close();
    }
  });

  it("AGG-FINALIZE-04: 親resultはcurrent aggregate snapshotが解決済みの場合だけatomicに確定する", () => {
    let parent = createRootWork("final-parent");
    parent = service.transition({ workItemId: parent.id, state: "in_progress", expectedRevision: 1, idempotencyKey: "parent-start" }, binding("task"));
    const child = createChild(parent.id, "final-child");
    completeChild(child.id, "final-child");
    const resultInput = {
      workItemId: parent.id, state: "completed" as const, expectedRevision: parent.revision,
      result: { summary: "integrated", changes: [], verificationResults: [], findings: [], unverifiedItems: [], remainingWork: [] },
      idempotencyKey: "parent-result",
    };
    assert.throws(() => service.reportResult({ ...resultInput, expectedAggregateRevision: 1 }, binding("task")), WorkItemAggregationConflictError);
    assert.equal(storage.get(parent.id)?.state, "in_progress");
    service.decideAggregation({ parentWorkItemId: parent.id, childWorkItemId: child.id, decision: "accepted", expectedAggregateRevision: 1, idempotencyKey: "final-accept" }, binding("task"));
    assert.throws(() => service.reportResult({ ...resultInput, expectedAggregateRevision: 1 }, binding("task")), WorkItemAggregationConflictError);
    const finalized = service.reportResult({ ...resultInput, expectedAggregateRevision: 2 }, binding("task"));
    assert.equal(finalized.state, "completed");
    assert.throws(() => createChild(parent.id, "late-child"), WorkItemParentError);
  });

  // @test-value v1
  // kind = "invariant"
  // claim = "同一principalとidempotency keyの同一create requestはimmutable bindingをreplayし、異なるrequestは拒否する"
  // oracle = { type = "contract", ref = "docs/plans/20260824-session-orchestration-work-item/plan.md#WORK-IDENTITY-01-immutable-binding" }
  // failure_mode = "retryが重複Work Itemを作成するか、同じkeyの別targetやgoalが既存bindingを上書きする"
  // scope = "WorkItemService create idempotency"
  // lifecycle = "permanent"
  // distinction = "同一requestのreplayと異なるtargetのcollisionを同じledgerに対して観測する"
  // @end-test-value
  it("WORK-IDENTITY-01: create replayはimmutable bindingを復元し異なるfingerprintを拒否する", () => {
    const created = createRootWork();
    assert.equal(createRootWork().id, created.id);
    assert.deepEqual(storage.get(created.id), created);
    assert.throws(() => service.create({
      expectedContainerRevision: currentSessionResourceRevision("sibling"),
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

  // @test-value v1
  // kind = "invariant"
  // claim = "trusted principalのWork Item idempotency ledgerは24時間後だけ削除され、同じprincipalとkeyの新規要求へ再利用できる"
  // oracle = { type = "contract", ref = "docs/plans/20260824-session-orchestration-work-item/plan.md#WORK-IDEM-07-idempotency-retention" }
  // failure_mode = "principal namespace変更で期限内ledgerを見失うか、期限後の同じkeyを永久に拒否する"
  // scope = "WorkItemStorageV6 idempotency retention"
  // lifecycle = "permanent"
  // @end-test-value
  it("WORK-IDEM-07: 24時間経過後はledgerを削除して同じkeyを新しい要求へ再利用できる", () => {
    const first = createRootWork("expiring-key");
    currentNow = AFTER_EXPIRES;
    const second = service.create({
      expectedContainerRevision: currentSessionResourceRevision("task"),
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
        WHERE principal_session_id = 'system:work-item-contract-test' AND idempotency_key = 'expiring-key'
      `).get() as { count: number }).count, 1);
    } finally {
      db.close();
    }
  });

  it("AGG-IDEM-06: maintenance cleanupは通常とaggregationの期限切れledgerを同時に削除する", () => {
    const parent = createRootWork("cleanup-parent");
    const child = createChild(parent.id, "cleanup-child");
    service.cancel({
      workItemId: child.id,
      expectedRevision: child.revision,
      idempotencyKey: "cleanup-child-cancel",
    }, binding("task"));
    service.retryAggregation({
      parentWorkItemId: parent.id,
      childWorkItemId: child.id,
      targetSessionId: "executor",
      goal: "retry",
      scope: "scope",
      completionCriteria: "done",
      authority: "local",
      sourceIdentity,
      expectedAggregateRevision: 1,
      idempotencyKey: "cleanup-retry",
    }, binding("task"));
    currentNow = AFTER_EXPIRES;
    assert.equal(service.cleanupExpiredIdempotency(), 4);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.equal((db.prepare("SELECT COUNT(*) AS count FROM work_item_idempotency_v6").get() as { count: number }).count, 0);
      assert.equal((db.prepare("SELECT COUNT(*) AS count FROM work_item_aggregation_idempotency_v6").get() as { count: number }).count, 0);
    } finally {
      db.close();
    }
  });

  // @test-value v1
  // kind = "security"
  // claim = "baseline active grantを持つcoordinatorの直属Work Item作成を許可し、canonical Session tree外またはactive parentなしの委譲を拒否する"
  // oracle = { type = "contract", ref = "docs/plans/20260824-session-orchestration-work-item/plan.md#WORK-AUTH-02-authority" }
  // failure_mode = "正規なactive grantの直属委譲を拒否するか、上方向、sibling、cross-root、自己target、またはinactive parentへの委譲を保存する"
  // scope = "SessionAuthorityService and WorkItemService delegation admission"
  // lifecycle = "permanent"
  // distinction = "許可pathはbaseline active grantのproofを使い、拒否pathはcanonical parent/target graphの各境界を対比する"
  // @end-test-value
  it("WORK-AUTH-02: coordinatorとactive parentだけが直属targetへ委譲できる", () => {
    const parentInput = {
      targetSessionId: "task",
      goal: "Delegate a task",
      scope: "Work Item slice",
      completionCriteria: "All direct checks pass",
      authority: "Local repository changes",
      sourceIdentity,
      idempotencyKey: "create-root",
    };
    const parent = createWithActiveGrant(parentInput, binding("root"));
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

    const childInput = {
      targetSessionId: "executor",
      parentWorkItemId: parent.id,
      goal: "child",
      scope: "scope",
      completionCriteria: "done",
      authority: "local",
      sourceIdentity,
      idempotencyKey: "child",
    };
    const child = createWithActiveGrant(childInput, binding("task"));
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

  // @test-value v1
  // kind = "invariant"
  // claim = "bounded listはactive grantのrelationへ可視範囲を絞り、root_member grant失効後に残るassigned grantでroot全体を公開しない"
  // oracle = { type = "contract", ref = "docs/plans/20260830-session-root-work-item/plan.md#直接検証" }
  // failure_mode = "assigned grantをroot構造だけでroot-wideへ拡張し、失効済みroot_member権限を迂回して同じrootの他target Work Itemを公開する"
  // scope = "WorkItemService bounded list visibility and keyset pagination"
  // lifecycle = "permanent"
  // distinction = "root_member proofでのkeyset paginationと、そのgrantだけを失効した後のassigned proofによるtarget限定一覧を同じfixtureで対比する"
  // @end-test-value
  it("WORK-AUTH-02: bounded listはrootとactor visibilityをstorage queryで固定する", () => {
    const assigned = createWithActiveGrant({
      targetSessionId: "task",
      goal: "Delegate a task",
      scope: "Work Item slice",
      completionCriteria: "All direct checks pass",
      authority: "Local repository changes",
      sourceIdentity,
      idempotencyKey: "list-task",
    }, binding("root"));
    const siblingInput = {
      targetSessionId: "sibling",
      goal: "sibling",
      scope: "scope",
      completionCriteria: "done",
      authority: "local",
      sourceIdentity,
      idempotencyKey: "list-sibling",
    };
    const sibling = createWithActiveGrant(siblingInput, binding("root"));
    const rootBinding = binding("root");
    const rootListInput = { limit: 10, afterSequence: null };
    const rootListProof = authorityService.authorize(rootBinding, "work.list", rootListInput).proof;
    assert.equal(rootListProof.resolvedScope.relation, "root_member");
    assert.deepEqual(service.resolveListScope(rootBinding, rootListProof), {
      rootSessionId: "root",
      actorSessionId: "root",
      visibility: "root",
    });
    const taskBinding = binding("task");
    const taskListProof = authorityService.authorize(taskBinding, "work.list", rootListInput).proof;
    assert.deepEqual(service.resolveListScope(taskBinding, taskListProof), {
      rootSessionId: "root",
      actorSessionId: "task",
      visibility: "target",
    });
    assert.deepEqual(service.list(rootListInput, taskBinding, taskListProof).map((item) => item.id), [assigned.id]);
    const rootItem = storage.get("root-work-item:root");
    assert.ok(rootItem);
    const firstPage = service.list({ limit: 1, afterSequence: null }, rootBinding, rootListProof);
    assert.deepEqual(firstPage.map((item) => item.id), [rootItem.id]);
    const secondPage = service.list({ limit: 1, afterSequence: firstPage[0]!.sequence }, rootBinding, rootListProof);
    assert.deepEqual(secondPage.map((item) => item.id), [assigned.id]);
    assert.deepEqual(service.list({
      limit: 1,
      afterSequence: secondPage[0]!.sequence,
    }, rootBinding, rootListProof).map((item) => item.id), [sibling.id]);

    const db = new DatabaseSync(dbPath);
    try {
      const grant = db.prepare(`
        SELECT grant_id, revision FROM session_authority_grants_v6
        WHERE grantee_session_id = 'root'
          AND relation_selector = 'root_member'
          AND actions_json = '["work.list"]'
      `).get() as { grant_id: string; revision: number };
      revokeSessionAuthorityGrant(db, {
        grantId: grant.grant_id,
        expectedRevision: grant.revision,
        principal: { kind: "system", service: "work-item-contract-test" },
        revokedAt: NOW,
      });
    } finally {
      db.close();
    }
    const assignedProof = authorityService.authorize(rootBinding, "work.list", rootListInput).proof;
    assert.equal(assignedProof.resolvedScope.relation, "assigned");
    assert.deepEqual(service.resolveListScope(rootBinding, assignedProof), {
      rootSessionId: "root",
      actorSessionId: "root",
      visibility: "target",
    });
    assert.deepEqual(service.list(rootListInput, rootBinding, assignedProof).map((item) => item.id), [rootItem.id]);
  });

  // @test-value v1
  // kind = "contract"
  // claim = "Work Item mutationはexpected revisionと状態遷移を検証し、terminal resultを同じtransactionで保存して同一idempotency keyを同じresponseへ収束させる"
  // oracle = { type = "contract", ref = "docs/plans/20260824-session-orchestration-work-item/plan.md#WORK-STATE-03-state-transition" }
  // failure_mode = "stale revision、terminalからの再開、またはresultとstateの部分保存を許し、再送時に異なるprojectionを返す"
  // scope = "WorkItemService and WorkItemStorageV6 mutation boundary"
  // lifecycle = "permanent"
  // distinction = "個別の遷移表ではなくSQLite projection、result、idempotent replay、terminal再遷移拒否を一連のobservableとして検証する"
  // @end-test-value
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
      expiresAt: EXPIRES,
      proof: trustedProof("work.transition", "task"),
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

  // @test-value v1
  // kind = "invariant"
  // claim = "Session executionはactive Work Itemのtargetだけへ関連付けられ、execution作成とassociationを同じtransactionで永続化する"
  // oracle = { type = "contract", ref = "docs/plans/20260824-session-orchestration-work-item/plan.md#WORK-EXEC-05-execution-association" }
  // failure_mode = "terminalまたは別targetのWork Itemをexecutionへ関連付けるか、再起動後にassociationを失って実行帰属が分岐する"
  // scope = "SessionExecutionStorageV6 Work Item association"
  // lifecycle = "permanent"
  // distinction = "serviceの事前判定だけでなくenqueue、即時実行、再起動read、拒否時rollbackをreal SQLiteで観測する"
  // @end-test-value
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
        expectedContainerRevision: currentSessionResourceRevision("task"),
        request: { turn: { userMessage: "work" } },
        idempotencyKey: "execution-key",
        requestFingerprint: "execution-fingerprint",
        createdAt: NOW,
        expiresAt: EXPIRES,
        workItemId: item.id,
        proof: trustedProof("turn.enqueue", "task"),
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
        expectedContainerRevision: 2,
        request: { turn: { userMessage: "stale validation" } },
        idempotencyKey: "execution-after-terminal-key",
        requestFingerprint: "execution-after-terminal-fingerprint",
        createdAt: NOW,
        expiresAt: EXPIRES,
        workItemId: item.id,
        proof: trustedProof("turn.enqueue", "task"),
      }), /Work Item.*active target/);
      assert.equal(staleValidationStorage.get("execution-after-terminal"), null);

      const mismatchedItem = createRootWork("create-target-mismatch");
      assert.throws(() => staleValidationStorage.startImmediate({
        id: "execution-target-mismatch",
        sessionId: "executor",
        expectedContainerRevision: 1,
        request: { turn: { userMessage: "wrong target" } },
        idempotencyKey: "execution-target-mismatch-key",
        requestFingerprint: "execution-target-mismatch-fingerprint",
        createdAt: NOW,
        expiresAt: EXPIRES,
        workItemId: mismatchedItem.id,
        proof: trustedProof("turn.run", "executor"),
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

  // @test-value v1
  // kind = "compatibility"
  // claim = "partial V6 schema repairは既存Session、execution、Work Itemを保持し、欠落したWork Item aggregationとauthority history schemaを再作成して二回実行で収束する"
  // oracle = { type = "contract", ref = "docs/plans/20260824-session-orchestration-work-item/plan.md#Migration" }
  // failure_mode = "repairが既存projectionを消す、aggregation revisionを再構築できない、または再実行でschemaやrowを増殖させる"
  // scope = "ensureV6Schema partial Work Item repair"
  // lifecycle = "permanent"
  // distinction = "fresh database作成ではなく関連表だけを欠落させた既存DBを二回repairし、既存rowと再構築projectionを観測する"
  // @end-test-value
  it("WORK-MIGRATE-06: partial repairは既存Session、execution、Work Itemを保持して再実行可能に収束する", () => {
    const item = createRootWork();
    let parent = createRootWork("migration-parent");
    parent = service.transition({
      workItemId: parent.id,
      state: "in_progress",
      expectedRevision: parent.revision,
      idempotencyKey: "migration-parent-start",
    }, binding("task"));
    const child = createChild(parent.id, "migration-child");
    completeChild(child.id, "migration-child");
    const executionStorage = new SessionExecutionStorageV6(dbPath);
    try {
      executionStorage.enqueue({
        id: "execution-existing",
        sessionId: "task",
        expectedContainerRevision: currentSessionResourceRevision("task"),
        request: { turn: { userMessage: "existing" } },
        idempotencyKey: "existing-key",
        requestFingerprint: "existing-fingerprint",
        createdAt: NOW,
        expiresAt: EXPIRES,
        proof: trustedProof("turn.enqueue", "task"),
      });
    } finally {
      executionStorage.close();
    }
    storage.close();
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`
        DROP TABLE work_item_aggregation_idempotency_v6;
        DROP TABLE work_item_aggregation_decisions_v6;
        DROP TABLE work_item_aggregations_v6;
        DROP TABLE work_item_execution_associations_v6;
        DROP TABLE work_item_idempotency_v6;
        DROP TRIGGER trg_v6_work_items_protect_session_delete;
      `);
      ensureV6Schema(db);
      ensureV6Schema(db);
      assert.equal((db.prepare("SELECT COUNT(*) AS count FROM sessions_v6").get() as { count: number }).count, 7);
      assert.equal((db.prepare("SELECT COUNT(*) AS count FROM session_executions_v6 WHERE id = 'execution-existing'").get() as { count: number }).count, 1);
      assert.equal((db.prepare("SELECT COUNT(*) AS count FROM work_items_v6 WHERE id = ?").get(item.id) as { count: number }).count, 1);
      assert.equal((db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name LIKE 'work_item_aggregation%'").get() as { count: number }).count, 4);
      assert.equal((db.prepare("SELECT aggregate_revision FROM work_item_aggregations_v6 WHERE parent_work_item_id = ?").get(parent.id) as { aggregate_revision: number }).aggregate_revision, 1);
      assert.equal((db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'trigger' AND name = 'trg_v6_work_items_protect_session_delete'").get() as { count: number }).count, 1);
    } finally {
      db.close();
    }
    storage = new WorkItemStorageV6(dbPath);
    service = makeService(storage);
    assert.equal(service.getAggregation({ parentWorkItemId: parent.id }, binding("task")).aggregateRevision, 1);
    service.decideAggregation({
      parentWorkItemId: parent.id,
      childWorkItemId: child.id,
      decision: "accepted",
      expectedAggregateRevision: 1,
      idempotencyKey: "migration-child-accept",
    }, binding("task"));
    const finalized = service.reportResult({
      workItemId: parent.id,
      state: "completed",
      expectedRevision: parent.revision,
      expectedAggregateRevision: 2,
      result: {
        summary: "migrated aggregation finalized",
        changes: [],
        verificationResults: [],
        findings: [],
        unverifiedItems: [],
        remainingWork: [],
      },
      idempotencyKey: "migration-parent-result",
    }, binding("task"));
    assert.equal(finalized.state, "completed");
  });

  // @test-value v1
  // kind = "compatibility"
  // claim = "expiry列のないtrusted principal ledgerを保持し、作成時刻から24時間のexpiryを補完する"
  // oracle = { type = "contract", ref = "docs/plans/20260824-session-orchestration-work-item/plan.md#Migration" }
  // failure_mode = "schema repairがnamespaced principal ledgerを削除するか、誤ったexpiryで再送保護期間を変える"
  // scope = "Work Item idempotency expiry migration"
  // lifecycle = "permanent"
  // @end-test-value
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
        WHERE operation = 'work.create'
          AND principal_session_id = 'system:work-item-contract-test'
          AND idempotency_key = 'legacy-ledger'
      `).get() as { work_item_id: string; expires_at: string };
      assert.equal(row.work_item_id, item.id);
      assert.equal(row.expires_at, EXPIRES);
    } finally {
      db.close();
    }
    storage = new WorkItemStorageV6(dbPath);
    service = makeService(storage);
  });

  // @test-value v1
  // kind = "security"
  // claim = "expected container revision付きWork Item createもunknown fieldを拒否し、result size上限を副作用前に強制する"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/00-shared-authority-and-history.md" }
  // failure_mode = "revision追加でexact inputまたはresult byte limit検証を迂回する"
  // scope = "Session Runtime Work Item mutation parser"
  // lifecycle = "permanent"
  // @end-test-value
  it("WORK-RESULT-04: raw contractはunknown fieldとresult size超過を副作用前に拒否する", () => {
    assert.throws(() => parseSessionRuntimeOperationInput("work.create", {
      expectedContainerRevision: 1,
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
