import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import { SESSION_AUTHORITY_MAPPING_REVISION, SESSION_AUTHORITY_OPERATION_DEFINITIONS, type MutationAuthorityProof } from "../../src/session-authority.js";
import { buildChildSessionRoleBinding, type RootSessionRole } from "../../src/session-role-binding.js";
import { buildNewSession, type Session } from "../../src/session-state.js";
import type { ResolvedAgentRuntimeBinding } from "../../src-electron/agent-runtime-binding.js";
import { createOrVerifyV6FreshDatabase } from "../../src-electron/app-database-v6-bootstrap.js";
import { SessionExecutionStorageV6 } from "../../src-electron/session-execution-storage-v6.js";
import { SessionStorageV6 } from "../../src-electron/session-storage-v6.js";
import { WorkItemService } from "../../src-electron/work-item-service.js";
import { WorkItemStorageV6 } from "../../src-electron/work-item-storage-v6.js";

const NOW = "2026-09-13T00:00:00.000Z";
function proof(operation: "work.create" | "work.cancel", owner = "root"): MutationAuthorityProof {
  const definition = SESSION_AUTHORITY_OPERATION_DEFINITIONS[operation];
  return { principal: { kind: "system", service: "delegation-work-cancel-test" }, providerId: null, operation, mappingRevision: SESSION_AUTHORITY_MAPPING_REVISION, action: definition.action, effectClass: definition.effectClass, grantId: null, grantRevision: null, evaluatedAt: NOW, resolvedScope: { resourceKind: definition.resourceKind, resourceId: owner, rootSessionId: "root", ownerKind: "session", ownerId: owner, relation: "self" } };
}
const binding: ResolvedAgentRuntimeBinding = { bindingId: "test", bindingIdHash: "test", actorSessionId: "root", providerId: "codex", executionGeneration: "generation", authoritySnapshot: {}, operationGrants: ["session.runtime.invoke"], createdAt: NOW, expiresAt: null };
function session(id: string, role?: RootSessionRole, parent?: Session): Session { return { ...buildNewSession({ id, taskTitle: id, workspaceLabel: "workspace", workspacePath: process.cwd(), branch: "main", characterId: "character", character: "Character", characterIconPath: "", characterThemeColors: { main: "#fff", sub: "#000" }, approvalMode: DEFAULT_APPROVAL_MODE, rootSessionRole: role, roleBinding: parent ? buildChildSessionRoleBinding(id, parent.id, parent.roleBinding!, "executor") : undefined }), updatedAt: NOW }; }

// @test-value v2
// kind = "invariant"
// claim = "compensation cancelが取消開始前に保存済みの別execution associationを検出した場合、Work Itemのstateとrevisionを変更せず、同一executionのterminal associationだけならcancelを許可する"
// oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/04-delegation-transaction.md#公開操作" }
// fault = "別DB接続から採用executionが保存済みでも、補償がWork Itemをcancelして進行中作業を隠す"
// observable = "別接続commit後の補償拒否、state/revision不変、terminal own associationの成功"
// observation_boundary = "component-behavior"
// scope = "WorkItemService.cancel existing association guard with real SQLite storage"
// lifecycle = "permanent"
// @end-test-value
test("compensation cancel rejects an existing association owned by another execution", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "delegation-work-cancel-"));
  const { dbPath } = await createOrVerifyV6FreshDatabase(dir);
  const sessions = new SessionStorageV6(dbPath);
  const executions = new SessionExecutionStorageV6(dbPath);
  const storage = new WorkItemStorageV6(dbPath);
  try {
    const root = sessions.insertSession(session("root", "overall-coordinator"));
    const child = sessions.insertSession(session("child", undefined, root));
    let nextWorkId = 1;
    const service = new WorkItemService({ storage, getTurnAuthoritySession: (id) => sessions.getSessionTurnAuthority(id), createWorkItemId: () => `work-${nextWorkId++}`, currentTimestamp: () => NOW });
    const childRevision = () => sessions.getSessionResourceRevision(child.id)!;
    const item = service.create({ expectedContainerRevision: childRevision(), targetSessionId: child.id, goal: "goal", scope: "scope", completionCriteria: "done", authority: "local", sourceIdentity: { workspace: null, repository: null, branch: null, base: null, head: null }, idempotencyKey: "create" }, binding, proof("work.create"));
    const active = item;
    const db = new DatabaseSync(dbPath);
    db.prepare("INSERT INTO session_executions_v6 (id, session_id, operation, state, request_json, created_at, updated_at) VALUES (?, ?, 'turn.enqueue', 'queued', '{}', ?, ?)").run("execution-other", child.id, NOW, NOW);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM work_item_execution_associations_v6 WHERE work_item_id = ?").get(active.id)!.count, 0);
    db.prepare("INSERT INTO work_item_execution_associations_v6 (execution_id, work_item_id, created_at) VALUES (?, ?, ?)").run("execution-other", active.id, NOW);
    db.close();
    assert.throws(() => service.cancel({ workItemId: active.id, expectedRevision: active.revision, idempotencyKey: "cancel-race" }, binding, proof("work.cancel"), { executionId: "execution-own" }), /use|association|references|active/i);
    const unchanged = storage.get(active.id);
    assert.equal(unchanged?.state, "pending");
    assert.equal(unchanged?.revision, active.revision);
    const own = service.create({ expectedContainerRevision: childRevision(), targetSessionId: child.id, goal: "own", scope: "own", completionCriteria: "done", authority: "local", sourceIdentity: { workspace: null, repository: null, branch: null, base: null, head: null }, idempotencyKey: "create-own" }, binding, proof("work.create"));
    const ownActive = own;
    const ownDb = new DatabaseSync(dbPath);
    ownDb.prepare("INSERT INTO session_executions_v6 (id, session_id, operation, state, request_json, created_at, updated_at) VALUES (?, ?, 'turn.enqueue', 'completed', '{}', ?, ?)").run("execution-own", child.id, NOW, NOW);
    ownDb.prepare("INSERT INTO work_item_execution_associations_v6 (execution_id, work_item_id, created_at) VALUES (?, ?, ?)").run("execution-own", ownActive.id, NOW);
    ownDb.close();
    const canceled = service.cancel({ workItemId: ownActive.id, expectedRevision: ownActive.revision, idempotencyKey: "cancel-own" }, binding, proof("work.cancel"), { executionId: "execution-own" });
    assert.equal(canceled.state, "canceled");
  } finally { executions.close(); storage.close(); sessions.close(); await rm(dir, { recursive: true, force: true }); }
});
