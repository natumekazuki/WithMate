import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";

import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import { SESSION_AUTHORITY_MAPPING_REVISION, type MutationAuthorityProof } from "../../src/session-authority.js";
import { buildChildSessionRoleBinding } from "../../src/session-role-binding.js";
import { buildNewSession, type Session } from "../../src/session-state.js";
import {
  ResourceBudgetError,
  ResourceBudgetStorage,
  bootstrapRootResourceBudget,
  ensureResourceBudgetSchema,
  verifyResourceBudgetLedger,
} from "../../src-electron/resource-budget-storage.js";
import { SessionStorageV6 } from "../../src-electron/session-storage-v6.js";

const NOW = "2026-09-05T00:00:00.000Z";

function root(id: string): Session {
  return { ...buildNewSession({ id, taskTitle: id, workspaceLabel: "workspace", workspacePath: "C:/workspace",
    branch: "main", characterId: "character", character: "A", characterIconPath: "",
    characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" }, approvalMode: DEFAULT_APPROVAL_MODE,
    rootSessionRole: "overall-coordinator" }), updatedAt: NOW };
}

function proof(sessionId: string, receiptId: string): MutationAuthorityProof {
  return { principal: { kind: "user", receiptId }, operation: "budget.configure", mappingRevision: SESSION_AUTHORITY_MAPPING_REVISION,
    action: "budget.configure", resolvedScope: { resourceKind: "budget", resourceId: sessionId, rootSessionId: sessionId,
      ownerKind: "session", ownerId: sessionId, relation: "self" }, effectClass: "local_mutation", grantId: null,
    grantRevision: null, evaluatedAt: NOW };
}

function child(id: string, parent: Session, role: "task-coordinator" | "executor" = "executor"): Session {
  return { ...buildNewSession({ id, taskTitle: id, workspaceLabel: "workspace", workspacePath: "C:/workspace",
    branch: "main", characterId: "character", character: "A", characterIconPath: "",
    characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" }, approvalMode: DEFAULT_APPROVAL_MODE,
    roleBinding: buildChildSessionRoleBinding(id, parent.id, parent.roleBinding!, role) }), updatedAt: NOW };
}

