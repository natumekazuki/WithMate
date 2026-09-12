import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { createOrVerifyV6FreshDatabase } from "../../src-electron/app-database-v6-bootstrap.js";
import { ensureV6Schema } from "../../src-electron/database-schema-v6.js";
import { backfillBaselineSessionAuthority } from "../../src-electron/session-authority-storage.js";
import { SessionExecutionStorageV6, SessionExecutionWorkItemAssociationError } from "../../src-electron/session-execution-storage-v6.js";
import { WorkItemStorageV6 } from "../../src-electron/work-item-storage-v6.js";
import { SESSION_AUTHORITY_MAPPING_REVISION, SESSION_AUTHORITY_OPERATION_DEFINITIONS, type MutationAuthorityProof } from "../../src/session-authority.js";
import type { DelegatedWorkItemBinding } from "../../src/work-item.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NOW = "2026-08-24T12:00:00.000Z";
const EXPIRES = "2026-08-25T12:00:00.000Z";
const SOURCE = { workspace: process.cwd(), repository: null, branch: "main", base: null, head: null };

function proof(operation: keyof typeof SESSION_AUTHORITY_OPERATION_DEFINITIONS, ownerId = "root"): MutationAuthorityProof {
  const definition = SESSION_AUTHORITY_OPERATION_DEFINITIONS[operation];
  return { principal: { kind: "system", service: "work-item-lifecycle-migration-test" }, providerId: null, operation,
    mappingRevision: SESSION_AUTHORITY_MAPPING_REVISION, action: definition.action, resolvedScope: { resourceKind: definition.resourceKind,
      resourceId: ownerId, rootSessionId: "root", ownerKind: "session", ownerId, relation: "self" }, effectClass: definition.effectClass,
    grantId: null, grantRevision: null, evaluatedAt: NOW };
}

function binding(parentWorkItemId: string | null, creatorSessionId: string, targetSessionId: string, goal: string): DelegatedWorkItemBinding {
  return { kind: "delegated", rootSessionId: "root", creatorSessionId, targetSessionId, parentWorkItemId, goal,
    scope: "scope", completionCriteria: "complete", authority: "local", sourceIdentity: SOURCE };
}

function containerRevision(dbPath: string, sessionId: string): number {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { return Number((db.prepare("SELECT resource_revision FROM sessions_v6 WHERE id=?").get(sessionId) as { resource_revision: number }).resource_revision); }
  finally { db.close(); }
}

function rebuild(db: DatabaseSync, table: string, sql: string, columns: string[]): void {
  db.exec(`DROP TRIGGER IF EXISTS trg_v6_work_items_protect_session_delete; DROP TRIGGER IF EXISTS trg_v6_work_items_cleanup_terminal_root_session_delete; DROP TRIGGER IF EXISTS work_item_aggregation_events_no_update_v6; DROP TRIGGER IF EXISTS work_item_aggregation_events_no_delete_v6; DROP INDEX IF EXISTS idx_v6_work_item_events_item_sequence; DROP INDEX IF EXISTS idx_v6_work_item_idempotency_item; DROP INDEX IF EXISTS idx_v6_work_item_idempotency_expiry; DROP INDEX IF EXISTS idx_v6_work_item_execution_item; ALTER TABLE ${table} RENAME TO ${table}_legacy;`);
  db.exec(sql);
  db.exec(`INSERT INTO ${table} (${columns.join(",")}) SELECT ${columns.join(",")} FROM ${table}_legacy; DROP TABLE ${table}_legacy;`);
}

async function fixture(useTemporaryWorkspace = false): Promise<{ dbPath: string; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), "withmate-lifecycle-migration-real-"));
  const { dbPath } = await createOrVerifyV6FreshDatabase(directory);
  const db = new DatabaseSync(dbPath);
  try {
    const session = db.prepare("INSERT INTO sessions_v6 (id,title,state,provider_id,catalog_revision,model_id,approval_mode,workspace_path,created_at,updated_at,last_active_at) VALUES (?,?,'active','codex',1,'gpt-5','on-request',?,?,?,?)");
    for (const id of ["root", "task", "task-2", "executor"]) session.run(id, id, useTemporaryWorkspace ? directory : process.cwd(), NOW, NOW, NOW);
    const role = db.prepare("INSERT INTO session_role_bindings_v6 (session_id,session_role,role_contract_revision,root_session_id,parent_session_id,delegation_depth) VALUES (?, ?, 1, 'root', ?, ?)");
    role.run("root", "overall-coordinator", null, 0); role.run("task", "task-coordinator", "root", 1); role.run("task-2", "task-coordinator", "root", 1); role.run("executor", "executor", "task", 2);
    backfillBaselineSessionAuthority(db, NOW);
    ensureV6Schema(db);
  } finally { db.close(); }
  return { dbPath, directory };
}

