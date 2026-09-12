import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import { buildNewSession, type Session } from "../../src/session-state.js";
import { SessionStorageV6 } from "../../src-electron/session-storage-v6.js";
import { issueRootConstructionCapability, listActiveSessionAuthorityGrants, revokeSessionAuthorityGrant } from "../../src-electron/session-authority-storage.js";
import { ResourceBudgetStorage } from "../../src-electron/resource-budget-storage.js";
import { initializeSessionConstruction, validateSessionConstruction } from "../../src-electron/session-lifecycle-creation.js";
import type { MutationAuthorityProof } from "../../src/session-authority.js";
import type { SessionRuntimeCreateInput } from "../../src/session-external-runtime-contract.js";
import { SessionLifecycleResolver } from "../../src-electron/session-lifecycle-resolver.js";
import { SessionLifecycleService } from "../../src-electron/session-lifecycle-service.js";

const NOW = "2026-09-08T12:00:00.000Z";
const provider = { id: "codex" as const, catalogRevision: 1, model: "test", reasoningEffort: "medium" as const, threadContinuity: "reset" as const, approvalMode: DEFAULT_APPROVAL_MODE, codexSandboxMode: "workspace-write" as const, allowedAdditionalDirectories: [] };

function root(id: string): Session {
  return { ...buildNewSession({ id, taskTitle: id, workspaceLabel: "workspace", workspacePath: "C:/workspace", branch: "main", characterId: "character-a", character: "A", characterIconPath: "", characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" }, approvalMode: DEFAULT_APPROVAL_MODE, rootSessionRole: "overall-coordinator" }), updatedAt: NOW };
}
function createInput(placement: SessionRuntimeCreateInput["placement"], initialGrant: SessionRuntimeCreateInput["initialGrant"] = { kind: "inherit" }, budget: SessionRuntimeCreateInput["budget"] = { kind: "inherit" }): SessionRuntimeCreateInput {
  return { expectedContainerRevision: 1, placement, title: "new", character: { characterId: "character-a", expectedDefinitionSha256: "sha" }, provider, workspace: { kind: "directory", path: "C:/workspace" }, initialGrant, budget, idempotencyKey: "create-key" };
}
function userProof(id: string): MutationAuthorityProof {
  return { principal: { kind: "user", receiptId: "test-user" }, providerId: null, operation: "session.create", mappingRevision: 2, action: "session.create", effectClass: "local_mutation", grantId: null, grantRevision: null, resolvedScope: { resourceKind: "session_namespace", resourceId: id, rootSessionId: id, ownerKind: "session", ownerId: id, relation: "self" }, evaluatedAt: NOW };
}
function agentProof(actor: string, grantId: string, revision: number): MutationAuthorityProof {
  return { principal: { kind: "agent", agent: "session-runtime", actorSessionId: actor, runtimeGeneration: "generation-1" }, providerId: "codex", operation: "session.create", mappingRevision: 2, action: "session.create", effectClass: "local_mutation", grantId, grantRevision: revision, resolvedScope: { resourceKind: "session_namespace", resourceId: actor, rootSessionId: actor, ownerKind: "session", ownerId: actor, relation: "self" }, evaluatedAt: NOW };
}

async function harness(): Promise<{ directory: string; storage: SessionStorageV6; db: DatabaseSync }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-construction-"));
  const dbPath = path.join(directory, "db.sqlite");
  const storage = new SessionStorageV6(dbPath);
  return { directory, storage, db: new DatabaseSync(dbPath) };
}

async function lifecycleHarness(h: { directory: string; storage: SessionStorageV6; db: DatabaseSync }, ids: string[]): Promise<SessionLifecycleService> {
  h.db.prepare("INSERT INTO characters (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)").run("character-a", "Character A", NOW, NOW);
  const resolver = new SessionLifecycleResolver({
    currentModelCatalog: () => ({ revision: 1, providers: [{ id: "codex", label: "Codex", defaultModelId: "test", defaultReasoningEffort: "medium", models: [{ id: "test", label: "Test", reasoningEfforts: ["medium"] }] }] }),
    isProviderEnabled: () => true, isProviderSupported: () => true,
    listCharacters: () => [{ id: "character-a", name: "Character A", description: "", iconFilePath: "", theme: { main: "#123456", sub: "#654321" }, state: "active", createdAt: NOW, updatedAt: NOW, archivedAt: null }],
    createCharacterRuntimeSnapshot: () => ({ characterId: "character-a", name: "Character A", description: "", iconFilePath: "", theme: { main: "#123456", sub: "#654321" }, definitionMarkdown: "", definitionSha256: "sha", definitionByteSize: 0, snapshotAt: NOW }),
    resolveSessionFilesDirectory: (id) => path.join(h.directory, "session-files", id),
  });
  let index = 0;
  return new SessionLifecycleService({ storage: h.storage, resolver, createSessionFilesDirectory: async () => undefined, cleanupSessionFilesDirectory: async () => undefined, resolveSessionFilesDirectory: (id) => path.join(h.directory, "session-files", id), publishSession: () => undefined, publishRemovedSession: async () => undefined, createSessionId: () => ids[index++] });
}

describe("Session lifecycle construction", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "SessionLifecycleService create commits a root through the real prepare/commit boundary and persists authority and budget projections"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/01-session-lifecycle.md#Root 作成" }
  // fault = "A direct helper fixture masks missing construction initialization in the lifecycle owner"
  // observable = "Committed Session, authority grants, root budget, and idempotent replay result"
  // observation_boundary = "component-behavior"
  // scope = "session-lifecycle-create-prepare-commit"
  // lifecycle = "permanent"
  // @end-test-value
  it("creates a root through SessionLifecycleService and replays without duplicate projections", async () => {
    const h = await harness();
    try {
      const service = await lifecycleHarness(h, ["service-root"]);
      const input = { ...createInput({ kind: "root", rootKind: "overall-coordinator" }), workspace: { kind: "directory" as const, path: h.directory } };
      const created = await service.create(input, userProof("service-root"));
      const grantSnapshot = listActiveSessionAuthorityGrants(h.db, created.sessionId, new Date()).map((grant) => grant.grantId).sort();
      const budgetSnapshot = new ResourceBudgetStorage(h.db).getByAccountId(created.sessionId);
      const replay = await service.create(input, userProof("service-root"));
      assert.equal(replay.sessionId, created.sessionId);
      assert.deepEqual(listActiveSessionAuthorityGrants(h.db, created.sessionId, new Date()).map((grant) => grant.grantId).sort(), grantSnapshot);
      assert.deepEqual(new ResourceBudgetStorage(h.db).getByAccountId(created.sessionId), budgetSnapshot);
      assert.equal((h.db.prepare("SELECT COUNT(*) AS count FROM sessions_v6 WHERE id = ?").get(created.sessionId) as { count: number }).count, 1);
    } finally { h.db.close(); await h.storage.close(); await rm(h.directory, { recursive: true, force: true }); }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "The real lifecycle boundary derives agent root authority and every construction ceiling dimension"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/01-session-lifecycle.md#Root 作成" }
  // fault = "A direct helper fixture masks missing agent-root projections"
  // observable = "Agent root authority provenance, workspace/actions/expiry and bounded budget survive prepare/commit"
  // observation_boundary = "component-behavior"
  // scope = "session-lifecycle-create-prepare-commit"
  // lifecycle = "permanent"
  // @end-test-value
  it("creates an agent root through the real lifecycle boundary", async () => {
    const h = await harness();
    try {
      const service = await lifecycleHarness(h, ["agent-parent", "agent-target"]);
      const rootInput = { ...createInput({ kind: "root", rootKind: "overall-coordinator" }), workspace: { kind: "directory" as const, path: h.directory } };
      await service.create(rootInput, userProof("agent-parent"));
      const capability = issueRootConstructionCapability(h.db, { rootSessionId: "agent-parent", granteeSessionId: "agent-parent", targetSessionRoles: ["overall-coordinator"], ceiling: { workspaceId: h.directory, projectId: null, visibility: "root", actions: [{ mode: "exercise", action: "session.self", resourceKind: "session", relationSelector: "self", effectClass: "read", targetSessionRoles: ["overall-coordinator"] }], budget: { concurrentTurns: 2, queuedTurns: 100, totalTurns: 1000, retries: 100, sessions: 100, workItems: 500, delegations: 500, storageBytes: 1073741824 }, expiresAt: "2026-09-20T00:00:00.000Z" }, principal: { kind: "user", receiptId: "test-user" }, proof: userProof("agent-parent"), issuedAt: NOW });
      const agentInput = { ...rootInput, budget: { kind: "explicit" as const, hardLimits: { concurrentTurns: 1 }, deadlineAt: "2026-09-20T00:00:00.000Z" }, idempotencyKey: "agent-root-create" };
      await service.create(agentInput, agentProof("agent-parent", capability.grantId, capability.revision));
      const grants = listActiveSessionAuthorityGrants(h.db, "agent-target", new Date()).filter((grant) => grant.provenance.source === "root-construction");
      assert.ok(grants.length > 0);
      assert.ok(grants.every((grant) => grant.rootSessionId === "agent-target" && grant.provenance.sourceGrantId === capability.grantId && grant.provenance.sourceGrantRevision === capability.revision));
      const dimensions = new ResourceBudgetStorage(h.db).getByAccountId("agent-target").dimensions;
      assert.deepEqual(Object.fromEntries(Object.entries(dimensions).map(([name, value]) => [name, value.hardLimit])), { concurrentTurns: 1, queuedTurns: 100, totalTurns: 1000, retries: 100, sessions: 100, workItems: 500, delegations: 500, storageBytes: 1073741824 });
    } finally { h.db.close(); await h.storage.close(); await rm(h.directory, { recursive: true, force: true }); }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "The real lifecycle boundary delegates a bounded child and consumes its parent session count once"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/01-session-lifecycle.md#Root 作成" }
  // fault = "A direct helper fixture masks child grant or budget projection errors"
  // observable = "Child grant is narrowed and replay does not consume another session"
  // observation_boundary = "component-behavior"
  // scope = "session-lifecycle-create-prepare-commit"
  // lifecycle = "permanent"
  // @end-test-value
  it("creates a bounded child through the real lifecycle boundary", async () => {
    const h = await harness();
    try {
      const service = await lifecycleHarness(h, ["child-parent", "child-target"]);
      const rootInput = { ...createInput({ kind: "root", rootKind: "overall-coordinator" }), workspace: { kind: "directory" as const, path: h.directory } };
      await service.create(rootInput, userProof("child-parent"));
      const parentGrant = listActiveSessionAuthorityGrants(h.db, "child-parent", new Date()).find((grant) => grant.actions.includes("session.create"));
      assert.ok(parentGrant);
      const before = new ResourceBudgetStorage(h.db).get("child-parent").dimensions.sessions.committed;
      const childInput = { ...createInput({ kind: "child", parentSessionId: "child-parent", sessionRole: "executor" }, { kind: "explicit", actions: ["session.self"], visibility: ["root"], expiresAt: "2026-09-20T00:00:00.000Z" }, { kind: "explicit", hardLimits: { concurrentTurns: 1 }, deadlineAt: "2026-09-20T00:00:00.000Z" }), workspace: { kind: "directory" as const, path: h.directory }, idempotencyKey: "child-create" };
      const proof = agentProof("child-parent", parentGrant.grantId, parentGrant.revision);
      await service.create(childInput, proof);
      const firstDelegated = listActiveSessionAuthorityGrants(h.db, "child-target", new Date()).filter((grant) => grant.provenance.source === "child-construction");
      const firstIds = firstDelegated.map((grant) => grant.grantId).sort();
      const budgetStorage = new ResourceBudgetStorage(h.db);
      const firstChildBudget = budgetStorage.getByAccountId("child-target");
      assert.equal(firstChildBudget.accountId, "child-target");
      assert.equal(firstChildBudget.rootSessionId, "child-parent");
      assert.equal(firstChildBudget.parentAccountId, "child-parent");
      assert.equal(firstChildBudget.deadlineAt, budgetStorage.getByAccountId("child-parent").deadlineAt);
      assert.equal((h.db.prepare("SELECT deadline_at FROM resource_budget_accounts_v6 WHERE account_id = ?")
        .get("child-target") as { deadline_at: string }).deadline_at, "2026-09-20T00:00:00.000Z");
      assert.equal(firstChildBudget.dimensions.concurrentTurns.hardLimit, 1);
      await service.create(childInput, proof);
      const delegated = listActiveSessionAuthorityGrants(h.db, "child-target", new Date()).filter((grant) => grant.provenance.source === "child-construction");
      assert.ok(delegated.length > 0);
      assert.ok(delegated.every((grant) => grant.actions.includes("session.self") && !grant.actions.includes("session.create")));
      assert.deepEqual(delegated.map((grant) => grant.grantId).sort(), firstIds);
      assert.deepEqual(budgetStorage.getByAccountId("child-target"), firstChildBudget);
      assert.equal(new ResourceBudgetStorage(h.db).get("child-parent").dimensions.sessions.committed, before + 1);
    } finally { h.db.close(); await h.storage.close(); await rm(h.directory, { recursive: true, force: true }); }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "agent root construction rejects any requested authority or budget dimension above the persisted construction ceiling"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/01-session-lifecycle.md#Root 作成" }
  // fault = "root creation silently filters or corrects an action, workspace, expiry, deadline, or budget above the source construction capability"
  // observable = "construction succeeds within every ceiling dimension and rejects each overflow"
  // observation_boundary = "component-behavior"
  // scope = "session-lifecycle-creation"
  // lifecycle = "permanent"
  // @end-test-value
  it("derives an agent root within the construction ceiling and rejects overflow", async () => {
    const h = await harness();
    try {
      const source = root("source-root"); const target = root("target-root"); h.storage.insertSession(source); h.storage.insertSession(target);
      const capability = issueRootConstructionCapability(h.db, { rootSessionId: source.id, granteeSessionId: source.id, targetSessionRoles: ["overall-coordinator"], ceiling: { workspaceId: "C:/workspace", projectId: null, visibility: "root", actions: [{ mode: "exercise", action: "session.self", resourceKind: "session", relationSelector: "self", effectClass: "read", targetSessionRoles: ["overall-coordinator"] }], budget: { concurrentTurns: 2, queuedTurns: 100, totalTurns: 1000, retries: 100, sessions: 100, workItems: 500, delegations: 500, storageBytes: 1073741824 }, expiresAt: "2026-09-20T00:00:00.000Z" }, principal: { kind: "user", receiptId: "test-user" }, proof: userProof(source.id), issuedAt: NOW });
      const proof = agentProof(source.id, capability.grantId, capability.revision);
      const input = createInput({ kind: "root", rootKind: "overall-coordinator" }, { kind: "inherit" }, { kind: "explicit", hardLimits: { concurrentTurns: 1 }, deadlineAt: "2026-09-20T00:00:00.000Z" });
      validateSessionConstruction(h.db, input, proof, target, NOW); initializeSessionConstruction(h.db, input, proof, target, "op-agent-root", NOW);
      assert.ok(listActiveSessionAuthorityGrants(h.db, target.id, new Date(NOW)).some((grant) => grant.provenance.source === "root-construction"));
      assert.throws(() => validateSessionConstruction(h.db, createInput({ kind: "root", rootKind: "overall-coordinator" }, { kind: "explicit", actions: ["session.get"], visibility: ["root"], expiresAt: null }), proof, target, NOW));
      assert.throws(() => validateSessionConstruction(h.db, createInput({ kind: "root", rootKind: "overall-coordinator" }, { kind: "explicit", actions: ["session.self"], visibility: ["root"], expiresAt: "2026-09-21T00:00:00.000Z" }), proof, target, NOW));
      assert.throws(() => validateSessionConstruction(h.db, input, proof, { ...target, workspacePath: "C:/other" }, NOW));
      const overflow = createInput({ kind: "root", rootKind: "overall-coordinator" }, { kind: "inherit" }, { kind: "explicit", hardLimits: { concurrentTurns: 3 }, deadlineAt: "2026-09-20T00:00:00.000Z" });
      assert.throws(() => validateSessionConstruction(h.db, overflow, proof, root("other-target"), NOW));
    } finally { h.db.close(); await h.storage.close(); await rm(h.directory, { recursive: true, force: true }); }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "revoked construction grants cannot create a root"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/01-session-lifecycle.md#Root 作成" }
  // fault = "root construction accepts a revoked source grant"
  // observable = "validation rejects the revoked proof"
  // observation_boundary = "component-behavior"
  // scope = "session-lifecycle-creation"
  // lifecycle = "permanent"
  // @end-test-value
  it("rejects a revoked construction grant", async () => {
    const h = await harness();
    try {
      const source = root("revoked-source"); h.storage.insertSession(source);
      const capability = issueRootConstructionCapability(h.db, { rootSessionId: source.id, granteeSessionId: source.id, targetSessionRoles: ["overall-coordinator"], ceiling: { workspaceId: null, projectId: null, visibility: "root", actions: [{ mode: "exercise", action: "session.self", resourceKind: "session", relationSelector: "self", effectClass: "read", targetSessionRoles: ["overall-coordinator"] }], budget: {}, expiresAt: null }, principal: { kind: "user", receiptId: "test-user" }, proof: userProof(source.id), issuedAt: NOW });
      const revoked = revokeSessionAuthorityGrant(h.db, { grantId: capability.grantId, expectedRevision: capability.revision, principal: { kind: "user", receiptId: "test-user" }, revokedAt: NOW });
      const before = (h.db.prepare("SELECT COUNT(*) AS count FROM session_authority_grants_v6 WHERE grantee_session_id = 'revoked-target'").get() as { count: number }).count;
      assert.throws(() => validateSessionConstruction(h.db, createInput({ kind: "root", rootKind: "overall-coordinator" }), agentProof(source.id, capability.grantId, revoked.revision), root("revoked-target"), NOW), (error: any) => error?.code === "AUTHORITY_GRANT_REVOKED");
      const after = (h.db.prepare("SELECT COUNT(*) AS count FROM session_authority_grants_v6 WHERE grantee_session_id = 'revoked-target'").get() as { count: number }).count;
      assert.equal(after, before);
    } finally { h.db.close(); await h.storage.close(); await rm(h.directory, { recursive: true, force: true }); }
  });
});
