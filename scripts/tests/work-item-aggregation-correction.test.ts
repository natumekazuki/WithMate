import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, it } from "node:test";

import { createOrVerifyV6FreshDatabase } from "../../src-electron/app-database-v6-bootstrap.js";
import { backfillBaselineSessionAuthority } from "../../src-electron/session-authority-storage.js";
import { WorkItemStorageV6 } from "../../src-electron/work-item-storage-v6.js";
import { SESSION_AUTHORITY_MAPPING_REVISION, SESSION_AUTHORITY_OPERATION_DEFINITIONS, type MutationAuthorityProof } from "../../src/session-authority.js";
import type { DelegatedWorkItemBinding, WorkItem, WorkItemResult } from "../../src/work-item.js";

const NOW = "2026-08-24T12:00:00.000Z";
const LATER = "2026-08-24T12:01:00.000Z";
const EXPIRES = "2026-08-25T12:00:00.000Z";
const SOURCE = { workspace: "C:/workspace", repository: "WithMate", branch: "feat/test", base: "base", head: "head" };

function proof(operation: keyof typeof SESSION_AUTHORITY_OPERATION_DEFINITIONS, ownerId = "root"): MutationAuthorityProof {
  const definition = SESSION_AUTHORITY_OPERATION_DEFINITIONS[operation];
  return {
    principal: { kind: "system", service: "work-item-aggregation-correction-test" }, providerId: null,
    operation, mappingRevision: SESSION_AUTHORITY_MAPPING_REVISION, action: definition.action,
    resolvedScope: { resourceKind: definition.resourceKind, resourceId: ownerId, rootSessionId: "root", ownerKind: "session", ownerId, relation: "self" },
    effectClass: definition.effectClass, grantId: null, grantRevision: null, evaluatedAt: NOW,
  };
}

function binding(parentWorkItemId: string | null, creatorSessionId: string, targetSessionId: string, goal = "goal"): DelegatedWorkItemBinding {
  return { kind: "delegated", rootSessionId: "root", creatorSessionId, targetSessionId, parentWorkItemId,
    goal, scope: "scope", completionCriteria: "complete", authority: "local", sourceIdentity: SOURCE };
}

