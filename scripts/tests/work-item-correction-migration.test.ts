import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { createOrVerifyV6FreshDatabase } from "../../src-electron/app-database-v6-bootstrap.js";
import { ensureV6Schema } from "../../src-electron/database-schema-v6.js";
import { backfillBaselineSessionAuthority } from "../../src-electron/session-authority-storage.js";
import { WorkItemStorageV6 } from "../../src-electron/work-item-storage-v6.js";
import { SESSION_AUTHORITY_MAPPING_REVISION, SESSION_AUTHORITY_OPERATION_DEFINITIONS, type MutationAuthorityProof } from "../../src/session-authority.js";
import type { SQLInputValue } from "node:sqlite";
import type { DelegatedWorkItemBinding, WorkItem } from "../../src/work-item.js";

const NOW = "2026-08-24T12:00:00.000Z";
const LATER = "2026-08-24T12:01:00.000Z";
const EXPIRES = "2026-08-25T12:00:00.000Z";
const SOURCE = { workspace: process.cwd(), repository: "WithMate", branch: "migration", base: "base", head: "head" };

function proof(operation: keyof typeof SESSION_AUTHORITY_OPERATION_DEFINITIONS, ownerId = "root"): MutationAuthorityProof {
  const definition = SESSION_AUTHORITY_OPERATION_DEFINITIONS[operation];
  return { principal: { kind: "system", service: "work-item-correction-migration-test" }, providerId: null, operation,
    mappingRevision: SESSION_AUTHORITY_MAPPING_REVISION, action: definition.action,
    resolvedScope: { resourceKind: definition.resourceKind, resourceId: ownerId, rootSessionId: "root", ownerKind: "session", ownerId, relation: "self" },
    effectClass: definition.effectClass, grantId: null, grantRevision: null, evaluatedAt: NOW };
}

function binding(parentWorkItemId: string | null, creatorSessionId: string, targetSessionId: string, goal: string): DelegatedWorkItemBinding {
  return { kind: "delegated", rootSessionId: "root", creatorSessionId, targetSessionId, parentWorkItemId, goal,
    scope: "scope", completionCriteria: "complete", authority: "local", sourceIdentity: SOURCE };
}

function revision(dbPath: string, sessionId: string): number {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { return Number((db.prepare("SELECT resource_revision FROM sessions_v6 WHERE id=?").get(sessionId) as { resource_revision: number }).resource_revision); }
  finally { db.close(); }
}

function sql<T = Record<string, unknown>>(dbPath: string, query: string, ...args: SQLInputValue[]): T[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { return db.prepare(query).all(...args) as T[]; } finally { db.close(); }
}

function result(item: WorkItem, summary: string) {
  return { outcome: "completed" as const, summary, changes: [], verificationResults: [], findings: [], unverifiedItems: [], remainingWork: [], reportingSessionId: item.targetSessionId, reportedAt: LATER };
}

