import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import { RESOURCE_BUDGET_DEFAULT_HARD_LIMITS } from "../../src/resource-budget.js";
import {
  SESSION_AUTHORITY_MAPPING_REVISION,
  SESSION_AUTHORITY_OPERATION_DEFINITIONS,
  type MutationAuthorityProof,
  type SessionAuthorityGrant,
} from "../../src/session-authority.js";
import { buildChildSessionRoleBinding, type RootSessionRole, type SessionRole } from "../../src/session-role-binding.js";
import { buildNewSession, type Session } from "../../src/session-state.js";
import { applySessionMove } from "../../src-electron/session-lifecycle-move.js";
import {
  issueTrustedCrossRootTransferCapability,
  listActiveSessionAuthorityGrants,
} from "../../src-electron/session-authority-storage.js";
import {
  ResourceBudgetError,
  ResourceBudgetStorage,
  verifyResourceBudgetLedger,
} from "../../src-electron/resource-budget-storage.js";
import { verifyResourceHistoryProjections } from "../../src-electron/resource-history-schema.js";
import { SessionStorageV6 } from "../../src-electron/session-storage-v6.js";
import { WorkItemStorageV6 } from "../../src-electron/work-item-storage-v6.js";

const NOW = "2026-09-05T12:00:00.000Z";
const LATER = "2026-09-05T12:01:00.000Z";
const EXPIRES = "2026-10-05T12:00:00.000Z";
const ALL_ROLES = ["standalone", "overall-coordinator", "task-coordinator", "executor"] as const satisfies readonly SessionRole[];

function root(id: string, role: RootSessionRole): Session {
  return { ...buildNewSession({ id, taskTitle: id, workspaceLabel: "workspace", workspacePath: "C:/workspace",
    branch: "main", characterId: "character-a", character: "A", characterIconPath: "",
    characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" }, approvalMode: DEFAULT_APPROVAL_MODE,
    rootSessionRole: role }), updatedAt: NOW };
}

function child(id: string, parent: Session, role: "task-coordinator" | "executor"): Session {
  return { ...buildNewSession({ id, taskTitle: id, workspaceLabel: "workspace", workspacePath: "C:/workspace",
    branch: "main", characterId: "character-a", character: "A", characterIconPath: "",
    characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" }, approvalMode: DEFAULT_APPROVAL_MODE,
    roleBinding: buildChildSessionRoleBinding(id, parent.id, parent.roleBinding!, role) }), updatedAt: NOW };
}

function trustedMoveProof(rootSessionId: string): MutationAuthorityProof {
  return { principal: { kind: "system", service: "session-root-transfer-test" }, providerId: null,
    operation: "session.move", mappingRevision: SESSION_AUTHORITY_MAPPING_REVISION, action: "session.move",
    resolvedScope: { resourceKind: "session_namespace", resourceId: null, rootSessionId,
      ownerKind: "session", ownerId: rootSessionId, relation: "root_owner" }, effectClass: "local_mutation",
    grantId: null, grantRevision: null, evaluatedAt: NOW };
}

function issueMoveGrant(db: DatabaseSync, sourceActorSessionId: string, destinationRootSessionId: string): SessionAuthorityGrant {
  const before = new Set(listActiveSessionAuthorityGrants(db, sourceActorSessionId, new Date(NOW)).map((grant) => grant.grantId));
  const proof = trustedMoveProof(destinationRootSessionId);
  const issued = issueTrustedCrossRootTransferCapability(db, { sourceActorSessionId, destinationRootSessionId,
    destinationTargetRoles: ALL_ROLES, principal: { kind: "system", service: "session-root-transfer-test" },
    proof, expiresAt: null, issuedAt: NOW });
  const created = issued.find((grant) => !before.has(grant.grantId)
    && grant.provenance.source === "trusted-cross-root-transfer");
  assert.ok(created, `transfer grant was not created for ${destinationRootSessionId}`);
  return created;
}

