import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { SESSION_AUTHORITY_MAPPING_REVISION, type MutationAuthorityProof } from "../../src/session-authority.js";
import type { CharacterCatalogEntry, CharacterRuntimeSnapshot } from "../../src/character/character-catalog.js";
import type { Session } from "../../src/session-state.js";
import type { SessionRuntimeProviderTuple } from "../../src/session-external-runtime-contract.js";
import { SessionLifecycleResolver } from "../../src-electron/session-lifecycle-resolver.js";
import { SessionLifecycleService } from "../../src-electron/session-lifecycle-service.js";
import { SessionStorageV6 } from "../../src-electron/session-storage-v6.js";

const character: CharacterCatalogEntry = { id: "character-a", name: "Character A", description: "", iconFilePath: "", theme: { main: "#123456", sub: "#654321" }, state: "active", createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z", archivedAt: null };
const snapshot: CharacterRuntimeSnapshot = { characterId: character.id, name: character.name, description: "", iconFilePath: "", theme: character.theme, definitionMarkdown: "# Character A", definitionSha256: "character-a-sha", definitionByteSize: 13, snapshotAt: "2026-08-01T00:00:00.000Z" };
const catalog = { revision: 7, providers: [{ id: "codex", label: "Codex", defaultModelId: "model-a", defaultReasoningEffort: "low", models: [{ id: "model-a", label: "Model A", reasoningEfforts: ["low", "high"] }] }] };

function provider(): SessionRuntimeProviderTuple {
  return { id: "codex", catalogRevision: 7, model: "model-a", reasoningEffort: "low", threadContinuity: "reset", approvalMode: "untrusted", codexSandboxMode: "workspace-write", allowedAdditionalDirectories: [] };
}

function proof(operation: MutationAuthorityProof["operation"], rootSessionId: string, agent = false, grantId: string | null = null, grantRevision: number | null = null, resourceId = rootSessionId): MutationAuthorityProof {
  return { principal: agent ? { kind: "agent", actorSessionId: rootSessionId, grantId: grantId!, grantRevision: grantRevision! } : { kind: "user", receiptId: "clone-test" }, operation, mappingRevision: SESSION_AUTHORITY_MAPPING_REVISION, action: operation, effectClass: "local_mutation", grantId, grantRevision, evaluatedAt: "2026-09-08T00:00:00.000Z", resolvedScope: { resourceKind: operation === "session.create" ? "session_namespace" : "session", resourceId: operation === "session.create" ? null : resourceId, rootSessionId, ownerKind: "session", ownerId: rootSessionId, relation: "self" } };
}

function parentGrant(dbPath: string, rootSessionId: string): { id: string; revision: number } {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare("SELECT grant_id AS id, revision FROM session_authority_grants_v6 WHERE grantee_session_id = ? AND actions_json LIKE '%session.create%' AND revoked_at IS NULL ORDER BY revision DESC LIMIT 1").get(rootSessionId) as { id: string; revision: number } | undefined;
    if (!row) throw new Error("clone grant missing");
    return row;
  } finally { db.close(); }
}

function provisionCloneGrant(dbPath: string, rootSessionId: string): { id: string; revision: number } {
  const db = new DatabaseSync(dbPath);
  try {
    const source = db.prepare("SELECT grant_id, revision, expires_at FROM session_authority_grants_v6 WHERE grantee_session_id = ? AND actions_json LIKE '%session.create%' AND revoked_at IS NULL ORDER BY revision DESC LIMIT 1").get(rootSessionId) as { grant_id: string; revision: number; expires_at: string | null } | undefined;
    if (!source) throw new Error("clone source grant missing");
    const grantId = `authority-grant:clone:${rootSessionId}`;
    const issuedAt = "2026-09-08T00:00:00.000Z";
    const provenance = JSON.stringify({ source: "trusted-session-clone-provisioning", sourceGrantId: source.grant_id, sourceGrantRevision: source.revision });
    db.prepare(`INSERT INTO session_authority_grants_v6 (
      grant_id, root_session_id, issuer_kind, issuer_id, issuer_grant_id, issuer_grant_revision,
      grantee_session_id, actions_json, resource_kind, relation_selector, target_session_roles_json,
      effect_class, delegable, child_ceiling_json, issued_at, effective_at, expires_at, revoked_at,
      revision, mapping_revision, provenance_json
    ) VALUES (?, ?, 'system', 'session-clone-provisioning', NULL, NULL, ?, ?, 'session', 'self', ?, 'local_mutation', 0, '[]', ?, ?, ?, NULL, 1, ?, ?)`).run(
      grantId, rootSessionId, rootSessionId, JSON.stringify(["session.clone"]), JSON.stringify(["standalone", "overall-coordinator", "task-coordinator", "executor"]), issuedAt, issuedAt, source.expires_at, SESSION_AUTHORITY_MAPPING_REVISION, provenance,
    );
    db.prepare(`INSERT INTO session_authority_grant_events_v6 (
      event_id, grant_id, event_kind, grant_revision, principal_kind, actor_session_id, payload_json, occurred_at
    ) VALUES (?, ?, 'delegated', 1, 'system', NULL, ?, ?)`).run(`authority-event:clone:${rootSessionId}`, grantId, provenance, issuedAt);
    return { id: grantId, revision: 1 };
  } finally { db.close(); }
}

