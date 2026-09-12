import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, it } from "node:test";

import { createOrVerifyV6FreshDatabase } from "../../src-electron/app-database-v6-bootstrap.js";
import { backfillBaselineSessionAuthority } from "../../src-electron/session-authority-storage.js";
import { WorkItemAggregationConflictError, WorkItemIdempotencyConflictError, WorkItemStorageV6 } from "../../src-electron/work-item-storage-v6.js";
import { SessionStorageV6 } from "../../src-electron/session-storage-v6.js";
import { buildSessionLifecycleManifest } from "../../src-electron/session-lifecycle-manifest.js";
import { SessionExecutionStorageV6 } from "../../src-electron/session-execution-storage-v6.js";
import { SESSION_AUTHORITY_MAPPING_REVISION, SESSION_AUTHORITY_OPERATION_DEFINITIONS, type MutationAuthorityProof } from "../../src/session-authority.js";
import { parseSessionRuntimeResultEnvelope } from "../../src/session-external-runtime-schema.js";
import type { DelegatedWorkItemBinding, WorkItem } from "../../src/work-item.js";

const NOW = "2026-08-24T12:00:00.000Z";
const LATER = "2026-08-24T12:01:00.000Z";
const EXPIRES = "2026-08-25T12:00:00.000Z";
const SOURCE = { workspace: "C:/workspace", repository: "WithMate", branch: "feat/test", base: "base", head: "head" };

function proof(operation: keyof typeof SESSION_AUTHORITY_OPERATION_DEFINITIONS, ownerId = "root"): MutationAuthorityProof {
  const definition = SESSION_AUTHORITY_OPERATION_DEFINITIONS[operation];
  return {
    principal: { kind: "system", service: "work-item-lifecycle-storage-test" }, providerId: null,
    operation, mappingRevision: SESSION_AUTHORITY_MAPPING_REVISION, action: definition.action,
    resolvedScope: { resourceKind: definition.resourceKind, resourceId: ownerId, rootSessionId: "root", ownerKind: "session", ownerId, relation: "self" },
    effectClass: definition.effectClass, grantId: null, grantRevision: null, evaluatedAt: NOW,
  };
}

function binding(parentWorkItemId: string | null, creatorSessionId: string, targetSessionId: string, goal = "goal"): DelegatedWorkItemBinding {
  return { kind: "delegated", rootSessionId: "root", creatorSessionId, targetSessionId, parentWorkItemId,
    goal, scope: "scope", completionCriteria: "complete", authority: "local", sourceIdentity: SOURCE };
}