function agentMoveProof(actorSessionId: string, grant: SessionAuthorityGrant, rootSessionId: string): MutationAuthorityProof {
  return { principal: { kind: "agent", agent: "session-runtime", actorSessionId, runtimeGeneration: "generation-1" },
    providerId: "internal", operation: "session.move", mappingRevision: SESSION_AUTHORITY_MAPPING_REVISION,
    action: "session.move", resolvedScope: { resourceKind: "session", resourceId: null, rootSessionId,
      ownerKind: "session", ownerId: rootSessionId, relation: "root_owner" }, effectClass: "local_mutation",
    grantId: grant.grantId, grantRevision: grant.revision, evaluatedAt: NOW };
}

function budgetProof(rootSessionId: string): MutationAuthorityProof {
  return { principal: { kind: "user", receiptId: `budget:${rootSessionId}` }, providerId: null,
    operation: "budget.configure", mappingRevision: SESSION_AUTHORITY_MAPPING_REVISION, action: "budget.configure",
    resolvedScope: { resourceKind: "budget", resourceId: rootSessionId, rootSessionId,
      ownerKind: "session", ownerId: rootSessionId, relation: "self" }, effectClass: "local_mutation",
    grantId: null, grantRevision: null, evaluatedAt: NOW };
}

function workProof(rootSessionId: string, operation: "work.transition" | "work.result"): MutationAuthorityProof {
  const definition = SESSION_AUTHORITY_OPERATION_DEFINITIONS[operation];
  return { principal: { kind: "system", service: "session-root-transfer-test" }, providerId: null,
    operation, mappingRevision: SESSION_AUTHORITY_MAPPING_REVISION, action: definition.action,
    resolvedScope: { resourceKind: definition.resourceKind, resourceId: `root-work-item:${rootSessionId}`,
      rootSessionId, ownerKind: "session", ownerId: rootSessionId, relation: "self" },
    effectClass: definition.effectClass, grantId: null, grantRevision: null, evaluatedAt: NOW };
}

function settleRootWork(db: DatabaseSync, rootSessionId: string): void {
  const storage = new WorkItemStorageV6(db);
  const workItemId = `root-work-item:${rootSessionId}`;
  const current = storage.get(workItemId);
  assert.ok(current);
  const active = storage.mutate({ operation: "work.transition", workItemId, principalSessionId: rootSessionId,
    idempotencyKey: `${workItemId}:start`, requestFingerprint: `${workItemId}:start:fp`,
    expectedRevision: current.revision, state: "in_progress", result: null, updatedAt: NOW, expiresAt: EXPIRES,
    proof: workProof(rootSessionId, "work.transition") });
  storage.mutate({ operation: "work.result", workItemId, principalSessionId: rootSessionId,
    idempotencyKey: `${workItemId}:result`, requestFingerprint: `${workItemId}:result:fp`,
    expectedRevision: active.revision, state: "completed", result: { outcome: "completed",
      summary: "source root completed", changes: [], verificationResults: [], findings: [], unverifiedItems: [],
      remainingWork: [], reportingSessionId: rootSessionId, reportedAt: LATER }, updatedAt: LATER,
    expiresAt: EXPIRES, proof: workProof(rootSessionId, "work.result") });
  storage.close();
}

function enlargeDestinationBudget(db: DatabaseSync, destinationRootSessionId: string): void {
  const budgets = new ResourceBudgetStorage(db);
  const current = budgets.getByAccountId(destinationRootSessionId);
  budgets.configure({ sessionId: destinationRootSessionId, accountId: destinationRootSessionId,
    expectedRevision: current.revision,
    hardLimits: Object.fromEntries(Object.entries(RESOURCE_BUDGET_DEFAULT_HARD_LIMITS)
      .map(([dimension, value]) => [dimension, value * 10])),
    idempotencyKey: `enlarge:${destinationRootSessionId}` }, budgetProof(destinationRootSessionId), NOW);
  budgets.close();
}

function prepareMove(db: DatabaseSync, sourceRootSessionId: string, destinationRootSessionId: string) {
  const sourceGrant = issueMoveGrant(db, sourceRootSessionId, sourceRootSessionId);
  const destinationGrant = issueMoveGrant(db, sourceRootSessionId, destinationRootSessionId);
  return { sourceGrant, destinationGrant,
    sourceProof: agentMoveProof(sourceRootSessionId, sourceGrant, sourceRootSessionId),
    destinationProof: agentMoveProof(sourceRootSessionId, destinationGrant, destinationRootSessionId) };
}

