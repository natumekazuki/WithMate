import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { SESSION_AUTHORITY_MAPPING_REVISION, type MutationAuthorityProof } from "../../src/session-authority.js";
import { buildNewSession } from "../../src/session-state.js";
import { SessionStorageV6 } from "../../src-electron/session-storage-v6.js";
import { bootstrapRootResourceBudget } from "../../src-electron/resource-budget-storage.js";
import { DelegationStorage } from "../../src-electron/delegation-storage.js";

const NOW = "2026-09-13T00:00:00.000Z";

function proof(): MutationAuthorityProof {
  return {
    principal: { kind: "user", receiptId: "delegation-storage-test" },
    operation: "delegation.create",
    mappingRevision: SESSION_AUTHORITY_MAPPING_REVISION,
    action: "delegation.create",
    effectClass: "external_side_effect",
    grantId: null,
    grantRevision: null,
    evaluatedAt: NOW,
    resolvedScope: { resourceKind: "session", resourceId: "root-a", rootSessionId: "root-a", ownerKind: "session", ownerId: "root-a", relation: "self" },
  };
}

async function fixture(): Promise<{ dir: string; dbPath: string; storage: DelegationStorage }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "withmate-delegation-storage-"));
  const dbPath = path.join(dir, "db.sqlite");
  const workspacePath = path.join(dir, "workspace");
  const sessions = new SessionStorageV6(dbPath);
  sessions.insertSession({ ...buildNewSession({ id: "root-a", taskTitle: "root", workspaceLabel: "workspace", workspacePath, branch: "main", characterId: "character-a", character: "A", characterIconPath: "", characterThemeColors: { main: "#fff", sub: "#000" }, approvalMode: "never", rootSessionRole: "overall-coordinator" }), updatedAt: NOW });
  sessions.close();
  const db = new DatabaseSync(dbPath);
  bootstrapRootResourceBudget(db, { rootSessionId: "root-a", rootCreatedAt: NOW, createdAt: NOW });
  db.close();
  return { dir, dbPath, storage: new DelegationStorage(dbPath) };
}

function item(index: number, sessionId = "session-a") {
  return { index, sessionId, workItemId: `work-${index}`, executionId: null, createdSession: false, createdWorkItem: false, state: "preparing" as const, pendingStep: "turn", effect: "not_applied" as const, error: null };
}

describe("DelegationStorage", () => {
  // @test-value v2
  // kind = "invariant"
  // claim = "Delegation rowはactor所有とrevision CASを守り、同一timestampの一覧cursorで項目を欠落させず、重複insertをrollbackし、pending入力と他consumer参照を再起動後も保持する"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/04-delegation-transaction.md#Public resource" }
  // fault = "別actor参照、古いrevision更新、同timestamp pagination、重複idempotency、再起動でpending消失、他consumer見落としによりrowまたはbudget消費が不整合になる"
  // observable = "owner/revision例外、一覧ID、unique replay、reopen後のpending input、consumer判定、delegations committed count"
  // observation_boundary = "component-behavior"
  // scope = "delegation-storage-durability"
  // lifecycle = "permanent"
  // @end-test-value
  it("persists ownership, CAS, pagination, replay, pending mutation, and budget count", async () => {
    const f = await fixture();
    try {
      const p = proof();
      const request1 = { idempotencyKey: "k-1", items: [{ target: { kind: "existing", sessionId: "session-a" }, work: { kind: "existing", workItemId: "work-0" } }] };
      const first = f.storage.create({ id: "d-1", actorSessionId: "root-a", idempotencyKey: "k-1", state: "prepared", request: request1, items: [item(0)], recoveryActions: ["retry"], createdAt: NOW, proof: p });
      assert.equal(f.storage.findByIdempotencyKey("root-a", "k-1")?.id, "d-1");
      assert.throws(() => f.storage.create({ id: "d-duplicate", actorSessionId: "root-a", idempotencyKey: "k-1", state: "prepared", request: request1, items: [item(0)], recoveryActions: ["retry"], createdAt: NOW, proof: p }));
      assert.throws(() => f.storage.get("d-1", "other"), /owned/i);
      const updated = f.storage.update({ id: "d-1", actorSessionId: "root-a", expectedRevision: first.revision, items: [item(0)], updatedAt: NOW, pending: { itemIndex: 0, operation: "turn.enqueue", input: { sessionId: "root-a" }, startedAt: NOW }, lastMutation: { operation: "delegation.retry", input: { idempotencyKey: "r-1" }, result: null }, proof: p });
      assert.equal(updated.revision, 2);
      assert.throws(() => f.storage.update({ id: "d-1", actorSessionId: "root-a", expectedRevision: 1, updatedAt: NOW }), /stale/i);
      const internal = f.storage.getInternal("d-1", "root-a");
      assert.equal(internal.pending?.itemIndex, 0);
      assert.equal(internal.lastMutation?.operation, "delegation.retry");
      f.storage.close();
      const reopened = new DelegationStorage(f.dbPath);
      assert.deepEqual(reopened.getInternal("d-1", "root-a").pending?.input, { sessionId: "root-a" });
      assert.equal(reopened.hasOtherConsumer("d-1", "session-a", "work-0"), false);
      const request2 = { idempotencyKey: "k-2", items: [{ target: { kind: "existing", sessionId: "session-a" }, work: { kind: "existing", workItemId: "work-0" } }] };
      reopened.create({ id: "d-2", actorSessionId: "root-a", idempotencyKey: "k-2", state: "prepared", request: request2, items: [item(1)], recoveryActions: ["retry"], createdAt: NOW, proof: p });
      assert.equal(reopened.hasOtherConsumer("d-1", "session-a", "work-0"), true);
      const page = reopened.list("root-a", 1);
      assert.equal(page.items.length, 1);
      assert.ok(page.nextCursor);
      const next = reopened.list("root-a", 1, page.nextCursor);
      assert.deepEqual(next.items.map((entry) => entry.id), ["d-1"]);
      const db = new DatabaseSync(f.dbPath);
      try { assert.equal((db.prepare("SELECT committed FROM resource_budget_dimensions_v6 WHERE account_id = 'root-a' AND dimension = 'delegations'").get() as { committed: number }).committed, 2); } finally { db.close(); }
      reopened.close();
    } finally { try { f.storage.close(); } catch {} await rm(f.dir, { recursive: true, force: true }); }
  });
});