describe("work-item lifecycle populated migration", () => {
  // @test-value v2
  // kind = "compatibility"
  // claim = "production storageで生成した旧Slice 3のWork Item projection、全履歴header、decision/replacement、execution association、grant、Work Item作成のbudget消費と履歴はSlice 4 schema migration後も同一内容で再生できる"
  // fault = "migrationが実データを失う、旧associationのactual sourceを捏造する、または履歴とprojectionを分岐させる"
  // observable = "work_items_v6, work_item_events_v6, resource_event_headers_v6, work_item_aggregation_events_v6, work_item_aggregation_decisions_v6, work_item_aggregation_idempotency_v6, work_item_execution_associations_v6, session_authority_grants_v6, resource_budget_accounts_v6, resource_budget_dimensions_v6, resource_budget_events_v6"
  // observation_boundary = "component-behavior"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/02-work-item-lifecycle.md" }
  // scope = "populated legacy Work Item schema migration"
  // lifecycle = "permanent"
  // distinction = "WorkItemStorageV6とSessionExecutionStorageV6で有効な履歴を生成し、追加列と旧CHECKだけをdowngradeしてからensureV6Schemaを実行する"
  // @end-test-value
  it("production経路で生成したpopulated legacy DBを保持してmigrationする", async () => {
    const f = await fixture();
    const storage = new WorkItemStorageV6(f.dbPath);
    const executions = new SessionExecutionStorageV6(f.dbPath);
    try {
      const create = (id: string, b: DelegatedWorkItemBinding, key: string) => storage.create({ id, binding: b, principalSessionId: "root", idempotencyKey: key, requestFingerprint: `${key}-fp`, expectedContainerRevision: containerRevision(f.dbPath, b.targetSessionId), createdAt: NOW, expiresAt: EXPIRES, proof: proof("work.create") });
      const parent = create("parent", binding(null, "root", "task", "parent"), "create-parent");
      const destination = create("destination", binding(null, "root", "task-2", "destination"), "create-destination");
      const child = create("child", binding(parent.id, "task", "executor", "child"), "create-child");
      const moveChild = create("move-child", binding(parent.id, "task", "executor", "move-child"), "create-move-child");
      const running = storage.mutate({ operation: "work.transition", workItemId: child.id, principalSessionId: "root", idempotencyKey: "child-start", requestFingerprint: "child-start-fp", expectedRevision: child.revision, state: "in_progress", result: null, updatedAt: NOW, expiresAt: EXPIRES, proof: proof("work.transition") });
      const done = storage.mutate({ operation: "work.result", workItemId: child.id, principalSessionId: "root", idempotencyKey: "child-result", requestFingerprint: "child-result-fp", expectedRevision: running.revision, state: "completed", result: { outcome: "completed", summary: "done", changes: [], verificationResults: [], findings: [], unverifiedItems: [], remainingWork: [], reportingSessionId: "executor", reportedAt: NOW }, updatedAt: NOW, expiresAt: EXPIRES, proof: proof("work.result") });
      const summary = storage.getAggregationSummary(parent.id);
      storage.retryAggregation({ parentWorkItemId: parent.id, childWorkItemId: done.id, actorSessionId: "task", expectedAggregateRevision: summary.aggregateRevision, idempotencyKey: "retry", requestFingerprint: "retry-fp", replacementId: "replacement", replacementBinding: binding(parent.id, "task", "executor", "replacement"), decidedAt: NOW, expiresAt: EXPIRES, reason: "retry", proof: proof("work.aggregation.retry") });
      executions.startImmediate({ id: "execution", expectedContainerRevision: containerRevision(f.dbPath, "executor"), sessionId: "executor", request: { userMessage: "run" }, idempotencyKey: "execution", requestFingerprint: "execution-fp", createdAt: NOW, expiresAt: EXPIRES, proof: proof("turn.run", "executor"), workItemId: "replacement" });
      const db = new DatabaseSync(f.dbPath);
      try {
        db.exec("DROP TRIGGER IF EXISTS session_execution_events_no_update_v6; UPDATE session_execution_events_v6 SET payload_json = json_remove(payload_json, '$.projection.workItemRevision', '$.projection.plannedSourceIdentity', '$.projection.actualStartSourceIdentity') WHERE execution_id='execution'");
        const workSql = (db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='work_items_v6'").get() as { sql: string }).sql.replace("    archived_at TEXT,\n", "");
        const eventSql = (db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='work_item_events_v6'").get() as { sql: string }).sql.replace(", 'assignment_changed',\n      'parent_changed', 'archived', 'restored', 'deleted'", "").replace("    FOREIGN KEY (actor_session_id)", "    FOREIGN KEY (work_item_id) REFERENCES work_items_v6(id) ON DELETE CASCADE,\n    FOREIGN KEY (actor_session_id)");
        const idemSql = (db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='work_item_idempotency_v6'").get() as { sql: string }).sql.replace(",\n      'work.reassign', 'work.move', 'work.clone', 'work.reopen',\n      'work.archive', 'work.delete'", "").replace("    response_json TEXT CHECK (response_json IS NULL OR (json_valid(response_json) AND length(CAST(response_json AS BLOB)) <= 2097152)),\n", "").replace("    PRIMARY KEY (operation, principal_session_id, idempotency_key)\n  )", "    PRIMARY KEY (operation, principal_session_id, idempotency_key),\n    FOREIGN KEY (work_item_id) REFERENCES work_items_v6(id) ON DELETE CASCADE\n  )");
        const assocSql = (db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='work_item_execution_associations_v6'").get() as { sql: string }).sql.replace("    work_item_revision INTEGER CHECK (work_item_revision IS NULL OR work_item_revision >= 1),\n", "").replace("    planned_source_json TEXT CHECK (planned_source_json IS NULL OR json_valid(planned_source_json)),\n", "").replace("    actual_source_json TEXT CHECK (actual_source_json IS NULL OR json_valid(actual_source_json)),\n", "");
        const aggregationSql = (name: string) => (db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(name) as { sql: string }).sql;
        const aggregationsSql = aggregationSql("work_item_aggregations_v6");
        const decisionsSql = aggregationSql("work_item_aggregation_decisions_v6");
        const aggregationIdemSql = aggregationSql("work_item_aggregation_idempotency_v6").replace("    response_json TEXT CHECK (response_json IS NULL OR json_valid(response_json)),\n", "");
        const aggregationEventsSql = aggregationSql("work_item_aggregation_events_v6").replace(", 'child_removed', 'child_adopted', 'decision_superseded'", "");
        assert.notEqual(workSql, ""); assert.notEqual(eventSql, ""); assert.notEqual(idemSql, ""); assert.notEqual(assocSql, "");
        assert.match(eventSql, /FOREIGN KEY \(work_item_id\) REFERENCES work_items_v6\(id\) ON DELETE CASCADE/);
        assert.match(idemSql, /FOREIGN KEY \(work_item_id\) REFERENCES work_items_v6\(id\) ON DELETE CASCADE/);
        const retainedReplay = db.prepare("SELECT * FROM work_item_idempotency_v6 ORDER BY operation,principal_session_id,idempotency_key").all();
        const retainedDecisions = db.prepare("SELECT * FROM work_item_aggregation_decisions_v6 ORDER BY sequence").all();
        const retainedAggregationEvents = db.prepare("SELECT * FROM work_item_aggregation_events_v6 ORDER BY event_id").all();
        db.exec("PRAGMA foreign_keys=OFF;");
        rebuild(db, "work_items_v6", workSql, ["sequence","id","kind","contract_revision","root_session_id","creator_session_id","target_session_id","parent_work_item_id","predecessor_work_item_id","goal","scope","completion_criteria","authority","source_identity_json","state","revision","progress_summary","blockers_json","next_action","result_json","created_at","updated_at"]);
        rebuild(db, "work_item_events_v6", eventSql, ["sequence","work_item_id","revision","event_type","actor_session_id","principal_kind","payload_json","created_at"]);
        rebuild(db, "work_item_idempotency_v6", idemSql, ["operation","principal_session_id","idempotency_key","request_fingerprint","work_item_id","response_json","created_at","expires_at"]);
        rebuild(db, "work_item_execution_associations_v6", assocSql, ["execution_id","work_item_id","created_at"]);
        rebuild(db, "work_item_aggregations_v6", aggregationsSql, ["parent_work_item_id","aggregate_revision","updated_at"]);
        rebuild(db, "work_item_aggregation_decisions_v6", decisionsSql, ["sequence","parent_work_item_id","child_work_item_id","decision_revision","child_revision","actor_session_id","decision_type","reason","replacement_work_item_id","decided_at"]);
        rebuild(db, "work_item_aggregation_idempotency_v6", aggregationIdemSql, ["operation","principal_session_id","idempotency_key","request_fingerprint","child_work_item_id","replacement_work_item_id","created_at","expires_at"]);
        rebuild(db, "work_item_aggregation_events_v6", aggregationEventsSql, ["event_id","parent_work_item_id","child_work_item_id","aggregate_revision","event_kind","payload_json"]);
        db.exec("PRAGMA foreign_keys=ON;");
        const before = JSON.stringify(db.prepare("SELECT sequence,id,kind,contract_revision,root_session_id,creator_session_id,target_session_id,parent_work_item_id,predecessor_work_item_id,goal,scope,completion_criteria,authority,source_identity_json,state,revision,progress_summary,blockers_json,next_action,result_json,created_at,updated_at FROM work_items_v6 ORDER BY id").all());
        const events = JSON.stringify(db.prepare("SELECT * FROM work_item_events_v6 ORDER BY sequence").all());
        const headers = JSON.stringify(db.prepare("SELECT event_id,resource_kind,resource_id,root_id,owner_kind,owner_id,event_kind,resource_revision,principal_kind,actor_session_id,grant_id,grant_revision,operation_id,idempotency_key_fingerprint,occurred_at,committed_at,supersedes_event_id,payload_schema_revision,effect FROM resource_event_headers_v6 ORDER BY event_id").all());
        const grants = JSON.stringify(db.prepare("SELECT * FROM session_authority_grants_v6 ORDER BY grant_id").all());
        const budgetAccounts = JSON.stringify(db.prepare("SELECT * FROM resource_budget_accounts_v6 ORDER BY account_id").all());
        const budgetDimensions = JSON.stringify(db.prepare("SELECT * FROM resource_budget_dimensions_v6 ORDER BY account_id,dimension").all());
        const budgetEvents = JSON.stringify(db.prepare("SELECT * FROM resource_budget_events_v6 ORDER BY account_id,sequence").all());
        const associations = db.prepare("SELECT execution_id,work_item_id,created_at FROM work_item_execution_associations_v6 ORDER BY execution_id").all();
        const aggregations = db.prepare("SELECT * FROM work_item_aggregations_v6 ORDER BY parent_work_item_id").all();
        const aggregationReplay = db.prepare("SELECT operation,principal_session_id,idempotency_key,request_fingerprint,child_work_item_id,replacement_work_item_id,created_at,expires_at FROM work_item_aggregation_idempotency_v6 ORDER BY operation,principal_session_id,idempotency_key").all();
        assert.ok(JSON.parse(budgetEvents).length > 0);
        ensureV6Schema(db);
        assert.deepEqual(db.prepare("SELECT execution_id,work_item_id,created_at FROM work_item_execution_associations_v6 ORDER BY execution_id").all(), associations);
        assert.deepEqual(db.prepare("SELECT * FROM work_item_aggregations_v6 ORDER BY parent_work_item_id").all(), aggregations);
        assert.deepEqual(db.prepare("SELECT operation,principal_session_id,idempotency_key,request_fingerprint,child_work_item_id,replacement_work_item_id,created_at,expires_at FROM work_item_aggregation_idempotency_v6 ORDER BY operation,principal_session_id,idempotency_key").all(), aggregationReplay);
        assert.equal(JSON.stringify(db.prepare("SELECT sequence,id,kind,contract_revision,root_session_id,creator_session_id,target_session_id,parent_work_item_id,predecessor_work_item_id,goal,scope,completion_criteria,authority,source_identity_json,state,revision,progress_summary,blockers_json,next_action,result_json,created_at,updated_at FROM work_items_v6 ORDER BY id").all()), before);
        assert.equal(JSON.stringify(db.prepare("SELECT * FROM work_item_events_v6 ORDER BY sequence").all()), events);
        assert.equal(JSON.stringify(db.prepare("SELECT event_id,resource_kind,resource_id,root_id,owner_kind,owner_id,event_kind,resource_revision,principal_kind,actor_session_id,grant_id,grant_revision,operation_id,idempotency_key_fingerprint,occurred_at,committed_at,supersedes_event_id,payload_schema_revision,effect FROM resource_event_headers_v6 ORDER BY event_id").all()), headers);
        assert.equal(JSON.stringify(db.prepare("SELECT * FROM session_authority_grants_v6 ORDER BY grant_id").all()), grants);
        assert.equal(JSON.stringify(db.prepare("SELECT * FROM resource_budget_accounts_v6 ORDER BY account_id").all()), budgetAccounts);
        assert.equal(JSON.stringify(db.prepare("SELECT * FROM resource_budget_dimensions_v6 ORDER BY account_id,dimension").all()), budgetDimensions);
        assert.equal(JSON.stringify(db.prepare("SELECT * FROM resource_budget_events_v6 ORDER BY account_id,sequence").all()), budgetEvents);
        assert.equal(db.prepare("SELECT actual_source_json FROM work_item_execution_associations_v6 WHERE execution_id='execution'").get()?.actual_source_json, null);
        assert.deepEqual(db.prepare("SELECT * FROM work_item_idempotency_v6 ORDER BY operation,principal_session_id,idempotency_key").all(), retainedReplay);
        assert.deepEqual(db.prepare("SELECT * FROM work_item_aggregation_decisions_v6 ORDER BY sequence").all(), retainedDecisions);
        assert.deepEqual(db.prepare("SELECT * FROM work_item_aggregation_events_v6 ORDER BY event_id").all(), retainedAggregationEvents);
        const moveStarted = storage.mutate({ operation: "work.transition", workItemId: moveChild.id, principalSessionId: "root", idempotencyKey: "move-child-start", requestFingerprint: "move-child-start-fp", expectedRevision: moveChild.revision, state: "in_progress", result: null, updatedAt: NOW, expiresAt: EXPIRES, proof: proof("work.transition") });
        const moveDone = storage.mutate({ operation: "work.result", workItemId: moveChild.id, principalSessionId: "root", idempotencyKey: "move-child-result", requestFingerprint: "move-child-result-fp", expectedRevision: moveStarted.revision, state: "completed", result: { outcome: "completed", summary: "move", changes: [], verificationResults: [], findings: [], unverifiedItems: [], remainingWork: [], reportingSessionId: "executor", reportedAt: NOW }, updatedAt: NOW, expiresAt: EXPIRES, proof: proof("work.result") });
        const moved = storage.move({ workItemId: moveChild.id, expectedRevision: moveDone.revision, principalSessionId: "root", idempotencyKey: "move", requestFingerprint: "move-fp", updatedAt: NOW, expiresAt: EXPIRES, proof: proof("work.move"), destinationParentWorkItemId: destination.id, expectedAggregateRevision: storage.getAggregationSummary(parent.id).aggregateRevision, expectedDestinationAggregateRevision: storage.getAggregationSummary(destination.id).aggregateRevision });
        assert.equal(moved.parentWorkItemId, destination.id);
        const reopened = storage.reopen({ workItemId: moved.id, expectedRevision: moved.revision, principalSessionId: "root", idempotencyKey: "reopen-after-migration", requestFingerprint: "reopen-after-migration-fp", updatedAt: NOW, expiresAt: EXPIRES, proof: proof("work.reopen"), goal: "reopened", scope: "scope", completionCriteria: "complete", authority: "local", sourceIdentity: SOURCE, destinationParentWorkItemId: destination.id, expectedContainerRevision: containerRevision(f.dbPath, "executor") });
        assert.equal(reopened.predecessorWorkItemId, moved.id);
        assert.equal(storage.get(moved.id)?.result?.summary, "move");
        ensureV6Schema(db);
      } finally { db.close(); }
    } finally { executions.close(); storage.close(); await rm(f.directory, { recursive: true, force: true }); }
  });
});


function downgradeQueuedAssociation(db: DatabaseSync): void {
  // Reproduce the Slice 3 schema and the payload emitted before source snapshots existed.
  db.exec("DROP TRIGGER IF EXISTS session_execution_events_no_update_v6; UPDATE session_execution_events_v6 SET payload_json=json_remove(payload_json, '$.workItemRevision', '$.plannedSourceIdentity', '$.actualStartSourceIdentity', '$.projection.workItemRevision', '$.projection.plannedSourceIdentity', '$.projection.actualStartSourceIdentity')");
  const ddl = (db.prepare("SELECT sql FROM sqlite_schema WHERE name='work_item_execution_associations_v6'").get() as { sql: string }).sql
    .replace("    work_item_revision INTEGER CHECK (work_item_revision IS NULL OR work_item_revision >= 1),\n", "")
    .replace("    planned_source_json TEXT CHECK (planned_source_json IS NULL OR json_valid(planned_source_json)),\n", "")
    .replace("    actual_source_json TEXT CHECK (actual_source_json IS NULL OR json_valid(actual_source_json)),\n", "");
  rebuild(db, "work_item_execution_associations_v6", ddl, ["execution_id", "work_item_id", "created_at"]);
  assert.deepEqual(db.prepare("PRAGMA table_info(work_item_execution_associations_v6)").all().map((row) => row.name), ["execution_id", "work_item_id", "created_at"]);
}

// @test-value v2
// kind = "compatibility"
// claim = "旧schemaの未改訂queued Work Itemは元のenqueue履歴を保持し、admission時にrevision/planned/actualを原子的に取得してrunningへ移行できる"
// fault = "NULL revisionの旧associationを一律拒否する、または移行で過去のexecution履歴を書き換える"
// observable = "旧DDLからのmigration、queued/running状態、association全列、旧event/header、admitted payload、再open後のprojection"
// observation_boundary = "component-behavior"
// oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/02-work-item-lifecycle.md" }
// scope = "legacy queued execution source migration and admission"
// lifecycle = "permanent"
// @end-test-value
it("未改訂の旧queued associationをadmissionで移行し履歴を保持する", async () => {
  const f = await fixture(true);
  const work = new WorkItemStorageV6(f.dbPath);
  let executions = new SessionExecutionStorageV6(f.dbPath);
  const db = new DatabaseSync(f.dbPath);
  try {
    const item = work.create({ id: "legacy-queued-work", binding: binding(null, "root", "executor", "legacy"), principalSessionId: "root", idempotencyKey: "create-queued", requestFingerprint: "create-queued", expectedContainerRevision: containerRevision(f.dbPath, "executor"), createdAt: NOW, expiresAt: EXPIRES, proof: proof("work.create") });
    executions.enqueue({ id: "legacy-queued", sessionId: "executor", expectedContainerRevision: containerRevision(f.dbPath, "executor"), request: { userMessage: "queued" }, idempotencyKey: "queued", requestFingerprint: "queued", createdAt: NOW, expiresAt: EXPIRES, proof: proof("turn.enqueue", "executor"), workItemId: item.id });
    executions.close();
    downgradeQueuedAssociation(db);
    const oldEvents = db.prepare("SELECT * FROM session_execution_events_v6 ORDER BY revision").all();
    const oldHeaders = db.prepare("SELECT * FROM resource_event_headers_v6 ORDER BY sequence").all();
    ensureV6Schema(db);
    executions = new SessionExecutionStorageV6(f.dbPath);
    assert.equal(executions.get("legacy-queued")?.state, "queued");
    assert.equal(db.prepare("SELECT work_item_revision FROM work_item_execution_associations_v6").get()?.work_item_revision, null);
    const admitted = executions.admitNextQueued("executor", NOW)!;
    assert.equal(admitted.state, "running");
    assert.equal(admitted.workItemRevision, item.revision);
    assert.deepEqual(admitted.plannedSourceIdentity, item.sourceIdentity);
    assert.deepEqual(admitted.actualStartSourceIdentity, { kind: "git_unavailable", workspace: f.directory.replace(/\\/g, "/"), repository: null, branch: null, base: null, head: null });
    const association = db.prepare("SELECT * FROM work_item_execution_associations_v6").get()!;
    assert.equal(association.work_item_revision, item.revision);
    assert.deepEqual(JSON.parse(association.planned_source_json as string), item.sourceIdentity);
    assert.deepEqual(JSON.parse(association.actual_source_json as string), admitted.actualStartSourceIdentity);
    assert.deepEqual(db.prepare("SELECT * FROM session_execution_events_v6 WHERE revision=1").all(), oldEvents);
    assert.deepEqual(db.prepare("SELECT * FROM resource_event_headers_v6 ORDER BY sequence").all().slice(0, oldHeaders.length), oldHeaders);
    const event = db.prepare("SELECT payload_json FROM session_execution_events_v6 WHERE event_kind='admitted'").get()!;
    const projection = JSON.parse(event.payload_json as string).projection;
    assert.equal(projection.workItemRevision, item.revision);
    assert.deepEqual(projection.plannedSourceIdentity, item.sourceIdentity);
    assert.deepEqual(projection.actualStartSourceIdentity, admitted.actualStartSourceIdentity);
    assert.equal(executions.admitNextQueued("executor", NOW), null);
    executions.close();
    executions = new SessionExecutionStorageV6(f.dbPath);
    assert.deepEqual(executions.get("legacy-queued"), admitted);
  } finally { db.close(); executions.close(); work.close(); await rm(f.directory, { recursive: true, force: true }); }
});

// @test-value v2
// kind = "invariant"
// claim = "旧queuedでもenqueue後の改訂がmigration前後のいずれで起きても拒否し、新形式のassociation欠落を旧形式として救済しない"
// fault = "migrationまたはadmissionで現在revisionを無条件採用し、enqueue後に変わった契約や改変associationを実行する"
// observable = "admissionの型付き拒否、queued状態、association/event/budget全行の不変"
// observation_boundary = "component-behavior"
// oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/02-work-item-lifecycle.md" }
// scope = "legacy queued revision and source integrity"
// lifecycle = "permanent"
// @end-test-value
it("旧queuedの移行前後の改訂と新associationのNULL改変を拒否する", async () => {
  for (const scenario of ["before-migration", "after-migration", "modern-null"] as const) {
    const f = await fixture();
    const work = new WorkItemStorageV6(f.dbPath);
    const executions = new SessionExecutionStorageV6(f.dbPath);
    const db = new DatabaseSync(f.dbPath);
    try {
      const item = work.create({ id: "queued-work", binding: binding(null, "root", "executor", "queued"), principalSessionId: "root", idempotencyKey: "create", requestFingerprint: "create", expectedContainerRevision: containerRevision(f.dbPath, "executor"), createdAt: NOW, expiresAt: EXPIRES, proof: proof("work.create") });
      executions.enqueue({ id: "queued", sessionId: "executor", expectedContainerRevision: containerRevision(f.dbPath, "executor"), request: { userMessage: "queued" }, idempotencyKey: "queued", requestFingerprint: "queued", createdAt: NOW, expiresAt: EXPIRES, proof: proof("turn.enqueue", "executor"), workItemId: item.id });
      const revise = () => work.reviseRoot({ workItemId: item.id, principalSessionId: "root", idempotencyKey: "revise", requestFingerprint: "revise", expectedRevision: item.revision, goal: "changed", scope: item.scope, completionCriteria: item.completionCriteria, authority: item.authority, updatedAt: NOW, expiresAt: EXPIRES, proof: proof("work.revise") });
      if (scenario === "before-migration") revise();
      if (scenario !== "modern-null") { downgradeQueuedAssociation(db); ensureV6Schema(db); }
      else db.exec("UPDATE work_item_execution_associations_v6 SET work_item_revision=NULL,planned_source_json=NULL,actual_source_json=NULL");
      if (scenario === "after-migration") revise();
      const snapshot = () => ["work_item_execution_associations_v6", "session_execution_events_v6", "resource_budget_dimensions_v6", "resource_budget_events_v6"].map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
      const before = snapshot();
      assert.throws(() => executions.admitNextQueued("executor", NOW), SessionExecutionWorkItemAssociationError, scenario);
      assert.equal(executions.get("queued")?.state, "queued");
      assert.deepEqual(snapshot(), before, scenario);
    } finally { db.close(); executions.close(); work.close(); await rm(f.directory, { recursive: true, force: true }); }
  }
});