function baselineGrantShape(db: DatabaseSync, sessionId: string) {
  return listActiveSessionAuthorityGrants(db, sessionId, new Date(LATER))
    .filter((grant) => grant.rootSessionId === sessionId && grant.granteeSessionId === sessionId
      && grant.provenance.source === "role-baseline")
    .map((grant) => ({ grantId: grant.grantId, actions: [...grant.actions].sort() }))
    .sort((left, right) => left.grantId.localeCompare(right.grantId));
}

function applyRootMove(db: DatabaseSync, args: { source: Session; destination: Session; descendants: readonly Session[];
  sourceProof: MutationAuthorityProof; destinationProof: MutationAuthorityProof; operationId: string }) {
  return applySessionMove(db, { sessionId: args.source.id, expectedRevision: 1, kind: "cross_root",
    destinationRootSessionId: args.destination.id, destinationParentSessionId: null, destinationExpectedRevision: 1,
    transferManifestRevision: 1, transferPolicy: "full",
    descendants: args.descendants.map((session) => ({ sessionId: session.id, revision: 1 })),
    destinationProof: args.destinationProof }, args.sourceProof, LATER, args.operationId);
}

function binding(db: DatabaseSync, sessionId: string) {
  return { ...db.prepare(`SELECT session_role, root_session_id, parent_session_id, delegation_depth
    FROM session_role_bindings_v6 WHERE session_id = ?`).get(sessionId) as Record<string, unknown> };
}

function snapshot(db: DatabaseSync): string {
  return JSON.stringify({ sessions: db.prepare("SELECT id, resource_revision FROM sessions_v6 ORDER BY id").all(),
    bindings: db.prepare("SELECT * FROM session_role_bindings_v6 ORDER BY session_id").all(),
    work: db.prepare(`SELECT id, kind, root_session_id, creator_session_id, target_session_id,
      parent_work_item_id, state, revision, result_json FROM work_items_v6 ORDER BY id`).all(),
    accounts: db.prepare("SELECT * FROM resource_budget_accounts_v6 ORDER BY account_id").all(),
    dimensions: db.prepare("SELECT * FROM resource_budget_dimensions_v6 ORDER BY account_id, dimension").all(),
    grants: db.prepare(`SELECT grant_id, root_session_id, grantee_session_id, revision, revoked_at
      FROM session_authority_grants_v6 ORDER BY grant_id`).all() });
}