async function makeService(dbPath: string, ids: string[]): Promise<{ service: SessionLifecycleService; storage: SessionStorageV6; close(): void }> {
  const storage = new SessionStorageV6(dbPath);
  const db = new DatabaseSync(dbPath);
  db.prepare("INSERT INTO characters (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)").run(character.id, character.name, character.createdAt, character.updatedAt);
  db.close();
  let index = 0;
  const resolveFolder = (id: string) => path.join(path.dirname(dbPath), "session-files", id);
  const resolver = new SessionLifecycleResolver({ currentModelCatalog: () => catalog, isProviderEnabled: () => true, isProviderSupported: () => true, listCharacters: () => [character], createCharacterRuntimeSnapshot: () => snapshot, resolveSessionFilesDirectory: resolveFolder });
  const service = new SessionLifecycleService({ storage, resolver, createSessionFilesDirectory: async (id) => { const folder = resolveFolder(id); await mkdir(folder, { recursive: true }); return folder; }, cleanupSessionFilesDirectory: async () => undefined, resolveSessionFilesDirectory: resolveFolder, publishSession: () => undefined, publishRemovedSession: async () => undefined, authorizeConstruction: (actorSessionId) => { const grant = parentGrant(dbPath, actorSessionId); return proof("session.create", actorSessionId, true, grant.id, grant.revision); }, createSessionId: () => ids[index++] ?? `clone-${index}` });
  return { service, storage, close: () => storage.close() };
}

function createInput(idempotencyKey: string, placement: { kind: "root"; rootKind: "overall-coordinator" } | { kind: "child"; parentSessionId: string; sessionRole: "executor" }) {
  return { expectedContainerRevision: 0, placement, title: "Source", character: { characterId: character.id, expectedDefinitionSha256: snapshot.definitionSha256 }, provider: provider(), workspace: { kind: "session_folder" as const }, initialGrant: { kind: "inherit" as const }, budget: { kind: "inherit" as const }, idempotencyKey };
}