describe("WorkItemStorageV6 lifecycle boundary", () => {
  let directory: string;
  let dbPath: string;
  let storage: WorkItemStorageV6;
  let nextId: number;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "withmate-work-item-lifecycle-"));
    ({ dbPath } = await createOrVerifyV6FreshDatabase(directory));
    const db = new DatabaseSync(dbPath);
    try {
      const insertSession = db.prepare(`INSERT INTO sessions_v6 (id,title,state,provider_id,catalog_revision,model_id,approval_mode,workspace_path,created_at,updated_at,last_active_at) VALUES (?,?,'active','codex',1,'gpt-5','on-request',?,?,?,?)`);
      for (const id of ["root", "task", "task-2", "executor"]) insertSession.run(id, id, process.cwd(), NOW, NOW, NOW);
      const insertRole = db.prepare(`INSERT INTO session_role_bindings_v6 (session_id,session_role,role_contract_revision,root_session_id,parent_session_id,delegation_depth) VALUES (?, ?, 1, ?, ?, ?)`);
      insertRole.run("root", "overall-coordinator", "root", null, 0);
      insertRole.run("task", "task-coordinator", "root", "root", 1);
      insertRole.run("task-2", "task-coordinator", "root", "root", 1);
      insertRole.run("executor", "executor", "root", "task", 2);
      db.prepare("UPDATE sessions_v6 SET workspace_path=? WHERE id='executor'").run(directory);
      backfillBaselineSessionAuthority(db, NOW);
    } finally { db.close(); }
    storage = new WorkItemStorageV6(dbPath);
    nextId = 1;
  });

  afterEach(async () => { storage.close(); await rm(directory, { recursive: true, force: true }); });

  function create(parent: string | null, creator: string, target: string, key = `create-${nextId}`): WorkItem {
    const id = `wi-${nextId++}`;
    const db = new DatabaseSync(dbPath, { readOnly: true });
    let containerRevision = 0;
    try { containerRevision = Number((db.prepare("SELECT resource_revision FROM sessions_v6 WHERE id=?").get(target) as { resource_revision?: number } | undefined)?.resource_revision ?? 1); } finally { db.close(); }
    return storage.create({ id, binding: binding(parent, creator, target), principalSessionId: "root", idempotencyKey: key, requestFingerprint: key + "-fp", expectedContainerRevision: containerRevision, createdAt: NOW, expiresAt: EXPIRES, proof: proof("work.create") });
  }

  function settle(item: WorkItem, expectedAggregateRevision?: number): WorkItem {
    const active = storage.mutate({ operation: "work.transition", workItemId: item.id, principalSessionId: "root", idempotencyKey: item.id + "-start", requestFingerprint: item.id + "-start-fp", expectedRevision: item.revision, state: "in_progress", result: null, updatedAt: NOW, expiresAt: EXPIRES, proof: proof("work.transition") });
    return storage.mutate({ operation: "work.result", expectedAggregateRevision, workItemId: item.id, principalSessionId: "root", idempotencyKey: item.id + "-result", requestFingerprint: item.id + "-result-fp", expectedRevision: active.revision, state: "completed", result: { outcome: "completed", summary: "done", changes: [], verificationResults: [], findings: [], unverifiedItems: [], remainingWork: [], reportingSessionId: item.targetSessionId, reportedAt: LATER }, updatedAt: LATER, expiresAt: EXPIRES, proof: proof("work.result") });
  }

  function assertPublicHistory(workItemId: string): void {
    const items = storage.listHistory({ workItemId, afterSequence: null, limit: 100 });
    assert.deepEqual(parseSessionRuntimeResultEnvelope("work.history.list", {
      schemaVersion: "withmate-session-result-v2", operation: "work.history.list", result: { items },
    }).result.items, items);
  }

  function sql<T = Record<string, unknown>>(query: string, ...args: unknown[]): T[] {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try { return db.prepare(query).all(...args) as T[]; } finally { db.close(); }
  }

  // @test-value v2
  // kind = "invariant"
  // claim = "moveは旧decisionを失効させ新parentへ未decisionで所属を移し、空になった旧parentのhandoff後も過去の集約ownerと履歴を保持する"
  // fault = "旧 parent の decision・child membership・result または新 parent の adoption が部分保存され、再open後に履歴とcurrent projectionが分岐する"
  // observable = "work_items_v6, work_item_aggregation_decisions_v6, work_item_aggregations_v6, work_item_aggregation_events_v6, work_item_events_v6"
  // observation_boundary = "component-behavior"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/02-work-item-lifecycle.md" }
  // scope = "WorkItemStorageV6.move"
  // lifecycle = "permanent"
  // distinction = "実DBで旧decision削除・旧新aggregate revision・result保持・reopenを同時に観測する"
  // @end-test-value
  it("terminal childを旧parentから新parentへ原子的にmoveする", () => {
    const oldParent = create(null, "root", "task", "parent-old");
    const newParent = create(null, "root", "task-2", "parent-new");
    const child = settle(create(oldParent.id, "task", "executor", "child"));
    const beforeOld = storage.getAggregationSummary(oldParent.id);
    const beforeNew = storage.getAggregationSummary(newParent.id);
    storage.decideAggregation({ parentWorkItemId: oldParent.id, childWorkItemId: child.id, actorSessionId: "task", decision: "accepted", reason: null, expectedAggregateRevision: beforeOld.aggregateRevision, idempotencyKey: "decision", requestFingerprint: "decision-fp", decidedAt: LATER, expiresAt: EXPIRES, proof: proof("work.aggregation.decide") });
    const moved = storage.move({ workItemId: child.id, expectedRevision: child.revision, principalSessionId: "root", idempotencyKey: "move", requestFingerprint: "move-fp", updatedAt: LATER, expiresAt: EXPIRES, proof: proof("work.move"), destinationParentWorkItemId: newParent.id, expectedAggregateRevision: storage.getAggregationSummary(oldParent.id).aggregateRevision, expectedDestinationAggregateRevision: beforeNew.aggregateRevision });
    assert.equal(moved.parentWorkItemId, newParent.id);
    assert.equal(sql("SELECT aggregate_revision FROM work_item_aggregations_v6 WHERE parent_work_item_id=?", oldParent.id)[0].aggregate_revision, beforeOld.aggregateRevision + 3);
    assert.equal(sql("SELECT aggregate_revision FROM work_item_aggregations_v6 WHERE parent_work_item_id=?", newParent.id)[0].aggregate_revision, beforeNew.aggregateRevision + 1);
    assert.deepEqual(moved.result, child.result);
    assert.equal(storage.getAggregationSummary(oldParent.id).directChildCount, 0);
    assert.equal(storage.getAggregationSummary(newParent.id).undecidedTerminalCount, 1);
    assert.equal(sql("SELECT COUNT(*) AS n FROM work_item_aggregation_decisions_v6 WHERE child_work_item_id=?", child.id)[0].n, 0);
    assert.deepEqual(sql("SELECT event_kind FROM work_item_aggregation_events_v6 WHERE child_work_item_id=?", child.id).map((r) => r.event_kind).sort(), ["child_added", "child_adopted", "child_removed", "decided", "decision_superseded"].sort());
    const movedAggregationEvents = sql<{ event_kind: string; parent_work_item_id: string; payload_json: string }>("SELECT event_kind,parent_work_item_id,payload_json FROM work_item_aggregation_events_v6 WHERE child_work_item_id=? ORDER BY aggregate_revision,event_kind", child.id);
    assert.deepEqual(JSON.parse(movedAggregationEvents.find((event) => event.event_kind === "decision_superseded")!.payload_json), { childRevision: child.revision, decision: "accepted", reason: null, replacementWorkItemId: null });
    assert.deepEqual(JSON.parse(movedAggregationEvents.find((event) => event.event_kind === "child_removed")!.payload_json), { childWorkItemId: child.id, childRevision: child.revision });
    assert.deepEqual(JSON.parse(movedAggregationEvents.find((event) => event.event_kind === "child_adopted")!.payload_json), { childWorkItemId: child.id, childRevision: moved.revision });
    const replayedDecision = storage.decideAggregation({ parentWorkItemId: oldParent.id, childWorkItemId: child.id, actorSessionId: "task", decision: "accepted", reason: null, expectedAggregateRevision: storage.getAggregationSummary(oldParent.id).aggregateRevision, idempotencyKey: "decision", requestFingerprint: "decision-fp", decidedAt: LATER, expiresAt: EXPIRES, proof: proof("work.aggregation.decide") });
    assert.equal(replayedDecision.parentWorkItemId, oldParent.id);
    assert.equal(storage.getAggregationSummary(newParent.id).undecidedTerminalCount, 1);
    assert.equal(sql("SELECT COUNT(*) AS n FROM work_item_aggregation_decisions_v6 WHERE child_work_item_id=?", child.id)[0].n, 0);
    assert.deepEqual(sql("SELECT event_type FROM work_item_events_v6 WHERE work_item_id=? ORDER BY revision", child.id).map((r) => r.event_type), ["created", "state_transitioned", "result_reported", "parent_changed"]);
    const oldHeaders = sql("SELECT * FROM resource_event_headers_v6 WHERE resource_id=? ORDER BY sequence", oldParent.id);
    storage.reassign({ workItemId: oldParent.id, expectedRevision: oldParent.revision, principalSessionId: "root", idempotencyKey: "handoff-empty-parent", requestFingerprint: "handoff-empty-parent-fp", updatedAt: LATER, expiresAt: EXPIRES, proof: proof("work.reassign"), targetSessionId: "executor", transferPolicy: "handoff" });
    assert.deepEqual(sql("SELECT * FROM resource_event_headers_v6 WHERE resource_id=? ORDER BY sequence", oldParent.id).slice(0, oldHeaders.length), oldHeaders);
    storage.close(); storage = new WorkItemStorageV6(dbPath);
    assert.deepEqual(sql("SELECT event_kind,parent_work_item_id,payload_json FROM work_item_aggregation_events_v6 WHERE child_work_item_id=? ORDER BY aggregate_revision,event_kind", child.id), movedAggregationEvents);
    assert.equal(storage.getAggregationSummary(newParent.id).undecidedTerminalCount, 1);
    assert.equal(storage.getAggregationSummary(oldParent.id).directChildCount, 0);
    assert.equal(storage.get(oldParent.id)?.targetSessionId, "executor");
    assertPublicHistory(child.id);
    assertPublicHistory(oldParent.id);
    assert.equal(storage.get(child.id)?.parentWorkItemId, newParent.id);
    assert.equal(storage.get(child.id)?.result?.summary, "done");
    assert.throws(() => storage.move({ workItemId: child.id, expectedRevision: moved.revision, principalSessionId: "root", idempotencyKey: "move", requestFingerprint: "different", updatedAt: LATER, expiresAt: EXPIRES, proof: proof("work.move"), destinationParentWorkItemId: oldParent.id, expectedAggregateRevision: storage.getAggregationSummary(newParent.id).aggregateRevision, expectedDestinationAggregateRevision: storage.getAggregationSummary(oldParent.id).aggregateRevision }), WorkItemIdempotencyConflictError);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "archive/restore は採用済みchildのresultとdecision childRevisionを変更せず、delete は未参照archived canceledのみ物理削除し履歴とretry可能性を保持する"
  // fault = "archive/restoreでdecision snapshotがstale化する、またはdeleteで参照済みWork Itemやeventsを失う"
  // observable = "work_items_v6, work_item_aggregation_decisions_v6, work_item_events_v6, work_item_tombstones_v6, work_item_idempotency_v6"
  // observation_boundary = "component-behavior"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/02-work-item-lifecycle.md" }
  // scope = "WorkItemStorageV6 archive/restore/delete"
  // lifecycle = "permanent"
  // distinction = "decision済みchildのarchive/restoreと孤立canceled Work Itemのdeleteを別実体で観測する"
  // @end-test-value
  it("archive/restoreはdecisionを保全し、孤立canceledだけをdeleteする", () => {
    const parent = create(null, "root", "task", "archive-parent");
    const child = settle(create(parent.id, "task", "executor", "archive-child"));
    const summary = storage.getAggregationSummary(parent.id);
    storage.decideAggregation({ parentWorkItemId: parent.id, childWorkItemId: child.id, actorSessionId: "task", decision: "accepted", reason: null, expectedAggregateRevision: summary.aggregateRevision, idempotencyKey: "archive-decision", requestFingerprint: "archive-decision-fp", decidedAt: LATER, expiresAt: EXPIRES, proof: proof("work.aggregation.decide") });
    const decisionRevision = Number(sql("SELECT child_revision AS n FROM work_item_aggregation_decisions_v6 WHERE child_work_item_id=?", child.id)[0].n);
    const archived = storage.archive({ workItemId: child.id, expectedRevision: child.revision, principalSessionId: "root", idempotencyKey: "archive", requestFingerprint: "archive-fp", updatedAt: LATER, expiresAt: EXPIRES, proof: proof("work.archive"), reason: "retained" });
    const restored = storage.restore({ workItemId: child.id, expectedRevision: archived.revision, principalSessionId: "root", idempotencyKey: "restore", requestFingerprint: "restore-fp", updatedAt: LATER, expiresAt: EXPIRES, proof: proof("work.restore") });
    assert.equal(restored.result?.summary, "done");
    assert.equal(Number(sql("SELECT child_revision AS n FROM work_item_aggregation_decisions_v6 WHERE child_work_item_id=?", child.id)[0].n), decisionRevision);
    const archivedAgain = storage.archive({ workItemId: child.id, expectedRevision: restored.revision, principalSessionId: "root", idempotencyKey: "archive-again", requestFingerprint: "archive-again-fp", updatedAt: LATER, expiresAt: EXPIRES, proof: proof("work.archive"), reason: "retained" });
    let referencedDeleteError: unknown;
    try { storage.delete({ workItemId: child.id, expectedRevision: archivedAgain.revision, principalSessionId: "root", idempotencyKey: "delete-referenced", requestFingerprint: "delete-referenced-fp", updatedAt: LATER, expiresAt: EXPIRES, proof: proof("work.delete") }); } catch (error) { referencedDeleteError = error; }
    assert.equal((referencedDeleteError as { code?: string }).code, "WORK_ITEM_DELETE_REFERENCED");
    storage.restore({ workItemId: child.id, expectedRevision: archivedAgain.revision, principalSessionId: "root", idempotencyKey: "restore-again", requestFingerprint: "restore-again-fp", updatedAt: LATER, expiresAt: EXPIRES, proof: proof("work.restore") });
    const orphan = create(null, "root", "executor", "orphan");
    assertPublicHistory(child.id);
    const canceled = storage.mutate({ operation: "work.cancel", workItemId: orphan.id, principalSessionId: "root", idempotencyKey: "cancel", requestFingerprint: "cancel-fp", expectedRevision: orphan.revision, state: "canceled", result: null, updatedAt: LATER, expiresAt: EXPIRES, proof: proof("work.cancel") });
    const archivedOrphan = storage.archive({ workItemId: canceled.id, expectedRevision: canceled.revision, principalSessionId: "root", idempotencyKey: "archive-orphan", requestFingerprint: "archive-orphan-fp", updatedAt: LATER, expiresAt: EXPIRES, proof: proof("work.archive"), reason: "cleanup" });
    const deleted = storage.delete({ workItemId: archivedOrphan.id, expectedRevision: archivedOrphan.revision, principalSessionId: "root", idempotencyKey: "delete", requestFingerprint: "delete-fp", updatedAt: LATER, expiresAt: EXPIRES, proof: proof("work.delete") });
    assert.equal(deleted.id, orphan.id);
    assert.equal(storage.get(orphan.id)?.deletedAt, LATER);
    assert.equal(sql("SELECT COUNT(*) AS n FROM work_item_events_v6 WHERE work_item_id=?", orphan.id)[0].n, 4);
    assert.equal(sql("SELECT COUNT(*) AS n FROM work_item_tombstones_v6 WHERE work_item_id=?", orphan.id)[0].n, 1);
    assert.equal(sql("SELECT COUNT(*) AS n FROM work_item_idempotency_v6 WHERE work_item_id=?", orphan.id)[0].n >= 3, true);
    const deletedReplay = storage.delete({ workItemId: orphan.id, expectedRevision: deleted.revision, principalSessionId: "root", idempotencyKey: "delete", requestFingerprint: "delete-fp", updatedAt: LATER, expiresAt: EXPIRES, proof: proof("work.delete") });
    assert.equal(deletedReplay.id, orphan.id);
    storage.close(); storage = new WorkItemStorageV6(dbPath);
    assert.equal(storage.get(orphan.id)?.deletedAt, LATER);
    assert.equal(sql("SELECT COUNT(*) AS n FROM work_item_events_v6 WHERE work_item_id=?", orphan.id)[0].n, 4);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "moveのcycle conflictはparent、子孫、集約、event、idempotency rowを変更しない"
  // fault = "循環するmoveがparent/revision/eventまたはidempotency rowを部分更新する"
  // observable = "work_items_v6, work_item_aggregations_v6, work_item_events_v6, work_item_idempotency_v6"
  // observation_boundary = "component-behavior"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/02-work-item-lifecycle.md" }
  // scope = "WorkItemStorageV6.move conflict atomicity"
  // lifecycle = "permanent"
  // distinction = "cycle拒否前後のrow/event/revisionを同一DBで比較する"
  // @end-test-value
  it("拒否されたmoveは原子性を保つ", () => {
    const parent = create(null, "root", "task", "cycle-parent");
    const child = create(parent.id, "task", "executor", "cycle-child");
    const descendant = create(child.id, "executor", "task-2", "cycle-descendant");
    const snapshot = () => ["work_items_v6", "work_item_aggregations_v6", "work_item_events_v6", "work_item_idempotency_v6"].map((table) => sql(`SELECT * FROM ${table} ORDER BY rowid`));
    const before = snapshot();
    let cycleError: unknown;
    try { storage.move({ workItemId: parent.id, expectedRevision: parent.revision, principalSessionId: "root", idempotencyKey: "cycle", requestFingerprint: "cycle-fp", updatedAt: LATER, expiresAt: EXPIRES, proof: proof("work.move"), destinationParentWorkItemId: descendant.id, expectedAggregateRevision: storage.getAggregationSummary(parent.id).aggregateRevision, expectedDestinationAggregateRevision: storage.getAggregationSummary(descendant.id).aggregateRevision }); } catch (error) { cycleError = error; }
    assert.equal((cycleError as { code?: string }).code, "WORK_ITEM_CYCLE");
    assert.deepEqual(snapshot(), before);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "clone、reopen、reassign successor は旧branchを変更せず新IDのWork Itemを作り、predecessor/sourceと予算を記録する"
  // fault = "successor操作が旧Work Itemのresult・decision・履歴を共有または変更し、予算再送で二重計上する"
  // observable = "work_items_v6, work_item_events_v6, work_item_idempotency_v6, resource_budget_dimensions_v6"
  // observation_boundary = "component-behavior"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/02-work-item-lifecycle.md" }
  // scope = "WorkItemStorageV6 clone/reopen/reassign successor"
  // lifecycle = "permanent"
  // distinction = "各 successor の新ID・predecessor/source created event・予算差分・旧branch不変を同一DBで観測する"
  // @end-test-value
  it("successor操作は旧branchを保全し予算を一度だけ消費する", () => {
    const parent = create(null, "root", "task", "successor-parent");
    const pendingSource = create(parent.id, "task", "executor", "successor-source");
    const executions = new SessionExecutionStorageV6(dbPath);
    try {
      const execution = executions.startImmediate({ id: "source-execution", sessionId: "executor", expectedContainerRevision: Number(sql("SELECT resource_revision AS n FROM sessions_v6 WHERE id='executor'")[0].n), request: { userMessage: "source" }, idempotencyKey: "source-execution", requestFingerprint: "source-execution-fp", createdAt: NOW, expiresAt: EXPIRES, workItemId: pendingSource.id, proof: proof("turn.run", "executor") });
      executions.completeRunning({ executionId: execution.execution.id, state: "completed", result: {}, errorCode: "", reason: "done", completedAt: LATER, expiresAt: EXPIRES });
    } finally { executions.close(); }
    const source = settle(pendingSource);
    storage.decideAggregation({ parentWorkItemId: parent.id, childWorkItemId: source.id, actorSessionId: "task", decision: "accepted", reason: null, expectedAggregateRevision: storage.getAggregationSummary(parent.id).aggregateRevision, idempotencyKey: "source-decision", requestFingerprint: "source-decision-fp", decidedAt: LATER, expiresAt: EXPIRES, proof: proof("work.aggregation.decide") });
    const retainedSource = () => [sql("SELECT * FROM work_item_events_v6 WHERE work_item_id=? ORDER BY sequence", source.id), sql("SELECT * FROM work_item_aggregation_decisions_v6 WHERE child_work_item_id=?", source.id), sql("SELECT * FROM work_item_execution_associations_v6 WHERE work_item_id=?", source.id), sql("SELECT * FROM work_item_idempotency_v6 WHERE work_item_id=? ORDER BY operation,idempotency_key", source.id)];
    const sourceHistory = retainedSource();
    const sourceSnapshot = JSON.stringify(source);
    const budget = () => Number(sql("SELECT committed FROM resource_budget_dimensions_v6 d INNER JOIN resource_budget_accounts_v6 a ON a.account_id=d.account_id WHERE a.owner_session_id='root' AND a.account_kind='root' AND d.dimension='workItems'")[0].committed);
    const beforeClone = budget();
    const clone = storage.clone({ workItemId: source.id, expectedRevision: source.revision, principalSessionId: "root", idempotencyKey: "clone", requestFingerprint: "clone-fp", updatedAt: LATER, expiresAt: EXPIRES, proof: proof("work.clone"), targetSessionId: "task", parentWorkItemId: null, expectedContainerRevision: Number(sql("SELECT resource_revision AS n FROM sessions_v6 WHERE id='task'")[0].n), goal: "cloned", scope: source.scope, completionCriteria: source.completionCriteria, authority: source.authority, sourceIdentity: source.sourceIdentity });
    assert.notEqual(clone.id, source.id);
    assert.equal(clone.predecessorWorkItemId ?? null, null);
    assert.equal(clone.result, null);
    assert.deepEqual(sql("SELECT event_type FROM work_item_events_v6 WHERE work_item_id=?", clone.id).map((row) => row.event_type), ["created"]);
    assert.equal(JSON.parse(sql<{ payload_json: string }>("SELECT payload_json FROM work_item_events_v6 WHERE work_item_id=? AND event_type='created'", clone.id)[0].payload_json).sourceWorkItemId, source.id);
    assert.equal(sql("SELECT COUNT(*) AS n FROM work_item_aggregation_decisions_v6 WHERE child_work_item_id=?", clone.id)[0].n, 0);
    assert.equal(sql("SELECT COUNT(*) AS n FROM work_item_execution_associations_v6 WHERE work_item_id=?", clone.id)[0].n, 0);
    assert.equal(JSON.stringify(storage.get(source.id)), sourceSnapshot);
    assert.equal(budget(), beforeClone + 1);
    const replayClone = storage.clone({ workItemId: source.id, expectedRevision: source.revision, principalSessionId: "root", idempotencyKey: "clone", requestFingerprint: "clone-fp", updatedAt: LATER, expiresAt: EXPIRES, proof: proof("work.clone"), targetSessionId: "task", parentWorkItemId: null, expectedContainerRevision: Number(sql("SELECT resource_revision AS n FROM sessions_v6 WHERE id='task'")[0].n) });
    assert.equal(replayClone.id, clone.id);
    assert.equal(budget(), beforeClone + 1);
    const beforeReopen = budget();
    const reopened = storage.reopen({ workItemId: source.id, expectedRevision: source.revision, principalSessionId: "root", idempotencyKey: "reopen", requestFingerprint: "reopen-fp", updatedAt: LATER, expiresAt: EXPIRES, proof: proof("work.reopen"), targetSessionId: "executor", parentWorkItemId: null, goal: "reopened", scope: source.scope, completionCriteria: source.completionCriteria, authority: source.authority, sourceIdentity: source.sourceIdentity, expectedContainerRevision: Number(sql("SELECT resource_revision AS n FROM sessions_v6 WHERE id='executor'")[0].n) });
    assert.notEqual(reopened.id, source.id);
    assert.equal(reopened.predecessorWorkItemId, source.id);
    assert.equal(JSON.parse(sql<{ payload_json: string }>("SELECT payload_json FROM work_item_events_v6 WHERE work_item_id=? AND event_type='created'", reopened.id)[0].payload_json).sourceWorkItemId, source.id);
    assert.equal(reopened.result, null);
    assert.equal(JSON.stringify(storage.get(source.id)), sourceSnapshot);
    assert.equal(budget(), beforeReopen + 1);
    const active = create(null, "root", "executor", "reassign-source");
    const beforeReassign = JSON.stringify(active);
    const beforeReassignBudget = budget();
    const reassigned = storage.reassign({ workItemId: active.id, expectedRevision: active.revision, principalSessionId: "root", idempotencyKey: "reassign", requestFingerprint: "reassign-fp", updatedAt: LATER, expiresAt: EXPIRES, proof: proof("work.reassign"), targetSessionId: "task-2", transferPolicy: "successor", expectedContainerRevision: Number(sql("SELECT resource_revision AS n FROM sessions_v6 WHERE id='task-2'")[0].n) });
    assert.notEqual(reassigned.id, active.id);
    assert.equal(reassigned.predecessorWorkItemId, active.id);
    assert.equal(JSON.parse(sql<{ payload_json: string }>("SELECT payload_json FROM work_item_events_v6 WHERE work_item_id=? AND event_type='created'", reassigned.id)[0].payload_json).sourceWorkItemId, active.id);
    assert.equal(reassigned.targetSessionId, "task-2");
    assert.equal(JSON.stringify(storage.get(active.id)), beforeReassign);
    assert.equal(budget(), beforeReassignBudget + 1);
    const reassignedReplay = storage.reassign({ workItemId: active.id, expectedRevision: active.revision, principalSessionId: "root", idempotencyKey: "reassign", requestFingerprint: "reassign-fp", updatedAt: LATER, expiresAt: EXPIRES, proof: proof("work.reassign"), targetSessionId: "task-2", transferPolicy: "successor", expectedContainerRevision: Number(sql("SELECT resource_revision AS n FROM sessions_v6 WHERE id='task-2'")[0].n) });
    assert.equal(reassignedReplay.id, reassigned.id);
    assert.equal(budget(), beforeReassignBudget + 1);
    assert.deepEqual(sql("SELECT event_type FROM work_item_events_v6 WHERE work_item_id=?", reassigned.id).map((r) => r.event_type), ["created"]);
    storage.close(); storage = new WorkItemStorageV6(dbPath);
    assert.equal(storage.get(reopened.id)?.predecessorWorkItemId, source.id);
    assert.equal(storage.get(reassigned.id)?.targetSessionId, "task-2");
    assert.deepEqual(retainedSource(), sourceHistory);
    assertPublicHistory(reassigned.id);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "reassign handoffは対象Work Itemに紐づくqueued/running executionがある間は拒否し、拒否時のtargetとrevisionを保持する"
  // fault = "handoffが実行中のtargetを変更してexecution帰属を分断する、または拒否時にtarget/revisionを部分更新する"
  // observable = "session_executions_v6, work_item_execution_associations_v6, work_items_v6, work_item_events_v6"
  // observation_boundary = "component-behavior"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/02-work-item-lifecycle.md" }
  // scope = "WorkItemStorageV6.reassign handoff and SessionExecutionStorageV6 association"
  // lifecycle = "permanent"
  // distinction = "実production enqueue/startImmediateでassociationを作り、queued/running各状態のhandoff拒否とrollbackを観測する"
  // @end-test-value
  it("executionがqueuedまたはrunningのhandoffを拒否する", () => {
    const queuedItem = create(null, "root", "executor", "handoff-queued");
    const executions = new SessionExecutionStorageV6(dbPath);
    try {
      const containerRevision = () => Number(sql("SELECT resource_revision AS n FROM sessions_v6 WHERE id='executor'")[0].n);
      const queued = executions.enqueue({ id: "execution-queued", sessionId: "executor", expectedContainerRevision: containerRevision(), request: { turn: { userMessage: "queued" } }, idempotencyKey: "execution-queued", requestFingerprint: "execution-queued-fp", createdAt: NOW, expiresAt: EXPIRES, workItemId: queuedItem.id, proof: proof("turn.enqueue", "executor") });
      const before = storage.get(queuedItem.id)!;
      const queuedHistory = sql("SELECT * FROM work_item_events_v6 WHERE work_item_id=? ORDER BY sequence", queuedItem.id);
      const queuedAssociation = sql("SELECT * FROM work_item_execution_associations_v6 WHERE execution_id=?", queued.execution.id)[0];
      let queuedError: unknown;
      try { storage.reassign({ workItemId: queuedItem.id, expectedRevision: before.revision, principalSessionId: "root", idempotencyKey: "handoff-queued", requestFingerprint: "handoff-queued-fp", updatedAt: LATER, expiresAt: EXPIRES, proof: proof("work.reassign"), targetSessionId: "task-2", transferPolicy: "handoff" }); } catch (error) { queuedError = error; }
      assert.equal((queuedError as { code?: string }).code, "WORK_ITEM_HANDOFF_REQUIRED");
      assert.deepEqual(storage.get(queuedItem.id), before);
      assert.deepEqual(sql("SELECT * FROM work_item_events_v6 WHERE work_item_id=? ORDER BY sequence", queuedItem.id), queuedHistory);
      assert.deepEqual(sql("SELECT * FROM work_item_execution_associations_v6 WHERE execution_id=?", queued.execution.id)[0], queuedAssociation);
      assert.equal(sql("SELECT state FROM session_executions_v6 WHERE id=?", queued.execution.id)[0].state, "queued");
      executions.cancelQueued(queued.execution.id, LATER, EXPIRES);

      const runningItem = create(null, "root", "executor", "handoff-running");
      const running = executions.startImmediate({ id: "execution-running", sessionId: "executor", expectedContainerRevision: containerRevision(), request: { turn: { userMessage: "running" } }, idempotencyKey: "execution-running", requestFingerprint: "execution-running-fp", createdAt: NOW, expiresAt: EXPIRES, workItemId: runningItem.id, proof: proof("turn.run", "executor") });
      const runningBefore = storage.get(runningItem.id)!;
      const runningHistory = sql("SELECT * FROM work_item_events_v6 WHERE work_item_id=? ORDER BY sequence", runningItem.id);
      const runningAssociation = sql("SELECT * FROM work_item_execution_associations_v6 WHERE execution_id=?", running.execution.id)[0];
      let runningError: unknown;
      try { storage.reassign({ workItemId: runningItem.id, expectedRevision: runningBefore.revision, principalSessionId: "root", idempotencyKey: "handoff-running", requestFingerprint: "handoff-running-fp", updatedAt: LATER, expiresAt: EXPIRES, proof: proof("work.reassign"), targetSessionId: "task-2", transferPolicy: "handoff" }); } catch (error) { runningError = error; }
      assert.equal((runningError as { code?: string }).code, "WORK_ITEM_HANDOFF_REQUIRED");
      assert.deepEqual(storage.get(runningItem.id), runningBefore);
      assert.deepEqual(sql("SELECT * FROM work_item_events_v6 WHERE work_item_id=? ORDER BY sequence", runningItem.id), runningHistory);
      assert.deepEqual(sql("SELECT * FROM work_item_execution_associations_v6 WHERE execution_id=?", running.execution.id)[0], runningAssociation);
      assert.equal(sql("SELECT state FROM session_executions_v6 WHERE id=?", running.execution.id)[0].state, "running");
      executions.completeRunning({ executionId: running.execution.id, state: "completed", result: {}, errorCode: "", reason: "done", completedAt: LATER, expiresAt: EXPIRES });
    } finally { executions.close(); }
    storage.close(); storage = new WorkItemStorageV6(dbPath);
    assert.equal(storage.get(queuedItem.id)?.targetSessionId, "executor");
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "確定済みparentからのchild moveは旧結果を保持し、旧集約をstale、新所属を未判断として原子的に保存する"
  // fault = "確定済みparentの集約結果を訂正せずchild所属だけを移動し、旧結果と新集約が同時に有効になる"
  // observable = "work_items_v6, work_item_aggregations_v6, work_item_events_v6, work_item_aggregation_events_v6"
  // observation_boundary = "component-behavior"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/02-work-item-lifecycle.md" }
  // scope = "WorkItemStorageV6.move finalized parent correction"
  // lifecycle = "permanent"
  // distinction = "子resultの事前訂正なしに確定済み親から移動し、再open後の所属、旧結果保持とstaleを観測する"
  // @end-test-value
  it("確定済みparentからのmoveは旧結果を保持し集約をstaleにする", () => {
    const oldParent = create(null, "root", "task", "finalized-parent");
    const child = settle(create(oldParent.id, "task", "executor", "finalized-child"));
    const beforeDecision = storage.getAggregationSummary(oldParent.id);
    storage.decideAggregation({ parentWorkItemId: oldParent.id, childWorkItemId: child.id, actorSessionId: "task", decision: "accepted", reason: null, expectedAggregateRevision: beforeDecision.aggregateRevision, idempotencyKey: "finalized-decision", requestFingerprint: "finalized-decision-fp", decidedAt: LATER, expiresAt: EXPIRES, proof: proof("work.aggregation.decide") });
    const parentRunning = storage.mutate({ operation: "work.transition", workItemId: oldParent.id, principalSessionId: "root", idempotencyKey: "finalized-start", requestFingerprint: "finalized-start-fp", expectedRevision: oldParent.revision, state: "in_progress", result: null, updatedAt: LATER, expiresAt: EXPIRES, proof: proof("work.transition") });
    const finalized = storage.mutate({ operation: "work.result", workItemId: oldParent.id, principalSessionId: "root", idempotencyKey: "finalized-result", requestFingerprint: "finalized-result-fp", expectedRevision: parentRunning.revision, state: "completed", result: { outcome: "completed", summary: "aggregate done", changes: [], verificationResults: [], findings: [], unverifiedItems: [], remainingWork: [], reportingSessionId: oldParent.targetSessionId, reportedAt: LATER }, updatedAt: LATER, expiresAt: EXPIRES, expectedAggregateRevision: storage.getAggregationSummary(oldParent.id).aggregateRevision, proof: proof("work.result") });
    const newParent = create(null, "root", "task-2", "finalized-destination");
    const beforeOld = storage.getAggregationSummary(oldParent.id);
    const beforeNew = storage.getAggregationSummary(newParent.id);
    const originalResult = sql("SELECT * FROM work_item_result_revisions_v6 WHERE work_item_id=?", oldParent.id);
    const moved = storage.move({ workItemId: child.id, expectedRevision: child.revision, principalSessionId: "root", idempotencyKey: "finalized-move", requestFingerprint: "finalized-move-fp", updatedAt: LATER, expiresAt: EXPIRES, proof: proof("work.move"), destinationParentWorkItemId: newParent.id, expectedAggregateRevision: beforeOld.aggregateRevision, expectedDestinationAggregateRevision: beforeNew.aggregateRevision });
    assert.equal(moved.parentWorkItemId, newParent.id);
    assert.deepEqual(storage.get(oldParent.id)?.result, finalized.result);
    assert.deepEqual(sql("SELECT * FROM work_item_result_revisions_v6 WHERE work_item_id=?", oldParent.id), originalResult);
    assert.equal(storage.getAggregationSummary(oldParent.id).stale, true);
    assert.equal(storage.getAggregationSummary(oldParent.id).directChildCount, 0);
    assert.equal(storage.getAggregationSummary(newParent.id).undecidedTerminalCount, 1);
    assert.equal(sql("SELECT * FROM work_item_aggregation_decisions_v6 WHERE child_work_item_id=?", child.id).length, 0);
    assert.equal(sql("SELECT * FROM work_item_aggregation_events_v6 WHERE parent_work_item_id=? AND child_work_item_id=? AND event_kind='decision_superseded'", oldParent.id, child.id).length, 1);
    storage.close(); storage = new WorkItemStorageV6(dbPath);
    assert.equal(storage.get(child.id)?.parentWorkItemId, newParent.id);
    assert.equal(storage.get(oldParent.id)?.resultCurrent, false);
    assert.deepEqual(storage.get(oldParent.id)?.result, finalized.result);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "採用済みchildのarchive/restoreだけのrevision差はSession削除とmanifestを妨げず、未判断childは引き続き削除を阻止する"
  // fault = "表示用lifecycle revisionを未回収結果と誤判定する、または未判断結果の担当Sessionを削除する"
  // observable = "manifest blockers、Session削除の成否とtombstone、decision全行とchild resultの保持、storage再open"
  // observation_boundary = "component-behavior"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/02-work-item-lifecycle.md" }
  // scope = "SessionStorageV6 deletion and lifecycle manifest after Work Item visibility changes"
  // lifecycle = "permanent"
  // @end-test-value
  it("採用済みchildのarchive/restore後も担当Sessionを削除できる", () => {
    const parent = create(null, "root", "task", "delete-parent");
    const children = [settle(create(parent.id, "task", "executor", "delete-archived")), settle(create(parent.id, "task", "task-2", "delete-restored"))];
    const sessions = new SessionStorageV6(dbPath);
    const db = new DatabaseSync(dbPath);
    try {
      for (const [index, child] of children.entries()) {
        assert.ok(buildSessionLifecycleManifest(db, child.targetSessionId).blockers.includes("work_items_present"));
        assert.throws(() => sessions.deleteSession(child.targetSessionId), /WORK_ITEM_SESSION_PROTECTED/);
        const unjudgedArchive = storage.archive({ workItemId: child.id, expectedRevision: child.revision, principalSessionId: "root", idempotencyKey: child.id + "-unjudged-archive", requestFingerprint: child.id + "-unjudged-archive", updatedAt: LATER, expiresAt: EXPIRES, proof: proof("work.archive"), reason: "retained" });
        assert.ok(buildSessionLifecycleManifest(db, child.targetSessionId).blockers.includes("work_items_present"));
        assert.throws(() => sessions.deleteSession(child.targetSessionId), /WORK_ITEM_SESSION_PROTECTED/);
        children[index] = storage.restore({ workItemId: child.id, expectedRevision: unjudgedArchive.revision, principalSessionId: "root", idempotencyKey: child.id + "-unjudged-restore", requestFingerprint: child.id + "-unjudged-restore", updatedAt: LATER, expiresAt: EXPIRES, proof: proof("work.restore") });
        assert.ok(buildSessionLifecycleManifest(db, child.targetSessionId).blockers.includes("work_items_present"));
        assert.throws(() => sessions.deleteSession(child.targetSessionId), /WORK_ITEM_SESSION_PROTECTED/);
        storage.decideAggregation({ parentWorkItemId: parent.id, childWorkItemId: child.id, actorSessionId: "task", decision: "accepted", reason: null, expectedAggregateRevision: storage.getAggregationSummary(parent.id).aggregateRevision, idempotencyKey: child.id + "-accept", requestFingerprint: child.id + "-accept", decidedAt: LATER, expiresAt: EXPIRES, proof: proof("work.aggregation.decide") });
      }
      settle(parent, storage.getAggregationSummary(parent.id).aggregateRevision);
      const decisions = sql("SELECT * FROM work_item_aggregation_decisions_v6 ORDER BY sequence");
      for (const [index, child] of children.entries()) {
        assert.deepEqual(buildSessionLifecycleManifest(db, child.targetSessionId).blockers, []);
        const archived = storage.archive({ workItemId: child.id, expectedRevision: child.revision, principalSessionId: "root", idempotencyKey: child.id + "-archive", requestFingerprint: child.id + "-archive", updatedAt: LATER, expiresAt: EXPIRES, proof: proof("work.archive"), reason: "retained" });
        assert.deepEqual(buildSessionLifecycleManifest(db, child.targetSessionId).blockers, []);
        if (index === 1) {
          storage.restore({ workItemId: child.id, expectedRevision: archived.revision, principalSessionId: "root", idempotencyKey: child.id + "-restore", requestFingerprint: child.id + "-restore", updatedAt: LATER, expiresAt: EXPIRES, proof: proof("work.restore") });
          assert.deepEqual(buildSessionLifecycleManifest(db, child.targetSessionId).blockers, []);
        }
        sessions.deleteSession(child.targetSessionId);
        assert.equal(sessions.getSession(child.targetSessionId), null);
        assert.ok(db.prepare("SELECT deleted_at FROM sessions_v6 WHERE id=?").get(child.targetSessionId)?.deleted_at);
        assert.deepEqual(storage.get(child.id)?.result, child.result);
      }
      assert.deepEqual(sql("SELECT * FROM work_item_aggregation_decisions_v6 ORDER BY sequence"), decisions);
    } finally { db.close(); sessions.close(); }
    storage.close(); storage = new WorkItemStorageV6(dbPath);
    for (const child of children) assert.deepEqual(storage.get(child.id)?.result, child.result);
  });

});