describe("Session root transfer", () => {
  // @test-value v2
  // kind = "invariant"
  // claim = "standalone rootのwhole-root移管はdestinationをoverall-coordinatorへ昇格し、source Session・Root Work Item・budget・grantを同じtransactionでdestination rootへ統合する"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/05-grants-routing-and-transfer.md#Session ownership transfer" }
  // fault = "root入力をparentなしとして拒否する、またはSession、Root Work Item、budget、grantの一部だけを移管する"
  // observable = "再open後のSession binding/revision、Work Item projection/history、budget account/ledger、authority grant"
  // observation_boundary = "component-behavior"
  // scope = "whole-root transfer of a standalone Session"
  // lifecycle = "permanent"
  // impact = "有効な公開root移管が実行不能になるか、複数の永続化正本が異なるrootを指して以後の認可と履歴検証が失敗する"
  // distinction = "型・schema検査では観測できない複数storage間のtransaction整合性とDB再openを実DBで確認する"
  // risk_tags = ["authorization", "billing", "irreversible-data-loss"]
  // @end-test-value
  it("standalone rootをdestination rootへ完全移管して再openできる", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-root-transfer-standalone-"));
    const dbPath = path.join(directory, "db.sqlite");
    let sessions: SessionStorageV6 | null = new SessionStorageV6(dbPath);
    try {
      const source = root("root-source", "standalone");
      const destination = root("root-destination", "standalone");
      sessions.insertSession(source);
      sessions.insertSession(destination);
      let destinationBaselineBefore: ReturnType<typeof baselineGrantShape> = [];
      const db = new DatabaseSync(dbPath);
      try {
        settleRootWork(db, source.id);
        const budgets = new ResourceBudgetStorage(db);
        const reservation = budgets.reserveStorage({ sessionId: source.id, bytes: 32,
          operationId: "source-storage", createdAt: NOW });
        budgets.consumeReservation(reservation.reservationId, 32, NOW);
        budgets.close();
        enlargeDestinationBudget(db, destination.id);
        destinationBaselineBefore = baselineGrantShape(db, destination.id);
        assert.ok(destinationBaselineBefore.length > 0);
        const move = prepareMove(db, source.id, destination.id);
        db.exec("BEGIN IMMEDIATE");
        const result = applyRootMove(db, { source, destination, descendants: [],
          sourceProof: move.sourceProof, destinationProof: move.destinationProof,
          operationId: "root-transfer-standalone" });
        db.exec("COMMIT");

        assert.deepEqual(result.affectedSessionIds.slice().sort(), [destination.id, source.id]);
        assert.deepEqual(binding(db, destination.id), { session_role: "overall-coordinator",
          root_session_id: destination.id, parent_session_id: null, delegation_depth: 0 });
        assert.deepEqual(binding(db, source.id), { session_role: "executor",
          root_session_id: destination.id, parent_session_id: destination.id, delegation_depth: 1 });
        assert.equal((db.prepare("SELECT resource_revision FROM sessions_v6 WHERE id = ?").get(source.id) as { resource_revision: number }).resource_revision, 2);
        assert.equal((db.prepare("SELECT resource_revision FROM sessions_v6 WHERE id = ?").get(destination.id) as { resource_revision: number }).resource_revision, 2);

        const sourceWork = { ...db.prepare(`SELECT kind, root_session_id, creator_session_id, target_session_id,
          parent_work_item_id, state, revision, result_json FROM work_items_v6 WHERE id = ?`)
          .get(`root-work-item:${source.id}`) as Record<string, unknown> };
        assert.deepEqual(sourceWork, { kind: "delegated", root_session_id: destination.id,
          creator_session_id: destination.id, target_session_id: source.id, parent_work_item_id: null,
          state: "completed", revision: 4, result_json: JSON.stringify({ outcome: "completed",
            summary: "source root completed", changes: [], verificationResults: [], findings: [], unverifiedItems: [],
            remainingWork: [], reportingSessionId: source.id, reportedAt: LATER }) });
        assert.equal((db.prepare("SELECT COUNT(*) AS count FROM work_items_v6 WHERE kind = 'root' AND root_session_id = ?")
          .get(destination.id) as { count: number }).count, 1);
        assert.deepEqual({ ...db.prepare(`SELECT kind, root_session_id, creator_session_id, target_session_id, state, revision
          FROM work_items_v6 WHERE id = ?`).get(`root-work-item:${destination.id}`) as Record<string, unknown> }, { kind: "root",
          root_session_id: destination.id, creator_session_id: destination.id, target_session_id: destination.id,
          state: "pending", revision: 1 });
        const change = db.prepare(`SELECT payload_json FROM work_item_events_v6 WHERE work_item_id = ?
          AND event_type = 'parent_changed' ORDER BY revision DESC LIMIT 1`).get(`root-work-item:${source.id}`) as { payload_json: string };
        const payload = JSON.parse(change.payload_json) as Record<string, unknown>;
        assert.equal(payload.beforeKind, "root");
        assert.equal(payload.afterKind, "delegated");
        assert.equal(payload.beforeOriginKind, "native");
        assert.equal(payload.afterOriginKind, "transferred_root");
        assert.equal(payload.afterRootSessionId, destination.id);
        assert.equal((db.prepare(`SELECT root_id FROM resource_event_headers_v6 WHERE resource_kind = 'work_item'
          AND resource_id = ? AND resource_revision = 4`).get(`root-work-item:${source.id}`) as { root_id: string }).root_id, destination.id);

        assert.deepEqual({ ...db.prepare(`SELECT account_kind, root_session_id, owner_session_id, parent_account_id
          FROM resource_budget_accounts_v6 WHERE account_id = ?`).get(source.id) as Record<string, unknown> }, { account_kind: "session",
          root_session_id: destination.id, owner_session_id: source.id, parent_account_id: destination.id });
        assert.equal((db.prepare(`SELECT committed FROM resource_budget_dimensions_v6 WHERE account_id = ?
          AND dimension = 'storageBytes'`).get(source.id) as { committed: number }).committed, 0);
        assert.equal((db.prepare(`SELECT committed FROM resource_budget_dimensions_v6 WHERE account_id = ?
          AND dimension = 'storageBytes'`).get(destination.id) as { committed: number }).committed, 32);
        assert.equal((db.prepare("SELECT revoked_at FROM session_authority_grants_v6 WHERE grant_id = ?")
          .get(move.sourceGrant.grantId) as { revoked_at: string | null }).revoked_at, LATER);
        assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM session_authority_grants_v6
          WHERE json_extract(provenance_json, '$.supersedesGrantId') = ?`).get(move.sourceGrant.grantId) as { count: number }).count, 0);
        assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM session_authority_grants_v6 WHERE grantee_session_id = ?
          AND root_session_id = ? AND revoked_at IS NULL`).get(source.id, source.id) as { count: number }).count, 0);
        assert.ok((db.prepare(`SELECT COUNT(*) AS count FROM session_authority_grants_v6 WHERE grantee_session_id = ?
          AND root_session_id = ? AND revoked_at IS NULL`).get(source.id, destination.id) as { count: number }).count > 0);
        assert.deepEqual(baselineGrantShape(db, destination.id), destinationBaselineBefore);
        verifyResourceBudgetLedger(db);
        verifyResourceHistoryProjections(db);
      } finally { db.close(); }

      sessions.close();
      sessions = null;
      const reopened = new SessionStorageV6(dbPath);
      try {
        assert.equal(reopened.getSession(source.id)?.roleBinding?.rootSessionId, destination.id);
        assert.equal(reopened.getSession(source.id)?.roleBinding?.sessionRole, "executor");
        assert.equal(reopened.getSession(destination.id)?.roleBinding?.sessionRole, "overall-coordinator");
        const reopenedDb = new DatabaseSync(dbPath, { readOnly: true });
        try {
          assert.deepEqual(baselineGrantShape(reopenedDb, destination.id), destinationBaselineBefore);
        } finally { reopenedDb.close(); }
      } finally { reopened.close(); }
    } finally {
      sessions?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "overall-coordinator rootのwhole-root移管はdirect childをdestination直下へ平坦化し、grandchildの親子関係と全Sessionのrootを保つ"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/05-grants-routing-and-transfer.md#Session ownership transfer" }
  // fault = "旧root配下をそのまま一段深くしてdepth上限を超える、またはdescendantを移管漏れにする"
  // observable = "再open後のsource root、direct task child、executor grandchildのrole bindingとgrant root"
  // observation_boundary = "component-behavior"
  // scope = "whole-root transfer of a coordinator Session tree"
  // lifecycle = "permanent"
  // impact = "正しい三層Session構造を持つrootだけが移管不能になるか、移管後のSessionが旧rootへ取り残される"
  // distinction = "単一Sessionのmove testでは観測できないroot tree全体のdepth再配置と再open後のbinding検証を行う"
  // risk_tags = ["authorization", "irreversible-data-loss"]
  // @end-test-value
  it("overall-coordinator配下のtaskとgrandchildを平坦化して完全移管する", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-root-transfer-tree-"));
    const dbPath = path.join(directory, "db.sqlite");
    let sessions: SessionStorageV6 | null = new SessionStorageV6(dbPath);
    try {
      const source = root("root-source", "overall-coordinator");
      const destination = root("root-destination", "overall-coordinator");
      sessions.insertSession(source);
      sessions.insertSession(destination);
      const task = child("source-task", source, "task-coordinator");
      const executor = child("source-executor", task, "executor");
      sessions.insertSession(task);
      sessions.insertSession(executor);
      const db = new DatabaseSync(dbPath);
      try {
        settleRootWork(db, source.id);
        enlargeDestinationBudget(db, destination.id);
        const move = prepareMove(db, source.id, destination.id);
        db.exec("BEGIN IMMEDIATE");
        const result = applyRootMove(db, { source, destination, descendants: [task, executor],
          sourceProof: move.sourceProof, destinationProof: move.destinationProof, operationId: "root-transfer-tree" });
        db.exec("COMMIT");

        assert.deepEqual(result.affectedSessionIds.slice().sort(), [destination.id, executor.id, source.id, task.id].sort());
        assert.deepEqual(binding(db, source.id), { session_role: "executor", root_session_id: destination.id,
          parent_session_id: destination.id, delegation_depth: 1 });
        assert.deepEqual(binding(db, task.id), { session_role: "task-coordinator", root_session_id: destination.id,
          parent_session_id: destination.id, delegation_depth: 1 });
        assert.deepEqual(binding(db, executor.id), { session_role: "executor", root_session_id: destination.id,
          parent_session_id: task.id, delegation_depth: 2 });
        for (const sessionId of [source.id, task.id, executor.id]) {
          assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM session_authority_grants_v6 WHERE grantee_session_id = ?
            AND root_session_id = ? AND revoked_at IS NULL`).get(sessionId, source.id) as { count: number }).count, 0);
          assert.ok((db.prepare(`SELECT COUNT(*) AS count FROM session_authority_grants_v6 WHERE grantee_session_id = ?
            AND root_session_id = ? AND revoked_at IS NULL`).get(sessionId, destination.id) as { count: number }).count > 0);
          assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM resource_event_headers_v6 WHERE resource_kind = 'session'
            AND resource_id = ? AND resource_revision = 2 AND root_id = ?`).get(sessionId, destination.id) as { count: number }).count, 1);
        }
        verifyResourceBudgetLedger(db);
        verifyResourceHistoryProjections(db);
      } finally { db.close(); }

      sessions.close();
      sessions = null;
      const reopened = new SessionStorageV6(dbPath);
      try {
        assert.deepEqual(reopened.getSession(task.id)?.roleBinding, { sessionRole: "task-coordinator",
          roleContractRevision: 1, rootSessionId: destination.id, parentSessionId: destination.id, delegationDepth: 1 });
        assert.deepEqual(reopened.getSession(executor.id)?.roleBinding, { sessionRole: "executor",
          roleContractRevision: 1, rootSessionId: destination.id, parentSessionId: task.id, delegationDepth: 2 });
      } finally { reopened.close(); }
    } finally {
      sessions?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "destination budget不足のwhole-root移管はSession、Work Item、budget、grantの永続化状態を一切変更せずrollbackできる"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/05-grants-routing-and-transfer.md#Session ownership transfer" }
  // fault = "budget capacity検証の前後でroot移管の一部を保存し、失敗後に複数resourceのownerやrevisionが分岐する"
  // observable = "失敗transaction前後のSession、binding、Work Item、budget account/dimension、grant projection"
  // observation_boundary = "component-behavior"
  // scope = "whole-root transfer transaction rollback"
  // lifecycle = "permanent"
  // impact = "容量不足という通常の拒否でSession treeまたは認可・予算履歴が部分移管され、復旧不能な不整合になる"
  // distinction = "個別storageのcapacity testでは確認できないapplySessionMove全体のtransaction rollback境界を比較する"
  // risk_tags = ["authorization", "billing", "irreversible-data-loss"]
  // @end-test-value
  it("destination budget不足ではroot移管全体をrollbackする", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-root-transfer-rollback-"));
    const dbPath = path.join(directory, "db.sqlite");
    const sessions = new SessionStorageV6(dbPath);
    try {
      const source = root("root-source", "standalone");
      const destination = root("root-destination", "standalone");
      sessions.insertSession(source);
      sessions.insertSession(destination);
      const db = new DatabaseSync(dbPath);
      try {
        settleRootWork(db, source.id);
        const move = prepareMove(db, source.id, destination.id);
        const before = snapshot(db);
        db.exec("BEGIN IMMEDIATE");
        assert.throws(() => applyRootMove(db, { source, destination, descendants: [],
          sourceProof: move.sourceProof, destinationProof: move.destinationProof,
          operationId: "root-transfer-budget-rejected" }),
        (error) => error instanceof ResourceBudgetError && error.code === "BUDGET_HARD_LIMIT_EXCEEDED");
        db.exec("ROLLBACK");
        assert.equal(snapshot(db), before);
        assert.deepEqual(binding(db, source.id), { session_role: "standalone", root_session_id: source.id,
          parent_session_id: null, delegation_depth: 0 });
      } finally { db.close(); }
    } finally {
      sessions.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