describe("work item correction populated migration", () => {
  // @test-value v2
  // kind = "compatibility"
  // claim = "実storageで生成したresult/decision/retry replacement/reopen successor/archive delete/grant/budget populated DBを旧Slice 4相当DDLへ降格しても、ensureV6Schemaがcurrent projectionとbaseline result revisionを再構築し、二回目のopenで同一状態を保つ"
  // fault = "migrationが旧decision/replacement、successor、削除済みresult、header、grant、budget、idempotencyを失う、または移行済みresult revisionの欠損を修復して隠す"
  // observable = "current/history/provenance全行の移行前後比較、result revision baseline、terminal parentのfinalized状態、二回目openの同一状態、移行済みresult行欠損の拒否"
  // observation_boundary = "component-behavior"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/03-result-and-aggregation-correction.md" }
  // scope = "populated correction schema migration"
  // lifecycle = "permanent"
  // distinction = "手作りrowではなくproduction WorkItemStorageV6経路で履歴を生成し、DDL降格前後の全current/history/provenanceを比較する"
  // @end-test-value
  it("populated correction databaseを降格DDLから再構築する", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "withmate-correction-migration-"));
    const { dbPath } = await createOrVerifyV6FreshDatabase(directory);
    const setupDb = new DatabaseSync(dbPath);
    try {
      const insertSession = setupDb.prepare(`INSERT INTO sessions_v6 (id,title,state,provider_id,catalog_revision,model_id,approval_mode,workspace_path,created_at,updated_at,last_active_at) VALUES (?,?,'active','codex',1,'gpt-5','on-request',?,?,?,?)`);
      for (const id of ["root", "task", "executor", "task-2"]) insertSession.run(id, id, process.cwd(), NOW, NOW, NOW);
      const role = setupDb.prepare(`INSERT INTO session_role_bindings_v6 (session_id,session_role,role_contract_revision,root_session_id,parent_session_id,delegation_depth) VALUES (?, ?, 1, 'root', ?, ?)`);
      role.run("root", "overall-coordinator", null, 0); role.run("task", "task-coordinator", "root", 1); role.run("task-2", "task-coordinator", "root", 1); role.run("executor", "executor", "task", 2);
      backfillBaselineSessionAuthority(setupDb, NOW);
    } finally { setupDb.close(); }
    const storage = new WorkItemStorageV6(dbPath);
    let reopened: WorkItem;
    try {
      const create = (id: string, b: DelegatedWorkItemBinding, key: string) => storage.create({ id, binding: b, principalSessionId: "root", idempotencyKey: key, requestFingerprint: `${key}-fp`, expectedContainerRevision: revision(dbPath, b.targetSessionId), createdAt: NOW, expiresAt: EXPIRES, proof: proof("work.create") });
      const parent = create("migration-parent", binding(null, "root", "task", "parent"), "migration-parent");
      const child = create("migration-child", binding(parent.id, "task", "executor", "child"), "migration-child");
      const running = storage.mutate({ operation: "work.transition", workItemId: child.id, principalSessionId: "root", idempotencyKey: "migration-child-start", requestFingerprint: "migration-child-start-fp", expectedRevision: child.revision, state: "in_progress", result: null, updatedAt: NOW, expiresAt: EXPIRES, proof: proof("work.transition") });
      const done = storage.mutate({ operation: "work.result", workItemId: child.id, principalSessionId: "root", idempotencyKey: "migration-child-result", requestFingerprint: "migration-child-result-fp", expectedRevision: running.revision, state: "completed", result: result(child, "original"), updatedAt: LATER, expiresAt: EXPIRES, proof: proof("work.result") });
      const retry = storage.retryAggregation({ parentWorkItemId: parent.id, childWorkItemId: done.id, actorSessionId: "task", expectedAggregateRevision: storage.getAggregationSummary(parent.id).aggregateRevision, idempotencyKey: "migration-retry", requestFingerprint: "migration-retry-fp", replacementId: "migration-replacement", replacementBinding: binding(parent.id, "task", "executor", "replacement"), decidedAt: LATER, expiresAt: EXPIRES, reason: "retry", proof: proof("work.aggregation.retry") });
      const replacementStart = storage.mutate({ operation: "work.transition", workItemId: retry.replacement.id, principalSessionId: "root", idempotencyKey: "migration-replacement-start", requestFingerprint: "migration-replacement-start-fp", expectedRevision: retry.replacement.revision, state: "in_progress", result: null, updatedAt: NOW, expiresAt: EXPIRES, proof: proof("work.transition") });
      storage.mutate({ operation: "work.result", workItemId: retry.replacement.id, principalSessionId: "root", idempotencyKey: "migration-replacement-result", requestFingerprint: "migration-replacement-result-fp", expectedRevision: replacementStart.revision, state: "completed", result: result(retry.replacement, "replacement"), updatedAt: LATER, expiresAt: EXPIRES, proof: proof("work.result") });
      reopened = storage.reopen({ workItemId: done.id, expectedRevision: done.revision, principalSessionId: "root", idempotencyKey: "migration-reopen", requestFingerprint: "migration-reopen-fp", updatedAt: LATER, expiresAt: EXPIRES, proof: proof("work.reopen"), targetSessionId: "executor", parentWorkItemId: parent.id, goal: "successor", scope: "scope", completionCriteria: "complete", authority: "local", sourceIdentity: SOURCE, expectedContainerRevision: revision(dbPath, "executor") });
      const orphan = create("migration-orphan", binding(null, "root", "executor", "orphan"), "migration-orphan");
      const settle = (item: WorkItem) => {
        const started = storage.mutate({ operation: "work.transition", workItemId: item.id, principalSessionId: "root", idempotencyKey: `${item.id}-start`, requestFingerprint: `${item.id}-start`, expectedRevision: item.revision, state: "in_progress", result: null, updatedAt: LATER, expiresAt: EXPIRES, proof: proof("work.transition") });
        return storage.mutate({ operation: "work.result", workItemId: item.id, principalSessionId: "root", idempotencyKey: `${item.id}-done`, requestFingerprint: `${item.id}-done`, expectedRevision: started.revision, ...(item.id === parent.id ? { expectedAggregateRevision: storage.getAggregationSummary(parent.id).aggregateRevision } : {}), state: "completed", result: result(item, item.id), updatedAt: LATER, expiresAt: EXPIRES, proof: proof("work.result") });
      };
      const orphanDone = settle(orphan);
      const archived = storage.archive({ workItemId: orphanDone.id, expectedRevision: orphanDone.revision, principalSessionId: "root", idempotencyKey: "migration-orphan-archive", requestFingerprint: "migration-orphan-archive-fp", updatedAt: LATER, expiresAt: EXPIRES, proof: proof("work.archive"), reason: "cleanup" });
      storage.delete({ workItemId: archived.id, expectedRevision: archived.revision, principalSessionId: "root", idempotencyKey: "migration-orphan-delete", requestFingerprint: "migration-orphan-delete-fp", updatedAt: LATER, expiresAt: EXPIRES, proof: proof("work.delete") });
      settle(reopened);
      for (const childId of [retry.replacement.id, reopened.id]) storage.decideAggregation({ parentWorkItemId: parent.id, childWorkItemId: childId, actorSessionId: "task", decision: "accepted", reason: null, expectedAggregateRevision: storage.getAggregationSummary(parent.id).aggregateRevision, idempotencyKey: `${childId}-accept`, requestFingerprint: `${childId}-accept`, decidedAt: LATER, expiresAt: EXPIRES, proof: proof("work.aggregation.decide") });
      settle(parent);
      const db = new DatabaseSync(dbPath);
      try {
        // Slice 4 has the same immutable result event body, without correction metadata or finalized events.
        db.exec(`UPDATE work_item_events_v6 SET payload_json=json_remove(payload_json,'$.resultRevision','$.sourceRevision','$.executionRevision') WHERE event_type='result_reported';
          DROP TRIGGER work_item_aggregation_events_no_delete_v6;
          DROP TRIGGER resource_event_headers_no_delete_v6;
          DELETE FROM resource_event_headers_v6 WHERE event_id IN (SELECT event_id FROM work_item_aggregation_events_v6 WHERE event_kind='finalized');
          DELETE FROM work_item_aggregation_events_v6 WHERE event_kind='finalized';
          UPDATE work_item_aggregations_v6 SET aggregate_revision=aggregate_revision-1 WHERE parent_work_item_id='migration-parent';
          DROP TABLE work_item_result_revisions_v6;
          ALTER TABLE work_item_aggregations_v6 DROP COLUMN stale;
          ALTER TABLE work_item_aggregations_v6 DROP COLUMN stale_reasons_json;
          ALTER TABLE work_item_aggregations_v6 DROP COLUMN finalized_revision;
          ALTER TABLE work_item_aggregations_v6 DROP COLUMN finalized_result_revision;`);
        for (const [table, removed] of [
          ["work_item_idempotency_v6", ", 'work.result.correct'"],
          ["work_item_aggregation_idempotency_v6", ", 'work.aggregation.correct'"],
          ["work_item_aggregation_events_v6", ", 'decision_corrected', 'stale', 'finalized'"],
        ]) {
          const original = (db.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(table) as { sql: string }).sql;
          const legacy = original.replace(removed, "");
          assert.notEqual(legacy, original);
          db.exec(`CREATE TEMP TABLE correction_migration_copy AS SELECT * FROM ${table}; DROP TABLE ${table}; ${legacy}; INSERT INTO ${table} SELECT * FROM correction_migration_copy; DROP TABLE correction_migration_copy;`);
        }
      } finally { db.close(); }
      const tables = ["work_items_v6", "work_item_events_v6", "work_item_aggregation_decisions_v6", "work_item_aggregation_events_v6", "work_item_idempotency_v6", "work_item_aggregation_idempotency_v6", "work_item_tombstones_v6", "resource_event_headers_v6", "session_authority_grants_v6", "resource_budget_dimensions_v6", "resource_budget_events_v6"];
      const snapshot = () => Object.fromEntries(tables.map(table => [table, sql(dbPath, `SELECT * FROM ${table} ORDER BY rowid`)]));
      const before = snapshot();
      assert.ok(before.session_authority_grants_v6.length > 0);
      assert.ok(before.resource_budget_events_v6.length > 0);
      const first = new DatabaseSync(dbPath); try { ensureV6Schema(first); } finally { first.close(); }
      const afterFirst = Object.fromEntries(Object.keys(before).map((table) => [table, sql(dbPath, `SELECT * FROM ${table} ORDER BY rowid`)]));
      assert.deepEqual(afterFirst, before);
      assert.equal(sql(dbPath, "SELECT result_revision FROM work_item_result_revisions_v6 WHERE work_item_id=? ORDER BY result_revision", done.id).length, 1);
      assert.equal(sql(dbPath, "SELECT result_revision FROM work_item_result_revisions_v6 WHERE work_item_id=?", reopened.id).length, 1);
      assert.deepEqual(JSON.parse(sql<{ result_json: string }>(dbPath, "SELECT result_json FROM work_item_result_revisions_v6 WHERE work_item_id=?", orphan.id)[0].result_json), orphanDone.result);
      assert.equal(storage.getAggregationSummary(parent.id).finalizedResultRevision, 1);
      assert.equal(storage.getAggregationSummary(parent.id).stale, false);
      assert.equal(sql(dbPath, "SELECT COUNT(*) AS n FROM work_item_result_revisions_v6 WHERE work_item_id=?", retry.replacement.id)[0].n, 1);
      const second = new DatabaseSync(dbPath); try { ensureV6Schema(second); } finally { second.close(); }
      const afterSecond = Object.fromEntries(Object.keys(before).map((table) => [table, sql(dbPath, `SELECT * FROM ${table} ORDER BY rowid`)]));
      assert.deepEqual(afterSecond, afterFirst);
      const missing = new DatabaseSync(dbPath); try { missing.exec("DROP TRIGGER work_item_result_revisions_no_delete_v6; DELETE FROM work_item_result_revisions_v6 WHERE work_item_id='migration-child'"); } finally { missing.close(); }
      assert.throws(() => { const invalid = new DatabaseSync(dbPath); try { ensureV6Schema(invalid); } finally { invalid.close(); } }, /baseline|result|schema/i);
    } finally { storage.close(); await rm(directory, { recursive: true, force: true }); }
  });
});