describe("Work Item result and aggregation correction", () => {
  let directory: string;
  let dbPath: string;
  let storage: WorkItemStorageV6;
  let nextId: number;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "withmate-aggregation-correction-"));
    ({ dbPath } = await createOrVerifyV6FreshDatabase(directory));
    const db = new DatabaseSync(dbPath);
    try {
      const insertSession = db.prepare(`INSERT INTO sessions_v6 (id,title,state,provider_id,catalog_revision,model_id,approval_mode,workspace_path,created_at,updated_at,last_active_at) VALUES (?,?,'active','codex',1,'gpt-5','on-request',?,?,?,?)`);
      for (const id of ["root", "task", "executor", "task-2"]) insertSession.run(id, id, process.cwd(), NOW, NOW, NOW);
      const insertRole = db.prepare(`INSERT INTO session_role_bindings_v6 (session_id,session_role,role_contract_revision,root_session_id,parent_session_id,delegation_depth) VALUES (?, ?, 1, ?, ?, ?)`);
      insertRole.run("root", "overall-coordinator", "root", null, 0);
      insertRole.run("task", "task-coordinator", "root", "root", 1);
      insertRole.run("task-2", "task-coordinator", "root", "root", 1);
      insertRole.run("executor", "executor", "root", "task", 2);
      backfillBaselineSessionAuthority(db, NOW);
    } finally { db.close(); }
    storage = new WorkItemStorageV6(dbPath);
    nextId = 1;
  });

  afterEach(async () => { storage.close(); await rm(directory, { recursive: true, force: true }); });

  function sql<T = Record<string, unknown>>(query: string, ...args: unknown[]): T[] {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try { return db.prepare(query).all(...args) as T[]; } finally { db.close(); }
  }

  function create(parentWorkItemId: string | null, creatorSessionId: string, targetSessionId: string, key = `create-${nextId}`): WorkItem {
    const id = `wi-${nextId++}`;
    const revision = Number(sql<{ resource_revision: number }>("SELECT resource_revision FROM sessions_v6 WHERE id=?", targetSessionId)[0].resource_revision);
    return storage.create({ id, binding: binding(parentWorkItemId, creatorSessionId, targetSessionId), principalSessionId: "root", idempotencyKey: key, requestFingerprint: `${key}-fp`, expectedContainerRevision: revision, createdAt: NOW, expiresAt: EXPIRES, proof: proof("work.create") });
  }

  function createRoot(key = `root-${nextId}`): WorkItem {
    const existing = sql<{ id: string }>("SELECT id FROM work_items_v6 WHERE kind='root' AND root_session_id='root' LIMIT 1")[0];
    if (existing) return storage.get(existing.id)!;
    const id = `root-wi-${nextId++}`;
    const db = new DatabaseSync(dbPath);
    try {
      db.prepare(`INSERT INTO work_items_v6 (id,kind,contract_revision,root_session_id,creator_session_id,target_session_id,parent_work_item_id,goal,scope,completion_criteria,authority,source_identity_json,state,revision,progress_summary,blockers_json,next_action,result_json,created_at,updated_at) VALUES (?, 'root', 2, 'root', 'root', 'root', NULL, 'root', 'scope', 'complete', 'local', ?, 'pending', 1, '', '[]', '', NULL, ?, ?)`)
        .run(id, JSON.stringify(SOURCE), NOW, NOW);
      db.prepare(`INSERT INTO work_item_events_v6 (work_item_id,revision,event_type,actor_session_id,principal_kind,payload_json,created_at) VALUES (?,1,'created','root','system',?,?)`)
        .run(id, JSON.stringify({ kind: "root", rootSessionId: "root", creatorSessionId: "root", targetSessionId: "root", parentWorkItemId: null, sourceIdentity: SOURCE, contract: { goal: "root", scope: "scope", completionCriteria: "complete", authority: "local" }, progress: { progressSummary: "", blockers: [], nextAction: "" }, state: "pending", result: null }), NOW);
    } finally { db.close(); }
    return storage.get(id)!;
  }

  function result(item: WorkItem, summary: string): WorkItemResult {
    return { outcome: "completed", summary, changes: [], verificationResults: [], findings: [], unverifiedItems: [], remainingWork: [], reportingSessionId: item.targetSessionId, reportedAt: LATER };
  }

  function settle(item: WorkItem, key = `${item.id}-result`): WorkItem {
    const active = storage.mutate({ operation: "work.transition", workItemId: item.id, principalSessionId: "root", idempotencyKey: `${key}-start`, requestFingerprint: `${key}-start-fp`, expectedRevision: item.revision, state: "in_progress", result: null, updatedAt: NOW, expiresAt: EXPIRES, proof: proof("work.transition") });
    return storage.mutate({ operation: "work.result", workItemId: item.id, principalSessionId: "root", idempotencyKey: key, requestFingerprint: `${key}-fp`, expectedRevision: active.revision, state: "completed", result: result(item, "original"), updatedAt: LATER, expiresAt: EXPIRES, proof: proof("work.result") });
  }

  // @test-value v2
  // kind = "invariant"
  // claim = "terminal result correctionは旧resultを保持したままcurrent projectionとresult_corrected eventを新revisionへ向ける"
  // fault = "訂正がwork_items_v6のresultだけを上書きし、旧result、source/execution provenance、訂正理由を失う"
  // observable = "work_items_v6.result_json, work_item_result_revisions_v6, work_item_events_v6"
  // observation_boundary = "component-behavior"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/03-result-and-aggregation-correction.md" }
  // scope = "WorkItemStorageV6.correctResult"
  // lifecycle = "permanent"
  // distinction = "current projectionとappend-only revision/eventを同じ実SQLiteで突き合わせる"
  // @end-test-value
  it("result訂正は旧revisionとprovenanceを保持する", () => {
    const child = settle(create(null, "root", "executor"));
    const correctedResult = result(child, "corrected");
    const corrected = storage.correctResult({
      workItemId: child.id, expectedRevision: child.revision, expectedResultRevision: 1, result: correctedResult,
      correctionReason: "verification update",
      principalSessionId: "root", idempotencyKey: "correct-result", requestFingerprint: "correct-result-fp",
      updatedAt: LATER, expiresAt: EXPIRES, proof: proof("work.result.correct" as keyof typeof SESSION_AUTHORITY_OPERATION_DEFINITIONS),
    });
    assert.equal(corrected.workItem.result?.summary, "corrected");
    const revisions = sql<{ result_json: string; result_revision: number; superseded_result_revision: number | null; correction_reason: string; source_revision: number; execution_revision: number | null }>("SELECT result_json,result_revision,superseded_result_revision,correction_reason,source_revision,execution_revision FROM work_item_result_revisions_v6 WHERE work_item_id=? ORDER BY result_revision", child.id);
    assert.equal(revisions.length >= 2, true);
    assert.equal(revisions.at(-1)?.result_revision, 2);
    assert.equal(revisions.at(-1)?.superseded_result_revision, 1);
    assert.equal(revisions.at(-1)?.correction_reason, "verification update");
    assert.equal(revisions.at(-1)?.source_revision, child.revision);
    assert.equal(revisions.at(-1)?.execution_revision, null);
    assert.deepEqual(sql<{ event_type: string }>("SELECT event_type FROM work_item_events_v6 WHERE work_item_id=? ORDER BY revision", child.id).map((row) => row.event_type).slice(-1), ["result_reported"]);
    assert.equal(JSON.parse(sql<{ result_json: string }>("SELECT result_json FROM work_item_result_revisions_v6 WHERE work_item_id=? ORDER BY result_revision LIMIT 1", child.id)[0].result_json).summary, "original");
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "旧child result revisionを参照したaggregation correctionはcommitされず、active decisionとaggregate projectionを変更しない"
  // fault = "stale child revisionの訂正がdecision chainへ入り、旧結果をacceptedした判断をcurrentとして再利用する"
  // observable = "work_item_aggregation_decisions_v6, work_item_aggregation_decision_events_v6, WorkItemAggregationSummary"
  // observation_boundary = "component-behavior"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/03-result-and-aggregation-correction.md" }
  // scope = "WorkItemStorageV6.correctAggregation stale child revision"
  // lifecycle = "permanent"
  // distinction = "訂正前後のdecision projectionとevent件数を実DBで観測する"
  // @end-test-value
  it("stale child revisionのaggregation correctionを拒否する", () => {
    const parent = create(null, "root", "task");
    const child = settle(create(parent.id, "task", "executor"));
    const before = storage.getAggregationSummary(parent.id);
    storage.decideAggregation({ parentWorkItemId: parent.id, childWorkItemId: child.id, actorSessionId: "task", decision: "accepted", reason: null, expectedAggregateRevision: before.aggregateRevision, idempotencyKey: "accept", requestFingerprint: "accept-fp", decidedAt: LATER, expiresAt: EXPIRES, proof: proof("work.aggregation.decide") });
    storage.correctResult({
      workItemId: child.id, expectedRevision: child.revision, expectedResultRevision: 1, result: result(child, "corrected after acceptance"),
      correctionReason: "new evidence", principalSessionId: "root",
      idempotencyKey: "stale-result", requestFingerprint: "stale-result-fp", updatedAt: LATER, expiresAt: EXPIRES, proof: proof("work.result.correct" as keyof typeof SESSION_AUTHORITY_OPERATION_DEFINITIONS),
    });
    const beforeRejectSummary = storage.getAggregationSummary(parent.id);
    const beforeRejectDecisions = sql("SELECT * FROM work_item_aggregation_decisions_v6 WHERE parent_work_item_id=?", parent.id);
    assert.throws(() => storage.correctAggregation({
      parentWorkItemId: parent.id, childWorkItemId: child.id, correction: { kind: "revise", decision: "excluded", reason: "stale attempt" },
      expectedAggregateRevision: beforeRejectSummary.aggregateRevision, expectedChildResultRevision: 1, actorSessionId: "task",
      idempotencyKey: "stale-correction", requestFingerprint: "stale-correction-fp", decidedAt: LATER, expiresAt: EXPIRES, proof: proof("work.aggregation.correct" as keyof typeof SESSION_AUTHORITY_OPERATION_DEFINITIONS),
    }));
    assert.deepEqual(storage.getAggregationSummary(parent.id), beforeRejectSummary);
    assert.deepEqual(sql("SELECT * FROM work_item_aggregation_decisions_v6 WHERE parent_work_item_id=?", parent.id), beforeRejectDecisions);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "withdrawはactive decisionを失効させ、childをundecided terminalへ戻してparent finalization条件を再計算する"
  // fault = "withdraw後もaccepted countまたはundecided terminal countが旧projectionに残り、stale aggregateがfinalized扱いになる"
  // observable = "WorkItemAggregationSummary.undecidedTerminalCount, acceptedCount, stale, finalizedRevision"
  // observation_boundary = "component-behavior"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/03-result-and-aggregation-correction.md" }
  // scope = "WorkItemStorageV6.correctAggregation withdraw"
  // lifecycle = "permanent"
  // distinction = "decision correction後のcurrent summaryを旧decision/eventと分けて観測する"
  // @end-test-value
  it("withdraw後は未判断数とstale状態を再計算する", () => {
    const parent = create(null, "root", "task");
    const child = settle(create(parent.id, "task", "executor"));
    const initial = storage.getAggregationSummary(parent.id);
    storage.decideAggregation({ parentWorkItemId: parent.id, childWorkItemId: child.id, actorSessionId: "task", decision: "accepted", reason: null, expectedAggregateRevision: initial.aggregateRevision, idempotencyKey: "accept-withdraw", requestFingerprint: "accept-withdraw-fp", decidedAt: LATER, expiresAt: EXPIRES, proof: proof("work.aggregation.decide") });
    const accepted = storage.getAggregationSummary(parent.id);
    const withdrawn = storage.correctAggregation({
      parentWorkItemId: parent.id, childWorkItemId: child.id, correction: { kind: "withdraw", reason: "reopen review" },
      expectedAggregateRevision: accepted.aggregateRevision, expectedChildResultRevision: 1, actorSessionId: "task",
      idempotencyKey: "withdraw", requestFingerprint: "withdraw-fp", decidedAt: LATER, expiresAt: EXPIRES, proof: proof("work.aggregation.decide"),
    });
    assert.equal(withdrawn?.decision, null);
    assert.equal(withdrawn?.supersededDecisionRevision, 2);
    const summary = storage.getAggregationSummary(parent.id);
    assert.equal(summary.acceptedCount, 0);
    assert.equal(summary.undecidedTerminalCount, 1);
    assert.equal(summary.stale, true);
    assert.equal(summary.finalizedRevision, null);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "同じcorrection/finalize requestの再送はrevisionとresult/eventを重複生成せず、response loss後にread-back可能である"
  // fault = "effect-bearing correctionの再送が別revisionを生成し、旧decisionと新decisionのprovenanceを二重化する"
  // observable = "result revision count, aggregation decision event count, idempotency response, current projection"
  // observation_boundary = "component-behavior"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/03-result-and-aggregation-correction.md" }
  // scope = "WorkItemStorageV6 correction replay"
  // lifecycle = "permanent"
  // distinction = "同一idempotency keyのreplayを保存行数とcurrent projectionで検証する"
  // @end-test-value
  it("correction replayは一度だけrevisionを進める", () => {
    const child = settle(create(null, "root", "executor"));
    const input = {
      workItemId: child.id, expectedRevision: child.revision, expectedResultRevision: 1, result: result(child, "replayed correction"),
      correctionReason: "response lost",
      principalSessionId: "root", idempotencyKey: "response-loss", requestFingerprint: "response-loss-fp",
      updatedAt: LATER, expiresAt: EXPIRES, proof: proof("work.result.correct" as keyof typeof SESSION_AUTHORITY_OPERATION_DEFINITIONS),
    };
    const first = storage.correctResult(input);
    storage.correctResult({ ...input, expectedRevision: first.workItem.revision, expectedResultRevision: first.resultRevision, result: result(child, "later correction"), correctionReason: "later evidence", idempotencyKey: "later-correction", requestFingerprint: "later-correction-fp" });
    const replay = storage.correctResult(input);
    assert.deepEqual(replay, first);
    assert.equal(sql("SELECT COUNT(*) AS n FROM work_item_result_revisions_v6 WHERE work_item_id=?", child.id)[0].n, 3);
    assert.equal(sql("SELECT COUNT(*) AS n FROM work_item_events_v6 WHERE work_item_id=? AND event_type='result_reported'", child.id)[0].n, 3);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "retry/replaceは旧childのdecision、replacement child、replacement provenanceを一つの集約履歴として保持する"
  // fault = "retryが旧decisionを消去する、replacementを別parentへ作る、または同じidempotency keyで予算とchildを二重生成する"
  // observable = "work_item_aggregation_decisions_v6, work_item_aggregation_events_v6, replacement Work Item parent/predecessor, budget events"
  // observation_boundary = "component-behavior"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/03-result-and-aggregation-correction.md" }
  // scope = "WorkItemStorageV6.retryAggregation replacement provenance"
  // lifecycle = "permanent"
  // distinction = "旧child decisionとreplacementの所属・履歴・再送時の予算増分を同時に観測する"
  // @end-test-value
  it("retry replacementのprovenanceを保持し再送で二重生成しない", () => {
    const parent = create(null, "root", "task");
    const child = settle(create(parent.id, "task", "executor"));
    const summary = storage.getAggregationSummary(parent.id);
    const input = {
      parentWorkItemId: parent.id, childWorkItemId: child.id, actorSessionId: "task", expectedAggregateRevision: summary.aggregateRevision,
      idempotencyKey: "retry-provenance", requestFingerprint: "retry-provenance-fp", replacementId: "replacement-provenance",
      replacementBinding: binding(parent.id, "task", "executor", "replacement"), decidedAt: LATER, expiresAt: EXPIRES, reason: "retry evidence", proof: proof("work.aggregation.retry"),
    };
    const first = storage.retryAggregation(input);
    const second = storage.retryAggregation(input);
    assert.equal(first.replacement.id, second.replacement.id);
    assert.equal(first.decision.decision, "retry_requested");
    assert.equal(first.decision.replacementWorkItemId, first.replacement.id);
    assert.equal(first.replacement.parentWorkItemId, parent.id);
    assert.equal(first.replacement.predecessorWorkItemId ?? null, null);
    assert.equal(sql("SELECT COUNT(*) AS n FROM work_items_v6 WHERE id=?", first.replacement.id)[0].n, 1);
    assert.equal(sql("SELECT COUNT(*) AS n FROM work_item_aggregation_decisions_v6 WHERE child_work_item_id=?", child.id)[0].n, 1);
    const retryEvents = sql<{ event_kind: string; child_work_item_id: string; payload_json: string }>("SELECT event_kind,child_work_item_id,payload_json FROM work_item_aggregation_events_v6 WHERE parent_work_item_id=? ORDER BY event_id", parent.id);
    assert.ok(retryEvents.some((event) => event.event_kind === "child_added" && event.child_work_item_id === first.replacement.id && JSON.parse(event.payload_json).childWorkItemId === first.replacement.id));
    assert.ok(retryEvents.some((event) => event.event_kind === "retry_requested" && event.child_work_item_id === child.id && JSON.parse(event.payload_json).replacementWorkItemId === first.replacement.id));
    assert.equal(sql("SELECT COUNT(*) AS n FROM resource_budget_reservations_v6 WHERE idempotency_key=?", `work.aggregation.retry:${first.replacement.id}`)[0].n, 1);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "finalizeのexpected aggregate revision不一致はresult、finalized event、idempotency responseを一切保存しない"
  // fault = "finalize検証を保存後に行い、親resultだけまたはaggregate finalized markerだけを残す"
  // observable = "parent Work Item projection, work_item_events_v6, work_item_idempotency_v6, WorkItemAggregationSummary"
  // observation_boundary = "component-behavior"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/03-result-and-aggregation-correction.md" }
  // scope = "WorkItemStorageV6.mutate work.result finalize atomicity"
  // lifecycle = "permanent"
  // distinction = "失敗前後の親projection・event・idempotency・summaryを同一transaction境界で比較する"
  // @end-test-value
  it("finalizeのstale aggregate拒否は原子的である", () => {
    const parent = create(null, "root", "task");
    const child = settle(create(parent.id, "task", "executor"));
    const beforeSummary = storage.getAggregationSummary(parent.id);
    const beforeParent = storage.get(parent.id);
    const active = storage.mutate({ operation: "work.transition", workItemId: parent.id, principalSessionId: "root", idempotencyKey: "finalize-atomic-start", requestFingerprint: "finalize-atomic-start-fp", expectedRevision: parent.revision, state: "in_progress", result: null, updatedAt: NOW, expiresAt: EXPIRES, proof: proof("work.transition") });
    const beforeFailedFinalizeEvents = sql("SELECT * FROM work_item_events_v6 WHERE work_item_id=?", parent.id);
    const beforeFailedFinalizeIdempotency = sql("SELECT * FROM work_item_idempotency_v6 WHERE work_item_id=?", parent.id);
    assert.throws(() => storage.mutate({ operation: "work.result", expectedAggregateRevision: beforeSummary.aggregateRevision - 1, workItemId: parent.id, principalSessionId: "root", idempotencyKey: "finalize-atomic-fail", requestFingerprint: "finalize-atomic-fail-fp", expectedRevision: active.revision, state: "completed", result: result(parent, "must not commit"), updatedAt: LATER, expiresAt: EXPIRES, proof: proof("work.result") }));
    assert.equal(storage.get(parent.id)?.state, "in_progress");
    assert.equal(storage.get(parent.id)?.result, null);
    assert.deepEqual(storage.getAggregationSummary(parent.id), beforeSummary);
    assert.deepEqual(sql("SELECT * FROM work_item_events_v6 WHERE work_item_id=?", parent.id), beforeFailedFinalizeEvents);
    assert.deepEqual(sql("SELECT * FROM work_item_idempotency_v6 WHERE work_item_id=?", parent.id), beforeFailedFinalizeIdempotency);
    assert.equal(child.state, "completed");
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "finalize eventの保存失敗は親result、finalized projection、idempotencyを同じtransactionでrollbackする"
  // fault = "finalized eventのtrigger failure後に親resultまたはresponseだけが残り、再送時にeffect certaintyを失う"
  // observable = "parent projection, work_item_events_v6, work_item_aggregations_v6, work_item_idempotency_v6"
  // observation_boundary = "component-behavior"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/03-result-and-aggregation-correction.md" }
  // scope = "finalize transaction failure injection"
  // lifecycle = "permanent"
  // distinction = "SQLite triggerでevent insertだけを失敗させ、transaction rollback後の全projectionを比較する"
  // @end-test-value
  it("finalize event insert failureは全projectionをrollbackする", () => {
    const parent = create(null, "root", "task", "finalize-trigger-parent");
    const child = settle(create(parent.id, "task", "executor", "finalize-trigger-child"));
    const summary = storage.getAggregationSummary(parent.id);
    storage.decideAggregation({ parentWorkItemId: parent.id, childWorkItemId: child.id, actorSessionId: "task", decision: "accepted", reason: null, expectedAggregateRevision: summary.aggregateRevision, idempotencyKey: "finalize-trigger-decision", requestFingerprint: "finalize-trigger-decision-fp", decidedAt: LATER, expiresAt: EXPIRES, proof: proof("work.aggregation.decide") });
    const active = storage.mutate({ operation: "work.transition", workItemId: parent.id, principalSessionId: "root", idempotencyKey: "finalize-trigger-start", requestFingerprint: "finalize-trigger-start-fp", expectedRevision: parent.revision, state: "in_progress", result: null, updatedAt: NOW, expiresAt: EXPIRES, proof: proof("work.transition") });
    const beforeWork = storage.get(parent.id);
    const beforeEvents = sql("SELECT * FROM work_item_events_v6 WHERE work_item_id=?", parent.id);
    const beforeAggregation = sql("SELECT * FROM work_item_aggregations_v6 WHERE parent_work_item_id=?", parent.id);
    const beforeIdempotency = sql("SELECT * FROM work_item_idempotency_v6 WHERE work_item_id=?", parent.id);
    const db = new DatabaseSync(dbPath);
    try { db.exec(`CREATE TRIGGER fail_finalize_event BEFORE INSERT ON work_item_events_v6 WHEN NEW.work_item_id = '${parent.id}' AND NEW.event_type = 'result_reported' BEGIN SELECT RAISE(ABORT, 'injected finalize event failure'); END`); } finally { db.close(); }
    assert.throws(() => storage.mutate({ operation: "work.result", workItemId: parent.id, principalSessionId: "root", idempotencyKey: "finalize-trigger-result", requestFingerprint: "finalize-trigger-result-fp", expectedRevision: active.revision, expectedAggregateRevision: storage.getAggregationSummary(parent.id).aggregateRevision, state: "completed", result: result(parent, "must rollback"), updatedAt: LATER, expiresAt: EXPIRES, proof: proof("work.result") }));
    const cleanup = new DatabaseSync(dbPath); try { cleanup.exec("DROP TRIGGER fail_finalize_event"); } finally { cleanup.close(); }
    assert.deepEqual(storage.get(parent.id), beforeWork);
    assert.deepEqual(sql("SELECT * FROM work_item_events_v6 WHERE work_item_id=?", parent.id), beforeEvents);
    assert.deepEqual(sql("SELECT * FROM work_item_aggregations_v6 WHERE parent_work_item_id=?", parent.id), beforeAggregation);
    assert.deepEqual(sql("SELECT * FROM work_item_idempotency_v6 WHERE work_item_id=?", parent.id), beforeIdempotency);
  });

  // @test-value v2
  // kind = "compatibility"
  // claim = "result correction後のpopulated databaseをreopenしてもcurrent result、旧revision、訂正eventを同じprojectionへ再生できる"
  // fault = "再open時にresult revision履歴を捨てる、current resultを旧値へ戻す、またはevent chainを切断する"
  // observable = "work_items_v6.result_json, work_item_result_revisions_v6, work_item_events_v6 after storage reopen"
  // observation_boundary = "component-behavior"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/03-result-and-aggregation-correction.md" }
  // scope = "populated result correction migration/reopen"
  // lifecycle = "permanent"
  // distinction = "populated correction dataをclose/reopen後に実SQLiteで再読込する"
  // @end-test-value
  it("populated correction履歴はstorage再open後も保持する", () => {
    const child = settle(create(null, "root", "executor"));
    const corrected = storage.correctResult({
      workItemId: child.id, expectedRevision: child.revision, expectedResultRevision: 1, result: result(child, "persisted correction"),
      correctionReason: "migration fixture", principalSessionId: "root", idempotencyKey: "persisted-correction", requestFingerprint: "persisted-correction-fp", updatedAt: LATER, expiresAt: EXPIRES, proof: proof("work.result.correct" as keyof typeof SESSION_AUTHORITY_OPERATION_DEFINITIONS),
    });
    const beforeRows = sql("SELECT * FROM work_item_result_revisions_v6 WHERE work_item_id=? ORDER BY result_revision", child.id);
    const beforeEvents = sql("SELECT event_type,revision,payload_json FROM work_item_events_v6 WHERE work_item_id=? ORDER BY revision", child.id);
    storage.close();
    storage = new WorkItemStorageV6(dbPath);
    assert.equal(storage.get(child.id)?.result?.summary, corrected.workItem.result?.summary);
    assert.deepEqual(sql("SELECT * FROM work_item_result_revisions_v6 WHERE work_item_id=? ORDER BY result_revision", child.id), beforeRows);
    assert.deepEqual(sql("SELECT event_type,revision,payload_json FROM work_item_events_v6 WHERE work_item_id=? ORDER BY revision", child.id), beforeEvents);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "同一root内のterminal parent訂正後はchildを新parentへ移し、旧branchをreopen successorとして履歴付きで再接続できる"
  // fault = "訂正済みstale parentでもmoveを無条件拒否する、旧parentのdecisionを消す、またはsuccessorのpredecessor/parent provenanceを失う"
  // observable = "old/new aggregate summaries, child.parentWorkItemId, parent_changed events, successor.predecessorWorkItemId"
  // observation_boundary = "component-behavior"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/03-result-and-aggregation-correction.md" }
  // scope = "same-root move/reopen after terminal parent correction"
  // lifecycle = "permanent"
  // distinction = "terminal parentの訂正、decision再確定、same-root move、reopen successorを一つの実DBで観測する"
  // @end-test-value
  it("same-rootの訂正後move/reopenは所属履歴を保つ", () => {
    const oldParent = create(null, "root", "task", "same-root-old-parent");
    const child = settle(create(oldParent.id, "task", "executor", "same-root-child"));
    const beforeDecision = storage.getAggregationSummary(oldParent.id);
    storage.decideAggregation({ parentWorkItemId: oldParent.id, childWorkItemId: child.id, actorSessionId: "task", decision: "accepted", reason: null, expectedAggregateRevision: beforeDecision.aggregateRevision, idempotencyKey: "same-root-accept", requestFingerprint: "same-root-accept-fp", decidedAt: LATER, expiresAt: EXPIRES, proof: proof("work.aggregation.decide") });
    const parentActive = storage.mutate({ operation: "work.transition", workItemId: oldParent.id, principalSessionId: "root", idempotencyKey: "same-root-parent-start", requestFingerprint: "same-root-parent-start-fp", expectedRevision: oldParent.revision, state: "in_progress", result: null, updatedAt: NOW, expiresAt: EXPIRES, proof: proof("work.transition") });
    storage.mutate({ operation: "work.result", workItemId: oldParent.id, principalSessionId: "root", idempotencyKey: "same-root-parent-result", requestFingerprint: "same-root-parent-result-fp", expectedRevision: parentActive.revision, expectedAggregateRevision: storage.getAggregationSummary(oldParent.id).aggregateRevision, state: "completed", result: result(oldParent, "parent finalized"), updatedAt: LATER, expiresAt: EXPIRES, proof: proof("work.result") });
    const corrected = storage.correctResult({ workItemId: child.id, expectedRevision: child.revision, expectedResultRevision: 1, result: result(child, "child corrected"), correctionReason: "parent review", principalSessionId: "root", idempotencyKey: "same-root-child-correction", requestFingerprint: "same-root-child-correction-fp", updatedAt: LATER, expiresAt: EXPIRES, proof: proof("work.result.correct" as keyof typeof SESSION_AUTHORITY_OPERATION_DEFINITIONS) });
    const staleParent = storage.getAggregationSummary(oldParent.id);
    storage.correctAggregation({ parentWorkItemId: oldParent.id, childWorkItemId: child.id, expectedAggregateRevision: staleParent.aggregateRevision, expectedChildResultRevision: 2, correction: { kind: "revise", decision: "accepted", reason: "reconfirmed" }, actorSessionId: "task", idempotencyKey: "same-root-reconfirm", requestFingerprint: "same-root-reconfirm-fp", decidedAt: LATER, expiresAt: EXPIRES, proof: proof("work.aggregation.correct" as keyof typeof SESSION_AUTHORITY_OPERATION_DEFINITIONS) });
    const newParent = create(null, "root", "task-2", "same-root-new-parent");
    const moved = storage.move({ workItemId: child.id, expectedRevision: corrected.workItem.revision, principalSessionId: "root", idempotencyKey: "same-root-move", requestFingerprint: "same-root-move-fp", updatedAt: LATER, expiresAt: EXPIRES, proof: proof("work.move"), destinationParentWorkItemId: newParent.id, expectedAggregateRevision: storage.getAggregationSummary(oldParent.id).aggregateRevision, expectedDestinationAggregateRevision: storage.getAggregationSummary(newParent.id).aggregateRevision });
    assert.equal(moved.parentWorkItemId, newParent.id);
    assert.equal(storage.getAggregationSummary(oldParent.id).directChildCount, 0);
    assert.equal(storage.getAggregationSummary(newParent.id).directChildCount, 1);
    const reopened = storage.reopen({ workItemId: moved.id, expectedRevision: moved.revision, principalSessionId: "root", idempotencyKey: "same-root-reopen", requestFingerprint: "same-root-reopen-fp", updatedAt: LATER, expiresAt: EXPIRES, proof: proof("work.reopen"), targetSessionId: "executor", parentWorkItemId: newParent.id, goal: "reopened", scope: moved.scope, completionCriteria: moved.completionCriteria, authority: moved.authority, sourceIdentity: moved.sourceIdentity, expectedContainerRevision: Number(sql<{ resource_revision: number }>("SELECT resource_revision FROM sessions_v6 WHERE id='executor'")[0].resource_revision) });
    assert.equal(reopened.parentWorkItemId, newParent.id);
    assert.equal(reopened.predecessorWorkItemId, moved.id);
    assert.equal(JSON.parse(sql<{ payload_json: string }>("SELECT payload_json FROM work_item_events_v6 WHERE work_item_id=? AND event_type='created'", reopened.id)[0].payload_json).sourceWorkItemId, moved.id);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "flatten readはdepth、cursor、field projectionをboundedに適用し、孫のdecision mutation authorityを付与しない"
  // fault = "深さ制限を越えて全descendantを返す、full resultを無制限hydrateする、root read proofからchild correctionを許可する"
  // observable = "listAggregationItems output size/fields and correction authorization error"
  // observation_boundary = "component-behavior"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/03-result-and-aggregation-correction.md" }
  // scope = "aggregation bounded flatten and authority separation"
  // lifecycle = "permanent"
  // distinction = "direct childとgrandchildを作り、depth/limit/cursorとmutation ownerを分離して観測する"
  // @end-test-value
  it("flattenはbounded readでmutation authorityを拡張しない", () => {
    const parent = create(null, "root", "task", "flatten-parent");
    const child = create(parent.id, "task", "executor", "flatten-child");
    const grandchild = create(child.id, "executor", "task-2", "flatten-grandchild");
    const direct = storage.listAggregationItems({ parentWorkItemId: parent.id, depth: 1, fields: ["summary"], afterSequence: null, limit: 1 });
    assert.equal(direct.length, 1);
    const flattened = storage.listAggregationItems({ parentWorkItemId: parent.id, depth: 8, fields: ["summary", "decision", "provenance"], afterSequence: null, limit: 10 });
    assert.ok(flattened.some((item) => item.child.id === child.id));
    assert.ok(flattened.some((item) => item.child.id === grandchild.id));
    assert.ok(flattened.length <= 10);
    const flattenedGrandchild = flattened.find((item) => item.child.id === grandchild.id)!;
    assert.equal(flattenedGrandchild.resultRevision, 0);
    assert.equal(flattenedGrandchild.resultCurrent, false);
    assert.equal(flattenedGrandchild.stale, false);
    assert.equal(flattenedGrandchild.provenance?.parentWorkItemId, child.id);
    assert.throws(() => storage.correctAggregation({ parentWorkItemId: parent.id, childWorkItemId: grandchild.id, expectedAggregateRevision: storage.getAggregationSummary(parent.id).aggregateRevision, expectedChildResultRevision: 1, correction: { kind: "withdraw", reason: "must be rejected" }, actorSessionId: "task", idempotencyKey: "flatten-authority", requestFingerprint: "flatten-authority-fp", decidedAt: LATER, expiresAt: EXPIRES, proof: proof("work.aggregation.correct" as keyof typeof SESSION_AUTHORITY_OPERATION_DEFINITIONS) }));
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "3階層のterminal parentでchild correctionが発生するとstaleが中間parentと上位parentへ伝播し、stale aggregateの新規採用を拒否する"
  // fault = "stale propagationが一段で止まる、上位parentが旧final resultをcurrent採用する、または訂正前decisionを再利用する"
  // observable = "three WorkItemAggregationSummary stale flags/reasons, parent result correction conflict, decision revisions"
  // observation_boundary = "component-behavior"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/03-result-and-aggregation-correction.md" }
  // scope = "nested stale propagation and re-decision"
  // lifecycle = "permanent"
  // distinction = "top/mid/leafの3階層を実SQLiteでfinalizeし、leaf訂正後の各ancestor projectionを直接比較する"
  // @end-test-value
  it("nested correctionは上位aggregateまでstaleを伝播する", () => {
    const top = create(null, "root", "task", "nested-top");
    const mid = create(top.id, "task", "executor", "nested-mid");
    const leaf = settle(create(mid.id, "executor", "task-2", "nested-leaf"));
    const midBefore = storage.getAggregationSummary(mid.id);
    storage.decideAggregation({ parentWorkItemId: mid.id, childWorkItemId: leaf.id, actorSessionId: "executor", decision: "accepted", reason: null, expectedAggregateRevision: midBefore.aggregateRevision, idempotencyKey: "nested-mid-decision", requestFingerprint: "nested-mid-decision-fp", decidedAt: LATER, expiresAt: EXPIRES, proof: proof("work.aggregation.decide") });
    const midRunning = storage.mutate({ operation: "work.transition", workItemId: mid.id, principalSessionId: "root", idempotencyKey: "nested-mid-start", requestFingerprint: "nested-mid-start-fp", expectedRevision: mid.revision, state: "in_progress", result: null, updatedAt: NOW, expiresAt: EXPIRES, proof: proof("work.transition") });
    storage.mutate({ operation: "work.result", workItemId: mid.id, principalSessionId: "root", idempotencyKey: "nested-mid-result", requestFingerprint: "nested-mid-result-fp", expectedRevision: midRunning.revision, expectedAggregateRevision: storage.getAggregationSummary(mid.id).aggregateRevision, state: "completed", result: result(mid, "mid finalized"), updatedAt: LATER, expiresAt: EXPIRES, proof: proof("work.result") });
    const topBefore = storage.getAggregationSummary(top.id);
    storage.decideAggregation({ parentWorkItemId: top.id, childWorkItemId: mid.id, actorSessionId: "task", decision: "accepted", reason: null, expectedAggregateRevision: topBefore.aggregateRevision, idempotencyKey: "nested-top-decision", requestFingerprint: "nested-top-decision-fp", decidedAt: LATER, expiresAt: EXPIRES, proof: proof("work.aggregation.decide") });
    const topRunning = storage.mutate({ operation: "work.transition", workItemId: top.id, principalSessionId: "root", idempotencyKey: "nested-top-start", requestFingerprint: "nested-top-start-fp", expectedRevision: top.revision, state: "in_progress", result: null, updatedAt: NOW, expiresAt: EXPIRES, proof: proof("work.transition") });
    storage.mutate({ operation: "work.result", workItemId: top.id, principalSessionId: "root", idempotencyKey: "nested-top-result", requestFingerprint: "nested-top-result-fp", expectedRevision: topRunning.revision, expectedAggregateRevision: storage.getAggregationSummary(top.id).aggregateRevision, state: "completed", result: result(top, "top finalized"), updatedAt: LATER, expiresAt: EXPIRES, proof: proof("work.result") });
    const corrected = storage.correctResult({ workItemId: leaf.id, expectedRevision: leaf.revision, expectedResultRevision: 1, result: result(leaf, "leaf corrected"), correctionReason: "new verification", principalSessionId: "root", idempotencyKey: "nested-leaf-correction", requestFingerprint: "nested-leaf-correction-fp", updatedAt: LATER, expiresAt: EXPIRES, proof: proof("work.result.correct" as keyof typeof SESSION_AUTHORITY_OPERATION_DEFINITIONS) });
    assert.equal(corrected.resultRevision, 2);
    assert.equal(storage.getAggregationSummary(mid.id).stale, true);
    assert.equal(storage.getAggregationSummary(top.id).stale, true);
    assert.throws(() => storage.correctAggregation({ parentWorkItemId: top.id, childWorkItemId: mid.id, expectedAggregateRevision: storage.getAggregationSummary(top.id).aggregateRevision, expectedChildResultRevision: 1, correction: { kind: "revise", decision: "accepted", reason: "stale adoption" }, actorSessionId: "task", idempotencyKey: "nested-top-stale-adoption", requestFingerprint: "nested-top-stale-adoption-fp", decidedAt: LATER, expiresAt: EXPIRES, proof: proof("work.aggregation.correct" as keyof typeof SESSION_AUTHORITY_OPERATION_DEFINITIONS) }), { code: "WORK_ITEM_AGGREGATION_CHILD_REVISION_CONFLICT" });
    const midSummary = storage.getAggregationSummary(mid.id);
    storage.correctAggregation({ parentWorkItemId: mid.id, childWorkItemId: leaf.id, expectedAggregateRevision: midSummary.aggregateRevision, expectedChildResultRevision: corrected.resultRevision, correction: { kind: "revise", decision: "accepted", reason: "leaf rechecked" }, actorSessionId: "executor", idempotencyKey: "nested-mid-recheck", requestFingerprint: "nested-mid-recheck-fp", decidedAt: LATER, expiresAt: EXPIRES, proof: proof("work.aggregation.correct" as keyof typeof SESSION_AUTHORITY_OPERATION_DEFINITIONS) });
    const midCorrected = storage.correctResult({ workItemId: mid.id, expectedRevision: storage.get(mid.id)!.revision, expectedResultRevision: 1, result: result(mid, "mid corrected"), correctionReason: "leaf recheck incorporated", principalSessionId: "root", idempotencyKey: "nested-mid-correction", requestFingerprint: "nested-mid-correction-fp", updatedAt: LATER, expiresAt: EXPIRES, proof: proof("work.result.correct" as keyof typeof SESSION_AUTHORITY_OPERATION_DEFINITIONS) });
    const midFinal = storage.mutate({ operation: "work.result", workItemId: mid.id, principalSessionId: "root", idempotencyKey: "nested-mid-refinalize", requestFingerprint: "nested-mid-refinalize-fp", expectedRevision: midCorrected.workItem.revision, expectedResultRevision: 2, expectedAggregateRevision: storage.getAggregationSummary(mid.id).aggregateRevision, state: "completed", result: midCorrected.workItem.result!, updatedAt: LATER, expiresAt: EXPIRES, proof: proof("work.result") });
    assert.equal(midFinal.result?.summary, midCorrected.workItem.result?.summary);
    storage.correctAggregation({ parentWorkItemId: top.id, childWorkItemId: mid.id, expectedAggregateRevision: storage.getAggregationSummary(top.id).aggregateRevision, expectedChildResultRevision: 2, correction: { kind: "revise", decision: "accepted", reason: "mid re-adopted" }, actorSessionId: "task", idempotencyKey: "nested-top-recheck", requestFingerprint: "nested-top-recheck-fp", decidedAt: LATER, expiresAt: EXPIRES, proof: proof("work.aggregation.correct" as keyof typeof SESSION_AUTHORITY_OPERATION_DEFINITIONS) });
    const topCorrected = storage.correctResult({ workItemId: top.id, expectedRevision: storage.get(top.id)!.revision, expectedResultRevision: 1, result: result(top, "top corrected"), correctionReason: "mid re-finalized", principalSessionId: "root", idempotencyKey: "nested-top-correction", requestFingerprint: "nested-top-correction-fp", updatedAt: LATER, expiresAt: EXPIRES, proof: proof("work.result.correct" as keyof typeof SESSION_AUTHORITY_OPERATION_DEFINITIONS) });
    const topFinal = storage.mutate({ operation: "work.result", workItemId: top.id, principalSessionId: "root", idempotencyKey: "nested-top-refinalize", requestFingerprint: "nested-top-refinalize-fp", expectedRevision: topCorrected.workItem.revision, expectedResultRevision: 2, expectedAggregateRevision: storage.getAggregationSummary(top.id).aggregateRevision, state: "completed", result: topCorrected.workItem.result!, updatedAt: LATER, expiresAt: EXPIRES, proof: proof("work.result") });
    assert.equal(topFinal.result?.summary, topCorrected.workItem.result?.summary);
    assert.equal(storage.getAggregationSummary(mid.id).stale, false);
    assert.equal(storage.getAggregationSummary(top.id).stale, false);
    assert.equal(storage.getAggregationSummary(mid.id).finalizedRevision, storage.getAggregationSummary(mid.id).aggregateRevision);
    assert.equal(storage.getAggregationSummary(top.id).finalizedRevision, storage.getAggregationSummary(top.id).aggregateRevision);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "root resultはdescendant correction後にstaleとして新規採用を拒否し、child/parentの再確定後にroot result correctionと再finalizeで復旧する"
  // fault = "rootがstale descendant resultをcurrent finalとして採用する、またはroot correction後の再finalizeが履歴とprojectionを分岐させる"
  // observable = "root Work Item result revisions, nested aggregate stale/finalized projections, work.result rejection and replay"
  // observation_boundary = "component-behavior"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/03-result-and-aggregation-correction.md" }
  // scope = "root stale propagation and re-finalization"
  // lifecycle = "permanent"
  // distinction = "root bindingを含む実SQLite fixtureでdescendant訂正からroot再確定までを観測する"
  // @end-test-value
  it("root resultはdescendant訂正後に再確定できる", () => {
    const root = createRoot("root-nested-correction");
    const parent = create(null, "root", "task", "root-parent");
    const child = settle(create(parent.id, "task", "executor", "root-child"));
    const parentSummary = storage.getAggregationSummary(parent.id);
    storage.decideAggregation({ parentWorkItemId: parent.id, childWorkItemId: child.id, actorSessionId: "task", decision: "accepted", reason: null, expectedAggregateRevision: parentSummary.aggregateRevision, idempotencyKey: "root-parent-decision", requestFingerprint: "root-parent-decision-fp", decidedAt: LATER, expiresAt: EXPIRES, proof: proof("work.aggregation.decide") });
    const parentRunning = storage.mutate({ operation: "work.transition", workItemId: parent.id, principalSessionId: "root", idempotencyKey: "root-parent-start", requestFingerprint: "root-parent-start-fp", expectedRevision: parent.revision, state: "in_progress", result: null, updatedAt: NOW, expiresAt: EXPIRES, proof: proof("work.transition") });
    storage.mutate({ operation: "work.result", workItemId: parent.id, principalSessionId: "root", idempotencyKey: "root-parent-result", requestFingerprint: "root-parent-result-fp", expectedRevision: parentRunning.revision, expectedAggregateRevision: storage.getAggregationSummary(parent.id).aggregateRevision, state: "completed", result: result(parent, "parent final"), updatedAt: LATER, expiresAt: EXPIRES, proof: proof("work.result") });
    const rootRunning = storage.mutate({ operation: "work.transition", workItemId: root.id, principalSessionId: "root", idempotencyKey: "root-start", requestFingerprint: "root-start-fp", expectedRevision: root.revision, state: "in_progress", result: null, updatedAt: NOW, expiresAt: EXPIRES, proof: proof("work.transition") });
    storage.mutate({ operation: "work.result", workItemId: root.id, principalSessionId: "root", idempotencyKey: "root-result", requestFingerprint: "root-result-fp", expectedRevision: rootRunning.revision, state: "completed", result: result(root, "root final"), updatedAt: LATER, expiresAt: EXPIRES, proof: proof("work.result") });
    const corrected = storage.correctResult({ workItemId: child.id, expectedRevision: child.revision, expectedResultRevision: 1, result: result(child, "root child corrected"), correctionReason: "root review", principalSessionId: "root", idempotencyKey: "root-child-correction", requestFingerprint: "root-child-correction-fp", updatedAt: LATER, expiresAt: EXPIRES, proof: proof("work.result.correct" as keyof typeof SESSION_AUTHORITY_OPERATION_DEFINITIONS) });
    assert.equal(storage.getAggregationSummary(parent.id).stale, true);
    assert.equal(storage.get(root.id)?.stale, true);
    assert.equal(storage.get(root.id)?.resultCurrent, false);
    assert.throws(() => storage.mutate({ operation: "work.result", workItemId: root.id, principalSessionId: "root", idempotencyKey: "root-stale-adoption", requestFingerprint: "root-stale-adoption-fp", expectedRevision: storage.get(root.id)!.revision, expectedResultRevision: 1, state: "completed", result: storage.get(root.id)!.result!, updatedAt: LATER, expiresAt: EXPIRES, proof: proof("work.result") }), { code: "WORK_ITEM_AGGREGATION_STALE" });
    storage.correctAggregation({ parentWorkItemId: parent.id, childWorkItemId: child.id, expectedAggregateRevision: storage.getAggregationSummary(parent.id).aggregateRevision, expectedChildResultRevision: corrected.resultRevision, correction: { kind: "revise", decision: "accepted", reason: "child rechecked" }, actorSessionId: "task", idempotencyKey: "root-parent-recheck", requestFingerprint: "root-parent-recheck-fp", decidedAt: LATER, expiresAt: EXPIRES, proof: proof("work.aggregation.correct" as keyof typeof SESSION_AUTHORITY_OPERATION_DEFINITIONS) });
    const parentCorrected = storage.correctResult({ workItemId: parent.id, expectedRevision: storage.get(parent.id)!.revision, expectedResultRevision: 1, result: result(parent, "parent corrected"), correctionReason: "child rechecked", principalSessionId: "root", idempotencyKey: "root-parent-correction", requestFingerprint: "root-parent-correction-fp", updatedAt: LATER, expiresAt: EXPIRES, proof: proof("work.result.correct" as keyof typeof SESSION_AUTHORITY_OPERATION_DEFINITIONS) });
    storage.mutate({ operation: "work.result", workItemId: parent.id, principalSessionId: "root", idempotencyKey: "root-parent-refinalize", requestFingerprint: "root-parent-refinalize-fp", expectedRevision: parentCorrected.workItem.revision, expectedResultRevision: 2, expectedAggregateRevision: storage.getAggregationSummary(parent.id).aggregateRevision, state: "completed", result: parentCorrected.workItem.result!, updatedAt: LATER, expiresAt: EXPIRES, proof: proof("work.result") });
    assert.equal(storage.get(root.id)?.stale, true);
    assert.equal(storage.get(root.id)?.resultCurrent, false);
    const rootCorrected = storage.correctResult({ workItemId: root.id, expectedRevision: storage.get(root.id)!.revision, expectedResultRevision: 1, result: result(root, "root corrected"), correctionReason: "descendant rechecked", principalSessionId: "root", idempotencyKey: "root-correction", requestFingerprint: "root-correction-fp", updatedAt: LATER, expiresAt: EXPIRES, proof: proof("work.result.correct" as keyof typeof SESSION_AUTHORITY_OPERATION_DEFINITIONS) });
    assert.equal(rootCorrected.workItem.resultCurrent, false);
    const rootFinal = storage.mutate({ operation: "work.result", workItemId: root.id, principalSessionId: "root", idempotencyKey: "root-refinalize", requestFingerprint: "root-refinalize-fp", expectedRevision: rootCorrected.workItem.revision, expectedResultRevision: 2, state: "completed", result: rootCorrected.workItem.result!, updatedAt: LATER, expiresAt: EXPIRES, proof: proof("work.result") });
    assert.equal(rootFinal.result?.summary, rootCorrected.workItem.result?.summary);
    assert.equal(rootFinal.resultCurrent, true);
    assert.equal(rootFinal.stale, false);
    storage.close(); storage = new WorkItemStorageV6(dbPath);
    assert.deepEqual(storage.get(root.id), rootFinal);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "replace訂正は既存replacementと新replacementの所属を検証し、旧retry decisionとreplacement provenanceを保持する"
  // fault = "replaceが別root/self/cycle replacementを受け入れる、または旧retry履歴をcurrent projection更新時に消去する"
  // observable = "aggregation decision/event chain, old/new replacement parent and root, replacement ids"
  // observation_boundary = "component-behavior"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/03-result-and-aggregation-correction.md" }
  // scope = "replace correction and replacement provenance"
  // lifecycle = "permanent"
  // distinction = "retryで生成した旧replacementと新replacementを同じparentで比較する"
  // @end-test-value
  it("replace訂正は旧retry履歴を保持し新replacementへ切り替える", () => {
    const parent = create(null, "root", "task", "replace-parent");
    const child = settle(create(parent.id, "task", "executor", "replace-child"));
    const retried = storage.retryAggregation({ parentWorkItemId: parent.id, childWorkItemId: child.id, actorSessionId: "task", expectedAggregateRevision: storage.getAggregationSummary(parent.id).aggregateRevision, idempotencyKey: "replace-retry", requestFingerprint: "replace-retry-fp", replacementId: "replace-old", replacementBinding: binding(parent.id, "task", "executor", "old replacement"), decidedAt: LATER, expiresAt: EXPIRES, reason: "retry", proof: proof("work.aggregation.retry") });
    settle(retried.replacement, "replace-old-result");
    const replacement = settle(create(parent.id, "task", "executor", "replace-new-child"), "replace-new-result");
    const revised = storage.correctAggregation({ parentWorkItemId: parent.id, childWorkItemId: child.id, expectedAggregateRevision: storage.getAggregationSummary(parent.id).aggregateRevision, expectedChildResultRevision: 1, correction: { kind: "replace", decision: "accepted", reason: "use newer replacement", replacementWorkItemId: replacement.id }, actorSessionId: "task", idempotencyKey: "replace-new", requestFingerprint: "replace-new-fp", decidedAt: LATER, expiresAt: EXPIRES, proof: proof("work.aggregation.correct" as keyof typeof SESSION_AUTHORITY_OPERATION_DEFINITIONS) });
    assert.equal(revised?.decision?.replacementWorkItemId, replacement.id);
    assert.equal(revised?.decision?.parentWorkItemId, parent.id);
    assert.equal(sql("SELECT COUNT(*) AS n FROM work_item_aggregation_events_v6 WHERE parent_work_item_id=? AND event_kind='retry_requested'", parent.id)[0].n, 1);
    assert.equal(JSON.parse(sql<{ payload_json: string }>("SELECT payload_json FROM work_item_aggregation_events_v6 WHERE parent_work_item_id=? AND event_kind='retry_requested' ORDER BY event_id DESC LIMIT 1", parent.id)[0].payload_json).replacementWorkItemId, retried.replacement.id);
    assert.equal(storage.get(retried.replacement.id)?.parentWorkItemId, parent.id);
    assert.equal(storage.get(replacement.id)?.parentWorkItemId, parent.id);
    assert.throws(() => storage.correctAggregation({ parentWorkItemId: parent.id, childWorkItemId: child.id, expectedAggregateRevision: storage.getAggregationSummary(parent.id).aggregateRevision, expectedChildResultRevision: 1, correction: { kind: "replace", decision: "accepted", reason: "self replacement is invalid", replacementWorkItemId: parent.id }, actorSessionId: "task", idempotencyKey: "replace-self", requestFingerprint: "replace-self-fp", decidedAt: LATER, expiresAt: EXPIRES, proof: proof("work.aggregation.correct" as keyof typeof SESSION_AUTHORITY_OPERATION_DEFINITIONS) }), { code: "WORK_ITEM_REPLACEMENT_INVALID" });
    const otherParent = create(null, "root", "task-2", "replace-other-parent");
    const otherReplacement = create(otherParent.id, "task-2", "executor", "replace-cross-parent");
    assert.throws(() => storage.correctAggregation({ parentWorkItemId: parent.id, childWorkItemId: child.id, expectedAggregateRevision: storage.getAggregationSummary(parent.id).aggregateRevision, expectedChildResultRevision: 1, correction: { kind: "replace", decision: "accepted", reason: "cross parent replacement is invalid", replacementWorkItemId: otherReplacement.id }, actorSessionId: "task", idempotencyKey: "replace-cross-parent", requestFingerprint: "replace-cross-parent-fp", decidedAt: LATER, expiresAt: EXPIRES, proof: proof("work.aggregation.correct" as keyof typeof SESSION_AUTHORITY_OPERATION_DEFINITIONS) }), { code: "WORK_ITEM_REPLACEMENT_INVALID" });
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "withdraw後のreopen successorは旧decisionをcurrent採用せず、同一idempotency replayを保ったまま新decisionへ修復できる"
  // fault = "withdraw後に旧acceptedを再利用する、reopen successorへ旧decisionを誤継承する、または同じwithdraw再送で履歴を重複する"
  // observable = "withdraw response replay, old/new child ids, decision rows, undecided/accepted counts"
  // observation_boundary = "component-behavior"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/03-result-and-aggregation-correction.md" }
  // scope = "withdraw/reopen/canonical replay"
  // lifecycle = "permanent"
  // distinction = "旧childを保持したまま同一parentのsuccessorを再decisionする"
  // @end-test-value
  it("withdraw後reopenはcanonical replayと新decisionを両立する", () => {
    const parent = create(null, "root", "task", "withdraw-parent");
    const child = settle(create(parent.id, "task", "executor", "withdraw-child"));
    storage.decideAggregation({ parentWorkItemId: parent.id, childWorkItemId: child.id, actorSessionId: "task", decision: "accepted", reason: null, expectedAggregateRevision: storage.getAggregationSummary(parent.id).aggregateRevision, idempotencyKey: "withdraw-accept", requestFingerprint: "withdraw-accept-fp", decidedAt: LATER, expiresAt: EXPIRES, proof: proof("work.aggregation.decide") });
    const input = { parentWorkItemId: parent.id, childWorkItemId: child.id, expectedAggregateRevision: storage.getAggregationSummary(parent.id).aggregateRevision, expectedChildResultRevision: 1, correction: { kind: "withdraw" as const, reason: "new review" }, actorSessionId: "task", idempotencyKey: "withdraw-replay", requestFingerprint: "withdraw-replay-fp", decidedAt: LATER, expiresAt: EXPIRES, proof: proof("work.aggregation.correct" as keyof typeof SESSION_AUTHORITY_OPERATION_DEFINITIONS) };
    const withdrawn = storage.correctAggregation(input);
    storage.close(); storage = new WorkItemStorageV6(dbPath);
    assert.deepEqual(storage.correctAggregation(input), withdrawn);
    assert.equal(storage.getAggregationSummary(parent.id).undecidedTerminalCount, 1);
    const successor = storage.reopen({ workItemId: child.id, expectedRevision: child.revision, principalSessionId: "root", idempotencyKey: "withdraw-reopen", requestFingerprint: "withdraw-reopen-fp", updatedAt: LATER, expiresAt: EXPIRES, proof: proof("work.reopen"), targetSessionId: "executor", parentWorkItemId: parent.id, goal: "reopened", scope: child.scope, completionCriteria: child.completionCriteria, authority: child.authority, sourceIdentity: child.sourceIdentity, expectedContainerRevision: Number(sql<{ resource_revision: number }>("SELECT resource_revision FROM sessions_v6 WHERE id='executor'")[0].resource_revision) });
    assert.equal(sql("SELECT COUNT(*) AS n FROM work_item_aggregation_decisions_v6 WHERE child_work_item_id=?", successor.id)[0].n, 0);
    const settledSuccessor = settle(successor, "withdraw-successor-result");
    storage.decideAggregation({ parentWorkItemId: parent.id, childWorkItemId: settledSuccessor.id, actorSessionId: "task", decision: "accepted", reason: null, expectedAggregateRevision: storage.getAggregationSummary(parent.id).aggregateRevision, idempotencyKey: "withdraw-successor-accept", requestFingerprint: "withdraw-successor-accept-fp", decidedAt: LATER, expiresAt: EXPIRES, proof: proof("work.aggregation.decide") });
    assert.equal(storage.getAggregationSummary(parent.id).acceptedCount, 1);
    assert.equal(storage.getAggregationSummary(parent.id).undecidedTerminalCount, 1);
  });
});