// @test-value v2
// kind = "invariant"
// claim = "root budget transferはaccount identity、累積storageとconcurrentTurnsの配分合計を保ち、直属allocationをdestinationへ移して孫の親を維持する"
// oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/05-grants-routing-and-transfer.md#Ownership transfer" }
// fault = "source rootをroot accountのまま二重所有にする、storage committedを落とす、またはdirect childと深い子孫のparent関係を壊す"
// observable = "account_kind・root_session_id・parent_account_id、両rootのstorage committed、source hard_limit、ledger verifier結果"
// observation_boundary = "component-behavior"
// scope = "root-budget-transfer"
// lifecycle = "permanent"
// risk_tags = ["billing", "irreversible-data-loss"]
// @end-test-value
it("root全体をbudget account identityと累積storageを保って移管する", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-root-budget-transfer-"));
  const dbPath = path.join(directory, "db.sqlite");
  const sessions = new SessionStorageV6(dbPath);
  const sourceRoot = root("source-root");
  const destinationRoot = root("destination-root");
  sessions.insertSession(sourceRoot);
  sessions.insertSession(destinationRoot);
  const sourceChild = child("source-child", sourceRoot, "task-coordinator");
  const sourceGrandchild = child("source-grandchild", sourceChild);
  sessions.insertSession(sourceChild);
  sessions.insertSession(sourceGrandchild);
  const db = new DatabaseSync(dbPath);
  const budget = new ResourceBudgetStorage(db);
  try {
    bootstrapRootResourceBudget(db, { rootSessionId: sourceRoot.id, rootCreatedAt: NOW, createdAt: NOW });
    bootstrapRootResourceBudget(db, { rootSessionId: destinationRoot.id, rootCreatedAt: NOW, createdAt: NOW });
    budget.allocateChild({ accountId: "source-child", accountKind: "session", rootSessionId: sourceRoot.id,
      ownerSessionId: "source-child", parentAccountId: sourceRoot.id,
      hardLimits: { concurrentTurns: 1, queuedTurns: 0, totalTurns: 0, retries: 0, sessions: 0, workItems: 0, delegations: 0, storageBytes: 0 },
      authorityGrantId: null, authorityGrantRevision: null, expiresAt: null, deadlineAt: "2026-10-01T00:00:00.000Z",
      idempotencyKey: "source-child", proof: proof(sourceRoot.id, "source-allocate"), createdAt: NOW });
    budget.allocateChild({ accountId: "source-grandchild", accountKind: "session", rootSessionId: sourceRoot.id,
      ownerSessionId: "source-grandchild", parentAccountId: "source-child",
      hardLimits: { concurrentTurns: 1, queuedTurns: 0, totalTurns: 0, retries: 0, sessions: 0, workItems: 0, delegations: 0, storageBytes: 0 },
      authorityGrantId: null, authorityGrantRevision: null, expiresAt: null, deadlineAt: "2026-10-01T00:00:00.000Z",
      idempotencyKey: "source-grandchild", proof: proof(sourceRoot.id, "source-allocate-grandchild"), createdAt: NOW });
    const reservation = budget.reserveStorage({ sessionId: sourceRoot.id, bytes: 7, operationId: "source-storage", createdAt: NOW });
    budget.consumeReservation(reservation.reservationId, 7, NOW);
    const sourceAccountId = "source-budget-account";
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("DROP TRIGGER resource_budget_events_no_update_v6");
    db.exec("DROP TRIGGER resource_event_headers_no_update_v6");
    db.prepare("UPDATE resource_budget_dimensions_v6 SET account_id = ? WHERE account_id = ?").run(sourceAccountId, sourceRoot.id);
    db.prepare("UPDATE resource_budget_events_v6 SET account_id = ? WHERE account_id = ?").run(sourceAccountId, sourceRoot.id);
    db.prepare("UPDATE resource_budget_reservations_v6 SET account_id = ? WHERE account_id = ?").run(sourceAccountId, sourceRoot.id);
    db.prepare("UPDATE resource_event_headers_v6 SET resource_id = ? WHERE resource_kind = 'budget' AND resource_id = ?")
      .run(sourceAccountId, sourceRoot.id);
    db.prepare(`UPDATE resource_budget_events_v6 SET projection_json = json_set(projection_json,
      '$.account.account_id', ?, '$.dimensions[0].account_id', ?, '$.dimensions[1].account_id', ?,
      '$.dimensions[2].account_id', ?, '$.dimensions[3].account_id', ?, '$.dimensions[4].account_id', ?,
      '$.dimensions[5].account_id', ?, '$.dimensions[6].account_id', ?, '$.dimensions[7].account_id', ?,
      '$.reservation.account_id', ?, '$.usage.account_id', ?)
      WHERE account_id = ?`).run(sourceAccountId, sourceAccountId, sourceAccountId, sourceAccountId,
        sourceAccountId, sourceAccountId, sourceAccountId, sourceAccountId, sourceAccountId, sourceAccountId, sourceAccountId, sourceAccountId);
    db.prepare("UPDATE resource_budget_accounts_v6 SET account_id = ? WHERE account_id = ?").run(sourceAccountId, sourceRoot.id);
    db.prepare("UPDATE resource_budget_accounts_v6 SET parent_account_id = ? WHERE parent_account_id = ?")
      .run(sourceAccountId, sourceRoot.id);
    ensureResourceBudgetSchema(db);
    db.exec(`CREATE TRIGGER resource_event_headers_no_update_v6
      BEFORE UPDATE ON resource_event_headers_v6 BEGIN
        SELECT RAISE(ABORT, 'resource event headers are append-only');
      END`);
    db.exec("PRAGMA foreign_keys = ON");
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);

    assert.throws(() => budget.transferRootAllocation({ sourceRootSessionId: sourceRoot.id, destinationRootSessionId: destinationRoot.id,
      proof: proof(sourceRoot.id, "source-transfer-rejected"), destinationProof: proof(destinationRoot.id, "destination-transfer-rejected"),
      operationId: "root-transfer-rejected", transferredAt: NOW }), /destination hard limit/);
    assert.equal((db.prepare("SELECT account_kind FROM resource_budget_accounts_v6 WHERE account_id = ?").get(sourceAccountId) as { account_kind: string }).account_kind, "root");

    const destination = budget.get(destinationRoot.id);
    budget.configure({ sessionId: destinationRoot.id, accountId: destinationRoot.id, expectedRevision: destination.revision,
      hardLimits: { concurrentTurns: 10, queuedTurns: 300, totalTurns: 3000, retries: 300,
        sessions: 300, workItems: 1500, delegations: 1500, storageBytes: 2_147_483_648 },
      idempotencyKey: "enlarge-destination" }, proof(destinationRoot.id, "destination-config"), NOW);

    budget.transferRootAllocation({ sourceRootSessionId: sourceRoot.id, destinationRootSessionId: destinationRoot.id,
      proof: proof(sourceRoot.id, "source-transfer"), destinationProof: proof(destinationRoot.id, "destination-transfer"),
      operationId: "root-transfer", transferredAt: NOW });

    const movedSource = db.prepare("SELECT account_kind, root_session_id, parent_account_id FROM resource_budget_accounts_v6 WHERE account_id = ?")
      .get(sourceAccountId) as { account_kind: string; root_session_id: string; parent_account_id: string };
    const movedChild = db.prepare("SELECT root_session_id, parent_account_id FROM resource_budget_accounts_v6 WHERE account_id = 'source-child'")
      .get() as { root_session_id: string; parent_account_id: string };
    const movedGrandchild = db.prepare("SELECT root_session_id, parent_account_id FROM resource_budget_accounts_v6 WHERE account_id = 'source-grandchild'")
      .get() as { root_session_id: string; parent_account_id: string };
    assert.equal(movedSource.account_kind, "session");
    assert.equal(movedSource.root_session_id, destinationRoot.id);
    assert.equal(movedSource.parent_account_id, destinationRoot.id);
    assert.equal(movedChild.root_session_id, destinationRoot.id);
    assert.equal(movedChild.parent_account_id, destinationRoot.id);
    assert.equal(movedGrandchild.root_session_id, destinationRoot.id);
    assert.equal(movedGrandchild.parent_account_id, "source-child");
    assert.equal(budget.getByAccountId(destinationRoot.id).dimensions.storageBytes.committed, 7);
    assert.equal(budget.getByAccountId(sourceAccountId).dimensions.storageBytes.committed, 7);
    assert.equal((db.prepare("SELECT committed, hard_limit FROM resource_budget_dimensions_v6 WHERE account_id = ? AND dimension = 'storageBytes'")
      .get(sourceAccountId) as { committed: number; hard_limit: number }).committed, 0);
    assert.equal((db.prepare("SELECT committed, hard_limit FROM resource_budget_dimensions_v6 WHERE account_id = ? AND dimension = 'storageBytes'")
      .get(sourceAccountId) as { committed: number; hard_limit: number }).hard_limit, 0);
    assert.equal((db.prepare("SELECT hard_limit FROM resource_budget_dimensions_v6 WHERE account_id = ? AND dimension = 'concurrentTurns'")
      .get(sourceAccountId) as { hard_limit: number }).hard_limit, 3);
    verifyResourceBudgetLedger(db);
  } finally {
    budget.close();
    db.close();
    sessions.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "invariant"
// claim = "削除済みSessionのbudget accountは消費履歴を保持したままusable allocationを失効させ、期限切れだけでroot移管を妨げない"
// oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/05-grants-routing-and-transfer.md#Ownership transfer" }
// fault = "tombstone済みSessionのexpired allocationがroot transferを拒否する、または消費済み枠を移管先のusable quotaとして二重計上する"
// observable = "transfer成功、archival accountのrevokedAt・rootSessionId・parentAccountId、消費済みtotalTurns、hardLimit、ledger verifier結果"
// observation_boundary = "component-behavior"
// scope = "root-budget-transfer-deleted-owner"
// lifecycle = "permanent"
// risk_tags = ["billing", "irreversible-data-loss"]
// @end-test-value
it("削除済みSessionのbudget accountを履歴として保持しusable allocationから除外する", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-root-budget-transfer-deleted-"));
  const dbPath = path.join(directory, "db.sqlite");
  const sessions = new SessionStorageV6(dbPath);
  const sourceRoot = root("deleted-source-root");
  const destinationRoot = root("deleted-destination-root");
  sessions.insertSession(sourceRoot);
  sessions.insertSession(destinationRoot);
  const sourceChild = child("deleted-source-child", sourceRoot, "task-coordinator");
  sessions.insertSession(sourceChild);
  const db = new DatabaseSync(dbPath);
  const budget = new ResourceBudgetStorage(db);
  try {
    bootstrapRootResourceBudget(db, { rootSessionId: sourceRoot.id, rootCreatedAt: NOW, createdAt: NOW });
    bootstrapRootResourceBudget(db, { rootSessionId: destinationRoot.id, rootCreatedAt: NOW, createdAt: NOW });
    const destination = budget.get(destinationRoot.id);
    budget.configure({ sessionId: destinationRoot.id, accountId: destinationRoot.id, expectedRevision: destination.revision,
      hardLimits: { concurrentTurns: 10, queuedTurns: 300, totalTurns: 3000, retries: 300,
        sessions: 300, workItems: 1500, delegations: 1500, storageBytes: 2_147_483_648 },
      idempotencyKey: "deleted-enlarge-destination" }, proof(destinationRoot.id, "deleted-destination-config"), NOW);
    budget.allocateChild({ accountId: sourceChild.id, accountKind: "session", rootSessionId: sourceRoot.id,
      ownerSessionId: sourceChild.id, parentAccountId: sourceRoot.id,
      hardLimits: { concurrentTurns: 1, queuedTurns: 2, totalTurns: 3, retries: 2, sessions: 2, workItems: 2, delegations: 2, storageBytes: 0 },
      authorityGrantId: null, authorityGrantRevision: null, expiresAt: "2026-09-06T00:00:00.000Z", deadlineAt: "2026-10-01T00:00:00.000Z",
      idempotencyKey: "deleted-child", proof: proof(sourceRoot.id, "deleted-allocate"), createdAt: NOW });
    budget.consumeCount({ sessionId: sourceChild.id, dimension: "totalTurns", idempotencyKey: "deleted-consume", consumedAt: NOW });
    sessions.deleteSession(sourceChild.id);
    const transferredAt = "2026-09-07T00:00:00.000Z";

    budget.transferRootAllocation({ sourceRootSessionId: sourceRoot.id, destinationRootSessionId: destinationRoot.id,
      proof: proof(sourceRoot.id, "deleted-transfer-source"), destinationProof: proof(destinationRoot.id, "deleted-transfer-destination"),
      operationId: "deleted-root-transfer", transferredAt });

    const moved = db.prepare(`SELECT root_session_id, parent_account_id, revoked_at
      FROM resource_budget_accounts_v6 WHERE account_id = ?`).get(sourceChild.id) as
      { root_session_id: string; parent_account_id: string; revoked_at: string | null };
    assert.deepEqual({ ...moved }, { root_session_id: destinationRoot.id, parent_account_id: sourceRoot.id, revoked_at: transferredAt });
    const dimension = db.prepare(`SELECT hard_limit, committed FROM resource_budget_dimensions_v6
      WHERE account_id = ? AND dimension = 'totalTurns'`).get(sourceChild.id) as { hard_limit: number; committed: number };
    assert.deepEqual({ ...dimension }, { hard_limit: 0, committed: 1 });
    assert.equal(budget.getByAccountId(sourceRoot.id).dimensions.totalTurns.available, 999);
    assert.equal(budget.getByAccountId(sourceChild.id).dimensions.totalTurns.available, 0);
    const destinationAfter = budget.getByAccountId(destinationRoot.id);
    assert.equal(destinationAfter.dimensions.totalTurns.allocatedToChildren, 1000);
    assert.equal(destinationAfter.dimensions.totalTurns.available, 2000);
    const archivedDimensions = db.prepare("SELECT dimension, hard_limit FROM resource_budget_dimensions_v6 WHERE account_id = ?")
      .all(sourceChild.id) as Array<{ dimension: string; hard_limit: number }>;
    assert.equal(archivedDimensions.length, 8);
    for (const dimension of archivedDimensions) {
      assert.equal(dimension.hard_limit, 0, dimension.dimension);
    }
    assert.equal((db.prepare("SELECT expires_at FROM resource_budget_accounts_v6 WHERE account_id = ?")
      .get(sourceChild.id) as { expires_at: string }).expires_at, "2026-09-06T00:00:00.000Z");
    assert.throws(() => budget.consumeCount({ sessionId: sourceChild.id, dimension: "totalTurns",
      idempotencyKey: "deleted-reuse", consumedAt: transferredAt }),
      (error: unknown) => error instanceof ResourceBudgetError && error.code === "BUDGET_AUTHORITY_REQUIRED");
    assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM resource_budget_events_v6
      WHERE account_id = ? AND event_kind = 'consumed'`).get(sourceChild.id) as { count: number }).count, 1);
    verifyResourceBudgetLedger(db);
  } finally {
    budget.close();
    db.close();
    sessions.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "security"
// claim = "削除済みSessionのbudget account配下にlive descendantがある場合、親をrevoked化したまま移管しない"
// oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/05-grants-routing-and-transfer.md#Ownership transfer" }
// fault = "tombstone済み親accountを移管してlive descendantのbudget authorityを暗黙に失効させる"
// observable = "明示的なtransfer拒否コードとsource account hierarchyの不変性"
// observation_boundary = "component-behavior"
// scope = "root-budget-transfer-live-descendant-under-deleted-parent"
// lifecycle = "permanent"
// risk_tags = ["authorization", "irreversible-data-loss"]
// @end-test-value
it("削除済み親Session配下のlive budget descendantを暗黙失効させない", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-root-budget-transfer-live-descendant-"));
  const dbPath = path.join(directory, "db.sqlite");
  const sessions = new SessionStorageV6(dbPath);
  const sourceRoot = root("live-descendant-source-root");
  const destinationRoot = root("live-descendant-destination-root");
  sessions.insertSession(sourceRoot);
  sessions.insertSession(destinationRoot);
  const deletedParent = child("live-descendant-deleted-parent", sourceRoot, "task-coordinator");
  const liveDescendant = child("live-descendant-live-child", deletedParent);
  sessions.insertSession(deletedParent);
  sessions.insertSession(liveDescendant);
  const db = new DatabaseSync(dbPath);
  const budget = new ResourceBudgetStorage(db);
  try {
    bootstrapRootResourceBudget(db, { rootSessionId: sourceRoot.id, rootCreatedAt: NOW, createdAt: NOW });
    bootstrapRootResourceBudget(db, { rootSessionId: destinationRoot.id, rootCreatedAt: NOW, createdAt: NOW });
    const destination = budget.get(destinationRoot.id);
    budget.configure({ sessionId: destinationRoot.id, accountId: destinationRoot.id, expectedRevision: destination.revision,
      hardLimits: { concurrentTurns: 10, queuedTurns: 300, totalTurns: 3000, retries: 300,
        sessions: 300, workItems: 1500, delegations: 1500, storageBytes: 2_147_483_648 },
      idempotencyKey: "live-descendant-enlarge-destination" }, proof(destinationRoot.id, "live-descendant-destination-config"), NOW);
    for (const [accountId, ownerSessionId, parentAccountId, idempotencyKey] of [
      [deletedParent.id, deletedParent.id, sourceRoot.id, "live-descendant-parent"],
      [liveDescendant.id, liveDescendant.id, deletedParent.id, "live-descendant-child"],
    ] as const) {
      budget.allocateChild({ accountId, accountKind: "session", rootSessionId: sourceRoot.id,
        ownerSessionId, parentAccountId,
        hardLimits: { concurrentTurns: 0, queuedTurns: 0, totalTurns: 1, retries: 0, sessions: 0, workItems: 0, delegations: 0, storageBytes: 0 },
        authorityGrantId: null, authorityGrantRevision: null, expiresAt: null, deadlineAt: "2026-10-01T00:00:00.000Z",
        idempotencyKey, proof: proof(sourceRoot.id, `${idempotencyKey}-proof`), createdAt: NOW });
    }
    sessions.deleteSession(deletedParent.id);
    const beforeLiveAccount = db.prepare("SELECT * FROM resource_budget_accounts_v6 WHERE account_id = ?").get(liveDescendant.id);
    const beforeLiveDimensions = db.prepare("SELECT * FROM resource_budget_dimensions_v6 WHERE account_id = ? ORDER BY dimension").all(liveDescendant.id);
    assert.throws(() => budget.transferRootAllocation({ sourceRootSessionId: sourceRoot.id, destinationRootSessionId: destinationRoot.id,
      proof: proof(sourceRoot.id, "live-descendant-transfer-source"), destinationProof: proof(destinationRoot.id, "live-descendant-transfer-destination"),
      operationId: "live-descendant-transfer", transferredAt: "2026-09-07T00:00:00.000Z" }),
      (error: unknown) => error instanceof ResourceBudgetError && error.code === "BUDGET_SETTLEMENT_CONFLICT");
    assert.deepEqual({ ...(db.prepare(`SELECT root_session_id, parent_account_id, revoked_at
      FROM resource_budget_accounts_v6 WHERE account_id = ?`).get(deletedParent.id) as Record<string, unknown>) },
      { root_session_id: sourceRoot.id, parent_account_id: sourceRoot.id, revoked_at: null });
    assert.equal((db.prepare(`SELECT root_session_id FROM resource_budget_accounts_v6 WHERE account_id = ?`)
      .get(liveDescendant.id) as { root_session_id: string }).root_session_id, sourceRoot.id);
    assert.deepEqual(db.prepare("SELECT * FROM resource_budget_accounts_v6 WHERE account_id = ?").get(liveDescendant.id), beforeLiveAccount);
    assert.deepEqual(db.prepare("SELECT * FROM resource_budget_dimensions_v6 WHERE account_id = ? ORDER BY dimension").all(liveDescendant.id), beforeLiveDimensions);
  } finally {
    budget.close();
    db.close();
    sessions.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "security"
// claim = "revokedな子budget allocationをroot transferでdestination authorityへ付け替えて復活させない"
// oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/05-grants-routing-and-transfer.md#Ownership transfer" }
// fault = "revokedなsource child accountを移管後にactive allocationとして再利用する"
// observable = "transfer拒否コード、source root/childのroot_session_idとparent_account_id、childのrevoked_at"
// observation_boundary = "component-behavior"
// scope = "root-budget-transfer-inactive-allocation"
// lifecycle = "permanent"
// risk_tags = ["authorization"]
// @end-test-value
it("inactive child allocationのauthority復活を拒否する", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-root-budget-transfer-inactive-"));
  const dbPath = path.join(directory, "db.sqlite");
  const sessions = new SessionStorageV6(dbPath);
  const sourceRoot = root("inactive-source-root");
  const destinationRoot = root("inactive-destination-root");
  sessions.insertSession(sourceRoot);
  sessions.insertSession(destinationRoot);
  const sourceChild = child("inactive-source-child", sourceRoot, "task-coordinator");
  sessions.insertSession(sourceChild);
  const db = new DatabaseSync(dbPath);
  const budget = new ResourceBudgetStorage(db);
  try {
    bootstrapRootResourceBudget(db, { rootSessionId: sourceRoot.id, rootCreatedAt: NOW, createdAt: NOW });
    bootstrapRootResourceBudget(db, { rootSessionId: destinationRoot.id, rootCreatedAt: NOW, createdAt: NOW });
    budget.allocateChild({ accountId: sourceChild.id, accountKind: "session", rootSessionId: sourceRoot.id,
      ownerSessionId: sourceChild.id, parentAccountId: sourceRoot.id,
      hardLimits: { concurrentTurns: 1, queuedTurns: 0, totalTurns: 0, retries: 0, sessions: 0, workItems: 0, delegations: 0, storageBytes: 0 },
      authorityGrantId: null, authorityGrantRevision: null, expiresAt: null, deadlineAt: "2026-10-01T00:00:00.000Z",
      idempotencyKey: "inactive-child", proof: proof(sourceRoot.id, "inactive-allocate"), createdAt: NOW });
    const childBudget = budget.getByAccountId(sourceChild.id);
    budget.configure({ sessionId: sourceChild.id, accountId: sourceChild.id, expectedRevision: childBudget.revision,
      revoked: true, idempotencyKey: "revoke-inactive-child" }, proof(sourceChild.id, "inactive-revoke"), NOW);
    assert.throws(() => budget.transferRootAllocation({ sourceRootSessionId: sourceRoot.id,
      destinationRootSessionId: destinationRoot.id, proof: proof(sourceRoot.id, "inactive-transfer-source"),
      destinationProof: proof(destinationRoot.id, "inactive-transfer-destination"), operationId: "inactive-transfer", transferredAt: NOW }),
      (error: unknown) => error instanceof ResourceBudgetError && error.code === "BUDGET_AUTHORITY_REQUIRED");
    const sourceState = db.prepare("SELECT root_session_id, parent_account_id FROM resource_budget_accounts_v6 WHERE account_id = ?")
      .get(sourceRoot.id) as { root_session_id: string; parent_account_id: string | null };
    assert.equal(sourceState.root_session_id, sourceRoot.id);
    assert.equal(sourceState.parent_account_id, null);
    assert.equal((db.prepare("SELECT root_session_id FROM resource_budget_accounts_v6 WHERE account_id = ?").get(sourceChild.id) as { root_session_id: string }).root_session_id, sourceRoot.id);
    assert.deepEqual({ ...db.prepare("SELECT parent_account_id, revoked_at FROM resource_budget_accounts_v6 WHERE account_id = ?").get(sourceChild.id) },
      { parent_account_id: sourceRoot.id, revoked_at: NOW });
  } finally {
    budget.close();
    db.close();
    sessions.close();
    await rm(directory, { recursive: true, force: true });
  }
});
