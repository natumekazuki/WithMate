import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import { buildChildSessionRoleBinding } from "../../src/session-role-binding.js";
import { buildNewSession, type Session } from "../../src/session-state.js";
import { SessionAuthorityService } from "../../src-electron/session-authority-service.js";
import { SessionStorageV6 } from "../../src-electron/session-storage-v6.js";
import { applySessionMove } from "../../src-electron/session-lifecycle-move.js";
import { issueTrustedCrossRootTransferCapability, listActiveSessionAuthorityGrants } from "../../src-electron/session-authority-storage.js";
import { ResourceBudgetStorage, bootstrapRootResourceBudget } from "../../src-electron/resource-budget-storage.js";
import { RESOURCE_BUDGET_DIMENSIONS } from "../../src/resource-budget.js";
import { ensureV6Schema } from "../../src-electron/database-schema-v6.js";
import { verifyResourceHistoryProjections } from "../../src-electron/resource-history-schema.js";
import { SessionCrudError } from "../../src-electron/session-crud-service.js";

const NOW = "2026-09-05T12:00:00.000Z";

function root(id: string): Session {
  return { ...buildNewSession({ id, taskTitle: id, workspaceLabel: "workspace", workspacePath: "C:/workspace",
    branch: "main", characterId: "character-a", character: "A", characterIconPath: "",
    characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" }, approvalMode: DEFAULT_APPROVAL_MODE,
    rootSessionRole: "overall-coordinator" }), updatedAt: NOW };
}

function child(id: string, parent: Session, role: "task-coordinator" | "executor"): Session {
  return { ...buildNewSession({ id, taskTitle: id, workspaceLabel: "workspace", workspacePath: "C:/workspace",
    branch: "main", characterId: "character-a", character: "A", characterIconPath: "",
    characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" }, approvalMode: DEFAULT_APPROVAL_MODE,
    roleBinding: buildChildSessionRoleBinding(id, parent.id, parent.roleBinding!, role) }), updatedAt: NOW };
}

function runtimeBinding(sessionId: string) {
  return { bindingId: `binding-${sessionId}`, bindingIdHash: `hash-${sessionId}`, actorSessionId: sessionId,
    providerId: "codex", executionGeneration: "generation-1", authoritySnapshot: {},
    operationGrants: ["session.runtime.invoke"], createdAt: NOW, expiresAt: null } as const;
}

function provisionMoveGrant(db: DatabaseSync, rootSessionId: string, destinationRootSessionId = rootSessionId) {
  return issueTrustedCrossRootTransferCapability(db, {
    sourceActorSessionId: rootSessionId,
    destinationRootSessionId,
    destinationTargetRoles: ["task-coordinator", "executor"],
    principal: { kind: "system", service: "session-move-test" },
    proof: {
      principal: { kind: "system", service: "session-move-test" }, providerId: null,
      operation: "session.move", mappingRevision: 2, action: "session.move", effectClass: "local_mutation",
      grantId: null, grantRevision: null,
      resolvedScope: { resourceKind: "session", resourceId: null, rootSessionId: destinationRootSessionId, ownerKind: "session", ownerId: destinationRootSessionId, relation: "root_owner" },
      evaluatedAt: NOW,
    },
    expiresAt: null, issuedAt: NOW,
  });
}

function moveProof(actorSessionId: string, grant: { grantId: string; revision: number }, scopeRootSessionId = actorSessionId) {
  return { principal: { kind: "agent" as const, agent: "session-runtime" as const, actorSessionId, runtimeGeneration: "generation-1" },
    providerId: "internal", operation: "session.move" as const, mappingRevision: 2, action: "session.move" as const,
    resolvedScope: { resourceKind: "session" as const, resourceId: null, rootSessionId: scopeRootSessionId, ownerKind: "session" as const, ownerId: scopeRootSessionId, relation: "root_owner" as const },
    effectClass: "local_mutation" as const, grantId: grant.grantId, grantRevision: grant.revision, evaluatedAt: NOW };
}

async function setup() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-move-"));
  const dbPath = path.join(directory, "db.sqlite");
  const storage = new SessionStorageV6(dbPath);
  const sourceRoot = root("root-a");
  const destinationRoot = root("root-b");
  const destinationParent = child("task-a", sourceRoot, "task-coordinator");
  const target = child("executor-a", sourceRoot, "executor");
  storage.insertSession(sourceRoot);
  storage.insertSession(destinationRoot);
  storage.insertSession(destinationParent);
  storage.insertSession(target);
  return { directory, dbPath, storage, sourceRoot, destinationRoot, destinationParent, target };
}