// @test-value v2
// kind = "invariant"
// claim = "Session clone preserves source persistence while allocating a new identity and empty runtime transcript for root and child placement."
// oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/01-session-lifecycle.md#Session identity と変更可能性" }
// fault = "Clone rewrites the source, copies prior messages/thread state, or creates duplicate resources on idempotent retry."
// observable = "Source and clone Session rows, message count, created timestamps, binding placement, authority grant, budget account, and clone count"
// observation_boundary = "public-boundary"
// scope = "SessionLifecycleService session.clone"
// lifecycle = "permanent"
// @end-test-value
test("SessionLifecycleService clone はsourceを保持しroot/childへ新規Sessionを一度だけ作る", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "withmate-lifecycle-clone-"));
  const dbPath = path.join(root, "app.db");
  const { service, storage, close } = await makeService(dbPath, ["source-root", "source-child", "clone-root", "clone-child"]);
  try {
    const source = await service.create({ ...createInput("source-key", { kind: "root", rootKind: "overall-coordinator" }), title: "Source root" }, proof("session.create", "source-root"));
    const sourceStored = storage.getLifecycleSession(source.sessionId, true)!;
    storage.upsertSession({ ...sourceStored, messages: [{ role: "user", text: "historical message" } as never], threadId: "source-thread" });
    const sourceBeforeClone = storage.getLifecycleSession(source.sessionId, true)!;
    const sourceRevisionBeforeClone = storage.getSessionResourceRevision(source.sessionId)!;
    const sourceDb = new DatabaseSync(dbPath);
    const sourceCreatedAt = sourceDb.prepare("SELECT created_at FROM sessions_v6 WHERE id = ?").get(source.sessionId) as { created_at: string };
    sourceDb.close();
    const cloneInput = { sourceSessionId: source.sessionId, expectedSourceRevision: storage.getSessionResourceRevision(source.sessionId)!, placement: { kind: "root", rootKind: "standalone" as const }, title: "Root clone", initialGrant: { kind: "inherit" as const }, budget: { kind: "inherit" as const }, idempotencyKey: "clone-root-key" };
    const cloneProof = proof("session.clone", source.sessionId);
    const rootClone = await service.clone(cloneInput, cloneProof);
    const sourceAfterRootClone = storage.getLifecycleSession(source.sessionId, true)!;
    assert.deepEqual(sourceAfterRootClone.messages, sourceBeforeClone.messages);
    assert.equal(sourceAfterRootClone.threadId, sourceBeforeClone.threadId);
    assert.equal(storage.getSessionResourceRevision(source.sessionId), sourceRevisionBeforeClone);
    const afterRootClone = new DatabaseSync(dbPath);
    const rootCloneRows = afterRootClone.prepare("SELECT id, created_at, resource_revision FROM sessions_v6 WHERE id IN (?, ?)").all(source.sessionId, rootClone.sessionId) as Array<{ id: string; created_at: string; resource_revision: number }>;
    const rootCloneGrants = afterRootClone.prepare("SELECT grantee_session_id, actions_json, revision FROM session_authority_grants_v6 WHERE grantee_session_id = ? ORDER BY grant_id").all(rootClone.sessionId) as Array<{ grantee_session_id: string; actions_json: string; revision: number }>;
    const rootCloneBudget = afterRootClone.prepare("SELECT account_id, owner_session_id FROM resource_budget_accounts_v6 WHERE owner_session_id = ?").all(rootClone.sessionId) as Array<{ account_id: string; owner_session_id: string }>;
    afterRootClone.close();
    const replay = await service.clone(cloneInput, cloneProof);
    assert.equal(replay.sessionId, rootClone.sessionId);
    const afterRootReplay = new DatabaseSync(dbPath);
    assert.deepEqual(afterRootReplay.prepare("SELECT id, created_at, resource_revision FROM sessions_v6 WHERE id IN (?, ?)").all(source.sessionId, rootClone.sessionId), rootCloneRows);
    assert.deepEqual(afterRootReplay.prepare("SELECT grantee_session_id, actions_json, revision FROM session_authority_grants_v6 WHERE grantee_session_id = ? ORDER BY grant_id").all(rootClone.sessionId), rootCloneGrants);
    assert.deepEqual(afterRootReplay.prepare("SELECT account_id, owner_session_id FROM resource_budget_accounts_v6 WHERE owner_session_id = ?").all(rootClone.sessionId), rootCloneBudget);
    afterRootReplay.close();
    const cloneStored = storage.getLifecycleSession(rootClone.sessionId, true)!;
    assert.notEqual(cloneStored.id, sourceStored.id);
    assert.deepEqual(cloneStored.messages, []);
    assert.equal(cloneStored.threadId, "");
    assert.equal(cloneStored.provider, sourceStored.provider);
    assert.equal(cloneStored.characterId, sourceStored.characterId);
    assert.equal(cloneStored.workspaceLabel, sourceStored.workspaceLabel);
    assert.notEqual(cloneStored.workspacePath, sourceStored.workspacePath);
    const cloneDb = new DatabaseSync(dbPath);
    const cloneCreatedAt = cloneDb.prepare("SELECT created_at FROM sessions_v6 WHERE id = ?").get(rootClone.sessionId) as { created_at: string };
    cloneDb.close();
    assert.equal(typeof sourceCreatedAt.created_at, "string");
    const sourceCreatedAtAfter = new DatabaseSync(dbPath);
    assert.equal((sourceCreatedAtAfter.prepare("SELECT created_at FROM sessions_v6 WHERE id = ?").get(source.sessionId) as { created_at: string }).created_at, sourceCreatedAt.created_at);
    sourceCreatedAtAfter.close();
    assert.ok(cloneCreatedAt.created_at.length > 0);

    const grant = parentGrant(dbPath, source.sessionId);
    const child = await service.create({ ...createInput("child-source-key", { kind: "child", parentSessionId: source.sessionId, sessionRole: "executor" }), expectedContainerRevision: storage.getSessionResourceRevision(source.sessionId)! }, proof("session.create", source.sessionId, true, grant.id, grant.revision));
    const usageBeforeChildCloneDb = new DatabaseSync(dbPath);
    const usageBeforeChildClone = usageBeforeChildCloneDb.prepare("SELECT committed FROM resource_budget_dimensions_v6 WHERE account_id = ? AND dimension = 'sessions'").get(source.sessionId) as { committed: number };
    usageBeforeChildCloneDb.close();
    const childCloneGrant = provisionCloneGrant(dbPath, source.sessionId);
    const childCloneInput = { sourceSessionId: child.sessionId, expectedSourceRevision: storage.getSessionResourceRevision(child.sessionId)!, expectedContainerRevision: storage.getSessionResourceRevision(source.sessionId)!, placement: { kind: "child" as const, parentSessionId: source.sessionId, sessionRole: "executor" as const }, title: "Child clone", initialGrant: { kind: "inherit" as const }, budget: { kind: "inherit" as const }, idempotencyKey: "clone-child-key" };
    const childClone = await service.clone(childCloneInput, proof("session.clone", source.sessionId, true, childCloneGrant.id, childCloneGrant.revision, child.sessionId));
    const childCloneStored = storage.getLifecycleSession(childClone.sessionId, true)!;
    assert.equal(childCloneStored.roleBinding?.parentSessionId, source.sessionId);
    assert.deepEqual(childCloneStored.messages, []);
    const childCloneProof = proof("session.clone", source.sessionId, true, childCloneGrant.id, childCloneGrant.revision, child.sessionId);
    const childBeforeReplayDb = new DatabaseSync(dbPath);
    const childGrantIdsBeforeReplay = childBeforeReplayDb.prepare("SELECT grant_id FROM session_authority_grants_v6 WHERE grantee_session_id = ? ORDER BY grant_id").all(childClone.sessionId).map((row) => (row as { grant_id: string }).grant_id);
    const childCountBeforeReplay = (childBeforeReplayDb.prepare("SELECT COUNT(*) AS count FROM sessions_v6 WHERE id = ?").get(childClone.sessionId) as { count: number }).count;
    childBeforeReplayDb.close();
    const childCloneReplay = await service.clone(childCloneInput, childCloneProof);
    assert.equal(childCloneReplay.sessionId, childClone.sessionId);
    const childAfterReplayDb = new DatabaseSync(dbPath);
    assert.deepEqual(childAfterReplayDb.prepare("SELECT grant_id FROM session_authority_grants_v6 WHERE grantee_session_id = ? ORDER BY grant_id").all(childClone.sessionId).map((row) => (row as { grant_id: string }).grant_id), childGrantIdsBeforeReplay);
    assert.equal((childAfterReplayDb.prepare("SELECT COUNT(*) AS count FROM sessions_v6 WHERE id = ?").get(childClone.sessionId) as { count: number }).count, childCountBeforeReplay);
    childAfterReplayDb.close();
    const db = new DatabaseSync(dbPath);
    try {
      const sessionCount = (db.prepare("SELECT COUNT(*) AS count FROM sessions_v6 WHERE deleted_at IS NULL").get() as { count: number }).count;
      const grantCount = (db.prepare("SELECT COUNT(*) AS count FROM session_authority_grants_v6 WHERE grantee_session_id IN (?, ?)").get(rootClone.sessionId, childClone.sessionId) as { count: number }).count;
      const budgetCount = (db.prepare("SELECT COUNT(*) AS count FROM resource_budget_accounts_v6 WHERE owner_session_id = ?").get(rootClone.sessionId) as { count: number }).count;
      const effectiveChildBudget = db.prepare("SELECT account_id, owner_session_id FROM resource_budget_accounts_v6 WHERE account_id = (SELECT root_session_id FROM session_role_bindings_v6 WHERE session_id = ?)").get(childClone.sessionId) as { account_id: string; owner_session_id: string };
      assert.equal(sessionCount, 4);
      assert.ok(grantCount > 0);
      assert.equal(budgetCount, 1);
      assert.equal(effectiveChildBudget.account_id, source.sessionId);
      assert.equal(effectiveChildBudget.owner_session_id, source.sessionId);
      const usageAfterChildClone = db.prepare("SELECT committed FROM resource_budget_dimensions_v6 WHERE account_id = ? AND dimension = 'sessions'").get(source.sessionId) as { committed: number };
      assert.equal(usageAfterChildClone.committed, usageBeforeChildClone.committed + 1);
    } finally { db.close(); }
  } finally { close(); await rm(root, { recursive: true, force: true }); }
});