describe("Session lifecycle move", () => {
  // @test-value v2
  // kind = "invariant"
  // claim = "same-root reparentは親とdepthを変更しSession revisionを更新する"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/01-session-lifecycle.md#Move、adopt、reuse" }
  // fault = "親変更後も旧parent/root/depthまたはrevisionが残る"
  // observable = "更新後のbindingとSession revision"
  // observation_boundary = "component-behavior"
  // scope = "session-lifecycle-move"
  // lifecycle = "permanent"
  // risk_tags = ["authorization"]
  // @end-test-value
  it("same-root reparentを適用する", async () => {
    const ctx = await setup();
    const service = new SessionAuthorityService({ databasePath: ctx.dbPath, getExecutionGeneration: () => "generation-1", now: () => new Date(NOW) });
    try {
      const provisioningDb = new DatabaseSync(ctx.dbPath); const grant = provisionMoveGrant(provisioningDb, ctx.sourceRoot.id)[0]; provisioningDb.close();
      const input = { sessionId: ctx.target.id, expectedRevision: 1, kind: "same_root" as const,
        destinationParentSessionId: ctx.destinationParent.id, destinationExpectedRevision: 1 };
      const proof = moveProof(ctx.sourceRoot.id, grant);
      const db = new DatabaseSync(ctx.dbPath);
      try {
        const result = applySessionMove(db, input, proof, NOW, "move-same-root");
        assert.equal(result.revisions[ctx.target.id], 2);
        assert.equal((db.prepare("SELECT resource_revision FROM sessions_v6 WHERE id = ?")
          .get(ctx.target.id) as { resource_revision: number }).resource_revision, 2);
        const binding = db.prepare("SELECT root_session_id, parent_session_id, delegation_depth FROM session_role_bindings_v6 WHERE session_id = ?")
          .get(ctx.target.id) as { root_session_id: string; parent_session_id: string; delegation_depth: number };
        assert.equal(binding.root_session_id, ctx.sourceRoot.id);
        assert.equal(binding.parent_session_id, ctx.destinationParent.id);
        assert.equal(binding.delegation_depth, 2);
      } finally { db.close(); }
    } finally { service.close(); ctx.storage.close(); await rm(ctx.directory, { recursive: true, force: true }); }
  });

  // @test-value v2
  // kind = "security"
  // claim = "same-root moveはdestination parentのrole contractに従い、executor配下へのchild配置をmutation前に拒否する"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/01-session-lifecycle.md#Move、adopt、reuse" }
  // fault = "executorを親にした不許可roleのmoveを受理してbindingとrevisionを部分更新する"
  // observable = "SESSION_STATE_CONFLICT、source/destination binding、両Session revision"
  // observation_boundary = "component-behavior"
  // scope = "session-lifecycle-move role parent admission"
  // lifecycle = "permanent"
  // risk_tags = ["authorization"]
  // @end-test-value
  it("executor parentへの不許可role moveを拒否する", async () => {
    const ctx = await setup();
    const service = new SessionAuthorityService({ databasePath: ctx.dbPath, getExecutionGeneration: () => "generation-1", now: () => new Date(NOW) });
    try {
      const provisioningDb = new DatabaseSync(ctx.dbPath); const grant = provisionMoveGrant(provisioningDb, ctx.sourceRoot.id)[0]; provisioningDb.close();
      const input = { sessionId: ctx.destinationParent.id, expectedRevision: 1, kind: "same_root" as const,
        destinationParentSessionId: ctx.target.id, destinationExpectedRevision: 1 };
      const proof = moveProof(ctx.sourceRoot.id, grant);
      const db = new DatabaseSync(ctx.dbPath);
      try {
        assert.throws(() => applySessionMove(db, input, proof, NOW, "move-forbidden-parent"), (error) => error instanceof SessionCrudError && error.code === "SESSION_STATE_CONFLICT");
        const sourceBinding = db.prepare("SELECT parent_session_id, delegation_depth FROM session_role_bindings_v6 WHERE session_id = ?").get(ctx.destinationParent.id) as { parent_session_id: string | null; delegation_depth: number };
        const parentBinding = db.prepare("SELECT parent_session_id, delegation_depth FROM session_role_bindings_v6 WHERE session_id = ?").get(ctx.target.id) as { parent_session_id: string | null; delegation_depth: number };
        assert.equal(sourceBinding.parent_session_id, ctx.sourceRoot.id);
        assert.equal(sourceBinding.delegation_depth, 1);
        assert.equal(parentBinding.parent_session_id, ctx.sourceRoot.id);
        assert.equal(parentBinding.delegation_depth, 1);
        assert.equal((db.prepare("SELECT resource_revision FROM sessions_v6 WHERE id = ?").get(ctx.destinationParent.id) as { resource_revision: number }).resource_revision, 1);
        assert.equal((db.prepare("SELECT resource_revision FROM sessions_v6 WHERE id = ?").get(ctx.target.id) as { resource_revision: number }).resource_revision, 1);
      } finally { db.close(); }
    } finally { service.close(); ctx.storage.close(); await rm(ctx.directory, { recursive: true, force: true }); }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "destination revisionがstaleなsame-root moveはprojectionを変更せず拒否する"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/01-session-lifecycle.md#Move、adopt、reuse" }
  // fault = "古いdestination revisionでparent変更を適用する"
  // observable = "SESSION_STATE_CONFLICTとtarget binding"
  // observation_boundary = "component-behavior"
  // scope = "session-lifecycle-move"
  // lifecycle = "permanent"
  // risk_tags = ["authorization"]
  // @end-test-value
  it("stale destination revisionを拒否する", async () => {
    const ctx = await setup();
    const service = new SessionAuthorityService({ databasePath: ctx.dbPath, getExecutionGeneration: () => "generation-1", now: () => new Date(NOW) });
    try {
      const provisioningDb = new DatabaseSync(ctx.dbPath); const grant = provisionMoveGrant(provisioningDb, ctx.sourceRoot.id)[0]; provisioningDb.close();
      const proof = moveProof(ctx.sourceRoot.id, grant);
      const db = new DatabaseSync(ctx.dbPath);
      try {
        const input = { sessionId: ctx.target.id, expectedRevision: 1, kind: "same_root" as const,
          destinationParentSessionId: ctx.destinationParent.id, destinationExpectedRevision: 99 };
        assert.throws(() => applySessionMove(db, input, proof, NOW, "move-stale-destination"), (error) => error instanceof SessionCrudError && error.code === "SESSION_STATE_CONFLICT");
        const row = db.prepare("SELECT parent_session_id, delegation_depth FROM session_role_bindings_v6 WHERE session_id = ?")
          .get(ctx.target.id) as { parent_session_id: string | null; delegation_depth: number };
        assert.equal(row.parent_session_id, ctx.sourceRoot.id);
        assert.equal(row.delegation_depth, 1);
        assert.equal((db.prepare("SELECT resource_revision FROM sessions_v6 WHERE id = ?")
          .get(ctx.target.id) as { resource_revision: number }).resource_revision, 1);
      } finally { db.close(); }
    } finally { service.close(); ctx.storage.close(); await rm(ctx.directory, { recursive: true, force: true }); }
  });

  // @test-value v2
  // kind = "security"
  // claim = "same-root moveはsubtree内parentを拒否する"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/01-session-lifecycle.md#Move、adopt、reuse" }
  // fault = "cycleを作るparent変更が許可される"
  // observable = "applySessionMoveの拒否結果"
  // observation_boundary = "component-behavior"
  // scope = "session-lifecycle-move"
  // lifecycle = "permanent"
  // risk_tags = ["authorization"]
  // @end-test-value
  it("subtree cycleを拒否する", async () => {
    const ctx = await setup();
    const service = new SessionAuthorityService({ databasePath: ctx.dbPath, getExecutionGeneration: () => "generation-1", now: () => new Date(NOW) });
    try {
      const provisioningDb = new DatabaseSync(ctx.dbPath); const grant = provisionMoveGrant(provisioningDb, ctx.sourceRoot.id)[0]; provisioningDb.close();
      const input = { sessionId: ctx.target.id, expectedRevision: 1, kind: "same_root" as const,
        destinationParentSessionId: ctx.target.id, destinationExpectedRevision: 1 };
      const proof = moveProof(ctx.sourceRoot.id, grant);
      const db = new DatabaseSync(ctx.dbPath);
      try {
        assert.throws(() => applySessionMove(db, input, proof, NOW, "move-cycle"), (error) => error instanceof SessionCrudError && error.code === "SESSION_STATE_CONFLICT");
        const binding = db.prepare("SELECT root_session_id, parent_session_id, delegation_depth FROM session_role_bindings_v6 WHERE session_id = ?")
          .get(ctx.target.id) as { root_session_id: string; parent_session_id: string | null; delegation_depth: number };
        assert.equal(binding.root_session_id, ctx.sourceRoot.id);
        assert.equal(binding.parent_session_id, ctx.sourceRoot.id);
        assert.equal(binding.delegation_depth, 1);
        assert.equal((db.prepare("SELECT resource_revision FROM sessions_v6 WHERE id = ?")
          .get(ctx.target.id) as { resource_revision: number }).resource_revision, 1);
      }
      finally { db.close(); }
    } finally { service.close(); ctx.storage.close(); await rm(ctx.directory, { recursive: true, force: true }); }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "runningのSession turnがあるsubtreeは移動できない"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/01-session-lifecycle.md#Move、adopt、reuse" }
  // fault = "実行中turnのSessionをreparentして実行状態とtopologyの整合性を壊す"
  // observable = "applySessionMoveの拒否結果"
  // observation_boundary = "component-behavior"
  // scope = "session-lifecycle-move"
  // lifecycle = "permanent"
  // risk_tags = ["authorization"]
  // @end-test-value
  it("running turnを拒否する", async () => {
    const ctx = await setup();
    const service = new SessionAuthorityService({ databasePath: ctx.dbPath, getExecutionGeneration: () => "generation-1", now: () => new Date(NOW) });
    try {
      const provisioningDb = new DatabaseSync(ctx.dbPath); const grant = provisionMoveGrant(provisioningDb, ctx.sourceRoot.id)[0]; provisioningDb.close();
      const input = { sessionId: ctx.target.id, expectedRevision: 1, kind: "same_root" as const,
        destinationParentSessionId: ctx.destinationParent.id, destinationExpectedRevision: 1 };
      const proof = moveProof(ctx.sourceRoot.id, grant);
      const db = new DatabaseSync(ctx.dbPath);
      try {
        db.prepare(`INSERT INTO session_turns_v6
          (session_id, phase, provider_id, model_id, reasoning_effort, approval_mode, sandbox_mode, thread_id, started_at, updated_at)
          VALUES (?, 'running', '', '', '', '', '', '', ?, ?)`)
          .run(ctx.target.id, NOW, NOW);
        assert.throws(() => applySessionMove(db, input, proof, NOW, "move-running"), (error) => error instanceof SessionCrudError && error.code === "SESSION_STATE_CONFLICT");
        const binding = db.prepare("SELECT root_session_id, parent_session_id, delegation_depth FROM session_role_bindings_v6 WHERE session_id = ?")
          .get(ctx.target.id) as { root_session_id: string; parent_session_id: string | null; delegation_depth: number };
        assert.equal(binding.root_session_id, ctx.sourceRoot.id);
        assert.equal(binding.parent_session_id, ctx.sourceRoot.id);
        assert.equal(binding.delegation_depth, 1);
        assert.equal((db.prepare("SELECT resource_revision FROM sessions_v6 WHERE id = ?")
          .get(ctx.target.id) as { resource_revision: number }).resource_revision, 1);
      } finally { db.close(); }
    } finally { service.close(); ctx.storage.close(); await rm(ctx.directory, { recursive: true, force: true }); }
  });

  // @test-value v2
  // kind = "security"
  // claim = "cross-root moveはdestination proofなしで許可されない"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/01-session-lifecycle.md#Move、adopt、reuse" }
  // fault = "source actorが任意destinationへproofなしでSessionを移動する"
  // observable = "applySessionMoveの拒否結果"
  // observation_boundary = "component-behavior"
  // scope = "session-lifecycle-move"
  // lifecycle = "permanent"
  // risk_tags = ["authorization"]
  // @end-test-value
  it("cross-root destination proofなしを拒否する", async () => {
    const ctx = await setup();
    const service = new SessionAuthorityService({ databasePath: ctx.dbPath, getExecutionGeneration: () => "generation-1", now: () => new Date(NOW) });
    try {
      const provisioningDb = new DatabaseSync(ctx.dbPath); const grant = provisionMoveGrant(provisioningDb, ctx.sourceRoot.id)[0]; provisioningDb.close();
      const proof = moveProof(ctx.sourceRoot.id, grant);
      const db = new DatabaseSync(ctx.dbPath);
      try {
        const input = { sessionId: ctx.target.id, expectedRevision: 1, kind: "cross_root" as const,
          destinationRootSessionId: ctx.destinationRoot.id, destinationParentSessionId: ctx.destinationRoot.id,
          destinationExpectedRevision: 1, transferManifestRevision: 1, transferPolicy: "full" as const };
        const before = db.prepare("SELECT root_session_id, parent_session_id, delegation_depth FROM session_role_bindings_v6 WHERE session_id = ?")
          .get(ctx.target.id) as { root_session_id: string; parent_session_id: string | null; delegation_depth: number };
        assert.throws(() => applySessionMove(db, input, proof, NOW, "move-cross-root-no-destination-proof"),
          (error) => error instanceof SessionCrudError && error.code === "SESSION_STATE_CONFLICT");
        const after = db.prepare("SELECT root_session_id, parent_session_id, delegation_depth FROM session_role_bindings_v6 WHERE session_id = ?")
          .get(ctx.target.id) as typeof before;
        assert.deepEqual(after, before);
      } finally { db.close(); }
    } finally { service.close(); ctx.storage.close(); await rm(ctx.directory, { recursive: true, force: true }); }
  });

  // @test-value v2
  // kind = "security"
  // claim = "cross-root child moveは同一actual actorのsource/destination grantを照合し、移動後grantのroot帰属を更新する"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/01-session-lifecycle.md#Move、adopt、reuse" }
  // fault = "destination root自身をactorにしたproofまたはsource側だけのgrantで移動を許可する"
  // observable = "移動後bindingとtarget Sessionのactive grant root"
  // observation_boundary = "component-behavior"
  // scope = "session-lifecycle-cross-root-move"
  // lifecycle = "permanent"
  // risk_tags = ["authorization"]
  // @end-test-value
  it("同一actual actorのcross-root grantでchildを移動する", async () => {
    const ctx = await setup();
    const service = new SessionAuthorityService({ databasePath: ctx.dbPath, getExecutionGeneration: () => "generation-1", now: () => new Date(NOW) });
    try {
      const db = new DatabaseSync(ctx.dbPath);
      try {
        bootstrapRootResourceBudget(db, { rootSessionId: ctx.sourceRoot.id, rootCreatedAt: NOW, createdAt: NOW });
        bootstrapRootResourceBudget(db, { rootSessionId: ctx.destinationRoot.id, rootCreatedAt: NOW, createdAt: NOW });
        const sourceGrant = provisionMoveGrant(db, ctx.sourceRoot.id)[0];
        const destinationGrant = provisionMoveGrant(db, ctx.sourceRoot.id, ctx.destinationRoot.id)[0];
        const differentActorGrant = provisionMoveGrant(db, ctx.destinationRoot.id, ctx.destinationRoot.id)[0];
        const proof = moveProof(ctx.sourceRoot.id, sourceGrant);
        const destinationProof = moveProof(ctx.sourceRoot.id, destinationGrant, ctx.destinationRoot.id);
        const beforeBinding = db.prepare("SELECT root_session_id, parent_session_id, delegation_depth FROM session_role_bindings_v6 WHERE session_id = ?")
          .get(ctx.target.id) as { root_session_id: string; parent_session_id: string | null; delegation_depth: number };
        const beforeRevision = (db.prepare("SELECT resource_revision FROM sessions_v6 WHERE id = ?")
          .get(ctx.target.id) as { resource_revision: number }).resource_revision;
        const beforeGrants = listActiveSessionAuthorityGrants(db, ctx.target.id, new Date(NOW));
        assert.throws(() => applySessionMove(db, { sessionId: ctx.target.id, expectedRevision: 1, kind: "cross_root" as const,
          destinationRootSessionId: ctx.destinationRoot.id, destinationParentSessionId: ctx.destinationRoot.id,
          destinationExpectedRevision: 1, transferManifestRevision: 1, transferPolicy: "full" as const,
          destinationProof: moveProof(ctx.destinationRoot.id, differentActorGrant, ctx.destinationRoot.id) },
          proof, NOW, "move-cross-root-wrong-actor"), /same actor/i);
        assert.deepEqual(db.prepare("SELECT root_session_id, parent_session_id, delegation_depth FROM session_role_bindings_v6 WHERE session_id = ?")
          .get(ctx.target.id), beforeBinding);
        assert.equal((db.prepare("SELECT resource_revision FROM sessions_v6 WHERE id = ?")
          .get(ctx.target.id) as { resource_revision: number }).resource_revision, beforeRevision);
        const budget = new ResourceBudgetStorage(db);
        const budgetProof = service.authorize(runtimeBinding(ctx.sourceRoot.id), "budget.configure", { sessionId: ctx.sourceRoot.id }).proof;
        budget.allocateChild({ accountId: "budget-executor-a", accountKind: "session", rootSessionId: ctx.sourceRoot.id,
          ownerSessionId: ctx.target.id, parentAccountId: ctx.sourceRoot.id,
          hardLimits: Object.fromEntries(RESOURCE_BUDGET_DIMENSIONS.map((dimension) => [dimension, dimension === "storageBytes" ? 0 : 2])),
          authorityGrantId: budgetProof.grantId, authorityGrantRevision: budgetProof.grantRevision, expiresAt: null,
          deadlineAt: "2026-10-01T00:00:00.000Z", idempotencyKey: "allocate-cross-root-target", proof: budgetProof, createdAt: NOW });
        const input = { sessionId: ctx.target.id, expectedRevision: 1, kind: "cross_root" as const,
          destinationRootSessionId: ctx.destinationRoot.id, destinationParentSessionId: ctx.destinationRoot.id,
          destinationExpectedRevision: 1, transferManifestRevision: 1, transferPolicy: "full" as const, destinationProof };
        const result = applySessionMove(db, input, proof, NOW, "move-cross-root-child");
        assert.equal(result.destinationRootSessionId, ctx.destinationRoot.id);
        assert.equal(result.revisions[ctx.target.id], 2);
        assert.equal((db.prepare("SELECT resource_revision FROM sessions_v6 WHERE id = ?")
          .get(ctx.target.id) as { resource_revision: number }).resource_revision, 2);
        const movedBinding = db.prepare("SELECT root_session_id, parent_session_id FROM session_role_bindings_v6 WHERE session_id = ?")
          .get(ctx.target.id) as { root_session_id: string; parent_session_id: string };
        assert.equal(movedBinding.root_session_id, ctx.destinationRoot.id);
        assert.equal(movedBinding.parent_session_id, ctx.destinationRoot.id);
        const afterGrants = listActiveSessionAuthorityGrants(db, ctx.target.id, new Date(NOW));
        assert.equal(afterGrants.filter((grant) => grant.rootSessionId === ctx.destinationRoot.id).length, beforeGrants.length);
        const grantShape = (grant: typeof beforeGrants[number]) => ({
          actions: [...grant.actions].sort(), resourceKind: grant.resourceKind,
          relationSelector: grant.relationSelector, targetSessionRoles: [...grant.targetSessionRoles].sort(),
          effectClass: grant.effectClass, delegable: grant.delegable,
          childCeiling: grant.childCeiling.map((permission) => ({ ...permission, targetSessionRoles: [...permission.targetSessionRoles].sort() }))
            .sort((left, right) => `${left.action}:${left.relationSelector}`.localeCompare(`${right.action}:${right.relationSelector}`)),
          expiresAt: grant.expiresAt,
        });
        assert.deepEqual(
          afterGrants.filter((grant) => grant.rootSessionId === ctx.destinationRoot.id).map(grantShape)
            .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
          beforeGrants.map(grantShape).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
        );
        for (const grant of beforeGrants) {
          assert.equal((db.prepare("SELECT revoked_at FROM session_authority_grants_v6 WHERE grant_id = ?")
            .get(grant.grantId) as { revoked_at: string | null }).revoked_at !== null, true);
        }
        const account = db.prepare("SELECT root_session_id, parent_account_id FROM resource_budget_accounts_v6 WHERE owner_session_id = ?")
          .get(ctx.target.id) as { root_session_id: string; parent_account_id: string } | undefined;
        assert.ok(account);
        assert.equal(account.root_session_id, ctx.destinationRoot.id);
        assert.equal(account.parent_account_id, ctx.destinationRoot.id);
        assert.equal((db.prepare("SELECT COUNT(*) AS count FROM session_authority_grants_v6 WHERE grantee_session_id = ? AND root_session_id = ? AND revoked_at IS NOT NULL")
          .get(ctx.target.id, ctx.sourceRoot.id) as { count: number }).count > 0, true);
        ensureV6Schema(db);
        verifyResourceHistoryProjections(db);
      } finally { db.close(); }
    } finally { service.close(); ctx.storage.close(); await rm(ctx.directory, { recursive: true, force: true }); }
  });
});
